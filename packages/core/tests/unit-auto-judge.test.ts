import { describe, test, expect } from 'bun:test';
import {
  runAutoShadowEval,
  initScaffoldTables, initShadowTables, getPendingScaffold,
  DEFAULT_SHADOW_CONFIG, DEFAULT_AUTO_JUDGE_CONFIG,
  type JudgeOutput,
  type StructuredJudgeFn,
} from '../src/index';
import { createTestRuntime } from './helpers';
import type { ChatEvent } from '../src/chat';
import { RunEventRecorder } from '../src/events/recorder';
import { present } from '@kinu.run/test-utils';

const noOpLlmStream = async function* () { yield { type: 'text-delta', delta: '' } satisfies ChatEvent; };

/** Distinct from the mock executor's scaffold error string, so a content-based judge cannot confuse them. */
const LIVE_OUTPUT = '<<live-answer>>';

function judgePromptResponses(prompt: string): [string, string] {
  const head = '\nResponse A:\n', mid = '\n\nResponse B:\n', tail = '\n\nRespond with';
  const bMark = prompt.indexOf(mid);

  return [
    prompt.slice(prompt.indexOf(head) + head.length, bMark),
    prompt.slice(bMark + mid.length, prompt.indexOf(tail)),
  ];
}

/** Picks `winner` by content: candidates arrive unlabelled in random order, so a positional judge would tie. */
function makeJudge(
  winner: 'current' | 'pending' | 'tie',
  currentOutput: string,
  rationale = 'mock',
): StructuredJudgeFn {
  return async (prompt) => {
    const [a] = judgePromptResponses(prompt);
    const currentSlot = a.includes(currentOutput) ? 'a' : 'b';
    const pendingSlot = currentSlot === 'a' ? 'b' : 'a';

    const wonBy = { current: currentSlot, pending: pendingSlot, tie: 'tie' } as const;
    const verdict: JudgeOutput['winner'] = wonBy[winner];

    const scoreFor = (slot: 'a' | 'b') => (slot === verdict ? 0.8 : 0.4);

    return { winner: verdict, rationale, scoreA: scoreFor('a'), scoreB: scoreFor('b') };
  };
}

async function setup(): Promise<ReturnType<typeof createTestRuntime>['rt']> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
  initShadowTables(rt.storage.execRaw);
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'initial', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 1, ${Date.now()}, 'alternative', 'pending')`;
  await rt.storage.vfs.writeFile(
    'scaffold/agent.js.v1',
    'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }',
  );
  await rt.identity.scaffold.write(
    'async function* run(rt, task) { yield { type: "chunk", data: "current: " + task }; }',
  );

  return rt;
}

describe('runAutoShadowEval', () => {
  test('skips when no pending scaffold', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
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
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 'compute 2+2', currentOutput: LIVE_OUTPUT,
      judge: async (prompt, schema) => {
        judgeCalls++;

        return inner(prompt, schema);
      },
      llmStream: noOpLlmStream,
      config: { autoApply: false },
    });

    expect(judgeCalls).toBe(2);
    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('pending');

    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');
    expect(pending.trialsSoFar).toBe(1);
    expect(pending.pendingWins).toBe(1);
  });

  test('returns decision=continue when below minTrials', async () => {
    const rt = await setup();

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
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

    for (let i = 0; i < 5; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations (actor_id, id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${rt.actor.actorId}, ${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      config: { autoApply: true },
      random: () => 0,
    });

    expect(result.decision).toBe('promote');
    expect(result.applied).toBe('promote');

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} ORDER BY version`;

    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(1)).toBe('current');
    expect(map.get(0)).toBe('historical');
  });

  test('auto-applies ROLLBACK on regressions beyond tolerance (regression veto, end-to-end)', async () => {
    const rt = await setup();

    // A 5-2 record would promote on win-rate alone; the second regression must still roll back.
    for (let i = 0; i < 6; i++) {
      const winner = i < 5 ? 'pending' : 'current';
      void rt.storage.sql`INSERT INTO scaffold_evaluations (actor_id, id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${rt.actor.actorId}, ${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, ${winner}, 'seed', ${Date.now()})`;
    }

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('current', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      config: { autoApply: true },
      random: () => 0,
    });

    expect(result.decision).toBe('rollback');
    expect(result.applied).toBe('rollback');

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} ORDER BY version`;

    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(0)).toBe('current');
    expect(map.get(1)).toBe('rolled_back');
  });

  test('records the STATUS-derived current version after rollback cycles', async () => {
    // After a rollback the numbering is non-contiguous, so currentVersion is not pending - 1.
    const rt = await setup();
    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE actor_id = ${rt.actor.actorId} AND version = 1`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 2, ${Date.now()}, 'second attempt', 'rolled_back')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 3, ${Date.now()}, 'third attempt', 'pending')`;
    await rt.storage.vfs.writeFile(
      'scaffold/agent.js.v3',
      'async function* run(rt, task) { yield { type: "chunk", data: "v3: " + task }; }',
    );

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });

    expect(result.skipped).toBe(false);

    const row = rt.storage.sql<{ current_version: number; pending_version: number }>`
      SELECT current_version, pending_version FROM scaffold_evaluations
      WHERE actor_id = ${rt.actor.actorId}`[0];

    expect(row.pending_version).toBe(3);
    expect(row.current_version).toBe(0);
  });

  test('skips gracefully when pending file unreadable', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'initial', 'current')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${rt.actor.actorId}, 1, ${Date.now()}, 'alt', 'pending')`;

    const result = await runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });

    expect(result).toEqual({ skipped: true, reason: 'pending_unreadable' });
    expect(rt.storage.sql`SELECT COUNT(*) AS n FROM scaffold_evaluations
      WHERE actor_id = ${rt.actor.actorId}`[0]).toEqual({ n: 0 });
  });

  test('config defaults honor DEFAULT_AUTO_JUDGE_CONFIG', () => {
    expect(DEFAULT_SHADOW_CONFIG.minTrials).toBe(5);
    expect(DEFAULT_SHADOW_CONFIG.promoteThreshold).toBe(0.6);
  });

  test('the trial carries no elapsed deadline — the config exposes no timeout knob', () => {
    // No timeout: a wall clock would score a candidate 0 for running out of room, not for being worse.
    expect('scaffoldTimeoutMs' in DEFAULT_AUTO_JUDGE_CONFIG).toBe(false);
    expect('scaffoldTimeoutMs' in structuredClone(DEFAULT_AUTO_JUDGE_CONFIG)).toBe(false);
  });

  test('a slow pending scaffold is awaited, not cut', async () => {
    const rt = await setup();
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
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 'slow candidate', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });

    await Promise.resolve();
    let settled = false;
    const settledPromise = evalPromise.then(() => { settled = true; });
    expect(settled).toBe(false);

    gate.resolve();
    const [result] = await Promise.all([evalPromise, settledPromise]);
    expect(executorReleased).toBe(true);
    expect(result.skipped).toBe(false);
  });
});

describe('order-swapped double-win judging', () => {
  interface RecordingJudge {
    fn: StructuredJudgeFn;
    prompts: string[];
  }

  function recordingJudge(answer: (call: number) => JudgeOutput): RecordingJudge {
    const prompts: string[] = [];

    return {
      prompts,
      fn: async (prompt) => {
        prompts.push(prompt);

        return answer(prompts.length - 1);
      },
    };
  }

  /** `orderRoll` < 0.5 puts the pending first on the first call. */
  async function runTrial(judge: StructuredJudgeFn, orderRoll: number) {
    const rt = await setup();

    return runAutoShadowEval({
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
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

    // Containment over an empty set is vacuously true; the judge must have been reached.
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
    expect(judgePromptResponses(pendingFirst.prompts[1])[0]).toContain(LIVE_OUTPUT);
    expect(judgePromptResponses(currentFirst.prompts[1])[1]).toContain(LIVE_OUTPUT);
  });

  test('winning BOTH orders is a win, and the scores average across them', async () => {
    const result = await runTrial(makeJudge('current', LIVE_OUTPUT), 0);
    expect(result.evaluation?.winner).toBe('current');
    expect(result.evaluation?.currentScore).toBe(0.8);
    expect(result.evaluation?.pendingScore).toBe(0.4);
  });

  test('a flip between the two orders is a TIE, not a coin-flip win', async () => {
    const judge = recordingJudge(() => ({ winner: 'a', rationale: 'position', scoreA: 0.9, scoreB: 0.1 }));
    const result = await runTrial(judge.fn, 0);

    expect(result.evaluation?.winner).toBe('tie');
    expect(result.evaluation?.rationale).toContain('Order-swap flip');
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
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt, task: 't', currentOutput: LIVE_OUTPUT,
      judge: makeJudge('pending', LIVE_OUTPUT),
      llmStream: noOpLlmStream,
      random: () => 0,
    });

    const row = rt.storage.sql<{ winner: string; current_score: number; pending_score: number }>`
      SELECT winner, current_score, pending_score FROM scaffold_evaluations
      WHERE actor_id = ${rt.actor.actorId}`[0];

    expect(row.winner).toBe('pending');
    expect(row.pending_score).toBe(0.8);
    expect(row.current_score).toBe(0.4);
    expect(present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold').pendingWins).toBe(1);
  });
});
