// `kinu debug <name>` — the debugging control plane. Covers both
// backends (a hand-seeded local workspace, and a stub cloud origin), the
// exact scenario the read-vs-write MCTS investigation turns on (two search
// runs, the older one sorting first by created_at — reproducing what the
// web UI's client-side buildTree() picks when it is not scoped by root_id),
// and the hard requirement: a planted secret must never appear in the bundle.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  BackgroundJobStore, MctsSearchStore, RunEventRecorder,
  JsonArraySchema, JsonObjectSchema, JsonValueSchema, UsageSchema, type JsonValue,
  initBackgroundJobsTable, initExplorationRecordsTable, initHeadsTables, initMctsSearchTable,
  initRunEventTables, initSearchTables, recordExploration,
  type ExplorationWrite, type ObjectiveIdentity,
} from '@kinu/core';
import { makeSql } from '@kinu/cli-backend';
import { redactSecrets } from '../src/commands/debug';
import * as v from 'valibot';

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(home: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, cliBin, ...args], {
    cwd,
    env: { ...process.env, PROTEUS_HOME: home, NO_COLOR: '1', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function result(proc: ReturnType<typeof runCli>) {
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

const SECRET_TOKEN = 'sk-ant-api03-thisisaplantedsecretfortest1234567890abcdefgh';
const SECRET_PROTEUS_TOKEN = 'pta_' + 'x'.repeat(40);

/**
 * A workspace with exactly the shape the investigation needs: two runs (one
 * that backgrounded a call and was then polled anyway — symptom 1 — and a
 * plain one), two head-runs (older + newer, proving `getHeadRuns` orders
 * correctly), and two MCTS searches where the OLDER root has the lower
 * created_at — the precise condition under which use-proteus.ts's client
 * buildTree() (no root_id scoping, picks whichever depth-0 node sorts first)
 * would show the wrong tree. A secret is planted in a tool result.
 */
function seedInvestigationWorkspace(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  const execRaw = (sql: string) => { db.exec(sql); };
  initRunEventTables(execRaw);
  initHeadsTables(execRaw, makeSql(db));
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw, makeSql(db));
  initBackgroundJobsTable(execRaw, makeSql(db));
  const sql = makeSql(db);

  // ── Runs: an older plain run, then the latest — which backgrounds a call
  // and is polled anyway (agent.jobResult right after the detach handle). ──
  const recorder = new RunEventRecorder(sql);
  recorder.emit('run-old', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'first' });
  recorder.emit('run-old', { type: 'turn_end', turnIndex: 0, usage: { input: 10, output: 5 } });
  // A second turn on the same run whose provider reported nothing at all — the
  // shape that used to disappear into `tokensIn += 0` and read as a free turn.
  recorder.emit('run-old', { type: 'turn_end', turnIndex: 1 });
  recorder.emit('run-old', { type: 'run_end', reason: 'completed' });

  recorder.emit('run-new', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'fork with mcts' });
  recorder.emit('run-new', {
    type: 'tool_call_end', name: 'agents', args: { action: 'fork', settle: 'mcts' }, toolCallId: 'tc-1',
    result: { background: true, jobId: 'job-1', kind: 'agents', message: `contains ${SECRET_TOKEN}` },
  });
  // The model polls the very job it was just told to stop waiting on.
  recorder.emit('run-new', {
    type: 'tool_call_end', name: 'agent', args: { jobResult: 'job-1' }, toolCallId: 'tc-2',
    result: { status: 'running' },
  });
  recorder.emit('run-new', { type: 'run_end', reason: 'completed' });

  // ── Head runs: older (failed) then newer (completed) — proves ordering. ──
  db.exec(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES ('head-old', 'first attempt', 1000)`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-old', NULL, 'head-old', 0, 'investigate', 'first attempt', 'failed', 1000, 'synthesize')`);
  db.exec(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES ('head-new', 'second attempt', 9000)`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-new', NULL, 'head-new', 0, 'investigate', 'second attempt', 'completed', 9000, 'synthesize')`);
  // A THIRD, real split with two actual child heads (id != root_id, unlike
  // the synthetic self-referencing rows above) — one settled, one still
  // running — the shape the new "N/M settled" progress readout is for.
  db.exec(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES ('head-live', 'third attempt', 12000)`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-live-a', NULL, 'head-live', 0, 'investigate A', 'branch a', 'completed', 12000, 'synthesize')`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-live-b', NULL, 'head-live', 0, 'investigate B', 'branch b', 'running', 12100, 'synthesize')`);

  // ── MCTS: the OLDER search's root sorts FIRST (lower created_at, same
  // depth 0) — exactly what the unscoped client buildTree() would return,
  // discarding every node of the real latest search. ──
  const insertNode = db.query(`INSERT INTO search_nodes
    (id, parent_id, root_id, task, action, visits, value, depth, status, created_at)
    VALUES (?, ?, ?, 'investigate', ?, 1, 0.5, ?, 'open', ?)`);
  insertNode.run('search-old-root', null, 'search-old', 'root', 0, 1000);
  insertNode.run('search-new-root', null, 'search-new', 'root', 0, 5000);
  insertNode.run('search-new-c1', 'search-new-root', 'search-new', 'branch a', 1, 5100);
  insertNode.run('search-new-c2', 'search-new-c1', 'search-new', 'branch a.1', 2, 5200);

  const mcts = new MctsSearchStore(sql);
  mcts.begin({ rootId: 'search-old', task: 'investigate', engine: 'mcts', rootMsgId: 'm1', config: { budget: 1, branches: 1 }, budget: 1, now: 1000 });
  mcts.converge('search-old', 0, 1500);
  // budget=10, checkpointed at iteration=6/budget-remaining=4 — the SAME
  // invariant mcts/engine.ts holds by construction (iteration + remaining
  // budget == the original total), and the exact shape that used to render
  // as the misleading "iter=6/4" fraction (looks like an overrun) instead of
  // "iter=6/10 (4 left)".
  mcts.begin({ rootId: 'search-new', task: 'investigate', engine: 'mcts', rootMsgId: 'm2', config: { budget: 10, branches: 3 }, budget: 10, now: 5000 });
  mcts.checkpoint('search-new', 0, 6, 4, 5300);

  // ── Background jobs: the job the run above detached and got polled, PLUS
  // one still running — the exact shape a 12-hour-old job with no visible
  // progress needs a duration/heartbeat readout for. ──
  // job-1 is the call that run recorded, from before tree search moved to
  // `action:'swarm'`: its label is the form jobs/runner.ts wrote back then,
  // `fork(settle=<policy>): <task>`. The bundle reads history, so it has to
  // keep printing rows naming a settle no current call can produce.
  const jobs = new BackgroundJobStore(sql);
  jobs.create({
    id: 'job-1', kind: 'agents', workMode: 'build',
    label: 'fork(settle=mcts): pick a migration-backfill approach',
    input: `token=${SECRET_PROTEUS_TOKEN}`, now: 5050,
  });
  jobs.settle('job-1', 0, JSON.stringify({ ok: true }), 5050 + 125_000);
  jobs.create({ id: 'job-2', kind: 'agents', workMode: 'build', input: '{}', now: 5060 });

  // ── The records store: two comparable sets, one unfloored with NO descriptor
  // partition and one partitioned across three cells, five occupants in the
  // largest. Written through the real writer, because the identity columns the
  // bundle prints are only trustworthy as something that writer filled. ──
  initExplorationRecordsTable(execRaw, sql);
  const CALLS: ObjectiveIdentity = {
    metric: 'oracle_calls', unit: 'oracle calls', direction: 'minimise',
    scale: 'log', verifierDigest: 'exec-ratio@abc123',
  };
  const PASS: ObjectiveIdentity = {
    metric: 'pass_rate', unit: 'fraction of held-out tasks', direction: 'maximise',
    scale: 'linear', verifierDigest: 'suite@f00d',
  };
  const record = (over: Partial<ExplorationWrite>): void => {
    recordExploration(sql, {
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
  test('redactSecrets scrubs every planted secret shape', () => {
    expect(redactSecrets(`bearer ${SECRET_PROTEUS_TOKEN}`)).not.toContain(SECRET_PROTEUS_TOKEN);
    expect(redactSecrets(SECRET_TOKEN)).not.toContain(SECRET_TOKEN);
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redactSecrets('{"api_key": "verysecretvalue1234"}')).toContain('[REDACTED]');
    expect(redactSecrets('{"api_key": "verysecretvalue1234"}')).not.toContain('verysecretvalue1234');
    expect(redactSecrets('plain text with no secrets')).toBe('plain text with no secrets');
  });
});

describe('kinu debug — local backend', () => {
  test('assembles identity, runs, heads, mcts searches and background jobs into one bundle, and never leaks the planted secret', async () => {
    const home = scratch('proteus-debug-local-');
    const out = scratch('proteus-debug-local-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: {}, aliases: {} }));
    mkdirSync(join(home, 'invest'), { recursive: true });
    seedInvestigationWorkspace(join(home, 'invest', 'agent.db'));

    const bundle = join(out, 'invest.debug.jsonl');
    const r = await result(runCli(home, ['debug', 'invest', '--out', bundle], repoRoot));
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);

    // Human summary surfaces the exact four-symptom signal.
    expect(r.stdout).toContain('Runs (2)');
    expect(r.stdout).toContain('polled job 1x after backgrounding');
    expect(r.stdout).toContain('Head/fork runs (3');
    expect(r.stdout).toContain('(1/2 settled)'); // head-live: one head done, one still running
    expect(r.stdout).toContain('MCTS searches (2');
    expect(r.stdout).toContain('latest vs previous: 3 vs 1 nodes, depth 2 vs 0');
    // The overrun-audit fix (2026-08-12): iteration + remaining budget is the
    // search's true total (10), not a fraction that can look exceeded — the
    // exact "iter=34/26 looks like an overrun" shape from production.
    expect(r.stdout).toContain('iter=6/10 (4 left)');
    expect(r.stdout).not.toContain('iter=6/4'); // the old, misleading fraction must be gone
    expect(r.stdout).toMatch(/checkpointed \d+d(?: \d+h)? ago/); // running search: the one real heartbeat
    expect(r.stdout).toContain('iter=0/1 (1 left)'); // search-old: converged, never checkpointed past begin()
    // Background jobs: a settled job's real duration (deterministic — both
    // timestamps are fixture data, not wall-clock) and its descriptive label,
    // plus a still-running job's duration made explicit rather than left for
    // the operator to compute from a bare created_at timestamp.
    expect(r.stdout).toContain('took 2m');
    expect(r.stdout).toContain('fork(settle=mcts): pick a migration-backfill approach');
    expect(r.stdout).toMatch(/job-2 agents running — running \d+d(?: \d+h)?/);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    // The leaderboard line carries the UNIT and the direction's arrow. A bare real
    // is the defect: 25.4% read as a reward level when it was a delta.
    expect(r.stdout).toContain('Exploration records (2 comparable set(s)');
    expect(r.stdout).toContain('best ↑0.71 fraction of held-out tasks');
    expect(r.stdout).toContain('best ↓23 oracle calls');
    expect(r.stdout).toContain('3 row(s) over 1 cell(s)');
    expect(r.stdout).toContain('7 row(s) over 3 cell(s)');
    expect(r.stdout).not.toContain(SECRET_PROTEUS_TOKEN);

    // The bundle file: owner-only permissions, and never the raw secrets —
    // the hard requirement, asserted directly against the written bytes.
    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    const raw = readFileSync(bundle, 'utf8');
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(SECRET_PROTEUS_TOKEN);
    expect(raw).toContain('[REDACTED]');

    const records = raw.trim().split('\n').map((line) => v.parse(
      v.objectWithRest({ t: v.string() }, JsonValueSchema), JSON.parse(line),
    ));
    const counts = new Map<string, number>();
    for (const rec of records) counts.set(rec.t, (counts.get(rec.t) ?? 0) + 1);
    expect(counts.get('run')).toBe(2);
    expect(counts.get('head_run')).toBe(3);
    expect(counts.get('mcts_search_run')).toBe(2);
    expect(counts.get('mcts_node')).toBe(4);
    expect(counts.get('background_job')).toBe(2);
    expect(counts.get('end')).toBe(1);
    // The records store: 2 comparable sets, 1 + 3 cells, 3 + 7 occupants. The
    // occupant count is the WALK's total — the reads are paged, so a cell whose
    // rows arrived in more than one page would still have to total exactly its
    // population, once each.
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
    // `descriptor: null` survives the bundle as null — the NO-PARTITION cell, not
    // an unnamed one and not a dropped field.
    expect(rows.filter((row) => row.descriptor === null)).toHaveLength(3);
    expect(rows.filter((row) => row.descriptor === 'len=short')).toHaveLength(5);
    // Full per-run event fidelity — the richest source, verbatim.
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
    const home = scratch('proteus-debug-json-');
    const out = scratch('proteus-debug-json-out-');
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
    // Both counters read `tool_call_end` — the row production writes. Seeded as
    // `tool_call_start` these were 2 and 1 in this test and 0 and 0 on every
    // real run, because nothing has ever emitted that type.
    expect(newRun?.toolCalls).toBe(2);
    expect(newRun?.jobPollsAfterHandle).toBe(1);
    // What the bundle now says a run cost. The seeded run reported input and
    // output on one turn and nothing on the next, so the accumulated usage
    // carries exactly those two fields — `cacheRead` absent, not 0 — and the
    // silent turn is counted rather than folded in as free.
    const oldRun = summary.runs.find((run) => run.runId === 'run-old');
    expect(oldRun?.usage).toEqual({ input: 10, output: 5 });
    expect(Object.keys(oldRun?.usage ?? {}).sort()).toEqual(['input', 'output']);
    expect(oldRun?.turnsWithoutUsage).toBe(1);
    // A run with no turn_end at all reports no usage: an empty object, not zeros.
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
        const respond = (result: JsonValue) => Response.json({ result });
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
          case 'getReleaseBoard': return respond({ changes: [] });
          case 'listTriggers': return respond({ triggers: [] });
          case 'getToolDescriptions': return respond({ builtIn: [], crafted: [], executors: [] });
          case 'getFacts': return respond([]);
          case 'getMemoryContent': return respond('');
          case 'getActivitySnapshot': return respond({ latest: null, log: [] });
          default: return Response.json({ error: `unhandled ${body.method}` }, { status: 404 });
        }
      },
    });

    const home = scratch('proteus-debug-cloud-');
    const out = scratch('proteus-debug-cloud-out-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: `http://127.0.0.1:${server.port}`,
      accessToken: 'ptc_stored_session',
      agents: { skywriter: { name: 'skywriter', mode: 'cloud', cloudName: 'skywriter', createdAt: '', updatedAt: '' } },
      aliases: {},
    }));

    try {
      const bundle = join(out, 'skywriter.debug.jsonl');
      const r = await result(runCli(home, ['debug', 'skywriter', '--out', bundle], repoRoot, {
        PROTEUS_ORIGIN: `http://127.0.0.1:${server.port}`,
      }));
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('skywriter');
      expect(r.stdout).toContain('Runs (1)');

      // The two RPCs that had NO remote read path before this command needed
      // them (see rpc-gate.ts) were actually called, not silently skipped.
      expect(calls).toContain('listRuns');
      expect(calls).toContain('getRunEvents');
      expect(calls).toContain('getMctsSearchRuns');

      const raw = readFileSync(bundle, 'utf8');
      expect(raw).not.toContain(SECRET_TOKEN);
      expect(raw).toContain('[REDACTED]');
    } finally {
      server.stop(true);
    }
  });
});
