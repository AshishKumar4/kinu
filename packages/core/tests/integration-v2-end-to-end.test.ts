/**
 * v2 end-to-end integration test.
 *
 * Exercises the v2 additions together against in-memory SQLite + stubbed
 * LLMs. After the duplicacy cleanup, this validates:
 *
 *   1. Inline executor (`createInlineExecutor`) — the pre-existing
 *      ExecutorProvider that backs codemode's workspace.* namespace.
 *      Round-trip a file + shell exec through its tool surface.
 *   2. Branching heads — HeadController spawns N heads, awaits, merges
 *      via a deterministic mock LLM, persists the journal + cached merge.
 *   3. Scaffold shadow rollout — write pending version, record N trials
 *      with biased outcomes, decidePromotion fires the right verdict,
 *      applyPromotionDecision flips statuses correctly.
 *   4. Durable event log — emit events through the full turn lifecycle,
 *      replay via readSince (the SSE-resume semantics).
 *   5. Approval gate — wrap a fake exec function and confirm allow/warn/
 *      gate/deny classification routes correctly.
 *
 * No network. No LLM calls. The test asserts contracts, not behaviors.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  // Execution layer (pre-existing — no parallel sandbox abstraction)
  createInlineExecutor,
  // Heads
  HeadController, HeadJournal, initHeadsTables,
  type HeadInput, type HeadReport, type HeadRuntime, type SpawnedHead,
  type SerializedMessage, type SplitRequest, type MergeOutput,
  // Scaffold
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision,
  DEFAULT_SHADOW_CONFIG, recordShadowEvaluation,
  initScaffoldTables, modifyScaffold,
  // Events
  initRunEventTables, RunEventRecorder,
  // Approval
  reviewCommand, withApprovalGate,
} from '../src/index.js';
import { makeSql, makeExecRaw, createTestRuntime } from './helpers.js';

// ── 1. Inline executor (workspace provider) ──────────────────────────

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

// ── 2. Branching heads e2e ───────────────────────────────────────────

describe('v2 e2e: branching heads → merge', () => {
  test('split 3 heads, await all, merge with deterministic mock LLM', async () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db));
    const sql = makeSql(db);
    const journal = new HeadJournal(sql);

    const headReports: Record<string, HeadReport> = {
      'survey': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Survey finding: 3 prior impls exist, all use the X pattern.',
        evidence: [{ id: 'e1', kind: 'fact', body: 'prior art' }],
        decisions: [{ question: 'use X pattern?', choice: 'yes', rationale: 'standard' }],
        artifactRefs: [], childHeadIds: [], toolCalls: [],
        tokenUsage: { input: 100, output: 80, total: 180 }, wallClockMs: 120,
      },
      'design': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Design sketch: minimal struct, no abstractions.',
        evidence: [{ id: 'e2', kind: 'fact', body: 'simple > clever' }],
        decisions: [{ question: 'add abstraction?', choice: 'no', rationale: 'YAGNI' }],
        artifactRefs: [], childHeadIds: [], toolCalls: [],
        tokenUsage: { input: 120, output: 90, total: 210 }, wallClockMs: 180,
      },
      'risks': {
        id: 'will-be-replaced', status: 'completed',
        summary: 'Failure modes: connection drops, race on init.',
        evidence: [{ id: 'e3', kind: 'fact', body: 'race condition' }],
        decisions: [{ question: 'add retry?', choice: 'yes', rationale: 'idempotent' }],
        artifactRefs: [], childHeadIds: [], toolCalls: [],
        tokenUsage: { input: 110, output: 75, total: 185 }, wallClockMs: 150,
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
      parentHeadId: null,
      rootId: 'root-1',
      inheritedContext,
      request,
    });

    expect(result.mergedNarrative).toContain('X pattern');
    expect(result.mergedNarrative).toContain('idempotent retry');
    expect(result.selectedDecisions.length).toBe(2);
    expect(result.costSummary.headCount).toBe(3);
    expect(result.evidenceAggregate.length).toBe(3);
    // v2: headIds is now populated from the actual spawned handles (not
    // a hack mapping evidence ids).
    expect(result.headIds.length).toBe(3);
    expect(result.headIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

    const rows = sql<{ status: string; summary: string | null }>`SELECT status, summary FROM head_journal`;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.summary).not.toBeNull();
    }

    const cached = journal.readCachedMerge('root-1');
    expect(cached).not.toBeNull();
    expect(cached!.mergedNarrative).toBe(result.mergedNarrative);
  });
});

// ── 3. Scaffold shadow rollout e2e ───────────────────────────────────

describe('v2 e2e: scaffold shadow rollout', () => {
  test('modifyScaffold writes new version with status=pending', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    await rt.identity.scaffold.write('async function* run(rt, task) { yield task; }');
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial', 'current')`;

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

    const pending = getPendingScaffold(rt.storage.sql);
    expect(pending).not.toBeNull();
    expect(pending!.version).toBe(1);
    expect(pending!.trialsSoFar).toBe(0);

    // Verify v0 is still current; v1 is pending.
    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(0)).toBe('current');
    expect(map.get(1)).toBe('pending');
  });

  test('pending wins → promote; statuses flip correctly', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial bootstrap', 'current')`;
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'try alternate loop with retry', 'pending')`;

    const judge = (winner: 'pending' | 'current') => ({
      winner, rationale: 'mock',
      currentScore: winner === 'current' ? 0.8 : 0.5,
      pendingScore: winner === 'pending' ? 0.8 : 0.5,
    });
    // A clean win with ZERO regressions — the regression veto (maxRegressions=0)
    // requires the pending lose no decisive trials to be promotable.
    for (let i = 0; i < 5; i++) {
      recordShadowEvaluation(rt.storage.sql, {
        currentVersion: 0, pendingVersion: 1,
        task: `t${i}`, currentOutput: 'c', pendingOutput: 'p',
        judgeResult: judge('pending'),
      });
    }

    const pending = getPendingScaffold(rt.storage.sql);
    expect(pending).not.toBeNull();
    expect(pending!.trialsSoFar).toBe(5);
    expect(pending!.pendingWins).toBe(5);
    expect(pending!.currentWins).toBe(0);

    const decision = decidePromotion(pending!, DEFAULT_SHADOW_CONFIG);
    expect(decision.decision).toBe('promote');
    expect(decision.winRate).toBeCloseTo(1, 2);

    const applied = await applyPromotionDecision(rt, pending!, 'promote');
    expect(applied.action).toBe('promote');
    expect(applied.newCurrentVersion).toBe(1);

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const byVersion = new Map(statuses.map((s) => [s.version, s.status]));
    expect(byVersion.get(1)).toBe('current');
    expect(byVersion.get(0)).toBe('historical');
  });
});

// ── 4. Durable event log ─────────────────────────────────────────────

describe('v2 e2e: durable event log', () => {
  test('emit through a turn lifecycle; replay via readSince', () => {
    const db = new Database(':memory:');
    initRunEventTables(makeExecRaw(db));
    const recorder = new RunEventRecorder(makeSql(db));

    const runId = 'run-test';
    recorder.emit(runId, { type: 'run_start', agentId: 'agent-1' });
    recorder.emit(runId, { type: 'turn_start', turnIndex: 0 });
    recorder.emit(runId, { type: 'text_delta', text: 'Working...' });
    recorder.emit(runId, { type: 'tool_call_end', name: 'search_memory', toolCallId: 'tc-1', durationMs: 50 });
    recorder.emit(runId, { type: 'text_delta', text: 'Done.' });
    recorder.emit(runId, { type: 'turn_end', turnIndex: 0 });
    recorder.emit(runId, { type: 'run_end', reason: 'completed' });

    const all = recorder.read(runId);
    expect(all.length).toBe(7);
    expect(all.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'text_delta', 'tool_call_end',
      'text_delta', 'turn_end', 'run_end',
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

// ── 5. Approval gate ─────────────────────────────────────────────────

describe('v2 e2e: approval gate', () => {
  test('classifies and routes correctly with withApprovalGate', async () => {
    const seen: string[] = [];
    const gated = withApprovalGate(
      async (cmd) => { seen.push(cmd); return `ran:${cmd}`; },
      (msg) => `DENIED:${msg}`,
      async () => true,
    );

    expect(await gated('ls')).toBe('ran:ls');
    expect(reviewCommand('ls').decision).toBe('allow');
    expect(await gated('printenv')).toContain('ran:');
    expect(await gated('sudo apt-get install nginx')).toContain('ran:');

    const result = await gated('rm -rf /');
    expect(result).toContain('DENIED');
    expect(result).toContain('rm-rf-root');
    expect(seen.includes('rm -rf /')).toBe(false);
  });
});
