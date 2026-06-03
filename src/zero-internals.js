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
// physical files the public entry uses, so there's no module duplication.
//
// Pinned to @rocicorp/zero@1.5.0 — brittle against version bumps. If you upgrade
// Zero, re-check these paths and the signatures they export.
// ---------------------------------------------------------------------------

const IVM = '../node_modules/@rocicorp/zero/out/zql/src/ivm';
const BUILDER = '../node_modules/@rocicorp/zero/out/zql/src/builder';
const QUERY = '../node_modules/@rocicorp/zero/out/zql/src/query';

// Reused verbatim from Zero — the subtle, correctness-critical bits.
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
  createPredicate,
  transformFilters,
} from '../node_modules/@rocicorp/zero/out/zql/src/builder/filter.js';

export {assertOrderingIncludesPK} from '../node_modules/@rocicorp/zero/out/zql/src/query/complete-ordering.js';

// For the end-to-end pipeline + tree demos.
export {buildPipeline} from '../node_modules/@rocicorp/zero/out/zql/src/builder/builder.js';
export {ArrayView} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/array-view.js';
export {MemoryStorage} from '../node_modules/@rocicorp/zero/out/zql/src/ivm/memory-storage.js';
