// ---------------------------------------------------------------------------
// The hack.
//
// To build a custom Zero `Source` we need IVM internals (the overlay splicing,
// the split-edit push machinery, the comparators, the filter compiler, the
// pipeline builder, the array view). None of these are in `@rocicorp/zero`'s
// public `exports` map, so a bare `import '@rocicorp/zero/.../ivm/...'` fails
// with ERR_PACKAGE_PATH_NOT_EXPORTED.
//
// But the `exports` map is only consulted for *bare specifiers*. A *relative
// path* to a file inside node_modules is resolved as a plain file — bypassing
// the map. Crucially this works the same in Node AND in Vite/the browser (Vite
// also only applies `exports` to bare specifiers), and resolves to the same
// physical files the public entry uses, so there's no module duplication. The
// adjacent `.d.ts` files also give us real types for everything below.
//
// Pinned to @rocicorp/zero@1.5.0 — brittle against version bumps. If you upgrade
// Zero, re-check these paths and the signatures they export.
// ---------------------------------------------------------------------------

// --- runtime values (reused verbatim from Zero) ---------------------------
export {
  MemorySource,
  genPushAndWriteWithSplitEdit,
  generateWithOverlay,
  generateWithStart,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/memory-source.js';

export {
  compareValues,
  makeComparator,
  valuesEqual,
  normalizeUndefined,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/data.js';

export {
  primaryKeyConstraintFromFilters,
  constraintMatchesPrimaryKey,
  constraintMatchesRow,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/constraint.js';

export {skipYields} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/skip-yields.js';
export {
  makeAddChange,
  makeEditChange,
  makeRemoveChange,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/change.js';
export {
  makeSourceChangeAdd,
  makeSourceChangeRemove,
  makeSourceChangeEdit,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/source.js';

export {
  createPredicate,
  transformFilters,
} from '../node_modules/@rocicorp/zero/out/zql/src/builder/filter.js';

export {assertOrderingIncludesPK} from '../node_modules/@rocicorp/zero/out/zql/src/query/complete-ordering.js';

// For the end-to-end pipeline + tree demos.
export {buildPipeline} from '../node_modules/@rocicorp/zero/out/zql/src/builder/builder.js';
export {ArrayView} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/array-view.js';
export {MemoryStorage} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/memory-storage.js';
export type {BuilderDelegate} from '../node_modules/@rocicorp/zero/out/zql/src/builder/builder.js';

// --- types (from the adjacent .d.ts of the same internal modules) ---------
export type {
  Source,
  SourceInput,
  SourceChange,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/source.js';

export type {
  Input,
  InputBase,
  Output,
  FetchRequest,
  Start,
  Storage,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/operator.js';

export type {Node, Comparator} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/data.js';
export type {Change} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/change.js';
export type {
  Connection,
  Overlay,
} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/memory-source.js';
export type {Condition} from '../node_modules/@rocicorp/zero/out/zero-protocol/src/ast.js';
export type {Constraint} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/constraint.js';
export type {SourceSchema} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/schema.js';
export type {Stream} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/stream.js';

// --- public types (re-exported for convenience) ---------------------------
export type {Row, Value} from '../node_modules/@rocicorp/zero/out/zero-protocol/src/data.js';
export type {Ordering} from '../node_modules/@rocicorp/zero/out/zero-protocol/src/ast.js';
export type {PrimaryKey} from '../node_modules/@rocicorp/zero/out/zero-protocol/src/primary-key.js';
export type {SchemaValue} from '../node_modules/@rocicorp/zero/out/zero-types/src/schema-value.js';
export type {TableSchema} from '../node_modules/@rocicorp/zero/out/zero-types/src/schema.js';
