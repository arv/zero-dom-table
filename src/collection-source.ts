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
// By default it's read/derive only: Zero doesn't write back through the
// collection. Pass `writeChange` to make it BIDIRECTIONAL — a pushed change is
// propagated back out to the collection (insert a <tr>, fire a mutation, …).
// `getRows`/`subscribe` is the inbound edge (collection → Zero); `writeChange`
// is the outbound edge (Zero push → collection). All the IVM-correct machinery
// stays inside MemorySource.
// ---------------------------------------------------------------------------

import {
  MemorySource,
  makeSourceChangeAdd,
  makeSourceChangeRemove,
  makeSourceChangeEdit,
} from './zero-internals.ts';
import type {Source, SourceChange, Row, SchemaValue, PrimaryKey} from './zero-internals.ts';
import {ADD, REMOVE, EDIT} from './change-type.ts';

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
  /**
   * Make the source bidirectional: propagate a pushed change back out to the
   * underlying collection (e.g. insert/remove a `<tr>`, or fire a mutation that
   * updates a query cache). Omit it and the source is read/derive only.
   *
   * The resulting collection write typically fires `subscribe`'s observer, but
   * `push` advances the committed baseline first, so the echoed `sync` is a
   * no-op (no double-apply).
   */
  writeChange?: (change: SourceChange) => void;
}

export function collectionSource(table: SourceTable, opts: CollectionOptions): CollectionSource {
  const {getRows, subscribe, key, writeChange} = opts;
  const inner = new MemorySource(table.name, table.columns, table.primaryKey);
  const pk = table.primaryKey;
  const keyOf = key ?? ((row: Row) => pk.map((k: string) => JSON.stringify(row[k])).join('\x00'));
  const committed = new Map<string, Row>(); // the diff baseline = what inner holds
  const listeners = new Set<(n: number) => void>();
  const S = JSON.stringify;

  // Advance the committed baseline to reflect a change that was applied to inner.
  const applyToCommitted = (change: SourceChange): void => {
    switch (change[0]) {
      case REMOVE: committed.delete(keyOf(change[1])); break;
      case ADD: committed.set(keyOf(change[1]), change[1]); break;
      case EDIT: {
        const oldKey = keyOf(change[2]);
        const newKey = keyOf(change[1]);
        if (oldKey !== newKey) committed.delete(oldKey);
        committed.set(newKey, change[1]);
        break;
      }
    }
  };

  // Inbound edge: collection -> Zero. Diff the snapshot against the committed
  // baseline and push the deltas into inner. Never writes back to the collection.
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
      applyToCommitted(change);
    }
    if (changes.length) for (const l of listeners) l(changes.length);
    return changes.length;
  };

  // Outbound edge: Zero push -> inner (+ committed) (+ collection via writeChange).
  // Order matters: advance `committed` BEFORE writeChange, so the observer's
  // echoed sync sees no diff (whether it fires sync- or asynchronously).
  function* push(change: SourceChange): Generator<'yield'> {
    yield* inner.push(change);
    applyToCommitted(change);
    writeChange?.(change);
  }
  function* genPush(change: SourceChange): Generator<'yield' | undefined> {
    yield* inner.genPush(change);
    applyToCommitted(change);
    writeChange?.(change);
  }

  const unsubscribe = subscribe ? subscribe(sync) : () => {};
  sync(); // capture whatever is available now

  return {
    // --- Source interface ---
    get tableSchema() { return inner.tableSchema; },
    connect: inner.connect.bind(inner),
    push,
    genPush,

    // --- lifecycle ---
    sync,
    onSync(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    destroy() { unsubscribe(); listeners.clear(); },
  };
}
