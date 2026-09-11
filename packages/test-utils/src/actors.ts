// REAL actor handles over a test database — the fixture the actor-private
// stores need.
//
// Every store that holds an actor's own state (`agent_facts`, `agent_tasks`,
// the head journal, `background_jobs`, the search ledger) is now constructed
// against an `ActorHandle`, captures its `actorId` once, and re-runs the
// handle's own validation before each statement. A test that wants one of those
// stores therefore needs an actor, and it has to be a REAL one: a literal
// standing in for the handle would bypass exactly the binding the stores exist
// to enforce, and two such literals could not collide the way two issued actors
// genuinely do.
//
// So this builds the production article. `WorkspaceActorDirectory` is the same
// class `createTestRuntime` and both backends issue through, `initActorScope`
// writes the same three tables `initWorkspaceSchema` does, and the handles
// come back with the directory's real validate closure — a retired row stops
// authorising writes here exactly as it does in production.
//
// `sibling` is what makes isolation provable: two actors of one workspace,
// over ONE database, whose stores must not see each other's rows even when
// their keys, task ids and job ids are identical.
import type { Database } from 'bun:sqlite';
import {
  WORKSPACE_IDENTITY_DDL, initWorkspaceActorTable, initAgentConfigTable, initCodemodeStateTable,
  WorkspaceActorDirectory, type ActorHandle, type RawSqlExec, type SqlExecutor,
} from '@kinu.run/core';
import { sqlOver } from './sql';

/** The actors of one test workspace, and the directory that issued them. */
export interface TestActors {
  /** The workspace's main actor — what a single-actor test binds its stores to. */
  readonly main: ActorHandle;
  /** Issue a real subordinate of `main`, for the two-actor isolation cases. */
  sibling(name: string): ActorHandle;
  readonly workspaceId: string;
  readonly directory: WorkspaceActorDirectory;
}

/**
 * Bind real actors over a database the test already has.
 *
 * Idempotent in the part that matters: the identity row and the three actor
 * tables are written only when absent, so this composes with fixtures that
 * already ran `initWorkspaceSchema` or `createTestRuntime`.
 */
export function createTestActors(
  sql: SqlExecutor, execRaw: RawSqlExec, opts: { name?: string } = {},
): TestActors {
  execRaw(WORKSPACE_IDENTITY_DDL);
  initWorkspaceActorTable(execRaw);
  initAgentConfigTable(execRaw);
  initCodemodeStateTable(execRaw);

  const existing = sql<{ id: string; owner_user_id: string }>`
    SELECT id, owner_user_id FROM workspace_identity LIMIT 1
  `[0];

  const workspaceId = existing?.id ?? crypto.randomUUID();
  const name = opts.name ?? 'test';

  if (!existing) void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, ${name})`;

  // The owner is READ, never assumed. A directory whose authority disagrees with
  // the database's stated owner is refused outright — that check is the point of
  // the directory — so a fixture composing over a harness that already
  // bootstrapped its workspace (with a real owner) cannot hardcode `''` here
  // without failing every test in the file with an ownership mismatch.
  const directory = new WorkspaceActorDirectory(sql, {
    workspaceId,
    ownerUserId: existing?.owner_user_id ?? '',
  });

  const main = directory.createMain({ name });

  return {
    main,
    workspaceId,
    directory,
    sibling: (child: string) => directory.create({
      parent: main, name: child, kind: 'subordinate', lifetime: 'durable', creationId: child,
    }),
  };
}

/** The same over a `bun:sqlite` handle a test opened itself — the shape most
 *  store suites already have, where `makeSql`/`makeExecRaw` were built inline. */
export function createTestActorsOver(db: Database, opts: { name?: string } = {}): TestActors {
  return createTestActors(sqlOver(db), (ddl) => { db.exec(ddl); }, opts);
}
