// ---------------------------------------------------------------------------
// collectionSource — turn any reactive snapshot of `Row[]` into a Zero Source.
//
// This is the generalization of DOMTreeSource.syncFromDOM(): you give it
//   • getRows()  — the current authoritative rows (a snapshot)
//   • subscribe(onChange) — call onChange whenever getRows() would differ
// and it keeps an internal committed projection (a MemorySource), diffing the
// snapshot against it by primary key and pushing add/remove/edit deltas. So an
// async/observable collection (TanStack Query, a signal, an RxJS stream, a
// WebSocket feed, a plain array you setState) becomes a first-class Source you
// can run ZQL over and JOIN against other sources — Zero as a reactive query/IVM
// layer on top of data you fetched yourself.
//
// It's read/derive only: Zero doesn't write back through the collection. Writes
// go through the collection's own API (e.g. a TanStack mutation), then flow back
// in via getRows(). All the IVM-correct machinery stays inside MemorySource.
// ---------------------------------------------------------------------------

import {MemorySource} from './zero-internals.js';

/**
 * @param {{name: string, columns: object, primaryKey: readonly string[]}} table
 * @param {{
 *   getRows: () => readonly object[] | undefined,
 *   subscribe?: (onChange: () => void) => (() => void),
 *   key?: (row: object) => string,
 * }} opts
 */
export function collectionSource(table, {getRows, subscribe, key}) {
  const inner = new MemorySource(table.name, table.columns, table.primaryKey);
  const pk = table.primaryKey;
  const keyOf = key ?? (row => pk.map(k => JSON.stringify(row[k])).join('\x00'));
  const committed = new Map(); // keyStr -> row
  const listeners = new Set();
  const S = JSON.stringify;

  const sync = () => {
    const cur = getRows() ?? [];
    const curByKey = new Map();
    for (const row of cur) curByKey.set(keyOf(row), row);

    const changes = [];
    for (const [k, old] of committed) {
      const now = curByKey.get(k);
      if (now === undefined) changes.push([1, old, null]); // remove
      else if (S(old) !== S(now)) changes.push([2, now, old]); // edit
    }
    for (const [k, now] of curByKey) {
      if (!committed.has(k)) changes.push([0, now, null]); // add
    }
    // removes/edits before adds (joins are order-independent; tidy overlays)
    changes.sort((a, b) => (a[0] === 0 ? 1 : 0) - (b[0] === 0 ? 1 : 0));

    for (const change of changes) {
      for (const _ of inner.push(change)) { /* drain */ }
      if (change[0] === 1) committed.delete(keyOf(change[1]));
      else committed.set(keyOf(change[1]), change[1]);
    }
    if (changes.length) for (const l of listeners) l(changes.length);
    return changes.length;
  };

  const unsubscribe = subscribe ? subscribe(sync) : () => {};
  sync(); // capture whatever is available now

  return {
    // --- Source interface (delegates the verified IVM machinery) ---
    get tableSchema() { return inner.tableSchema; },
    connect: (sort, filters, splitEditKeys) => inner.connect(sort, filters, splitEditKeys),
    push: c => inner.push(c),
    genPush: c => inner.genPush(c),

    // --- lifecycle ---
    sync, // force a reconcile (tests; or after an out-of-band change)
    onSync(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    destroy() { unsubscribe(); listeners.clear(); },
  };
}
