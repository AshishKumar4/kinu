/**
 * The promotion gate's trials are OFFLINE.
 *
 * A shadow trial is a whole candidate turn plus two judge calls. It used to run
 * on the lane the finished turn was still holding — a `kinu exec` process
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
import { createTestRuntime } from './helpers';
import { createTestSql } from '@kinu.run/test-utils';

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

/** The decision every sampled turn in these suites carries: version 1 is the
 *  candidate `setup` leaves pending. */
const PLAN = { pendingVersion: 1 } as const;

const PENDING_SOURCE = 'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }';

async function setup(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
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
    }, PLAN);

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

  test('the plan decides sampling once: rate 0 and no pending both answer null, and a key answers the same way twice', async () => {
    const rt = await setup();
    const unsampled = countedControl(rt, { sampleRate: 0 });
    expect(shadowTrialPlan(unsampled.control, 'turn-1')).toBeNull();
    expect(listQueuedShadowTrials(rt.storage.sql, 1)).toHaveLength(0);

    const sampled = countedControl(rt, { sampleRate: 1 });
    expect(shadowTrialPlan(sampled.control, 'turn-1')).toBe(1);
    // An unkeyed turn has no durable identity to record a trial under.
    expect(shadowTrialPlan(sampled.control, '')).toBeNull();
    // Reproducible: a replaying caller re-derives the plan it recorded.
    const half = countedControl(rt, { sampleRate: 0.5 });
    const keys = Array.from({ length: 64 }, (_, i) => `turn-${String(i)}`);
    const first = keys.map((key) => shadowTrialPlan(half.control, key));
    expect(keys.map((key) => shadowTrialPlan(half.control, key))).toEqual(first);
    const sampledCount = first.filter((plan) => plan !== null).length;
    expect(sampledCount).toBeGreaterThan(0);
    expect(sampledCount).toBeLessThan(keys.length);

    void rt.storage.sql`UPDATE scaffold_versions SET status = 'rolled_back' WHERE version = 1`;
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
      queueTurnShadowTrial(control, { task: `t${i}`, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
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
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: CONTEXT }, PLAN);

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
      queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
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
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);
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
    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: [] }, PLAN);

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
    hostEngine(rt, control, true).queueShadowTrial(completedTurn(), CONTEXT, PLAN);

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

    engine.queueShadowTrial(completedTurn(), CONTEXT, PLAN);
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

    queueTurnShadowTrial(control, { task: TASK, currentOutput: LIVE_ANSWER, context: huge }, PLAN);

    const stored = listQueuedShadowTrials(rt.storage.sql, 1)[0].context;
    expect(stored.length).toBeLessThan(huge.length);
    expect(stored[0].role).toBe('user');
    expect(stored[stored.length - 1]).toEqual(huge[huge.length - 1]);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(SHADOW_TRIAL_CONTEXT_CHARS);
  });
});

// The queue row is the whole conflict target, and the runner deletes it the
// moment it has scored the trial. A caller that OWES the queueing — a durable
// terminal effect whose disposition was never recorded — replays it after that.
describe('a keyed trial survives the consumption of its queue row', () => {
  function openQueue() {
    const { sql, execRaw } = createTestSql();
    initShadowTables(execRaw);
    return sql;
  }
  const trial = (id?: string, now?: number) => {
    const args: Parameters<typeof queueShadowTrial>[1] = {
      pendingVersion: 2, task: TASK, currentOutput: LIVE_ANSWER, context: [],
    };
    if (id !== undefined) args.id = id;
    if (now !== undefined) args.now = now;
    return args;
  };

  test('re-queueing a consumed key creates no second trial', () => {
    const sql = openQueue();
    expect(queueShadowTrial(sql, trial('trial:seq-1', 1))).toBe('queued');
    expect(listQueuedShadowTrials(sql, 2)).toHaveLength(1);

    // Scored, and the row that carried it deleted.
    dropQueuedShadowTrial(sql, 'trial:seq-1');
    expect(listQueuedShadowTrials(sql, 2)).toEqual([]);

    // The replay: the obligation is discharged and nothing is queued for a
    // second scoring.
    expect(queueShadowTrial(sql, trial('trial:seq-1', 9))).toBe('queued');
    expect(listQueuedShadowTrials(sql, 2)).toEqual([]);
  });

  test('a full queue does not make a consumed key report queue_full', () => {
    const sql = openQueue();
    queueShadowTrial(sql, trial('trial:seq-1', 1));
    dropQueuedShadowTrial(sql, 'trial:seq-1');
    for (let i = 0; i < MAX_QUEUED_SHADOW_TRIALS; i++) queueShadowTrial(sql, trial());

    expect(queueShadowTrial(sql, trial('trial:seq-1', 9))).toBe('queued');
    expect(queueShadowTrial(sql, trial())).toBe('queue_full');
  });

  test('unkeyed queueings stay distinct — two turns, two trials', () => {
    const sql = openQueue();
    expect(queueShadowTrial(sql, trial(undefined, 1))).toBe('queued');
    expect(queueShadowTrial(sql, trial(undefined, 2))).toBe('queued');
    expect(listQueuedShadowTrials(sql, 2)).toHaveLength(2);
  });
});
