// ---------------------------------------------------------------------------
// DOMSource — a Zero IVM `Source` whose backing store is a live DOM subtree.
//
// Each row is a `<tr>` inside a container element (typically a `<tbody>`).
// Columns are `<td>` cells. The canonical typed value of a cell lives in its
// `data-v` attribute (JSON-encoded, so types survive); its text content is just
// a human-readable rendering. Hand-authored `<td>Alice</td>` cells without
// `data-v` are coerced via the schema, so an existing HTML table IS a source.
//
// Architecture: `connect`, `push`, `genPush` and all the overlay / split-edit /
// comparator machinery are reused verbatim from Zero's MemorySource. Only the
// *storage layer* differs:
//   - `#fetch`        reads rows out of the DOM and sorts them on demand
//   - `#writeChange`  mutates the DOM (<tr> insert / remove)
//   - `#has`          checks row presence by primary key in the DOM
// The DOM is the single source of truth; no secondary indexes are persisted.
// ---------------------------------------------------------------------------

import {
  genPushAndWriteWithSplitEdit,
  generateWithOverlay,
  generateWithStart,
  skipYields,
  makeComparator,
  compareValues,
  valuesEqual,
  primaryKeyConstraintFromFilters,
  constraintMatchesPrimaryKey,
  constraintMatchesRow,
  transformFilters,
  createPredicate,
  assertOrderingIncludesPK,
} from './zero-internals.ts';
import {ADD, REMOVE, EDIT} from './change-type.ts';
import type {
  Source,
  SourceInput,
  SourceChange,
  Input,
  Output,
  FetchRequest,
  Node as IVMNode,
  Constraint,
  Connection,
  Overlay,
  SourceSchema,
  TableSchema,
  Ordering,
  Condition,
  Row,
  Value,
  SchemaValue,
} from './zero-internals.ts';

type Dir = 'asc' | 'desc';
type Sort = (readonly [string, Dir])[];
// Bound comparators compare rows OR partial seek-keys carrying min/max sentinels.
type BoundComparator = (a: Record<string, unknown>, b: Record<string, unknown>) => number;

export interface DOMSourceSchema {
  tableName: string;
  columns: Record<string, SchemaValue>;
  primaryKey: readonly string[];
}

export class DOMSource implements Source {
  readonly #container: Element;
  readonly #doc: Document;
  readonly #tableName: string;
  readonly #columns: Record<string, SchemaValue>;
  readonly #columnOrder: string[];
  readonly #primaryKey: readonly string[];
  readonly #primaryIndexSort: Sort;
  readonly #pkComparator: BoundComparator;

  readonly #connections: Connection[] = [];
  #overlay: Overlay | undefined;
  #pushEpoch = 0;

  constructor(container: Element, schema: DOMSourceSchema) {
    const {tableName, columns, primaryKey} = schema;
    this.#container = container;
    this.#doc = container.ownerDocument;
    this.#tableName = tableName;
    this.#columns = columns;
    this.#columnOrder = Object.keys(columns);
    this.#primaryKey = primaryKey;
    this.#primaryIndexSort = primaryKey.map(k => [k, 'asc'] as const);
    this.#pkComparator = makeBoundComparator(this.#primaryIndexSort);
  }

  get container(): Element {
    return this.#container;
  }

  get tableSchema(): TableSchema {
    return {
      name: this.#tableName,
      columns: this.#columns,
      primaryKey: this.#primaryKey as TableSchema['primaryKey'],
    };
  }

  get primaryKey(): readonly string[] {
    return this.#primaryKey;
  }

  /** Current committed rows, parsed from the DOM (in document order). */
  currentRows(): Row[] {
    return this.#readAllRows();
  }

  /**
   * Replace the entire container with canonical <tr>s for `rows`. Used by the
   * MutationObserver bridge to revert to a known snapshot before replaying a
   * diff through push(). Does NOT notify connected outputs.
   */
  reset(rows: readonly Row[]): void {
    while (this.#container.firstChild) this.#container.firstChild.remove();
    for (const row of rows) this.#domAdd(row);
  }

  // -- row <-> <tr> serialization ------------------------------------------

  #rowToTr(row: Row): HTMLTableRowElement {
    const tr = this.#doc.createElement('tr');
    for (const col of this.#columnOrder) {
      const v = normalize(row[col]);
      const td = this.#doc.createElement('td');
      td.dataset.col = col;
      td.dataset.v = JSON.stringify(v);
      td.textContent = v === null ? '' : String(v);
      tr.appendChild(td);
    }
    return tr;
  }

  #trToRow(tr: Element): Row {
    const row: Record<string, Value> = {};
    const cells = [...tr.children].filter((c): c is HTMLElement => c.tagName === 'TD');
    cells.forEach((td, i) => {
      const col = td.dataset.col ?? this.#columnOrder[i];
      if (col == null) return;
      const type = this.#columns[col]?.type ?? 'string';
      const text = td.textContent ?? '';
      if (td.dataset.v !== undefined) {
        const parsed = JSON.parse(td.dataset.v) as Value;
        const rendered = parsed === null ? '' : String(parsed);
        // If the visible text still matches data-v, trust the typed value.
        // If it diverges, a user edited the text in place — honor the edit.
        row[col] = text === rendered ? parsed : coerce(text, type);
      } else {
        // Hand-authored cell: coerce text via the schema.
        row[col] = coerce(text, type);
      }
    });
    for (const col of this.#columnOrder) if (!(col in row)) row[col] = null;
    return row;
  }

  #rowTrs(): Element[] {
    return [...this.#container.children].filter(c => c.tagName === 'TR');
  }

  #readAllRows(): Row[] {
    return this.#rowTrs().map(tr => this.#trToRow(tr));
  }

  // -- DOM-backed storage operations ---------------------------------------

  #findTr(row: Row): Element | undefined {
    for (const tr of this.#rowTrs()) {
      const r = this.#trToRow(tr);
      let match = true;
      for (const k of this.#primaryKey) {
        if (!valuesEqual(r[k], row[k])) { match = false; break; }
      }
      if (match) return tr;
    }
    return undefined;
  }

  #has(row: Row): boolean {
    return this.#findTr(row) !== undefined;
  }

  #domAdd(row: Row): void {
    const tr = this.#rowToTr(row);
    // Insert in primary-key order to keep the visible table tidy.
    for (const existing of this.#rowTrs()) {
      if (this.#pkComparator(this.#trToRow(existing), row) > 0) {
        this.#container.insertBefore(tr, existing);
        return;
      }
    }
    this.#container.appendChild(tr);
  }

  #domRemove(row: Row): void {
    const tr = this.#findTr(row);
    if (tr) tr.remove();
  }

  #writeChange(change: SourceChange): void {
    switch (change[0]) {
      case ADD:
        this.#domAdd(change[1]);
        break;
      case REMOVE:
        this.#domRemove(change[1]);
        break;
      case EDIT: // remove old, add new
        this.#domRemove(change[2]);
        this.#domAdd(change[1]);
        break;
      default:
        throw new Error(`unknown change type ${(change as SourceChange)[0]}`);
    }
  }

  // -- Source interface -----------------------------------------------------

  #getSchema(connection: Connection, unordered: boolean): SourceSchema {
    return {
      tableName: this.#tableName,
      columns: this.#columns,
      primaryKey: this.#primaryKey as SourceSchema['primaryKey'],
      sort: unordered ? undefined : connection.sort,
      system: 'client',
      relationships: {},
      isHidden: false,
      compareRows: connection.compareRows,
    };
  }

  connect(sort: Ordering | undefined, filters?: Condition, splitEditKeys?: Set<string>): SourceInput {
    const transformedFilters = transformFilters(filters);
    const unordered = sort === undefined;
    const internalSort = sort ?? (this.#primaryIndexSort as unknown as Ordering);

    const input: SourceInput = {
      getSchema: () => schema,
      fetch: (req: FetchRequest) => this.#fetch(req, connection),
      setOutput: (output: Output) => { connection.output = output; },
      destroy: () => { this.#disconnect(input); },
      fullyAppliedFilters: !transformedFilters.conditionsRemoved,
    };

    const connection: Connection = {
      input,
      output: undefined,
      sort: internalSort,
      splitEditKeys,
      compareRows: makeComparator(internalSort),
      filters: transformedFilters.filters
        ? {
            condition: transformedFilters.filters,
            predicate: createPredicate(transformedFilters.filters),
          }
        : undefined,
      lastPushedEpoch: 0,
    };

    const schema = this.#getSchema(connection, unordered);
    if (!unordered) assertOrderingIncludesPK(internalSort, this.#primaryKey as TableSchema['primaryKey']);
    this.#connections.push(connection);
    return input;
  }

  #disconnect(input: Input): void {
    const idx = this.#connections.findIndex(c => c.input === input);
    if (idx === -1) throw new Error('Connection not found');
    this.#connections.splice(idx, 1);
  }

  /**
   * Build the sorted index for `indexSort` on demand by reading the DOM.
   * MemorySource keeps a persistent BTree per ordering; we re-derive from the
   * DOM (the source of truth) each fetch — simpler and always consistent.
   */
  #deriveIndex(indexSort: Sort): {data: SortedRows; comparator: BoundComparator} {
    const comparator = makeBoundComparator(indexSort);
    const rows = this.#readAllRows();
    rows.sort(comparator as (a: Row, b: Row) => number);
    return {data: new SortedRows(rows, comparator), comparator};
  }

  // A faithful port of MemorySource#fetch — only #deriveIndex differs.
  *#fetch(req: FetchRequest, conn: Connection): Generator<IVMNode | 'yield'> {
    const requestedSort = must(conn.sort) as unknown as Sort;
    const {compareRows} = conn;
    const connectionComparator = req.reverse
      ? (r1: Row, r2: Row) => compareRows(r2, r1)
      : compareRows;
    const pkConstraint = primaryKeyConstraintFromFilters(
      conn.filters?.condition,
      this.#primaryKey as TableSchema['primaryKey'],
    );
    const fetchOrPkConstraint = pkConstraint ?? req.constraint;
    const indexSort: Sort = [];
    if (fetchOrPkConstraint) {
      for (const key of Object.keys(fetchOrPkConstraint)) indexSort.push([key, 'asc']);
    }
    if (
      this.#primaryKey.length > 1 ||
      !fetchOrPkConstraint ||
      !constraintMatchesPrimaryKey(fetchOrPkConstraint, this.#primaryKey as TableSchema['primaryKey'])
    ) {
      indexSort.push(...requestedSort);
    }
    const {data, comparator: compare} = this.#deriveIndex(indexSort);
    const indexComparator: BoundComparator = req.reverse ? (r1, r2) => compare(r2, r1) : compare;
    const startAt = req.start?.row;
    let scanStart: Record<string, unknown> | Row | undefined;
    if (fetchOrPkConstraint) {
      const ss: Record<string, unknown> = {};
      for (const [key, dir] of indexSort) {
        if (hasOwn(fetchOrPkConstraint, key)) ss[key] = (fetchOrPkConstraint as Record<string, unknown>)[key];
        else if (req.reverse) ss[key] = dir === 'asc' ? maxValue : minValue;
        else ss[key] = dir === 'asc' ? minValue : maxValue;
      }
      scanStart = ss;
    } else {
      scanStart = startAt;
    }
    const rowsIterable = generateRows(data, scanStart, req.reverse);
    const withConstraint = generateWithConstraint(
      skipYields(
        generateWithStart(
          generateWithOverlay(
            startAt,
            pkConstraint ? once(rowsIterable) : rowsIterable,
            req.constraint,
            this.#overlay,
            conn.lastPushedEpoch,
            indexComparator,
            conn.filters?.predicate,
          ),
          req.start,
          connectionComparator,
        ),
      ),
      req.constraint,
    );
    yield* conn.filters
      ? generateWithFilter(withConstraint, conn.filters.predicate)
      : withConstraint;
  }

  *push(change: SourceChange): Generator<'yield'> {
    for (const result of this.genPush(change)) if (result === 'yield') yield result;
  }

  *genPush(change: SourceChange): Generator<'yield' | undefined> {
    const exists = (row: Row) => this.#has(row);
    const setOverlay = (o: Overlay | undefined): Overlay | undefined => (this.#overlay = o);
    const writeChange = (c: SourceChange) => this.#writeChange(c);
    yield* genPushAndWriteWithSplitEdit(
      this.#connections,
      change,
      exists,
      setOverlay,
      writeChange,
      () => ++this.#pushEpoch,
    );
  }
}

// --- small local utilities (inlined to keep the brittle-import surface small) ---

function must<T>(v: T | undefined | null, msg?: string): T {
  if (v === undefined || v === null) throw new Error(msg ?? `must: got ${v}`);
  return v;
}

const hasOwn = (o: object, k: PropertyKey): boolean => Object.hasOwn(o, k);

function normalize(v: Value): Value {
  return v === undefined ? null : v;
}

function coerce(text: string, type: string): Value {
  switch (type) {
    case 'number': return text === '' ? null : Number(text);
    case 'boolean': return text === 'true';
    case 'json': return JSON.parse(text) as Value;
    case 'null': return null;
    default: return text;
  }
}

// Caching wrapper so an iterable can be (re)consumed; mirrors shared/once.
function once<T>(iterable: Iterable<T>): Iterable<T> {
  let cache: T[] | null = null;
  return {
    *[Symbol.iterator]() {
      if (cache) { yield* cache; return; }
      const c: T[] = [];
      for (const v of iterable) { c.push(v); yield v; }
      cache = c;
    },
  };
}

// --- copied verbatim from memory-source.js (storage-layer helpers) ---

const minValue = Symbol('min-value');
const maxValue = Symbol('max-value');

function compareBounds(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === 'symbol') return a === minValue ? -1 : 1;
  if (typeof b === 'symbol') return b === minValue ? 1 : -1;
  return compareValues(a as Value, b as Value);
}

function makeBoundComparator(sort: Sort): BoundComparator {
  const len = sort.length;
  const k0 = sort[0]![0];
  const a0 = sort[0]![1] === 'asc';
  const k1 = len > 1 ? sort[1]![0] : '';
  const a1 = len > 1 ? sort[1]![1] === 'asc' : true;
  return (a, b) => {
    const c0 = a0 ? compareBounds(a[k0], b[k0]) : compareBounds(b[k0], a[k0]);
    if (len === 1 || c0 !== 0) return c0;
    const c1 = a1 ? compareBounds(a[k1], b[k1]) : compareBounds(b[k1], a[k1]);
    if (len === 2 || c1 !== 0) return c1;
    for (let i = 2; i < len; i++) {
      const cmp = compareBounds(a[sort[i]![0]], b[sort[i]![0]]);
      if (cmp !== 0) return sort[i]![1] === 'asc' ? cmp : -cmp;
    }
    return 0;
  };
}

function* generateRows(
  data: SortedRows,
  scanStart: Record<string, unknown> | Row | undefined,
  reverse: boolean | undefined,
): Generator<Row> {
  yield* reverse ? data.valuesFromReversed(scanStart) : data.valuesFrom(scanStart);
}

function* generateWithConstraint(
  it: Iterable<IVMNode | 'yield'>,
  constraint: Constraint | undefined,
): Generator<IVMNode | 'yield'> {
  for (const node of it) {
    if (node !== 'yield' && constraint && !constraintMatchesRow(constraint, node.row)) break;
    yield node;
  }
}

function* generateWithFilter(
  it: Iterable<IVMNode | 'yield'>,
  filter: (row: Row) => boolean,
): Generator<IVMNode | 'yield'> {
  for (const node of it) if (node === 'yield' || filter(node.row)) yield node;
}

// A sorted array exposing the BTreeSet seek surface that generateRows needs.
class SortedRows {
  readonly #rows: Row[];
  readonly #cmp: BoundComparator;
  constructor(rows: Row[], cmp: BoundComparator) {
    this.#rows = rows;
    this.#cmp = cmp;
  }
  #lowerBound(key: Record<string, unknown>): number {
    let lo = 0, hi = this.#rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#cmp(this.#rows[mid]!, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  #upperBound(key: Record<string, unknown>): number {
    let lo = 0, hi = this.#rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#cmp(this.#rows[mid]!, key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  *valuesFrom(scanStart: Record<string, unknown> | Row | undefined): Generator<Row> {
    const start = scanStart === undefined ? 0 : this.#lowerBound(scanStart);
    for (let i = start; i < this.#rows.length; i++) yield this.#rows[i]!;
  }
  *valuesFromReversed(scanStart: Record<string, unknown> | Row | undefined): Generator<Row> {
    const start = scanStart === undefined ? this.#rows.length - 1 : this.#upperBound(scanStart) - 1;
    for (let i = start; i >= 0; i--) yield this.#rows[i]!;
  }
}
