/**
 * Defends: a record adapter writing a row the dataset's boundary filter cannot find. Each writer stamps
 * the event and boundary it declares. That every declared boundary is emitted at its site is the gate in
 * scripts/analytics-datasets.test.ts.
 */
import { describe, expect, test } from 'bun:test';

import { boundaryOf, eventFamily } from '@kinu.run/core/analytics';
import { AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA } from '@kinu.run/core/analytics';
import * as record from '@kinu.run/core/analytics';
import type { AnalyticsEnv } from '@kinu.run/core/analytics';

interface Captured {
  indexes?: ((ArrayBuffer | string) | null)[];
  blobs?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
}

interface CapturedPlane {
  readonly env: AnalyticsEnv;
  readonly agent: Captured[];
  readonly ops: Captured[];
}

function captureEnv(): CapturedPlane {
  const agent: Captured[] = [];
  const ops: Captured[] = [];

  return {
    agent,
    ops,
    env: {
      AGENT_METRICS: { writeDataPoint: (point?: Captured) => { agent.push(point ?? {}); } },
      CONTROL_PLANE_OPS: { writeDataPoint: (point?: Captured) => { ops.push(point ?? {}); } },
    },
  };
}

describe('the registry is read at runtime', () => {
  test('an undeclared event stamps no boundary', () => {
    // Empty: a `boundary` filter asks about the declared set only.
    expect(boundaryOf('something.undeclared')).toBe('');
  });

  test('a family is the segment before the first dot, and a bare name is its own', () => {
    expect(eventFamily('turn.settled')).toBe('turn');
    expect(eventFamily('control_plane.workspace_remove')).toBe('control_plane');
    expect(eventFamily('bare')).toBe('bare');
  });
});

describe('a writer boundary emits the event and boundary it declares', () => {
  const eventSlot = AGENT_METRICS_SCHEMA.blobs.findIndex((slot) => slot.name === 'event');
  const boundarySlot = AGENT_METRICS_SCHEMA.blobs.findIndex((slot) => slot.name === 'boundary');
  const opsOperationSlot = CONTROL_PLANE_OPS_SCHEMA.blobs.findIndex((s) => s.name === 'operation');

  test('turn.settled', () => {
    const captured = captureEnv();
    record.recordTurnRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm',
      outcome: 'ok', code: '', durationMs: 1, steps: 1, toolCalls: 0, usage: {}, usd: undefined,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('turn.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('turn.settled');
  });

  test('turn.first_token', () => {
    const captured = captureEnv();
    record.recordTtftRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm', ttftMs: 5,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('turn.first_token');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('turn.first_token');
  });

  test('tool.settled', () => {
    const captured = captureEnv();
    record.recordToolRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('tool.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('tool.settled');
  });

  test('model.call', () => {
    const captured = captureEnv();
    record.recordModelRow(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm',
      source: 'judge', usage: {}, usd: undefined,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('model.call');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('model.call');
  });

  test('job.settled', () => {
    const captured = captureEnv();
    record.recordJobSettled(captured.env, {
      workspace: 'w', agentKind: 'orchestrator', operation: 'cancel', outcome: 'ok',
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('job.settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('job.settled');
  });

  test('sandbox.recovery_settled', () => {
    const captured = captureEnv();
    record.recordSandboxRecovery(captured.env, {
      workspace: 'w', stage: 'attach', outcome: 'ok', code: '', attempts: 3, durationMs: 12_000,
    });
    expect(captured.agent[0].blobs?.[eventSlot]).toBe('sandbox.recovery_settled');
    expect(captured.agent[0].blobs?.[boundarySlot]).toBe('sandbox.recovery');
  });

  test('release.transitioned', () => {
    const captured = captureEnv();
    record.recordReleaseTransition(captured.env, {
      actor: 'u', operation: 'transition', reason: 'merged', target: 'c',
      outcome: 'ok', code: '',
    });
    // The audit dataset has no `event` slot; its rows are identified by operation.
    expect(captured.agent).toHaveLength(0);
    expect(captured.ops[0].blobs?.[opsOperationSlot]).toBe('release_transition');
  });
});
