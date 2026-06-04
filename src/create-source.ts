// ---------------------------------------------------------------------------
// createSource — the proposed public seam for custom Zero sources.
//
// `MemorySource`'s connect / push / genPush and all the overlay-splicing,
// split-edit, comparator, and multi-sort-index machinery are GENERIC — only the
// storage layer is BTree-specific. So this factory contains that generic IVM
// machinery and takes a tiny `RowStore` backend: you implement has/insert/delete
// (+ optional update) and `rows()`, and Zero handles correctness (the volatile
// `Source`/yield protocol stays sealed inside here).
//
// This is the durable extension point: a DOM source, a sqlite source, an
// IndexedDB source are each ~a RowStore. (See dom-source.ts: DOMSource is just
// `createSource(table, new DomRowStore(...))`.)
//
// NB: in this repo the IVM helpers come from ./zero-internals (the relative-path
// hack). In Zero proper this file would BE part of the package and import them
// directly — the public surface (`createSource`, `RowStore`) is what's clean.
// ---------------------------------------------------------------------------

import {
  genPushAndWriteWithSplitEdit,
  generateWithOverlay,
  generateWithStart,
  skipYields,
  makeComparator,
  compareValues,
  primaryKeyConstraintFromFilters,
  constraintMatchesPrimaryKey,
  constraintMatchesRow,
  transformFilters,
  createPredicate,
  assertOrderingIncludesPK,
} from './zero-internals.ts';
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
import {ADD, REMOVE, EDIT} from './change-type.ts';

/**
 * The storage backend a custom source implements. Zero maintains the sorted
 * indexes by reading `rows()`; you supply identity, mutation, and iteration.
 */
export interface RowStore {
  /** Does a row with this primary key exist? */
  has(row: Row): boolean;
  insert(row: Row): void;
  delete(row: Row): void;
  /** Optional in-place edit; defaults to delete(old) + insert(new). */
  update?(oldRow: Row, newRow: Row): void;
  /** All current rows, any order — Zero sorts/indexes them per query. */
  rows(): Iterable<Row>;
}

export interface CreateSourceTable {
  name: string;
  columns: Record<string, SchemaValue>;
  primaryKey: readonly string[];
}

type Dir = 'asc' | 'desc';
type Sort = (readonly [string, Dir])[];
type BoundComparator = (a: Record<string, unknown>, b: Record<string, unknown>) => number;

export function createSource(table: CreateSourceTable, store: RowStore): Source {
  return new GenericSource(table, store);
}

class GenericSource implements Source {
  readonly #store: RowStore;
  readonly #tableName: string;
  readonly #columns: Record<string, SchemaValue>;
  readonly #primaryKey: readonly string[];
  readonly #primaryIndexSort: Sort;
  readonly #connections: Connection[] = [];
  #overlay: Overlay | undefined;
  #pushEpoch = 0;

  constructor(table: CreateSourceTable, store: RowStore) {
    this.#store = store;
    this.#tableName = table.name;
    this.#columns = table.columns;
    this.#primaryKey = table.primaryKey;
    this.#primaryIndexSort = table.primaryKey.map(k => [k, 'asc'] as const);
  }

  get tableSchema(): TableSchema {
    return {
      name: this.#tableName,
      columns: this.#columns,
      primaryKey: this.#primaryKey as TableSchema['primaryKey'],
    };
  }

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
        ? {condition: transformedFilters.filters, predicate: createPredicate(transformedFilters.filters)}
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

  // Build the sorted index for `indexSort` on demand from the backend's rows.
  #deriveIndex(indexSort: Sort): {data: SortedRows; comparator: BoundComparator} {
    const comparator = makeBoundComparator(indexSort);
    const rows = [...this.#store.rows()];
    rows.sort(comparator as (a: Row, b: Row) => number);
    return {data: new SortedRows(rows, comparator), comparator};
  }

  // A faithful port of MemorySource#fetch — only #deriveIndex differs.
  *#fetch(req: FetchRequest, conn: Connection): Generator<IVMNode | 'yield'> {
    const requestedSort = must(conn.sort) as unknown as Sort;
    const {compareRows} = conn;
    const connectionComparator = req.reverse ? (r1: Row, r2: Row) => compareRows(r2, r1) : compareRows;
    const pkConstraint = primaryKeyConstraintFromFilters(conn.filters?.condition, this.#primaryKey as TableSchema['primaryKey']);
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
    yield* conn.filters ? generateWithFilter(withConstraint, conn.filters.predicate) : withConstraint;
  }

  #writeChange(change: SourceChange): void {
    switch (change[0]) {
      case ADD:
        this.#store.insert(change[1]);
        break;
      case REMOVE:
        this.#store.delete(change[1]);
        break;
      case EDIT:
        if (this.#store.update) this.#store.update(change[2], change[1]);
        else { this.#store.delete(change[2]); this.#store.insert(change[1]); }
        break;
      default:
        throw new Error(`unknown change type ${(change as SourceChange)[0]}`);
    }
  }

  *push(change: SourceChange): Generator<'yield'> {
    for (const result of this.genPush(change)) if (result === 'yield') yield result;
  }

  *genPush(change: SourceChange): Generator<'yield' | undefined> {
    const exists = (row: Row) => this.#store.has(row);
    const setOverlay = (o: Overlay | undefined): Overlay | undefined => (this.#overlay = o);
    const writeChange = (c: SourceChange) => this.#writeChange(c);
    yield* genPushAndWriteWithSplitEdit(this.#connections, change, exists, setOverlay, writeChange, () => ++this.#pushEpoch);
  }
}

// --- local utilities (copied verbatim from memory-source.js's storage layer) ---

function must<T>(v: T | undefined | null, msg?: string): T {
  if (v === undefined || v === null) throw new Error(msg ?? `must: got ${v}`);
  return v;
}

const hasOwn = (o: object, k: PropertyKey): boolean => Object.hasOwn(o, k);

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

const minValue = Symbol('min-value');
const maxValue = Symbol('max-value');

function compareBounds(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === 'symbol') return a === minValue ? -1 : 1;
  if (typeof b === 'symbol') return b === minValue ? 1 : -1;
  return compareValues(a as Value, b as Value);
}

/** Exported so backends can keep their store pk-ordered if they like. */
export function makeBoundComparator(sort: Sort): BoundComparator {
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
      if (this.#cmp(this.#rows[mid]!, key) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  #upperBound(key: Record<string, unknown>): number {
    let lo = 0, hi = this.#rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#cmp(this.#rows[mid]!, key) <= 0) lo = mid + 1; else hi = mid;
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
