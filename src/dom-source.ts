// ---------------------------------------------------------------------------
// DOMSource — a flat `<tbody>` table as a Zero Source, now expressed as a
// `RowStore` backend over `createSource`. Each row is a `<tr>`; columns are
// `<td>`s carrying a JSON-encoded typed value in `data-v` (so types survive)
// plus human-readable text. Hand-authored cells without `data-v` are coerced via
// the schema, so an existing HTML table IS a source.
//
//   DOMSource = createSource(table, new DomRowStore(<tbody>, schema))
//
// All the IVM machinery lives in createSource; DomRowStore is just storage:
// has / insert / delete / update / rows over the DOM. A same-pk edit updates the
// `<tr>` in place (preserving the node, untouched cells, and any cursor).
// ---------------------------------------------------------------------------

import {createSource} from './create-source.ts';
import type {RowStore} from './create-source.ts';
import {makeComparator, valuesEqual} from './zero-internals.ts';
import type {
  Source, SourceInput, SourceChange, TableSchema, Ordering, Condition, Row, Value, SchemaValue,
} from './zero-internals.ts';

export interface DOMSourceSchema {
  tableName: string;
  columns: Record<string, SchemaValue>;
  primaryKey: readonly string[];
}

const normalize = (v: Value): Value => (v === undefined ? null : v);

function coerce(text: string, type: string): Value {
  switch (type) {
    case 'number': return text === '' ? null : Number(text);
    case 'boolean': return text === 'true';
    case 'json': return JSON.parse(text) as Value;
    case 'null': return null;
    default: return text;
  }
}

/** A RowStore whose storage is a live `<tbody>` of `<tr>` rows. */
class DomRowStore implements RowStore {
  readonly #container: Element;
  readonly #doc: Document;
  readonly #columns: Record<string, SchemaValue>;
  readonly #columnOrder: string[];
  readonly #primaryKey: readonly string[];
  readonly #pkComparator: (a: Row, b: Row) => number;

  constructor(container: Element, schema: DOMSourceSchema) {
    this.#container = container;
    this.#doc = container.ownerDocument;
    this.#columns = schema.columns;
    this.#columnOrder = Object.keys(schema.columns);
    this.#primaryKey = schema.primaryKey;
    this.#pkComparator = makeComparator(schema.primaryKey.map(k => [k, 'asc'] as const) as unknown as Ordering);
  }

  get container(): Element { return this.#container; }
  get primaryKey(): readonly string[] { return this.#primaryKey; }

  // -- serialization --------------------------------------------------------
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
        row[col] = text === rendered ? parsed : coerce(text, type); // honor in-place text edits
      } else {
        row[col] = coerce(text, type); // hand-authored cell
      }
    });
    for (const col of this.#columnOrder) if (!(col in row)) row[col] = null;
    return row;
  }

  #rowTrs(): Element[] {
    return [...this.#container.children].filter(c => c.tagName === 'TR');
  }

  #findTr(row: Row): Element | undefined {
    return this.#rowTrs().find(tr => {
      const r = this.#trToRow(tr);
      return this.#primaryKey.every((k: string) => valuesEqual(r[k], row[k]));
    });
  }

  // Update only the cells whose value actually changed (preserves node + cursor).
  #updateTr(tr: Element, row: Row): void {
    const cells = [...tr.children].filter((c): c is HTMLElement => c.tagName === 'TD');
    cells.forEach((td, i) => {
      const col = td.dataset.col ?? this.#columnOrder[i];
      if (col == null) return;
      const v = normalize(row[col]);
      const encoded = JSON.stringify(v);
      if (td.dataset.v === encoded) return;
      td.dataset.v = encoded;
      td.textContent = v === null ? '' : String(v);
    });
  }

  // -- RowStore -------------------------------------------------------------
  has(row: Row): boolean {
    return this.#findTr(row) !== undefined;
  }

  insert(row: Row): void {
    const tr = this.#rowToTr(row);
    for (const existing of this.#rowTrs()) {
      if (this.#pkComparator(this.#trToRow(existing), row) > 0) {
        this.#container.insertBefore(tr, existing);
        return;
      }
    }
    this.#container.appendChild(tr);
  }

  delete(row: Row): void {
    this.#findTr(row)?.remove();
  }

  update(oldRow: Row, newRow: Row): void {
    if (this.#primaryKey.every((k: string) => valuesEqual(oldRow[k], newRow[k]))) {
      const tr = this.#findTr(oldRow);
      if (tr) { this.#updateTr(tr, newRow); return; }
    }
    this.delete(oldRow);
    this.insert(newRow);
  }

  *rows(): Generator<Row> {
    for (const tr of this.#rowTrs()) yield this.#trToRow(tr);
  }

  reset(rows: readonly Row[]): void {
    while (this.#container.firstChild) this.#container.firstChild.remove();
    for (const row of rows) this.insert(row);
  }
}

/**
 * A Zero Source whose storage is a live `<tbody>`. Thin wrapper over
 * `createSource` + `DomRowStore`, plus the extra surface (`container`,
 * `currentRows`, `reset`) the `observeDOM` bridge uses.
 */
export class DOMSource implements Source {
  readonly #store: DomRowStore;
  readonly #source: Source;
  readonly #compare: (a: Row, b: Row) => number;

  constructor(container: Element, schema: DOMSourceSchema) {
    this.#store = new DomRowStore(container, schema);
    this.#source = createSource(
      {name: schema.tableName, columns: schema.columns, primaryKey: schema.primaryKey},
      this.#store,
    );
    // An all-columns comparator: `compare(a, b) === 0` iff a and b have identical
    // values — using Zero's value semantics (null/bigint), not JSON.stringify.
    this.#compare = makeComparator(
      Object.keys(schema.columns).map(c => [c, 'asc'] as const) as unknown as Ordering,
    );
  }

  get container(): Element { return this.#store.container; }
  get primaryKey(): readonly string[] { return this.#store.primaryKey; }
  /** Current committed rows, parsed from the DOM (document order). */
  currentRows(): Row[] { return [...this.#store.rows()]; }
  /** Replace the whole container with canonical `<tr>`s for `rows`. */
  reset(rows: readonly Row[]): void { this.#store.reset(rows); }
  /** Total order over all columns; `=== 0` means identical content. */
  compare(a: Row, b: Row): number { return this.#compare(a, b); }

  get tableSchema(): TableSchema { return this.#source.tableSchema; }
  connect(sort: Ordering | undefined, filters?: Condition, splitEditKeys?: Set<string>): SourceInput {
    return this.#source.connect(sort, filters, splitEditKeys);
  }
  push(change: SourceChange): ReturnType<Source['push']> { return this.#source.push(change); }
  genPush(change: SourceChange): ReturnType<Source['genPush']> { return this.#source.genPush(change); }
}
