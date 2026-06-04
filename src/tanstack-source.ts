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
import type {QueryClient, QueryObserverOptions} from '@tanstack/query-core';
import {collectionSource} from './collection-source.ts';
import type {SourceTable, CollectionSource} from './collection-source.ts';
import type {Row} from './zero-internals.ts';

type RowObserverOptions = QueryObserverOptions<readonly Row[], Error, readonly Row[]>;
type RowObserver = QueryObserver<readonly Row[], Error, readonly Row[]>;

export interface TanstackSource extends CollectionSource {
  /** The underlying QueryObserver — read status (isFetching) or trigger refetch. */
  observer: RowObserver;
}

/**
 * The query is expected to resolve to an array of rows matching `table`.
 */
export function tanstackSource(
  table: SourceTable,
  queryClient: QueryClient,
  options: RowObserverOptions,
): TanstackSource {
  const observer = new QueryObserver(queryClient, options);
  const source = collectionSource(table, {
    getRows: () => observer.getCurrentResult().data ?? [],
    subscribe: onChange => observer.subscribe(() => onChange()),
    status: () => {
      const r = observer.getCurrentResult();
      return {loading: r.isPending, error: r.error ?? undefined};
    },
  }) as TanstackSource;
  source.observer = observer;
  return source;
}
