// A background job's settle notice must reach the owner's conversation ONCE,
// and must never read as something the owner said.
//
// Measured on the owner's live workspace `stone-ash-71f2` (getChatHistory over
// POST /api/cli/workspaces/stone-ash-71f2/rpc): the newest page of 100 messages
// held 58 rows with distinct ids and byte-identical content
//
//   {role:'user', content:"Background agents job bgjob-y2vlvl1wbli9gan6sh78a
//    completed. Read the full result with agent.jobResult('bgjob-…'), …"}
//
// stamped 30–31s apart across 28 minutes with no assistant reply between any of
// them, plus 9 more for a second job that had died with
// `interrupted by Durable Object eviction before completion (gave up after 5
// resume attempts)`.
//
// Two independent defects produced that:
//
//  (a) the notice is stored `role:'user'`, which it must be for the model to
//      read it as its turn input — but every consumer that asks "what did the
//      owner say" was answering with it. `forkCandidates` (cli/agent-client.ts,
//      limit 10, `role === 'user'`) offered ten copies of one machine notice as
//      the whole walk-back list, and `findForkPivot` resolves duplicates by
//      occurrence-from-end, so picking one was a coin flip between 58 rows.
//
//  (b) `BackgroundJobRunner.recoverJob` re-wakes a job whose outcome is already
//      persisted and writes nothing back, so every cold activation announced it
//      again — with a fresh `crypto.randomUUID()` row id each time.
//
// Recovery is at-least-once BY DESIGN (recoverOrphans sweeps the registry on
// every activation; the only thing left to record is that the agent was told,
// and an activation that dies before recording it must still tell), so the fix
// is a write that cannot duplicate rather than a flag a second activation
// loses: the announcement's identity is the row's primary key.
import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { BackgroundJobRunner, backgroundJobWakeTrigger } from '../src/jobs/runner.js';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store.js';
import { SignalDelivery } from '../src/orchestrator/signals.js';
import { EventLog, initEventsHubTables } from '../src/events/hub/index.js';
import { getChatHistoryPage } from '../src/read-models/status.js';
import { PROGRAMMATIC_MESSAGE_ID_PREFIX, uiMessageText } from '../src/utils/ui-message.js';
import type { BackendHost } from '../src/types/backend-host.js';
import type { Schedule, SqlExecutor } from '../src/types/primitives.js';
import { createTestWorkspace, makeSql, makeExecRaw, makeSqlExec, SDK_SESSION_DDL } from './helpers.js';

const JOB = 'bgjob-y2vlvl1wbli9gan6sh78a';

/**
 * The durable chat store as the cloud backend actually reaches it: the agents
 * SDK's `assistant_messages` table, and `BackendHost.enqueueTurn`'s row
 * derivation (actor-agent.ts) on top of it.
 *
 * Both halves are copied deliberately rather than stubbed. `appendMessage`
 * returns early for an id already present (agents, AgentSessionProvider), which
 * is the mechanism a stable id relies on — a harness that appended
 * unconditionally would report the fix working when production would still
 * duplicate, and a harness that deduped on text would report it working for the
 * wrong reason.
 */
function chatStore(db: Database) {
  const sql = makeSql(db);
  makeExecRaw(db)(SDK_SESSION_DDL);
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async ({ text, metadata, idempotencyKey }) => {
      const id = `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${idempotencyKey ?? crypto.randomUUID()}`;
      const present = sql<{ id: string }>`SELECT id FROM assistant_messages WHERE id = ${id}`;
      if (present.length === 0) {
        void sql`
          INSERT INTO assistant_messages (id, session_id, role, content)
          VALUES (${id}, ${''}, ${'user'}, ${JSON.stringify({
            id, role: 'user', parts: [{ type: 'text', text }], metadata,
          })})
        `;
      }
      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  return { host, sql };
}

/** One activation over the given durable rows: fresh runner, fresh in-memory
 *  state, same database. This is the whole reason the defect could not be seen
 *  from inside one process. */
function activation(db: Database) {
  const sql = makeSql(db);
  const { host } = chatStore(db);
  const fiber: Schedule['fiber'] = async (_name, fn) => fn({ stash: () => {}, snapshot: null });
  const runner = new BackgroundJobRunner({
    store: new BackgroundJobStore(sql),
    fiber,
    signals: new SignalDelivery(host),
    eventLog: new EventLog(makeSqlExec(db)),
    scheduleDrain: () => {},
  });
  return { runner, sql };
}

/** The job as the eviction left it: settled in the registry, and still carrying
 *  a `running` row for the sweep to find — the exact state recoverOrphans is
 *  written for, and the state that produced the 58 rows. */
function evictedWorkspace() {
  const ws = createTestWorkspace();
  initBackgroundJobsTable(ws.execRaw, ws.sql);
  initEventsHubTables(makeSqlExec(ws.db));
  const store = new BackgroundJobStore(ws.sql);
  const now = Date.now();
  store.create({
    id: JOB, kind: 'agents', workMode: 'build', now,
    label: 'fork(settle=mcts): design the generation algorithm',
  });
  return { db: ws.db, store, now };
}

function noticeRows(sql: SqlExecutor) {
  return sql<{ id: string; content: string }>`
    SELECT id, content FROM assistant_messages ORDER BY rowid ASC`;
}

describe('a settled background job announces itself once, and not as the owner', () => {
  test('N cold activations over one settled job leave ONE conversation row', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, JSON.stringify({ strategy: 'mcts', score: 0 }), ws.now + 1_000);

    // Six activations — one more than MAX_RESUME_ATTEMPTS, so nothing here is
    // bounded by the resume cap; each is a fresh isolate sweeping the registry.
    for (let start = 0; start < 6; start++) {
      const { runner } = activation(ws.db);
      await runner.wake(JOB);
    }

    const rows = noticeRows(makeSql(ws.db));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${backgroundJobWakeTrigger(JOB)}`);
    expect(rows[0]!.content).toContain(`Background agents job ${JOB} completed`);
  });

  test('driving orphan recovery twice over the same rows still leaves ONE row', async () => {
    const ws = evictedWorkspace();
    // The outcome landed but the fiber died before the wake — the one case
    // recoverJob's blind re-wake exists to cover, and the one it multiplied.
    ws.store.fail(
      JOB, 0,
      'interrupted by Durable Object eviction before completion (gave up after 5 resume attempts)',
      ws.now + 1_000,
    );

    const first = activation(ws.db);
    await first.runner.recover({ jobId: JOB, phase: 'running' });
    const second = activation(ws.db);
    await second.runner.recover({ jobId: JOB, phase: 'running' });

    const rows = noticeRows(makeSql(ws.db));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('gave up after 5 resume attempts');
  });

  test('the notice is not offered as the owner\'s words: the transcript reports it as system', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const { runner } = activation(ws.db);
    await runner.wake(JOB);

    const history = getChatHistoryPage(makeSql(ws.db)).items;
    expect(history).toHaveLength(1);
    expect(history[0]!.role).toBe('system');
    // The stored row is untouched: the model still reads its turn input as the
    // user message it has to be. Only the claim about authorship changed.
    const stored = makeSql(ws.db)<{ role: string }>`SELECT role FROM assistant_messages`;
    expect(stored[0]!.role).toBe('user');
  });

  test('a walk-back list built from the transcript offers no machine notice', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const { runner, sql } = activation(ws.db);
    await runner.wake(JOB);
    // Something the owner really did type, before the notice.
    void sql`
      INSERT INTO assistant_messages (id, session_id, role, content)
      VALUES (${'typed-1'}, ${''}, ${'user'}, ${JSON.stringify({
        id: 'typed-1', role: 'user', parts: [{ type: 'text', text: 'find me a domain' }],
      })})
    `;

    // forkCandidates' predicate, which is `role === 'user'` and nothing else —
    // the reason the owner's picker showed ten copies of one notice.
    const pivots = getChatHistoryPage(makeSql(ws.db)).items
      .filter((row) => row.role === 'user')
      .map((row) => row.content);
    expect(pivots).toEqual(['find me a domain']);
  });

  test('NEGATIVE CONTROL: the same delivery without an announcement identity duplicates', async () => {
    const ws = evictedWorkspace();
    const { host } = chatStore(ws.db);
    const signals = new SignalDelivery(host);
    for (let start = 0; start < 6; start++) {
      await signals.deliver({ kind: 'background_job', text: `Background agents job ${JOB} completed.` });
    }
    // Six rows, byte-identical content, distinct ids — the shape measured on
    // stone-ash-71f2. Nothing about the seam prevents this; the producer naming
    // its fact is what does.
    const rows = noticeRows(makeSql(ws.db));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.id)).size).toBe(6);
    expect(new Set(rows.map((row) => uiMessageText(row.content))).size).toBe(1);
  });

  test('authorship covers every programmatic writer, keyed or not', async () => {
    // The `fork_interrupted` wake (heads/reconcile.ts) is the second background
    // writer, and it needs no announcement identity — `abandonRunning` settles
    // its rows first, so a second activation delivers nothing. It was still
    // stored as the owner's words, and one of them is sitting in the owner's
    // live transcript at 16:52:06 on stone-ash-71f2, four rows above things they
    // actually typed. Authorship is fixed at the seam, so an unkeyed turn is
    // covered by the same rule the keyed one is.
    const ws = evictedWorkspace();
    const { host } = chatStore(ws.db);
    await new SignalDelivery(host).deliver({
      kind: 'fork_interrupted',
      text: '23 head(s) across 6 fork run(s) were still marked running…',
    });

    const history = getChatHistoryPage(makeSql(ws.db)).items;
    expect(history.map((row) => row.role)).toEqual(['system']);
  });

  test('the wake and its durable retry breadcrumb name the same announcement', async () => {
    const ws = evictedWorkspace();
    ws.store.settle(JOB, 0, '"done"', ws.now + 1_000);
    const sql = makeSql(ws.db);
    // A host that pre-empts: the wake goes undelivered, so compensate publishes
    // the breadcrumb whose trigger_id must be the same identity the queued turn
    // would have used — one fact, one name, both rails.
    const preempting: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async () => ({ status: 'skipped' }),
      turnInFlight: () => false,
      setTimer: () => {},
    };
    const fiber: Schedule['fiber'] = async (_name, fn) => fn({ stash: () => {}, snapshot: null });
    const runner = new BackgroundJobRunner({
      store: new BackgroundJobStore(sql),
      fiber,
      signals: new SignalDelivery(preempting),
      eventLog: new EventLog(makeSqlExec(ws.db)),
      scheduleDrain: () => {},
    });
    await runner.wake(JOB);
    await runner.wake(JOB);

    const events = sql<{ payload: string }>`SELECT payload FROM agent_log WHERE kind = 'event'`;
    // The EventLog's own `timer:<trigger_id>:<scheduled_fire_at>` dedupe key
    // already made this rail exactly-once; the point here is that the id it
    // dedupes on is the SAME string the conversation row is keyed by.
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toContain(backgroundJobWakeTrigger(JOB));
  });
});
