/**
 * The pane session store — the agents SDK's `assistant_messages`, as its
 * `AgentSessionProvider.ensureTable` creates it, verbatim. `created_at` is a
 * whole-second DATETIME, the reason a fork cut cannot be a timestamp
 * comparison.
 *
 * VENDOR-OWNED. Think's session creates and writes this table; Kinu never
 * does, and product code carries no copy of it. This is the ONE fixture
 * definition, and `packages/cf-backend/tests/unit-pane-store-shape.test.ts`
 * holds it column for column to the installed SDK, so every suite that seeds
 * the pane seeds the shape production has.
 *
 * Its own module because a fixture's users are not one runtime: `workerd`
 * probes (cf-backend `tests/workerd/fork-probe.ts`) seed the same table but
 * cannot reach `tests/helpers.ts`, which imports `bun:sqlite`. Re-exported
 * there so the bun suites keep one import path.
 */
export const SDK_SESSION_DDL = `CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;
