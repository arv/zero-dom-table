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
// live editing would mean rebuilding the subtree on every keystroke (trashing
// cursor/selection/listeners). So the DOM is the authoritative *structure* and an
// internal MemorySource holds the committed adjacency projection; syncFromDOM()
// diffs the DOM against it and pushes the deltas. Non-destructive and correct.
// ---------------------------------------------------------------------------

import {createSchema, table, number, string, relationships} from '@rocicorp/zero';
import {generateKeyBetween} from 'fractional-indexing';
import {MemorySource} from './zero-internals.js';

export const nodeTable = table('node')
  .columns({
    id: string(), // stable unique identity; never changes (survives moves)
    parentId: string().optional(),
    // fractional-index key for sibling order; `childNodes` is .orderBy('order').
    // A mid-tree insert mints ONE key between neighbors; a move re-keys only the
    // moved node's order (its id is untouched).
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

const isWhitespaceText = node =>
  node.nodeType === TEXT_NODE && (node.nodeValue ?? '').trim() === '';

export class DOMTreeSource {
  #root;
  #inner; // MemorySource holding the committed adjacency projection
  #committed = new Map(); // id -> row
  #id = new WeakMap(); // DOM Node -> stable unique id
  #order = new WeakMap(); // DOM Node -> fractional-index order key
  #nextId = 0;
  #skipWhitespace;

  /**
   * @param {Node} root container whose descendant nodes become rows. `root`
   *   itself is not a row; its direct children have `parentId: null`.
   * @param {{schema?: object, skipWhitespace?: boolean}} [opts]
   */
  constructor(root, {schema = nodeSchema, skipWhitespace = true} = {}) {
    this.#root = root;
    this.#skipWhitespace = skipWhitespace;
    const t = schema.tables.node;
    this.#inner = new MemorySource('node', t.columns, t.primaryKey);
    this.syncFromDOM(); // initial load
  }

  get root() {
    return this.#root;
  }

  // --- Source interface: delegate the verified IVM machinery to MemorySource ---
  get tableSchema() {
    return this.#inner.tableSchema;
  }
  connect(sort, filters, splitEditKeys) {
    return this.#inner.connect(sort, filters, splitEditKeys);
  }
  push(change) {
    return this.#inner.push(change);
  }
  genPush(change) {
    return this.#inner.genPush(change);
  }

  // --- DOM projection ------------------------------------------------------

  #skip(node) {
    return this.#skipWhitespace && isWhitespaceText(node);
  }

  #idFor(node) {
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
   * key positioning it among its siblings. Within each sibling group, an unkeyed
   * (new) node gets an order between its neighbors; a node whose stored order now
   * sorts out of place (it moved here) is re-keyed — but only its `order`, never
   * its `id`.
   */
  #project() {
    const rows = [];
    const walk = (parent, parentId) => {
      const kids = [...parent.childNodes].filter(child => !this.#skip(child));
      let prevOrder = null;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        let order = this.#order.get(child);
        if (order === undefined || (prevOrder !== null && order <= prevOrder)) {
          let nextOrder = null; // nearest existing order strictly greater than prevOrder
          for (let j = i + 1; j < kids.length; j++) {
            const o = this.#order.get(kids[j]);
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
  currentDOMRows() {
    return this.#project();
  }

  /**
   * Diff the live DOM against the committed projection and push the deltas into
   * the pipeline. Returns the number of changes applied.
   */
  syncFromDOM() {
    const cur = this.#project();
    const curById = new Map(cur.map(r => [r.id, r]));
    const S = JSON.stringify;

    const changes = [];
    for (const [id, old] of this.#committed) {
      const now = curById.get(id);
      if (now === undefined) changes.push([1, old, null]); // remove
      else if (S(old) !== S(now)) changes.push([2, now, old]); // edit
    }
    for (const [id, now] of curById) {
      if (!this.#committed.has(id)) changes.push([0, now, null]); // add
    }
    // Apply removes/edits before adds (joins are order-independent; tidy overlays).
    changes.sort((a, b) => (a[0] === 0 ? 1 : 0) - (b[0] === 0 ? 1 : 0));

    for (const change of changes) {
      for (const _ of this.#inner.push(change)) { /* drain */ }
      if (change[0] === 1) this.#committed.delete(change[1].id);
      else this.#committed.set(change[1].id, change[1]);
    }
    return changes.length;
  }

  /**
   * Watch the DOM and sync structural/text changes into the pipeline.
   * Returns {flush, disconnect}.
   */
  observe({ObserverImpl} = {}) {
    const MO =
      ObserverImpl ??
      this.#root.ownerDocument?.defaultView?.MutationObserver ??
      globalThis.MutationObserver;
    if (!MO) throw new Error('No MutationObserver available');
    const opts = {childList: true, subtree: true, characterData: true};
    const run = () => {
      observer.disconnect();
      try {
        this.syncFromDOM();
      } finally {
        observer.observe(this.#root, opts);
      }
    };
    const observer = new MO(run);
    observer.observe(this.#root, opts);
    return {flush: run, disconnect: () => observer.disconnect()};
  }
}
