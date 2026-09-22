// Kinu-local rule; see upstream.json's `kinuRules`. The seeded red->green run through the real
// `oxlint` binary lives in ../no-design-smells.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noManufacturedSqlColumnRule } from "./no-manufactured-sql-column.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "manufacturedColumn" };

tester.run("anti-slop/no-manufactured-sql-column", noManufacturedSqlColumnRule, {
  valid: [
    // An existence probe reads no column; the constant is the whole answer.
    "const present = sql`SELECT 1 AS present FROM head_journal WHERE actor_id = ${id} LIMIT 1`.length > 0;",
    "const held = exec('SELECT 1 AS held FROM user_mcp_servers WHERE lower(name) = lower(?) LIMIT 1');",
    // Real columns only.
    "const rows = sql`SELECT sequence, part_no, operation, payload_json FROM message_updates WHERE actor_id = ${a}`;",
    // Expressions and aggregates aliased are computed from the table, not planted.
    "const n = sql`SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM turn_outcomes`;",
    "const m = sql`SELECT *, COALESCE(input, output) IS NOT NULL AS reported FROM field`;",
    "const j = sql`SELECT id, json_extract(usage, '$.input') AS input FROM call`;",
    // A UNION arm fills a column so the arms align; that is the legitimate use of a constant column.
    "const ranked = sql`SELECT *, eff_rn FROM (SELECT *, 1 AS eff_rn FROM turn_outcomes) UNION ALL SELECT *, 1 AS eff_rn FROM turn_outcomes WHERE turn_id IS NULL`;",
    // A string that is not SQL.
    "const label = 'select the option marked NULL as unknown';",
    // A subquery of constants inside a real select list is the subquery's own probe.
    "const rows = sql`SELECT id, (SELECT 1 AS x FROM t WHERE t.id = u.id LIMIT 1) AS linked FROM u`;",
    // No FROM: nothing is read, so nothing is faked.
    "const one = sql`SELECT 1 AS v`;",
  ],
  invalid: [
    {
      name: "the projection read that faked message_updates' shape (messages.ts, 2026-09-21)",
      code: "const row = this.sql<UpdateRow>`SELECT sequence,NULL AS part_no,'open' AS operation,payload_json,payload_path,payload_digest FROM message_projections WHERE actor_id=${a} AND message_id=${m}`[0];",
      errors: [error],
    },
    {
      name: "a string literal statement",
      code: "const rows = exec(\"SELECT id, name, 'workspace' AS kind FROM workspaces WHERE owner = ?\", owner);",
      errors: [error],
    },
    {
      name: "a number planted beside a column",
      code: "const rows = sql`SELECT id, 0 AS depth FROM nodes`;",
      errors: [error],
    },
    {
      name: "mixed case keywords",
      code: "const rows = sql`select id, null as parent_id from nodes`;",
      errors: [error],
    },
    {
      name: "the fake inside a subquery",
      code: "const rows = sql`SELECT * FROM (SELECT id, 'open' AS operation FROM parts) WHERE id = ${id}`;",
      errors: [error],
    },
  ],
});
