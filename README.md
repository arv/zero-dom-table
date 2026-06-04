# zero-dom-table

An experiment: [Zero](https://zero.rocicorp.dev/) IVM **`Source`s backed by the DOM**.
Two flavors:

1. **Flat table** ([src/dom-source.ts](src/dom-source.ts)) — rows are `<tr>` elements
   in a `<tbody>`. Zero queries run against the DOM as if it were an in-memory table,
   and editing the DOM directly (contenteditable, `appendChild`, devtools, htmx, …)
   flows changes *into* the query pipeline.
2. **Tree** ([src/dom-tree-source.ts](src/dom-tree-source.ts)) — every node in a DOM
   subtree (Element **and** Text, Comment, …) is a row carrying the DOM core props
   (`nodeType`, `nodeName`, `nodeValue`), and the DOM's own structure becomes
   relationships: **`childNodes`** (`many()`) and **`parentNode`** (`one()`). A recursive
   `node.related('childNodes', q => q.related('childNodes', …))` query returns the DOM
   subtree as a nested, incrementally-maintained view; `.related('parentNode')` walks
   back up. A DOM `Node` has `childNodes` that are `Node`s; a Zero IVM `Node` has
   `relationships` you drill into — same shape, now wired together.

There's a **[Vite + Solid demo](demo/)**: `pnpm dev`, then edit a live
`contenteditable` DOM tree and watch the recursive Zero query update beside it — joined,
in one query, against **two more sources**: an in-memory `label` source (click a node to tag
it) and an **async/remote `tag` source fetched via [TanStack Query](https://tanstack.com/query)**.

```
   source.push(change)  ───▶  DOM mutates (<tr> insert/remove)  ───▶  query results
        ▲                                                                  │
        └────────────  observeDOM: user edits the DOM  ◀───────────────────┘
```

## Status: works, proven by tests

Written in **TypeScript**, type-checked with **TypeScript 7** — the native (Go) compiler,
[`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview)'s
`tsgo`. Tests run directly under Node 24's type-stripping (no build step), and the demo is
bundled by Vite:

```
pnpm install
pnpm test          # node runs the .ts tests directly (type-stripping)
pnpm typecheck     # tsgo --noEmit
pnpm build         # Vite builds the demo
```

The Zero internals are imported by relative path (`src/zero-internals.ts`); their adjacent
`.d.ts` files give real types, so the whole project type-checks with `strict` +
`verbatimModuleSyntax` (`skipLibCheck` avoids `.ts`-extension imports inside Zero's own
declarations). `ChangeType` is a const-enum with no runtime module, so we mirror its tags
in [src/change-type.ts](src/change-type.ts).

Eight suites, all green:

| Suite | What it proves |
| --- | --- |
| `test/differential.test.ts` | `DOMSource` is **observationally identical** to Zero's own `MemorySource` across 400 random add/edit/remove mutations × many sorts, constraints, `start`, `reverse`, composite PK, and split-edit. If you can't tell it apart from `MemorySource`, every operator that works on one works on the other. |
| `test/observe.test.ts` | Direct DOM edits (append a `<tr>`, edit a cell, delete a row) flow into a connected Zero query via the `MutationObserver` bridge. Starts from a *hand-authored* HTML table. |
| `test/pipeline.test.ts` | A **real** Zero pipeline (`buildPipeline` → Filter + sort operators → materialized `ArrayView`) running `item.where('score','>=',10).orderBy('score','desc')` on the DOM-backed source, updated by both `push()` and direct DOM edits. |
| `test/tree.test.ts` | A recursive **`childNodes`** (`many`) query over a real DOM tree materializes a nested view of Element + Text nodes that mirrors the DOM, matches a from-scratch `MemorySource` oracle, drills back up via **`parentNode`** (`one`), updates live on DOM append / in-place text edit / subtree removal, and **keeps node identity across a move** (id stable, only `parentId`/`order` change). |
| `test/join.test.ts` | **Combining sources**: a single query joins the DOM-backed `node` source with a separate in-memory `label` source via `node.related('labels')`. Labels appear on the right nodes, update as the label source changes, and stay attached across DOM edits (the join is by stable node `id`). |
| `test/tanstack.test.ts` | **TanStack Query as a source**: two independent TanStack queries (`users`, `teams`) joined via `user.related('team')`. The join is live as either query refetches (rename a team → every joined user updates; add/move a user → flows through), and plain `where`/`orderBy` works over a fetched collection. |
| `test/bidirectional.test.ts` | **Bidirectional `collectionSource`** (`writeChange` hook): a flat DOM table where `source.push(...)` inserts/edits/removes a `<tr>` *and* raw DOM edits flow into the query — round-trip, with the outbound write **not** echoing back (a `sync` right after a push is a no-op). |
| `test/host.test.ts` | **`createHost` / `registerSource`**: two async sources registered by name, joined via a relationship; `materialize` returns `[rows, meta]`, and `meta.type` flips **`unknown → complete`** when the fetches land (a collection's loading state surfaced as Zero's `{type}`). |

## How it works

`MemorySource`'s `connect` / `push` / `genPush` and all the overlay-splicing,
split-edit, and comparator machinery are **generic** — only the storage layer is
BTree-specific. So `DOMSource` ([src/dom-source.ts](src/dom-source.ts)) reuses
Zero's exact logic and swaps only:

- **`#fetch`** — reads rows out of the DOM and sorts them on demand (instead of
  reading a persistent BTree index). A faithful port of `MemorySource#fetch`.
- **`#writeChange`** — mutates the DOM instead of a BTree (`<tr>` insert / remove; a
  same-pk **edit updates the existing `<tr>` in place**, touching only changed cells, so
  the node, untouched cells, and any cursor survive — only a pk change does remove + add).
- **`#has`** — checks row presence by primary key in the DOM.

The DOM is the single source of truth; no secondary indexes are persisted.

### The tree: `childNodes` as a relationship

[`DOMTreeSource`](src/dom-tree-source.ts) treats a DOM subtree as a `node` table —
one row per node `{id, parentId, order, nodeType, nodeName, nodeValue}`, covering Element,
Text, Comment, … (so `<li>Apple</li>` is an `LI` element with a `#text` child).
`parentId` comes from the live DOM. Two self-relationships are declared with Zero's
real schema builders — `childNodes` (`many`, `node.id == child.parentId`) and
`parentNode` (`one`, `node.parentId == parent.id`) — so you query them with the
ordinary recursive `.related(…)` API and materialize a live nested view. `syncFromDOM()`
(or the `observe()` `MutationObserver`) diffs the DOM against the committed projection
and pushes the deltas.

**Identity and order are separate** (both in `WeakMap`s keyed by the DOM node, since
Text nodes can't carry a `data-*` id):

- **`id`** — a stable, unique id assigned once; it *never changes*.
- **`order`** — a [fractional-index](https://www.npmjs.com/package/fractional-indexing)
  key for sibling order; `childNodes` is `.orderBy('order')`.

So a mid-tree insert mints *one* `order` key between neighbors (no sibling re-indexing),
and a **move is a plain edit** — same `id`, new `parentId`/`order` — so identity survives
and descendants don't churn at all (their `id`/`parentId`/`order` are untouched).

#### No recursive queries — unroll to the tree's depth

Zero (ZQL) has **no recursive queries** (no recursive-CTE equivalent): `buildPipeline`
eagerly unrolls `ast.related` into `Join` operators, so a query materializes a *fixed*
shape. The `childNodes` relationship is self-referential in the **schema**, but to drill
the tree you must unroll `.related('childNodes', …)` to a finite depth — there is no way
around that at the query layer. Rather than a magic constant that silently truncates,
[src/tree-query.ts](src/tree-query.ts) measures the live tree (`domDepth`) and
`expandChildNodes` unrolls exactly that deep; the demo rebuilds the pipeline only when the
tree grows deeper (you can watch the `depth N` counter climb). The alternative idiom —
query the flat node list and rebuild the tree in the view layer from `parentId` — has no
depth limit at all, but moves the nesting out of the query.

Unlike the flat source — which stores rows *as* `<tr>` elements and reads them back in
`fetch` — the tree source keeps the DOM as the authoritative **structure** and
delegates the IVM storage to an internal `MemorySource`. The reason is the IVM overlay
contract: during a `push`, committed storage must still reflect the *old* state.
Honoring that with a nested DOM *and* non-destructive live editing would mean rebuilding
the subtree on every keystroke (trashing cursor/selection/listeners). So the DOM drives
*structure*; the projection provides *correct, non-destructive* incremental maintenance.

### Combining sources (join across a DOM source and another source)

A query can span sources of *different kinds*. [src/labels.ts](src/labels.ts) adds a
plain in-memory `label` source and a relationship `node.labels`
(`many`, `node.id == label.nodeId`), so a single query

```js
node.related('childNodes', c => …).related('labels', l => …)
```

joins DOM-backed `node` rows with `label` rows from a completely separate source. This
works because Zero's `BuilderDelegate.getSource(tableName)` routes each table to its own
source — the join operator doesn't care that one side is a DOM tree and the other is a
`MemorySource`. Because the join correlates on the stable node `id`, labels stay attached
to a node even as you edit its text or move it. In the demo, click any node to tag it and
click a chip to remove it; the tags live entirely in the other source.

### Async sources: TanStack Query (and any reactive `Row[]`)

The DOM and in-memory sources are synchronous. For *async/observable* collections there's a
second tier: [src/collection-source.ts](src/collection-source.ts) — `collectionSource(table,
{ getRows, subscribe })` — keeps an internal `MemorySource` and, whenever the snapshot
changes, diffs it by primary key and pushes the deltas (this is `DOMTreeSource.syncFromDOM`,
generalized). Any reactive `Row[]` becomes a Source: a signal, an RxJS stream, a WebSocket
feed, a plain `useState` array — or **TanStack Query**:

```js
// src/tanstack-source.ts — ~10 lines over collectionSource
const source = tanstackSource(table, queryClient, { queryKey, queryFn });
// internally: getRows = () => observer.getCurrentResult().data ?? [];
//             subscribe = onChange => observer.subscribe(onChange);
```

Now a TanStack query result is a live Zero Source — joinable against every other source and
incrementally maintained as it refetches. The demo's third source is exactly this: a `tag`
table fetched from a (fake) remote API, joined as `node.related('tag')` to put an emoji on
every node by `nodeName`. Hit **refetch** and the “server” returns a different emoji set;
every matching node updates through the join. So the demo joins **three kinds of source at
once** — live DOM (`node`), in-memory (`label`), and async/remote (`tag`).

#### Bidirectional: the `writeChange` hook

`getRows`/`subscribe` is the *inbound* edge (collection → Zero). Pass an optional
**`writeChange`** and the source becomes **bidirectional** — a pushed change is propagated
back *out* to the collection (insert a `<tr>`, fire a mutation, `setQueryData`, …). `push`
advances the committed baseline *before* `writeChange` fires, so the observer's echoed `sync`
finds nothing to do (no double-apply). [src/dom-table-source.ts](src/dom-table-source.ts)
uses this to recover `DOMSource`'s bidirectional behavior — `source.push(...)` inserts a
`<tr>` *and* editing the table flows into queries — on the simpler, indexed, non-destructive
`collectionSource` foundation (the DOM is a *mirror* of the committed store rather than the
store itself; see `test/bidirectional.test.ts`).

The mental model: this is **Zero the query/IVM engine**, not Zero the sync engine. Without
`writeChange` it's read/derive only (writes go through TanStack's mutations, then flow back
in via `getRows`); filtering is client-side/post-fetch (push selectivity into the `queryKey`),
and “loading”
lives in TanStack (`isFetching`), since IVM has no loading state — an unresolved query just
looks like an empty source. What you get is ZQL **joins, relationships, sorting, and derived
incremental views** over data you fetched yourself.

## Toward a real custom-source API (the seams)

Everything above reaches Zero's internals by relative-path import (see “The hack” below).
This sketches what Zero could expose so custom sources are first-class — three layered
seams, each with running code + tests behind it.

### 1. `createSource(table, store)` — the storage backend

`MemorySource`'s connect/push/genPush/overlay/split-edit/index machinery is **generic**;
only storage differs. [src/create-source.ts](src/create-source.ts) factors that out, so you
implement a tiny `RowStore` and Zero keeps the volatile IVM protocol sealed:

```ts
interface RowStore {
  has(row): boolean; insert(row): void; delete(row): void;
  update?(oldRow, newRow): void;   // optional in-place edit
  rows(): Iterable<Row>;           // Zero maintains the sorted indexes
}
createSource(table, store): Source
```

`DOMSource` is now literally `createSource(table, new DomRowStore(<tbody>))` — and the
differential test (`DOMSource ≡ MemorySource`) re-validates `createSource` through it. This is
the SQLite-vtable move: publish the *backend* (durable), keep the *planner* (volatile) inside.

### 2. `collectionSource(table, {getRows, subscribe, writeChange, status})` — observable collections

For async/observable stores (TanStack, signals, sockets), the observe-diff-push adapter
([src/collection-source.ts](src/collection-source.ts)). `writeChange` makes it bidirectional;
**`status`** reports the collection's load state.

### 3. `createHost(schema)` + `registerSource` — the client integration

A query that joins sources needs every table its AST touches to resolve via the delegate's
`getSource`. `registerSource(name, …)` is the write side of that map; `materialize(query)`
returns `[rows, meta]` like Zero's `useQuery`, with **`meta` aggregated across the query's
sources** — so a still-loading source makes the query `{type: 'unknown'}` (an unresolved
async source ≡ a not-yet-synced Zero query). See [src/host.ts](src/host.ts);
`wrapDelegate(original, registry)` there is the minimal primitive (front the delegate, fall
back) — the smallest thing Zero could expose to let custom sources work with the real
`useQuery` for the pure-custom case.

> In Zero proper, these would import the IVM directly (no hack), `ChangeType` would have a
> runtime export, and `registerSource` would also mark the table **client-local** (un-synced)
> and route mutators to `writeChange`. This repo is the reference behind that proposal.

### The hack

The IVM internals we reuse (`MemorySource`, `buildPipeline`, `ArrayView`,
`genPushAndWriteWithSplitEdit`, `generateWithOverlay`, the comparators, the filter
compiler) are **not** in `@rocicorp/zero`'s public `exports` map. But that map is only
consulted for *bare specifiers* — a **relative path** to a file inside `node_modules` is
resolved as a plain file and bypasses it. Crucially this works identically in Node
**and** Vite/the browser (Vite also only applies `exports` to bare specifiers), resolving
to the same physical files the public entry uses, so there's no module duplication. See
[src/zero-internals.ts](src/zero-internals.ts). Pinned to `@rocicorp/zero@1.5.0` —
brittle against version bumps; re-check the paths/signatures if you upgrade.

### Serialization

Each `<td>` carries a JSON-encoded typed value in `data-v` (so `number` / `boolean`
/ `null` / `json` survive round-trips) plus human-readable text. Hand-authored
cells without `data-v` are coerced via the schema, and a text edit that diverges
from `data-v` is honored — so `contenteditable` Just Works.

## Caveats / next steps

- **Perf**: `#fetch` re-reads and re-sorts the DOM each call (`O(n log n)`), and
  `#has`/`#findTr` are linear scans. Fine for a few thousand rows; for more you'd
  cache derived indexes and invalidate on `writeChange`. The point here was
  fidelity, not throughput.
- **Flat-source relationships** are always `{}` — `DOMSource` is a single-table
  source; joins compose *above* it. The **tree** source adds the `childNodes`
  self-relationship (see above).
- **Tree node ordering**: sibling order is a fractional-index `order` column
  (`.orderBy('order')`), separate from the stable `id`. A mid-tree insert touches only
  the new node; a move re-keys only the moved node's `order` (its `id` is untouched, so
  it's an edit, not a remove+add, and descendants don't churn).
- **Whitespace text nodes** are skipped by default (`skipWhitespace: true`) so seeded
  HTML doesn't fill the tree with `#text` indentation nodes; pass `false` for full
  fidelity.

## Demo

```
pnpm dev      # Vite + Solid, http://localhost:5173
pnpm build    # production bundle (proves the internals bundle for the browser)
```

Edit the `contenteditable` DOM tree on the left; the right pane is a live
`node.related('childNodes', …).related('labels', …).related('tag')` Zero query rendered with
Solid — **a join across three kinds of source** (live DOM, in-memory, async/remote),
updated incrementally via a `MutationObserver` → `syncFromDOM()`:

- **Click any node to tag it** — tags live in a separate in-memory `label` source. The panel
  below visualizes that source as its own table, with a `→ node` column driven by the
  **inverse** relationship `label.related('node')` (a `one()`) — resolved live from the DOM
  source (rename a node and watch the table update).
- The emoji on each node comes from a **TanStack Query** `tag` source (a fake remote API,
  joined by `nodeName`). Hit **refetch** and every matching node updates through the join.

See [demo/src/App.tsx](demo/src/App.tsx).

## License

[Apache-2.0](LICENSE) © Erik Arvidsson. Note this is an experiment that reaches into
`@rocicorp/zero`'s unpublished internals (see "The hack"); Zero itself is separately
licensed by Rocicorp.
