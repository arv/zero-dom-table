import {createSignal, onMount, onCleanup, For, Show} from 'solid-js';
import {createBuilder} from '@rocicorp/zero';
import {DOMTreeSource, TEXT_NODE, COMMENT_NODE} from '../../src/dom-tree-source.js';
import {labeledSchema, createLabelSource} from '../../src/labels.js';
import {expandChildNodes, domDepth} from '../../src/tree-query.js';
import {buildPipeline, ArrayView, MemoryStorage} from '../../src/zero-internals.js';

// Route each table in a query to its own source: `node` -> the DOM-backed source,
// `label` -> the in-memory source. This is what lets a single query join them.
const makeDelegate = (nodeSource, labelSource) => ({
  getSource: n => (n === 'node' ? nodeSource : n === 'label' ? labelSource : undefined),
  createStorage: () => new MemoryStorage(),
  decorateInput: i => i,
  decorateFilterInput: i => i,
  decorateSourceInput: i => i,
  addEdge: () => {},
});

const materialize = (query, delegate, id) => {
  const view = new ArrayView(buildPipeline(query.ast, delegate, id), query.format, true, () => {});
  view.flush();
  return view;
};

// View #1 — the tree: node.related('childNodes', …).related('labels', …).
// Zero has no recursive queries, so `childNodes` is unrolled `depth` levels
// (expandChildNodes), sized to the live tree and rebuilt only when it grows.
function buildTreeView(nodeSource, labelSource, depth) {
  const builder = createBuilder(labeledSchema);
  const query = expandChildNodes(
    builder.node.where('parentId', 'IS', null).orderBy('order', 'asc'),
    depth,
    q => q.related('labels', l => l.orderBy('id', 'asc')),
  );
  return materialize(query, makeDelegate(nodeSource, labelSource), 'tree');
}

// View #2 — the label source itself, with the INVERSE relationship resolved:
// label.related('node') (a `one()`) joins each label back to the node it tags.
function buildLabelView(nodeSource, labelSource) {
  const builder = createBuilder(labeledSchema);
  const query = builder.label.orderBy('id', 'asc').related('node');
  return materialize(query, makeDelegate(nodeSource, labelSource), 'labels');
}

const clone = e => ({
  id: e.id,
  nodeType: e.nodeType,
  nodeName: e.nodeName,
  nodeValue: e.nodeValue ?? null,
  labels: (e.labels ?? []).map(l => ({id: l.id, nodeId: l.nodeId, text: l.text, color: l.color})),
  childNodes: (e.childNodes ?? []).map(clone),
});

const cloneLabel = l => ({
  id: l.id,
  nodeId: l.nodeId,
  text: l.text,
  color: l.color,
  node: l.node ? {nodeName: l.node.nodeName, nodeValue: l.node.nodeValue ?? null} : null,
});

const PALETTE = [
  {text: '★', color: '#f5b14c'},
  {text: 'fav', color: '#e06c75'},
  {text: 'TODO', color: '#7c9cff'},
  {text: 'review', color: '#c678dd'},
  {text: 'done', color: '#5fd0a4'},
];

const SEED = `<ul>
  <li>Fruit
    <ul><li>Apple</li><li>Banana</li></ul>
  </li>
  <li>Vegetables
    <ul><li>Carrot</li><li>Pea</li></ul>
  </li>
</ul>`;

function NodeView(props) {
  const n = () => props.node;
  const kind = () =>
    n().nodeType === TEXT_NODE ? 'text' : n().nodeType === COMMENT_NODE ? 'comment' : 'element';
  const hasValue = () => n().nodeValue != null && n().nodeValue !== '';
  return (
    <li class={`node ${kind()}`}>
      <span class="row" title="click to tag this node" onClick={() => props.api.addLabel(n())}>
        <span class="badge">{n().nodeName}</span>
        <span class="type">type {n().nodeType}</span>
        <Show when={hasValue()}>
          <span class="value">“{n().nodeValue}”</span>
        </Show>
        <For each={n().labels}>
          {l => (
            <span
              class="label"
              title="click to remove"
              style={{background: l.color + '22', 'border-color': l.color + '99', color: l.color}}
              onClick={e => { e.stopPropagation(); props.api.removeLabel(l); }}
            >
              {l.text}
            </span>
          )}
        </For>
      </span>
      <Show when={(n().childNodes ?? []).length > 0}>
        <ul class="children">
          <For each={n().childNodes}>{c => <NodeView node={c} api={props.api} />}</For>
        </ul>
      </Show>
    </li>
  );
}

export default function App() {
  const [tree, setTree] = createSignal([]);
  const [labels, setLabels] = createSignal([]);
  const [count, setCount] = createSignal(0);
  const [labelCount, setLabelCount] = createSignal(0);
  const [depth, setDepth] = createSignal(0);
  const [api, setApi] = createSignal({addLabel() {}, removeLabel() {}});
  let editorRef;

  onMount(() => {
    editorRef.innerHTML = SEED;

    const nodeSource = new DOMTreeSource(editorRef, {schema: labeledSchema});
    const labelSource = createLabelSource();

    // The label source's own view never changes shape, so it's built once.
    const labelView = buildLabelView(nodeSource, labelSource);

    // Self-sizing depth: Zero can't recurse, so we unroll childNodes exactly as
    // deep as the live tree and rebuild only when it grows deeper (rare).
    let view, builtDepth = 0;
    const ensureDepth = need => {
      if (view && need <= builtDepth) return false;
      builtDepth = Math.max(need, builtDepth, 2);
      view?.destroy?.();
      view = buildTreeView(nodeSource, labelSource, builtDepth);
      setDepth(builtDepth);
      return true;
    };
    ensureDepth(domDepth(editorRef));

    const refresh = () => {
      const data = (view.data ?? []).map(clone);
      setTree(data);
      let nodes = 0, count = 0;
      const walk = ns => ns.forEach(n => { nodes++; count += n.labels.length; walk(n.childNodes); });
      walk(data);
      setCount(nodes);
      setLabelCount(count);
      setLabels((labelView.data ?? []).map(cloneLabel));
    };

    const pushLabel = change => {
      for (const _ of labelSource.push(change)) { /* drain */ }
      view.flush();      // tree view shows labels as chips
      labelView.flush(); // label-source table
      refresh();
    };
    const added = new Map(); // id -> row, so we can remove cleanly
    let nextLabel = 0;
    setApi({
      addLabel(node) {
        const have = new Set((node.labels ?? []).map(l => l.text));
        const choice = PALETTE.find(p => !have.has(p.text));
        if (!choice) return; // node already has every palette label
        const row = {id: 'l' + ++nextLabel, nodeId: node.id, text: choice.text, color: choice.color};
        added.set(row.id, row);
        pushLabel([0, row, null]);
      },
      removeLabel(label) {
        const row = added.get(label.id) ?? label;
        added.delete(label.id);
        pushLabel([1, row, null]);
      },
    });

    refresh();

    const mo = new MutationObserver(() => {
      nodeSource.syncFromDOM();
      // If the tree got deeper, rebuild the pipeline (already re-materialized);
      // otherwise just commit the pushed changes to the existing view.
      if (!ensureDepth(domDepth(editorRef))) view.flush();
      labelView.flush(); // editing a node updates label.related('node')
      refresh();
    });
    mo.observe(editorRef, {childList: true, subtree: true, characterData: true});
    onCleanup(() => mo.disconnect());

    // expose reset that also clears labels
    App._reset = () => {
      for (const row of [...added.values()]) for (const _ of labelSource.push([1, row, null])) { /* drain */ }
      added.clear();
      editorRef.innerHTML = SEED;
    };
  });

  const addNode = () => {
    const ul = editorRef.querySelector('ul ul') ?? editorRef.querySelector('ul') ?? editorRef;
    const li = document.createElement('li');
    li.textContent = 'New ' + Math.floor(Math.random() * 1000);
    ul.appendChild(li);
  };

  return (
    <main class="app">
      <header>
        <h1>Zero × the DOM tree</h1>
        <p>
          Two sources, one query. The <b>node</b> table is backed by the editable DOM
          on the left; a separate in-memory <b>label</b> source holds tags. The view on
          the right is a live{' '}
          <code>node.related('childNodes', …).related('labels', …)</code> — a join across
          both sources, maintained incrementally.
        </p>
      </header>

      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <h2>Live DOM tree</h2>
            <div class="actions">
              <button onClick={addNode}>+ add &lt;li&gt;</button>
              <button onClick={() => App._reset?.()}>reset</button>
            </div>
          </div>
          <p class="hint">Type — it's <code>contenteditable</code>. Add items, edit text, delete lines.</p>
          <div class="editor" contenteditable ref={editorRef} spellcheck={false} />
        </section>

        <section class="pane">
          <div class="pane-head">
            <h2>Zero query result</h2>
            <span class="count">{count()} nodes · {labelCount()} labels · depth {depth()}</span>
          </div>
          <p class="hint">Click any node to tag it (cycles a palette) · click a chip to remove it.</p>
          <ul class="result">
            <For each={tree()} fallback={<li class="empty">(empty)</li>}>
              {n => <NodeView node={n} api={api()} />}
            </For>
          </ul>
        </section>
      </div>

      <section class="pane labels-pane">
        <div class="pane-head">
          <h2>label source <span class="sub">— the other table</span></h2>
          <span class="count">{labels().length} rows</span>
        </div>
        <p class="hint">
          Raw rows of the in-memory <code>label</code> source. The <b>node</b> column is the
          inverse relationship <code>label.related('node')</code> (a <code>one()</code>) —
          resolved live from the DOM source.
        </p>
        <table class="label-table">
          <thead>
            <tr><th>id</th><th>text</th><th>color</th><th>nodeId</th><th>→ node</th></tr>
          </thead>
          <tbody>
            <For each={labels()} fallback={<tr><td colspan="5" class="empty">no rows — click a node above to tag it</td></tr>}>
              {l => (
                <tr>
                  <td><code>{l.id}</code></td>
                  <td><span class="label" style={{background: l.color + '22', 'border-color': l.color + '99', color: l.color}}>{l.text}</span></td>
                  <td><code>{l.color}</code></td>
                  <td><code>{l.nodeId}</code></td>
                  <td>
                    <Show when={l.node} fallback={<span class="empty">—</span>}>
                      <span class="badge">{l.node.nodeName}</span>
                      <Show when={l.node.nodeValue}><span class="value"> “{l.node.nodeValue}”</span></Show>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>

      <footer>
        <span class="legend"><i class="sw element" /> Element</span>
        <span class="legend"><i class="sw text" /> #text</span>
        <span class="spacer" />
        <span><code>node</code> (DOM) ⋈ <code>label</code> (memory) · childNodes <code>many()</code> · labels <code>many()</code> · node <code>one()</code></span>
      </footer>
    </main>
  );
}
