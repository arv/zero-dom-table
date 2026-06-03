// TanStack Query as a Zero Source. Two independent TanStack queries (users, teams)
// are joined via a Zero relationship — user.related('team') — and the join stays
// live as either query refetches. Proves Zero can act as a reactive join/IVM layer
// over async data it didn't fetch itself.

import {QueryClient} from '@tanstack/query-core';
import {createSchema, table, string, number, relationships, createBuilder} from '@rocicorp/zero';
import {tanstackSource} from '../src/tanstack-source.js';
import {buildPipeline, ArrayView, MemoryStorage} from '../src/zero-internals.js';

const S = v => JSON.stringify(v);
let failures = 0;
const check = (label, actual, expected) => {
  const a = S(actual), e = S(expected);
  if (a !== e) { failures++; console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
  else console.log(`  ✓ ${label}`);
};

// --- schema: user -> team (one) ------------------------------------------
const userTable = table('user').columns({id: number(), name: string(), teamId: number()}).primaryKey('id');
const teamTable = table('team').columns({id: number(), name: string()}).primaryKey('id');
const userRels = relationships(userTable, ({one}) => ({
  team: one({sourceField: ['teamId'], destField: ['id'], destSchema: teamTable}),
}));
const schema = createSchema({tables: [userTable, teamTable], relationships: [userRels]});

// --- a fake "server" backing the TanStack queries ------------------------
let usersData = [
  {id: 1, name: 'Ada', teamId: 10},
  {id: 2, name: 'Lin', teamId: 20},
  {id: 3, name: 'Bo', teamId: 10},
];
let teamsData = [
  {id: 10, name: 'Platform'},
  {id: 20, name: 'Growth'},
];
const fetchUsers = () => Promise.resolve(usersData.map(u => ({...u})));
const fetchTeams = () => Promise.resolve(teamsData.map(t => ({...t})));

const main = async () => {
  const queryClient = new QueryClient({
    defaultOptions: {queries: {staleTime: Infinity, retry: false}},
  });
  // Prefetch so the observers have data synchronously when the sources build.
  await queryClient.prefetchQuery({queryKey: ['users'], queryFn: fetchUsers});
  await queryClient.prefetchQuery({queryKey: ['teams'], queryFn: fetchTeams});

  const userSource = tanstackSource(schema.tables.user, queryClient, {queryKey: ['users'], queryFn: fetchUsers});
  const teamSource = tanstackSource(schema.tables.team, queryClient, {queryKey: ['teams'], queryFn: fetchTeams});

  const delegate = {
    getSource: n => (n === 'user' ? userSource : n === 'team' ? teamSource : undefined),
    createStorage: () => new MemoryStorage(),
    decorateInput: i => i, decorateFilterInput: i => i, decorateSourceInput: i => i, addEdge: () => {},
  };

  const builder = createBuilder(schema);
  const query = builder.user.orderBy('id', 'asc').related('team');
  const input = buildPipeline(query.ast, delegate, 'tq');
  const view = new ArrayView(input, query.format, true, () => {});
  view.flush();

  const usersView = () => view.data.map(u => ({name: u.name, team: u.team?.name ?? null}));

  // 1. Two TanStack queries joined by a Zero relationship.
  check('join across two TanStack sources', usersView(), [
    {name: 'Ada', team: 'Platform'},
    {name: 'Lin', team: 'Growth'},
    {name: 'Bo', team: 'Platform'},
  ]);

  // 2. Refetch the teams query with a renamed team -> the join updates.
  teamsData = [{id: 10, name: 'Core Platform'}, {id: 20, name: 'Growth'}];
  await queryClient.refetchQueries({queryKey: ['teams']});
  teamSource.sync(); // real apps rely on the subscription; force it for determinism
  view.flush();
  check('refetching the teams query updates every joined user', usersView(), [
    {name: 'Ada', team: 'Core Platform'},
    {name: 'Lin', team: 'Growth'},
    {name: 'Bo', team: 'Core Platform'},
  ]);

  // 3. Refetch the users query with a new + moved user -> incremental update.
  usersData = [
    {id: 1, name: 'Ada', teamId: 20}, // moved to Growth
    {id: 2, name: 'Lin', teamId: 20},
    {id: 3, name: 'Bo', teamId: 10},
    {id: 4, name: 'Mei', teamId: 10}, // new
  ];
  await queryClient.refetchQueries({queryKey: ['users']});
  userSource.sync();
  view.flush();
  check('refetching the users query (add + move) flows through', usersView(), [
    {name: 'Ada', team: 'Growth'},
    {name: 'Lin', team: 'Growth'},
    {name: 'Bo', team: 'Core Platform'},
    {name: 'Mei', team: 'Core Platform'},
  ]);

  // 4. A plain ZQL filter/sort over the TanStack collection.
  const q2 = builder.user.where('teamId', '=', 20).orderBy('name', 'asc');
  const v2 = new ArrayView(buildPipeline(q2.ast, delegate, 'tq2'), q2.format, true, () => {});
  v2.flush();
  check('where/orderBy over a TanStack collection', v2.data.map(u => u.name), ['Ada', 'Lin']);

  console.log(failures === 0
    ? '\n✅ TanStack Query works as a Zero Source (joins + refetch + filter)'
    : `\n❌ ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

main();
