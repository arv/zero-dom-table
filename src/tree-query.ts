// ---------------------------------------------------------------------------
// tree-query.ts — expanding the self-referential `childNodes` relationship.
//
// IMPORTANT: Zero (ZQL) has NO recursive queries — no recursive-CTE equivalent.
// `buildPipeline` eagerly unrolls `ast.related` into Join operators, so a query
// materializes a FIXED shape. The `childNodes` relationship is self-referential
// in the *schema* (node → node), but to drill the tree you must unroll
// `.related('childNodes', …)` to a finite depth. There is no way around that at
// the query layer; the only choice is how deep, and who decides it.
//
// So instead of a magic constant that silently truncates, `domDepth()` measures
// the live tree and callers expand exactly that deep (rebuilding when it grows).
// ---------------------------------------------------------------------------

// The Zero query builder's relationship API is keyed by relationship-name
// strings and changes the result type per `.related` call, which a generic
// recursive unroll helper can't express precisely. We keep the caller's query
// type `Q` (so `.ast`/`.format` stay typed) and use `any` for the dynamic
// recursion internally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;

/**
 * Expand `childNodes` `depth` levels, ordering each level by `order` and
 * optionally applying `perLevel` (e.g. to pull in a `labels` relationship) at
 * every level.
 */
export function expandChildNodes<Q>(
  query: Q,
  depth: number,
  perLevel: (q: Q) => Q = q => q,
): Q {
  const go = (q: AnyQuery, d: number): AnyQuery => {
    const withLevel: AnyQuery = perLevel(q);
    return d <= 0
      ? withLevel
      : withLevel.related('childNodes', (sub: AnyQuery) => go(sub.orderBy('order', 'asc'), d - 1));
  };
  return go(query, depth);
}

/**
 * Max node depth under `root` (a direct child of root is depth 1). Counts every
 * node, including Text nodes, so it never under-counts the rows the source emits.
 * Expanding `childNodes` this many levels is always enough to reach every node
 * (one level of headroom — the deepest expansion just yields empty children).
 */
export function domDepth(root: Node): number {
  let max = 0;
  const walk = (node: Node, d: number): void => {
    for (const child of node.childNodes) {
      if (d > max) max = d;
      walk(child, d + 1);
    }
  };
  walk(root, 1);
  return max;
}
