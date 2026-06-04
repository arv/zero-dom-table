// Zero's `ChangeType` is a const-style enum with no runtime module (the numeric
// tags are inlined into its compiled output). We can't import it as a value, so
// we mirror the tags here. They're typed as the literals 0/1/2 — the exact type
// of `SourceChange[0]` — so `change[0] === ADD` both compiles and narrows the
// discriminated union. Construction goes through Zero's makeSourceChange* helpers.
export const ADD = 0;
export const REMOVE = 1;
export const EDIT = 2;
