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

import {
  MemorySource,
  makeSourceChangeAdd,
  makeSourceChangeRemove,
  makeSourceChangeEdit,
} from './zero-internals.ts';
import type {Source, SourceChange, Row, SchemaValue, PrimaryKey} from './zero-internals.ts';
import {ADD, REMOVE} from './change-type.ts';

export interface SourceTable {
  readonly name: string;
  readonly columns: Record<string, SchemaValue>;
  readonly primaryKey: PrimaryKey;
}

export interface CollectionSource extends Source {
  /** Force a reconcile (tests; or after an out-of-band change). */
  sync(): number;
  onSync(cb: (changeCount: number) => void): () => void;
  destroy(): void;
}

export interface CollectionOptions {
  getRows: () => readonly Row[] | undefined;
  subscribe?: (onChange: () => void) => () => void;
  key?: (row: Row) => string;
}

export function collectionSource(table: SourceTable, opts: CollectionOptions): CollectionSource {
  const {getRows, subscribe, key} = opts;
  const inner = new MemorySource(table.name, table.columns, table.primaryKey);
  const pk = table.primaryKey;
  const keyOf = key ?? ((row: Row) => pk.map((k: string) => JSON.stringify(row[k])).join('\x00'));
  const committed = new Map<string, Row>();
  const listeners = new Set<(n: number) => void>();
  const S = JSON.stringify;

  const sync = (): number => {
    const cur = getRows() ?? [];
    const curByKey = new Map<string, Row>();
    for (const row of cur) curByKey.set(keyOf(row), row);

    const changes: SourceChange[] = [];
    for (const [k, old] of committed) {
      const now = curByKey.get(k);
      if (now === undefined) changes.push(makeSourceChangeRemove(old)); // remove
      else if (S(old) !== S(now)) changes.push(makeSourceChangeEdit(now, old)); // edit
    }
    for (const [k, now] of curByKey) {
      if (!committed.has(k)) changes.push(makeSourceChangeAdd(now)); // add
    }
    // removes/edits before adds (joins are order-independent; tidy overlays)
    changes.sort((a, b) => (a[0] === ADD ? 1 : 0) - (b[0] === ADD ? 1 : 0));

    for (const change of changes) {
      for (const _ of inner.push(change)) { /* drain */ }
      if (change[0] === REMOVE) committed.delete(keyOf(change[1]));
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
    connect: inner.connect.bind(inner),
    push: inner.push.bind(inner),
    genPush: inner.genPush.bind(inner),

    // --- lifecycle ---
    sync,
    onSync(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    destroy() { unsubscribe(); listeners.clear(); },
  };
}
