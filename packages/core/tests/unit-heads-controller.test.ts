/** HeadController split → await → merge, over a bun:sqlite HeadJournal and a canned HeadRuntime. */

import { describe, test, expect } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
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
} from '../src/heads/index';
import type { SqlValue } from '../src/types/primitives';
import { makeSql, makeExecRaw, createTestActor } from './helpers';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';
import { present } from '@kinu.run/test-utils';

function newJournal() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw);
  const sql = makeSql(db);
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'heads-test');

  return { sql, journal: new HeadJournal(sql, actor), db, actor };
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
    usage: { input: 100, output: 80 },
    wallClockMs: 250,
    ...overrides,
    stepCount: overrides.stepCount ?? 0,
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
  failedTasks?: readonly string[];
  mergeOutput?: MergeOutput;
  mergeThrows?: Error;
  spawnedInputs?: HeadInput[];
}): HeadRuntime {
  const { reports = {}, failedTasks = [], mergeOutput, mergeThrows, spawnedInputs } = opts;

  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      spawnedInputs?.push(input);
      const id = input.id;

      return {
        id,
        async run() {
          // A failed head never reports, as when a real head runtime's call is lost.
          if (failedTasks.includes(input.task)) throw new Error(`the runtime lost head ${id}`);

          return reports[input.task] ?? fakeReport(id, { summary: `Default for ${input.task}` });
        },
        async abort() {  },
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

describe('HeadController.run', () => {
  test('propagates trusted Plan mode to every spawned head', async () => {
    const { journal } = newJournal();
    const spawnedInputs: HeadInput[] = [];
    const controller = new HeadController(buildRuntime({ spawnedInputs }), journal);

    await controller.run({
      mode: 'plan',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      // Each test states the recursion room its scenario spends; one level suffices when heads only report.
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(spawnedInputs).toHaveLength(2);
    expect(spawnedInputs.every((input) => input.mode === 'plan')).toBe(true);
  });

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
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
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
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
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
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-1',
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const cached = present(journal.readCachedMerge('root-1'), 'the cached merge for root-1');

    expect(cached.mergedNarrative).toBe('Cached narrative.');
    expect(cached.costSummary.headCount).toBe(result.costSummary.headCount);
  });

  test('a slow head runs to completion: the controller sets no deadline', async () => {
    const { sql, journal } = newJournal();
    const gate = Promise.withResolvers<void>();
    const runtime = buildRuntime({});
    const originalSpawn = runtime.spawnHead;
    runtime.spawnHead = async (input) => {
      const handle = await originalSpawn(input);

      return {
        ...handle,
        run: async () => {
          await gate.promise;   // the head takes as long as it takes

          return fakeReport(input.id, { summary: 'slow but done' });
        },
      };
    };

    const controller = new HeadController(runtime, journal);

    let settled = false;

    const run = controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    }).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);   // still joined while the head works

    gate.resolve();
    await run;
    const rows = sql<{ status: string }>`SELECT status FROM head_journal`;
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
  });

  test('rejects split when maxDepth budget is exhausted', async () => {
    const { journal } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);

    await expect(controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 0, spawnedAt: Date.now() },
    })).rejects.toThrow(/max depth/i);
  });

  test('rejects split when no heads are provided', async () => {
    const { journal } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);

    await expect(controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: { rationale: 'no heads', heads: [] },
      // Real room: the depth check runs first, so a spent budget would raise its error instead.
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    })).rejects.toThrow(/no head tasks/i);
  });

  /** A head that failed before reporting has unknown usage, not zero; every layer down to SQL must say so. */
  test('a head that failed before reporting carries no usage, and its reporting sibling still counts', async () => {
    const { sql, journal } = newJournal();
    // 'angle A' fails; 'angle B' reports 100 + 80 under its own spawn id so the usage reaches the journal columns.
    const runtime = buildRuntime({ failedTasks: ['angle A'] });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-mixed',
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(result.costSummary.totalTokens).toBe(180);

    // Asserted on the columns: `DEFAULT 0` could not represent unknown.
    const rows = sql<{ status: string; token_input: number | null; token_output: number | null }>`
      SELECT status, token_input, token_output FROM head_journal`;

    const failed = rows.find((r) => r.status === 'errored');
    expect(failed?.token_input).toBeNull();
    expect(failed?.token_output).toBeNull();

    const view = journal.readRun('root-mixed');
    expect(view?.heads.find((h) => h.status === 'errored')?.usage).toEqual({});
    expect(view?.heads.find((h) => h.status === 'completed')?.usage).toEqual({ input: 100, output: 80 });
  });

  test('a split no head reported on has undefined tokens, never 0 — through the cache too', async () => {
    const { journal } = newJournal();
    // Both heads fail before reporting, so the split settles down the deterministic empty-split path.
    const runtime = buildRuntime({ failedTasks: ['angle A', 'angle B'] });
    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-blank',
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });

    expect(result.costSummary.headCount).toBe(2);
    expect(result.costSummary.totalTokens).toBeUndefined();

    // This narrative reaches the parent verbatim; "0 tokens" would tell the agent a failed delegation was free.
    expect(result.mergedNarrative).not.toContain('0 tokens');
    expect(result.mergedNarrative).toContain('tokens unreported');

    // NULL survives the durable round-trip, so a replayed merge makes the same claim.
    expect(journal.readRun('root-blank')?.merge?.totalTokens).toBeNull();
    expect(journal.readCachedMerge('root-blank')?.costSummary.totalTokens).toBeUndefined();
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
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toContain('Merge synthesis unavailable');
    expect(result.mergedNarrative).toContain('LLM timeout');
    expect(result.mergedNarrative).toContain('A finding');
    expect(result.mergedNarrative).toContain('B finding');
    expect(result.selectedDecisions.length).toBe(2);
  });

  test('falls back when merge LLM returns schema-invalid output', async () => {
    const { journal } = newJournal();
    const malformed = fakeMergeOutput('invalid');

    for (const key of Object.keys(malformed)) Reflect.deleteProperty(malformed, key);

    const spawner = buildRuntime({});

    const runtime: HeadRuntime = {
      spawnHead: spawner.spawnHead,
      mergeLLM: async () => malformed,
    };

    const controller = new HeadController(runtime, journal);

    const result = await controller.run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toContain('Merge synthesis unavailable');
    expect(result.mergedNarrative).toContain('schema invalid');
  });

  test('honors merge strategy in the prompt — synthesize / best_of / consensus', async () => {
    const { journal } = newJournal();
    const promptsSeen: string[] = [];

    const spawner = buildRuntime({});

    const runtime: HeadRuntime = {
      spawnHead: spawner.spawnHead,
      mergeLLM: async (prompt) => {
        promptsSeen.push(prompt);

        return fakeMergeOutput('ok');
      },
    };

    const controller = new HeadController(runtime, journal);

    const strategies: MergeStrategy[] = ['synthesize', 'best_of', 'consensus'];

    for (const strategy of strategies) {
      await controller.run({
      mode: 'build',
        parentHeadId: null,
        inheritedContext: baseContext,
        request: { ...baseRequest, mergeStrategy: strategy },
        parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
      });
    }

    expect(promptsSeen).toHaveLength(3);
    expect(promptsSeen[0]).toContain('synthesize');
    expect(promptsSeen[1]).toContain('best_of');
    expect(promptsSeen[2]).toContain('consensus');
  });

  test('records the per-head step trace; listRuns round-trips it', async () => {
    const { journal } = newJournal();

    // Report id must match the spawned `input.id` for `recordReport` to land.
    const runtime: HeadRuntime = {
      async spawnHead(input) {
        return {
          id: input.id,
          async run() {
            return fakeReport(input.id, { stepCount: 2 });
          },
          async abort() {},
        };
      },
      mergeLLM: async () => fakeMergeOutput('ok'),
    };

    const controller = new HeadController(runtime, journal);
    await controller.run({
      mode: 'build',
      parentHeadId: null, rootId: 'r-steps',
      inheritedContext: baseContext,
      request: { rationale: 'trace test', heads: [{ task: 'angle A', rationale: 'a' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const run = present(journal.listRuns(10).find((r) => r.rootId === 'r-steps'), 'the r-steps run');

    expect(run.heads).toHaveLength(1);
    // The trace reaches the journal per step via `HeadInferenceDeps.reportStep`, never from the finished report,
    // or a late report could overwrite live rows.
    expect(journal.readSteps(run.heads[0].id)).toHaveLength(0);
  });

  test('a head whose spawn throws still yields a MergeResult carrying its errored report and the survivor', async () => {
    const { sql, journal } = newJournal();

    const runtime: HeadRuntime = {
      async spawnHead(input: HeadInput): Promise<SpawnedHead> {
        if (input.task === 'angle A') throw new Error('spawn blew up');

        return {
          id: input.id,
          async run() { return fakeReport(input.id, { summary: 'B finding' }); },
          async abort() {},
        };
      },
      mergeLLM: async () => fakeMergeOutput('Merged with one survivor.'),
    };

    const splitIds: string[] = [];

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-spawn-fail',
      inheritedContext: baseContext,
      request: baseRequest,
      onPhase: (e) => { if (e.kind === 'split') splitIds.push(...e.headIds); },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.mergedNarrative).toBe('Merged with one survivor.');
    expect(result.costSummary.headCount).toBe(2);
    expect(result.costSummary.headsWithFindings).toBe(1);
    expect(result.evidenceAggregate).toHaveLength(1);
    expect(splitIds).toHaveLength(1);

    const rows = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal`;

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.status === 'errored')?.error_message).toContain('spawn blew up');
    expect(rows.find((r) => r.status === 'completed')?.id).toBe(splitIds[0]);
  });
});

/** A head that stopped without banking anything observed nothing; its silence must not reach the parent as a fact. */
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
      mergeLLM: async (...args) => {
        mergeCalls++;

        return base.mergeLLM(...args);
      },
    };

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(mergeCalls).toBe(0);
    expect(result.costSummary.headsWithFindings).toBe(0);
    expect(result.mergedNarrative).toContain('No head produced findings');
    expect(result.mergedNarrative).toContain('budget_exceeded');
    expect(result.mergedNarrative).toContain('stream closed');
    expect(result.mergedNarrative).toContain('do not infer a cause from it');
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
      mergeLLM: async (p, schema) => {
        prompt = p;

        return base.mergeLLM(p, schema);
      },
    };

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
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
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.costSummary.headsWithFindings).toBe(1);
    expect(result.mergedNarrative).toBe('One head got partway.');
  });

  test('the cached replay reports the same findings count as the live merge', async () => {
    const { journal } = newJournal();

    // Reports carry the spawned id so they land on the rows the cached read counts.
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
      mode: 'build',
      parentHeadId: null, rootId: 'root-1', inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const cached = journal.readCachedMerge('root-1');
    expect(cached?.costSummary.headsWithFindings).toBe(live.costSummary.headsWithFindings);
  });
});

describe('HeadJournal.listLive — the live fork roster', () => {
  const spawn = (journal: HeadJournal, rootId: string, id: string) => journal.insertSpawn({
    id, parentId: null, rootId, depth: 1, task: `t-${id}`, rationale: 'why',
    mode: 'build',
    inheritedContext: [], mergeStrategy: 'consensus',
    budget: { maxDepth: 2, spawnedAt: Date.now() },
    loop: defaultLoopOrigin('head'),
  });

  test('a run with heads still running is reported with its progress and its split rationale', () => {
    const { journal } = newJournal();
    journal.recordSplit('root-a', 'explore two angles', Date.now());
    spawn(journal, 'root-a', 'h1');
    spawn(journal, 'root-a', 'h2');
    journal.recordReport(fakeReport('h1'));

    expect(journal.listLive()).toEqual({
      items: [{ rootId: 'root-a', rationale: 'explore two angles', running: 1, total: 2 }],
      total: 1,
    });
  });

  test('a run whose heads have all settled is no longer live', () => {
    const { journal } = newJournal();
    journal.recordSplit('root-a', 'why', Date.now());
    spawn(journal, 'root-a', 'h1');
    journal.recordReport(fakeReport('h1'));
    expect(journal.listLive()).toEqual({ items: [], total: 0 });
  });

  test('an unlabelled split still reports, and the roster is capped', () => {
    const { journal } = newJournal();

    for (let i = 0; i < 4; i++) spawn(journal, `root-${i}`, `h${i}`);
    const live = journal.listLive(2);
    expect(live.items).toHaveLength(2);
    // The bound cut the page, not the count.
    expect(live.total).toBe(4);
    expect(live.items.every((run) => run.rationale === '')).toBe(true);
  });

  test('the recovery authority returns every running run, independent of roster page size', () => {
    const { journal } = newJournal();

    for (let index = 0; index < 105; index += 1) {
      spawn(journal, `branch-${index}`, `branch-${index}-head`);
    }

    expect(journal.listLive(8)).toMatchObject({ total: 105 });
    expect(journal.listRunningRuns()).toHaveLength(105);

    journal.recordReport(fakeReport('branch-0-head'));
    const remaining = journal.listRunningRuns();
    expect(remaining).toHaveLength(104);
    expect(remaining.some((run) => run.rootId === 'branch-0')).toBe(false);
  });

  // The roster is read every model step and the journal has no GC, so its plan must be bounded by open runs;
  // a full scan of head_journal is the regression. The statement is captured from the journal itself.
  test('the roster does not read the settled journal', () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    initHeadsTables(execRaw);
    const inner = makeSql(db);
    // Bound over the underlying executor so the capture holds only the journal's statements.
    const actor = createTestActor(inner, execRaw, crypto.randomUUID(), 'roster-test');
    const statements: Array<{ text: string; values: SqlValue[] }> = [];

    const capturing: typeof inner = <T,>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
      statements.push({ text: strings.join('?'), values });

      return inner<T>(strings, ...values);
    };

    const journal = new HeadJournal(capturing, actor);

    journal.recordSplit('root-live', 'still going', Date.now());
    spawn(journal, 'root-live', 'live-1');

    for (let i = 0; i < 200; i++) {
      journal.recordSplit(`root-old-${i}`, 'done', i);
      spawn(journal, `root-old-${i}`, `old-${i}`);
      journal.recordReport(fakeReport(`old-${i}`));
    }

    statements.length = 0;
    expect(journal.listLive()).toEqual({
      items: [{ rootId: 'root-live', rationale: 'still going', running: 1, total: 1 }],
      total: 1,
    });

    // The count and the page must both use the status index.
    expect(statements).toHaveLength(2);

    for (const { text, values } of statements) {
      // Bound with the statement's own values; the plan is only honest against the real parameters.
      const bound: SQLQueryBindings[] = values.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value);

      const plan = db.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${text}`).all(...bound);
      const details = plan.map((row) => row.detail).join('\n');
      expect(details).not.toMatch(/\bSCAN\b/);
      expect(details).toContain('idx_head_journal_status');
    }
  });
});

describe('HeadJournal.listRuns — grouping (the #179 quirk fix)', () => {
  test('a top-level split (synthetic root, all heads parent_id NULL) is ONE run, not N', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({ mergeOutput: fakeMergeOutput('Merged A+B.') });
    const controller = new HeadController(runtime, journal);
    await controller.run({
      mode: 'build',
      parentHeadId: null, rootId: 'top-root',
      inheritedContext: baseContext,
      request: { rationale: 'Explore two angles', heads: baseRequest.heads },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const runs = journal.listRuns(10);
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
      mode: 'build',
        parentHeadId: null, rootId: root,
        inheritedContext: baseContext,
        request: { rationale: `r-${root}`, heads: [{ task: `t-${root}`, rationale: 'x' }] },
        parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
      });
    }

    const runs = journal.listRuns(2);
    expect(runs).toHaveLength(2);
    // newest-first by MIN(spawned_at); all share ~same spawnedAt so just assert count + distinctness
    expect(new Set(runs.map((r) => r.rootId)).size).toBe(2);
  });

  test('an exact run lookup is not bounded by the recent-run window', async () => {
    const { journal, db } = newJournal();
    const controller = new HeadController(buildRuntime({}), journal);

    for (const root of ['bookmarked', 'newer-1', 'newer-2']) {
      await controller.run({
        mode: 'build',
        parentHeadId: null,
        rootId: root,
        inheritedContext: baseContext,
        request: { rationale: `r-${root}`, heads: [{ task: `t-${root}`, rationale: 'x' }] },
        parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
      });
    }

    db.prepare("UPDATE head_journal SET spawned_at = 1 WHERE root_id = 'bookmarked'").run();
    db.prepare("UPDATE head_journal SET spawned_at = 2 WHERE root_id = 'newer-1'").run();
    db.prepare("UPDATE head_journal SET spawned_at = 3 WHERE root_id = 'newer-2'").run();

    expect(journal.listRuns(2).some((run) => run.rootId === 'bookmarked')).toBe(false);
    expect(journal.readRun('bookmarked')).toMatchObject({
      rootId: 'bookmarked', rationale: 'r-bookmarked',
    });
    expect(journal.readRun('missing')).toBeNull();
  });

  test('child budget is derived from parent: one level less deep', async () => {
    const { journal } = newJournal();
    const spawns: HeadInput[] = [];

    const runtime: HeadRuntime = {
      async spawnHead(input) {
        spawns.push(input);

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
      mode: 'build',
      parentHeadId: null,
      inheritedContext: baseContext,
      request: baseRequest, // 2 heads
      parentBudget: { maxDepth: 3, spawnedAt: Date.now() },
    });

    const firstSpawn = present(spawns[0], 'the first spawned head input');

    expect(firstSpawn.budget.maxDepth).toBe(2);     // depth - 1
    expect(firstSpawn.depth).toBe(1);               // 3 - 2 = 1
  });
});

/** blind_spots, the merge's negative-space field. These lock its carriage, not its wording; see heads/merge-schema.ts. */
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
      mode: 'build',
      parentHeadId: null,
      rootId: 'root-bs',
      inheritedContext: baseContext,
      request: baseRequest,
      onPhase: (e) => { if (e.kind === 'merge') events.push([...e.blindSpots]); },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.blindSpots).toEqual(spots);
    expect(events).toEqual([spots]);
    const cached = journal.readCachedMerge('root-bs');

    if (!cached) throw new Error('expected cached merge');
    expect(cached.blindSpots).toEqual(spots);
  });

  test('degrades to [] when the merge model omits the key, exactly like the other list fields', async () => {
    const { journal } = newJournal();
    const narrativeOnly = fakeMergeOutput('Just a narrative.');

    for (const key of ['selected_decisions', 'unresolved_questions', 'recommendations', 'blind_spots']) {
      Reflect.deleteProperty(narrativeOnly, key);
    }

    const runtime: HeadRuntime = {
      ...buildRuntime({}),
      mergeLLM: async () => narrativeOnly,
    };

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
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
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.costSummary.headsWithFindings).toBe(0);
    expect(result.blindSpots).toEqual([]);
  });

  test('a merge that fails reports no blind spots rather than a stale or invented list', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({ mergeThrows: new Error('merge model unreachable') });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
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
      mergeLLM: async (p, schema) => {
        prompt = p;

        return base.mergeLLM(p, schema);
      },
    };

    await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: baseContext, request: baseRequest,
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(prompt).toContain('blind_spots');
    // Without the distinction the model refiles the heads' open questions here.
    expect(prompt).toContain('A question a head RAISED is an unresolved_question');
    expect(prompt).toContain('Return []');
  });
});
