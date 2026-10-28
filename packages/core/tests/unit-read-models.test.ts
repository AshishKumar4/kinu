import { exists, readText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Read models through public entry points over real storage, asserting the shapes surfaces
 *  consume. */

import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';

import { createMemoryVfs, seedTranscriptEntry, present, testActorHandle } from '@kinu.run/test-utils';
import {
  createTestActor, createTestRuntime, createWorkspaceBundle, makeExecRaw, makeSql, makeSqlExec,
} from './helpers';
import { workspaceSoul, writeWorkspaceSoul } from '../src/vfs/workspace-planes';
import { MOUNT_EXECUTORS, standardMounts, workspaceFilePlane } from '../src/vfs/mounts';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { createTestActors } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { JobOutputFeeds } from '../src/jobs/live-output';
import { REAL_CLOCK } from '../src/types/clock';
import { RunEventRecorder, initRunEventTables } from '../src/events/recorder';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { getRunTimeline } from '../src/read-models/timeline';
import { getRunEvents, getRunSummaries, listRuns } from '../src/read-models/runs';
import { chatSeed, getAgentStatus, getChatHistoryPage, getToolList, type ChatHistoryPage } from '../src/read-models/status';
import { RECORDED_AT_METADATA_KEY } from '../src/session/transcript';
import { keptMediaName } from '../src/session/chat-media';
import { SessionHistory } from '../src/session/history';
import { stampTurnAuthor } from '../src/types/turn-metadata';
import { readSessionTranscript, type SessionTranscriptReader } from '../src/session/transcript';
import { PLATFORM_LIMITS } from '../src/platform-limits';
import { CHAT_PAGE_BYTES, CHAT_SEED_ROWS, CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { PositionPageRequestSchema, type PositionCursor } from '../src/session/page';
import { getWorkspaceDiff, resetWorkspaceBaseline } from '../src/read-models/workspace-diff';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { getExecutorFiles, readExecutorFile, writeExecutorFileOp } from '../src/read-models/files';
import type { SqlExecutor } from '../src/types/primitives';
import {
  cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob,
  listBackgroundJobs, retryBackgroundJob, type BackgroundJobControl,
} from '../src/read-models/background-jobs';
import {
  getAlwaysActiveSkills, getEvolutionConfig, getShellApprovalMode,
  setAlwaysActiveSkills, setEvolutionConfig, setModel, setReasoningEffort, setShellApprovalMode,
} from '../src/read-models/config-plane';
import { getEvolutionChangelog, markChangelogSeen } from '../src/read-models/evolution-views';
import type { JsonValue } from '../src/utils/json';
import { claimFences } from '../src/orchestrator/actor-claims';
import { rowText } from '../src/utils/ui-message';

function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw, sql, exec, transactionSync: (write) => db.transaction(write)() });
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'read-model-test');
  const bundle = createWorkspaceBundle(db);

  return { db, sql, execRaw, actor, vfs: bundle.vfs, bundle, config: actor.config };
}

interface SeedRow { id: string; role: 'user' | 'assistant'; content: string }

function transcriptOf(n: number): SeedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`, role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `message ${i + 1}`,
  }));
}

function chatStore(w: { db: Database; sql: SqlExecutor; actor: ActorHandle; vfs: VFS }) {
  const history = new SessionHistory({
    sql: w.sql, actor: w.actor, transactionSync: (write) => w.db.transaction(write)(),
    files: async () => ({ vfs: w.vfs, artifactDirectory: '/home/main/.kinu/context' }),
    claims: claimFences(w.sql, w.actor),
  });

  return { history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** Appended in order, as a real turn writes. */
async function seedTranscript(history: SessionHistory, rows: readonly SeedRow[]): Promise<void> {
  for (const row of rows) {
    await seedTranscriptEntry(history, CHAT_SESSION_ID, {
      id: row.id, message: { role: row.role, content: row.content },
      origin: row.role === 'user' ? 'input' : 'output',
    });
  }
}

/** Every page, oldest first: the only way to observe pages join without overlap. */
async function walkTranscript(transcript: SessionTranscriptReader, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: PositionCursor | undefined;

  for (;;) {
    const page = await getChatHistoryPage(transcript, { limit, cursor }, keptMediaName);
    ids.unshift(...page.items.map((m) => m.id));

    if (page.status === 'end') return ids;
    cursor = page.next;
  }
}

/** Real job store plus a recording runner stand-in; the runner contract is these four calls. */
function jobPlane() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initBackgroundJobsTable(execRaw);
  const jobs = new BackgroundJobStore(sql, createTestActors(sql, execRaw).main);
  const detached: Array<{ jobId: string; kind: string }> = [];
  let created = 0;

  const runner: BackgroundJobControl = {
    output: new JobOutputFeeds({ clock: REAL_CLOCK, send: () => {} }),
    cancel: () => Promise.resolve(true),
    createRetry: ({ sourceId, kind, input, mode }) => {
      const id = `retry-${++created}`;

      return jobs.createRetry({
        sourceId, id, kind, workMode: mode, input: JSON.stringify(input), now: Date.now(),
      }) ? id : null;
    },
    detach: (jobId, kind) => { detached.push({ jobId, kind }); },
  };

  return { db, sql, jobs, runner, detached };
}

describe('run reads', () => {
  function eventLog(): RunEventRecorder {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    const sql = makeSql(db);

    return new RunEventRecorder(sql, testActorHandle(sql));
  }

  test('summaries fold provenance and cost out of the event log', () => {
    const events = eventLog();

    events.emit('r1', { type: 'run_start', agentId: 'a1', caused_by: 'timer', userMessage: 'do the thing' });
    events.emit('r1', { type: 'turn_end', turnIndex: 0, usage: { input: 10, output: 4, cacheRead: 2 } });
    events.emit('r1', { type: 'turn_end', turnIndex: 1, usage: { input: 5, output: 1 } });
    events.emit('r1', { type: 'run_end', reason: 'completed' });

    const [summary] = getRunSummaries(events).items;
    expect(summary).toMatchObject({
      runId: 'r1', causedBy: 'timer', userMessage: 'do the thing', status: 'completed',
      eventCount: 4, turnsWithoutUsage: 0,
    });
    // Fields neither turn reported stay absent instead of appearing as 0.
    expect(summary?.usage).toEqual({ input: 15, output: 5, cacheRead: 2 });
  });

  test('a run longer than one read window still folds whole', () => {
    const events = eventLog();

    events.emit('big', { type: 'run_start', agentId: 'a1', caused_by: 'chat' });

    for (let i = 0; i < 1100; i++) {
      events.emit('big', { type: 'turn_end', turnIndex: i, usage: { input: 1 } });
    }

    events.emit('big', { type: 'run_end', reason: 'completed' });

    // Folding one window would miss the `run_end`, so usage reads short and status null.
    const [summary] = getRunSummaries(events).items;
    expect(summary?.usage).toEqual({ input: 1100 });
    expect(summary).toMatchObject({ status: 'completed', eventCount: 1102 });
  });

  test('a run whose turns reported nothing is not a run that cost nothing', () => {
    const events = eventLog();
    events.emit('silent', { type: 'run_start', agentId: 'a1', caused_by: 'chat' });
    events.emit('silent', { type: 'turn_end', turnIndex: 0 });
    events.emit('silent', { type: 'turn_end', turnIndex: 1 });
    events.emit('zeroed', { type: 'run_start', agentId: 'a1', caused_by: 'chat' });
    events.emit('zeroed', { type: 'turn_end', turnIndex: 0, usage: { input: 0, output: 0 } });

    const { items } = getRunSummaries(events);
    const silent = items.find((s) => s.runId === 'silent');
    const zeroed = items.find((s) => s.runId === 'zeroed');

    // The provider said nothing; the silent-turn count is the denominator that says so.
    expect(silent?.usage).toEqual({});
    expect(silent?.turnsWithoutUsage).toBe(2);

    // A reported zero is a report, distinct from the silence above.
    expect(zeroed?.usage).toEqual({ input: 0, output: 0 });
    expect(zeroed?.turnsWithoutUsage).toBe(0);
  });

  test('a run with no run_start still reports as a run, caused by nothing', () => {
    const events = eventLog();
    events.emit('r2', { type: 'error', message: 'boom' });

    expect(getRunSummaries(events).items[0]).toMatchObject({
      runId: 'r2', causedBy: null, usage: {}, turnsWithoutUsage: 0,
    });
    expect(listRuns(events).items.map((r) => r.runId)).toEqual(['r2']);
    expect(getRunEvents(events, 'r2')).toHaveLength(1);
  });

  test('a workspace with no run_events fails the read instead of reporting no history', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const events = new RunEventRecorder(sql, testActorHandle(sql));
    expect(() => listRuns(events)).toThrow(/no such table: run_events/);
    expect(() => getRunEvents(events, 'nope')).toThrow(/no such table: run_events/);
    expect(() => getRunSummaries(events)).toThrow(/no such table: run_events/);
    db.close();
  });
});

describe('run timeline', () => {
  test('merges every source into one list ordered by time', () => {
    const { db, sql, execRaw, actor } = workspace();
    initRunEventTables(execRaw);
    // Event log and job registry are each actor-private, so both bind the one actor.
    const events = new RunEventRecorder(sql, actor);
    const jobs = new BackgroundJobStore(sql, actor);

    events.emit('r1', { type: 'run_start', agentId: 'a1', caused_by: 'chat' });
    const base = Date.now() + 1000;
    void sql`INSERT INTO evolution_events (actor_id, id, type, message, data, created_at)
      VALUES (${actor.actorId}, 'e1', 'scaffold_proposed', 'v2 proposed', '{"version":2}', ${base})`;
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, depth, visits, value, status, action, task, created_at)
      VALUES (${actor.actorId}, 'n1', NULL, 'n1', 0, 1, 0.5, 'terminal', 'explore A', 't', ${base + 1000})`;
    jobs.create({ id: 'j1', kind: 'shell', workMode: 'build', now: base + 2000 });

    const spans = getRunTimeline({ sql, actor, events, jobs, currentRunId: 'r1' });

    expect(spans.map((s) => s.source)).toEqual(['shell', 'evolution', 'swarm', 'background']);

    for (const [index, span] of spans.entries()) expect(span.ts).toBeGreaterThanOrEqual(spans[index - 1]?.ts ?? -Infinity);

    // text_delta is the stream's own noise — never a span.
    expect(spans.some((s) => s.rawType === 'text_delta')).toBe(false);
    expect(spans[1]).toMatchObject({ kind: 'scaffold', label: 'v2 proposed', data: { version: 2 } });
    expect(spans[3]).toMatchObject({ kind: 'background' });
    db.close();
  });

  test('the limit bounds the newest end of the merged list', () => {
    const { sql, execRaw, actor } = workspace();
    initRunEventTables(execRaw);
    const events = new RunEventRecorder(sql, actor);

    for (let i = 0; i < 5; i++) {
      void sql`INSERT INTO evolution_events (actor_id, id, type, message, created_at)
        VALUES (${actor.actorId}, ${`e${i}`}, 'reflection', ${`m${i}`}, ${i * 100})`;
    }

    const spans = getRunTimeline(
      { sql, actor, events, jobs: new BackgroundJobStore(sql, actor), currentRunId: null },
      { limit: 2 },
    );

    expect(spans.map((s) => s.label)).toEqual(['m3', 'm4']);
  });

  test('an idle workspace answers empty; one missing the tables fails the read', () => {
    const { db, sql, actor } = workspace();
    expect(getRunTimeline({
      sql, actor, events: new RunEventRecorder(sql, actor),
      jobs: new BackgroundJobStore(sql, actor), currentRunId: 'r1',
    })).toEqual([]);
    db.close();

    const bare = new Database(':memory:');
    const bareSql = makeSql(bare);
    const bareActor = createTestActors(bareSql, makeExecRaw(bare)).main;
    expect(() => getRunTimeline({
      sql: bareSql, actor: bareActor, events: new RunEventRecorder(bareSql, bareActor),
      jobs: new BackgroundJobStore(bareSql, bareActor), currentRunId: 'r1',
    })).toThrow(/no such table/);
    bare.close();
  });
});

describe('agent status', () => {
  test('identity, counts and the model the next turn runs, in one shape', async () => {
    const w = workspace();
    const { db, sql, actor, vfs, bundle } = w;
    void sql`UPDATE workspace_identity SET name = 'jarvis', created_at = 42`;
    await seedTranscript(chatStore(w).history, [{ id: 'm1', role: 'user', content: 'hi' }]);

    // SOUL.md as its agents left it answers the soul and mission: the owner's, then the main agent's edit.
    await writeWorkspaceSoul(bundle, '# Mine\n\n## Mission\n\nread the room');
    await writeText(vfs, 'SOUL.md', '# Mine\n\n## Mission\n\nread the room and update it');

    expect(await getAgentStatus({
      sql, soul: () => workspaceSoul(bundle), actor, model: 'anthropic/claude-opus-5', reasoningEffort: 'high', name: 'fallback-name',
      displayName: 'Jarvis', layout: 'focus',
    })).toMatchObject({
      name: 'jarvis', displayName: 'Jarvis', createdAt: 42, model: 'anthropic/claude-opus-5', layout: 'focus',
      messageCount: 1, scaffoldVersion: 0, reasoningEffort: 'high', forkLineage: null,
      soul: '# Mine\n\n## Mission\n\nread the room and update it', purpose: 'read the room and update it',
    });
    db.close();
  });

  test('the scaffold version is the one the actor runs: not a pending proposal, not a rolled-back one', async () => {
    const { db, sql, actor } = workspace();
    const shown = async () => (await getAgentStatus({ sql, soul: async () => null, actor, model: '', reasoningEffort: null, name: 'jarvis', displayName: 'Jarvis', layout: 'workbench' })).scaffoldVersion;

    const version = (n: number, status: string) => {
      void sql`INSERT OR REPLACE INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (${actor.actorId}, ${n}, ${n}, ${'test'}, ${status})`;
    };

    version(0, 'rolled_back');
    version(1, 'current');
    version(2, 'pending');
    expect(await shown()).toBe(1);

    version(0, 'current');
    version(1, 'rolled_back');
    expect(await shown()).toBe(0);
    db.close();
  });

  test('a workspace with no tables fails the read instead of inventing an identity', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const other = workspace();
    await expect(getAgentStatus({
      sql, soul: async () => null,
      actor: other.actor, model: '', reasoningEffort: null, name: 'agent-7',
      displayName: 'ignored', layout: 'workbench',
    })).rejects.toThrow(/no such table/);
  });

  test('chat history flattens multi-part content and drops non-chat roles', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscriptEntry(history, CHAT_SESSION_ID, {
      id: 'a', origin: 'input',
      message: { role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
    });
    await seedTranscriptEntry(history, CHAT_SESSION_ID, {
      id: 'b', origin: 'output',
      message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'text', value: 'not a chat role' } }] },
    });

    const recorded = transcript.read('a');

    if (recorded === null) throw new Error('the seeded user entry must be in the transcript');
    expect(await getChatHistoryPage(transcript, {}, keptMediaName)).toEqual({
      status: 'end',
      items: [{ id: 'a', position: 0, role: 'user', turnId: recorded.turnId, runId: recorded.runId, parts: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }], createdAt: recorded.recordedAt, metadata: { [RECORDED_AT_METADATA_KEY]: recorded.recordedAt } }],
    });
    w.db.close();
  });

  test('a harness row walks back with the markers its card is drawn from', async () => {
    // A `fork_interrupted` notice: the chat draws the card from `kinuEvent`, so the marker must survive.
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const id = 'f8798675-5e9a-4d13-aac2-293f4557f1c1';

    const message = await history.admitInput({
      id, turnId: id, message: { role: 'user', content: '9 head(s) across 1 fork run(s)…' },
      assertOwner: () => { w.actor.assertCurrent(); },
    });

    transcript.appendUser(await transcript.prepareUser({
      id, turnId: id, message, metadata: stampTurnAuthor({ kinuEvent: 'fork_interrupted', heads: 9 }),
    }));

    const recorded = transcript.read(id);

    if (recorded === null) throw new Error('the harness notice must be in the transcript');
    expect((await getChatHistoryPage(transcript, {}, keptMediaName)).items).toEqual([{
      id, position: 0, role: 'system', turnId: id, runId: recorded.runId,
      parts: [{ type: 'text', text: '9 head(s) across 1 fork run(s)…' }], createdAt: recorded.recordedAt,
      metadata: { kinuEvent: 'fork_interrupted', heads: 9, kinuAuthor: 'harness', [RECORDED_AT_METADATA_KEY]: recorded.recordedAt },
    }]);
    w.db.close();
  });

  test('a retained full assignment exposes the exact run already stored on its conversation row', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const id = 'assignment';
    const runId = 'run-assignment';
    const content = `${'Read every row. '.repeat(50)}Write the report to the assigned file.`;
    const message = await history.admitInput({ id, turnId: id, message: { role: 'user', content }, assertOwner: () => { w.actor.assertCurrent(); } });

    transcript.appendUser(await transcript.prepareUser({ id, turnId: id, runId, message }));

    expect((await getChatHistoryPage(transcript, {}, keptMediaName)).items.map((item) => ({ runId: item.runId, content: rowText(item) }))).toEqual([{ runId, content }]);
    w.db.close();
  });

  // Owner 2026-09-28: a scrollbar drag lands on any position and reads it in one round trip, and the rows above
  // the oldest one read are exactly its position.
  test('a page carries each entry\'s position, and a cursor naming a position reads that stretch directly', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(10));

    const newest = await getChatHistoryPage(transcript, { limit: 3 }, keptMediaName);

    expect(newest).toMatchObject({ status: 'more', next: { before: 7 } });
    expect(newest.items.map((m) => [m.id, m.position])).toEqual([['m8', 7], ['m9', 8], ['m10', 9]]);

    const top = await getChatHistoryPage(transcript, { limit: 3, cursor: { before: 3 } }, keptMediaName);

    expect(top.status).toBe('end');
    expect(top.items.map((m) => [m.id, m.position])).toEqual([['m1', 0], ['m2', 1], ['m3', 2]]);
    expect((await getChatHistoryPage(transcript, { limit: 2, cursor: { before: 6 } }, keptMediaName)).items.map((m) => m.position)).toEqual([4, 5]);
    w.db.close();
  });

  // 2026-09-28: cursors became positions; an id cursor dropped silently would re-read the newest page forever.
  test('a page request naming an id cursor is refused, not read as no cursor', () => {
    expect(v.safeParse(PositionPageRequestSchema, { limit: 2, cursor: { after: 'm3' } }).success).toBe(false);
    expect(v.safeParse(PositionPageRequestSchema, { limit: 2, after: 'm3' }).success).toBe(false);
    expect(v.parse(PositionPageRequestSchema, { limit: 2, cursor: { before: 3 } })).toEqual({ limit: 2, cursor: { before: 3 } });
  });

  /** A bare `LIMIT` cannot tell truncated from complete; an exactly-consumed page is the case the
     *  limit+1 probe exists for. */
  test('a short page is exhaustion, a full page is not, and an exactly-full page is', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(4));

    expect((await getChatHistoryPage(transcript, { limit: 9 }, keptMediaName)).status).toBe('end');
    expect(await getChatHistoryPage(transcript, { limit: 2 }, keptMediaName)).toMatchObject({ status: 'more', next: { before: 2 } });
    expect((await getChatHistoryPage(transcript, { limit: 4 }, keptMediaName)).status).toBe('end');
    w.db.close();
  });

  /** A message arriving between page fetches must neither duplicate nor skip rows: the keyset-cursor
     *  property no offset can satisfy. */
  test('a message arriving mid-pagination causes neither a duplicate nor a gap', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(10));

    const first = await getChatHistoryPage(transcript, { limit: 4 }, keptMediaName);
    expect(first).toMatchObject({ status: 'more' });

    if (first.status !== 'more') throw new Error('unreachable');
    expect(first.items.map((m) => m.id)).toEqual(['m7', 'm8', 'm9', 'm10']);

    await seedTranscript(history, [{ id: 'm11', role: 'assistant', content: 'live arrival' }]);

    const second = await getChatHistoryPage(transcript, { limit: 4, cursor: first.next }, keptMediaName);
    expect(second.items.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);

    // No duplicate, no gap (m6 directly before m7), and the newer arrival never leaks in.
    expect(second.items.map((m) => m.id)).not.toContain('m11');

    const walked = await walkTranscript(transcript, 4);
    expect(walked).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
    expect(new Set(walked).size).toBe(walked.length);
    w.db.close();
  });

  /** Rows share one `recorded_at`, so only a keyset on id has a boundary to seek on. */
  test('messages sharing one recorded instant still page without loss', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(6));
    void w.sql`UPDATE conversation_entries SET recorded_at = ${1_772_000_000_000}
      WHERE actor_id = ${w.actor.actorId} AND session_id = ${CHAT_SESSION_ID}`;

    expect(await walkTranscript(transcript, 2)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    w.db.close();
  });

  /** A dismissed actor's pane has no file plane: spilled entries say unavailable, the page reads whole. */
  test('a reader with no file plane pages a spilled entry as unavailable, in its place', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const spilled = 'x'.repeat(PLATFORM_LIMITS['do.sqlite.row_bytes'].value);

    await seedTranscript(history, [
      { id: 'm1', role: 'user', content: 'before' },
      { id: 'm2', role: 'assistant', content: spilled },
      { id: 'm3', role: 'user', content: 'after' },
    ]);

    // Walked to the start: a page ends before an entry that would take it past its bytes.
    const shown = async (reader: SessionTranscriptReader) => {
      const rows: ChatHistoryPage['items'][number][] = [];

      for (let page = await getChatHistoryPage(reader, {}, keptMediaName); ; page = await getChatHistoryPage(reader, { cursor: page.next }, keptMediaName)) {
        rows.unshift(...page.items);

        if (page.status === 'end') return rows.map((row) => ({ id: row.id, content: rowText(row).length, unavailable: row.unavailable }));
      }
    };

    expect(await shown(transcript)).toEqual([
      { id: 'm1', content: 6, unavailable: undefined },
      { id: 'm2', content: spilled.length, unavailable: undefined },
      { id: 'm3', content: 5, unavailable: undefined },
    ]);
    expect(await shown(readSessionTranscript(w.sql, w.actor, CHAT_SESSION_ID, null))).toEqual([
      { id: 'm1', content: 6, unavailable: undefined },
      { id: 'm2', content: 0, unavailable: true },
      { id: 'm3', content: 5, unavailable: undefined },
    ]);
    w.db.close();
  });

  test('the tool list carries each crafted tool with its preference and choices', async () => {
    const { rt, db } = createTestRuntime();
    const sql = makeSql(db);
    // This UPDATE stands in for a real usage history on the crafted_tools row.
    await rt.craftStore.create({
      name: 'summarize', description: 'sum', code: 'x',
    });
    void sql`UPDATE crafted_tools SET offered = 8, chosen = 7, rated = 3, rating_sum = 2.4 WHERE name = 'summarize'`;

    expect(getToolList(sql).crafted).toEqual([
      { name: 'summarize', description: 'sum', qualityScore: (8 / 10) * (3.6 / 5), usageCount: 7 },
    ]);
    // A tool nothing has offered reads as the smoothing's prior, never as zero.
    void sql`UPDATE crafted_tools SET offered = 0, chosen = 0, rated = 0, rating_sum = 0 WHERE name = 'summarize'`;
    expect(getToolList(sql).crafted[0]).toMatchObject({ qualityScore: 0.3, usageCount: 0 });
    db.close();
  });
});

describe('workspace change-set', () => {
  test('work completed before the first read remains visible against the birth baseline', async () => {
    const { rt, db, workspace: bundle } = createTestRuntime();
    // The runtime writes its scaffold on its first file call, before the birth review.
    await exists(rt.storage.vfs, 'scaffold/agent.js');
    const baselines = { store: (await bundle.session()).vfs, cred: CRED_SESSION_USER };
    await resetWorkspaceBaseline(rt, baselines);
    await writeText(rt.storage.vfs, 'notes.md', 'one\n');

    const first = await getWorkspaceDiff(rt, baselines);
    expect(first.files.map((f) => [f.path, f.status, f.added])).toEqual([['notes.md', 'added', 2]]);

    expect(await resetWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true });
    await writeText(rt.storage.vfs, 'notes.md', 'one\ntwo\n');
    const after = await getWorkspaceDiff(rt, baselines);
    expect(after.files.map((f) => [f.path, f.status, f.added])).toEqual([['notes.md', 'changed', 1]]);

    expect(await resetWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true });
    expect((await getWorkspaceDiff(rt, baselines)).files).toEqual([]);
    db.close();
  });
});

describe('executor file plane', () => {
  /** A machine's own file plane, empty, which records each call: a call to a computer starts it. */
  function machinePlane(machine: string, asked: string[]): VFS {
    const { vfs } = createMemoryVfs();

    const heard = async <T>(op: string, path: string, call: () => T | Promise<T>): Promise<T> => {
      asked.push(`${machine}.${op} ${path}`);

      return await call();
    };

    return {
      readFile: async (path) => heard('readFile', path, () => vfs.readFile(path)),
      writeFile: async (path, data) => heard('writeFile', path, () => vfs.writeFile(path, data)),
      readdir: async (path) => heard('readdir', path, () => vfs.readdir(path)),
      stat: async (path, options) => heard('stat', path, () => vfs.stat(path, options)),
      unlink: async (path) => heard('unlink', path, () => vfs.unlink(path)),
      mkdir: async (path, options) => heard('mkdir', path, () => vfs.mkdir(path, options)),
    };
  }

  /** Includes where the executor starts, which only the environment knows. */
  function router(files?: VFS) {
    const provider = files === undefined
      ? { homeDir: async () => '/home/main' }
      : { homeDir: async () => '/home/main', files };

    return { getProvider: (name: string) => (name === 'workspace' ? provider : undefined) };
  }

  test('workspace listings are typed, sized and directories-first', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.mkdir('/home/main/proj/sub', { recursive: true });
    await writeText(rt.storage.vfs, '/home/main/proj/a.txt', 'aa');

    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/home/main/proj');
    expect(listed.entries?.map((e) => [e.name, e.type])).toEqual([['sub', 'dir'], ['a.txt', 'file']]);
    expect(listed.entries?.find((e) => e.name === 'a.txt')?.size).toBe(2);
    db.close();
  });

  test('an empty path lists where the environment itself says it starts', async () => {
    const { rt, db } = createTestRuntime();
    await writeText(rt.storage.vfs, '/home/main/notes.md', 'me');

    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '');
    expect(listed.path).toBe('/home/main');
    expect(listed.entries?.map((e) => e.name)).toContain('notes.md');
    db.close();
  });

  test('the directories the platform manages are not listed beside the work', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.mkdir('/home/main/proj/.nimbus/runtimes', { recursive: true });
    await rt.storage.vfs.mkdir('/home/main/proj/.kinu/tool-output', { recursive: true });
    await writeText(rt.storage.vfs, '/home/main/proj/hello.py', 'print(42)\n');

    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/home/main/proj');
    expect(listed.entries?.map((e) => e.name)).toEqual(['hello.py']);
    db.close();
  });

  test('the listed directory comes back absolute and resolved, so the caller can walk up', async () => {
    const { rt, db } = createTestRuntime();
    await writeText(rt.storage.vfs, '/home/main/notes.md', 'me');

    // `..` from the agent's home is /home, not the filesystem root: the home sits in it.
    const up = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/home/main/..');
    expect(up.path).toBe('/home');
    expect(up.entries?.map((e) => e.name)).toContain('main');
    db.close();
  });

  test("the root lists each machine's mount point as a directory without asking that machine, which would start it", async () => {
    const db = new Database(':memory:');
    const asked: string[] = [];
    const machines = new Map(Object.values(MOUNT_EXECUTORS).map((machine) => [machine, { isAvailable: () => true, files: machinePlane(machine, asked) }]));
    const { files } = workspaceFilePlane(createWorkspaceBundle(db), { mounts: standardMounts((name) => machines.get(name)), principal: {}, home: WORKSPACE_ROOT });

    const listed = await getExecutorFiles(router(files), 'workspace', '/');

    expect(asked).toEqual([]);
    expect(listed.entries).toEqual(expect.arrayContaining(Object.keys(MOUNT_EXECUTORS).map((mount) => ({ name: mount.slice(1), type: 'dir' }))));
    db.close();
  });

  test("hidden items, as on a desktop: a machine's own directories at a root and dotfiles anywhere, shown and marked when asked", async () => {
    const db = new Database(':memory:');
    const machines = new Map(Object.values(MOUNT_EXECUTORS).map((machine) => [machine, { isAvailable: () => true, files: machinePlane(machine, []) }]));
    const { files } = workspaceFilePlane(createWorkspaceBundle(db), { mounts: standardMounts((name) => machines.get(name)), principal: {}, home: WORKSPACE_ROOT });
    await files.mkdir('/home/main/proj/tmp', { recursive: true });
    await files.writeFile('/home/main/proj/.env', new TextEncoder().encode('KEY=1'));
    const names = (page: { entries?: readonly { name: string }[] }) => page.entries?.map((entry) => entry.name).sort();

    const root = await getExecutorFiles(router(files), 'workspace', '/');
    const shown = await getExecutorFiles(router(files), 'workspace', '/', { hidden: true });
    const project = await getExecutorFiles(router(files), 'workspace', '/home/main/proj');
    const projectShown = await getExecutorFiles(router(files), 'workspace', '/home/main/proj', { hidden: true });

    // The namespace's `/` holds the machine's own (`usr`, `tmp`, `proc`…) beside the workspace's places, the shared
    // `scratch` among them.
    expect(names(root)).toEqual(['computer', 'home', 'pc', 'scratch', 'slates', 'uploads']);
    expect(shown.entries?.filter((entry) => entry.hidden === true).map((entry) => entry.name)).toEqual(expect.arrayContaining(['usr', 'tmp', 'etc']));
    expect(shown.entries?.filter((entry) => entry.hidden !== true).map((entry) => entry.name).sort()).toEqual(['computer', 'home', 'pc', 'scratch', 'slates', 'uploads']);
    // Below a root a project's `tmp` is its own; its dotfile waits to be asked for.
    expect(names(project)).toEqual(['tmp']);
    expect(projectShown.entries?.find((entry) => entry.name === '.env')).toEqual(expect.objectContaining({ hidden: true }));
    db.close();
  });

  test('an environment with no file plane is an error value, not a throw', async () => {
    const { rt, db } = createTestRuntime();
    // Unknown id and a device with no filesystem yet both read as a rendered reason.
    expect(await getExecutorFiles(router(rt.storage.vfs), 'ghost', ''))
      .toMatchObject({ error: expect.any(String) });
    expect(await getExecutorFiles(router(), 'workspace', ''))
      .toMatchObject({ error: expect.any(String) });
    expect(await readExecutorFile(router(rt.storage.vfs), 'workspace', '')).toMatchObject({ error: expect.any(String) });
    db.close();
  });

  test('reading refuses binaries and directories, and reports truncation', async () => {
    const { rt, db } = createTestRuntime();
    const r = router(rt.storage.vfs);
    await rt.storage.vfs.mkdir('dir', { recursive: true });
    await writeText(rt.storage.vfs, 'bin', `x\u0000y`);
    await writeText(rt.storage.vfs, 'big', 'z'.repeat(512 * 1024 + 10));

    expect(await readExecutorFile(r, 'workspace', 'dir')).toMatchObject({ error: expect.any(String) });
    expect(await readExecutorFile(r, 'workspace', 'bin')).toMatchObject({ error: expect.any(String) });
    // A plane without ranged read (seven base VFS methods) refuses an over-budget preview and names
    // the download.
    const refused = await readExecutorFile(r, 'workspace', 'big');
    expect(refused.content).toBeUndefined();
    expect(refused.error).toBeTypeOf('string');

    // A plane that can serve a prefix previews and truncates.
    const ranged = {
      getProvider: (name: string) => (name === 'workspace' ? {
        homeDir: async () => '/home/main',
        files: {
          ...rt.storage.vfs,
          readRange: async (path: string, offset: number, length: number) => {
            const whole = await readText(rt.storage.vfs, path);
            const bytes = new TextEncoder().encode(whole);

            return bytes.subarray(offset, offset + length);
          },
        },
      } : undefined),
    };

    const big = await readExecutorFile(ranged, 'workspace', 'big');
    expect(big.truncated).toBe(true);
    expect(big.content).toHaveLength(512 * 1024);
    db.close();
  });

  test("a write round-trips through the same environment's own paths", async () => {
    const { rt, db } = createTestRuntime();
    const r = router(rt.storage.vfs);
    expect(await writeExecutorFileOp(r, 'workspace', 'up.txt', { bytes: new TextEncoder().encode('hi') }))
      .toMatchObject({ ok: true });
    // The workspace store checks revisions, so the read carries the edit token its save names.
    expect(await readExecutorFile(r, 'workspace', 'up.txt')).toEqual({ content: 'hi', revision: expect.anything() });
    expect(await writeExecutorFileOp(r, 'workspace', 'dir/', { bytes: new Uint8Array() }))
      .toMatchObject({ error: expect.any(String) });
    db.close();
  });
});

describe('background-job control plane', () => {
  test('a settled job retries through its stored input on the raw surface', async () => {
    const { db, jobs, runner, detached } = jobPlane();
    const seen: JsonValue[] = [];

    const tools: ToolSet = {
      search: tool({
        inputSchema: jsonSchema<JsonValue>({}),
        execute: async (input) => {
          seen.push(input);

          return 'done';
        },
      }),
    };

    jobs.create({ id: 'j1', kind: 'search', workMode: 'build', input: JSON.stringify({ q: 'kinu' }), now: 1 });
    jobs.settle('j1', 0, 'old result', 2);

    const retry = await retryBackgroundJob({
      jobs, jobRunner: runner, rawTools: async () => tools, logActivity: () => undefined,
    }, 'j1');

    expect(retry.ok).toBe(true);
    expect(retry.jobId).not.toBe('j1');
    expect(seen).toEqual([{ q: 'kinu' }]);
    expect(detached).toEqual([{ jobId: present(retry.jobId, 'the retried job id'), kind: 'search' }]);
    db.close();
  });

  test('retry states the reason it cannot run rather than failing silently', async () => {
    const { db, jobs, runner } = jobPlane();
    const deps = { jobs, jobRunner: runner, rawTools: async (): Promise<ToolSet> => ({}), logActivity: () => undefined };

    expect(await retryBackgroundJob(deps, 'missing')).toMatchObject({ ok: false, error: expect.any(String) });

    jobs.create({ id: 'running', kind: 'shell', workMode: 'build', input: '{}', now: 1 });
    expect(await retryBackgroundJob(deps, 'running')).toMatchObject({ ok: false, error: expect.any(String) });

    jobs.create({ id: 'noinput', kind: 'shell', workMode: 'build', now: 1 });
    jobs.settle('noinput', 0, 'r', 2);
    expect(await retryBackgroundJob(deps, 'noinput')).toMatchObject({ ok: false, error: expect.any(String) });

    jobs.create({ id: 'gone', kind: 'vanished', workMode: 'build', input: '{}', now: 1 });
    jobs.settle('gone', 0, 'r', 2);
    expect(await retryBackgroundJob(deps, 'gone')).toMatchObject({ ok: false, error: expect.any(String) });
    db.close();
  });

  test('cancelling current work aborts foreground tools and announces the outcome', async () => {
    const { db } = jobPlane();
    const live = new AbortController();
    const already = new AbortController();
    already.abort();
    const broadcasts: string[] = [];
    const order: string[] = [];

    const outcome = await cancelCurrentWork({
      activeToolControllers: new Set([live, already]),
      broadcast: (payload) => { order.push('broadcast'); broadcasts.push(payload); },
      onCancelled: () => order.push('settled'),
    });

    expect(outcome).toEqual({ ok: true, abortedTools: 1, deviceCommands: [] });
    expect(live.signal.aborted).toBe(true);
    // The backend settles its own turn state BEFORE clients hear about it.
    expect(order).toEqual(['settled', 'broadcast']);
    expect(JSON.parse(broadcasts[0])).toMatchObject({ type: 'work_cancelled', abortedTools: 1 });
    db.close();
  });

  test('the framework turn is aborted FIRST, so the model request stops even when the client cancel frame is lost', async () => {
    const { db } = jobPlane();
    const order: string[] = [];

    const outcome = await cancelCurrentWork({
      cancelChats: () => { order.push('cancelChats'); },
      activeToolControllers: new Set(),
      broadcast: () => order.push('broadcast'),
      onCancelled: () => order.push('settled'),
    });

    expect(outcome).toEqual({ ok: true, abortedTools: 0, deviceCommands: [] });
    // Queued steers are not part of the outcome; they run as the next turn.
    expect(order).toEqual(['cancelChats', 'settled', 'broadcast']);
    db.close();
  });

  test('a workspace with no background_jobs fails the read instead of reporting no work', () => {
    const db = new Database(':memory:');
    const bareSql = makeSql(db);
    const jobs = new BackgroundJobStore(bareSql, createTestActors(bareSql, makeExecRaw(db)).main);
    expect(() => listBackgroundJobs(jobs)).toThrow(/no such table: background_jobs/);
    expect(() => jobs.get('j1')).toThrow(/no such table: background_jobs/);
    expect(dismissBackgroundJob(jobs, 'j1')).toEqual({
      ok: false,
      error: expect.stringContaining('no such table: background_jobs'),
    });
    expect(clearBackgroundJobs(jobs)).toEqual({
      ok: false,
      error: expect.stringContaining('no such table: background_jobs'),
    });
    db.close();
  });
});

describe('config plane', () => {
  test('a model change is validated, stored, and invalidates what it bound', () => {
    const { db, config } = workspace();
    let invalidations = 0;

    const deps = {
      config,
      normalize: (spec: string) => {
        if (!spec.includes('/')) throw new Error(`unknown provider: ${spec}`);

        return spec.toLowerCase();
      },
      onChanged: () => { invalidations++; },
    };

    expect(setModel(deps, 'OpenAI/GPT-5.1')).toEqual({ ok: true, spec: 'openai/gpt-5.1' });
    expect(config.getModel()).toBe('openai/gpt-5.1');
    expect(invalidations).toBe(1);

    // The provider's own message reaches the caller unwrapped.
    expect(() => setModel(deps, 'nonsense')).toThrow('unknown provider: nonsense');
    // A rejected spec neither stores nor invalidates.
    expect(config.getModel()).toBe('openai/gpt-5.1');
    expect(invalidations).toBe(1);
    db.close();
  });

  test('setters reject values off their domain', () => {
    const { db, config } = workspace();
    expect(() => setReasoningEffort(config, 'extreme')).toThrow(Error);
    expect(() => setShellApprovalMode({ config, onChanged: () => undefined }, 'yolo')).toThrow(Error);
    expect(() => setAlwaysActiveSkills(config, 'debugging')).toThrow(Error);
    expect(() => setAlwaysActiveSkills(config, ['ok', 7])).toThrow(Error);
    db.close();
  });

  test('shell approval and pinned skills round-trip through storage', () => {
    const { db, config } = workspace();
    let rebuilt = 0;
    expect(setShellApprovalMode({ config, onChanged: () => { rebuilt++; } }, 'allow_all'))
      .toEqual({ ok: true, mode: 'allow_all' });
    expect(getShellApprovalMode(config)).toEqual({ mode: 'allow_all' });
    expect(rebuilt).toBe(1);

    expect(setAlwaysActiveSkills(config, ['review', 'debugging'])).toEqual({ ok: true, names: ['review', 'debugging'] });
    expect(getAlwaysActiveSkills(config)).toEqual({ names: ['review', 'debugging'] });
    expect(setAlwaysActiveSkills(config, [])).toEqual({ ok: true, names: [] });
    db.close();
  });

  test('an evolution write answers with the EFFECTIVE config; learning is on until turned off', () => {
    const { db, config } = workspace();
    expect(getEvolutionConfig(config).learning).toBe(true);
    const effective = setEvolutionConfig(config, { learning: false });
    expect(effective.learning).toBe(false);
    expect(getEvolutionConfig(config).learning).toBe(false);
    db.close();
  });
});

describe('changelog view', () => {
  test('unseen counts against the stored watermark, and marking seen zeroes it', () => {
    const { db, sql, actor, config } = workspace();
    void sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${actor.actorId}, 1, ${Date.now()}, 'an earlier way of working', 'historical')`;

    expect(getEvolutionChangelog(sql, actor).entries).toHaveLength(1);
    expect(getEvolutionChangelog(sql, actor).unseenCount).toBe(1);
    const { seenAt } = markChangelogSeen(config);
    const after = getEvolutionChangelog(sql, actor);
    expect(after.seenAt).toBe(seenAt);
    expect(after.unseenCount).toBe(0);
    db.close();
  });
});

/** A computer-use turn's screenshots, as its tool results keep them: each the model was handed as content. */
function screenshotTurn(id: string, shots: readonly string[]) {
  return {
    id, origin: 'output',
    message: {
      role: 'assistant',
      content: shots.flatMap((data, index) => [
        { type: 'tool-call' as const, toolCallId: `${id}-${String(index)}`, toolName: 'computer', input: { op: 'screen' } },
        {
          type: 'tool-result' as const, toolCallId: `${id}-${String(index)}`, toolName: 'computer',
          output: { type: 'content' as const, value: [{ type: 'text' as const, text: `screen ${String(index)}` }, { type: 'file' as const, data: { type: 'data' as const, data }, mediaType: 'image/png' }] },
        },
      ]),
    } satisfies ModelMessage,
  } as const;
}

/** A distinct base64 image of `bytes` characters. */
const shot = (mark: string, bytes: number): string => `iVBOR${mark}${'A'.repeat(bytes - 5 - mark.length)}`;

/** Every page from the newest back to the start, and each page's JSON. */
async function walkDrawn(transcript: SessionTranscriptReader): Promise<{ ids: string[]; pages: string[] }> {
  const ids: string[] = [];
  const pages: string[] = [];

  for (let page = await getChatHistoryPage(transcript, {}, JSON.stringify); ; page = await getChatHistoryPage(transcript, { cursor: page.next }, JSON.stringify)) {
    ids.unshift(...page.items.map((entry) => entry.id));
    pages.push(JSON.stringify(page.items));

    if (page.status === 'end') return { ids, pages };
  }
}

describe("a chat's pages", () => {
  // Staging 2026-10-19: a 341-step computer-use session's chat was one 70 MB read, past the 32 MiB a facet RPC carries.
  test('a long run of screenshots crosses as addresses, each page within its bytes, and walked back every entry once', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const shots = Array.from({ length: 24 }, (_, index) => shot(`shot${String(index)}x`, 512 * 1024));

    await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: 'ask', origin: 'input', message: { role: 'user', content: 'Play the level through.' } });
    await seedTranscriptEntry(history, CHAT_SESSION_ID, screenshotTurn('played', shots));

    for (let index = 0; index < 6; index += 1) {
      await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: `long-${String(index)}`, origin: 'input', message: { role: 'user', content: 'w'.repeat(400 * 1024) } });
    }

    const { ids, pages } = await walkDrawn(transcript);

    expect(ids).toEqual(['ask', 'played', ...Array.from({ length: 6 }, (_, index) => `long-${String(index)}`)]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.filter((page) => new TextEncoder().encode(page).length > CHAT_PAGE_BYTES)).toEqual([]);
    expect(pages.filter((page) => shots.some((data) => page.includes(data.slice(0, 16))))).toEqual([]);
    w.db.close();
  });

  test('an address reads back the image it names, and names nothing outside this chat', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const shots = [shot('first', 4096), shot('second', 4096)];

    await seedTranscriptEntry(history, CHAT_SESSION_ID, screenshotTurn('played', shots));
    const page = await getChatHistoryPage(transcript, {}, JSON.stringify);
    const urls = JSON.stringify(page.items).match(/\{\\"messageId[^}]*\}/gu) ?? [];
    const refs = urls.map((url) => v.parse(v.object({ messageId: v.string(), partNo: v.number(), index: v.number() }), JSON.parse(JSON.parse(`"${url}"`))));

    expect(await Promise.all(refs.map(async (ref) => (await transcript.media(ref))?.data))).toEqual(shots);
    expect(await transcript.media({ ...present(refs[0], 'the first address'), index: 1 })).toBeNull();
    expect(await transcript.media({ ...present(refs[0], 'the first address'), messageId: 'another-chat' })).toBeNull();
    w.db.close();
  });

  test("a person's attached picture crosses as an address and reads back whole", async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const picture = shot('attached', 64 * 1024);

    await seedTranscriptEntry(history, CHAT_SESSION_ID, {
      id: 'asked', origin: 'input',
      message: { role: 'user', content: [{ type: 'text', text: 'What is in this?' }, { type: 'file', data: picture, mediaType: 'image/png', filename: 'level.png' }] },
    });

    const [entry] = (await getChatHistoryPage(transcript, {}, JSON.stringify)).items;
    const file = present(entry?.parts.find((part) => part.type === 'file'), 'the attached file part');
    const ref = v.parse(v.object({ messageId: v.string(), partNo: v.number(), index: v.number() }), JSON.parse(v.parse(v.string(), file.url)));

    expect(JSON.stringify(entry)).not.toContain(picture.slice(0, 16));
    expect((await transcript.media(ref))?.data).toBe(picture);
    w.db.close();
  });

  // Staging rc21 (2026-10-19, live-app-plans): a tab was seeded with up to 200 rows, the whole of a 140-entry chat, and
  // its first scroll-back asked for the newest page again, so nothing older came.
  test("a tab is seeded with the chat's newest window, and reads on from just before it", async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);

    for (let index = 0; index < 140; index += 1) {
      await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: `row-${String(index)}`, origin: 'input', message: { role: 'user', content: `ask ${String(index)}` } });
    }

    const seed = await chatSeed(transcript, JSON.stringify);
    const older = present(seed.older, 'the cursor before the window');
    const next = await getChatHistoryPage(transcript, { cursor: older, limit: 40 }, JSON.stringify);

    expect(seed.messages.map((message) => message.id)).toEqual(Array.from({ length: CHAT_SEED_ROWS }, (_, at) => `row-${String(140 - CHAT_SEED_ROWS + at)}`));
    expect(next.items.map((item) => item.id)).toEqual(Array.from({ length: 40 }, (_, at) => `row-${String(140 - CHAT_SEED_ROWS - 40 + at)}`));
    w.db.close();
  });

  test('a window that reaches the chat\'s start says there is nothing older to read', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);

    for (let index = 0; index < 3; index += 1) {
      await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: `row-${String(index)}`, origin: 'input', message: { role: 'user', content: `ask ${String(index)}` } });
    }

    expect(await chatSeed(transcript, JSON.stringify)).toMatchObject({ older: null });
    w.db.close();
  });
});
