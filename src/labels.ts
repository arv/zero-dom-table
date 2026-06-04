// ---------------------------------------------------------------------------
// labels.ts — a SECOND source, joined to the DOM tree.
//
// Demonstrates combining sources: the `node` table is backed by the live DOM
// (DOMTreeSource), while `label` is an ordinary in-memory source. They're tied
// together by a relationship — `node.labels` (many, `node.id == label.nodeId`)
// and the inverse `label.node` (one) — so a single query
// `node.related('labels', …)` joins DOM-backed rows with rows from a completely
// different source. Zero's BuilderDelegate.getSource(tableName) routes each
// table to its own source, so the join just works.
// ---------------------------------------------------------------------------

import {createSchema, table, string, relationships} from '@rocicorp/zero';
import {nodeTable} from './dom-tree-source.ts';
import {MemorySource} from './zero-internals.ts';

export const labelTable = table('label')
  .columns({
    id: string(),
    nodeId: string(), // -> node.id
    text: string(),
    color: string(),
  })
  .primaryKey('id');

const nodeRelationships = relationships(nodeTable, ({many, one}) => ({
  childNodes: many({sourceField: ['id'], destField: ['parentId'], destSchema: nodeTable}),
  parentNode: one({sourceField: ['parentId'], destField: ['id'], destSchema: nodeTable}),
  labels: many({sourceField: ['id'], destField: ['nodeId'], destSchema: labelTable}),
}));

const labelRelationships = relationships(labelTable, ({one}) => ({
  node: one({sourceField: ['nodeId'], destField: ['id'], destSchema: nodeTable}),
}));

// Schema spanning BOTH tables and the cross-source relationship.
export const labeledSchema = createSchema({
  tables: [nodeTable, labelTable],
  relationships: [nodeRelationships, labelRelationships],
});

export function createLabelSource(): MemorySource {
  const t = labeledSchema.tables.label;
  return new MemorySource('label', t.columns, t.primaryKey);
}
