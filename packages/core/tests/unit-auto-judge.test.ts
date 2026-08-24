/**
 * Unit tests for runAutoShadowEval — auto-judge shadow eval loop.
 */

import { describe, test, expect } from 'bun:test';
import {
  runAutoShadowEval,
  initScaffoldTables, initShadowTables, getPendingScaffold,
  DEFAULT_SHADOW_CONFIG, DEFAULT_AUTO_JUDGE_CONFIG,
  type JudgeOutput,
  type StructuredJudgeFn,
} from '../src/index';
import { createTestRuntime } from './helpers';

const noOpLlmStream = async function* () { yield ''; };

/** The live scaffold's output in these tests. Distinctive on purpose: the
 *  pending's output under the mock executor is a scaffold error string, and a
 *  content-based judge must not confuse the two. */
const LIVE_OUTPUT = '<<live-answer>>';

/** The two response bodies of a judge prompt, in presentation order. */
function judgePromptResponses(prompt: string): [string, string] {
  const head = '\nResponse A:\n', mid = '\n\nResponse B:\n', tail = '\n\nRespond with';
  const bMark = prompt.indexOf(mid);
  return [
    prompt.slice(prompt.indexOf(head) + head.length, bMark),
    prompt.slice(bMark + mid.length, prompt.indexOf(tail)),
  ];
}

/**
 * A judge that always favours `winner`. It has to identify the candidates by
 * CONTENT — the protocol presents them unlabelled in a randomized order, and
 * a position-based judge would flip on the swapped call and score every trial
 * a tie. `currentOutput` is the text the live scaffold produced this turn.
 */
function makeJudge(
  winner: 'current' | 'pending' | 'tie',
  currentOutput: string,
  rationale = 'mock',
): StructuredJudgeFn {
  return async (prompt) => {
    const [a] = judgePromptResponses(prompt);
    const currentSlot = a.includes(currentOutput) ? 'a' : 'b';
    const pendingSlot = currentSlot === 'a' ? 'b' : 'a';
    const verdict: JudgeOutput['winner'] =
      winner === 'current' ? currentSlot : winner === 'pending' ? pendingSlot : 'tie';
    const scoreFor = (slot: 'a' | 'b') =>
      slot === currentSlot ? (winner === 'current' ? 0.8 : 0.4) : (winner === 'pending' ? 0.8 : 0.4);
    return { winner: verdict, rationale, scoreA: scoreFor('a'), scoreB: scoreFor('b') };
  };
}

async function setup(): Promise<ReturnType<typeof createTestRuntime>['rt']> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initShadowTables(rt.storage.execRaw);
  // Bootstrap a pending scaffold v1, current v0.
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'initial', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (1, ${Date.now()}, 'alternative', 'pending')`;
  // Write the pending scaffold's backup file (executor reads this).
  await rt.storage.vfs.writeFile(
    'scaffold/agent.js.v1',
    'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }',
  );
  // Also write current.
  await rt.identity.scaffold.write(
    'async function* run(rt, task) { yield { type: "chunk", data: "current: " + task }; }',
  );
  return rt;
}

describe('runAutoShadowEval', () => {
  test('skips when no pending scaffold', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initShadowTables(rt.storage.execRaw);
    const result = await runAutoShadowEval({
      rt, task: 'hello', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('current', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_pending');
  });

  test('runs + records evaluation on a queued trial', async () => {
    const rt = await setup();
    const inner = makeJudge('pending', LIVE_OUTPUT);
    let judgeCalls = 0;
    const result = await runAutoShadowEval({
      rt, task: 'compute 2+2', currentOutput: LIVE_OUTPUT,
      judge: async (prompt, schema) => { judgeCalls++; return inner(prompt, schema); },
      llmStream: noOpLlmStream,
      config: { autoApply: false },
    });
    expect(judgeCalls).toBe(2); // one call per presentation order
    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('pending');

    // Verify it was recorded.
    const pending = getPendingScaffold(rt.storage.sql)!;
    expect(pending.trialsSoFar).toBe(1);
    expect(pending.pendingWins).toBe(1);
  });

  test('returns decision=continue when below minTrials', async () => {
    const rt = await setup();
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });
    expect(result.decision).toBe('continue');
    expect(result.applied).toBeNull();
  });

  test('auto-applies when conclusive + autoApply=true', async () => {
    const rt = await setup();
    // Seed 5 prior pending wins so this 6th call crosses the promote threshold.
    for (let i = 0; i < 5; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      config: { autoApply: true },
      random: () => 0,
    });
    expect(result.decision).toBe('promote');
    expect(result.applied).toBe('promote');

    // v1 should be 'current'; v0 should be 'historical'.
    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(1)).toBe('current');
    expect(map.get(0)).toBe('historical');
  });

  test('auto-applies ROLLBACK on regressions beyond tolerance (regression veto, end-to-end)', async () => {
    const rt = await setup();
    // Seed 5 pending wins + 1 loss (a strong 5-1 record, within the
    // maxRegressions=1 tolerance); this turn the judge picks 'current' again —
    // the SECOND regression must roll the pending back despite the 5-2 record
    // (winRate 0.71 would promote on win-rate alone). Proves the hardened gate
    // gates auto-apply.
    for (let i = 0; i < 6; i++) {
      const winner = i < 5 ? 'pending' : 'current';
      void rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, ${winner}, 'seed', ${Date.now()})`;
    }
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('current', LIVE_OUTPUT), // the regression
      llmStream: noOpLlmStream,
      config: { autoApply: true },
      random: () => 0,
    });
    expect(result.decision).toBe('rollback');
    expect(result.applied).toBe('rollback');

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(0)).toBe('current');      // live scaffold unchanged
    expect(map.get(1)).toBe('rolled_back');  // bad pending discarded
  });

  test('records the STATUS-derived current version after rollback cycles', async () => {
    // Regression: the eval row hardcoded currentVersion = pending - 1. After
    // a rollback cycle the numbering is non-contiguous (live=v0 while the new
    // pending is v3), so pending-1 pointed at a rolled_back row.
    const rt = await setup();
    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back' WHERE version = 1`;
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (2, ${Date.now()}, 'second attempt', 'rolled_back')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (3, ${Date.now()}, 'third attempt', 'pending')`;
    await rt.storage.vfs.writeFile(
      'scaffold/agent.js.v3',
      'async function* run(rt, task) { yield { type: "chunk", data: "v3: " + task }; }',
    );

    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });
    expect(result.skipped).toBe(false);

    const row = rt.storage.sql<{ current_version: number; pending_version: number }>`
      SELECT current_version, pending_version FROM scaffold_evaluations`[0]!;
    expect(row.pending_version).toBe(3);
    expect(row.current_version).toBe(0); // the live status='current' row, NOT 2
  });

  test('skips gracefully when pending file unreadable', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initShadowTables(rt.storage.execRaw);
    // Pending row exists but no scaffold/agent.js current file. version()
    // returns max(scaffold_versions.version)=1 which matches our pending=1,
    // so readScaffoldVersion follows the "read current" path; with no file,
    // it throws ENOENT, caught in the try/catch → returns null.
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial', 'current')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'alt', 'pending')`;
    // Explicitly DO NOT write 'scaffold/agent.js'.

    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });
    // One outcome, not two. This accepted BOTH — skipped with the reason, or
    // not skipped with an evaluation recorded — so the claim in the title was
    // undefended: a regression that stopped skipping and judged a missing
    // scaffold as an empty candidate took the `else` arm and stayed green. The
    // comment even argued "it shouldn't have recorded a meaningful evaluation"
    // while the `else` asserted that it had.
    //
    // `readScaffoldVersion` returns null for an absent file, and auto-judge.ts
    // turns that into `{ skipped: true, reason: 'pending_unreadable' }` before
    // any scaffold runs. That is the contract.
    expect(result).toEqual({ skipped: true, reason: 'pending_unreadable' });
    // Skipping means nothing was judged and nothing was written, so a later
    // trial still sees a clean slate.
    expect(rt.storage.sql`SELECT COUNT(*) AS n FROM scaffold_evaluations`[0]).toEqual({ n: 0 });
  });

  test('config defaults honor DEFAULT_AUTO_JUDGE_CONFIG', () => {
    // Sanity check on the public defaults.
    expect(DEFAULT_SHADOW_CONFIG.minTrials).toBe(5);
    expect(DEFAULT_SHADOW_CONFIG.promoteThreshold).toBe(0.6);
  });

  test('the trial carries no elapsed deadline — the config exposes no timeout knob', () => {
    // A trial used to run the candidate under a wall clock; a candidate that
    // attempted substantial work was cut and scored 0 for running out of room
    // rather than for being worse. The candidate now runs to completion
    // exactly as the live turn did, so there is no field left to tune and no
    // default to drift.
    expect('scaffoldTimeoutMs' in DEFAULT_AUTO_JUDGE_CONFIG).toBe(false);
    expect('scaffoldTimeoutMs' in structuredClone(DEFAULT_AUTO_JUDGE_CONFIG)).toBe(false);
  });

  test('a slow pending scaffold is awaited, not cut', async () => {
    const rt = await setup();
    // The executor holds the trial's scaffold run open until released; the
    // eval must still be pending while it runs, then complete on the run's
    // own settlement — never on a timer.
    const gate = Promise.withResolvers<void>();
    let executorReleased = false;
    rt.executor = {
      languages: ['javascript'],
      execute: async () => {
        await gate.promise;
        executorReleased = true;
        return { result: undefined };
      },
    };
    const evalPromise = runAutoShadowEval({
      rt, task: 'slow candidate', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });
    await Promise.resolve();
    let settled = false;
    void evalPromise.then(() => { settled = true; });
    expect(settled).toBe(false);          // still running with the executor gated

    gate.resolve();
    const result = await evalPromise;
    expect(executorReleased).toBe(true);
    expect(result.skipped).toBe(false);
  });
});

/**
 * The order-swapped double-win protocol — the position/status-quo debiasing
 * that sits directly upstream of the promotion rule.
 */
describe('order-swapped double-win judging', () => {
  interface RecordingJudge {
    fn: StructuredJudgeFn;
    prompts: string[];
  }

  /** Records every prompt the judge saw and answers with a fixed slot. */
  function recordingJudge(answer: (call: number) => JudgeOutput): RecordingJudge {
    const prompts: string[] = [];
    return {
      prompts,
      fn: async (prompt) => { prompts.push(prompt); return answer(prompts.length - 1); },
    };
  }

  /** Runs one trial with an injected RNG. `orderRoll` decides the presentation
   *  order of the FIRST call (< 0.5 → pending first). */
  async function runTrial(judge: StructuredJudgeFn, orderRoll: number) {
    const rt = await setup();
    return runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge,
      llmStream: noOpLlmStream,
      random: () => orderRoll,
    });
  }

  test('calls the judge twice with the two orders swapped', async () => {
    const judge = recordingJudge(() => ({ winner: 'tie', rationale: 'r', scoreA: 0.5, scoreB: 0.5 }));
    await runTrial(judge.fn, 0);

    expect(judge.prompts).toHaveLength(2);
    const [first, second] = judge.prompts.map(judgePromptResponses);
    expect(first[0]).toBe(second[1]);
    expect(first[1]).toBe(second[0]);
    expect(first[0]).not.toBe(first[1]);
  });

  test('neutral labels — no CURRENT / PENDING provenance reaches the judge', async () => {
    const judge = recordingJudge(() => ({ winner: 'tie', rationale: 'r', scoreA: 0.5, scoreB: 0.5 }));
    await runTrial(judge.fn, 0);

    // The floor: a containment claim over an empty set is true of nothing, so a
    // trial that never reached the judge would satisfy every line below.
    expect(judge.prompts).toHaveLength(2);
    for (const prompt of judge.prompts) {
      expect(prompt).not.toContain('CURRENT');
      expect(prompt).not.toContain('PENDING');
      expect(prompt).toContain('\nResponse A:\n');
      expect(prompt).toContain('\nResponse B:\n');
    }
  });

  test('the RNG picks the presentation order, and both orderings are reachable', async () => {
    const pendingFirst = recordingJudge(() => ({ winner: 'tie', rationale: 'r', scoreA: 0.5, scoreB: 0.5 }));
    await runTrial(pendingFirst.fn, 0.0);
    const currentFirst = recordingJudge(() => ({ winner: 'tie', rationale: 'r', scoreA: 0.5, scoreB: 0.5 }));
    await runTrial(currentFirst.fn, 0.99);

    expect(judgePromptResponses(pendingFirst.prompts[0])[1]).toContain(LIVE_OUTPUT);
    expect(judgePromptResponses(currentFirst.prompts[0])[0]).toContain(LIVE_OUTPUT);
    // Swapping the roll swaps the whole pair, not just the first call.
    expect(judgePromptResponses(pendingFirst.prompts[1])[0]).toContain(LIVE_OUTPUT);
    expect(judgePromptResponses(currentFirst.prompts[1])[1]).toContain(LIVE_OUTPUT);
  });

  test('winning BOTH orders is a win, and the scores average across them', async () => {
    // This judge always picks the response holding LIVE_OUTPUT — a
    // content-based verdict, so it survives the swap and takes both orders.
    const result = await runTrial(makeJudge('current', LIVE_OUTPUT), 0);
    expect(result.evaluation?.winner).toBe('current');
    expect(result.evaluation?.currentScore).toBe(0.8);
    expect(result.evaluation?.pendingScore).toBe(0.4);
  });

  test('a flip between the two orders is a TIE, not a coin-flip win', async () => {
    // The pathological judge: always picks "Response A". Under the old
    // single-call protocol that was a guaranteed win for whoever sat in slot A
    // — the incumbent, every single time.
    const judge = recordingJudge(() => ({ winner: 'a', rationale: 'position', scoreA: 0.9, scoreB: 0.1 }));
    const result = await runTrial(judge.fn, 0);

    expect(result.evaluation?.winner).toBe('tie');
    expect(result.evaluation?.rationale).toContain('Order-swap flip');
    // Averaging across the swap cancels the positional score inflation too.
    expect(result.evaluation?.currentScore).toBe(0.5);
    expect(result.evaluation?.pendingScore).toBe(0.5);
  });

  test('a tie in either order blocks the win', async () => {
    const judge = recordingJudge((call) => call === 0
      ? { winner: 'a', rationale: 'first', scoreA: 0.8, scoreB: 0.4 }
      : { winner: 'tie', rationale: 'second', scoreA: 0.6, scoreB: 0.6 });
    const result = await runTrial(judge.fn, 0);
    expect(result.evaluation?.winner).toBe('tie');
    expect(result.evaluation?.rationale).not.toContain('Order-swap flip');
  });

  test('the recorded trial keeps the current/pending contract the promotion rule reads', async () => {
    const rt = await setup();
    await runAutoShadowEval({
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });
    const row = rt.storage.sql<{ winner: string; current_score: number; pending_score: number }>`
      SELECT winner, current_score, pending_score FROM scaffold_evaluations`[0]!;
    expect(row.winner).toBe('pending');
    expect(row.pending_score).toBe(0.8);
    expect(row.current_score).toBe(0.4);
    expect(getPendingScaffold(rt.storage.sql)!.pendingWins).toBe(1);
  });
});
