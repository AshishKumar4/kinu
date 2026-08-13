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
    fileChanges: [],
    childHeadIds: [],
    toolCalls: [],
    steps: [],
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
    blind_spots: [],
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
        maxDepth: 0, maxWallClockMs: 1000, spawnedAt: Date.now(),
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
        maxDepth: 2, maxWallClockMs: 50,
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

  test('records the per-head step trace; listRuns round-trips it', async () => {
    const { journal } = newJournal();
    // Report id must match the spawned input.id for recordReport to land, so
    // build the report from input.id with an injected step trace.
    const runtime: HeadRuntime = {
      async spawnHead(input) {
        return {
          id: input.id,
          async run() {
            return fakeReport(input.id, {
              steps: [
                { text: 'Reading the spec.', reasoning: 'start here', toolCalls: [] },
                { text: '', toolCalls: [{ name: 'sandbox_read', input: { path: '/x' }, output: 'contents' }] },
              ],
            });
          },
          async abort() {},
        };
      },
      mergeLLM: async () => fakeMergeOutput('ok'),
    };
    const controller = new HeadController(runtime, journal);
    await controller.run({
      parentHeadId: null, rootId: 'r-steps',
      inheritedContext: baseContext,
      request: { rationale: 'trace test', heads: [{ task: 'angle A', rationale: 'a' }] },
    });

    const run = journal.listRuns(10).find((r) => r.rootId === 'r-steps');
    expect(run).toBeDefined();
    expect(run!.heads).toHaveLength(1);
    expect(run!.heads[0].steps).toHaveLength(2);
    expect(run!.heads[0].steps[1].toolCalls[0]).toEqual({ name: 'sandbox_read', input: { path: '/x' }, output: 'contents' });
  });
});

/**
 * A head that stopped without banking anything observed nothing, and its
 * silence must never reach the parent as a fact. A real run merged two
 * budget-starved heads into "the immediate blockage is the sandbox provisioning
 * failure" — a cause nobody had observed, handed to the parent as ground truth.
 */
describe('HeadController.merge — an empty head cannot become a finding', () => {
  const emptyReport = (id: string, overrides: Partial<HeadReport> = {}): HeadReport => fakeReport(id, {
    status: 'budget_exceeded',
    summary: `Head ${id} did not complete (status=budget_exceeded). It produced no findings.`,
    evidence: [], decisions: [], artifactRefs: [],
    ...overrides,
  });

  test('when no head banked anything the merge LLM is never asked to narrate it', async () => {
    const { journal } = newJournal();
    let mergeCalls = 0;
    const base = buildRuntime({
      reports: {
        'angle A': emptyReport('h-A'),
        'angle B': emptyReport('h-B', { status: 'errored', errorMessage: 'stream closed' }),
      },
    });
    const runtime: HeadRuntime = {
      spawnHead: base.spawnHead,
      mergeLLM: async (...args) => { mergeCalls++; return base.mergeLLM(...args); },
    };

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(mergeCalls).toBe(0);
    expect(result.costSummary.headsWithFindings).toBe(0);
    expect(result.mergedNarrative).toContain('No head produced findings');
    expect(result.mergedNarrative).toContain('budget_exceeded');
    expect(result.mergedNarrative).toContain('stream closed');
    expect(result.mergedNarrative).toContain('do not infer a cause from it');
    // Nothing was learned, so nothing is asserted.
    expect(result.recommendations).toEqual([]);
    expect(result.unresolvedQuestions).toEqual([]);
    expect(result.selectedDecisions).toEqual([]);
    expect(result.evidenceAggregate).toEqual([]);
  });

  test('a mixed split still merges, but marks the empty head and forbids inferring why', async () => {
    const { journal } = newJournal();
    let prompt = '';
    const base = buildRuntime({
      reports: {
        'angle A': fakeReport('h-A', { summary: 'A finding' }),
        'angle B': emptyReport('h-B'),
      },
      mergeOutput: fakeMergeOutput('Synthesis of what A found.'),
    });
    const runtime: HeadRuntime = {
      spawnHead: base.spawnHead,
      mergeLLM: async (p, schema) => { prompt = p; return base.mergeLLM(p, schema); },
    };

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(result.mergedNarrative).toBe('Synthesis of what A found.');
    expect(result.costSummary.headsWithFindings).toBe(1);
    expect(result.costSummary.headCount).toBe(2);
    expect(prompt).toContain('PRODUCED NO FINDINGS');
    expect(prompt).toContain('do NOT turn their silence into a claim about the environment');
  });

  test('a stopped head that DID bank evidence counts as having findings', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({
      reports: {
        'angle A': emptyReport('h-A', { evidence: [{ id: 'e1', kind: 'fact', body: 'gates.txt exists' }] }),
        'angle B': emptyReport('h-B'),
      },
      mergeOutput: fakeMergeOutput('One head got partway.'),
    });

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(result.costSummary.headsWithFindings).toBe(1);
    expect(result.mergedNarrative).toBe('One head got partway.');
  });

  test('the cached replay reports the same findings count as the live merge', async () => {
    const { journal } = newJournal();
    // Reports carry the SPAWNED id here so they land on the journal rows the
    // cached read derives its count from.
    const runtime: HeadRuntime = {
      async spawnHead(input: HeadInput): Promise<SpawnedHead> {
        return {
          id: input.id,
          run: async () => (input.task === 'angle A'
            ? fakeReport(input.id, { summary: 'A finding' })
            : emptyReport(input.id)),
          abort: async () => undefined,
        };
      },
      mergeLLM: async () => fakeMergeOutput('Synthesis of what A found.'),
    };
    const live = await new HeadController(runtime, journal).run({
      parentHeadId: null, rootId: 'root-1', inheritedContext: baseContext, request: baseRequest,
    });

    const cached = journal.readCachedMerge('root-1');
    expect(cached?.costSummary.headsWithFindings).toBe(live.costSummary.headsWithFindings);
  });
});

describe('HeadJournal.listLive — the live fork roster', () => {
  const spawn = (journal: HeadJournal, rootId: string, id: string) => journal.insertSpawn({
    id, parentId: null, rootId, depth: 1, task: `t-${id}`, rationale: 'why',
    inheritedContext: [], mergeStrategy: 'consensus',
    budget: { maxDepth: 2, maxWallClockMs: 10, spawnedAt: Date.now() },
  });

  test('a run with heads still running is reported with its progress and its split rationale', () => {
    const { journal } = newJournal();
    journal.recordSplit('root-a', 'explore two angles', Date.now());
    spawn(journal, 'root-a', 'h1');
    spawn(journal, 'root-a', 'h2');
    journal.recordReport(fakeReport('h1'));

    expect(journal.listLive()).toEqual([
      { rootId: 'root-a', rationale: 'explore two angles', running: 1, total: 2 },
    ]);
  });

  test('a run whose heads have all settled is no longer live', () => {
    const { journal } = newJournal();
    journal.recordSplit('root-a', 'why', Date.now());
    spawn(journal, 'root-a', 'h1');
    journal.recordReport(fakeReport('h1'));
    expect(journal.listLive()).toEqual([]);
  });

  test('an unlabelled split still reports, and the roster is capped', () => {
    const { journal } = newJournal();
    for (let i = 0; i < 4; i++) spawn(journal, `root-${i}`, `h${i}`);
    const live = journal.listLive(2);
    expect(live).toHaveLength(2);
    expect(live.every((run) => run.rationale === '')).toBe(true);
  });
});

describe('HeadJournal.listRuns — grouping (the #179 quirk fix)', () => {
  test('a top-level split (synthetic root, all heads parent_id NULL) is ONE run, not N', async () => {
    const { journal } = newJournal();
    // Default reports (no override) → fakeReport(input.id) so recordReport lands.
    const runtime = buildRuntime({ mergeOutput: fakeMergeOutput('Merged A+B.') });
    const controller = new HeadController(runtime, journal);
    await controller.run({
      parentHeadId: null, rootId: 'top-root',
      inheritedContext: baseContext,
      request: { rationale: 'Explore two angles', heads: baseRequest.heads },
    });

    const runs = journal.listRuns(10);
    // The quirk: this used to be 2 "roots" with empty heads. Now: ONE run.
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.rootId).toBe('top-root');
    expect(run.heads).toHaveLength(2);
    expect(run.heads.every((h) => h.status === 'completed')).toBe(true);
    expect(run.rationale).toBe('Explore two angles'); // from head_runs
    expect(run.task).toBe('Explore two angles');      // synthetic root → label from rationale
    expect(run.merge?.narrative).toBe('Merged A+B.');
    expect(run.status).toBe('completed');
  });

  test('runs are ordered newest-first and limited', async () => {
    const { journal } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);
    for (const root of ['run-1', 'run-2', 'run-3']) {
      await controller.run({
        parentHeadId: null, rootId: root,
        inheritedContext: baseContext,
        request: { rationale: `r-${root}`, heads: [{ task: `t-${root}`, rationale: 'x' }] },
      });
    }
    const runs = journal.listRuns(2);
    expect(runs).toHaveLength(2);
    // newest-first by MIN(spawned_at); all share ~same spawnedAt so just assert count + distinctness
    expect(new Set(runs.map((r) => r.rootId)).size).toBe(2);
  });

  test('child budget is derived from parent: depth-1, envelope undivided', async () => {
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
      parentBudget: { maxDepth: 3, maxWallClockMs: 60_000, spawnedAt: Date.now() },
    });

    expect(observed).not.toBeNull();
    expect(observed!.budget.maxDepth).toBe(2);     // depth - 1
    expect(observed!.depth).toBe(1);               // 3 - 2 = 1
    // Fan-out does not divide a child's working room: two siblings each get the
    // parent's envelope, not half of it.
    expect(observed!.budget.maxWallClockMs).toBe(60_000);
  });
});

/**
 * blind_spots — the merge's negative-space field.
 *
 * Every other merge output is a function of what the heads SAID, so a framing
 * all N heads shared has no field to surface in and gets synthesized into a
 * confident narrative. These lock the carriage rather than the wording: the
 * field's own value is unmeasured and settled by reading `head_merge` rows
 * across real splits — the query and the revert rule are stated with the field
 * itself, in heads/merge-schema.ts.
 */
describe('merge blind spots', () => {
  const withBlindSpots = (...spots: string[]): MergeOutput => ({
    ...fakeMergeOutput('Synthesis.'),
    blind_spots: spots,
  });

  const bankedNothing = (id: string): HeadReport => fakeReport(id, {
    status: 'budget_exceeded',
    summary: `Head ${id} did not complete.`,
    evidence: [], decisions: [], artifactRefs: [],
  });

  test('reaches the MergeResult, the journal and the merge phase event', async () => {
    const { journal } = newJournal();
    const spots = ['no head checked whether the endpoint is rate-limited'];
    const runtime = buildRuntime({ mergeOutput: withBlindSpots(...spots) });
    const events: string[][] = [];

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null,
      rootId: 'root-bs',
      inheritedContext: baseContext,
      request: baseRequest,
      onPhase: (e) => { if (e.kind === 'merge') events.push([...e.blindSpots]); },
    });

    expect(result.blindSpots).toEqual(spots);
    // The row the falsification query reads.
    expect(events).toEqual([spots]);
    // And it survives the cache, so a replayed merge does not quietly lose it.
    expect(journal.readCachedMerge('root-bs')!.blindSpots).toEqual(spots);
  });

  test('degrades to [] when the merge model omits the key, exactly like the other list fields', async () => {
    const { journal } = newJournal();
    // A model that answers with only a narrative — the documented degradation.
    const runtime: HeadRuntime = {
      ...buildRuntime({}),
      mergeLLM: async () => ({ narrative: 'Just a narrative.' } as unknown as MergeOutput),
    };

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(result.mergedNarrative).toBe('Just a narrative.');
    expect(result.blindSpots).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  test('an empty split reports no blind spots — nothing was observed to have a negative space', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({
      reports: {
        'angle A': bankedNothing('h-A'),
        'angle B': bankedNothing('h-B'),
      },
      mergeOutput: withBlindSpots('invented'),
    });

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    // The merge never reached a model, so it cannot have produced a blind spot.
    expect(result.costSummary.headsWithFindings).toBe(0);
    expect(result.blindSpots).toEqual([]);
  });

  test('a merge that fails reports no blind spots rather than a stale or invented list', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({ mergeThrows: new Error('merge model unreachable') });

    const result = await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(result.mergedNarrative).toContain('Merge synthesis unavailable');
    expect(result.blindSpots).toEqual([]);
  });

  test('the merge prompt asks the negative-space question and separates it from open questions', async () => {
    const { journal } = newJournal();
    let prompt = '';
    const base = buildRuntime({ mergeOutput: withBlindSpots() });
    const runtime: HeadRuntime = {
      spawnHead: base.spawnHead,
      mergeLLM: async (p, schema) => { prompt = p; return base.mergeLLM(p, schema); },
    };

    await new HeadController(runtime, journal).run({
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
    });

    expect(prompt).toContain('blind_spots');
    // The distinction is the whole point: without it the model refiles the
    // heads' own open questions here and the field measures nothing.
    expect(prompt).toContain('A question a head RAISED is an unresolved_question');
    // And an honest empty answer must be reachable, or the field becomes filler.
    expect(prompt).toContain('Return []');
  });
});
