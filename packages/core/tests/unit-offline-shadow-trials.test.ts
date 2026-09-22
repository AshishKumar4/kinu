import type { ChatEvent } from '../src/chat';
/** Shadow trials run offline: a turn only queues one row, and the cadence-lane drain runs it. */

import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  DEFAULT_SHADOW_CONFIG, EvolutionEngine, MAX_QUEUED_SHADOW_TRIALS, SHADOW_TRIAL_CONTEXT_CHARS,
  applyScaffoldDecision, decidePromotion, getPendingScaffold, getShadowStatus,
  dropQueuedShadowTrial, initScaffoldTables, initShadowTables, listQueuedShadowTrials,
  queueShadowTrial, queueTurnShadowTrial,
  runQueuedShadowTrials, shadowTrialPlan,
  type CompletedTurn, type JudgeOutput, type ScaffoldControl,
  type ScaffoldReplayContext,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Executor, ResolvedProvider } from '../src/types/primitives';
import { decodeJsonValue } from '../src/utils/json';
import type { ModelMessage } from 'ai';
import { createTestRuntime, storesFor } from './helpers';
import { createTestSql, present, testActorHandle } from '@kinu.run/test-utils';
import { RunEventRecorder } from '../src/events/recorder';

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

const PLAN = { pendingVersion: 1 } as const;

const PENDING_SOURCE = 'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }';

async function setup(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
  initShadowTables(rt.storage.execRaw);
  rt.executor = evalExecutor();
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 0, ${Date.now()}, 'initial', 'current')`;
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 1, ${Date.now()}, 'candidate', 'pending')`;
  await rt.storage.vfs.writeFile('scaffold/agent.js.v1', PENDING_SOURCE);
  await rt.identity.scaffold.write('async function* run(rt, task) { yield { type: "chunk", data: "live" }; }');

  return rt;
}

/** Every executable control-plane port, counted: a completed turn may touch none. */
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
    events: new RunEventRecorder(rt.storage.sql, rt.actor),
    rt,
    sql: rt.storage.sql,
    history: storesFor(rt).history,
    config: {
      getShadowSampleRate: () => opts?.sampleRate ?? 1,
      getAutoPromoteScaffold: () => opts?.autoPromote ?? false,
      getGepaEvalBudget: () => 2,
    },
    surface: (_task, context) => {
      counts.surface++;
      contexts.push(context ?? []);

      return {
        llmStream: async function* () { yield { type: 'text-delta', delta: '' } satisfies ChatEvent; },
        defaultInference: async function* () { counts.defaultInference++; yield { value: '' }; },
      };
    },
    model: () => new MockLanguageModelV3(),
    judge: async ({ schema }) => {
      counts.judge++;

      // The protocol is order-swapped, so attribute by the pending's known output, not a fixed slot.
      const out: JudgeOutput = verdict === 'tie'
        ? { winner: 'tie', rationale: 'm', scoreA: 0.5, scoreB: 0.5 }
        : { winner: 'a', rationale: 'm', scoreA: 0.8, scoreB: 0.4 };

      return v.parse(schema, out);
    },
  };

  return { control, counts, contexts };
}

/** Decides by content, so it survives the order swap. */
function contentJudge(
  pendingText: string,
  winner: 'pending' | 'current',
): ScaffoldControl['judge'] {
  return async ({ prompt, schema }) => {
    const bMark = prompt.indexOf('\n\nResponse B:\n');
    const a = prompt.slice(prompt.indexOf('\nResponse A:\n'), bMark);
    const pendingIsA = a.includes(pendingText);
    const pendingSide = pendingIsA ? 'a' : 'b';
    const currentSide = pendingIsA ? 'b' : 'a';
    const pick = winner === 'pending' ? pendingSide : currentSide;

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
    }, PLAN);

    expect(outcome).toBe('queued');
    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
    const queued = listQueuedShadowTrials(rt.storage.sql, rt.actor, 1);
    expect(queued).toHaveLength(1);
    expect(queued[0].task).toBe(TASK);
    expect(queued[0].currentOutput).toBe(LIVE_ANSWER);
    expect(queued[0].context).toEqual(CONTEXT);
  });

  test('the plan decides sampling once: rate 0 and no pending both answer null, and a key answers the same way twice', async () => {
    const rt = await setup();
    const unsampled = countedControl(rt, { sampleRate: 0 });
    expect(shadowTrialPlan(unsampled.control, 'turn-1')).toBeNull();
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(0);

    const sampled = countedControl(rt, { sampleRate: 1 });
    expect(shadowTrialPlan(sampled.control, 'turn-1')).toBe(1);
    expect(shadowTrialPlan(sampled.control, '')).toBeNull();
    const half = countedControl(rt, { sampleRate: 0.5 });
    const keys = Array.from({ length: 64 }, (_, i) => `turn-${String(i)}`);
    const first = keys.map((key) => shadowTrialPlan(half.control, key));
    expect(keys.map((key) => shadowTrialPlan(half.control, key))).toEqual(first);
    const sampledCount = first.filter((plan) => plan !== null).length;
    expect(sampledCount).toBeGreaterThan(0);
    expect(sampledCount).toBeLessThan(keys.length);

    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE actor_id = ${rt.actor.actorId} AND version = 1`;
    const resolved = countedControl(rt);
    expect(shadowTrialPlan(resolved.control, 'turn-1')).toBeNull();
    expect(resolved.counts.surface).toBe(0);
  });

  test('a host that never drains cannot grow the queue without bound', async () => {
    const rt = await setup();
    const { control } = countedControl(rt);

    for (let i = 0; i < MAX_QUEUED_SHADOW_TRIALS; i++) {
      expect(queueTurnShadowTrial(control, { task: `t${i}`, currentOutput: 'a', context: [] }, PLAN)).toBe('queued');
    }

    expect(queueTurnShadowTrial(control, { task: 'one more', currentOutput: 'a', context: [] }, PLAN))
      .toBe('queue_full');
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(MAX_QUEUED_SHADOW_TRIALS);
  });
});

describe('a queued trial is not evidence', () => {
  test('the gate sees queued trials separately and still says continue', async () => {
    const rt = await setup();
    const { control } = countedControl(rt);

    for (let i = 0; i < 4; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations (actor_id, id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${rt.actor.actorId}, ${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }

    for (let i = 0; i < 6; i++) {
      queueTurnShadowTrial(control, { task: `t${i}`, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
    }

    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');
    // Only trials actually run count as evidence.
    expect(pending.trialsSoFar).toBe(4);
    expect(decidePromotion(pending, DEFAULT_SHADOW_CONFIG).decision).toBe('continue');

    const status = getShadowStatus(rt.storage.sql, rt.actor);
    expect(status.hasPending).toBe(true);

    if (!status.hasPending) throw new Error('unreachable');
    expect(status.queuedTrials).toBe(6);
    expect(status.pending.trialsSoFar).toBe(4);

    const forced = await applyScaffoldDecision(control, 'auto');
    expect(forced).toEqual({ ok: false, error: 'inconclusive; need more trials' });
  });
});

describe('the offline drain is what executes trials', () => {
  test('draining runs the queued trial, records it, and clears the row', async () => {
    const rt = await setup();
    const { control, counts, contexts } = countedControl(rt);
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT }, PLAN);

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 1, applied: null });
    expect(counts.surface).toBe(1);
    expect(counts.judge).toBe(2); // the order-swapped pair
    expect(present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold').trialsSoFar).toBe(1);
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(0);
    // Shadow parity: the candidate runs against the turn's own conversation, carried through the queue.
    expect(contexts[0]).toEqual(CONTEXT);
  });

  test('a conclusive gate promotes from the drain, and the stale queue is discarded', async () => {
    const rt = await setup();

    for (let i = 0; i < 5; i++) {
      void rt.storage.sql`INSERT INTO scaffold_evaluations (actor_id, id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${rt.actor.actorId}, ${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }

    const counted = countedControl(rt, { autoPromote: true });

    const control: ScaffoldControl = {
      ...counted.control,
      judge: contentJudge(`pending: ${TASK}`, 'pending'),
    };

    for (let i = 0; i < 3; i++) {
      queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
    }

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 1, applied: 'promote' });

    const statuses = new Map(rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId}`.map((r) => [r.version, r.status]));

    expect(statuses.get(1)).toBe('current');
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
  });

  test('trials for a version that is no longer pending are discarded, not run', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE actor_id = ${rt.actor.actorId} AND version = 1`;

    const drain = await runQueuedShadowTrials(control);

    expect(drain).toEqual({ trials: 0, applied: null });
    expect(counts.surface).toBe(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
  });

  test('a trial that throws is dropped rather than wedging the queue', async () => {
    const rt = await setup();
    const counted = countedControl(rt);

    const control: ScaffoldControl = {
      ...counted.control,
      judge: async () => { throw new Error('judge down'); },
    };

    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);

    const drain = await runQueuedShadowTrials(control);

    expect(drain.applied).toBeNull();
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
  });
});

describe('auto-evolution off runs no trial and leaves no trial to run', () => {
  function hostEngine(rt: AgentRuntime, control: ScaffoldControl, enabled: boolean): EvolutionEngine {
    return new EvolutionEngine(rt, storesFor(rt).history, {
      enabled,
      shadowTrialQueue: (turn, opts) => queueTurnShadowTrial(control, turn, opts),
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

    engine.queueShadowTrial(completedTurn(), CONTEXT, PLAN);
    // Asserted before the drain too, or a drain would hide a turn that queued.
    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);

    await engine.runDueShadowTrials();

    expect(rt.storage.sql`SELECT id FROM scaffold_trial_queue WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    expect(getPendingScaffold(rt.storage.sql, rt.actor)?.version).toBe(1);
  });

  test('such a host does not drain what an earlier evolution-enabled run queued', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    hostEngine(rt, control, true).queueShadowTrial(completedTurn(), CONTEXT, PLAN);

    await hostEngine(rt, control, false).runDueShadowTrials();

    expect(counts).toEqual({ surface: 0, judge: 0, defaultInference: 0 });
    expect(rt.storage.sql`SELECT id FROM scaffold_evaluations WHERE actor_id = ${rt.actor.actorId}`).toHaveLength(0);
    // Deferred, not dropped: the evidence waits for a host that does evolve.
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(1);
  });

  test('the same turn on an evolution-enabled host queues one row and drains it', async () => {
    const rt = await setup();
    const { control, counts } = countedControl(rt);
    const engine = hostEngine(rt, control, true);

    engine.queueShadowTrial(completedTurn(), CONTEXT, PLAN);
    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(1);

    await engine.runDueShadowTrials();

    expect(listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)).toHaveLength(0);
    expect(counts.judge).toBe(2);
    expect(getPendingScaffold(rt.storage.sql, rt.actor)?.trialsSoFar).toBe(1);
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

    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: huge }, PLAN);

    const stored = listQueuedShadowTrials(rt.storage.sql, rt.actor, 1)[0].context;
    expect(stored.length).toBeLessThan(huge.length);
    expect(stored[0].role).toBe('user');
    expect(stored[stored.length - 1]).toEqual(huge[huge.length - 1]);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(SHADOW_TRIAL_CONTEXT_CHARS);
  });
});

// The runner deletes the queue row once scored, but a caller that owes the queueing may replay it after.
describe('a keyed trial survives the consumption of its queue row', () => {
  function openQueue() {
    const { sql, execRaw } = createTestSql();
    initShadowTables(execRaw);

    return { sql, actor: testActorHandle(sql) };
  }

  const trial = (id?: string, now?: number) => {
    const args: Parameters<typeof queueShadowTrial>[2] = {
      pendingVersion: 2, task: TASK, currentOutput: LIVE_ANSWER, context: [],
    };

    if (id !== undefined) args.id = id;

    if (now !== undefined) args.now = now;

    return args;
  };

  test('re-queueing a consumed key creates no second trial', () => {
    const { sql, actor } = openQueue();
    expect(queueShadowTrial(sql, actor, trial('trial:seq-1', 1))).toBe('queued');
    expect(listQueuedShadowTrials(sql, actor, 2)).toHaveLength(1);

    dropQueuedShadowTrial(sql, actor, 'trial:seq-1');
    expect(listQueuedShadowTrials(sql, actor, 2)).toEqual([]);

    expect(queueShadowTrial(sql, actor, trial('trial:seq-1', 9))).toBe('queued');
    expect(listQueuedShadowTrials(sql, actor, 2)).toEqual([]);
  });

  test('a full queue does not make a consumed key report queue_full', () => {
    const { sql, actor } = openQueue();
    queueShadowTrial(sql, actor, trial('trial:seq-1', 1));
    dropQueuedShadowTrial(sql, actor, 'trial:seq-1');

    for (let i = 0; i < MAX_QUEUED_SHADOW_TRIALS; i++) queueShadowTrial(sql, actor, trial());

    expect(queueShadowTrial(sql, actor, trial('trial:seq-1', 9))).toBe('queued');
    expect(queueShadowTrial(sql, actor, trial())).toBe('queue_full');
  });

  test('unkeyed queueings stay distinct — two turns, two trials', () => {
    const { sql, actor } = openQueue();
    expect(queueShadowTrial(sql, actor, trial(undefined, 1))).toBe('queued');
    expect(queueShadowTrial(sql, actor, trial(undefined, 2))).toBe('queued');
    expect(listQueuedShadowTrials(sql, actor, 2)).toHaveLength(2);
  });
});
