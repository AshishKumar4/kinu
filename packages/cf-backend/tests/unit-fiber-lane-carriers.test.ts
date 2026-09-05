/**
 * THE PER-LANE CARRIER TABLE. The SDK deletes a recovered `cf_agents_runs` row
 * the moment `classifyRecoveredFiber` returns, so every lane's classification
 * must leave a durable carrier behind — or be a DELIBERATE, documented drop.
 * This suite is that audit as a test: one row per lane, asserting which of the
 * two it is, so a new lane cannot join the closed set without declaring its
 * carrier story here.
 *
 * The carrier is `transports.redrive`: the actor's implementation writes a
 * fresh fiber row synchronously before the hook returns (the do-init gate pins
 * that shape). What this table pins is that every lane with work to lose HANDS
 * ITS WORK to that seam.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import {
  ADVISOR_LANE_FIBER, EVOLUTION_LANE_FIBER, MCP_WARM_LANE_FIBER,
  TERMINAL_LANE_FIBER, classifyRecoveredFiber, type FiberLaneTransports,
} from '../src/fiber-recovery';
import { BACKGROUND_FIBER_PREFIX, SEARCH_FIBER_NAME, recoveryBackoffMs } from '@kinu.run/core';

/** The carrier half of a classification verdict, read from the module's own
 *  answer rather than restated beside it. */
const LaneSnapshotSchema = v.object({ lane: v.string(), redrive: v.string() });

function recordingTransports() {
  const redriven: string[] = [];
  const state = { auditRows: 0 };
  const sql: FiberLaneTransports['sql'] = <T>(_strings: TemplateStringsArray, ..._values: unknown[]): T[] => {
    state.auditRows += 1;
    return [];
  };
  const transports: FiberLaneTransports = {
    jobs: {
      recover: () => Promise.resolve(null),
      recoverOrphans: () => Promise.resolve([]),
    },
    runDueSessionEvolution: () => Promise.resolve(),
    hasAdvisorNoteForTurn: () => false,
    reviewAdvisorSnapshot: () => Promise.resolve(null),
    sql,
    appendMemory: () => Promise.resolve(),
    armOwedTerminalRecovery: () => Promise.resolve(),
    deliverSignal: () => Promise.resolve('queued' as const),
    redrive: (lane) => { redriven.push(lane); },
  };
  return {
    transports,
    redriven,
    get auditRows() { return state.auditRows; },
  };
}

function fiber(name: string, snapshot: JsonValue = null): Parameters<typeof classifyRecoveredFiber>[1] {
  return { id: `fiber-${name}`, name, snapshot, createdAt: Date.now(), recoveryReason: 'interrupted' };
}

describe('every recovered lane leaves a carrier, or drops on purpose', () => {
  test('the four work-bearing lanes hand their work to the redrive seam', () => {
    const cases: readonly [string, string][] = [
      [`${BACKGROUND_FIBER_PREFIX}job-1`, `${BACKGROUND_FIBER_PREFIX}job-1`],
      [EVOLUTION_LANE_FIBER, EVOLUTION_LANE_FIBER],
      [TERMINAL_LANE_FIBER, TERMINAL_LANE_FIBER],
      [SEARCH_FIBER_NAME, SEARCH_FIBER_NAME],
    ];
    for (const [name, lane] of cases) {
      const scene = recordingTransports();
      const verdict = classifyRecoveredFiber(scene.transports, fiber(name));
      expect(verdict.status).toBe('completed');
      expect(scene.redriven).toEqual([lane]);
    }
  });

  test('the advisor lane redrives an unreviewed turn and refuses to double a note', () => {
    const snapshot: JsonValue = {
      turn: {
        userMessage: 'do the thing', assistantResponse: 'done', toolCalls: [],
        steps: 1, durationMs: 5, feedback: null, hadError: false, turnId: 'turn-9',
      },
      reachable: [], minSeverity: 'concern', recent: [],
    };
    const fresh = recordingTransports();
    expect(classifyRecoveredFiber(fresh.transports, fiber(ADVISOR_LANE_FIBER, snapshot)).status)
      .toBe('completed');
    expect(fresh.redriven).toEqual([ADVISOR_LANE_FIBER]);

    const reviewed = recordingTransports();
    reviewed.transports = { ...reviewed.transports, hasAdvisorNoteForTurn: () => true };
    const verdict = classifyRecoveredFiber(reviewed.transports, fiber(ADVISOR_LANE_FIBER, snapshot));
    // The note row IS the durable evidence: the work already landed, so the
    // absent carrier is correctness, not loss.
    expect(verdict.status).toBe('completed');
    expect(reviewed.redriven).toEqual([]);
  });

  test('the search lane writes its audit row synchronously beside the carrier', () => {
    const scene = recordingTransports();
    classifyRecoveredFiber(scene.transports, fiber(SEARCH_FIBER_NAME, { iteration: 3 }));
    expect(scene.auditRows).toBe(1);
    expect(scene.redriven).toEqual([SEARCH_FIBER_NAME]);
  });

  test('the MCP warm lane drops on purpose: the next settled turn warms again', () => {
    const scene = recordingTransports();
    const verdict = classifyRecoveredFiber(scene.transports, fiber(MCP_WARM_LANE_FIBER));
    expect(verdict.status).toBe('completed');
    // NO carrier, and that is the contract — a re-entry would open sockets to
    // third parties on an activation no turn asked anything of, for a
    // connection whose successor turn re-establishes it unconditionally.
    expect(scene.redriven).toEqual([]);
  });

  test('the fork-notice lane replays the delivery from its own checkpoint', () => {
    // The checkpoint IS the signal — everything the replay needs crossed into
    // the fiber row before the reconcile returned — and the producer's
    // idempotency key is what makes a replay of a landed delivery collide.
    // The lane name below is the classifier's address. The carrier it names is
    // read from the verdict, never restated.
    const scene = recordingTransports();
    const signal = {
      kind: 'fork_interrupted', text: 'the fork was retired',
      idempotencyKey: 'fork-interrupted:root-1',
    };
    const verdict = classifyRecoveredFiber(scene.transports, fiber('fork:notice', signal));
    expect(verdict.status).toBe('completed');
    if (verdict.status !== 'completed') throw new Error('expected the fork-notice lane to classify completed');
    const snapshot = v.parse(LaneSnapshotSchema, verdict.snapshot);
    expect(snapshot.redrive).toBe('signal-delivery');
    expect(scene.redriven).toEqual([snapshot.lane]);
    // A checkpoint that will not parse has no fact left to announce: terminal,
    // not a poison row that re-enters for a day.
    const garbage = recordingTransports();
    expect(classifyRecoveredFiber(garbage.transports, fiber('fork:notice', null)).status)
      .toBe('error');
    expect(garbage.redriven).toEqual([]);
  });

  test('an undelivered notice re-dispatches on a fresh carrier until the seam accepts it', async () => {
    // `undelivered` = the enqueue was pre-empted; the notice is STILL OWED and
    // its row must not vanish with a resolving body. Each retry is its own
    // fiber row, paced by the turn slot that pre-empted it.
    const scene = recordingTransports();
    const outcomes: ('undelivered' | 'queued')[] = ['undelivered', 'queued'];
    const bodies: (() => Promise<void>)[] = [];
    scene.transports = {
      ...scene.transports,
      deliverSignal: () => Promise.resolve(outcomes.shift() ?? 'queued'),
      redrive: (lane, _checkpoint, body) => { scene.redriven.push(lane); bodies.push(body); },
    };
    const signal = { kind: 'fork_interrupted', text: 'retired', idempotencyKey: 'k' };
    const verdict = classifyRecoveredFiber(scene.transports, fiber('fork:notice', signal));

    // Drain the dispatch chain the way the carrier would: run each body as it
    // is dispatched. The first attempt is refused and re-dispatches; the
    // second lands and dispatches nothing further.
    while (bodies.length > 0) {
      const body = bodies.shift();
      if (body) await body();
    }
    // Both dispatches ride the lane the verdict named — a retry under any
    // other lane would re-enter the wrong arm after an eviction.
    if (verdict.status !== 'completed') throw new Error('expected the fork-notice lane to classify completed');
    const lane = v.parse(LaneSnapshotSchema, verdict.snapshot).lane;
    expect(scene.redriven).toEqual([lane, lane]);
  });

  test('a deterministic enqueue failure is paced by capped backoff, never a row storm', () => {
    // Attempts are UNBOUNDED on purpose — a cap that gives up loses the
    // notice — so the runaway protection is the PACE. The shared curve is
    // pinned at its definition: the fork-notice sleep, the job runner's resume
    // deferral and every other paced retry read this one function, so a change
    // to it is a change to all of them and fails here on purpose.
    expect(recoveryBackoffMs(1)).toBe(2000);
    expect(recoveryBackoffMs(6)).toBe(60_000);
    expect(recoveryBackoffMs(50)).toBe(60_000);
    // And the attempt count rides the checkpoint: a recovered fifth attempt
    // re-dispatches as the fifth — the body sleeps ITS OWN backoff before
    // delivering, so an eviction mid-backoff cannot skip the pacing.
    const scene = recordingTransports();
    const checkpoints: JsonValue[] = [];
    scene.transports = {
      ...scene.transports,
      redrive: (lane, checkpoint) => { scene.redriven.push(lane); checkpoints.push(checkpoint); },
    };
    classifyRecoveredFiber(scene.transports, fiber('fork:notice', {
      kind: 'fork_interrupted', text: 'retired', idempotencyKey: 'k', attempts: 5,
    }));
    expect(checkpoints).toMatchObject([{ attempts: 5 }]);
  });

  test('an unrecognised lane is a classified loss, loudly, with no carrier', () => {
    const scene = recordingTransports();
    const verdict = classifyRecoveredFiber(scene.transports, fiber('somebody:new-lane'));
    expect(verdict.status).toBe('error');
    expect(scene.redriven).toEqual([]);
  });
});
