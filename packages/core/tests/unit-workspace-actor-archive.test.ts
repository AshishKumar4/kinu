// One SQL snapshot is the workspace for every actor (open-38); the archive declares its roster's actor
// count and restore refuses a rebuilt roster that disagrees.
import { describe, test, expect } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { restoreWorkspaceArchive, writeWorkspaceArchive } from '../src/identity/archive';
import { SessionHistory } from '../src/session/history';
import { readSessionTranscript, type SessionTranscriptReader } from '../src/session/transcript';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor, SqlValue } from '../src/types/primitives';

interface Workspace {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorHandle;
}

/** Local rather than test-utils' `sqlOver`: that pulls the core barrel and with it the context plane. */
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
  initWorkspaceSchema({ execRaw: (ddl) => { db.exec(ddl); }, sql, exec: makeSqlExec(db), transactionSync: (write) => db.transaction(write)() });
  const workspaceId = crypto.randomUUID();
  void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'hosted')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });

  return { db, sql, directory, main: directory.createMain({ name: 'hosted' }) };
}

/** Short enough to stay inline, so neither writer nor reader reaches a file plane. */
async function noFilePlane(): Promise<never> {
  throw new Error('an inline-payload conversation must never open a file plane');
}

/** Entry text lives in message parts, so only a projection can answer it. */
async function spoken(sql: SqlExecutor, actorId: string): Promise<string | undefined> {
  const transcript: SessionTranscriptReader =
    readSessionTranscript(sql, { actorId, assertCurrent() {} }, CHAT_SESSION_ID, noFilePlane);

  return (await transcript.project(`m-${actorId}`))?.content;
}

interface SeededActorState {
  ws: Workspace;
  actor: ActorHandle;
  text: string;
  runId: string;
  version: number;
}

async function seedActorState({ ws, actor, text, runId, version }: SeededActorState): Promise<void> {
  const now = Date.now();

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: (write) => ws.db.transaction(write)(), files: noFilePlane,
  });

  await history.record(CHAT_SESSION_ID, {
    id: `m-${actor.actorId}`, parentId: null, origin: 'input', message: { role: 'user', content: text },
  });
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
    await seedActorState({ ws, actor: ws.main, text: 'the main actor said this', runId: 'run-main', version: 4 });
    await seedActorState({ ws, actor: hire, text: 'alpha said this', runId: 'run-alpha', version: 1 });
    await seedActorState({ ws, actor: head, text: 'the head said this', runId: 'run-head', version: 7 });

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local', now: 7 });
    const end = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(end.t).toBe('end');
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
      expect(await spoken(there, actor.actorId)).toBe(text);
      expect(there<{ run_id: string; program_version: number }>`
        SELECT run_id, program_version FROM actor_turn_claims WHERE actor_id = ${actor.actorId}`[0])
        .toEqual({ run_id: runId, program_version: version });
      expect(there<{ version: number }>`
        SELECT version FROM scaffold_versions WHERE actor_id = ${actor.actorId} AND status = 'current'`[0]?.version)
        .toBe(version);
    }

    expect(there<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'conversation_entries'`[0]?.n).toBe(1);
  });

  test('a retained dismissal is still in the snapshot', async () => {
    const ws = workspace();
    const gone = ws.directory.create({ parent: ws.main, name: 'beta', creationId: 'c3', kind: 'subordinate', lifetime: 'durable' });
    await seedActorState({ ws, actor: ws.main, text: 'main', runId: 'run-main', version: 1 });
    await seedActorState({ ws, actor: gone, text: 'beta said this before it was dismissed', runId: 'run-beta', version: 2 });
    const reference = { actorId: gone.actorId, workspaceId: gone.workspaceId, parentActorId: gone.parentActorId };
    const path = ws.directory.storagePath({ actorId: ws.main.actorId, workspaceId: ws.main.workspaceId, parentActorId: null });
    ws.directory.apply(ws.main, path, { action: 'retire', name: 'beta', reference });
    ws.directory.apply(ws.main, path, { action: 'release', name: 'beta', reference });

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local' });
    expect(JSON.parse(lines[lines.length - 1] ?? '{}').actors).toBe(2);
    const target = new Database(':memory:');
    const restored = await restoreWorkspaceArchive(makeSqlExec(target), lines);
    expect(restored.actors).toBe(2);
    expect(await spoken(sqlOver(target), gone.actorId)).toBe('beta said this before it was dismissed');
  });

  test('an archive that lost one actor is refused even when its row total agrees', async () => {
    const ws = workspace();
    const head = ws.directory.create({ parent: ws.main, name: 'exp:head-1', creationId: 'c4', kind: 'head', lifetime: 'task' });
    await seedActorState({ ws, actor: ws.main, text: 'main', runId: 'run-main', version: 1 });
    await seedActorState({ ws, actor: head, text: 'head', runId: 'run-head', version: 1 });

    const lines = await writeWorkspaceArchive(makeSqlExec(ws.db), { workspace: 'hosted', source: 'local' });
    const end = JSON.parse(lines[lines.length - 1] ?? '{}');

    // Drop a roster row and repair the row total: only the declared actor count catches the missing agent.
    const short = lines
      .filter((line) => !(line.includes('"workspace_actors"') && line.includes(`"actor_id":"${head.actorId}"`)))
      .map((line) => (JSON.parse(line).t === 'end'
        ? JSON.stringify({ ...JSON.parse(line), rows: end.rows - 1 })
        : line));

    expect(short.length).toBe(lines.length - 1);
    await expect(restoreWorkspaceArchive(makeSqlExec(new Database(':memory:')), short))
      .rejects.toThrow(/declares 2 actors but restored 1/);
  });
});
