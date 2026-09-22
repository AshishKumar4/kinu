/** Read models through public entry points over real storage, asserting the shapes surfaces
 *  consume. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { jsonSchema, tool, type ToolSet } from 'ai';

import { present, testActorHandle } from '@kinu.run/test-utils';
import {
  collectWorkspaceTextFiles, createTestActor, createTestRuntime, createWorkspaceBundle, makeExecRaw, makeSql, makeSqlExec,
} from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { RunEventRecorder, initRunEventTables } from '../src/events/recorder';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { getRunTimeline } from '../src/read-models/timeline';
import { getRunEvents, getRunSummaries, listRuns } from '../src/read-models/runs';
import { getAgentStatus, getChatHistoryPage, getToolList } from '../src/read-models/status';
import { SessionHistory } from '../src/session/history';
import { readSessionTranscript, type SessionTranscriptReader } from '../src/session/transcript';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import type { ChatHistoryEntry } from '../src/types/chat';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { StaleCursorError, type Page, type SeekCursor } from '../src/session/page';
import {
  getWorkspaceDiff, initWorkspaceBaselineTable, resetWorkspaceBaseline,
} from '../src/read-models/workspace-diff';
import { getExecutorFiles, readExecutorFile, writeExecutorFileOp } from '../src/read-models/files';
import type { SqlExecutor, VFS } from '../src/types/primitives';
import {
  cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob, jobResult,
  listBackgroundJobs, retryBackgroundJob, type BackgroundJobControl,
} from '../src/read-models/background-jobs';
import {
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getShellApprovalMode,
  setAlwaysActiveSkills, setEvolutionConfig, setModel, setReasoningEffort, setShellApprovalMode,
} from '../src/read-models/config-plane';
import { getEvolutionChangelog, markChangelogSeen } from '../src/read-models/evolution-views';
import type { JsonValue } from '../src/utils/json';

function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw, sql, exec });
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'read-model-test');

  return { db, sql, execRaw, actor, vfs: createWorkspaceBundle(db).vfs, config: actor.config };
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
    files: async () => ({ vfs: w.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** Each entry is the child of the one before it, as a real turn writes. */
async function seedTranscript(history: SessionHistory, rows: readonly SeedRow[], after: string | null = null): Promise<void> {
  let parentId = after;

  for (const row of rows) {
    await history.record(CHAT_SESSION_ID, {
      id: row.id, parentId, message: { role: row.role, content: row.content },
      origin: row.role === 'user' ? 'input' : 'output',
    });
    parentId = row.id;
  }
}

/** Every page, oldest first: the only way to observe pages join without overlap. */
async function walkTranscript(transcript: SessionTranscriptReader, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: SeekCursor | undefined;

  for (;;) {
    const page = await getChatHistoryPage(transcript, { limit, cursor });
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

    expect(spans.map((s) => s.source)).toEqual(['shell', 'evolution', 'mcts', 'background']);
    expect(spans.map((s) => s.ts)).toEqual([...spans].sort((a, b) => a.ts - b.ts).map((s) => s.ts));
    // text_delta is the stream's own noise — never a span.
    expect(spans.some((s) => s.rawType === 'text_delta')).toBe(false);
    expect(spans[1]).toMatchObject({ kind: 'scaffold', label: 'v2 proposed', data: { version: 2 } });
    expect(spans[3]).toMatchObject({ kind: 'background', label: 'Background shell', detail: 'running in background' });
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
    const { db, sql, actor, vfs } = w;
    void sql`UPDATE workspace_identity SET name = 'jarvis', created_at = 42`;
    await seedTranscript(chatStore(w).history, [{ id: 'm1', role: 'user', content: 'hi' }]);

    // The read model reports the caller-resolved model as given.
    expect(await getAgentStatus({
      sql, vfs, actor, model: 'anthropic/claude-opus-5', reasoningEffort: 'high', name: 'fallback-name',
      displayName: 'Jarvis',
    })).toMatchObject({
      name: 'jarvis', displayName: 'Jarvis', createdAt: 42, model: 'anthropic/claude-opus-5',
      messageCount: 1, scaffoldVersion: 0, reasoningEffort: 'high', forkLineage: null,
    });
    db.close();
  });

  test('a workspace with no tables fails the read instead of inventing an identity', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const other = workspace();
    await expect(getAgentStatus({
      sql, vfs: createWorkspaceBundle(db).vfs,
      actor: other.actor, model: '', reasoningEffort: null, name: 'agent-7',
      displayName: 'ignored',
    })).rejects.toThrow(/no such table/);
  });

  test('chat history flattens multi-part content and drops non-chat roles', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await history.record(CHAT_SESSION_ID, {
      id: 'a', parentId: null, origin: 'input',
      message: { role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
    });
    await history.record(CHAT_SESSION_ID, {
      id: 'b', parentId: 'a', origin: 'output',
      message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'text', value: 'not a chat role' } }] },
    });

    const recorded = transcript.read('a');

    if (recorded === null) throw new Error('the seeded user entry must be in the transcript');
    expect(await getChatHistoryPage(transcript)).toEqual({
      status: 'end',
      items: [{ id: 'a', role: 'user', content: 'hello', createdAt: recorded.recordedAt }],
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
      id, turnId: id, message, metadata: { kinuEvent: 'fork_interrupted', heads: 9 },
    }));

    const recorded = transcript.read(id);

    if (recorded === null) throw new Error('the harness notice must be in the transcript');
    expect((await getChatHistoryPage(transcript)).items).toEqual([{
      id, role: 'system',
      content: '9 head(s) across 1 fork run(s)…', createdAt: recorded.recordedAt,
      metadata: { kinuEvent: 'fork_interrupted', heads: 9 },
    }]);
    w.db.close();
  });

  /** A bare `LIMIT` cannot tell truncated from complete; an exactly-consumed page is the case the
     *  limit+1 probe exists for. */
  test('a short page is exhaustion, a full page is not, and an exactly-full page is', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(4));

    expect((await getChatHistoryPage(transcript, { limit: 9 })).status).toBe('end');
    expect(await getChatHistoryPage(transcript, { limit: 2 })).toMatchObject({ status: 'more', next: { after: 'm3' } });
    expect((await getChatHistoryPage(transcript, { limit: 4 })).status).toBe('end');
    w.db.close();
  });

  /** A message arriving between page fetches must neither duplicate nor skip rows: the keyset-cursor
     *  property no offset can satisfy. */
  test('a message arriving mid-pagination causes neither a duplicate nor a gap', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(10));

    const first = await getChatHistoryPage(transcript, { limit: 4 });
    expect(first).toMatchObject({ status: 'more' });

    if (first.status !== 'more') throw new Error('unreachable');
    expect(first.items.map((m) => m.id)).toEqual(['m7', 'm8', 'm9', 'm10']);

    await seedTranscript(history, [{ id: 'm11', role: 'assistant', content: 'live arrival' }], 'm10');

    const second = await getChatHistoryPage(transcript, { limit: 4, cursor: first.next });
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

  /** A cursor whose anchor is gone must not answer "no rows", the exhaustion answer. */
  test('a cursor whose anchor has vanished is refused, not reported as exhausted', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    await seedTranscript(history, transcriptOf(3));

    await expect(getChatHistoryPage(transcript, { cursor: { after: 'never-existed' } }))
      .rejects.toThrow(StaleCursorError);
    await expect(getChatHistoryPage(transcript, { cursor: { after: 'never-existed' } }))
      .rejects.toThrow(/no longer in it/);
    w.db.close();
  });

  /** A dismissed actor's pane has no file plane: spilled entries say unavailable, the page reads whole. */
  test('a reader with no file plane pages a spilled entry as unavailable, in its place', async () => {
    const w = workspace();
    const { history, transcript } = chatStore(w);
    const spilled = 'x'.repeat(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value);

    await seedTranscript(history, [
      { id: 'm1', role: 'user', content: 'before' },
      { id: 'm2', role: 'assistant', content: spilled },
      { id: 'm3', role: 'user', content: 'after' },
    ]);

    const shown = (page: Page<ChatHistoryEntry>) =>
      page.items.map(({ id, content, unavailable }) => ({ id, content: content.length, unavailable }));

    expect(shown(await getChatHistoryPage(transcript))).toEqual([
      { id: 'm1', content: 6, unavailable: undefined },
      { id: 'm2', content: spilled.length, unavailable: undefined },
      { id: 'm3', content: 5, unavailable: undefined },
    ]);
    expect(shown(await getChatHistoryPage(readSessionTranscript(w.sql, w.actor, CHAT_SESSION_ID, null)))).toEqual([
      { id: 'm1', content: 6, unavailable: undefined },
      { id: 'm2', content: 0, unavailable: true },
      { id: 'm3', content: 5, unavailable: undefined },
    ]);
    w.db.close();
  });

  test('the tool list carries each crafted tool with its live score', async () => {
    const { rt, db } = createTestRuntime();
    const sql = makeSql(db);
    // This UPDATE stands in for a real usage history on the crafted_tools row.
    await rt.craftStore.create({
      name: 'summarize', description: 'sum', params: null, code: 'x', scope: 'local',
    });
    void sql`UPDATE crafted_tools SET score = 0.9, uses = 7 WHERE name = 'summarize'`;

    const list = getToolList(sql, rt.craftStore);
    expect(list.builtIn.length).toBeGreaterThan(0);
    expect(list.crafted).toEqual([
      { name: 'summarize', description: 'sum', scope: 'local', qualityScore: 0.9, usageCount: 7 },
    ]);
    // An unscored tool reads as the neutral prior, never as zero.
    void sql`UPDATE crafted_tools SET score = 0.5, uses = 0 WHERE name = 'summarize'`;
    expect(getToolList(sql, rt.craftStore).crafted[0]).toMatchObject({ qualityScore: 0.5, usageCount: 0 });
    db.close();
  });
});

describe('workspace change-set', () => {
  test('work completed before the first read remains visible against the birth baseline', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('notes.md', 'one\n');

    const first = await getWorkspaceDiff(rt);
    expect(first.baselineJustCaptured).toBe(false);
    expect(first.files.map((f) => [f.path, f.status, f.added])).toEqual([['notes.md', 'added', 2]]);

    expect(await resetWorkspaceBaseline(rt)).toMatchObject({ ok: true });
    await rt.storage.vfs.writeFile('notes.md', 'one\ntwo\n');
    const after = await getWorkspaceDiff(rt);
    expect(after.baselineJustCaptured).toBe(false);
    expect(after.files.map((f) => [f.path, f.status, f.added])).toEqual([['notes.md', 'changed', 1]]);

    expect(await resetWorkspaceBaseline(rt)).toMatchObject({ ok: true });
    expect((await getWorkspaceDiff(rt)).files).toEqual([]);
    db.close();
  });

  test('binary files are excluded from the snapshot', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile('text.txt', 'readable');
    await rt.storage.vfs.writeFile('blob.bin', `has nul`);
    const files = await collectWorkspaceTextFiles(rt);
    expect(files['text.txt']).toBe('readable');
    expect(files['blob.bin']).toBeUndefined();
    db.close();
  });
});

describe('executor file plane', () => {
  /** Includes where the executor starts, which only the environment knows. */
  function router(files?: VFS) {
    const provider = files === undefined
      ? { homeDir: async () => '/home/user' }
      : { homeDir: async () => '/home/user', files };

    return { getProvider: (name: string) => (name === 'workspace' ? provider : undefined) };
  }

  test('workspace listings are typed, sized and directories-first', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.mkdir('/proj/sub', { recursive: true });
    await rt.storage.vfs.writeFile('/proj/a.txt', 'aa');

    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/proj');
    expect(listed.entries?.map((e) => [e.name, e.type])).toEqual([['sub', 'dir'], ['a.txt', 'file']]);
    expect(listed.entries?.find((e) => e.name === 'a.txt')?.size).toBe(2);
    db.close();
  });

  test('an empty path lists where the environment itself says it starts', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile('/home/user/SOUL.md', 'me');

    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '');
    expect(listed.path).toBe('/home/user');
    expect(listed.entries?.map((e) => e.name)).toContain('SOUL.md');
    db.close();
  });

  test('the listed directory comes back absolute and resolved, so the caller can walk up', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile('/home/user/SOUL.md', 'me');
    await rt.storage.vfs.writeFile('/home/SHARED', 's');

    // `..` from the agent's home is /home, not the filesystem root.
    const up = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/home/user/..');
    expect(up.path).toBe('/home');
    expect(up.entries?.map((e) => e.name)).toContain('SHARED');
    db.close();
  });

  test('an environment with no file plane is an error value, not a throw', async () => {
    const { rt, db } = createTestRuntime();
    // Unknown id and a device with no filesystem yet both read as a rendered reason.
    expect(await getExecutorFiles(router(rt.storage.vfs), 'ghost', ''))
      .toEqual({ error: 'Executor "ghost" has no file plane' });
    expect(await getExecutorFiles(router(), 'workspace', ''))
      .toEqual({ error: 'Executor "workspace" has no file plane' });
    expect(await readExecutorFile(router(rt.storage.vfs), 'workspace', '')).toEqual({ error: 'path required' });
    db.close();
  });

  test('reading refuses binaries and directories, and reports truncation', async () => {
    const { rt, db } = createTestRuntime();
    const r = router(rt.storage.vfs);
    await rt.storage.vfs.mkdir('dir', { recursive: true });
    await rt.storage.vfs.writeFile('bin', `x\u0000y`);
    await rt.storage.vfs.writeFile('big', 'z'.repeat(512 * 1024 + 10));

    expect(await readExecutorFile(r, 'workspace', 'dir')).toEqual({ error: 'path is a directory' });
    expect(await readExecutorFile(r, 'workspace', 'bin')).toEqual({ error: 'binary file — not previewable' });
    // A plane without ranged read (seven base VFS methods) refuses an over-budget preview and names
    // the download.
    const refused = await readExecutorFile(r, 'workspace', 'big');
    expect(refused.content).toBeUndefined();
    expect(refused.error).toContain('no ranged read');
    expect(refused.error).toContain('download');

    // A plane that can serve a prefix previews and truncates.
    const ranged = {
      getProvider: (name: string) => (name === 'workspace' ? {
        homeDir: async () => '/home/user',
        files: {
          ...rt.storage.vfs,
          readRange: async (path: string, offset: number, length: number) => {
            const whole = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
            const bytes = whole instanceof Uint8Array ? whole : new TextEncoder().encode(whole);

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
      .toEqual({ ok: true });
    // No compare-and-write on this plane, so the read carries the reason instead of an edit token.
    expect(await readExecutorFile(r, 'workspace', 'up.txt')).toEqual({
      content: 'hi',
      readOnlyReason:
        'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.',
    });
    expect(await writeExecutorFileOp(r, 'workspace', 'dir/', { bytes: new Uint8Array() }))
      .toEqual({ error: 'file path required' });
    db.close();
  });
});

describe('background-job control plane', () => {
  test('a settled job retries through its stored input on the raw surface', () => {
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

    const retry = retryBackgroundJob({
      jobs, jobRunner: runner, rawTools: () => tools, logActivity: () => undefined,
    }, 'j1');

    expect(retry.ok).toBe(true);
    expect(retry.jobId).not.toBe('j1');
    expect(seen).toEqual([{ q: 'kinu' }]);
    expect(detached).toEqual([{ jobId: present(retry.jobId, 'the retried job id'), kind: 'search' }]);
    db.close();
  });

  test('retry states the reason it cannot run rather than failing silently', () => {
    const { db, jobs, runner } = jobPlane();
    const deps = { jobs, jobRunner: runner, rawTools: (): ToolSet => ({}), logActivity: () => undefined };

    expect(retryBackgroundJob(deps, 'missing')).toEqual({ ok: false, error: 'job not found' });

    jobs.create({ id: 'running', kind: 'shell', workMode: 'build', input: '{}', now: 1 });
    expect(retryBackgroundJob(deps, 'running')).toEqual({ ok: false, error: 'job still running' });

    jobs.create({ id: 'noinput', kind: 'shell', workMode: 'build', now: 1 });
    jobs.settle('noinput', 0, 'r', 2);
    expect(retryBackgroundJob(deps, 'noinput')).toEqual({ ok: false, error: 'no stored input to retry' });

    jobs.create({ id: 'gone', kind: 'vanished', workMode: 'build', input: '{}', now: 1 });
    jobs.settle('gone', 0, 'r', 2);
    expect(retryBackgroundJob(deps, 'gone')).toEqual({ ok: false, error: 'tool "vanished" unavailable' });
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
    expect(() => jobResult(jobs, 'j1')).toThrow(/no such table: background_jobs/);
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

    // The provider's own message is the CAUSE, not spliced into the wrapper.
    expect(() => setModel(deps, 'nonsense')).toThrow('setModel(nonsense) failed');

    const failure = (() => {
      try {
        setModel(deps, 'nonsense');

        return null;
      } catch (error) { return error; }
    })();

    expect(failure instanceof Error && failure.cause instanceof Error ? failure.cause.message : null)
      .toBe('unknown provider: nonsense');
    // A rejected spec neither stores nor invalidates.
    expect(config.getModel()).toBe('openai/gpt-5.1');
    expect(invalidations).toBe(1);
    db.close();
  });

  test('setters reject values off their domain', () => {
    const { db, config } = workspace();
    expect(() => setReasoningEffort(config, 'extreme')).toThrow('Invalid reasoning effort: extreme');
    expect(() => setShellApprovalMode({ config, onChanged: () => undefined }, 'yolo')).toThrow('invalid mode: yolo');
    expect(() => setAlwaysActiveSkills(config, 'debugging')).toThrow('names must be a string array');
    expect(() => setAlwaysActiveSkills(config, ['ok', 7])).toThrow('names must contain only strings');
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

  test('the MCTS view is stored overrides over engine defaults', () => {
    const { db, config } = workspace();
    const defaults = getMctsConfig(config);
    config.setMctsOverrides({ budget: 3 });
    expect(getMctsConfig(config)).toEqual({ ...defaults, maxIterations: 3 });
    db.close();
  });

  test('an evolution write answers with the EFFECTIVE config, clamps included', () => {
    const { db, config } = workspace();
    const effective = setEvolutionConfig(config, { autoPromoteScaffold: true, gepaEvalBudget: 1_000_000 });
    expect(effective.autoPromoteScaffold).toBe(true);
    expect(effective.gepaEvalBudget).toBeLessThan(1_000_000);
    expect(getEvolutionConfig(config)).toEqual(effective);
    db.close();
  });
});

describe('changelog view', () => {
  test('unseen counts against the stored watermark, and marking seen zeroes it', () => {
    const { db, sql, actor, config } = workspace();
    void sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
      VALUES ('summarize', 'sum', NULL, 'x', 'local', ${Date.now()}, ${Date.now()})`;

    expect(getEvolutionChangelog(sql, actor).entries).toHaveLength(1);
    expect(getEvolutionChangelog(sql, actor).unseenCount).toBe(1);
    const { seenAt } = markChangelogSeen(config);
    const after = getEvolutionChangelog(sql, actor);
    expect(after.seenAt).toBe(seenAt);
    expect(after.unseenCount).toBe(0);
    db.close();
  });
});
