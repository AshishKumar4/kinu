/**
 * v2 end-to-end integration test.
 *
 * Exercises the three new pillars together against in-memory SQLite +
 * stubbed LLMs to validate that:
 *   1. SandboxApi (VirtualSandbox) + sandboxToExecutorProvider compose
 *      correctly with the existing codemode-shaped ExecutorProvider surface
 *   2. Branching heads — HeadController spawns N heads, awaits, merges via
 *      a deterministic mock LLM, persists the journal + cached merge
 *   3. Scaffold shadow rollout — write pending version, record N trials
 *      with biased outcomes, decidePromotion fires the right verdict,
 *      applyPromotionDecision flips statuses correctly
 *   4. Durable event log — emit events through the full turn lifecycle,
 *      replay via readSince (the SSE-resume semantics)
 *   5. Compaction — drop a long synthetic conversation through the
 *      summarizer, verify head + tail preserved
 *   6. Approval gate — wrap a fake exec function and confirm allow/warn/
 *      gate/deny classification routes correctly
 *
 * No network. No LLM calls. The test asserts contracts, not behaviors.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  // Sandbox
  createVirtualSandbox, sandboxToExecutorProvider, DefaultSandboxRegistry,
  type VirtualVFS, type VirtualShell,
  // Heads
  HeadController, HeadJournal, initHeadsTables,
  type HeadInput, type HeadReport, type HeadRuntime, type SpawnedHead,
  type SerializedMessage, type SplitRequest, type MergeOutput,
  // Scaffold
  initShadowTables, getPendingScaffold, decidePromotion, applyPromotionDecision,
  DEFAULT_SHADOW_CONFIG, recordShadowEvaluation,
  initScaffoldTables, bootstrapScaffold,
  // Events
  initRunEventTables, RunEventRecorder,
  // Compaction
  compactMessages, type CompactableMessage,
  // Approval
  reviewCommand, withApprovalGate,
  // Test helpers
} from '../src/index.js';
import { makeSql, makeExecRaw, createTestRuntime } from './helpers.js';

// ── In-memory VirtualVFS for sandbox tests ───────────────────────────

function makeMemoryVFS(): VirtualVFS {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const seedParents = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      dirs.add(cur);
    }
  };
  return {
    async readFile(path, opts) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      const data = files.get(path)!;
      return opts?.encoding === 'utf8' ? data : new TextEncoder().encode(data);
    },
    async writeFile(path, data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      seedParents(path);
      files.set(path, text);
    },
    async readdir(path) {
      const prefix = path === '/' ? '/' : path + '/';
      const seen = new Set<string>();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const name = f.slice(prefix.length).split('/')[0];
          if (name) seen.add(name);
        }
      }
      return Array.from(seen);
    },
    async stat(path) {
      if (dirs.has(path) || path === '/') return { type: 'dir' as const, size: 0, mtimeMs: 0 };
      if (files.has(path)) return { type: 'file' as const, size: files.get(path)!.length, mtimeMs: 0 };
      throw new Error(`ENOENT: ${path}`);
    },
    async unlink(path) { if (!files.delete(path)) throw new Error(`ENOENT: ${path}`); },
    async mkdir(path) { seedParents(path + '/'); dirs.add(path); },
    async exists(path) { return files.has(path) || dirs.has(path); },
    async rmdir(path) { dirs.delete(path); },
  };
}

const passthroughShell: VirtualShell = {
  async exec(input) {
    if (input.includes('echo hello')) return { stdout: 'hello\n', stderr: '', exitCode: 0 };
    if (input.startsWith('false')) return { stdout: '', stderr: 'fail', exitCode: 1 };
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

// ── 1. Sandbox composition test ──────────────────────────────────────

describe('v2 e2e: sandbox + adapter + registry', () => {
  test('VirtualSandbox roundtrips through ExecutorProvider adapter', async () => {
    const sb = createVirtualSandbox({ id: 'e2e-virtual', vfs: makeMemoryVFS(), shell: passthroughShell });
    const provider = sandboxToExecutorProvider(sb, 'workspace');
    const reg = new DefaultSandboxRegistry();
    reg.register('workspace', sb);

    // Round-trip a file via the provider tools.
    await provider.tools.writeFile.execute('/a.txt', 'hello');
    expect(await provider.tools.readFile.execute('/a.txt')).toBe('hello');

    // Shell exec → string return contract.
    expect(await provider.tools.exec.execute('echo hello')).toBe('hello\n');
    expect(String(await provider.tools.exec.execute('false'))).toContain('Exit 1');

    // Registry view.
    expect(reg.available().map((e) => e.namespace)).toEqual(['workspace']);
    expect(reg.get('workspace')?.id).toBe('e2e-virtual');
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
          async run() {
            return { ...(headReports[taskKey] ?? headReports.survey), id: input.id };
          },
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

    // Journal persisted.
    const rows = sql<{ status: string; summary: string | null }>`SELECT status, summary FROM head_journal`;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.summary).not.toBeNull();
    }

    // Merge cache round-trip.
    const cached = journal.readCachedMerge('root-1');
    expect(cached).not.toBeNull();
    expect(cached!.mergedNarrative).toBe(result.mergedNarrative);
  });
});

// ── 3. Scaffold shadow rollout e2e ───────────────────────────────────

describe('v2 e2e: scaffold shadow rollout', () => {
  test('pending wins → promote; statuses flip correctly', async () => {
    const { rt } = createTestRuntime();
    // Set up: scaffold_versions exists + status column. Insert v0 (current)
    // and v1 (pending) directly — bootstrap's scaffold.exists() is a stub
    // in the test runtime so it short-circuits the v0 INSERT.
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial bootstrap', 'current')`;
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'try alternate loop with retry', 'pending')`;

    // Record 6 trials: pending wins 4, current wins 2 — promote.
    const judge = (winner: 'pending' | 'current') => ({
      winner, rationale: 'mock', currentScore: winner === 'current' ? 0.8 : 0.5,
      pendingScore: winner === 'pending' ? 0.8 : 0.5,
    });
    for (let i = 0; i < 4; i++) {
      recordShadowEvaluation(rt.storage.sql, {
        currentVersion: 0, pendingVersion: 1,
        task: `t${i}`, currentOutput: 'c', pendingOutput: 'p',
        judgeResult: judge('pending'),
      });
    }
    for (let i = 0; i < 2; i++) {
      recordShadowEvaluation(rt.storage.sql, {
        currentVersion: 0, pendingVersion: 1,
        task: `t-c${i}`, currentOutput: 'c', pendingOutput: 'p',
        judgeResult: judge('current'),
      });
    }

    const pending = getPendingScaffold(rt.storage.sql);
    expect(pending).not.toBeNull();
    expect(pending!.trialsSoFar).toBe(6);
    expect(pending!.pendingWins).toBe(4);

    const decision = decidePromotion(pending!, DEFAULT_SHADOW_CONFIG);
    expect(decision.decision).toBe('promote');
    expect(decision.winRate).toBeCloseTo(4 / 6, 2);

    const applied = await applyPromotionDecision(rt, pending!, 'promote');
    expect(applied.action).toBe('promote');
    expect(applied.newCurrentVersion).toBe(1);

    // Statuses flipped.
    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const byVersion = new Map(statuses.map((s) => [s.version, s.status]));
    expect(byVersion.get(1)).toBe('current');
    expect(byVersion.get(0)).toBe('historical');
  });
});

// ── 4. Durable event log + SSE-resume semantics ──────────────────────

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

    // Full replay.
    const all = recorder.read(runId);
    expect(all.length).toBe(7);
    expect(all.map((e) => e.type)).toEqual([
      'run_start', 'turn_start', 'text_delta', 'tool_call_end',
      'text_delta', 'turn_end', 'run_end',
    ]);
    expect(all[0].eventIndex).toBe(0);
    expect(all[6].eventIndex).toBe(6);

    // SSE-resume: simulate client reconnect after seeing index 3.
    const resumed = recorder.readSince(runId, 3);
    expect(resumed.length).toBe(3);
    expect(resumed[0].eventIndex).toBe(4);

    // Type filter.
    const tools = recorder.read(runId, { types: ['tool_call_end'] });
    expect(tools.length).toBe(1);
    expect(tools[0].type).toBe('tool_call_end');
  });
});

// ── 5. Compaction over a long conversation ───────────────────────────

describe('v2 e2e: compaction', () => {
  test('drops middle, preserves head + tail, calls summarizer', async () => {
    const messages: CompactableMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'answer' },
      // 8 long middle turns
      ...Array.from({ length: 16 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `mid ${i}: ${'a'.repeat(300)}`,
      })),
      { role: 'user', content: 'recent q' },
      { role: 'assistant', content: 'recent a' },
    ];

    let calls = 0;
    const r = await compactMessages(
      messages,
      async () => { calls++; return 'Compacted earlier turns.'; },
      { keepFirstMessages: 3, keepRecentTokens: 20 },
    );

    expect(calls).toBe(1);
    expect(r.droppedCount).toBe(16);
    expect(r.summary).toBe('Compacted earlier turns.');
    // First 3 + summary + 2 tail = 6
    expect(r.messages.length).toBe(6);
    expect(r.messages[0].content).toBe('You are an assistant.');
    expect(r.messages[3].content).toContain('Compacted earlier turns.');
    expect(r.messages[5].content).toBe('recent a');
  });
});

// ── 6. Approval gate wraps an exec ───────────────────────────────────

describe('v2 e2e: approval gate', () => {
  test('classifies and routes correctly with withApprovalGate', async () => {
    const seen: string[] = [];
    const gated = withApprovalGate(
      async (cmd) => { seen.push(cmd); return `ran:${cmd}`; },
      (msg) => `DENIED:${msg}`,
      async () => true, // auto-approve gated commands for the test
    );

    // allow
    expect(await gated('ls')).toBe('ran:ls');
    expect(reviewCommand('ls').decision).toBe('allow');

    // warn → still runs
    expect(await gated('printenv')).toContain('ran:');

    // gate → approver returns true → runs
    expect(await gated('sudo apt-get install nginx')).toContain('ran:');

    // deny → never runs
    const result = await gated('rm -rf /');
    expect(result).toContain('DENIED');
    expect(seen.includes('rm -rf /')).toBe(false);
  });
});
