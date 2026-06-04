// createHost + registerSource: a host owns the schema + the delegate (the
// getSource registry), `registerSource` is the write side of it, and
// `materialize` returns a Zero-useQuery-shaped [rows, meta] view whose meta
// aggregates the registered sources' load state (unknown → complete).

import { QueryClient } from "@tanstack/query-core";
import {
  createSchema,
  table,
  string,
  number,
  relationships,
} from "@rocicorp/zero";
import { tanstackSource } from "../src/tanstack-source.ts";
import { createHost } from "../src/host.ts";
import type { Row } from "../src/zero-internals.ts";

const S = (v: unknown): string => JSON.stringify(v);
let failures = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  const a = S(actual),
    e = S(expected);
  if (a !== e) {
    failures++;
    console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
  } else console.log(`  ✓ ${label}`);
};

const userTable = table("user")
  .columns({ id: number(), name: string(), teamId: number() })
  .primaryKey("id");
const teamTable = table("team")
  .columns({ id: number(), name: string() })
  .primaryKey("id");
const userRels = relationships(userTable, ({ one }) => ({
  team: one({ sourceField: ["teamId"], destField: ["id"], destSchema: teamTable }),
}));
const schema = createSchema({
  tables: [userTable, teamTable],
  relationships: [userRels],
});

const usersData = [
  { id: 1, name: "Ada", teamId: 10 },
  { id: 2, name: "Lin", teamId: 20 },
];
const teamsData = [
  { id: 10, name: "Platform" },
  { id: 20, name: "Growth" },
];
// small delay so the "loading" state is observable before resolution
const delayed = (rows: readonly Row[]): Promise<readonly Row[]> =>
  new Promise((res) => setTimeout(() => res(rows.map((r) => ({ ...r }))), 10));

const main = async (): Promise<void> => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const host = createHost(schema);

  // registration = the write side of the delegate's getSource map
  host.registerSource(
    "user",
    tanstackSource(schema.tables.user, queryClient, {
      queryKey: ["users"],
      queryFn: () => delayed(usersData),
    }),
  );
  host.registerSource(
    "team",
    tanstackSource(schema.tables.team, queryClient, {
      queryKey: ["teams"],
      queryFn: () => delayed(teamsData),
    }),
  );

  const view = host.materialize(host.query.user.orderBy("id", "asc").related("team"));

  // 1. While the async sources are still fetching, the query is `unknown`.
  check("meta.type is 'unknown' while sources load", view.meta.type, "unknown");
  check("meta.loading is true", view.meta.loading, true);
  check("rows empty during load", (view.data as Row[]).length, 0);

  // 2. Once both fetches resolve, the host flushes the view and meta → complete.
  await new Promise((r) => setTimeout(r, 40));

  check("meta.type flips to 'complete' once loaded", view.meta.type, "complete");
  check("meta.loading is false", view.meta.loading, false);
  check(
    "joined rows across the two registered sources",
    (view.data as any[]).map((u) => ({ name: u.name, team: u.team?.name })),
    [
      { name: "Ada", team: "Platform" },
      { name: "Lin", team: "Growth" },
    ],
  );

  view.destroy();
  console.log(
    failures === 0
      ? "\n✅ createHost/registerSource: [rows, meta] with status-aware meta works"
      : `\n❌ ${failures} failure(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

main();
