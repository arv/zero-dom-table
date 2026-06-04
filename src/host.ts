// ---------------------------------------------------------------------------
// createHost — the proposed client-integration seam for custom sources.
//
// A host owns the schema, the query builder, and the IVM *delegate* (the thing
// buildPipeline calls `getSource(tableName)` on). `registerSource(name, …)` is
// just the write side of that delegate map — which is exactly the piece that was
// missing: for a query to join across sources, every table its AST touches must
// resolve to a registered source.
//
// `materialize(query)` returns a Zero-`useQuery`-shaped `[rows, meta]` view, with
// `meta` aggregated across the sources the query touches — so a collection's
// loading state surfaces as Zero's `{type: 'unknown' | 'complete'}` (an unresolved
// async source is `'unknown'`, exactly like a not-yet-synced Zero query).
//
// This is the userland shape; in Zero proper, `z.registerSource` + client-local
// tables would be the real thing (mark the table un-synced, route the host's
// getSource, feed status into meta). `wrapDelegate` shows the minimal primitive.
// ---------------------------------------------------------------------------

import { createBuilder } from "@rocicorp/zero";
import { buildPipeline, ArrayView, MemoryStorage } from "./zero-internals.ts";
import type { BuilderDelegate, Source } from "./zero-internals.ts";
import { collectionSource } from "./collection-source.ts";
import type {
  SourceTable,
  CollectionSource,
  CollectionOptions,
  SourceStatus,
} from "./collection-source.ts";

export interface QueryMeta {
  type: "complete" | "unknown";
  loading: boolean;
  error?: unknown;
}

export interface MaterializedView<T = unknown> {
  readonly data: T;
  readonly meta: QueryMeta;
  subscribe(cb: () => void): () => void;
  destroy(): void;
}

/** The minimal primitive: front a delegate with a custom registry, fall back. */
export function wrapDelegate(
  original: BuilderDelegate,
  custom: Map<string, Source>,
): BuilderDelegate {
  return {
    ...original,
    getSource: (name) => custom.get(name) ?? original.getSource(name),
  };
}

const isSource = (x: unknown): x is Source =>
  typeof (x as Source)?.connect === "function";

const isCollectionSource = (s: Source): s is CollectionSource =>
  typeof (s as CollectionSource).onSync === "function" &&
  typeof (s as CollectionSource).status === "function";

// Every table an AST touches: the root + all `related` subqueries (recursively).
function collectTables(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ast: any,
  into = new Set<string>(),
): Set<string> {
  into.add(ast.table);
  for (const r of ast.related ?? []) collectTables(r.subquery, into);
  return into;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHost(schema: { tables: Record<string, any> }) {
  const registry = new Map<string, Source>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = createBuilder(schema as any);
  const delegate: BuilderDelegate = {
    getSource: (name) => registry.get(name),
    createStorage: () => new MemoryStorage(),
    decorateInput: (i) => i,
    decorateFilterInput: (i) => i,
    decorateSourceInput: (i) => i,
    addEdge: () => {},
  };
  let nextId = 0;

  return {
    /** The Zero query builder (`host.query.node.where(...).related(...)`). */
    query: builder,

    /** Register a source by table name — `Source` or `collectionSource` hooks. */
    registerSource(name: string, srcOrHooks: Source | CollectionOptions): Source {
      const source = isSource(srcOrHooks)
        ? srcOrHooks
        : collectionSource(schema.tables[name] as SourceTable, srcOrHooks);
      registry.set(name, source);
      return source;
    },

    /** Materialize a query into a live `[rows, meta]` view. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    materialize(query: any): MaterializedView {
      const input = buildPipeline(query.ast, delegate, "q" + ++nextId);
      const view = new ArrayView(input, query.format, true, () => {});
      view.flush();

      const sources = [...collectTables(query.ast)]
        .map((t) => registry.get(t))
        .filter((s): s is Source => !!s);
      const collections = sources.filter(isCollectionSource);

      const listeners = new Set<() => void>();
      const notify = () => {
        for (const l of listeners) l();
      };
      const unsubs = collections.flatMap((s) => [
        s.onSync(() => {
          view.flush();
          notify();
        }),
        s.onStatusChange(() => notify()),
      ]);

      const meta = (): QueryMeta => {
        const statuses: SourceStatus[] = collections.map((s) => s.status());
        const loading = statuses.some((st) => st.loading);
        const error = statuses.find((st) => st.error !== undefined)?.error;
        return { type: loading ? "unknown" : "complete", loading, error };
      };

      return {
        get data() {
          return view.data;
        },
        get meta() {
          return meta();
        },
        subscribe(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        destroy() {
          for (const u of unsubs) u();
          view.destroy();
        },
      };
    },
  };
}
