// ---------------------------------------------------------------------------
// DOMTreeSource — a Zero Source whose rows ARE the nodes of a live DOM tree.
//
// Every node in a DOM subtree (Element AND Text, Comment, …) is one row carrying
// the DOM core props: nodeType, nodeName, nodeValue. The DOM's own parent/child
// structure becomes relationships:
//   • childNodes — many()  (node.id == child.parentId), ordered by `order`
//   • parentNode — one()   (node.parentId == parent.id)
// so `node.related('childNodes', q => q.related('childNodes', …))` returns the DOM
// subtree as a nested, incrementally-maintained view, and `.related('parentNode')`
// walks back up. A DOM `Node` has `childNodes` that are `Node`s; a Zero IVM `Node`
// has `relationships` you drill into — the same shape, now wired together.
//
// Identity and order are SEPARATE (both held in WeakMaps keyed by the DOM node,
// since Text nodes can't hold a data-* attribute):
//   • `id`    — a stable, unique id assigned once; never changes.
//   • `order` — a fractional-index key positioning the node among its siblings.
// `childNodes` is `.orderBy('order')`. A mid-tree insert mints ONE order key
// between neighbors (no sibling re-indexing), and a MOVE is a plain edit
// (same id, new parentId/order) — identity is preserved and descendants don't
// churn, since their id/parentId/order are unchanged.
//
// Why a projection instead of literally reading the DOM in fetch(): Zero's IVM
// overlay contract requires committed storage to still reflect the *old* state
// during a push. Honoring that with a nested DOM while supporting non-destructive
// live editing would mean rebuilding the subtree on every keystroke. So the DOM is
// the authoritative *structure* and an internal MemorySource holds the committed
// adjacency projection; syncFromDOM() diffs the DOM against it and pushes deltas.
// ---------------------------------------------------------------------------

import {createSchema, table, number, string, relationships} from '@rocicorp/zero';
import {generateKeyBetween} from 'fractional-indexing';
import {
  MemorySource,
  makeSourceChangeAdd,
  makeSourceChangeRemove,
  makeSourceChangeEdit,
} from './zero-internals.ts';
import type {Source, SourceChange, SchemaValue, PrimaryKey} from './zero-internals.ts';
import {ADD} from './change-type.ts';

export const nodeTable = table('node')
  .columns({
    id: string(), // stable unique identity; never changes (survives moves)
    parentId: string().optional(),
    // fractional-index key for sibling order; `childNodes` is .orderBy('order').
    order: string(),
    nodeType: number(), // 1 = Element, 3 = Text, 8 = Comment, …
    nodeName: string(), // "DIV", "#text", "#comment", …
    nodeValue: string().optional(), // text/comment data; null for elements
  })
  .primaryKey('id');

const nodeRelationships = relationships(nodeTable, ({many, one}) => ({
  childNodes: many({sourceField: ['id'], destField: ['parentId'], destSchema: nodeTable}),
  parentNode: one({sourceField: ['parentId'], destField: ['id'], destSchema: nodeTable}),
}));

export const nodeSchema = createSchema({
  tables: [nodeTable],
  relationships: [nodeRelationships],
});

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;

/** One row per DOM node — assignable to Zero's `Row`. */
export interface NodeRow {
  id: string;
  parentId: string | null;
  order: string;
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
}

/** Just the part of a Zero schema DOMTreeSource needs to build its MemorySource. */
interface NodeSchemaLike {
  tables: {node: {columns: Record<string, SchemaValue>; primaryKey: PrimaryKey}};
}

export interface DOMTreeSourceOptions {
  schema?: NodeSchemaLike;
  skipWhitespace?: boolean;
}

export interface ObserveHandle {
  flush(): void;
  disconnect(): void;
}

const isWhitespaceText = (node: Node): boolean =>
  node.nodeType === TEXT_NODE && (node.nodeValue ?? '').trim() === '';

export class DOMTreeSource implements Source {
  readonly #root: Node;
  readonly #inner: MemorySource; // committed adjacency projection
  readonly #committed = new Map<string, NodeRow>();
  readonly #id = new WeakMap<Node, string>(); // DOM Node -> stable unique id
  readonly #order = new WeakMap<Node, string>(); // DOM Node -> fractional-index order
  #nextId = 0;
  readonly #skipWhitespace: boolean;

  /**
   * @param root container whose descendant nodes become rows. `root` itself is
   *   not a row; its direct children have `parentId: null`.
   */
  constructor(root: Node, opts: DOMTreeSourceOptions = {}) {
    const {schema = nodeSchema, skipWhitespace = true} = opts;
    this.#root = root;
    this.#skipWhitespace = skipWhitespace;
    const t = (schema as NodeSchemaLike).tables.node;
    this.#inner = new MemorySource('node', t.columns, t.primaryKey);
    this.syncFromDOM(); // initial load
  }

  get root(): Node {
    return this.#root;
  }

  // --- Source interface: delegate the verified IVM machinery to MemorySource ---
  get tableSchema(): MemorySource['tableSchema'] {
    return this.#inner.tableSchema;
  }
  connect(...args: Parameters<MemorySource['connect']>): ReturnType<MemorySource['connect']> {
    return this.#inner.connect(...args);
  }
  push(change: SourceChange): ReturnType<MemorySource['push']> {
    return this.#inner.push(change);
  }
  genPush(change: SourceChange): ReturnType<MemorySource['genPush']> {
    return this.#inner.genPush(change);
  }

  // --- DOM projection ------------------------------------------------------

  #skip(node: Node): boolean {
    return this.#skipWhitespace && isWhitespaceText(node);
  }

  #idFor(node: Node): string {
    let id = this.#id.get(node);
    if (id === undefined) {
      id = 'n' + ++this.#nextId;
      this.#id.set(node, id);
    }
    return id;
  }

  /**
   * Walk the live DOM subtree (pre-order) into adjacency rows. Each node gets a
   * stable `id` (assigned once, survives moves) and an `order` fractional-index
   * key positioning it among its siblings. A node whose stored order now sorts
   * out of place (it moved here) is re-keyed — but only its `order`, never its id.
   */
  #project(): NodeRow[] {
    const rows: NodeRow[] = [];
    const walk = (parent: Node, parentId: string | null): void => {
      const kids = [...parent.childNodes].filter(child => !this.#skip(child));
      let prevOrder: string | null = null;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]!;
        let order = this.#order.get(child);
        if (order === undefined || (prevOrder !== null && order <= prevOrder)) {
          let nextOrder: string | null = null; // nearest existing order > prevOrder
          for (let j = i + 1; j < kids.length; j++) {
            const o = this.#order.get(kids[j]!);
            if (o !== undefined && (prevOrder === null || o > prevOrder)) { nextOrder = o; break; }
          }
          order = generateKeyBetween(prevOrder, nextOrder);
          this.#order.set(child, order);
        }
        prevOrder = order;
        const id = this.#idFor(child);
        rows.push({
          id,
          parentId,
          order,
          nodeType: child.nodeType,
          nodeName: child.nodeName,
          nodeValue: child.nodeValue ?? null,
        });
        walk(child, id);
      }
    };
    walk(this.#root, null);
    return rows;
  }

  /** Current rows projected from the live DOM (also assigns ids). */
  currentDOMRows(): NodeRow[] {
    return this.#project();
  }

  /**
   * Diff the live DOM against the committed projection and push the deltas into
   * the pipeline. Returns the number of changes applied.
   */
  syncFromDOM(): number {
    const cur = this.#project();
    const curById = new Map<string, NodeRow>(cur.map(r => [r.id, r]));
    const S = JSON.stringify;

    interface Delta {change: SourceChange; remove?: string; set?: NodeRow}
    const deltas: Delta[] = [];
    for (const [id, old] of this.#committed) {
      const now = curById.get(id);
      if (now === undefined) deltas.push({change: makeSourceChangeRemove(old), remove: id});
      else if (S(old) !== S(now)) deltas.push({change: makeSourceChangeEdit(now, old), set: now});
    }
    for (const [id, now] of curById) {
      if (!this.#committed.has(id)) deltas.push({change: makeSourceChangeAdd(now), set: now});
    }
    // Apply removes/edits before adds (joins are order-independent; tidy overlays).
    deltas.sort((a, b) => (a.change[0] === ADD ? 1 : 0) - (b.change[0] === ADD ? 1 : 0));

    for (const d of deltas) {
      for (const _ of this.#inner.push(d.change)) { /* drain */ }
      if (d.remove !== undefined) this.#committed.delete(d.remove);
      if (d.set !== undefined) this.#committed.set(d.set.id, d.set);
    }
    return deltas.length;
  }

  /** Watch the DOM and sync structural/text changes into the pipeline. */
  observe(opts: {ObserverImpl?: typeof MutationObserver} = {}): ObserveHandle {
    const MO =
      opts.ObserverImpl ??
      (this.#root.ownerDocument?.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ??
      globalThis.MutationObserver;
    if (!MO) throw new Error('No MutationObserver available');
    const observeOpts: MutationObserverInit = {childList: true, subtree: true, characterData: true};
    const run = (): void => {
      observer.disconnect();
      try {
        this.syncFromDOM();
      } finally {
        observer.observe(this.#root, observeOpts);
      }
    };
    const observer = new MO(run);
    observer.observe(this.#root, observeOpts);
    return {flush: run, disconnect: () => observer.disconnect()};
  }
}
