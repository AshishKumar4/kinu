// A background job's settle notice reaches the owner's conversation once, and never reads as
// the owner's words. Recovery is at-least-once, so the notice's identity is the row's primary key.
import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { BackgroundJobRunner, backgroundJobWakeTrigger } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { Inbox } from '../src/orchestrator/inbox';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { getChatHistoryPage } from '../src/read-models/status';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { PROGRAMMATIC_MESSAGE_ID_PREFIX, TURN_AUTHOR_METADATA_KEY } from '../src/utils/ui-message';
import type { BackendHost } from '../src/types/backend-host';
import type { Schedule } from '../src/types/primitives';
import { createTestWorkspace, createWorkspaceBundle, makeSql, makeSqlExec } from './helpers';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { createTestActors } from '@kinu.run/test-utils';

const JOB = 'bgjob-y2vlvl1wbli9gan6sh78a';

/** Copied, not stubbed: `appendUser` skipping a present id is the mechanism a stable id relies on. */
function chatStore(db: Database) {
  const sql = makeSql(db);
  const actor = openWorkspaceMainActor(sql);

  const history = new SessionHistory({
    sql, actor, transactionSync: (write) => db.transaction(write)(),
    files: async () => ({ vfs: createWorkspaceBundle(db).vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  const transcript = history.transcript(CHAT_SESSION_ID);

  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async ({ text, metadata, idempotencyKey }) => {
      const id = `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${idempotencyKey ?? crypto.randomUUID()}`;

      const message = await history.admitInput({
        id, turnId: id, message: { role: 'user', content: text },
        assertOwner: () => { actor.assertCurrent(); },
      });

      transcript.appendUser(await transcript.prepareUser(
        metadata === undefined ? { id, turnId: id, message } : { id, turnId: id, message, metadata },
      ));

      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  return { host, sql, history, transcript };
}

/** Fresh runner and in-memory state over the same database. */
function activation(db: Database) {
  const sql = makeSql(db);
  const { host } = chatStore(db);
  const fiber: Schedule['fiber'] = async (_name, fn) => fn({ stash: () => {}, snapshot: null });

  const runner = new BackgroundJobRunner({
    store: new BackgroundJobStore(sql, openWorkspaceMainActor(sql)),
    fiber,
    inbox: new Inbox(host),
    eventLog: new EventLog(makeSqlExec(db), openWorkspaceMainActor(sql)),
    scheduleDrain: () => {},
  });

  return { runner, sql };
}

/** Settled in the registry yet still `running` for the sweep: the state recoverOrphans handles. */
function evictedWorkspace() {
  const ws = createTestWorkspace();
  initBackgroundJobsTable(ws.execRaw);
  initEventsHubTables(makeSqlExec(ws.db));
  const actor = createTestActors(ws.sql, ws.execRaw).main;
  const store = new BackgroundJobStore(ws.sql, actor);
  const now = Date.now();
  store.create({
    id: JOB, kind: 'agents', workMode: 'build', now,
    label: 'fork: design the generation algorithm',
  });

  return { db: ws.db, store, now, actor };
}

/** Read off the canonical store, so a duplicate cannot hide behind the paged projection. */
async function noticeRows(db: Database): Promise<{ id: string; content: string }[]> {
  const transcript = chatStore(db).transcript;
  const rows: { id: string; content: string }[] = [];

  for (const entry of transcript.ancestry()) {
    const projected = await transcript.project(entry.id);

    if (projected === null) throw new Error(`entry ${entry.id} vanished between read and projection`);
    rows.push({ id: projected.id, content: projected.content });
  }

  return rows;
}

describe('a settled background job announces itself once, and not as the owner', () => {
  test('N cold activations over one settled job leave ONE conversation row', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, JSON.stringify({ strategy: 'mcts', score: 0 }), ws.now + 1_000);

    for (let start = 0; start < 6; start++) {
      const { runner } = activation(ws.db);
      await runner.wake(JOB);
    }

    const rows = await noticeRows(ws.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${backgroundJobWakeTrigger(JOB)}`);
    expect(rows[0].content).toContain(`Background agents job ${JOB} completed`);
  });

  test('driving orphan recovery twice over the same rows still leaves ONE row', async () => {
    const ws = evictedWorkspace();
    ws.store.fail(
      JOB, 0,
      // Legacy give-up text: stored rows outlive the code that wrote them.
      'interrupted by Durable Object eviction before completion (gave up after 5 resume attempts)',
      ws.now + 1_000,
    );

    const first = activation(ws.db);
    await first.runner.recover({ jobId: JOB, phase: 'running' });
    const second = activation(ws.db);
    await second.runner.recover({ jobId: JOB, phase: 'running' });

    const rows = await noticeRows(ws.db);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('gave up after 5 resume attempts');
  });

  test('the notice is not offered as the owner\'s words: the transcript reports it as system', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const { runner } = activation(ws.db);
    await runner.wake(JOB);

    const history = (await getChatHistoryPage(chatStore(ws.db).transcript)).items;
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('system');

    const stored = makeSql(ws.db)<{ role: string }>`SELECT role FROM conversation_entries`;

    expect(stored[0].role).toBe('user');
  });

  test('a walk-back list built from the transcript offers no machine notice', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const { runner } = activation(ws.db);
    await runner.wake(JOB);
    const owner = chatStore(ws.db);
    await owner.history.record(CHAT_SESSION_ID, {
      id: 'typed-1', parentId: owner.transcript.newestId(), origin: 'input',
      message: { role: 'user', content: 'find me a domain' },
    });

    // forkCandidates' predicate (`role === 'user'`).
    const pivots = (await getChatHistoryPage(owner.transcript)).items
      .filter((row) => row.role === 'user')
      .map((row) => row.content);

    expect(pivots).toEqual(['find me a domain']);
  });

  test('NEGATIVE CONTROL: the same delivery without an announcement identity duplicates', async () => {
    const ws = evictedWorkspace();
    const { host } = chatStore(ws.db);
    const inbox = new Inbox(host);

    for (let start = 0; start < 6; start++) {
      await inbox.send({ kind: 'background_job', text: `Background agents job ${JOB} completed.` });
    }

    const rows = await noticeRows(ws.db);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.id)).size).toBe(6);
    expect(new Set(rows.map((row) => row.content)).size).toBe(1);
  });

  test('authorship covers every programmatic writer, keyed or not', async () => {
    // `fork_interrupted` (heads/reconcile.ts) is an unkeyed writer; authorship is fixed at the seam.
    const ws = evictedWorkspace();
    const { host } = chatStore(ws.db);
    await new Inbox(host).send({
      kind: 'fork_interrupted',
      text: '23 head(s) across 6 fork run(s) were still marked running…',
    });

    const history = (await getChatHistoryPage(chatStore(ws.db).transcript)).items;
    expect(history.map((row) => row.role)).toEqual(['system']);
  });

  test('the wake and its durable retry breadcrumb name the same announcement', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const sql = makeSql(ws.db);

    // Pre-empting host: the breadcrumb's trigger_id must equal the queued turn's identity.
    const preempting: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async () => ({ status: 'skipped' }),
      turnInFlight: () => false,
      setTimer: () => {},
    };

    const fiber: Schedule['fiber'] = async (_name, fn) => fn({ stash: () => {}, snapshot: null });

    const runner = new BackgroundJobRunner({
      store: new BackgroundJobStore(sql, openWorkspaceMainActor(sql)),
      fiber,
      inbox: new Inbox(preempting),
      eventLog: new EventLog(makeSqlExec(ws.db), openWorkspaceMainActor(sql)),
      scheduleDrain: () => {},
    });

    await runner.wake(JOB);
    await runner.wake(JOB);

    const events = sql<{ payload: string }>`SELECT payload FROM agent_log WHERE kind = 'event'`;
    expect(events).toHaveLength(1);
    expect(events[0].payload).toContain(backgroundJobWakeTrigger(JOB));
  });

  test('the entry carries the stamp at rest, and the paged read serves it', async () => {
    // The id has no prefix, so only the entry's authorship stamp can answer.
    const ws = evictedWorkspace();
    const store = chatStore(ws.db);
    const id = backgroundJobWakeTrigger(JOB);
    const text = `Background agents job ${JOB} completed. Read the full result with agent.jobResult.`;

    const message = await store.history.admitInput({
      id, turnId: id, message: { role: 'user', content: text },
      assertOwner: () => { ws.actor.assertCurrent(); },
    });

    store.transcript.appendUser(await store.transcript.prepareUser({
      id, turnId: id, message,
      metadata: {
        kinuEvent: 'background_job', jobId: JOB, kind: 'agents', status: 'completed',
        [TURN_AUTHOR_METADATA_KEY]: 'harness',
      },
    }));

    const history = (await getChatHistoryPage(store.transcript)).items;
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('system');
    expect(history[0].metadata).toMatchObject({ kinuEvent: 'background_job', jobId: JOB });
  });
});
