/**
 * The promotion gate's trials are OFFLINE.
 *
 * A shadow trial is a whole candidate turn plus two judge calls. It used to run
 * on the lane the finished turn was still holding — a `proteus exec` process
 * waited it out before it could exit, and a Durable Object ran a second full
 * inference beside the next request. What a turn owes the gate is now one row;
 * the rollout happens on the cadence lane.
 *
 * These tests pin both halves and the seam between them: the turn executes
 * nothing, the drain executes what the turn queued, and a queued trial is never
 * counted as evidence in the meantime.
 */

import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  DEFAULT_SHADOW_CONFIG, EvolutionEngine, MAX_QUEUED_SHADOW_TRIALS, SHADOW_TRIAL_CONTEXT_CHARS,
  applyScaffoldDecision, decidePromotion, getPendingScaffold, getShadowStatus,
  initScaffoldTables, initShadowTables, listQueuedShadowTrials, queueTurnShadowTrial,
  runQueuedShadowTrials,
  type CompletedTurn, type JudgeOutput, type ScaffoldControl,
  type ScaffoldReplayContext,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Executor, ResolvedProvider } from '../src/types/primitives';
import { decodeJsonValue } from '../src/utils/json';
import type { ModelMessage } from 'ai';
import { createTestRuntime } from './helpers';

const TASK = 'what did we decide about the codename?';
const LIVE_ANSWER = '<<live-answer>>';
const CONTEXT: ModelMessage[] = [
  { role: 'user', content: 'the codename is BLUEFIN' },
  { role: 'assistant', content: 'noted' },
  { role: 'user', content: TASK },
];

/** DynamicWorkerExecutor semantics: providers visible as globals. */
function evalExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code, providers) {
      const resolved: ResolvedProvider[] = Array.isArray(providers)
        ? providers
        : [{ name: 'workspace', fns: providers }];
      try {
        const fn = new Function(
          ...resolved.map((provider) => provider.name),
          `return (async () => {\n${code}\n})();`,
        );
        const result = await fn(...resolved.map((provider) => provider.fns));
        return { result: result === undefined ? undefined : decodeJsonValue({ value: result }) };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const PENDING_SOURCE = 'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }';

async function setup(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initShadowTables(rt.storage.execRaw);
  rt.executor = evalExecutor();
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'initial', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (1, ${Date.now()}, 'candidate', 'pending')`;
  await rt.storage.vfs.writeFile('scaffold/agent.js.v1', PENDING_SOURCE);
  await rt.identity.scaffold.write('async function* run(rt, task) { yield { type: "chunk", data: "live" }; }');
  return rt;
}

/** Every executable port of the control plane, counted. Nothing here may be
 *  touched by a completed turn — that is the whole property under test. */
interface CountedControl {
  control: ScaffoldControl;
  counts: { surface: number; judge: number; defaultInference: number };
  contexts: ScaffoldReplayContext[];
}

function countedControl(
  rt: AgentRuntime,
  opts?: { sampleRate?: number; autoPromote?: boolean; verdict?: 'pending' | 'current' | 'tie' },
): CountedControl {
  const counts = { surface: 0, judge: 0, defaultInference: 0 };
  const contexts: ScaffoldReplayContext[] = [];
  const verdict = opts?.verdict ?? 'pending';
  const control: ScaffoldControl = {
    rt,
    sql: rt.storage.sql,
    config: {
      getShadowSampleRate: () => opts?.sampleRate ?? 1,
      getAutoPromoteScaffold: () => opts?.autoPromote ?? false,
      getGepaEvalBudget: () => 2,
    },
    surface: (_task, context) => {
      counts.surface++;
      contexts.push(context ?? []);
      return {
        llmStream: async function* () { yield ''; },
        defaultInference: async function* () { counts.defaultInference++; yield { value: '' }; },
      };
    },
    model: () => new MockLanguageModelV3(),
    judge: async ({ schema }) => {
      counts.judge++;
      // Content-blind, but the protocol is order-swapped, so a fixed slot would
      // flip and tie. Attribute by the pending's known output instead.
      const out: JudgeOutput = verdict === 'tie'
        ? { winner: 'tie', rationale: 'm', scoreA: 0.5, scoreB: 0.5 }
        : { winner: 'a', rationale: 'm', scoreA: 0.8, scoreB: 0.4 };
      return v.parse(schema, out);
    },
  };
  return { control, counts, contexts };
}

/** A judge that decides by CONTENT, so it survives the order swap and yields a
 *  decisive trial. `pendingText` is what the candidate scaffold emits. */
function contentJudge(
  pendingText: string,
  winner: 'pending' | 'current',
): ScaffoldControl['judge'] {
  return async ({ prompt, schema }) => {
    const bMark = prompt.indexOf('\n\nResponse B:\n');
    const a = prompt.slice(prompt.indexOf('\nResponse A:\n'), bMark);
    const pendingIsA = a.includes(pendingText);
    const pick = winner === 'pending' ? (pendingIsA ? 'a' : 'b') : (pendingIsA ? 'b' : 'a');
    return v.parse(schema, {
      winner: pick,
      rationale: 'content',
      scoreA: pick === 'a' ? 0.8 : 0.4,
      scoreB: pick === 'b' ? 0.8 : 0.4,
    });
  };
}

describe('the interactive path runs no trial', () => {
  test('a completed turn touches no scaffold port and no judge — it queues one row', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);

    const outcome = queueTurnShadowTrial(control, {
      task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT,
    });

    expect(outcome).toBe('queued');
    // The candidate was never built, never run, never judged.
    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations`).toHaveLength(0);
    // What it left behind instead: one durable row, carrying the whole turn.
    const queued = listQueuedShadowTrials(rt.storage.sql, 1);
    expect(queued).toHaveLength(1);
    expect(queued[0].task).toBe(TASK);
    expect(queued[0].currentOutput).toBe(LIVE_ANSWER);
    expect(queued[0].context).toEqual(CONTEXT);
  });

  test('nothing is queued when the turn is not sampled, or when nothing is pending', async () => {
    const rt = await setup();
    const unsampled = countedControl(rt, { sampleRate: 0 });
    expect(queueTurnShadowTrial(unsampled.control, {
      task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT,
    })).toBe('not_sampled');
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(0);

    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back' WHERE version = 1`;
    const resolved = countedControl(rt);
    expect(queueTurnShadowTrial(resolved.control, {
      task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT,
    })).toBe('no_pending');
    expect(resolved.counts.surface).toBe(0);
  });

  test('a host that never drains cannot grow the queue without bound', async () => {
    const rt = await setup();
    const { control } = countedControl(rt);
    for (let i = 0; i < MAX_QUEUED_SHADOW_TRIALS; i++) {
      expect(queueTurnShadowTrial(control, { task: `t${i}`, currentOutput: 'a', context: [] })).toBe('queued');
    }
    expect(queueTurnShadowTrial(control, { task: 'one more', currentOutput: 'a', context: [] }))
      .toBe('queue_full');
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(MAX_QUEUED_SHADOW_TRIALS);
  });
});

describe('a queued trial is not evidence', () => {
  test('the gate sees queued trials separately and still says continue', async () => {
    const rt = await setup();
    const { control } = countedControl(rt);
    // Four decisive wins recorded — one short of the ladder's minimum.
    for (let i = 0; i < 4; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }
    for (let i = 0; i < 6; i++) {
      queueTurnShadowTrial(control, { task: `t${i}`, currentOutput: LIVE_ANSWER, context: [] });
    }

    const pending = getPendingScaffold(rt.storage.sql)!;
    // Ten trials exist in some sense; four have been RUN, and only those count.
    expect(pending.trialsSoFar).toBe(4);
    expect(decidePromotion(pending, DEFAULT_SHADOW_CONFIG).decision).toBe('continue');

    const status = getShadowStatus(rt.storage.sql);
    expect(status.hasPending).toBe(true);
    if (!status.hasPending) throw new Error('unreachable');
    expect(status.queuedTrials).toBe(6);
    expect(status.pending.trialsSoFar).toBe(4);

    // And the honest refusal survives an explicit ask.
    const forced = await applyScaffoldDecision(control, 'auto');
    expect(forced).toEqual({ ok: false, error: 'inconclusive; need more trials' });
  });
});

describe('the offline drain is what executes trials', () => {
  test('draining runs the queued trial, records it, and clears the row', async () => {
    const rt = await setup();
    const { control, counts, contexts } = countedControl(rt);
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT });

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 1, applied: null });
    expect(counts.surface).toBe(1);
    expect(counts.judge).toBe(2); // the order-swapped pair
    expect(getPendingScaffold(rt.storage.sql)!.trialsSoFar).toBe(1);
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(0);
    // The candidate ran against the turn's OWN conversation, not a task-text
    // reconstruction of it — the shadow-parity contract, carried through the
    // queue rather than through a live closure.
    expect(contexts[0]).toEqual(CONTEXT);
  });

  test('a conclusive gate promotes from the drain, and the stale queue is discarded', async () => {
    const rt = await setup();
    for (let i = 0; i < 5; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }
    const counted = countedControl(rt, { autoPromote: true });
    const control: ScaffoldControl = {
      ...counted.control,
      judge: contentJudge(`pending: ${TASK}`, 'pending'),
    };
    for (let i = 0; i < 3; i++) {
      queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] });
    }

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 1, applied: 'promote' });
    const statuses = new Map(rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions`.map((r) => [r.version, r.status]));
    expect(statuses.get(1)).toBe('current');
    // The two trials still queued were evidence about a candidate nobody is
    // deciding on any more.
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue`).toHaveLength(0);
  });

  test('trials for a version that is no longer pending are discarded, not run', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] });
    // The operator resolved it by hand while the trial sat in the queue.
    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back' WHERE version = 1`;

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 0, applied: null });
    expect(counts.surface).toBe(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue`).toHaveLength(0);
  });

  test('a trial that throws is dropped rather than wedging the queue', async () => {
    const rt = await setup();
    const counted = countedControl(rt);
    const control: ScaffoldControl = {
      ...counted.control,
      judge: async () => { throw new Error('judge down'); },
    };
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] });

    const drain = await runQueuedShadowTrials(control);

    expect(drain.applied).toBeNull();
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations`).toHaveLength(0);
  });
});

describe('auto-evolution off runs no trial and leaves no trial to run', () => {
  /** Both halves of the loop as a host wires them — the ports the backends
   *  supply, over the counted control plane. */
  function hostEngine(rt: AgentRuntime, control: ScaffoldControl, enabled: boolean): EvolutionEngine {
    return new EvolutionEngine(rt, {
      enabled,
      shadowTrialQueue: (turn) => { queueTurnShadowTrial(control, turn); },
      shadowTrialRunner: () => runQueuedShadowTrials(control),
    });
  }

  const completedTurn = (): CompletedTurn => ({
    userMessage: TASK, assistantResponse: LIVE_ANSWER,
    toolCalls: [], steps: 1, durationMs: 1, feedback: null, hadError: false,
  });

  test('a `--no-auto-evolve` turn writes no queue row, and its host drains none', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    const engine = hostEngine(rt, control, false);

    engine.queueShadowTrial(completedTurn(), CONTEXT);
    // No evolution state: nothing recorded for a later evolution-enabled host
    // to evolve on this run's behalf. Asserted before the drain as well as
    // after it, or a drain that ran would hide a turn that queued.
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue`).toHaveLength(0);

    await engine.runDueShadowTrials();

    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue`).toHaveLength(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations`).toHaveLength(0);
    // No evolution compute: no candidate rollout, no judge call.
    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    // The candidate an earlier run left pending is untouched, not lost — the
    // next host that does evolve resolves it.
    expect(getPendingScaffold(rt.storage.sql)?.version).toBe(1);
  });

  test('such a host does not drain what an earlier evolution-enabled run queued', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    // The row an interactive session or the daemon left in this workspace.
    hostEngine(rt, control, true).queueShadowTrial(completedTurn(), CONTEXT);

    await hostEngine(rt, control, false).runDueShadowTrials();

    // The candidate rollout and its two judge calls are evolution compute, and
    // this run was told to spend none.
    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations`).toHaveLength(0);
    // Deferred, not dropped: the queue is durable, so the evidence waits for a
    // host that does evolve rather than being consumed by one that does not.
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(1);
  });

  test('the same turn on an evolution-enabled host queues one row and drains it', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    const engine = hostEngine(rt, control, true);

    engine.queueShadowTrial(completedTurn(), CONTEXT);
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(1);

    await engine.runDueShadowTrials();

    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(0);
    expect(counts.judge).toBe(2);
    expect(getPendingScaffold(rt.storage.sql)?.trialsSoFar).toBe(1);
  });
});

describe('the stored replay context is bounded', () => {
  test('an oversized conversation keeps its tail and still starts on a user message', async () => {
    const rt = await setup();
    const { control } = countedControl(rt);
    const filler = 'x'.repeat(SHADOW_TRIAL_CONTEXT_CHARS / 4);
    const huge: ModelMessage[] = [
      { role: 'user', content: `oldest ${filler}` },
      { role: 'assistant', content: filler },
      { role: 'user', content: `middle ${filler}` },
      { role: 'assistant', content: filler },
      { role: 'user', content: `newest ${filler}` },
    ];

    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: huge });

    const stored = listQueuedShadowTrials(rt.storage.sql, 1)[0].context;
    expect(stored.length).toBeLessThan(huge.length);
    expect(stored[0].role).toBe('user');
    expect(stored[stored.length - 1]).toEqual(huge[huge.length - 1]);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(SHADOW_TRIAL_CONTEXT_CHARS);
  });
});
