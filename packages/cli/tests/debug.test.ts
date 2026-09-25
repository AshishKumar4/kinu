// `kinu debug <name>` over a local and a stub cloud backend; a planted secret must never reach the bundle.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  BackgroundJobStore, MctsSearchStore, RunEventRecorder,
  JsonArraySchema, JsonObjectSchema, JsonValueSchema, UsageSchema, type JsonValue,
  initBackgroundJobsTable, initExplorationRecordsTable, initHeadsTables, initMctsSearchTable,
  initRunEventTables, initSearchTables, recordExploration,
  type ExplorationWrite, type ObjectiveIdentity,
} from '@kinu.run/core';
import { makeSql } from '@kinu.run/cli-backend';
import { scratchDir, createTestActorsOver } from '@kinu.run/test-utils';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

function scratch(prefix: string): string {
  const dir = scratchDir(prefix);

  return dir;
}

function runCli(home: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, cliBin, ...args], {
    cwd,
    env: { ...process.env, KINU_HOME: home, NO_COLOR: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function result(proc: ReturnType<typeof runCli>) {
  const exitCode = await proc.exited;

  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

const SECRET_TOKEN = ['sk-ant-', 'api03-thisisaplantedsecretfortest1234567890abcdefgh'].join('');

const SECRET_KINU_TOKEN = 'pta_' + 'x'.repeat(40);

const AKIA = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const BEARER_SECRET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Two runs (one polls a job it backgrounded), two head-runs, and two MCTS searches whose older
 * root sorts first by created_at, where an unscoped client buildTree() shows the wrong tree.
 */
function seedInvestigationWorkspace(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  const execRaw = (sql: string) => { db.exec(sql); };

  initRunEventTables(execRaw);
  initHeadsTables(execRaw);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initBackgroundJobsTable(execRaw);
  const sql = makeSql(db);
  // Rows must belong to the workspace main actor (`openWorkspaceMainActor`), so the seed registers a real identity.
  const actor = createTestActorsOver(db, { name: 'invest' }).main;

  const recorder = new RunEventRecorder(sql, actor);
  recorder.emit('run-old', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'first' });
  recorder.emit('run-old', { type: 'turn_end', turnIndex: 0, usage: { input: 10, output: 5 } });
  // A turn whose provider reported nothing must not read as a free turn.
  recorder.emit('run-old', { type: 'turn_end', turnIndex: 1 });
  recorder.emit('run-old', { type: 'run_end', reason: 'completed' });

  recorder.emit('run-new', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'fork with mcts' });
  recorder.emit('run-new', {
    type: 'tool_call_end', name: 'agents', args: { action: 'fork', settle: 'mcts' }, toolCallId: 'tc-1',
    outcome: { success: true }, result: { background: true, jobId: 'job-1', kind: 'agents', message: 'contains ' + SECRET_TOKEN },
  });
  recorder.emit('run-new', {
    type: 'tool_call_end', name: 'agent', args: { jobResult: 'job-1' }, toolCallId: 'tc-2',
    outcome: { success: true }, result: { status: 'running' },
  });
  recorder.emit('run-new', { type: 'run_end', reason: 'completed' });

  db.exec(`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES ('${actor.actorId}', 'head-old', 'first attempt', 1000)`);
  db.exec(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('${actor.actorId}', 'head-old', NULL, 'head-old', 0, 'investigate', 'first attempt', 'failed', 1000, 'synthesize')`);
  db.exec(`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES ('${actor.actorId}', 'head-new', 'second attempt', 9000)`);
  db.exec(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('${actor.actorId}', 'head-new', NULL, 'head-new', 0, 'investigate', 'second attempt', 'completed', 9000, 'synthesize')`);
  db.exec(`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES ('${actor.actorId}', 'head-live', 'third attempt', 12000)`);
  db.exec(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('${actor.actorId}', 'head-live-a', NULL, 'head-live', 0, 'investigate A', 'branch a', 'completed', 12000, 'synthesize')`);
  db.exec(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('${actor.actorId}', 'head-live-b', NULL, 'head-live', 0, 'investigate B', 'branch b', 'running', 12100, 'synthesize')`);

  // The older search's root sorts first, as the unscoped buildTree() would pick.
  const insertNode = db.query(`INSERT INTO search_nodes
    (actor_id, id, parent_id, root_id, task, action, visits, value, depth, status, created_at)
    VALUES (?, ?, ?, ?, 'investigate', ?, 1, 0.5, ?, 'open', ?)`);

  insertNode.run(actor.actorId, 'search-old-root', null, 'search-old', 'root', 0, 1000);
  insertNode.run(actor.actorId, 'search-new-root', null, 'search-new', 'root', 0, 5000);
  insertNode.run(actor.actorId, 'search-new-c1', 'search-new-root', 'search-new', 'branch a', 1, 5100);
  insertNode.run(actor.actorId, 'search-new-c2', 'search-new-c1', 'search-new', 'branch a.1', 2, 5200);

  const mcts = new MctsSearchStore(sql, actor);
  mcts.begin({ rootId: 'search-old', task: 'investigate', engine: 'mcts', rootMsgId: 'm1', config: { budget: 1, branches: 1 }, budget: 1, now: 1000 });
  mcts.converge('search-old', 0, 1500);
  // iteration + remaining == budget (the mcts/engine.ts invariant), rendered as "iter=6/10 (4 left)".
  mcts.begin({ rootId: 'search-new', task: 'investigate', engine: 'mcts', rootMsgId: 'm2', config: { budget: 10, branches: 3 }, budget: 10, now: 5000 });
  mcts.checkpoint('search-new', 0, { iteration: 6, budget: 4, now: 5300 });

  // A historical `fork(settle=<policy>): <task>` label; the bundle must still print it.
  const jobs = new BackgroundJobStore(sql, actor);
  jobs.create({
    id: 'job-1', kind: 'agents', workMode: 'build',
    label: 'fork(settle=mcts): pick a migration-backfill approach',
    input: `token=${SECRET_KINU_TOKEN}`, now: 5050,
  });
  jobs.settle('job-1', 0, JSON.stringify({ ok: true }), 5050 + 125_000);
  jobs.create({
    id: 'job-2', kind: 'agents', workMode: 'build',
    input: `{"api_key": "verysecretvalue1234"} ${AKIA} Authorization: Bearer ${BEARER_SECRET}`,
    now: 5060,
  });

  // Written through the real writer: the identity columns the bundle prints are only trustworthy from it.
  initExplorationRecordsTable(execRaw);

  const CALLS: ObjectiveIdentity = {
    metric: 'oracle_calls', unit: 'oracle calls', direction: 'minimise',
    scale: 'log', verifierDigest: 'exec-ratio@abc123',
  };

  const PASS: ObjectiveIdentity = {
    metric: 'pass_rate', unit: 'fraction of held-out tasks', direction: 'maximise',
    scale: 'linear', verifierDigest: 'suite@f00d',
  };

  const record = (over: Partial<ExplorationWrite>): void => {
    recordExploration(sql, actor, {
      publication: { kind: 'open' },
      write: {
        identity: CALLS, descriptor: null, artifact: 'solve()', value: 23,
        detail: '23 calls', measured: null, preset: 'optimise', label: null,
        rootId: 'search-new', configDigest: 'cfg-1', depth: 5, branches: 3,
        floor: null, costUsd: null, costTokens: null, at: 20_000, ...over,
      },
    });
  };

  for (const [index, value] of [41, 23, 88].entries()) {
    record({ artifact: `calls-${String(index)}`, value, at: 20_000 + index });
  }

  const cells: ReadonlyArray<readonly [string, number]> = [
    ['len=short', 0.71], ['len=short', 0.5], ['len=short', 0.44], ['len=short', 0.4],
    ['len=short', 0.39], ['len=medium', 0.66], ['len=long', 0.6],
  ];

  for (const [index, [descriptor, value]] of cells.entries()) {
    record({
      identity: PASS, descriptor, value, at: 21_000 + index,
      artifact: `pass artifact ${String(index)} unique tokens ${String(index)}`,
    });
  }

  db.close();
}

describe('kinu debug — redaction', () => {
  test('the bundle scrubs every planted secret shape but keeps the surrounding rows', async () => {
    const home = scratch('kinu-debug-redact-');
    const out = scratch('kinu-debug-redact-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    mkdirSync(join(home, 'invest'), { recursive: true });
    seedInvestigationWorkspace(join(home, 'invest', 'agent.db'));

    const bundle = join(out, 'invest.debug.jsonl');
    const r = await result(runCli(home, ['debug', 'invest', '--out', bundle], repoRoot));
    expect(r.exitCode).toBe(0);

    const raw = readFileSync(bundle, 'utf8');
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(SECRET_KINU_TOKEN);
    expect(raw).not.toContain(AKIA);
    expect(raw).not.toContain(BEARER_SECRET);
    expect(raw).not.toContain('verysecretvalue1234');
    expect(raw).toContain('[REDACTED]');
    expect(raw).toContain('job-2');
    expect(raw).toContain('pick a migration-backfill approach');
  });
});

describe('kinu debug — local backend', () => {
  test('assembles identity, runs, heads, mcts searches and background jobs into one bundle, and never leaks the planted secret', async () => {
    const home = scratch('kinu-debug-local-');
    const out = scratch('kinu-debug-local-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    mkdirSync(join(home, 'invest'), { recursive: true });
    seedInvestigationWorkspace(join(home, 'invest', 'agent.db'));

    const bundle = join(out, 'invest.debug.jsonl');
    const r = await result(runCli(home, ['debug', 'invest', '--out', bundle], repoRoot));
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);

    expect(r.stdout).toContain('Runs (2)');
    expect(r.stdout).toContain('polled job 1x after backgrounding');
    expect(r.stdout).toContain('Head/fork runs (3');
    expect(r.stdout).toContain('(1/2 settled)');
    expect(r.stdout).toContain('MCTS searches (2');
    expect(r.stdout).toContain('latest vs previous: 3 vs 1 nodes, depth 2 vs 0');
    expect(r.stdout).toContain('iter=6/10 (4 left)');
    expect(r.stdout).not.toContain('iter=6/4');
    expect(r.stdout).toMatch(/checkpointed \d+d(?: \d+h)? ago/);
    expect(r.stdout).toContain('iter=0/1 (1 left)');
    expect(r.stdout).toContain('took 2m');
    expect(r.stdout).toContain('fork(settle=mcts): pick a migration-backfill approach');
    expect(r.stdout).toMatch(/job-2 agents running for \d+d(?: \d+h)?/);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    // The leaderboard line carries the unit and direction arrow; a bare real reads as a level, not a delta.
    expect(r.stdout).toContain('Exploration records (2 comparable set(s)');
    expect(r.stdout).toContain('best ↑0.71 fraction of held-out tasks');
    expect(r.stdout).toContain('best ↓23 oracle calls');
    expect(r.stdout).toContain('3 row(s) over 1 cell(s)');
    expect(r.stdout).toContain('7 row(s) over 3 cell(s)');
    expect(r.stdout).not.toContain(SECRET_KINU_TOKEN);

    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    const raw = readFileSync(bundle, 'utf8');
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(SECRET_KINU_TOKEN);
    expect(raw).toContain('[REDACTED]');

    const records = raw.trim().split('\n').map((line) => v.parse(
      v.objectWithRest({ t: v.string() }, JsonValueSchema), JSON.parse(line),
    ));

    const counts = new Map<string, number>();

    for (const rec of records) counts.set(rec.t, (counts.get(rec.t) ?? 0) + 1);
    expect(counts.get('shell')).toBe(2);
    expect(counts.get('head_run')).toBe(3);
    expect(counts.get('mcts_search_run')).toBe(2);
    expect(counts.get('mcts_node')).toBe(4);
    expect(counts.get('background_job')).toBe(2);
    expect(counts.get('end')).toBe(1);
    // Reads are paged; a cell split across pages must still total its population exactly once.
    expect(counts.get('record_objective')).toBe(2);
    expect(counts.get('record_cell')).toBe(4);
    expect(counts.get('record')).toBe(10);

    const RecordRowSchema = v.object({
      t: v.literal('record'), descriptor: v.nullable(v.string()),
      artifactDigest: v.string(), value: v.number(),
    });

    const rows = records.flatMap((record) => {
      const parsed = v.safeParse(RecordRowSchema, record);

      return parsed.success ? [parsed.output] : [];
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.artifactDigest)).size).toBe(rows.length);
    // `descriptor: null` is the no-partition cell, kept as null.
    expect(rows.filter((row) => row.descriptor === null)).toHaveLength(3);
    expect(rows.filter((row) => row.descriptor === 'len=short')).toHaveLength(5);
    const RunEventSchema = v.object({ t: v.literal('run_event'), runId: v.string(), type: v.string() });

    const runEvents = records.flatMap((record) => {
      const event = v.safeParse(RunEventSchema, record);

      return event.success ? [event.output] : [];
    });

    expect(runEvents.filter((e) => e.runId === 'run-new').map((e) => e.type)).toEqual([
      'run_start', 'tool_call_end', 'tool_call_end', 'run_end',
    ]);
  });

  test('--json prints the same investigation summary as machine-readable JSON', async () => {
    const home = scratch('kinu-debug-json-');
    const out = scratch('kinu-debug-json-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    mkdirSync(join(home, 'invest'), { recursive: true });
    seedInvestigationWorkspace(join(home, 'invest', 'agent.db'));

    const r = await result(runCli(home, ['debug', 'invest', '--out', join(out, 'b.jsonl'), '--json'], repoRoot));
    expect(r.exitCode).toBe(0);

    const summary = v.parse(v.object({
      runs: v.array(v.object({
        runId: v.string(), toolCalls: v.number(), jobPollsAfterHandle: v.number(),
        usage: UsageSchema, turnsWithoutUsage: v.number(),
      })),
      mctsSearches: v.array(v.object({ rootId: v.string(), nodeCount: v.number(), maxDepth: v.number() })),
    }), JSON.parse(r.stdout));

    const newRun = summary.runs.find((run) => run.runId === 'run-new');
    // Both counters read `tool_call_end`, the row production writes; nothing emits `tool_call_start`.
    expect(newRun?.toolCalls).toBe(2);
    expect(newRun?.jobPollsAfterHandle).toBe(1);
    // Accumulated usage carries only reported fields (`cacheRead` absent, not 0); the silent turn is counted.
    const oldRun = summary.runs.find((run) => run.runId === 'run-old');
    expect(oldRun?.usage).toEqual({ input: 10, output: 5 });
    expect(Object.keys(oldRun?.usage ?? {}).sort()).toEqual(['input', 'output']);
    expect(oldRun?.turnsWithoutUsage).toBe(1);
    expect(newRun?.usage).toEqual({});
    expect(newRun?.turnsWithoutUsage).toBe(0);
    const [latest, previous] = summary.mctsSearches;
    expect(latest).toMatchObject({ rootId: 'search-new', nodeCount: 3, maxDepth: 2 });
    expect(previous).toMatchObject({ rootId: 'search-old', nodeCount: 1, maxDepth: 0 });
    expect(JSON.stringify(summary)).not.toContain(SECRET_TOKEN);
  });
});

describe('kinu debug — cloud backend', () => {
  test('walks the same sections over RPC, using the newly-exposed getRunEvents/listRuns/getMctsSearchRuns', async () => {
    const calls: string[] = [];

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== '/api/cli/workspaces/skywriter/rpc') return new Response('nope', { status: 404 });

        if (request.headers.get('authorization') !== 'Bearer ptc_stored_session') {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        const body = v.parse(JsonObjectSchema, await request.json());
        const method = v.parse(v.string(), body.method);
        const args = v.parse(JsonArraySchema, body.args);
        calls.push(method);
        const respond = (value: JsonValue) => Response.json({ result: value });

        switch (method) {
          case 'getWorkspaceSnapshot': return respond({ status: { displayName: 'skywriter', purpose: 'p', scaffoldVersion: 1, model: 'x' } });
          case 'getChatHistoryPage': return respond({ status: 'end', items: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }] });
          case 'listRuns': return respond({ status: 'end', items: [{ runId: 'run-cloud', lastTs: new Date(1000).toISOString(), eventCount: 2 }] });
          case 'getRunEvents': {
            const opts = v.parse(v.object({ since: v.number() }), args[1]);

            if (opts.since > 0) return respond([]);

            return respond([
              { type: 'run_start', eventIndex: 0, runId: 'run-cloud', timestamp: new Date(1000).toISOString(), caused_by: 'chat' },
              {
                type: 'tool_call_end', eventIndex: 1, runId: 'run-cloud', timestamp: new Date(1001).toISOString(),
                name: 'exec', toolCallId: 't1', result: `secret=${SECRET_TOKEN}`,
              },
            ]);
          }

          case 'getHeadRuns': return respond([]);
          case 'getMctsSearchRuns': return respond([]);
          case 'getMctsTree': return respond([]);
          case 'listBackgroundJobs': return respond([]);
          case 'getEvolutionChangelog': return respond({ entries: [], unseenCount: 0, seenAt: 0 });
          case 'listScaffoldVersions': return respond([]);
          case 'getGepaRuns': return respond([]);
          case 'listTriggers': return respond({ triggers: [] });
          case 'getToolDescriptions': return respond({ builtIn: [], crafted: [], executors: [] });
          case 'getFacts': return respond([]);
          case 'getMemoryContent': return respond('');
          case 'getActivitySnapshot': return respond({ latest: null, log: [] });
          default: return Response.json({ error: `unhandled ${method}` }, { status: 404 });
        }
      },
    });

    const home = scratch('kinu-debug-cloud-');
    const out = scratch('kinu-debug-cloud-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_stored_session',
      agents: { skywriter: { name: 'skywriter', mode: 'cloud', cloudName: 'skywriter', createdAt: '', updatedAt: '' } },
      aliases: {},
    }));

    try {
      const bundle = join(out, 'skywriter.debug.jsonl');

      const r = await result(runCli(home, ['debug', 'skywriter', '--out', bundle], repoRoot, {
        KINU_ORIGIN: `http://127.0.0.1:${server.port}`,
      }));

      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('skywriter');
      expect(r.stdout).toContain('identity  skywriter: p');
      expect(r.stdout).toContain('scaffold  v1  x');
      expect(r.stdout).toContain('Runs (1)');

      expect(calls).toContain('listRuns');
      expect(calls).toContain('getRunEvents');
      expect(calls).toContain('getMctsSearchRuns');

      const raw = readFileSync(bundle, 'utf8');
      expect(raw).not.toContain(SECRET_TOKEN);
      expect(raw).toContain('[REDACTED]');
    } finally {
      await server.stop(true);
    }
  });
});
