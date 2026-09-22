// Real actor handles over a test database. Actor-private stores re-run the handle's validation per
// statement, so a literal stand-in would bypass the binding under test; `sibling` proves isolation.
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
  sibling: (name: string) => ActorHandle;
  readonly workspaceId: string;
  readonly directory: WorkspaceActorDirectory;
}

/**
 * Bind real actors over a database the test already has. Idempotent: identity row and actor
 * tables are written only when absent, so this composes with `initWorkspaceSchema`/`createTestRuntime`.
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

  // The directory refuses an authority that disagrees with the database's stated owner, so read it.
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

/** The same over a `bun:sqlite` handle a test opened itself. */
export function createTestActorsOver(db: Database, opts: { name?: string } = {}): TestActors {
  return createTestActors(sqlOver(db), (ddl) => { db.exec(ddl); }, opts);
}
