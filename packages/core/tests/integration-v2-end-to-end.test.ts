/** v2 end-to-end: inline executor, branching heads, scaffold shadow rollout, durable event log, approval gate. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createInlineExecutor,
  HeadController, HeadJournal, initHeadsTables,
  type HeadInput, type HeadReport, type HeadRuntime, type SpawnedHead,
  type SerializedMessage, type SplitRequest, type MergeOutput,
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision, readScaffoldVersion,
  DEFAULT_SHADOW_CONFIG, recordShadowEvaluation,
  initScaffoldTables, modifyScaffold,
  initRunEventTables, RunEventRecorder,
  reviewCommand, gateExec,
} from '../src/index';
import { present, testActorHandle } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw, createTestRuntime, createTestActor } from './helpers';

interface HeadReportIndex {
  [headId: string]: HeadReport;
}

describe('v2 e2e: workspace executor via createInlineExecutor', () => {
  test('writeFile + readFile + exec round-trip through ExecutorProvider tools', async () => {
    const { rt } = createTestRuntime();

    const provider = createInlineExecutor({
      vfs: rt.storage.vfs, memory: rt.memory, craftStore: rt.craftStore,
      shell: { exec: async (cmd) => cmd.includes('echo hi')
        ? { stdout: 'hi\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 } },
      sql: rt.storage.sql,
    });

    expect(provider.name).toBe('workspace');
    expect(provider.kind).toBe('workspace');
    expect(provider.capabilities.has('shell')).toBe(true);

    await provider.tools.writeFile.execute('/a.txt', 'hello');
    expect(await provider.tools.readFile.execute('/a.txt')).toBe('hello');
    expect(await provider.tools.exec.execute('echo hi')).toBe('hi\n');
  });
});

describe('v2 e2e: branching heads → merge', () => {
  test('split 3 heads, await all, merge with deterministic mock LLM', async () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    initHeadsTables(execRaw);
    const sql = makeSql(db);
    const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'e2e-heads');
    const journal = new HeadJournal(sql, actor);

    const headReports: HeadReportIndex = {
      'survey': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Survey finding: 3 prior impls exist, all use the X pattern.',
        evidence: [{ id: 'e1', kind: 'fact', body: 'prior art' }],
        decisions: [{ question: 'use X pattern?', choice: 'yes', rationale: 'standard' }],
        artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
        usage: { input: 100, output: 80 }, wallClockMs: 120,
      },
      'design': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Design sketch: minimal struct, no abstractions.',
        evidence: [{ id: 'e2', kind: 'fact', body: 'simple > clever' }],
        decisions: [{ question: 'add abstraction?', choice: 'no', rationale: 'YAGNI' }],
        artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
        usage: { input: 120, output: 90 }, wallClockMs: 180,
      },
      'risks': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Failure modes: connection drops, race on init.',
        evidence: [{ id: 'e3', kind: 'fact', body: 'race condition' }],
        decisions: [{ question: 'add retry?', choice: 'yes', rationale: 'idempotent' }],
        artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
        usage: { input: 110, output: 75 }, wallClockMs: 150,
      },
    };

    const runtime: HeadRuntime = {
      async spawnHead(input: HeadInput): Promise<SpawnedHead> {
        const taskKey = input.task.split(' ')[0];

        return {
          id: input.id,
          async run() { return { ...(headReports[taskKey] ?? headReports.survey), id: input.id }; },
          async abort() { /* nop */ },
        };
      },
      async mergeLLM(_prompt, _schema): Promise<MergeOutput> {
        return {
          narrative: 'Unified: use the X pattern, keep it minimal, add idempotent retry.',
          selected_decisions: [
            { question: 'pattern?', choice: 'X pattern', rationale: 'matches prior art' },
            { question: 'reliability?', choice: 'idempotent retry', rationale: 'covers race' },
          ],
          unresolved_questions: ['back-off curve?'],
          recommendations: ['Implement X pattern minimal struct + retry-on-init.'],
          blind_spots: [],
        };
      },
    };

    const controller = new HeadController(runtime, journal);

    const inheritedContext: SerializedMessage[] = [
      { id: 'm1', role: 'user', content: 'help me integrate X', createdAt: 1 },
    ];

    const request: SplitRequest = {
      rationale: 'Explore three angles on integrating X',
      heads: [
        { task: 'survey prior art', rationale: 'know what exists' },
        { task: 'design our own', rationale: 'minimal first' },
        { task: 'risks and failure modes', rationale: 'stress-test' },
      ],
    };

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-1',
      inheritedContext,
      request,
      // One level of forking: the recursion room the heads inherit is zero.
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toContain('X pattern');
    expect(result.mergedNarrative).toContain('idempotent retry');
    expect(result.selectedDecisions.length).toBe(2);
    expect(result.costSummary.headCount).toBe(3);
    expect(result.evidenceAggregate.length).toBe(3);
    expect(result.headIds.length).toBe(3);
    expect(result.headIds.every((id) => id.length > 0)).toBe(true);

    const rows = sql<{ status: string; summary: string | null }>`
      SELECT status, summary FROM head_journal WHERE actor_id = ${actor.actorId}`;

    expect(rows.length).toBe(3);

    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.summary).not.toBeNull();
    }

    const cached = present(journal.readCachedMerge('root-1'), 'the cached merge for root-1');

    expect(cached.mergedNarrative).toBe(result.mergedNarrative);
  });
});

describe('v2 e2e: scaffold shadow rollout', () => {
  test('modifyScaffold writes new version with status=pending', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    await rt.identity.scaffold.write('async function* run(rt, task) { yield task; }');
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'initial', 'current')`;

    const validCode = `async function* run(rt, task) {
      yield { type: "chunk", data: "v1: " + task };
    }`;

    const result = await modifyScaffold(
      rt,
      'Try a tagged response to improve UI rendering for fast paths.',
      validCode,
    );

    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);

    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');

    expect(pending.version).toBe(1);
    expect(pending.trialsSoFar).toBe(0);

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} ORDER BY version`;

    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(0)).toBe('current');
    expect(map.get(1)).toBe('pending');
  });

  test('pending wins → promote; statuses flip correctly', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'initial bootstrap', 'current')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 1, ${Date.now()}, 'try alternate loop with retry', 'pending')`;

    // `modifyScaffold` gate 4 archives v0 at `.v0` and writes the proposal at `.v1`; without these files
    // promotion copies v0 over itself and the status assertions still pass.
    const V0 = 'async function* run(rt, task) { yield { type: "chunk", data: "v0" }; }';
    const V1 = 'async function* run(rt, task) { yield { type: "chunk", data: "v1-retry" }; }';
    await rt.identity.scaffold.write(V0);
    await rt.storage.vfs.writeFile(`${rt.identity.scaffold.path}.v0`, V0);
    await rt.storage.vfs.writeFile(`${rt.identity.scaffold.path}.v1`, V1);

    const judge = (winner: 'pending' | 'current') => ({
      winner, rationale: 'mock',
      currentScore: winner === 'current' ? 0.8 : 0.5,
      pendingScore: winner === 'pending' ? 0.8 : 0.5,
    });

    for (let i = 0; i < 5; i++) {
      recordShadowEvaluation(rt.storage.sql, rt.actor, {
        currentVersion: 0, pendingVersion: 1,
        task: `t${i}`, currentOutput: 'c', pendingOutput: 'p',
        judgeResult: judge('pending'),
      });
    }

    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');

    expect(pending.trialsSoFar).toBe(5);
    expect(pending.pendingWins).toBe(5);
    expect(pending.currentWins).toBe(0);

    const decision = decidePromotion(pending, DEFAULT_SHADOW_CONFIG);
    expect(decision.decision).toBe('promote');
    expect(decision.winRate).toBeCloseTo(1, 2);

    const applied = await applyPromotionDecision(rt, pending, 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));
    expect(applied.action).toBe('promote');
    expect(applied.newCurrentVersion).toBe(1);

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} ORDER BY version`;

    const byVersion = new Map(statuses.map((s) => [s.version, s.status]));
    expect(byVersion.get(1)).toBe('current');
    expect(byVersion.get(0)).toBe('historical');

    // Flipping statuses without swapping the source would leave the agent running v0 labelled v1.
    expect(await rt.identity.scaffold.read()).toBe(V1);
    expect(await rt.identity.scaffold.version()).toBe(1);
    expect(await readScaffoldVersion(rt, 0)).toBe(V0);
  });
});

describe('v2 e2e: durable event log', () => {
  test('emit through a turn lifecycle; replay via readSince', () => {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    const sql = makeSql(db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));

    const runId = 'run-test';
    recorder.emit(runId, { type: 'run_start', agentId: 'agent-1' });
    recorder.emit(runId, { type: 'turn_start', turnIndex: 0 });
    recorder.emit(runId, { type: 'step_finish', stepIndex: 1, messages: [{ role: 'assistant', content: 'Working...' }] });
    recorder.emit(runId, { type: 'tool_call_end', name: 'search_memory', toolCallId: 'tc-1', durationMs: 50, outcome: { success: true } });
    recorder.emit(runId, { type: 'step_finish', stepIndex: 2, messages: [{ role: 'assistant', content: 'Done.' }] });
    recorder.emit(runId, { type: 'turn_end', turnIndex: 0 });
    recorder.emit(runId, { type: 'run_end', reason: 'completed' });

    const all = recorder.read(runId);
    expect(all.length).toBe(7);
    expect(all.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'step_finish', 'tool_call_end',
      'step_finish', 'turn_end', 'run_end',
    ]);
    expect(all[0].eventIndex).toBe(0);
    expect(all[6].eventIndex).toBe(6);

    const resumed = recorder.readSince(runId, 3);
    expect(resumed.length).toBe(3);
    expect(resumed[0].eventIndex).toBe(4);

    const tools = recorder.read(runId, { types: ['tool_call_end'] });
    expect(tools.length).toBe(1);
    expect(tools[0].type).toBe('tool_call_end');
  });
});

describe('v2 e2e: approval gate', () => {
  test('classifies and routes correctly through gateExec', async () => {
    const seen: string[] = [];

    const gated = gateExec<string>(
      async (cmd) => {
        seen.push(cmd);

        return `ran:${cmd}`;
      },
      (msg) => `DENIED:${msg}`,
      'device',
      { policy: { mode: () => 'strict', requestApproval: async () => 'allow' } },
    );

    expect(await gated('ls')).toBe('ran:ls');
    expect(reviewCommand('ls', 'device').decision).toBe('allow');
    expect(await gated('printenv')).toContain('ran:');
    expect(await gated('sudo apt-get install nginx')).toContain('ran:');

    const result = String(await gated('rm -rf /'));
    expect(result).toContain('DENIED');
    expect(result).toContain('rm-rf-root');
    expect(seen.includes('rm -rf /')).toBe(false);
  });
});
