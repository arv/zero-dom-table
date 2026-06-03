// Combining sources: join the DOM-backed `node` source with a separate in-memory
// `label` source via `node.related('labels')`. Proves a single Zero query spans
// two different sources, and stays live as EITHER source changes.

import {Window} from 'happy-dom';
import {createBuilder} from '@rocicorp/zero';
import {DOMTreeSource} from '../src/dom-tree-source.js';
import {labeledSchema, createLabelSource} from '../src/labels.js';
import {expandChildNodes, domDepth} from '../src/tree-query.js';
import {buildPipeline, ArrayView, MemoryStorage} from '../src/zero-internals.js';

const window = new Window();
const document = window.document;
const S = v => JSON.stringify(v);

let failures = 0;
const check = (label, actual, expected) => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};

// --- build the two sources ------------------------------------------------
const root = document.createElement('div');
const ul = document.createElement('ul');
const mk = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };
ul.append(mk('li', 'Apple'), mk('li', 'Banana'), mk('li', 'Carrot'));
root.append(ul);

const nodeSource = new DOMTreeSource(root, {schema: labeledSchema});
const labelSource = createLabelSource();

const delegate = {
  getSource: name => (name === 'node' ? nodeSource : name === 'label' ? labelSource : undefined),
  createStorage: () => new MemoryStorage(),
  decorateInput: i => i, decorateFilterInput: i => i, decorateSourceInput: i => i, addEdge: () => {},
};

// node.related('childNodes', …).related('labels', …) — sized to the tree depth.
const builder = createBuilder(labeledSchema);
const query = expandChildNodes(
  builder.node.where('parentId', 'IS', null).orderBy('order', 'asc'),
  domDepth(root),
  q => q.related('labels', l => l.orderBy('id', 'asc')),
);

const input = buildPipeline(query.ast, delegate, 'joined');
const view = new ArrayView(input, query.format, true, () => {});
view.flush();

// id of the <li> whose #text is `text`
const liId = text => {
  const rows = nodeSource.currentDOMRows();
  const t = rows.find(r => r.nodeValue === text);
  return t?.parentId;
};
// gather [text, [labelText...]] for every #text node's PARENT <li> in the view
const labelsByText = () => {
  const out = {};
  const walk = ns => ns.forEach(n => {
    if (n.nodeType === 1) {
      const txt = (n.childNodes ?? []).find(c => c.nodeType === 3)?.nodeValue;
      if (txt) out[txt] = (n.labels ?? []).map(l => l.text);
    }
    walk(n.childNodes ?? []);
  });
  walk(view.data);
  return out;
};

let nextLabel = 0;
const addLabel = (nodeId, text, color = '#fff') => {
  const row = {id: 'l' + ++nextLabel, nodeId, text, color};
  for (const _ of labelSource.push([0, row, null])) { /* drain */ }
  view.flush();
  return row;
};

// 1. No labels yet.
check('no labels initially', labelsByText(), {Apple: [], Banana: [], Carrot: []});

// 2. Add labels into the SEPARATE source -> they appear on the joined nodes.
addLabel(liId('Apple'), 'fav');
const bananaBug = addLabel(liId('Banana'), 'bug');
addLabel(liId('Banana'), 'todo');
check('labels from the other source join onto the right nodes', labelsByText(), {
  Apple: ['fav'], Banana: ['bug', 'todo'], Carrot: [],
});

// 3. Remove a label from the label source -> it leaves the joined view.
for (const _ of labelSource.push([1, bananaBug, null])) { /* drain */ }
view.flush();
check('removing a label updates the join', labelsByText(), {
  Apple: ['fav'], Banana: ['todo'], Carrot: [],
});

// 4. Editing the DOM (node source) keeps labels attached by id: rename Carrot,
//    add a label, then append a new <li> — labels track node identity.
addLabel(liId('Carrot'), 'veg');
[...root.querySelectorAll('li')].find(li => li.textContent.trim() === 'Carrot').childNodes[0].textContent = 'Carrots';
nodeSource.syncFromDOM();
view.flush();
check('label stays attached across a DOM text edit', labelsByText(), {
  Apple: ['fav'], Banana: ['todo'], Carrots: ['veg'],
});

console.log(failures === 0 ? '\n✅ Cross-source join (DOM `node` × in-memory `label`) works' : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
