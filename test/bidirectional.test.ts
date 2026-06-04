// Bidirectional collectionSource: a flat DOM table where API pushes mutate the
// DOM (writeChange) AND DOM edits flow into queries (getRows + sync). Proves
// round-trip works and that the outbound write doesn't echo back (no double-apply).

import {Window} from 'happy-dom';
import {domTableSource} from '../src/dom-table-source.ts';
import {ADD, REMOVE, EDIT} from '../src/change-type.ts';
import type {Node as IVMNode} from '../src/zero-internals.ts';

const document: any = new Window().document;
const S = (v: unknown): string => JSON.stringify(v);

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};
const drain = (s: Iterable<unknown>): void => { for (const _ of s) { /* */ } };

const columns = {id: {type: 'number'}, name: {type: 'string'}} as const;
const tbody = document.createElement('tbody');
const src = domTableSource(tbody, {name: 'item', columns, primaryKey: ['id']});

const input = src.connect([['id', 'asc']]);
const queryRows = () => [...input.fetch({})].filter((n): n is IVMNode => n !== 'yield').map(n => n.row);
const trCount = () => [...tbody.children].filter((c: any) => c.tagName === 'TR').length;
const domCell = (id: string, col: number) =>
  [...tbody.children].find((tr: any) => tr.children[0].dataset.v === id)?.children[col].textContent;

// 1. OUTBOUND: an API push mutates the DOM and the query.
drain(src.push([ADD, {id: 1, name: 'a'}, null]));
check('push inserts a <tr> into the DOM', trCount(), 1);
check('push is visible to the query', queryRows(), [{id: 1, name: 'a'}]);

// 2. NO ECHO: the writeChange fired the observer, but committed was advanced —
//    so a reconcile finds nothing to do (no duplicate row).
check('sync after push is a no-op (echo suppressed)', src.sync(), 0);
check('still exactly one <tr>', trCount(), 1);

// 3. INBOUND: a raw DOM edit flows into the query via sync.
const tr = document.createElement('tr');
const mkTd = (col: string, v: unknown) => {
  const td = document.createElement('td');
  td.dataset.col = col; td.dataset.v = JSON.stringify(v); td.textContent = String(v);
  return td;
};
tr.append(mkTd('id', 2), mkTd('name', 'b'));
tbody.appendChild(tr);
check('a DOM-appended <tr> is one inbound change', src.sync(), 1);
check('query sees both rows', queryRows(), [{id: 1, name: 'a'}, {id: 2, name: 'b'}]);

// 4. OUTBOUND edit: API edit updates the DOM cell and the query.
drain(src.push([EDIT, {id: 1, name: 'A'}, {id: 1, name: 'a'}]));
check('edit reflected in the query', queryRows(), [{id: 1, name: 'A'}, {id: 2, name: 'b'}]);
check('edit reflected in the DOM cell', domCell('1', 1), 'A');
check('no echo after edit', src.sync(), 0);

// 5. OUTBOUND remove: API remove drops the <tr>.
drain(src.push([REMOVE, {id: 2, name: 'b'}, null]));
check('remove drops the <tr>', trCount(), 1);
check('query sees one row', queryRows(), [{id: 1, name: 'A'}]);
check('no echo after remove', src.sync(), 0);

src.destroy();
console.log(failures === 0 ? '\n✅ Bidirectional collectionSource (push → DOM, DOM → query) works' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
