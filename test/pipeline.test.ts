// End-to-end: a real Zero query pipeline (Filter + sort operators) built from an
// AST, reading from DOMSource, materialized into a live ArrayView — updated both
// by source.push() AND by direct DOM edits through the observer bridge.

import {Window} from 'happy-dom';
import {DOMSource} from '../src/dom-source.ts';
import {observeDOM} from '../src/observe-dom.ts';
import {buildPipeline, ArrayView, MemoryStorage} from '../src/zero-internals.ts';
import type {BuilderDelegate} from '../src/zero-internals.ts';
import {ADD, EDIT} from '../src/change-type.ts';

const document: any = new Window().document;
const S = (v: unknown): string => JSON.stringify(v);

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};

const columns = {
  id: {type: 'number'},
  name: {type: 'string'},
  score: {type: 'number'},
  active: {type: 'boolean'},
} as const;
const tbody = document.createElement('tbody');
const source = new DOMSource(tbody, {tableName: 'item', columns, primaryKey: ['id']});

// Seed a few rows through the source API.
const seed = [
  {id: 1, name: 'alice', score: 5, active: true},
  {id: 2, name: 'bob', score: 12, active: true},
  {id: 3, name: 'carol', score: 20, active: false},
];
for (const row of seed) for (const _ of source.push([ADD, row, null])) { /* drain */ }

// A BuilderDelegate that hands Zero our DOM-backed source.
const delegate: BuilderDelegate = {
  getSource: name => (name === 'item' ? source : undefined),
  createStorage: () => new MemoryStorage(),
  decorateInput: i => i,
  decorateFilterInput: i => i,
  decorateSourceInput: i => i,
  addEdge: () => {},
};

// ZQL equivalent:  item.where('score', '>=', 10).orderBy('score', 'desc')
const ast: any = {
  table: 'item',
  where: {type: 'simple', op: '>=', left: {type: 'column', name: 'score'}, right: {type: 'literal', value: 10}},
  orderBy: [['score', 'desc'], ['id', 'asc']],
};

const input = buildPipeline(ast, delegate, 'q-scores');
const view = new ArrayView(input, {singular: false, relationships: {}}, true, () => {});
view.flush();

const names = (): unknown[] => (view.data as any[]).map(r => r.name);

check('initial materialized view (score>=10, desc)', names(), ['carol', 'bob']);

// --- Update via the source API ---
for (const _ of source.push([ADD, {id: 4, name: 'dave', score: 99, active: true}, null])) { /* drain */ }
view.flush();
check('push high score -> enters view at top', names(), ['dave', 'carol', 'bob']);

// Edit bob's score below the threshold -> should leave the view.
for (const _ of source.push([EDIT, {id: 2, name: 'bob', score: 1, active: true}, {id: 2, name: 'bob', score: 12, active: true}])) { /* drain */ }
view.flush();
check('edit below threshold -> leaves view', names(), ['dave', 'carol']);

// --- Update via DIRECT DOM EDIT, through the observer bridge ---
const bridge = observeDOM(source, {});
const tr = document.createElement('tr');
tr.innerHTML = `<td>5</td><td>erin</td><td>50</td><td>true</td>`;
tbody.appendChild(tr);          // user appends a row in the DOM...
bridge.flush();                 // ...observer pushes it into the pipeline...
view.flush();                   // ...and the Zero view reflects it.
check('DOM-appended row flows into the live Zero view', names(), ['dave', 'erin', 'carol']);

console.log(failures === 0 ? '\n✅ Real Zero pipeline runs on a DOM-backed source' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
