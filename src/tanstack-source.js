// ---------------------------------------------------------------------------
// tanstackSource — a TanStack Query result as a Zero Source.
//
// A QueryObserver gives us the current rows (`getCurrentResult().data`) plus a
// subscription that fires on every cache update (fetch resolved, background
// refetch, optimistic mutation, invalidation). We hand those to collectionSource,
// which diffs and pushes deltas into Zero. The result is a live Zero Source whose
// rows are whatever your TanStack query fetched — joinable against any other
// source, incrementally maintained as the query refetches.
//
// Framework-agnostic: uses @tanstack/query-core directly (no React/Solid needed).
// ---------------------------------------------------------------------------

import {QueryObserver} from '@tanstack/query-core';
import {collectionSource} from './collection-source.js';

/**
 * @param {{name: string, columns: object, primaryKey: readonly string[]}} table
 * @param {import('@tanstack/query-core').QueryClient} queryClient
 * @param {object} options QueryObserver options ({ queryKey, queryFn, select, ... })
 *   The query is expected to resolve to an array of rows matching `table`.
 */
export function tanstackSource(table, queryClient, options) {
  const observer = new QueryObserver(queryClient, options);
  const source = collectionSource(table, {
    getRows: () => observer.getCurrentResult().data ?? [],
    subscribe: onChange => observer.subscribe(() => onChange()),
  });
  // Expose the observer so callers can read status (isFetching, dataUpdatedAt)
  // and trigger refetch.
  source.observer = observer;
  return source;
}
