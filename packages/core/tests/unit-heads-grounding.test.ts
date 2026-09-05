/**
 * Behavior tests for the grounded heads path (THINKING-AUDIT §4 DO-NOW #2).
 *
 *  1. Grounded outcome score — each head's report is scored by the SAME
 *     execution-grounded evaluator the MCTS engine uses. A head whose work
 *     failed/was aborted scores below one whose code ran and held up.
 *  2. k-sample median merge — with a grounding seam the merge runs k synthesis
 *     samples and keeps the median-scored one (not n=1).
 *  3. No evidence clipping — a long finding survives verbatim into the merge
 *     prompt (no 6×200-char truncation).
 *  4. Heads → Alternate-Takes — a completed heads run emits a take set (source
 *     'heads') into the ledger, claimed against the turn so the pick is a
 *     preference signal.
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
import { createJSONLLM } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw, captureConsole } from './helpers';

// ── fakes ────────────────────────────────────────────────────────────

function newJournal() {
  const db = new Database(':memory:');
  initHeadsTables(makeExecRaw(db));
  const sql = makeSql(db);
  return { sql, journal: new HeadJournal(sql), db };
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

/** A runtime returning canned reports keyed by task, a scripted merge LLM, and
 *  an optional grounding seam. Records every merge prompt + counts merge calls. */
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
        async run() { return { ...opts.reports[input.task]!, id: input.id }; },
        async abort() {},
      };
    },
    async mergeLLM(prompt): Promise<MergeOutput> {
      opts.mergePrompts?.push(prompt);
      const narrs = opts.mergeNarratives ?? ['merged'];
      const narrative = narrs[Math.min(mergeCall, narrs.length - 1)]!;
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

// ── 1. grounded outcome score ─────────────────────────────────────────

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
    });

    expect(result.grounded).toBe(true);
    expect(result.headScores).toHaveLength(2);
    const good = result.headScores.find((s) => s.text === 'works')!;
    const bad = result.headScores.find((s) => s.text === 'broken')!;
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
    });
    const gone = result.headScores.find((s) => s.status === 'aborted')!;
    const done = result.headScores.find((s) => s.status === 'completed')!;
    expect(gone.score).toBe(0);
    expect(done.score).toBeGreaterThan(gone.score);
  });

  test('a judge the provider cannot answer costs the split its grounded signal, not the split', async () => {
    // The heads have already run and banked their findings. The shared evaluator
    // propagates a judge FAILURE deliberately (mcts/evaluation.ts) because the
    // MCTS engine answers one per branch under its own allSettled; this caller
    // has no branch to fail, so an unreachable or rate-limited judge used to
    // reject `run` and take the whole split with it — discarding both reports,
    // the merge that would have carried them, and the `head_merge` phase that is
    // the only durable trace a fork ran at all.
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
    });

    // Reaching 'merge' is the whole point: that phase is what the run-event
    // ledger records a fork's cost and productivity from.
    expect(phases).toEqual(['split', 'merge']);
    expect(result.costSummary.headsWithFindings).toBe(2);
    expect(result.mergedNarrative).toBe('merged');
    // Each head reports the absence of a grounded verdict rather than a 0 it
    // did not earn — its judge broke, its work did not.
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
    });
    expect(result.grounded).toBe(false);
    expect(result.headScores.every((s) => s.score === 0.5)).toBe(true);
  });

  // The invisible spend ceiling (2026-08-18): heads reuse the MCTS judge knobs,
  // so a split told `judgeSamples: 20` scored its heads with three-sample
  // ensembles — the request shares one per-head-score call pool with check
  // generation — and nothing said so.
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
    }));

    const lines = stderr.filter((line) => line.includes('"event":"head.judge_ensemble_clamped"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).fields).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 3,
      maxEvalLLMCalls: 4,
    });
  });
});

// ── 2. k-sample median merge ──────────────────────────────────────────

describe('k-sample median merge', () => {
  test('grounded merge runs k samples and keeps the median-scored one', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];
    // Three distinct candidate narratives; the judge scores them low/mid/high
    // by keyword so the median ("mid") must be the one selected.
    const scoringJudge: LLM = {
      async *stream() { yield ''; },
      async complete(prompt: string) {
        if (prompt.includes('Synthesized answer:')) {
          const s = prompt.includes('CAND-low') ? 0.1 : prompt.includes('CAND-high') ? 0.9 : 0.5;
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
    });
    // k=3 merge synthesis calls were made (the merge prompt is identical each time).
    expect(mergePrompts).toHaveLength(3);
    // The median-scored candidate ("mid") wins — not low, not high.
    expect(result.mergedNarrative).toBe('CAND-mid');
  });

  test('a merge judge the provider cannot answer costs the ensemble, not the merge', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];
    // The per-head judge answers; only the merge-narrative scorer rejects. The
    // k syntheses are already in hand and paid for at that point, so losing the
    // ensemble's tie-break is the honest cost — losing the merge is not. This
    // only bites with mergeSamples > 1, which is why nothing caught it when the
    // judge-failure catch was removed; k defaults to 1.
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
    });
    // All k samples were still produced, and one of them is the merge — not an
    // exception that discards the split and its head_merge ledger row.
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
    });
    expect(mergePrompts).toHaveLength(1);
    expect(result.mergedNarrative).toBe('only');
  });
});

// ── 3. no evidence clipping ───────────────────────────────────────────

describe('evidence is not clipped into the merge', () => {
  test('a long finding body survives verbatim into the merge prompt', async () => {
    const { journal } = newJournal();
    const mergePrompts: string[] = [];
    const longBody = 'X'.repeat(1200); // far past the old 200-char clip
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
    });
    const prompt = mergePrompts[0]!;
    expect(prompt).toContain(longBody);            // full body, not truncated
    expect(prompt).toContain('finding-8');         // the 9th evidence item (past the old slice(0,6))
  });
});
