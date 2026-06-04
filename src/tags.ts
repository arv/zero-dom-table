// ---------------------------------------------------------------------------
// tags.ts — a THIRD source for the demo, fetched via TanStack Query.
//
// `tag` rows ({nodeName, emoji}) come from a (fake) remote API through a TanStack
// query. The relationship `node.tag` (one, node.nodeName == tag.nodeName) joins an
// emoji onto every DOM node by its nodeName. So the demo's tree query spans THREE
// sources of three different kinds:
//   • node  — the live DOM (DOMTreeSource)
//   • label — in-memory, click-to-edit (MemorySource)
//   • tag   — async/remote, via TanStack Query (tanstackSource)
// all joined in one incrementally-maintained query.
// ---------------------------------------------------------------------------

import {createSchema, table, string, relationships} from '@rocicorp/zero';
import {nodeTable} from './dom-tree-source.ts';
import {labelTable} from './labels.ts';

export const tagTable = table('tag')
  .columns({
    nodeName: string(), // -> node.nodeName (e.g. "LI", "#text")
    emoji: string(),
  })
  .primaryKey('nodeName');

const nodeRelationships = relationships(nodeTable, ({many, one}) => ({
  childNodes: many({sourceField: ['id'], destField: ['parentId'], destSchema: nodeTable}),
  parentNode: one({sourceField: ['parentId'], destField: ['id'], destSchema: nodeTable}),
  labels: many({sourceField: ['id'], destField: ['nodeId'], destSchema: labelTable}),
  tag: one({sourceField: ['nodeName'], destField: ['nodeName'], destSchema: tagTable}),
}));

const labelRelationships = relationships(labelTable, ({one}) => ({
  node: one({sourceField: ['nodeId'], destField: ['id'], destSchema: nodeTable}),
}));

const tagRelationships = relationships(tagTable, ({many}) => ({
  nodes: many({sourceField: ['nodeName'], destField: ['nodeName'], destSchema: nodeTable}),
}));

// Schema spanning all three tables and the cross-source relationships.
export const taggedSchema = createSchema({
  tables: [nodeTable, labelTable, tagTable],
  relationships: [nodeRelationships, labelRelationships, tagRelationships],
});
