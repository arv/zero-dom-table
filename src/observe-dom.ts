// ---------------------------------------------------------------------------
// observeDOM — turn out-of-band DOM edits into Zero source pushes.
//
// When something *other than the source* mutates the table (a user editing a
// cell, JS appending a <tr>, devtools, contenteditable, htmx, ...), this bridge
// diffs the new DOM against the last committed snapshot and replays the diff
// through `source.push()` so it flows into every connected Zero query.
//
// To keep Zero's "storage updates only as part of push" contract intact, and to
// avoid an observe→push→mutate→observe feedback loop, each batch:
//   1. detaches the observer,
//   2. reverts the container to the snapshot (old state),
//   3. replays the diff via the fully-verified push() path (which re-mutates the
//      DOM canonically and notifies outputs),
//   4. re-attaches the observer.
// Net visible effect within one microtask: the user's change, now also pushed.
// ---------------------------------------------------------------------------

import {
  makeSourceChangeAdd,
  makeSourceChangeRemove,
  makeSourceChangeEdit,
} from './zero-internals.ts';
import type {Row, SourceChange} from './zero-internals.ts';
import {REMOVE, EDIT} from './change-type.ts';

/** The slice of a DOM-backed source that observeDOM drives. */
export interface ObservableSource {
  readonly container: Element;
  readonly primaryKey: readonly string[];
  currentRows(): Row[];
  reset(rows: Row[]): void;
  push(change: SourceChange): Iterable<unknown>;
  compare(a: Row, b: Row): number;
}

export interface ObserveOptions {
  onChange?: (change: SourceChange) => void;
  ObserverImpl?: typeof MutationObserver;
}

export interface ObserveHandle {
  /** Force a synchronous reconcile (handy in tests / before reading results). */
  flush(): void;
  disconnect(): void;
}

const OBSERVE_OPTS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
};

export function observeDOM(source: ObservableSource, options: ObserveOptions = {}): ObserveHandle {
  const {onChange, ObserverImpl} = options;
  const container = source.container;
  const pk = source.primaryKey;
  const MO =
    ObserverImpl ??
    (container.ownerDocument?.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ??
    globalThis.MutationObserver;
  if (!MO) throw new Error('No MutationObserver available in this environment');

  const keyOf = (row: Row) => pk.map(k => JSON.stringify(row[k])).join('\x00');
  const snap = new Map<string, Row>(); // pk -> row (last committed state)
  for (const row of source.currentRows()) snap.set(keyOf(row), row);

  const same = (a: Row, b: Row) => source.compare(a, b) === 0;

  const reconcile = (): void => {
    const current = source.currentRows();
    const currentByKey = new Map<string, Row>(current.map(r => [keyOf(r), r]));

    const changes: SourceChange[] = [];
    // removed / edited
    for (const [k, oldRow] of snap) {
      const newRow = currentByKey.get(k);
      if (newRow === undefined) changes.push(makeSourceChangeRemove(oldRow));
      else if (!same(oldRow, newRow)) changes.push(makeSourceChangeEdit(newRow, oldRow));
    }
    // added
    for (const [k, newRow] of currentByKey) {
      if (!snap.has(k)) changes.push(makeSourceChangeAdd(newRow));
    }
    if (changes.length === 0) return;

    // Revert to snapshot, then replay through the canonical push path.
    source.reset([...snap.values()]);
    for (const change of changes) {
      for (const _ of source.push(change)) { /* drain */ }
      if (change[0] === REMOVE) snap.delete(keyOf(change[1]));
      else snap.set(keyOf(change[1]), change[1]); // add & edit key on new row
      if (change[0] === EDIT) {
        // pk may have changed on an edit; drop the stale key.
        const oldKey = keyOf(change[2]);
        if (oldKey !== keyOf(change[1])) snap.delete(oldKey);
      }
      onChange?.(change);
    }
  };

  const observer = new MO(() => {
    observer.disconnect();
    try {
      reconcile();
    } finally {
      observer.observe(container, OBSERVE_OPTS);
    }
  });
  observer.observe(container, OBSERVE_OPTS);

  return {
    flush() {
      observer.disconnect();
      try {
        reconcile();
      } finally {
        observer.observe(container, OBSERVE_OPTS);
      }
    },
    disconnect() {
      observer.disconnect();
    },
  };
}
