import {createSignal, onMount, onCleanup, For, Show} from 'solid-js';
import {QueryClient} from '@tanstack/query-core';
import {createBuilder} from '@rocicorp/zero';
import {DOMTreeSource, TEXT_NODE, COMMENT_NODE} from '../../src/dom-tree-source.js';
import {createLabelSource} from '../../src/labels.js';
import {taggedSchema, tagTable} from '../../src/tags.js';
import {tanstackSource} from '../../src/tanstack-source.js';
import {expandChildNodes, domDepth} from '../../src/tree-query.js';
import {buildPipeline, ArrayView, MemoryStorage} from '../../src/zero-internals.js';

// Route each table in a query to its own source — three different kinds:
//   node  -> the live DOM (DOMTreeSource)
//   label -> in-memory, click-to-edit (MemorySource)
//   tag   -> async/remote, via TanStack Query (tanstackSource)
const makeDelegate = (nodeSource, labelSource, tagSource) => ({
  getSource: n => (n === 'node' ? nodeSource : n === 'label' ? labelSource : n === 'tag' ? tagSource : undefined),
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

// View #1 — the tree, joining all three sources:
//   node.related('childNodes', …).related('labels', …).related('tag')
// Zero has no recursive queries, so `childNodes` is unrolled `depth` levels
// (expandChildNodes), sized to the live tree and rebuilt only when it grows.
function buildTreeView(sources, depth) {
  const builder = createBuilder(taggedSchema);
  const query = expandChildNodes(
    builder.node.where('parentId', 'IS', null).orderBy('order', 'asc'),
    depth,
    q => q.related('labels', l => l.orderBy('id', 'asc')).related('tag'),
  );
  return materialize(query, makeDelegate(...sources), 'tree');
}

// View #2 — the label source itself, with the INVERSE relationship resolved:
// label.related('node') (a `one()`) joins each label back to the node it tags.
function buildLabelView(sources) {
  const builder = createBuilder(taggedSchema);
  const query = builder.label.orderBy('id', 'asc').related('node');
  return materialize(query, makeDelegate(...sources), 'labels');
}

const clone = e => ({
  id: e.id,
  nodeType: e.nodeType,
  nodeName: e.nodeName,
  nodeValue: e.nodeValue ?? null,
  emoji: e.tag?.emoji ?? null, // joined from the remote (TanStack) tag source
  labels: (e.labels ?? []).map(l => ({id: l.id, nodeId: l.nodeId, text: l.text, color: l.color})),
  childNodes: (e.childNodes ?? []).map(clone),
});

// A fake remote "tags" API: maps nodeName -> emoji. Each refetch returns the next
// set, simulating the server changing — every matching node updates live.
const EMOJI_SETS = [
  {UL: '📋', LI: '•', '#text': '🔤'},
  {UL: '📁', LI: '✅', '#text': '✍️'},
  {UL: '🗂️', LI: '⭐', '#text': '💬'},
];
let serverIndex = 0;
const fetchTags = () =>
  new Promise(resolve =>
    setTimeout(() => {
      const set = EMOJI_SETS[serverIndex % EMOJI_SETS.length];
      resolve(Object.entries(set).map(([nodeName, emoji]) => ({nodeName, emoji})));
    }, 450), // simulated network latency
  );

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
        <Show when={n().emoji}><span class="emoji" title="from the remote tag source (TanStack)">{n().emoji}</span></Show>
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
  const [tagFetching, setTagFetching] = createSignal(false);
  const [tagCount, setTagCount] = createSignal(0);
  const [api, setApi] = createSignal({addLabel() {}, removeLabel() {}});
  let editorRef;

  onMount(() => {
    editorRef.innerHTML = SEED;

    const nodeSource = new DOMTreeSource(editorRef, {schema: taggedSchema});
    const labelSource = createLabelSource();

    // The remote `tag` source: a TanStack query fetching emojis by nodeName from a
    // (fake) async API. Joined as node.related('tag').
    const queryClient = new QueryClient({
      defaultOptions: {queries: {staleTime: Infinity, retry: false}},
    });
    const tagSource = tanstackSource(taggedSchema.tables.tag, queryClient, {
      queryKey: ['tags'],
      queryFn: fetchTags,
    });
    const sources = [nodeSource, labelSource, tagSource];

    // The label source's own view never changes shape, so it's built once.
    const labelView = buildLabelView(sources);

    // Self-sizing depth: Zero can't recurse, so we unroll childNodes exactly as
    // deep as the live tree and rebuild only when it grows deeper (rare).
    let view, builtDepth = 0;
    const ensureDepth = need => {
      if (view && need <= builtDepth) return false;
      builtDepth = Math.max(need, builtDepth, 2);
      view?.destroy?.();
      view = buildTreeView(sources, builtDepth);
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

    // When the remote tag query resolves / refetches, its source pushes deltas;
    // commit them to the tree view and re-render (emojis appear/update).
    tagSource.onSync(() => { view.flush(); refresh(); });
    const updateTagStatus = () => {
      const r = tagSource.observer.getCurrentResult();
      setTagFetching(r.isFetching);
      setTagCount((r.data ?? []).length);
    };
    tagSource.observer.subscribe(updateTagStatus);
    updateTagStatus();
    // Refetch with the next emoji set — simulates the server changing.
    App._refetchTags = () => { serverIndex++; tagSource.observer.refetch(); };

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
    onCleanup(() => { mo.disconnect(); tagSource.destroy(); });

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
          Three sources, one query. <b>node</b> is the editable DOM on the left; <b>label</b>
          {' '}is an in-memory source (click a node to tag it); <b>tag</b> is an{' '}
          <b>async/remote</b> source fetched via <b>TanStack Query</b>. The view on the right
          is a live{' '}
          <code>node.related('childNodes', …).related('labels', …).related('tag')</code> — a
          join across all three, maintained incrementally.
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
          <div class="tag-bar">
            <span>🛰️ remote <code>tag</code> source (TanStack Query):</span>
            <span class="tag-status">{tagFetching() ? 'fetching…' : `${tagCount()} rows`}</span>
            <button onClick={() => App._refetchTags?.()} disabled={tagFetching()}>
              refetch (server changes the emojis)
            </button>
          </div>
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
        <span><code>node</code> (DOM) ⋈ <code>label</code> (memory) ⋈ <code>tag</code> (TanStack)</span>
      </footer>
    </main>
  );
}
