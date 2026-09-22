/**
 * Grounded heads (THINKING-AUDIT §4 DO-NOW #2): outcome scoring by the MCTS evaluator, k-sample median merge,
 * unclipped evidence, and an Alternate-Takes set per run.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  HeadController, HeadJournal,
  type HeadInput, type HeadReport, type HeadRuntime, type HeadGrounding,
  type SpawnedHead, type SerializedMessage, type MergeOutput,
  type Executor, type LLM,
  initHeadsTables,
} from '../src/index';
import { createJSONLLM, present } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw, captureConsole, createTestActor } from './helpers';

function newJournal() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw);
  const sql = makeSql(db);
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'grounding-test');

  return { sql, journal: new HeadJournal(sql, actor), db, actor };
}

/** Executor whose verdict is decided by whether the code mentions "boom". */
function verdictExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code: string) {
      return code.includes('boom')
        ? { result: undefined, error: 'boom' }
        : { result: undefined };
    },
  };
}

function report(id: string, o: Partial<HeadReport> = {}): HeadReport {
  return {
    id, status: 'completed', summary: `Head ${id} finding.`,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 0, usage: { input: 10, output: 10 },
    wallClockMs: 5, ...o,
  };
}

function mergeOut(narrative: string): MergeOutput {
  return { narrative, selected_decisions: [], unresolved_questions: [], recommendations: [], blind_spots: [] };
}

/** Canned reports keyed by task, a scripted merge LLM, and an optional grounding seam. */
function buildRuntime(opts: {
  reports: Record<string, HeadReport>;
  grounding?: HeadGrounding;
  mergeNarratives?: string[];     // one per merge call (cycles to last)
  mergePrompts?: string[];        // out-param: every merge prompt seen
}): HeadRuntime {
  let mergeCall = 0;

  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      return {
        id: input.id,
        async run() { return { ...opts.reports[input.task], id: input.id }; },
        async abort() {},
      };
    },
    async mergeLLM(prompt): Promise<MergeOutput> {
      opts.mergePrompts?.push(prompt);
      const narrs = opts.mergeNarratives ?? ['merged'];
      const narrative = narrs[Math.min(mergeCall, narrs.length - 1)];
      mergeCall++;

      return mergeOut(narrative);
    },
  };

  if (opts.grounding) runtime.grounding = opts.grounding;

  return runtime;
}

const ctx: SerializedMessage[] = [{ id: 'm1', role: 'user', content: 'go', createdAt: 1 }];

function grounding(over: Partial<HeadGrounding> = {}): HeadGrounding {
  const judge = createJSONLLM({ score: 0.5, rationale: 'ok' });

  return { executor: verdictExecutor(), explorer: judge, judge, ...over };
}

describe('grounded head outcome scores', () => {
  test('a head whose code RAN outscores a head whose code FAILED', async () => {
    const { journal } = newJournal();

    const runtime = buildRuntime({
      reports: {
        good: report('h-good', { summary: 'works', evidence: [{ id: 'e1', kind: 'artifact', body: '```js\nconst x = 42;\n```' }] }),
        bad: report('h-bad', { summary: 'broken', evidence: [{ id: 'e2', kind: 'artifact', body: '```js\nthrow new Error("boom");\n```' }] }),
      },
      grounding: grounding(),
    });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'good', rationale: 'a' }, { task: 'bad', rationale: 'b' }] },
      // Each split forks once, so it states one level of recursion room.
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.grounded).toBe(true);
    expect(result.headScores).toHaveLength(2);
    const good = present(result.headScores.find((s) => s.text === 'works'), "the 'works' head score");
    const bad = present(result.headScores.find((s) => s.text === 'broken'), "the 'broken' head score");
    expect(good.grounding).toBe('execution');
    expect(bad.grounding).toBe('execution');
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.score).toBeLessThanOrEqual(0.3);   // fail band
    expect(good.score).toBeGreaterThanOrEqual(0.6); // pass band
  });

  test('a non-completed head is floored below a completed one without a judge call', async () => {
    const { journal } = newJournal();

    // Judge that throws if ever asked — proves the aborted head spends no call.
    const throwingJudge: LLM = {
      stream() { throw new Error('should not be called for the aborted head'); },
      async complete() { return JSON.stringify({ score: 0.9 }); },
    };

    const runtime = buildRuntime({
      reports: {
        done: report('h-done', { summary: 'finished' }),
        gone: report('h-gone', { status: 'aborted', summary: '' }),
      },
      grounding: grounding({ judge: throwingJudge, explorer: throwingJudge }),
    });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'done', rationale: 'a' }, { task: 'gone', rationale: 'b' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const gone = present(result.headScores.find((s) => s.status === 'aborted'), 'the aborted head score');
    const done = present(result.headScores.find((s) => s.status === 'completed'), 'the completed head score');
    expect(gone.score).toBe(0);
    expect(done.score).toBeGreaterThan(gone.score);
  });

  test('a judge the provider cannot answer costs the split its grounded signal, not the split', async () => {
    // The evaluator propagates judge failures (mcts/evaluation.ts); here a broken judge must not reject `shell`
    // and lose the split.
    const { journal } = newJournal();

    const brokenJudge: LLM = {
      stream() { throw new Error('judge provider unreachable'); },
      async complete(): Promise<string> { throw new Error('judge provider unreachable'); },
    };

    const runtime = buildRuntime({
      reports: { a: report('h-a', { summary: 'found A' }), b: report('h-b', { summary: 'found B' }) },
      grounding: grounding({ judge: brokenJudge, explorer: brokenJudge }),
    });

    const phases: string[] = [];

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      onPhase: (e) => phases.push(e.kind),
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    // The 'merge' phase is what the run-event ledger records a fork's cost from.
    expect(phases).toEqual(['split', 'merge']);
    expect(result.costSummary.headsWithFindings).toBe(2);
    expect(result.mergedNarrative).toBe('merged');
    // No grounded verdict rather than an unearned 0: the judge broke, not the work.
    expect(result.headScores.map((s) => s.score)).toEqual([0.5, 0.5]);
    expect(result.headScores.map((s) => s.status)).toEqual(['completed', 'completed']);
  });

  test('without a grounding seam, scores are neutral and grounded=false', async () => {
    const { journal } = newJournal();
    const runtime = buildRuntime({ reports: { a: report('h-a'), b: report('h-b') } });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(result.grounded).toBe(false);
    expect(result.headScores.every((s) => s.score === 0.5)).toBe(true);
  });

  // Heads reuse the MCTS judge knobs, and the request shares one per-head-score call pool with check
  // generation.
  test('a head judge request the call budget cannot fund is realised at the ceiling AND disclosed', async () => {
    const { journal } = newJournal();

    const runtime = buildRuntime({
      reports: {
        a: report('h-a', {
          summary: 'works',
          evidence: [{ id: 'e1', kind: 'artifact', body: '```js\nconst x = 42;\n```' }],
        }),
      },
      grounding: grounding({ judgeSamples: 20 }),
    });

    const { stderr } = await captureConsole(() => new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    }));

    const lines = stderr.filter((line) => line.includes('"event":"head.judge_ensemble_clamped"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).fields).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 3,
      maxEvalLLMCalls: 4,
    });
  });
});

/** Three synthesized candidates scored by keyword, so the median is known. */
function synthesisScore(prompt: string): number {
  if (prompt.includes('CAND-low')) return 0.1;

  if (prompt.includes('CAND-high')) return 0.9;

  return 0.5;
}

describe('k-sample median merge', () => {
  test('grounded merge runs k samples and keeps the median-scored one', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];

    const scoringJudge: LLM = {
      async *stream() { yield ''; },
      async complete(prompt: string) {
        if (prompt.includes('Synthesized answer:')) {
          const s = synthesisScore(prompt);

          return JSON.stringify({ score: s });
        }

        return JSON.stringify({ score: 0.5 }); // per-head judge
      },
    };

    const runtime = buildRuntime({
      reports: { a: report('h-a'), b: report('h-b') },
      grounding: grounding({ judge: scoringJudge, explorer: scoringJudge, mergeSamples: 3 }),
      mergeNarratives: ['CAND-low', 'CAND-mid', 'CAND-high'],
      mergePrompts,
    });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    // k=3 merge synthesis calls with the same prompt.
    expect(mergePrompts).toHaveLength(3);
    // The median-scored candidate ("mid") wins — not low, not high.
    expect(result.mergedNarrative).toBe('CAND-mid');
  });

  test('a merge judge the provider cannot answer costs the ensemble, not the merge', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];

    // Only the merge-narrative scorer rejects: the k syntheses are paid for, so lose the tie-break, not the
    // merge.
    const halfBrokenJudge: LLM = {
      async *stream() { yield ''; },
      async complete(prompt: string) {
        if (prompt.includes('Synthesized answer:')) throw new Error('judge provider unreachable');

        return JSON.stringify({ score: 0.5 });
      },
    };

    const runtime = buildRuntime({
      reports: { a: report('h-a'), b: report('h-b') },
      grounding: grounding({ judge: halfBrokenJudge, explorer: halfBrokenJudge, mergeSamples: 3 }),
      mergeNarratives: ['CAND-a', 'CAND-b', 'CAND-c'],
      mergePrompts,
    });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    // All k samples were produced and one is the merge, not an exception.
    expect(mergePrompts).toHaveLength(3);
    expect(result.mergedNarrative).toBe('CAND-a');
  });

  test('ungrounded merge is n=1', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];

    const runtime = buildRuntime({
      reports: { a: report('h-a'), b: report('h-b') },
      mergeNarratives: ['only'],
      mergePrompts,
    });

    const result = await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(mergePrompts).toHaveLength(1);
    expect(result.mergedNarrative).toBe('only');
  });
});

describe('evidence is not clipped into the merge', () => {
  test('a long finding body survives verbatim into the merge prompt', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];
    const longBody = 'X'.repeat(1200); // far past a 200-char clip
    const manyEv = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, kind: 'fact' as const, body: `finding-${i}` }));

    const runtime = buildRuntime({
      reports: {
        a: report('h-a', { evidence: [{ id: 'big', kind: 'fact', body: longBody }, ...manyEv] }),
        b: report('h-b'),
      },
      mergePrompts,
    });

    await new HeadController(runtime, journal).run({
      mode: 'build',
      parentHeadId: null, inheritedContext: ctx,
      request: { rationale: 'task', heads: [{ task: 'a', rationale: 'x' }, { task: 'b', rationale: 'y' }] },
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });
    const prompt = mergePrompts[0];
    expect(prompt).toContain(longBody);            // full body, not truncated
    expect(prompt).toContain('finding-8');         // the 9th evidence item (past a slice(0,6))
  });
});
