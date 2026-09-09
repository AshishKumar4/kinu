// ONE SQL snapshot IS the workspace — for every actor, not only its main one.
//
// The claim open-38 rests on is that a workspace object's SQLite contains the
// whole workspace. That used to hold for the main actor alone: a hired
// subordinate, a head and a swarm node each owned a database, so an export of
// the workspace object was an export of one agent out of N and nothing said so.
// With every actor's rows in one database the export already covers them — but
// "already covers them" is exactly the kind of claim that rots, so the archive
// DECLARES how many actors its roster carried and the restore refuses an
// archive whose rebuilt roster disagrees.
//
// This suite deliberately depends on nothing but the archive, the directory and
// the workspace schema: no session, no event log, no store bundle. It is the
// half of the proof that can be run before the hosting cutover merges.
import { describe, test, expect } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { WorkspaceActorDirectory } from '../src/state/workspace-actors';
import { restoreWorkspaceArchive, writeWorkspaceArchive } from '../src/identity/archive';
import type { ActorHandle } from '../src/state/actor-handle';
import type { SqlExecutor, SqlValue } from '../src/types/primitives';

interface Workspace {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorHandle;
}

/**
 * A tagged-template `SqlExecutor` over a database this suite owns.
 *
 * Local rather than `@kinu.run/test-utils`' `sqlOver`, deliberately: that
 * package imports the `@kinu.run/core` barrel, the barrel re-exports the actor
 * host, and the host's own imports land with the context plane. This suite
 * proves a property of the ARCHIVE and must be runnable before that merge.
 */
function sqlOver(db: Database): SqlExecutor {
  return <Row = unknown>(strings: TemplateStringsArray, ...values: readonly SqlValue[]): Row[] => {
    const query = strings.reduce((acc, part, index) => acc + part + (index < values.length ? '?' : ''), '');
    const bound = values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    return db.prepare<Row, SQLQueryBindings[]>(query).all(...bound);
  };
}

function workspace(): Workspace {
  const db = new Database(':memory:');
  const sql = sqlOver(db);
  initWorkspaceSchema({ execRaw: (ddl) => { db.exec(ddl); }, sql, exec: makeSqlExec(db) });
  const workspaceId = crypto.randomUUID();
  void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'hosted')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });
  return { db, sql, directory, main: directory.createMain({ name: 'hosted' }) };
}

/** One actor's conversation, claim and promoted-loop pointer — the three things
 *  a snapshot has to carry per actor and used to carry for one. */
function seedActorState(ws: Workspace, actor: ActorHandle, text: string, runId: string, version: number): void {
  const now = Date.now();
  void ws.sql`INSERT INTO messages (actor_id, id, role, content, created_at)
    VALUES (${actor.actorId}, ${`m-${actor.actorId}`}, 'user', ${text}, ${now})`;
  void ws.sql`INSERT INTO actor_turn_claims (
      actor_id, turn_id, run_id, epoch, work_mode, program_kind, program_version,
      program_digest, program_build, status, outcome, consumed_revision, claimed_at, settled_at)
    VALUES (${actor.actorId}, ${`turn-${runId}`}, ${runId}, 1, 'build', 'scaffold', ${version},
      ${`digest-${version}`}, NULL, 'admitted', NULL, NULL, ${now}, NULL)`;
  void ws.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${actor.actorId}, ${version}, ${now}, ${`seeded for ${runId}`}, 'current')`;
}

describe('a workspace snapshot covers every actor', () => {
  test('export and restore return every actor conversation, claim and loop pointer', async () => {
    const ws = workspace();
    const hire = ws.directory.create({ parent: ws.main, name: 'alpha', creationId: 'c1', kind: 'subordinate', lifetime: 'durable' });
    const head = ws.directory.create({ parent: ws.main, name: 'exp:head-1', creationId: 'c2', kind: 'head', lifetime: 'task' });
    seedActorState(ws, ws.main, 'the main actor said this', 'run-main', 4);
    seedActorState(ws, hire, 'alpha said this', 'run-alpha', 1);
    seedActorState(ws, head, 'the head said this', 'run-head', 7);

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local', now: 7 });
    const end = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(end.t).toBe('end');
    // The DECLARED coverage is the roster, not just a row total.
    expect(end.actors).toBe(3);

    const target = new Database(':memory:');
    const restored = await restoreWorkspaceArchive(makeSqlExec(target), lines);
    expect(restored.actors).toBe(3);
    const there = sqlOver(target);
    expect(there<{ n: number }>`SELECT COUNT(*) AS n FROM workspace_actors`[0]?.n).toBe(3);
    for (const [actor, text, runId, version] of [
      [ws.main, 'the main actor said this', 'run-main', 4],
      [hire, 'alpha said this', 'run-alpha', 1],
      [head, 'the head said this', 'run-head', 7],
    ] as const) {
      expect(there<{ content: string }>`
        SELECT content FROM messages WHERE actor_id = ${actor.actorId}`[0]?.content).toBe(text);
      expect(there<{ run_id: string; program_version: number }>`
        SELECT run_id, program_version FROM actor_turn_claims WHERE actor_id = ${actor.actorId}`[0])
        .toEqual({ run_id: runId, program_version: version });
      expect(there<{ version: number }>`
        SELECT version FROM scaffold_versions WHERE actor_id = ${actor.actorId} AND status = 'current'`[0]?.version)
        .toBe(version);
    }
    // No child database and no second object was needed to produce any of it.
    expect(there<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages'`[0]?.n).toBe(1);
  });

  test('a retained dismissal is still in the snapshot', async () => {
    const ws = workspace();
    const gone = ws.directory.create({ parent: ws.main, name: 'beta', creationId: 'c3', kind: 'subordinate', lifetime: 'durable' });
    seedActorState(ws, ws.main, 'main', 'run-main', 1);
    seedActorState(ws, gone, 'beta said this before it was dismissed', 'run-beta', 2);
    const reference = { actorId: gone.actorId, workspaceId: gone.workspaceId, parentActorId: gone.parentActorId };
    const path = ws.directory.storagePath({ actorId: ws.main.actorId, workspaceId: ws.main.workspaceId, parentActorId: null });
    ws.directory.apply(ws.main, path, { action: 'retire', name: 'beta', reference });
    ws.directory.apply(ws.main, path, { action: 'release', name: 'beta', reference });

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local' });
    expect(JSON.parse(lines[lines.length - 1] ?? '{}').actors).toBe(2);
    const target = new Database(':memory:');
    const restored = await restoreWorkspaceArchive(makeSqlExec(target), lines);
    expect(restored.actors).toBe(2);
    // Its history retained means its rows are workspace state, so losing them
    // in a backup is data loss and not tidiness.
    expect(sqlOver(target)<{ content: string }>`
      SELECT content FROM messages WHERE actor_id = ${gone.actorId}`[0]?.content)
      .toBe('beta said this before it was dismissed');
  });

  test('an archive that lost one actor is refused even when its row total agrees', async () => {
    const ws = workspace();
    const head = ws.directory.create({ parent: ws.main, name: 'exp:head-1', creationId: 'c4', kind: 'head', lifetime: 'task' });
    seedActorState(ws, ws.main, 'main', 'run-main', 1);
    seedActorState(ws, head, 'head', 'run-head', 1);

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local' });
    const end = JSON.parse(lines[lines.length - 1] ?? '{}');
    // Drop the head's ROSTER row and repair the row total the way a truncation
    // nobody noticed would leave it. Every other check this archive faces now
    // passes; without the declared actor count it restores a workspace that is
    // silently missing an agent.
    const short = lines
      .filter((line) => !(line.includes('"workspace_actors"') && line.includes(`"actor_id":"${head.actorId}"`)))
      .map((line) => (JSON.parse(line).t === 'end'
        ? JSON.stringify({ ...JSON.parse(line), rows: end.rows - 1 })
        : line));
    expect(short.length).toBe(lines.length - 1);
    await expect(restoreWorkspaceArchive(makeSqlExec(new Database(':memory:')), short))
      .rejects.toThrow(/declares 2 actors but restored 1/);
  });

  // The restore half of the same claim. An export covering every actor is worth
  // nothing if the import folds them together, and the chat pane is where that
  // happens: it is normalized into `messages` on the way in, and `messages` is
  // actor-scoped.
  test('a restored pane keeps every row under the actor that wrote it', async () => {
    const ws = workspace();
    const hire = ws.directory.create({ parent: ws.main, name: 'gamma', creationId: 'c5', kind: 'subordinate', lifetime: 'durable' });
    // The pane exactly as `ForkTargetWriter.ensurePaneTable` writes it.
    ws.db.exec(`CREATE TABLE assistant_messages (
      actor_id TEXT NOT NULL,
      id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (actor_id, id)
    )`);
    for (const [actor, text] of [[ws.main, 'main pane line'], [hire, 'gamma pane line']] as const) {
      void ws.sql`INSERT INTO assistant_messages (actor_id, id, role, content, created_at)
        VALUES (${actor.actorId}, ${`p-${actor.actorId}`}, 'user', ${text}, '2026-01-02 03:04:05')`;
    }

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'cloud' });
    const target = new Database(':memory:');
    await restoreWorkspaceArchive(makeSqlExec(target), lines);
    const there = sqlOver(target);

    expect(there<{ content: string }>`
      SELECT content FROM messages WHERE actor_id = ${hire.actorId}`.map((r) => r.content))
      .toEqual(['gamma pane line']);
    expect(there<{ content: string }>`
      SELECT content FROM messages WHERE actor_id = ${ws.main.actorId}`.map((r) => r.content))
      .toEqual(['main pane line']);
    // Normalized once: the pane schema does not survive alongside the plain store.
    expect(there<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name = 'assistant_messages'`[0]?.n).toBe(0);
  });

  // The other vintage, and the reason the branch exists: a pane exported before
  // the column names no owner, so the directory is the only place an answer
  // lives and the main actor is the honest one.
  test('a pane with no owner column is attributed to the main actor', async () => {
    const ws = workspace();
    ws.directory.create({ parent: ws.main, name: 'delta', creationId: 'c6', kind: 'subordinate', lifetime: 'durable' });
    ws.db.exec(`CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    void ws.sql`INSERT INTO assistant_messages (id, role, content, created_at)
      VALUES ('legacy-1', 'user', 'exported before the column existed', '2026-01-02 03:04:05')`;

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'cloud' });
    const target = new Database(':memory:');
    await restoreWorkspaceArchive(makeSqlExec(target), lines);
    const there = sqlOver(target);

    expect(there<{ actor_id: string }>`
      SELECT actor_id FROM messages WHERE id = 'legacy-1'`[0]?.actor_id).toBe(ws.main.actorId);
  });
});
