/**
 * Behaviour tests for the read models — the folds an operator surface asks
 * for, now that they have one implementation instead of one per backend.
 *
 * These go through the public entry points with real storage (in-memory
 * SQLite, the canonical VFS), so they assert the SHAPES the surfaces consume
 * rather than how the fold is written.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { jsonSchema, tool, type ToolSet } from 'ai';

import {
  collectWorkspaceTextFiles, createTestRuntime, createWorkspaceBundle, makeExecRaw, makeSql, makeSqlExec,
  SDK_SESSION_DDL,
} from './helpers';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { RunEventRecorder, initRunEventTables } from '../src/events/recorder';
import { createAgentConfigStore } from '../src/config/store';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { getRunTimeline } from '../src/read-models/timeline';
import { getRunEvents, getRunSummaries, listRuns } from '../src/read-models/runs';
import { getAgentStatus, getChatHistoryPage, getToolList } from '../src/read-models/status';
import { StaleCursorError, type SeekCursor } from '../src/read-models/page';
import { uiMessageText } from '../src/utils/ui-message';
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

/** A workspace with the real schema — the same entry point both backends run. */
function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw, sql, exec });
  return { db, sql, execRaw, vfs: createWorkspaceBundle(db).vfs, config: createAgentConfigStore(sql) };
}

interface SeedRow { id: string; role: string; content: string }

/** `n` transcript rows, m1 oldest. Inserted through the SDK's own column list
 *  so `created_at` is the whole-second DATETIME default a real turn writes. */
function transcriptOf(n: number): SeedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i + 1}`,
  }));
}

function seedTranscript(sql: SqlExecutor, rows: readonly SeedRow[]): void {
  for (const row of rows) {
    void sql`INSERT INTO assistant_messages (id, session_id, role, content, created_at)
      VALUES (${row.id}, ${''}, ${row.role}, ${row.content}, ${'2026-01-01 00:00:00'})`;
  }
}

/** Every page, oldest first — the walk a caller performs, and the only way to
 *  observe that the pages join up without overlapping. */
function walkTranscript(sql: SqlExecutor, limit: number): string[] {
  const ids: string[] = [];
  let cursor: SeekCursor | undefined;
  for (;;) {
    const page = getChatHistoryPage(sql, { limit, cursor });
    ids.unshift(...page.items.map((m) => m.id));
    if (page.status === 'end') return ids;
    cursor = page.next;
  }
}

/** A real job store plus a recording stand-in for the runner: this plane's
 *  contract with the runner is exactly these four calls, and the lifecycle
 *  behind them has its own tests (unit-background-job-runner). */
function jobPlane() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
  const jobs = new BackgroundJobStore(sql);
  const detached: Array<{ jobId: string; kind: string }> = [];
  let created = 0;
  const runner: BackgroundJobControl = {
    cancel: () => Promise.resolve(true),
    cancelRunning: () => [],
    create: (kind, input, mode) => {
      const id = `retry-${++created}`;
      jobs.create({ id, kind, workMode: mode, input: JSON.stringify(input), now: Date.now() });
      return id;
    },
    detach: (jobId, kind) => { detached.push({ jobId, kind }); },
  };
  return { db, sql, jobs, runner, detached };
}

describe('run reads', () => {
  /** A bare event log — the only storage the run reads need. No caller closes
   *  it: an in-memory Database is collected with the test. */
  function eventLog(): RunEventRecorder {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    return new RunEventRecorder(makeSql(db));
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
    // `cacheRead` came from one turn only and is summed over that turn alone;
    // the fields NEITHER turn reported stay absent instead of appearing as 0.
    expect(summary?.usage).toEqual({ input: 15, output: 5, cacheRead: 2 });
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

    // The provider said nothing: no field is present, and the count of silent
    // turns is the denominator that says so.
    expect(silent?.usage).toEqual({});
    expect(silent?.turnsWithoutUsage).toBe(2);

    // The provider said "zero": that IS a report, and it must not be folded
    // into the same shape as the silence above.
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
    const events = new RunEventRecorder(makeSql(db));
    expect(() => listRuns(events)).toThrow(/no such table: run_events/);
    expect(() => getRunEvents(events, 'nope')).toThrow(/no such table: run_events/);
    expect(() => getRunSummaries(events)).toThrow(/no such table: run_events/);
    db.close();
  });
});

describe('run timeline', () => {
  test('merges every source into one list ordered by time', () => {
    const { db, sql, execRaw } = workspace();
    initRunEventTables(execRaw);
    const events = new RunEventRecorder(sql);
    const jobs = new BackgroundJobStore(sql);

    // The run events stamp themselves with the wall clock; the other sources
    // carry their own, so they are placed after it to pin the ordering.
    events.emit('r1', { type: 'run_start', agentId: 'a1', caused_by: 'chat' });
    const base = Date.now() + 1000;
    void sql`INSERT INTO evolution_events (id, type, message, data, created_at)
      VALUES ('e1', 'scaffold_proposed', 'v2 proposed', '{"version":2}', ${base})`;
    void sql`INSERT INTO search_nodes (id, parent_id, depth, visits, value, status, action, task, created_at)
      VALUES ('n1', NULL, 0, 1, 0.5, 'terminal', 'explore A', 't', ${base + 1000})`;
    jobs.create({ id: 'j1', kind: 'run', workMode: 'build', now: base + 2000 });

    const spans = getRunTimeline({ sql, events, jobs, currentRunId: 'r1' });

    expect(spans.map((s) => s.source)).toEqual(['run', 'evolution', 'mcts', 'background']);
    expect(spans.map((s) => s.ts)).toEqual([...spans].sort((a, b) => a.ts - b.ts).map((s) => s.ts));
    // text_delta is the stream's own noise — never a span.
    expect(spans.some((s) => s.rawType === 'text_delta')).toBe(false);
    // The evolution payload survives the merge, parsed.
    expect(spans[1]).toMatchObject({ kind: 'scaffold', label: 'v2 proposed', data: { version: 2 } });
    expect(spans[3]).toMatchObject({ kind: 'background', label: 'Background run', detail: 'running in background' });
    db.close();
  });

  test('the limit bounds the newest end of the merged list', () => {
    const { sql, execRaw } = workspace();
    initRunEventTables(execRaw);
    const events = new RunEventRecorder(sql);
    for (let i = 0; i < 5; i++) {
      void sql`INSERT INTO evolution_events (id, type, message, created_at)
        VALUES (${`e${i}`}, 'reflection', ${`m${i}`}, ${i * 100})`;
    }
    const spans = getRunTimeline({ sql, events, jobs: new BackgroundJobStore(sql), currentRunId: null }, { limit: 2 });
    expect(spans.map((s) => s.label)).toEqual(['m3', 'm4']);
  });

  test('an idle workspace answers empty; one missing the tables fails the read', () => {
    const { db, sql } = workspace();
    expect(getRunTimeline({
      sql, events: new RunEventRecorder(sql), jobs: new BackgroundJobStore(sql), currentRunId: 'r1',
    })).toEqual([]);
    db.close();

    const bare = new Database(':memory:');
    const bareSql = makeSql(bare);
    expect(() => getRunTimeline({
      sql: bareSql, events: new RunEventRecorder(bareSql),
      jobs: new BackgroundJobStore(bareSql), currentRunId: 'r1',
    })).toThrow(/no such table/);
    bare.close();
  });
});

describe('agent status', () => {
  test('identity, counts and config in one shape', async () => {
    const { db, sql, config, vfs } = workspace();
    void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES ('id-1', 'jarvis', 42)`;
    void sql`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', 'default', 'user', 'hi', 1)`;
    config.setReasoningEffort('high');

    expect(await getAgentStatus({
      sql, vfs, config, name: 'fallback-name',
      displayName: 'Jarvis', fallbackMessageCount: 99,
    })).toMatchObject({
      name: 'jarvis', displayName: 'Jarvis', createdAt: 42,
      messageCount: 1, scaffoldVersion: 0, reasoningEffort: 'high', forkLineage: null,
    });
    db.close();
  });

  test('a workspace with no tables fails the read instead of inventing an identity', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    await expect(getAgentStatus({
      sql, vfs: createWorkspaceBundle(db).vfs,
      config: createAgentConfigStore(sql), name: 'agent-7',
      displayName: 'ignored', fallbackMessageCount: 3,
    })).rejects.toThrow(/no such table/);
  });

  test('chat history flattens UI-message parts and drops non-chat roles', () => {
    const { db, sql, execRaw } = workspace();
    execRaw(SDK_SESSION_DDL);
    seedTranscript(sql, [
      { id: 'a', role: 'user', content: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }) },
      { id: 'b', role: 'tool', content: 'not a chat role' },
    ]);

    expect(getChatHistoryPage(sql)).toEqual({
      status: 'end',
      items: [{ id: 'a', role: 'user', content: 'hello', createdAt: '2026-01-01 00:00:00' }],
    });
    db.close();
  });

  test('chat history falls back to the plain mirror when there is no rich table', () => {
    const { db, sql } = workspace();
    void sql`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', 'default', 'assistant', 'plain', 5)`;
    expect(getChatHistoryPage(sql, { limit: 1 })).toEqual({
      status: 'end',
      items: [{ id: 'm1', role: 'assistant', content: 'plain', createdAt: 5 }],
    });
    db.close();
  });

  /**
   * The defect a bare `LIMIT` has: it answers a truncated window and a complete
   * one with the identical shape, so a caller cannot tell "that is all there
   * is" from "that is all you asked for".
   *
   * The third case is the one the limit+1 probe exists for. A page that exactly
   * consumes the data is indistinguishable from a truncated one by row count
   * alone — `rows.length === limit` is true for both — so an implementation
   * that compares lengths reports `more` here and then serves an empty page.
   */
  test('a short page is exhaustion, a full page is not, and an exactly-full page is', () => {
    const { db, sql, execRaw } = workspace();
    execRaw(SDK_SESSION_DDL);
    seedTranscript(sql, transcriptOf(4));

    expect(getChatHistoryPage(sql, { limit: 9 }).status).toBe('end');
    expect(getChatHistoryPage(sql, { limit: 2 })).toMatchObject({ status: 'more', next: { after: 'm3' } });
    expect(getChatHistoryPage(sql, { limit: 4 }).status).toBe('end');
    db.close();
  });

  /**
   * THE property. A message arriving between two page fetches is the normal
   * case for a chat — the user scrolls up while the agent is still answering —
   * and it is what separates a keyset cursor from an offset.
   *
   * An offset implementation fails this precisely: page 1 of `ORDER BY rowid
   * DESC LIMIT 4` is m10..m7, the insert makes m11 the newest row, and `LIMIT 4
   * OFFSET 4` then answers m7..m4 — m7 delivered twice. Shift the offset to
   * compensate and it skips instead. There is no offset that is right, because
   * an offset names a position in a sequence that changed.
   */
  test('a message arriving mid-pagination causes neither a duplicate nor a gap', () => {
    const { db, sql, execRaw } = workspace();
    execRaw(SDK_SESSION_DDL);
    seedTranscript(sql, transcriptOf(10));

    const first = getChatHistoryPage(sql, { limit: 4 });
    expect(first).toMatchObject({ status: 'more' });
    if (first.status !== 'more') throw new Error('unreachable');
    expect(first.items.map((m) => m.id)).toEqual(['m7', 'm8', 'm9', 'm10']);

    // The live turn lands while the reader is scrolling up.
    seedTranscript(sql, [{ id: 'm11', role: 'assistant', content: 'live arrival' }]);

    const second = getChatHistoryPage(sql, { limit: 4, cursor: first.next });
    expect(second.items.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);

    // No duplicate: nothing from page 1 reappears. No gap: m6 is the row
    // immediately before m7, not m5. And the newer arrival never leaks into a
    // page walking away from it.
    expect(second.items.map((m) => m.id)).not.toContain('m11');

    const walked = walkTranscript(sql, 4);
    expect(walked).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
    expect(new Set(walked).size).toBe(walked.length);
    db.close();
  });

  /**
   * `assistant_messages.created_at` is a whole-second DATETIME and a turn emits
   * several rows inside one second (see identity/session-tree.ts). Every row
   * here shares a timestamp, so a `created_at` cursor has no boundary to seek
   * on at all and a `created_at` ORDER BY has no defined membership.
   */
  test('messages sharing one whole second still page without loss', () => {
    const { db, sql, execRaw } = workspace();
    execRaw(SDK_SESSION_DDL);
    for (const row of transcriptOf(6)) {
      void sql`INSERT INTO assistant_messages (id, session_id, role, content, created_at)
        VALUES (${row.id}, ${''}, ${row.role}, ${row.content}, ${'2026-03-04 05:06:07'})`;
    }
    expect(walkTranscript(sql, 2)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    db.close();
  });

  /**
   * The third state. A cursor whose anchor is gone must not answer "no rows",
   * because that is the exhaustion answer and the caller would stop walking a
   * conversation it never finished reading.
   */
  test('a cursor whose anchor has vanished is refused, not reported as exhausted', () => {
    const { db, sql, execRaw } = workspace();
    execRaw(SDK_SESSION_DDL);
    seedTranscript(sql, transcriptOf(3));

    expect(() => getChatHistoryPage(sql, { cursor: { after: 'never-existed' } }))
      .toThrow(StaleCursorError);
    expect(() => getChatHistoryPage(sql, { cursor: { after: 'never-existed' } }))
      .toThrow(/no longer in it/);
    db.close();
  });

  test('uiMessageText leaves plain text alone', () => {
    expect(uiMessageText('just text')).toBe('just text');
    expect(uiMessageText(JSON.stringify({ parts: [{ type: 'text', text: 'a' }, { type: 'tool', x: 1 }, { type: 'text', text: 'b' }] })))
      .toBe('ab');
  });

  test('the tool list carries each crafted tool with its live score', async () => {
    const { rt, db } = createTestRuntime();
    const sql = makeSql(db);
    // craft_scores is created by the runtime's own schema. A local
    // `CREATE TABLE IF NOT EXISTS` naming a 3-column subset was a silent no-op
    // against the real 5-column table, and the positional INSERT below then
    // bound three values into five columns.
    await rt.craftStore.create({
      name: 'summarize', description: 'sum', params: null, code: 'x', scope: 'local',
    });
    void sql`INSERT INTO craft_scores (tool_name, score, uses) VALUES ('summarize', 0.9, 7)`;

    const list = getToolList(sql, rt.craftStore);
    expect(list.builtIn.length).toBeGreaterThan(0);
    expect(list.crafted).toEqual([
      { name: 'summarize', description: 'sum', scope: 'local', qualityScore: 0.9, usageCount: 7 },
    ]);
    // An unscored tool reads as the neutral prior, never as zero.
    void sql`DELETE FROM craft_scores`;
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
  /** A router holding one executor, the way a real runtime hands one over —
   *  including the one thing only the environment knows: where it starts. */
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

    // The browser opens an environment without knowing its paths. Cut
    // homeDir() out of the read model and this lands somewhere else.
    const listed = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '');
    expect(listed.path).toBe('/home/user');
    expect(listed.entries?.map((e) => e.name)).toContain('SOUL.md');
    db.close();
  });

  test('the listed directory comes back absolute and resolved, so the caller can walk up', async () => {
    const { rt, db } = createTestRuntime();
    await rt.storage.vfs.writeFile('/home/user/SOUL.md', 'me');
    await rt.storage.vfs.writeFile('/home/SHARED', 's');

    // `..` from the agent's home is /home, NOT the filesystem root — the exact
    // navigation the pane could not perform while every environment reported
    // its working directory as the literal '.'.
    const up = await getExecutorFiles(router(rt.storage.vfs), 'workspace', '/home/user/..');
    expect(up.path).toBe('/home');
    expect(up.entries?.map((e) => e.name)).toContain('SHARED');
    db.close();
  });

  test('an environment with no file plane is an error value, not a throw', async () => {
    const { rt, db } = createTestRuntime();
    // Unknown id, and a known executor that has no filesystem to browse (the
    // laptop before a device connects) read the same way: a rendered reason.
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
    const big = await readExecutorFile(r, 'workspace', 'big');
    expect(big.truncated).toBe(true);
    expect(big.content).toHaveLength(512 * 1024);
    db.close();
  });

  test("a write round-trips through the same environment's own paths", async () => {
    const { rt, db } = createTestRuntime();
    const r = router(rt.storage.vfs);
    expect(await writeExecutorFileOp(r, 'workspace', 'up.txt', new TextEncoder().encode('hi')))
      .toEqual({ ok: true });
    expect(await readExecutorFile(r, 'workspace', 'up.txt')).toEqual({ content: 'hi' });
    expect(await writeExecutorFileOp(r, 'workspace', 'dir/', new Uint8Array()))
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
        execute: async (input) => { seen.push(input); return 'done'; },
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
    // Detached immediately — the work already proved slow once.
    expect(detached).toEqual([{ jobId: retry.jobId!, kind: 'search' }]);
    db.close();
  });

  test('retry states the reason it cannot run rather than failing silently', () => {
    const { db, jobs, runner } = jobPlane();
    const deps = { jobs, jobRunner: runner, rawTools: (): ToolSet => ({}), logActivity: () => undefined };

    expect(retryBackgroundJob(deps, 'missing')).toEqual({ ok: false, error: 'job not found' });

    jobs.create({ id: 'running', kind: 'run', workMode: 'build', input: '{}', now: 1 });
    expect(retryBackgroundJob(deps, 'running')).toEqual({ ok: false, error: 'job still running' });

    jobs.create({ id: 'noinput', kind: 'run', workMode: 'build', now: 1 });
    jobs.settle('noinput', 0, 'r', 2);
    expect(retryBackgroundJob(deps, 'noinput')).toEqual({ ok: false, error: 'no stored input to retry' });

    jobs.create({ id: 'gone', kind: 'vanished', workMode: 'build', input: '{}', now: 1 });
    jobs.settle('gone', 0, 'r', 2);
    expect(retryBackgroundJob(deps, 'gone')).toEqual({ ok: false, error: 'tool "vanished" unavailable' });
    db.close();
  });

  test('cancelling current work aborts foreground tools and announces the outcome', () => {
    const { db, runner } = jobPlane();
    const live = new AbortController();
    const already = new AbortController();
    already.abort();
    const broadcasts: string[] = [];
    const order: string[] = [];

    const outcome = cancelCurrentWork({
      jobRunner: runner,
      activeToolControllers: new Set([live, already]),
      broadcast: (payload) => { order.push('broadcast'); broadcasts.push(payload); },
      onCancelled: () => order.push('settled'),
    });

    expect(outcome).toEqual({ ok: true, cancelledJobs: [], abortedTools: 1, returnedSteers: [] });
    expect(live.signal.aborted).toBe(true);
    // The backend settles its own turn state BEFORE clients hear about it.
    expect(order).toEqual(['settled', 'broadcast']);
    expect(JSON.parse(broadcasts[0]!)).toMatchObject({ type: 'work_cancelled', abortedTools: 1 });
    db.close();
  });

  test('an interrupt hands the pending mid-turn steers back instead of eating them', () => {
    const { db, runner } = jobPlane();
    const order: string[] = [];

    const outcome = cancelCurrentWork({
      jobRunner: runner,
      activeToolControllers: new Set(),
      broadcast: () => order.push('broadcast'),
      // What UserSteerDrain.interrupt() returns: what the model never saw.
      interruptSteers: () => { order.push('interrupt'); return ['also check staging', 'and the logs']; },
      onCancelled: (settled) => order.push(`settled:${settled.returnedSteers.length}`),
    });

    expect(outcome.returnedSteers).toEqual(['also check staging', 'and the logs']);
    // The drop happens before the backend settles, so the settle hook — the
    // place a backend broadcasts the return — already has the texts.
    expect(order).toEqual(['interrupt', 'settled:2', 'broadcast']);
    db.close();
  });

  test('a workspace with no background_jobs fails the read instead of reporting no work', () => {
    const db = new Database(':memory:');
    const jobs = new BackgroundJobStore(makeSql(db));
    expect(() => listBackgroundJobs(jobs)).toThrow(/no such table: background_jobs/);
    expect(() => jobResult(jobs, 'j1')).toThrow(/no such table: background_jobs/);
    expect(dismissBackgroundJob(jobs, 'j1')).toEqual({ ok: false });
    expect(clearBackgroundJobs(jobs)).toEqual({ ok: false });
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
      try { setModel(deps, 'nonsense'); return null; } catch (error) { return error; }
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
    const { db, sql, config } = workspace();
    void sql`INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at)
      VALUES ('summarize', 'sum', NULL, 'x', 'local', ${Date.now()}, ${Date.now()})`;

    expect(getEvolutionChangelog(config, sql).entries).toHaveLength(1);
    expect(getEvolutionChangelog(config, sql).unseenCount).toBe(1);
    const { seenAt } = markChangelogSeen(config);
    const after = getEvolutionChangelog(config, sql);
    expect(after.seenAt).toBe(seenAt);
    expect(after.unseenCount).toBe(0);
    db.close();
  });
});
