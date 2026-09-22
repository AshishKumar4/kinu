/**
 * Per-lane carrier table: the SDK deletes a recovered `cf_agents_runs` row once `classifyRecoveredFiber`
 * returns, so each lane must hand its work to `transports.redrive` or be a deliberate, documented drop.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { ActorHandle, JsonValue } from '@kinu.run/core';
import { createTestActorsOver } from '@kinu.run/test-utils';
import {
  EVOLUTION_LANE_FIBER, MCP_WARM_LANE_FIBER,
  TERMINAL_LANE_FIBER, classifyRecoveredFiber, type FiberLaneTransports,
} from '../src/fiber-recovery';
import { ADVISOR_LANE_FIBER, BACKGROUND_FIBER_PREFIX, SEARCH_FIBER_NAME, recoveryBackoffMs } from '@kinu.run/core';

/** Read from the module's own verdict rather than restated. */
const LaneSnapshotSchema = v.object({ lane: v.string(), redrive: v.string() });

function recordingTransports() {
  const redriven: string[] = [];
  const writes: unknown[][] = [];
  const state = { auditRows: 0 };
  const actor: ActorHandle = createTestActorsOver(new Database(':memory:')).main;

  const sql: FiberLaneTransports['sql'] = <T>(_strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    state.auditRows += 1;
    writes.push(values);

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
    actor,
    appendMemory: () => Promise.resolve(),
    armOwedTerminalRecovery: () => Promise.resolve(),
    deliverSignal: () => Promise.resolve('queued' as const),
    redrive: (lane) => { redriven.push(lane); },
  };

  return {
    transports,
    redriven,
    writes,
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
    // The work already landed; the note row is the durable evidence.
    expect(verdict.status).toBe('completed');
    expect(reviewed.redriven).toEqual([]);
  });

  test('the search lane writes its audit row synchronously beside the carrier', () => {
    const scene = recordingTransports();
    classifyRecoveredFiber(scene.transports, fiber(SEARCH_FIBER_NAME, { iteration: 3 }));
    expect(scene.auditRows).toBe(1);
    expect(scene.redriven).toEqual([SEARCH_FIBER_NAME]);
    expect(scene.writes[0]?.[0]).toBe(scene.transports.actor.actorId);
  });

  test('the MCP warm lane drops on purpose: the next settled turn warms again', () => {
    const scene = recordingTransports();
    const verdict = classifyRecoveredFiber(scene.transports, fiber(MCP_WARM_LANE_FIBER));
    expect(verdict.status).toBe('completed');
    // No carrier by contract: the successor turn re-establishes the connection unconditionally.
    expect(scene.redriven).toEqual([]);
  });

  test('the fork-notice lane replays the delivery from its own checkpoint', () => {
    // The checkpoint carries everything the replay needs; the producer's idempotency key makes a
    // replay of a landed delivery collide.
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
    // An unparseable checkpoint is terminal, not a poison row.
    const garbage = recordingTransports();
    expect(classifyRecoveredFiber(garbage.transports, fiber('fork:notice', null)).status)
      .toBe('error');
    expect(garbage.redriven).toEqual([]);
  });

  test('an undelivered notice re-dispatches on a fresh carrier until the seam accepts it', async () => {
    // `undelivered`: the notice is still owed; each retry is its own fiber row, paced by the turn slot.
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

    while (bodies.length > 0) {
      const body = bodies.shift();

      if (body) await body();
    }

    // A retry under any other lane would re-enter the wrong arm after an eviction.
    if (verdict.status !== 'completed') throw new Error('expected the fork-notice lane to classify completed');
    const lane = v.parse(LaneSnapshotSchema, verdict.snapshot).lane;
    expect(scene.redriven).toEqual([lane, lane]);
  });

  test('a deterministic enqueue failure is paced by capped backoff, never a row storm', () => {
    // Attempts are unbounded (a cap loses the notice), so the pace is the protection. The shared
    // curve is pinned here: every paced retry reads this one function.
    expect(recoveryBackoffMs(1)).toBe(2000);
    expect(recoveryBackoffMs(6)).toBe(60_000);
    expect(recoveryBackoffMs(50)).toBe(60_000);
    // The attempt count rides the checkpoint, so an eviction mid-backoff cannot skip the pacing.
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
