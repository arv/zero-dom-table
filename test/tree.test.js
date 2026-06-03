// The DOM tree IS the data: every node (Element + Text) is a row with real DOM
// props, drilled via recursive `childNodes` (many) and `parentNode` (one) Zero
// relationships. We materialize the nested view, assert it mirrors the live DOM,
// cross-check a MemorySource oracle, and confirm DOM edits flow through.

import {Window} from 'happy-dom';
import {createBuilder} from '@rocicorp/zero';
import {DOMTreeSource, nodeSchema, ELEMENT_NODE, TEXT_NODE} from '../src/dom-tree-source.js';
import {expandChildNodes, domDepth} from '../src/tree-query.js';
import {MemorySource, buildPipeline, ArrayView, MemoryStorage} from '../src/zero-internals.js';

const window = new Window();
const document = window.document;
const S = v => JSON.stringify(v);

let failures = 0;
const check = (label, actual, expected) => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};

// --- expected tree, read straight from the live DOM ----------------------
const isWs = n => n.nodeType === TEXT_NODE && (n.nodeValue ?? '').trim() === '';
const domTree = node => ({
  nodeName: node.nodeName,
  nodeType: node.nodeType,
  nodeValue: node.nodeValue ?? null,
  childNodes: [...node.childNodes].filter(n => !isWs(n)).map(domTree),
});
const viewTree = e => ({
  nodeName: e.nodeName,
  nodeType: e.nodeType,
  nodeValue: e.nodeValue ?? null,
  childNodes: (e.childNodes ?? []).map(viewTree),
});

const delegate = source => ({
  getSource: n => (n === 'node' ? source : undefined),
  createStorage: () => new MemoryStorage(),
  decorateInput: i => i, decorateFilterInput: i => i, decorateSourceInput: i => i, addEdge: () => {},
});

const builder = createBuilder(nodeSchema);
let rootQuery; // built once `root` exists, sized to the actual tree depth

const materialize = (source, query = rootQuery) => {
  const input = buildPipeline(query.ast, delegate(source), 'tree');
  const view = new ArrayView(input, query.format, true, () => {});
  view.flush();
  return view;
};

const oracleRoots = treeSource => {
  const t = nodeSchema.tables.node;
  const mem = new MemorySource('node', t.columns, t.primaryKey);
  for (const row of treeSource.currentDOMRows()) for (const _ of mem.push([0, row, null])) { /**/ }
  return materialize(mem).data.map(viewTree);
};

// --- build a DOM tree -----------------------------------------------------
const root = document.createElement('div');
const ul = document.createElement('ul');
const mk = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };
const fruit = mk('li', 'Fruit');
const fruitUl = mk('ul');
fruitUl.append(mk('li', 'Apple'), mk('li', 'Banana'));
fruit.append(fruitUl);
const veg = mk('li', 'Veg');
const vegUl = mk('ul');
vegUl.append(mk('li', 'Carrot'));
veg.append(vegUl);
ul.append(fruit, veg);
root.append(ul);

// Unroll childNodes exactly as deep as the tree actually is — no magic constant.
rootQuery = expandChildNodes(builder.node.where('parentId', 'IS', null).orderBy('order', 'asc'), domDepth(root));

const source = new DOMTreeSource(root);
const view = materialize(source);
const obs = source.observe();
const roots = () => view.data.map(viewTree);
const expected = () => [...root.childNodes].filter(n => !isWs(n)).map(domTree);

// 1. Nested Zero view mirrors the DOM (Element + Text nodes).
check('recursive childNodes view mirrors the DOM tree', roots(), expected());
check('matches a from-scratch MemorySource oracle', roots(), oracleRoots(source));

// 2. Text nodes are first-class: the "Apple" <li> has a #text child.
const findInView = (nodes, pred) => {
  for (const n of nodes) {
    if (pred(n)) return n;
    const f = findInView(n.childNodes ?? [], pred);
    if (f) return f;
  }
  return undefined;
};
const appleLi = findInView(view.data, n => n.nodeName === 'LI' && (n.childNodes ?? []).some(c => c.nodeValue === 'Apple'));
check('Element node has the right nodeName/nodeType', [appleLi.nodeName, appleLi.nodeType], ['LI', ELEMENT_NODE]);
const appleText = appleLi.childNodes[0];
check('its child is a #text node carrying nodeValue', [appleText.nodeName, appleText.nodeType, appleText.nodeValue], ['#text', TEXT_NODE, 'Apple']);

// 3. parentNode (one) drills back up.
const parentQuery = builder.node
  .where('nodeValue', '=', 'Apple')
  .related('parentNode', p => p.related('parentNode'));
const pv = materialize(source, parentQuery);
const appleRow = pv.data[0];                  // the #text "Apple"
check('parentNode of #text Apple is the <li>', appleRow.parentNode.nodeName, 'LI');
check('grandparent is the <ul>', appleRow.parentNode.parentNode.nodeName, 'UL');

// 4. Append a new <li> directly in the DOM.
fruitUl.append(mk('li', 'Cherry'));
obs.flush(); view.flush();
check('DOM-appended <li> appears in the nested view', roots(), expected());
check('append matches oracle', roots(), oracleRoots(source));

// 5. Edit text in place: Apple -> Green Apple.
[...root.querySelectorAll('li')].find(li => li.textContent.startsWith('Apple')).childNodes[0].textContent = 'Green Apple';
obs.flush(); view.flush();
check('in-place text edit flows through', roots(), expected());

// 6. Remove a whole subtree: delete the Veg <li>.
veg.remove();
obs.flush(); view.flush();
check('subtree removal flows through', roots(), expected());
check('removal matches oracle', roots(), oracleRoots(source));

// 7. Insert at the FRONT of a list (insertBefore). With fractional-index ids this
//    mints one key before the existing first child — monotonic counter ids would
//    sort it last and break order. The view (ordered by id) must match the DOM.
fruitUl.insertBefore(mk('li', 'Aardvark'), fruitUl.firstChild);
obs.flush(); view.flush();
check('mid-tree insertBefore keeps DOM order', roots(), expected());
const firstFruitChild = view.data[0].childNodes[0].childNodes.find(c => c.nodeName === 'UL').childNodes[0];
check('inserted node sorts first among siblings', firstFruitChild.childNodes[0].nodeValue, 'Aardvark');

// 8. `order` ascends within each sibling group (matches DOM order).
const rowsNow = source.currentDOMRows();
const byParent = new Map();
for (const r of rowsNow) {
  const k = r.parentId ?? '∅';
  (byParent.get(k) ?? byParent.set(k, []).get(k)).push(r.order);
}
const orderingOk = [...byParent.values()].every(os => S(os) === S([...os].sort()));
check('order ascends within every sibling group', orderingOk, true);

// 9. A MOVE preserves identity: id is stable, only parentId/order change, and
//    descendants don't churn at all.
const before = source.currentDOMRows();
const bananaText0 = before.find(r => r.nodeValue === 'Banana'); // #text
const bananaTextId = bananaText0.id;
const bananaLiId = bananaText0.parentId; // the enclosing <li>
const bananaLiOldParent = before.find(r => r.id === bananaLiId).parentId;
const bananaLi = [...root.querySelectorAll('li')].find(li => li.textContent.trim() === 'Banana');
root.querySelector('ul').appendChild(bananaLi); // reparent: inner list -> top-level <ul>
obs.flush(); view.flush();

const after = source.currentDOMRows();
const bananaLiRow = after.find(r => r.id === bananaLiId);
const bananaTextRow = after.find(r => r.nodeValue === 'Banana');
check('moved <li> keeps its id (identity preserved)', bananaLiRow?.id, bananaLiId);
check('moved <li> parentId changed (it was reparented)', bananaLiRow?.parentId !== bananaLiOldParent, true);
check('descendant #text id is unchanged', bananaTextRow?.id, bananaTextId);
check('descendant #text still points at the same <li>', bananaTextRow?.parentId, bananaLiId);
check('view still mirrors the DOM after a move', roots(), expected());

obs.disconnect();
console.log(failures === 0 ? '\n✅ DOM tree queryable via childNodes (many) + parentNode (one)' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
