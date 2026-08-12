// `proteus debug <name>` — the debugging control plane. Covers both
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
  initBackgroundJobsTable, initHeadsTables, initMctsSearchTable, initRunEventTables, initSearchTables,
} from '@proteus/core';
import { makeSql } from '@proteus/cli-backend';
import { redactSecrets } from '../src/commands/debug.js';

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
  initHeadsTables(execRaw);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initBackgroundJobsTable(execRaw);
  const sql = makeSql(db);

  // ── Runs: an older plain run, then the latest — which backgrounds a call
  // and is polled anyway (agent.jobResult right after the detach handle). ──
  const recorder = new RunEventRecorder(sql);
  recorder.emit('run-old', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'first' });
  recorder.emit('run-old', { type: 'turn_end', turnIndex: 0, tokenUsage: { input: 10, output: 5 } });
  recorder.emit('run-old', { type: 'run_end', reason: 'completed' });

  recorder.emit('run-new', { type: 'run_start', agentId: 'w', caused_by: 'chat', userMessage: 'fork with mcts' });
  recorder.emit('run-new', {
    type: 'tool_call_start', name: 'agents', args: { action: 'fork', settle: 'mcts' }, toolCallId: 'tc-1',
  });
  recorder.emit('run-new', {
    type: 'tool_call_end', name: 'agents', toolCallId: 'tc-1',
    result: { background: true, jobId: 'job-1', kind: 'agents', message: `contains ${SECRET_TOKEN}` },
  });
  // The model polls the very job it was just told to stop waiting on.
  recorder.emit('run-new', {
    type: 'tool_call_start', name: 'agent', args: { jobResult: 'job-1' }, toolCallId: 'tc-2',
  });
  recorder.emit('run-new', { type: 'tool_call_end', name: 'agent', toolCallId: 'tc-2', result: { status: 'running' } });
  recorder.emit('run-new', { type: 'run_end', reason: 'completed' });

  // ── Head runs: older (failed) then newer (completed) — proves ordering. ──
  db.exec(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES ('head-old', 'first attempt', 1000)`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-old', NULL, 'head-old', 0, 'investigate', 'first attempt', 'failed', 1000, 'synthesize')`);
  db.exec(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES ('head-new', 'second attempt', 9000)`);
  db.exec(`INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES ('head-new', NULL, 'head-new', 0, 'investigate', 'second attempt', 'completed', 9000, 'synthesize')`);

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
  mcts.begin({ rootId: 'search-old', task: 'investigate', rootMsgId: 'm1', config: { budget: 1, branches: 1 }, budget: 1, now: 1000 });
  mcts.converge('search-old', 0, 1500);
  mcts.begin({ rootId: 'search-new', task: 'investigate', rootMsgId: 'm2', config: { budget: 5, branches: 3 }, budget: 5, now: 5000 });
  mcts.checkpoint('search-new', 0, 3, 5, 5300);

  // ── Background jobs: the job the run above detached and got polled. ──
  const jobs = new BackgroundJobStore(sql);
  jobs.create({ id: 'job-1', kind: 'agents', label: 'fork(settle=mcts)', input: `token=${SECRET_PROTEUS_TOKEN}`, now: 5050 });
  jobs.settle('job-1', 0, JSON.stringify({ ok: true }), 5400);

  db.close();
}

describe('proteus debug — redaction', () => {
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

describe('proteus debug — local backend', () => {
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
    expect(r.stdout).toContain('Head/fork runs (2');
    expect(r.stdout).toContain('MCTS searches (2');
    expect(r.stdout).toContain('latest vs previous: 3 vs 1 nodes, depth 2 vs 0');
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    expect(r.stdout).not.toContain(SECRET_PROTEUS_TOKEN);

    // The bundle file: owner-only permissions, and never the raw secrets —
    // the hard requirement, asserted directly against the written bytes.
    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    const raw = readFileSync(bundle, 'utf8');
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(SECRET_PROTEUS_TOKEN);
    expect(raw).toContain('[REDACTED]');

    const records = raw.trim().split('\n').map((l) => JSON.parse(l) as { t: string });
    const counts = new Map<string, number>();
    for (const rec of records) counts.set(rec.t, (counts.get(rec.t) ?? 0) + 1);
    expect(counts.get('run')).toBe(2);
    expect(counts.get('head_run')).toBe(2);
    expect(counts.get('mcts_search_run')).toBe(2);
    expect(counts.get('mcts_node')).toBe(4);
    expect(counts.get('background_job')).toBe(1);
    expect(counts.get('end')).toBe(1);
    // Full per-run event fidelity — the richest source, verbatim.
    const runEvents = records.filter((r2) => r2.t === 'run_event') as unknown as Array<{ runId: string; type: string }>;
    expect(runEvents.filter((e) => e.runId === 'run-new').map((e) => e.type)).toEqual([
      'run_start', 'tool_call_start', 'tool_call_end', 'tool_call_start', 'tool_call_end', 'run_end',
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
    const summary = JSON.parse(r.stdout) as {
      runs: Array<{ runId: string; jobPollsAfterHandle: number }>;
      mctsSearches: Array<{ rootId: string; nodeCount: number; maxDepth: number }>;
    };
    const newRun = summary.runs.find((run) => run.runId === 'run-new');
    expect(newRun?.jobPollsAfterHandle).toBe(1);
    const [latest, previous] = summary.mctsSearches;
    expect(latest).toMatchObject({ rootId: 'search-new', nodeCount: 3, maxDepth: 2 });
    expect(previous).toMatchObject({ rootId: 'search-old', nodeCount: 1, maxDepth: 0 });
    expect(JSON.stringify(summary)).not.toContain(SECRET_TOKEN);
  });
});

describe('proteus debug — cloud backend', () => {
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
        const body = await request.json() as { method: string; args: unknown[] };
        calls.push(body.method);
        const respond = (result: unknown) => Response.json({ result });
        switch (body.method) {
          case 'getWorkspaceSnapshot': return respond({ status: { displayName: 'skywriter', purpose: 'p', scaffoldVersion: 1, model: 'x' } });
          case 'getChatHistory': return respond([{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }]);
          case 'listRuns': return respond([{ runId: 'run-cloud', lastTs: new Date(1000).toISOString(), eventCount: 2 }]);
          case 'getRunEvents': {
            const [, opts] = body.args as [string, { since: number }];
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
