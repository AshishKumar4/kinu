/**
 * Unit tests for HeadController — pure-logic split → await → merge orchestration.
 *
 * Uses bun:sqlite for the HeadJournal and a mock HeadRuntime that returns
 * canned reports + canned merge LLM responses. Validates:
 *   - spawn → journal records insert
 *   - await collects reports in order
 *   - wall-clock budget enforces aborts
 *   - merge produces a valid MergeResult
 *   - schema-invalid merge LLM output falls back gracefully
 *   - depth-budget rejection at max-depth
 *   - cached merge round-trips through journal
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  HeadController,
  HeadJournal,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type SpawnedHead,
  type SerializedMessage,
  type SplitRequest,
  type MergeOutput,
  type MergeStrategy,
  initHeadsTables,
} from '../src/heads/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

// ── Test runtime wiring ──────────────────────────────────────────────

function newJournal(): { sql: ReturnType<typeof makeSql>; journal: HeadJournal; db: Database } {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  const sql = makeSql(db);
  return { sql, journal: new HeadJournal(sql), db };
}

function fakeReport(id: string, overrides: Partial<HeadReport> = {}): HeadReport {
  return {
    id,
    status: 'completed',
    summary: `Head ${id} did its job.`,
    evidence: [{ id: `${id}-ev-1`, kind: 'fact', body: `${id} learned something.` }],
    decisions: [{ question: `Q for ${id}?`, choice: `Answer ${id}`, rationale: `Because ${id}` }],
    artifactRefs: [],
    childHeadIds: [],
    toolCalls: [],
    tokenUsage: { input: 100, output: 80, total: 180 },
    wallClockMs: 250,
    ...overrides,
  };
}

function fakeMergeOutput(narrative: string): MergeOutput {
  return {
    narrative,
    selected_decisions: [{ question: 'Final Q?', choice: 'Final A', rationale: 'Synthesized' }],
    unresolved_questions: ['What about edge case X?'],
    recommendations: ['Take action Y.'],
  };
}

function buildRuntime(opts: {
  reports?: Record<string, HeadReport>;
  reportDelays?: Record<string, number>;
  mergeOutput?: MergeOutput;
  mergeThrows?: Error;
}): HeadRuntime {
  const { reports = {}, reportDelays = {}, mergeOutput, mergeThrows } = opts;
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      let aborted = false;
      const id = input.id;
      return {
        id,
        async run() {
          const delay = reportDelays[input.task] ?? 0;
          await new Promise((r) => setTimeout(r, delay));
          if (aborted) {
            return fakeReport(id, { status: 'aborted', summary: 'aborted by runtime' });
          }
          return reports[input.task] ?? fakeReport(id, { summary: `Default for ${input.task}` });
        },
        async abort() { aborted = true; },
      };
    },
    async mergeLLM(_prompt, _schema): Promise<MergeOutput> {
      if (mergeThrows) throw mergeThrows;
      return mergeOutput ?? fakeMergeOutput('Default merged narrative.');
    },
  };
}

const baseContext: SerializedMessage[] = [
  { id: 'm1', role: 'user', content: 'Help me explore X', createdAt: 1 },
];

const baseRequest: SplitRequest = {
  rationale: 'Explore three angles on X',
  heads: [
    { task: 'angle A', rationale: 'first angle' },
    { task: 'angle B', rationale: 'second angle' },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────

describe('HeadController.run', () => {
  test('spawns all heads, records journal entries, returns merged narrative', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({
      reports: {
        'angle A': fakeReport('h-A', { summary: 'A finding' }),
        'angle B': fakeReport('h-B', { summary: 'B finding' }),
      },
      mergeOutput: fakeMergeOutput('Unified findings across A and B.'),
    });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
    });

    expect(result.mergedNarrative).toBe('Unified findings across A and B.');
    expect(result.costSummary.headCount).toBe(2);
    expect(result.costSummary.totalTokens).toBe(360); // 180 + 180
    expect(result.selectedDecisions.length).toBe(1);
    expect(result.evidenceAggregate.length).toBe(2);
  });

  test('persists every spawn + report in the journal', async () => {
    const { sql, journal } = newJournal();
    const runtime = buildRuntime({});
    const controller = new HeadController(runtime, journal);

    await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
    });

    const rows = sql<{ id: string; status: string; summary: string | null }>`
      SELECT id, status, summary FROM head_journal`;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.summary).not.toBeNull();
    }
  });

  test('caches merge result keyed by rootId; round-trip via journal', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({
      mergeOutput: fakeMergeOutput('Cached narrative.'),
    });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      parentHeadId: null,
      rootId: 'root-1',
      inheritedContext: baseContext,
      request: baseRequest,
    });

    const cached = journal.readCachedMerge('root-1');
    expect(cached).not.toBeNull();
    expect(cached!.mergedNarrative).toBe('Cached narrative.');
    expect(cached!.costSummary.headCount).toBe(result.costSummary.headCount);
  });

  test('rejects split when maxDepth budget is exhausted', async () => {
    const { journal } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);

    await expect(controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: {
        maxDepth: 0, maxTokens: 1000, maxWallClockMs: 1000, spawnedAt: Date.now(),
      },
    })).rejects.toThrow(/max depth/i);
  });

  test('rejects split when no heads are provided', async () => {
    const { journal } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);

    await expect(controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: { rationale: 'no heads', heads: [] },
    })).rejects.toThrow(/no head tasks/i);
  });

  test('aborts heads that exceed wall-clock budget; records budget_exceeded', async () => {
    const { sql, journal } = newJournal();
    const runtime = buildRuntime({
      reportDelays: { 'angle A': 1000 }, // way over the 50ms budget
    });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: { rationale: 'tight budget test', heads: [{ task: 'angle A', rationale: 'slow' }] },
      parentBudget: {
        maxDepth: 2, maxTokens: 10_000, maxWallClockMs: 50,
        spawnedAt: Date.now(),
      },
    });

    expect(result.costSummary.headCount).toBe(1);
    const rows = sql<{ status: string; error_message: string | null }>`
      SELECT status, error_message FROM head_journal`;
    expect(rows[0]?.status).toBe('budget_exceeded');
    expect(rows[0]?.error_message).toMatch(/wall-clock/i);
  });

  test('falls back gracefully when merge LLM throws', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({
      reports: {
        'angle A': fakeReport('h-A', { summary: 'A finding' }),
        'angle B': fakeReport('h-B', { summary: 'B finding' }),
      },
      mergeThrows: new Error('LLM timeout'),
    });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
    });

    expect(result.mergedNarrative).toContain('Merge synthesis unavailable');
    expect(result.mergedNarrative).toContain('LLM timeout');
    expect(result.mergedNarrative).toContain('A finding');
    expect(result.mergedNarrative).toContain('B finding');
    // Decisions still aggregate from heads.
    expect(result.selectedDecisions.length).toBe(2);
  });

  test('falls back when merge LLM returns schema-invalid output', async () => {
    const { journal } = newJournal();
    const runtime: HeadRuntime = {
      spawnHead: buildRuntime({}).spawnHead,
      // Returns an output that doesn't match MergeOutputSchema (missing required fields).
      mergeLLM: async () => ({} as MergeOutput),
    };
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
    });

    expect(result.mergedNarrative).toContain('Merge synthesis unavailable');
    expect(result.mergedNarrative).toContain('schema invalid');
  });

  test('honors merge strategy in the prompt — synthesize / best_of / consensus', async () => {
    const { journal } = newJournal();
    const promptsSeen: string[] = [];
    const runtime: HeadRuntime = {
      spawnHead: buildRuntime({}).spawnHead,
      mergeLLM: async (prompt) => {
        promptsSeen.push(prompt);
        return fakeMergeOutput('ok');
      },
    };
    const controller = new HeadController(runtime, journal);

    for (const strategy of ['synthesize', 'best_of', 'consensus'] as MergeStrategy[]) {
      await controller.run({
        parentHeadId: null,
        inheritedContext: baseContext,
        request: { ...baseRequest, mergeStrategy: strategy },
      });
    }

    expect(promptsSeen).toHaveLength(3);
    expect(promptsSeen[0]).toContain('synthesize');
    expect(promptsSeen[1]).toContain('best_of');
    expect(promptsSeen[2]).toContain('consensus');
  });

  test('child budget is derived from parent (depth-1, tokens split equally)', async () => {
    const { journal } = newJournal();
    let observed: HeadInput | null = null;
    const runtime: HeadRuntime = {
      async spawnHead(input) {
        if (observed == null) observed = input;
        return {
          id: input.id,
          async run() { return fakeReport(input.id); },
          async abort() {},
        };
      },
      mergeLLM: async () => fakeMergeOutput('ok'),
    };
    const controller = new HeadController(runtime, journal);

    await controller.run({
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest, // 2 heads
      parentBudget: { maxDepth: 3, maxTokens: 10_000, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(observed).not.toBeNull();
    expect(observed!.budget.maxDepth).toBe(2);     // depth - 1
    expect(observed!.budget.maxTokens).toBe(5_000); // 10000 / 2
    expect(observed!.depth).toBe(1);                // 3 - 2 = 1
  });
});
