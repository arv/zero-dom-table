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
// comparator machinery are reused verbatim from Zero's MemorySource (imported
// through ./zero-internals.js). Only the *storage layer* differs:
//   - `#fetch`        reads rows out of the DOM and sorts them on demand
//   - `#writeChange`  mutates the DOM (<tr> insert / remove)
//   - `#has`          checks row presence by primary key in the DOM
// The DOM is the single source of truth; no secondary indexes are persisted.
// ---------------------------------------------------------------------------

import {
  // reused verbatim from Zero:
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
} from './zero-internals.js';

export class DOMSource {
  #container;
  #doc;
  #tableName;
  #columns;
  #columnOrder;
  #primaryKey;
  #primaryIndexSort;
  #pkComparator;

  #connections = [];
  #overlay;
  #pushEpoch = 0;

  /**
   * @param {Element} container element that holds the row <tr>s (e.g. a <tbody>)
   * @param {{tableName: string, columns: Record<string, {type: string}>, primaryKey: readonly string[]}} schema
   */
  constructor(container, {tableName, columns, primaryKey}) {
    this.#container = container;
    this.#doc = container.ownerDocument;
    this.#tableName = tableName;
    this.#columns = columns;
    this.#columnOrder = Object.keys(columns);
    this.#primaryKey = primaryKey;
    this.#primaryIndexSort = primaryKey.map(k => [k, 'asc']);
    this.#pkComparator = makeBoundComparator(this.#primaryIndexSort);
  }

  get container() {
    return this.#container;
  }

  get tableSchema() {
    return {
      name: this.#tableName,
      columns: this.#columns,
      primaryKey: this.#primaryKey,
    };
  }

  get primaryKey() {
    return this.#primaryKey;
  }

  /** Current committed rows, parsed from the DOM (in document order). */
  currentRows() {
    return this.#readAllRows();
  }

  /**
   * Replace the entire container with canonical <tr>s for `rows`. Used by the
   * MutationObserver bridge to revert to a known snapshot before replaying a
   * diff through push(). Does NOT notify connected outputs.
   */
  reset(rows) {
    while (this.#container.firstChild) this.#container.firstChild.remove();
    for (const row of rows) this.#domAdd(row);
  }

  // -- row <-> <tr> serialization ------------------------------------------

  #rowToTr(row) {
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

  #trToRow(tr) {
    const row = {};
    const cells = [...tr.children].filter(c => c.tagName === 'TD');
    cells.forEach((td, i) => {
      const col = td.dataset.col ?? this.#columnOrder[i];
      if (col == null) return;
      const type = this.#columns[col]?.type ?? 'string';
      if (td.dataset.v !== undefined) {
        const parsed = JSON.parse(td.dataset.v);
        const rendered = parsed === null ? '' : String(parsed);
        // If the visible text still matches data-v, trust the typed value.
        // If it diverges, a user edited the text in place — honor the edit.
        row[col] = td.textContent === rendered ? parsed : coerce(td.textContent, type);
      } else {
        // Hand-authored cell: coerce text via the schema.
        row[col] = coerce(td.textContent, type);
      }
    });
    for (const col of this.#columnOrder) if (!(col in row)) row[col] = null;
    return row;
  }

  #rowTrs() {
    return [...this.#container.children].filter(c => c.tagName === 'TR');
  }

  #readAllRows() {
    return this.#rowTrs().map(tr => this.#trToRow(tr));
  }

  // -- DOM-backed storage operations ---------------------------------------

  #findTr(row) {
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

  #has(row) {
    return this.#findTr(row) !== undefined;
  }

  #domAdd(row) {
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

  #domRemove(row) {
    const tr = this.#findTr(row);
    if (tr) tr.remove();
  }

  #writeChange(change) {
    switch (change[0]) {
      case 0: // ADD
        this.#domAdd(change[1]);
        break;
      case 1: // REMOVE
        this.#domRemove(change[1]);
        break;
      case 2: // EDIT: remove old, add new
        this.#domRemove(change[2]);
        this.#domAdd(change[1]);
        break;
      default:
        throw new Error(`unknown change type ${change[0]}`);
    }
  }

  // -- Source interface -----------------------------------------------------

  #getSchema(connection, unordered) {
    return {
      tableName: this.#tableName,
      columns: this.#columns,
      primaryKey: this.#primaryKey,
      sort: unordered ? undefined : connection.sort,
      system: 'client',
      relationships: {},
      isHidden: false,
      compareRows: connection.compareRows,
    };
  }

  connect(sort, filters, splitEditKeys) {
    const transformedFilters = transformFilters(filters);
    const unordered = sort === undefined;
    const internalSort = sort ?? this.#primaryIndexSort;

    const input = {
      getSchema: () => schema,
      fetch: req => this.#fetch(req, connection),
      setOutput: output => { connection.output = output; },
      destroy: () => { this.#disconnect(input); },
      fullyAppliedFilters: !transformedFilters.conditionsRemoved,
    };

    const connection = {
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
    if (!unordered) assertOrderingIncludesPK(internalSort, this.#primaryKey);
    this.#connections.push(connection);
    return input;
  }

  #disconnect(input) {
    const idx = this.#connections.findIndex(c => c.input === input);
    if (idx === -1) throw new Error('Connection not found');
    this.#connections.splice(idx, 1);
  }

  /**
   * Build the sorted index for `indexSort` on demand by reading the DOM.
   * MemorySource keeps a persistent BTree per ordering; we re-derive from the
   * DOM (the source of truth) each fetch — simpler and always consistent.
   */
  #deriveIndex(indexSort) {
    const comparator = makeBoundComparator(indexSort);
    const rows = this.#readAllRows();
    rows.sort(comparator);
    return {data: new SortedRows(rows, comparator), comparator};
  }

  // A faithful port of MemorySource#fetch — only #deriveIndex differs.
  *#fetch(req, conn) {
    const requestedSort = must(conn.sort);
    const {compareRows} = conn;
    const connectionComparator = req.reverse
      ? (r1, r2) => compareRows(r2, r1)
      : compareRows;
    const pkConstraint = primaryKeyConstraintFromFilters(
      conn.filters?.condition,
      this.#primaryKey,
    );
    const fetchOrPkConstraint = pkConstraint ?? req.constraint;
    const indexSort = [];
    if (fetchOrPkConstraint) {
      for (const key of Object.keys(fetchOrPkConstraint)) indexSort.push([key, 'asc']);
    }
    if (
      this.#primaryKey.length > 1 ||
      !fetchOrPkConstraint ||
      !constraintMatchesPrimaryKey(fetchOrPkConstraint, this.#primaryKey)
    ) {
      indexSort.push(...requestedSort);
    }
    const {data, comparator: compare} = this.#deriveIndex(indexSort);
    const indexComparator = req.reverse ? (r1, r2) => compare(r2, r1) : compare;
    const startAt = req.start?.row;
    let scanStart;
    if (fetchOrPkConstraint) {
      scanStart = {};
      for (const [key, dir] of indexSort) {
        if (hasOwn(fetchOrPkConstraint, key)) scanStart[key] = fetchOrPkConstraint[key];
        else if (req.reverse) scanStart[key] = dir === 'asc' ? maxValue : minValue;
        else scanStart[key] = dir === 'asc' ? minValue : maxValue;
      }
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

  *push(change) {
    for (const result of this.genPush(change)) if (result === 'yield') yield result;
  }

  *genPush(change) {
    const exists = row => this.#has(row);
    const setOverlay = o => { this.#overlay = o; };
    const writeChange = c => this.#writeChange(c);
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

function must(v, msg) {
  if (v === undefined || v === null) throw new Error(msg ?? `must: got ${v}`);
  return v;
}

const hasOwn = (o, k) => Object.hasOwn(o, k);

function normalize(v) {
  return v === undefined ? null : v;
}

function coerce(text, type) {
  switch (type) {
    case 'number': return text === '' ? null : Number(text);
    case 'boolean': return text === 'true';
    case 'json': return JSON.parse(text);
    case 'null': return null;
    default: return text;
  }
}

// Caching wrapper so an iterable can be (re)consumed; mirrors shared/once.
function once(iterable) {
  let cache = null;
  return {
    *[Symbol.iterator]() {
      if (cache) { yield* cache; return; }
      const c = [];
      for (const v of iterable) { c.push(v); yield v; }
      cache = c;
    },
  };
}

// --- copied verbatim from memory-source.js (storage-layer helpers) ---

const minValue = Symbol('min-value');
const maxValue = Symbol('max-value');

function compareBounds(a, b) {
  if (a === b) return 0;
  if (typeof a === 'symbol') return a === minValue ? -1 : 1;
  if (typeof b === 'symbol') return b === minValue ? 1 : -1;
  return compareValues(a, b);
}

function makeBoundComparator(sort) {
  const len = sort.length;
  const k0 = sort[0][0];
  const a0 = sort[0][1] === 'asc';
  const k1 = len > 1 ? sort[1][0] : '';
  const a1 = len > 1 ? sort[1][1] === 'asc' : true;
  return (a, b) => {
    const c0 = a0 ? compareBounds(a[k0], b[k0]) : compareBounds(b[k0], a[k0]);
    if (len === 1 || c0 !== 0) return c0;
    const c1 = a1 ? compareBounds(a[k1], b[k1]) : compareBounds(b[k1], a[k1]);
    if (len === 2 || c1 !== 0) return c1;
    for (let i = 2; i < len; i++) {
      const cmp = compareBounds(a[sort[i][0]], b[sort[i][0]]);
      if (cmp !== 0) return sort[i][1] === 'asc' ? cmp : -cmp;
    }
    return 0;
  };
}

function* generateRows(data, scanStart, reverse) {
  yield* data[reverse ? 'valuesFromReversed' : 'valuesFrom'](scanStart);
}

function* generateWithConstraint(it, constraint) {
  for (const node of it) {
    if (constraint && !constraintMatchesRow(constraint, node.row)) break;
    yield node;
  }
}

function* generateWithFilter(it, filter) {
  for (const node of it) if (filter(node.row)) yield node;
}

// A sorted array exposing the BTreeSet seek surface that generateRows needs.
class SortedRows {
  #rows;
  #cmp;
  constructor(rows, cmp) {
    this.#rows = rows;
    this.#cmp = cmp;
  }
  #lowerBound(key) {
    let lo = 0, hi = this.#rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#cmp(this.#rows[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  #upperBound(key) {
    let lo = 0, hi = this.#rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#cmp(this.#rows[mid], key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  *valuesFrom(scanStart) {
    const start = scanStart === undefined ? 0 : this.#lowerBound(scanStart);
    for (let i = start; i < this.#rows.length; i++) yield this.#rows[i];
  }
  *valuesFromReversed(scanStart) {
    const start =
      scanStart === undefined ? this.#rows.length - 1 : this.#upperBound(scanStart) - 1;
    for (let i = start; i >= 0; i--) yield this.#rows[i];
  }
}
