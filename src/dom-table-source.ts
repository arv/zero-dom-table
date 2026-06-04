// ---------------------------------------------------------------------------
// domTableSource — a flat DOM `<tbody>` table as a BIDIRECTIONAL Zero Source,
// built on collectionSource.
//
// This is the "projection" sibling of DOMSource (which stores rows *as* the
// literal DOM and reads them back in fetch). Here the IVM storage is the inner
// MemorySource; the DOM is kept in sync in BOTH directions:
//   • inbound  — a MutationObserver re-reads the <tr>s on any DOM edit (getRows
//                + subscribe), diffing into the source.
//   • outbound — a pushed change inserts/removes a <tr> (writeChange).
// So `source.push(...)` mutates the table AND editing the table flows into
// queries — the same bidirectional behavior as DOMSource, but without porting
// fetch/overlay/comparators and without the destructive revert-replay (the DOM
// is a mirror of the committed store, not the store itself).
// ---------------------------------------------------------------------------

import {collectionSource} from './collection-source.ts';
import type {CollectionSource, SourceTable} from './collection-source.ts';
import {valuesEqual} from './zero-internals.ts';
import type {Row, Value} from './zero-internals.ts';
import {ADD, REMOVE} from './change-type.ts';

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

/**
 * @param tbody container holding the row `<tr>`s.
 * @param table `{name, columns, primaryKey}` (e.g. `schema.tables.x`).
 */
export function domTableSource(tbody: Element, table: SourceTable): CollectionSource {
  const doc = tbody.ownerDocument;
  const cols = Object.keys(table.columns);
  const pk = table.primaryKey;

  const rowToTr = (row: Row): HTMLTableRowElement => {
    const tr = doc.createElement('tr');
    for (const col of cols) {
      const v = normalize(row[col]);
      const td = doc.createElement('td');
      td.dataset.col = col;
      td.dataset.v = JSON.stringify(v);
      td.textContent = v === null ? '' : String(v);
      tr.appendChild(td);
    }
    return tr;
  };

  const trToRow = (tr: Element): Row => {
    const row: Record<string, Value> = {};
    const cells = [...tr.children].filter((c): c is HTMLElement => c.tagName === 'TD');
    cells.forEach((td, i) => {
      const col = td.dataset.col ?? cols[i];
      if (col == null) return;
      const type = table.columns[col]?.type ?? 'string';
      const text = td.textContent ?? '';
      if (td.dataset.v !== undefined) {
        const parsed = JSON.parse(td.dataset.v) as Value;
        const rendered = parsed === null ? '' : String(parsed);
        row[col] = text === rendered ? parsed : coerce(text, type); // honor in-place text edits
      } else {
        row[col] = coerce(text, type); // hand-authored cell
      }
    });
    for (const col of cols) if (!(col in row)) row[col] = null;
    return row;
  };

  const rowTrs = (): Element[] => [...tbody.children].filter(c => c.tagName === 'TR');
  const findTr = (row: Row): Element | undefined =>
    rowTrs().find(tr => {
      const r = trToRow(tr);
      return pk.every((k: string) => valuesEqual(r[k], row[k]));
    });
  const domRemove = (row: Row): void => { findTr(row)?.remove(); };
  const domAdd = (row: Row): void => { tbody.appendChild(rowToTr(row)); };

  return collectionSource(table, {
    getRows: () => rowTrs().map(trToRow),
    subscribe: onChange => {
      const MO =
        (tbody.ownerDocument?.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ??
        globalThis.MutationObserver;
      const obs = new MO(onChange);
      obs.observe(tbody, {childList: true, subtree: true, characterData: true, attributes: true});
      return () => obs.disconnect();
    },
    writeChange: change => {
      switch (change[0]) {
        case ADD: domAdd(change[1]); break;
        case REMOVE: domRemove(change[1]); break;
        default: domRemove(change[2]); domAdd(change[1]); break; // EDIT
      }
    },
  });
}
