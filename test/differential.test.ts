// Differential test: DOMSource must be observationally identical to Zero's own
// MemorySource. We drive both with the same SourceChange sequence and assert
// that every fetch() variant and every pushed Change matches, step by step.

import {Window} from 'happy-dom';
import {DOMSource} from '../src/dom-source.ts';
import {MemorySource} from '../src/zero-internals.ts';
import type {SourceInput, Output, FetchRequest, SourceChange, SchemaValue, Row} from '../src/zero-internals.ts';
import {ADD, REMOVE, EDIT} from '../src/change-type.ts';

// happy-dom's DOM types differ from lib.dom; tests are runtime-validated, so we
// treat the document as `any` and let the sources see real DOM nodes at runtime.
const document: any = new Window().document;

const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const S = (v: unknown): string => JSON.stringify(v, jsonReplacer);

// LCG for reproducible "randomness".
let seed = 0x2545f491;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

let failures = 0;
function eq(label: string, a: string, b: string): void {
  if (a !== b) {
    failures++;
    console.error(`  ✗ ${label}\n      mem: ${a}\n      dom: ${b}`);
  }
}

// Drain a Stream<Node|'yield'> into a JSON string of its rows.
function fetchRows(input: SourceInput, req: FetchRequest): string {
  const rows: Row[] = [];
  for (const node of input.fetch(req)) {
    if (node === 'yield') continue;
    rows.push(node.row);
  }
  return S(rows);
}

// An Output that records the downstream Changes it receives.
function recorder(): {output: Output; log: string[]} {
  const log: string[] = [];
  const output: Output = {
    push(change) {
      const c = change as any;
      const type = c[0];
      const node = c[1];
      const extra = type === EDIT ? c[2].row : null;
      log.push(S([type, node.row, extra]));
      return []; // empty Stream<'yield'>
    },
  };
  return {output, log};
}

function drain(stream: Iterable<unknown>): void {
  for (const _ of stream) { /* consume */ }
}

interface ScenarioOpts {
  columns: Record<string, SchemaValue>;
  primaryKey: readonly [string, ...string[]];
  connSpecs: {sort: any; splitEditKeys?: Set<string>}[];
  fetchReqs: ((rows: Row[]) => FetchRequest)[];
  genAdd: (model: Map<string, Row>) => Row;
  mutate: (old: any) => Row;
  steps: number;
}

function runScenario(name: string, opts: ScenarioOpts): void {
  const {columns, primaryKey, connSpecs, fetchReqs, genAdd, mutate, steps} = opts;
  console.log(`\n# ${name}`);
  const tbody = document.createElement('tbody');
  const mem = new MemorySource(name, columns, primaryKey);
  const dom = new DOMSource(tbody, {tableName: name, columns, primaryKey});

  // Set up matching connections + recorders on both sources.
  const conns = connSpecs.map(spec => {
    const mr = recorder();
    const dr = recorder();
    const mi = mem.connect(spec.sort, undefined, spec.splitEditKeys);
    const di = dom.connect(spec.sort, undefined, spec.splitEditKeys);
    mi.setOutput(mr.output);
    di.setOutput(dr.output);
    return {spec, mi, di, mr, dr};
  });

  const model = new Map<string, Row>(); // pk-string -> row
  const pkOf = (row: Row): string => primaryKey.map(k => S(row[k])).join(' ');

  const compareFetches = (step: number): void => {
    for (const c of conns) {
      for (const reqOf of fetchReqs) {
        const req = reqOf([...model.values()]);
        eq(
          `step ${step} ${name} conn=${S(c.spec.sort)} fetch=${S(req)}`,
          fetchRows(c.mi, req),
          fetchRows(c.di, req),
        );
      }
    }
  };

  compareFetches(-1); // empty state

  for (let step = 0; step < steps; step++) {
    const keys = [...model.keys()];
    const kind = keys.length === 0 ? 'add' : pick(['add', 'add', 'edit', 'remove'] as const);

    let change: SourceChange;
    if (kind === 'add') {
      const row = genAdd(model);
      if (model.has(pkOf(row))) continue; // skip dup pk
      change = [ADD, row, null];
      model.set(pkOf(row), row);
    } else if (kind === 'remove') {
      const row = model.get(pick(keys))!;
      change = [REMOVE, row, null];
      model.delete(pkOf(row));
    } else {
      const oldRow = model.get(pick(keys))!;
      const newRow = mutate(oldRow); // same pk, different fields
      change = [EDIT, newRow, oldRow];
      model.set(pkOf(newRow), newRow);
    }

    drain(mem.push(change));
    drain(dom.push(change));

    // Pushed Change logs must match for every connection.
    for (const c of conns) {
      eq(`step ${step} ${name} pushlog conn=${S(c.spec.sort)}`, S(c.mr.log), S(c.dr.log));
    }
    compareFetches(step);
  }
}

// ----- Scenario 1: single-column PK -----
runScenario('item', {
  columns: {
    id: {type: 'number'},
    name: {type: 'string'},
    score: {type: 'number'},
    active: {type: 'boolean'},
  },
  primaryKey: ['id'],
  connSpecs: [
    {sort: [['id', 'asc']]},
    {sort: [['score', 'asc'], ['id', 'asc']]},
    {sort: [['score', 'desc'], ['id', 'asc']]},
    {sort: [['name', 'asc'], ['id', 'asc']]},
    {sort: [['id', 'asc']], splitEditKeys: new Set(['active'])},
  ],
  fetchReqs: [
    () => ({}),
    () => ({reverse: true}),
    () => ({constraint: {active: true}}),
    () => ({constraint: {active: false}}),
    rows => (rows.length ? {start: {row: rows[Math.floor(rows.length / 2)]!, basis: 'at'}} : {}),
    rows => (rows.length ? {start: {row: rows[0]!, basis: 'after'}, reverse: true} : {}),
  ],
  genAdd: model => ({
    id: model.size === 0 ? 1 : Math.floor(rand() * 12) + 1,
    name: pick(['alice', 'bob', 'carol', 'dave', 'eve']),
    score: Math.floor(rand() * 5),
    active: rand() < 0.5,
  }),
  mutate: old => ({...old, score: (old.score + 1) % 5, active: !old.active}),
  steps: 200,
});

// ----- Scenario 2: composite PK (exercises primaryKey.length > 1 branch) -----
runScenario('pair', {
  columns: {
    a: {type: 'number'},
    b: {type: 'string'},
    w: {type: 'number'},
  },
  primaryKey: ['a', 'b'],
  connSpecs: [
    {sort: [['a', 'asc'], ['b', 'asc']]},
    {sort: [['w', 'asc'], ['a', 'asc'], ['b', 'asc']]},
    {sort: [['w', 'desc'], ['a', 'desc'], ['b', 'asc']]},
  ],
  fetchReqs: [
    () => ({}),
    () => ({reverse: true}),
    () => ({constraint: {a: 1}}),
    () => ({constraint: {w: 2}}),
    rows => (rows.length ? {start: {row: rows[Math.floor(rows.length / 2)]!, basis: 'after'}} : {}),
  ],
  genAdd: () => ({
    a: Math.floor(rand() * 3) + 1,
    b: pick(['x', 'y', 'z']),
    w: Math.floor(rand() * 4),
  }),
  mutate: old => ({...old, w: (old.w + 2) % 4}),
  steps: 200,
});

console.log(
  failures === 0
    ? '\n✅ ALL CHECKS PASSED — DOMSource is observationally identical to MemorySource'
    : `\n❌ ${failures} mismatch(es)`,
);
process.exit(failures === 0 ? 0 : 1);
