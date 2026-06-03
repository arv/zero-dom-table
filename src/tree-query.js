// ---------------------------------------------------------------------------
// tree-query.js — expanding the self-referential `childNodes` relationship.
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
// The alternative idiom — query the flat node list and rebuild the tree in the
// view layer from parentId — has no depth limit at all; this module keeps the
// "the query returns the nested tree" shape, sized to the data.
// ---------------------------------------------------------------------------

/**
 * Expand `childNodes` `depth` levels, ordering each level by `order` and
 * optionally applying `perLevel` (e.g. to pull in a `labels` relationship) at
 * every level.
 *
 * @param {object} query a Zero query positioned at the tree roots
 * @param {number} depth number of `childNodes` levels to unroll
 * @param {(q: object) => object} [perLevel] applied at each level
 */
export function expandChildNodes(query, depth, perLevel = q => q) {
  const go = (q, d) =>
    d <= 0
      ? perLevel(q)
      : perLevel(q).related('childNodes', sub => go(sub.orderBy('order', 'asc'), d - 1));
  return go(query, depth);
}

/**
 * Max node depth under `root` (a direct child of root is depth 1). Counts every
 * node, including Text nodes, so it never under-counts the rows the source emits.
 * Expanding `childNodes` this many levels is always enough to reach every node
 * (one level of headroom — the deepest expansion just yields empty children).
 */
export function domDepth(root) {
  let max = 0;
  const walk = (node, d) => {
    for (const child of node.childNodes) {
      if (d > max) max = d;
      walk(child, d + 1);
    }
  };
  walk(root, 1);
  return max;
}
