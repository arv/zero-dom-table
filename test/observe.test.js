// DOM-driven test: edits made directly to the DOM must flow into Zero queries
// via the MutationObserver bridge. Starts from a hand-authored HTML table.

import {Window} from 'happy-dom';
import {DOMSource} from '../src/dom-source.js';
import {observeDOM} from '../src/observe-dom.js';

const window = new Window();
const document = window.document;
const S = v => JSON.stringify(v);

let failures = 0;
const check = (label, actual, expected) => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};

// 1. Hand-authored table — plain <td> text, no data-v. The source adopts it.
const tbody = document.createElement('tbody');
tbody.innerHTML = `
  <tr><td>2</td><td>bob</td><td>10</td><td>true</td></tr>
  <tr><td>1</td><td>alice</td><td>5</td><td>false</td></tr>
`;

const columns = {
  id: {type: 'number'},
  name: {type: 'string'},
  score: {type: 'number'},
  active: {type: 'boolean'},
};
const source = new DOMSource(tbody, {tableName: 'item', columns, primaryKey: ['id']});

// A live query: id-ascending, plus a running aggregate driven by pushed changes.
const input = source.connect([['id', 'asc']]);
let activeCount = 0;
const log = [];
input.setOutput({
  push(change) {
    const [type, node] = change;
    log.push(type === 0 ? 'add' : type === 1 ? 'remove' : 'edit');
    if (type === 0 && node.row.active) activeCount++;
    if (type === 1 && node.row.active) activeCount--;
    if (type === 2) {
      const old = change[2].row;
      activeCount += (node.row.active ? 1 : 0) - (old.active ? 1 : 0);
    }
    return [];
  },
});

const fetchAll = () => [...input.fetch({})].filter(n => n !== 'yield').map(n => n.row);

// Seed activeCount from initial adoption (bob active, alice not).
for (const r of source.currentRows()) if (r.active) activeCount++;

check('adopted hand-authored rows, typed + id-sorted', fetchAll(), [
  {id: 1, name: 'alice', score: 5, active: false},
  {id: 2, name: 'bob', score: 10, active: true},
]);
check('initial active count', activeCount, 1);

// 2. Start observing, then mutate the DOM directly (as a user/JS would).
const bridge = observeDOM(source, {});

// (a) Append a brand-new row via raw DOM.
const tr = document.createElement('tr');
tr.innerHTML = `<td>3</td><td>carol</td><td>20</td><td>true</td>`;
tbody.appendChild(tr);

// (b) Edit a cell in place: flip alice's active false -> true.
const aliceActiveCell = [...tbody.children]
  .map(tr => tr)
  .find(tr => tr.children[0].textContent === '1').children[3];
aliceActiveCell.textContent = 'true';

// (c) Remove bob entirely.
[...tbody.children].find(tr => tr.children[0].textContent === '2').remove();

bridge.flush(); // deterministic reconcile (observer would fire on a microtask)

check('query reflects DOM-driven add + edit + remove', fetchAll(), [
  {id: 1, name: 'alice', score: 5, active: true},
  {id: 3, name: 'carol', score: 20, active: true},
]);
check('pushed change kinds reached the pipeline', log, [
  'remove', // bob
  'edit',   // alice
  'add',    // carol
]);
// started at 1 (bob). remove bob(-1)=0, alice edit(+1)=1, add carol(+1)=2.
check('live aggregate updated via pushes', activeCount, 2);

// 3. A second edit on an already-canonical row (now carries data-v) must still
//    be picked up when edited via text content.
[...tbody.children].find(tr => tr.children[0].textContent === '3').children[2].textContent = '99';
bridge.flush();
check('text edit on canonical cell flows through', fetchAll(), [
  {id: 1, name: 'alice', score: 5, active: true},
  {id: 3, name: 'carol', score: 99, active: true},
]);

console.log(failures === 0 ? '\n✅ DOM-driven sync works' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
