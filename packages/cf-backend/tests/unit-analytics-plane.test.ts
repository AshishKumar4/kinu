/**
 * The analytics plane against a fake Analytics Engine binding: `writeDataPoint` returns void and
 * drops bad points silently, so the captured point is the only observable. Defends: slot
 * transpositions, privacy leaks, silently exceeded platform limits, unweighted SQL over samples.
 */
import { describe, expect, test } from 'bun:test';
import {
  KinuError, RESERVED_LOG_FIELDS, createCompositeLogger, createRecordingLogger, diagnostics,
} from '@kinu.run/core/obs';
import type { SqlExec } from '@kinu.run/core';
import * as v from 'valibot';

import {
  MAX_WRITES_PER_INVOCATION, assertQuantileLevel, assertWithinPlatformLimits,
} from '@kinu.run/core/analytics';
import {
  AGENT_METRICS_SCHEMA, ANALYTICS_SCHEMAS, CONTROL_PLANE_OPS_SCHEMA, FEEDBACK_MARKERS_SCHEMA,
  blobColumn, doubleColumn, indexColumn, type AnalyticsSchema,
} from '@kinu.run/core/analytics';
import { analyticsDigest, assertPublishableNames } from '@kinu.run/core/analytics';
import {
  analyticsPlane, openAnalyticsWindow,
  type AnalyticsEnv,
} from '@kinu.run/core/analytics';
import {
  recordJobSettled, recordModelRow, recordReleaseTransition, recordToolRow,
  recordTtftRow, recordTurnRow,
} from '@kinu.run/core/analytics';
import { feedbackRouteFamily, writeFeedbackMarker } from '@kinu.run/core/analytics';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { controlPlaneMetricsQueries } from '@kinu.run/core/analytics';
import { reportAdminDenial, type AdminDenial } from '../src/control-plane/admin-caller';
import { cliScopesConnectionTag, rejectOutOfScopeRpc } from '../src/cli/rpc-gate';
import { requireTier, type OwnerCapabilityEnv } from '@kinu.run/core';

interface Captured {
  indexes?: ((ArrayBuffer | string) | null)[];
  blobs?: ((ArrayBuffer | string) | null)[];
  doubles?: number[];
}

interface FakeDataset {
  writeDataPoint(point?: Captured): void;
  readonly points: Captured[];
}

function fakeDataset(): FakeDataset {
  const points: Captured[] = [];

  return {
    points,
    writeDataPoint(point?: Captured): void {
      points.push(point ?? {});
    },
  };
}

interface FakePlane {
  readonly env: AnalyticsEnv;
  readonly agent: FakeDataset;
  readonly feedback: FakeDataset;
  readonly ops: FakeDataset;
}

/** Fresh env per call: `analyticsPlane` memoises on the object. */
function fakeEnv(): FakePlane {
  const agent = fakeDataset();
  const feedback = fakeDataset();
  const ops = fakeDataset();

  return {
    agent,
    feedback,
    ops,
    env: { AGENT_METRICS: agent, FEEDBACK_MARKERS: feedback, CONTROL_PLANE_OPS: ops },
  };
}

/** Fails naming what was written, rather than an `undefined` read. */
function onlyPoint(dataset: FakeDataset): Captured {
  expect(dataset.points).toHaveLength(1);

  return dataset.points[0];
}

type BlobValue = string | ArrayBuffer | null | undefined;

/** Resolved by name through the schema; the position tests catch a move. */
function blobAt(point: Captured, schema: typeof AGENT_METRICS_SCHEMA, name: string): BlobValue {
  return point.blobs?.[schema.blobs.findIndex((slot) => slot.name === name)];
}

/** Install the real composite sink (its Analytics half is module-private); drops the install's own announcement row. */
function installSink(plane: FakePlane): () => void {
  const restore = installAnalyticsDiagnostics(plane.env);
  plane.agent.points.length = 0;

  return restore;
}

/** Emit through the installed sink, then restore the previous one: the sink is module-global. */
function throughSink(plane: FakePlane, emit: () => void): void {
  const restore = installSink(plane);

  try {
    emit();
  } finally {
    restore();
  }
}

describe('the slot layout is one declaration', () => {
  // Platform numbers are written out, not derived from the constants, so these pin the platform
  // rather than the guard's self-consistency.

  interface SchemaCensus {
    dataset: string;
    blobBytes: readonly number[];
    doubles: number;
    indexes: readonly { name: string; maxBytes: number }[];
  }

  const census = (dataset: string, over: {
    blobBytes?: readonly number[];
    doubles?: number;
    indexes?: readonly { name: string; maxBytes: number }[];
  }): SchemaCensus => ({
    dataset,
    blobBytes: over.blobBytes ?? [8],
    doubles: over.doubles ?? 1,
    indexes: over.indexes ?? [{ name: 'workspace', maxBytes: 32 }],
  });

  test('every shipped schema fits inside the platform limits, through the guard itself', () => {
    // `defineSchema` is module-private: this pins every shipped dataset inside every limit through the
    // same guard the refusals exercise, over a non-empty schema list.
    expect(ANALYTICS_SCHEMAS.map((schema) => schema.dataset).sort()).toEqual([
      'kinu_agent_metrics',
      'kinu_control_plane_ops',
      'kinu_feedback_markers',
    ]);

    for (const schema of ANALYTICS_SCHEMAS) {
      expect(() => assertWithinPlatformLimits({
        dataset: schema.dataset,
        blobBytes: schema.blobs.map((slot) => slot.maxBytes),
        doubles: schema.doubles.length,
        indexes: [schema.index],
      })).not.toThrow();
      expect(() => assertPublishableNames(schema.dataset, [
        schema.index.name,
        ...schema.blobs.map((slot) => slot.name),
        ...schema.doubles.map((slot) => slot.name),
      ])).not.toThrow();
    }
  });

  test('a schema whose blob budgets exceed 16 KiB is refused at definition', () => {
    expect(() => assertWithinPlatformLimits(census('oversize', {
      blobBytes: [16_385],
    }))).toThrow(/16384/);
  });

  test('a schema declaring more than twenty blobs is refused', () => {
    expect(() => assertWithinPlatformLimits(census('too-wide', {
      blobBytes: Array.from({ length: 21 }, () => 8),
    }))).toThrow(/exceeds the platform's 20/);
  });

  test('a schema declaring more than twenty doubles is refused', () => {
    expect(() => assertWithinPlatformLimits(census('too-deep', { doubles: 21 })))
      .toThrow(/exceeds the platform's 20/);
  });

  test('an index over 96 bytes is refused', () => {
    expect(() => assertWithinPlatformLimits(census('wide-index', {
      indexes: [{ name: 'workspace', maxBytes: 97 }],
    }))).toThrow(/over the platform's 96/);
  });

  test('a second index is refused: the platform writes one and drops the rest in silence', () => {
    expect(() => assertWithinPlatformLimits(census('two-indexes', {
      indexes: [{ name: 'workspace', maxBytes: 32 }, { name: 'actor', maxBytes: 32 }],
    }))).toThrow(/the platform takes 1/);
  });

  test('a slot named for a reserved field is refused — the runtime half of core\'s type ban', () => {
    for (const reserved of ['token', 'prompt', 'headers'] as const) {
      // A `string`-typed name reaches the runtime arm; the type ban (`ReservedSlotIsNotWritable`) is erased.
      const name: string = reserved;
      expect(() => assertPublishableNames(`leaky-${reserved}`, ['workspace', name, 'count']))
        .toThrow(new RegExp(`"${reserved}" is a reserved field name`));
    }
  });

  test('a duplicated slot name is refused: two names for one position is the transposition', () => {
    expect(() => assertPublishableNames('ambiguous', ['workspace', 'kind', 'kind', 'count']))
      .toThrow(/declared twice/);
  });

  test('assertPublishableNames names the offender rather than only refusing', () => {
    expect(() => assertPublishableNames('a test', ['fine', 'apiKey'])).toThrow(/"apiKey"/);
    expect(() => assertPublishableNames('a test', ['fine', 'also_fine'])).not.toThrow();
  });

  test('no reserved name is publishable through any shipped schema', () => {
    const published = new Set<string>();

    for (const schema of ANALYTICS_SCHEMAS) {
      published.add(schema.index.name);

      for (const slot of schema.blobs) published.add(slot.name);

      for (const slot of schema.doubles) published.add(slot.name);
    }

    for (const reserved of RESERVED_LOG_FIELDS) expect(published.has(reserved)).toBe(false);
  });
});

describe('column resolution is derived, never spelled', () => {
  test('agent-metrics positions are pinned — a move here breaks every stored row', () => {
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'kind')).toBe('blob1');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'family')).toBe('blob2');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'event')).toBe('blob3');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'outcome')).toBe('blob4');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'code')).toBe('blob5');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'boundary')).toBe('blob6');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'agentKind')).toBe('blob7');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'provider')).toBe('blob8');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'model')).toBe('blob9');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'tool')).toBe('blob10');
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'source')).toBe('blob11');
    // Appended slots are pinned too: slot order is the wire format.
    expect(blobColumn(AGENT_METRICS_SCHEMA, 'reason')).toBe('blob12');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'count')).toBe('double1');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'durationMs')).toBe('double2');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'ttftMs')).toBe('double3');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'steps')).toBe('double4');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'toolCalls')).toBe('double5');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'input')).toBe('double6');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'output')).toBe('double7');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'cacheRead')).toBe('double8');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'cacheWrite')).toBe('double9');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'reasoning')).toBe('double10');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'neurons')).toBe('double11');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'usd')).toBe('double12');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'priced')).toBe('double13');
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'attempts')).toBe('double14');
    expect(indexColumn(AGENT_METRICS_SCHEMA)).toBe('index1');
  });

  test('feedback and control-plane positions are pinned too', () => {
    expect(blobColumn(FEEDBACK_MARKERS_SCHEMA, 'kind')).toBe('blob1');
    expect(blobColumn(FEEDBACK_MARKERS_SCHEMA, 'outcome')).toBe('blob2');
    expect(blobColumn(FEEDBACK_MARKERS_SCHEMA, 'rejectReason')).toBe('blob3');
    expect(blobColumn(FEEDBACK_MARKERS_SCHEMA, 'routeFamily')).toBe('blob4');
    expect(doubleColumn(FEEDBACK_MARKERS_SCHEMA, 'screenshotBytes')).toBe('double2');
    expect(blobColumn(CONTROL_PLANE_OPS_SCHEMA, 'operation')).toBe('blob2');
    expect(blobColumn(CONTROL_PLANE_OPS_SCHEMA, 'target')).toBe('blob7');
    expect(doubleColumn(CONTROL_PLANE_OPS_SCHEMA, 'affected')).toBe('double3');
  });

  test('an unknown slot name is a named refusal, not an off-by-one column', () => {
    // At the base schema `BlobName` widens to `string`, so an unknown name reaches the runtime arm.
    const resolve: (schema: AnalyticsSchema, name: string) => string = blobColumn;
    expect(() => resolve(AGENT_METRICS_SCHEMA, 'sourc')).toThrow(/no blob slot named "sourc"/);
  });

  test('a schema declares no column a resolver cannot name', () => {
    for (const schema of ANALYTICS_SCHEMAS) {
      for (const slot of schema.blobs) expect(blobColumn(schema, slot.name)).toMatch(/^blob\d+$/);

      for (const slot of schema.doubles) {
        expect(doubleColumn(schema, slot.name)).toMatch(/^double\d+$/);
      }
    }
  });
});

describe('the writer holds the limits the platform enforces silently', () => {
  test('a blob is cut to its slot bound, on a byte boundary, and the cut is counted', () => {
    const plane = fakeEnv();
    // `model` declares 128 bytes; three-byte characters, so 60 of them is 180.
    const long = '漢'.repeat(60);
    recordModelRow(plane.env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'workers-ai', model: long,
      source: 'turn', usage: {}, usd: undefined,
    });
    // Parsed: the wire union admits ArrayBuffer and null; a clamped blob must stay a string.
    const written = v.parse(v.string(), blobAt(onlyPoint(plane.agent), AGENT_METRICS_SCHEMA, 'model'));
    const bytes = new TextEncoder().encode(written);
    expect(bytes.length).toBeLessThanOrEqual(128);
    // Never mid-character: re-encoding the decoded text is byte-identical.
    expect(new TextDecoder().decode(bytes)).toBe(written);
    expect(analyticsPlane(plane.env).agent.stats.clamped).toBe(1);
  });

  test('the write window admits 250 points and refuses the 251st', () => {
    const plane = fakeEnv();
    const { feedback, window } = analyticsPlane(plane.env);

    const row = {
      feedbackId: 'f', kind: 'feedback', outcome: 'accepted', rejectReason: '', routeFamily: 'home',
      count: 1, screenshot: 0, screenshotBytes: 0, noteLength: 0, annotated: 0,
    } as const;

    for (let at = 0; at < MAX_WRITES_PER_INVOCATION + 5; at += 1) feedback.write(row);
    expect(plane.feedback.points).toHaveLength(MAX_WRITES_PER_INVOCATION);
    expect(feedback.stats.written).toBe(MAX_WRITES_PER_INVOCATION);
    expect(feedback.stats.refused).toBe(5);
    expect(window.refused).toBe(5);
  });

  test('the budget is shared across datasets, because the platform counts every call', () => {
    const plane = fakeEnv();
    const window = analyticsPlane(plane.env).window;

    for (let at = 0; at < 100; at += 1) {
      recordToolRow(plane.env, {
        workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
      });
    }

    expect(window.remaining).toBe(MAX_WRITES_PER_INVOCATION - 100);

    for (let at = 0; at < 100; at += 1) {
      recordReleaseTransition(plane.env, {
        actor: 'u', operation: 'transition', reason: 'merged', target: 'c',
        outcome: 'ok', code: '',
      });
    }

    // Two datasets, one budget: 200 spent, not 100 out of 250 twice.
    expect(window.remaining).toBe(MAX_WRITES_PER_INVOCATION - 200);
  });

  test('opening a window replaces the budget rather than topping it up', () => {
    // At the shipped capacity: the number that has to be right is the platform's.
    const { window } = analyticsPlane(fakeEnv().env);
    expect(window.take()).toBe(true);
    window.open();
    expect(window.remaining).toBe(MAX_WRITES_PER_INVOCATION);

    for (let at = 0; at < MAX_WRITES_PER_INVOCATION; at += 1) expect(window.take()).toBe(true);
    expect(window.take()).toBe(false);
  });

  test('openAnalyticsWindow re-opens the plane the record adapters write through', () => {
    const plane = fakeEnv();
    recordToolRow(plane.env, {
      workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
    });
    expect(analyticsPlane(plane.env).window.remaining).toBe(MAX_WRITES_PER_INVOCATION - 1);
    openAnalyticsWindow(plane.env);
    expect(analyticsPlane(plane.env).window.remaining).toBe(MAX_WRITES_PER_INVOCATION);
  });

  test('the budget is per invocation, so two invocations write more than one can', () => {
    // No Durable Object opens its window in a constructor: a hot object would get one window for its
    // whole life, then silence.
    const oneInvocation = fakeEnv();

    for (let at = 0; at <= MAX_WRITES_PER_INVOCATION; at += 1) {
      recordToolRow(oneInvocation.env, {
        workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
      });
    }

    expect(oneInvocation.agent.points).toHaveLength(MAX_WRITES_PER_INVOCATION);
    expect(analyticsPlane(oneInvocation.env).agent.stats.refused).toBe(1);

    // The same 251 rows, split by one invocation boundary — every one written.
    const twoInvocations = fakeEnv();

    for (let at = 0; at < MAX_WRITES_PER_INVOCATION; at += 1) {
      recordToolRow(twoInvocations.env, {
        workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
      });
    }

    openAnalyticsWindow(twoInvocations.env);
    recordToolRow(twoInvocations.env, {
      workspace: 'w', agentKind: 'orchestrator', tool: 'read', failed: false, durationMs: 1,
    });
    expect(twoInvocations.agent.points).toHaveLength(MAX_WRITES_PER_INVOCATION + 1);
    expect(analyticsPlane(twoInvocations.env).agent.stats.refused).toBe(0);
  });

  test('an absent binding is a counted no-op, never a throw', () => {
    const env: AnalyticsEnv = {};
    expect(() => recordTurnRow(env, {
      workspace: 'w', agentKind: 'orchestrator', provider: 'p', model: 'm',
      outcome: 'ok', code: '', durationMs: 1, steps: 1, toolCalls: 0, usage: {}, usd: undefined,
    })).not.toThrow();
    expect(analyticsPlane(env).agent.stats.skipped).toBe(1);
    expect(analyticsPlane(env).agent.stats.written).toBe(0);
  });

  test('a non-finite double is written as zero and counted, not as NaN', () => {
    const plane = fakeEnv();
    recordToolRow(plane.env, {
      workspace: 'w', agentKind: 'orchestrator', tool: 'read',
      failed: false, durationMs: Number.NaN,
    });
    const point = onlyPoint(plane.agent);
    expect(point.doubles?.[1]).toBe(0);
    expect(analyticsPlane(plane.env).agent.stats.coerced).toBe(1);
  });

  test('exactly one index is written, and it is the schema\'s own slot', () => {
    const plane = fakeEnv();
    recordToolRow(plane.env, {
      workspace: 'my-personal-assistant-f0e4afa6', agentKind: 'orchestrator',
      tool: 'read', failed: false, durationMs: 1,
    });
    const point = onlyPoint(plane.agent);
    expect(point.indexes).toHaveLength(1);
    // Against the schema's own declared bound, which the writer clamps to.
    expect(new TextEncoder().encode(v.parse(v.string(), point.indexes?.[0])).length)
      .toBeLessThanOrEqual(AGENT_METRICS_SCHEMA.index.maxBytes);
  });
});

describe('nothing a person said reaches the dataset', () => {
  test('a workspace name is written as a digest, never as itself', () => {
    const plane = fakeEnv();
    const workspace = 'help-me-file-my-divorce-paperwork-a1b2';
    recordTurnRow(plane.env, {
      workspace, agentKind: 'orchestrator', provider: 'workers-ai', model: 'deepseek',
      outcome: 'ok', code: '', durationMs: 10, steps: 2, toolCalls: 1, usage: {}, usd: undefined,
    });
    const point = onlyPoint(plane.agent);
    expect(point.indexes?.[0]).toBe(analyticsDigest(workspace));
    expect(JSON.stringify(point)).not.toContain('divorce');
  });

  test('the digest is stable, distinguishing, and empty for an absent identifier', () => {
    // Known answers per the algorithm `privacy.ts` documents: stored approval digests must keep matching.
    expect(analyticsDigest('alpha')).toBe('a33109d75d8b6dab');
    expect(analyticsDigest('beta')).toBe('f24c3abbaf81e4c7');
    expect(analyticsDigest('alpha')).not.toBe(analyticsDigest('beta'));
    // Absent stays visibly absent, not one bucket that looks like a real workspace.
    expect(analyticsDigest('')).toBe('');
    expect(analyticsDigest('alpha')).toMatch(/^[0-9a-f]{16}$/);
  });

  test('an admin address is digested on the audit dataset, never published', () => {
    const plane = fakeEnv();
    recordReleaseTransition(plane.env, {
      actor: 'owner@example.com', operation: 'transition', reason: 'merged',
      target: 'change-7', outcome: 'ok', code: '',
    });
    const point = onlyPoint(plane.ops);
    expect(JSON.stringify(point)).not.toContain('owner@example.com');
    expect(point.indexes?.[0]).toBe(analyticsDigest('owner@example.com'));
    // One user's work, so digested too.
    expect(point.blobs?.[6]).toBe(analyticsDigest('change-7'));
  });

  test('a diagnostic\'s reserved fields never reach a data point', () => {
    const plane = fakeEnv();
    const restore = installSink(plane);

    // A parsed payload carrying extra fields (spread, RPC hop, JSON body): the runtime arm
    // `LoggableFields` cannot see.
    const smuggled: { provider: string } = JSON.parse(JSON.stringify({
      token: 'sk-live-do-not-publish',
      prompt: 'the user asked about their medical results',
      headers: 'authorization: Bearer hunter2',
      provider: 'workers-ai',
    }));

    diagnostics.event('provider.error', smuggled);
    restore();
    const serialized = JSON.stringify(onlyPoint(plane.agent));
    expect(serialized).not.toContain('sk-live-do-not-publish');
    expect(serialized).not.toContain('medical');
    expect(serialized).not.toContain('hunter2');
    // Proves the row is not empty by accident.
    expect(serialized).toContain('workers-ai');
  });

  test('a failure\'s cause chain is never written — only its classification', () => {
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.failure(
        'provider.error',
        new KinuError('denied', 'upstream said: key sk-live-leaked is revoked'),
        { provider: 'workers-ai' },
      );
    });
    const point = onlyPoint(plane.agent);
    expect(JSON.stringify(point)).not.toContain('sk-live-leaked');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'code')).toBe('denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('failed');
  });

  test('a rendered cause chain in the reason slot is dropped, not clamped and kept', () => {
    // A rendered failure chain under the allowlisted `reason` name is prose; it must not reach the slot.
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: 'digest',
        outcome: 'failed',
        reason: 'removing my-personal-assistant-f0e4afa6: Error: token sk-live-leaked is revoked',
      });
    });
    const point = onlyPoint(plane.ops);
    const serialized = JSON.stringify(point);
    expect(serialized).not.toContain('sk-live-leaked');
    expect(serialized).not.toContain('my-personal-assistant');
    expect(serialized).not.toContain('Error');
    // Dropped, not partially kept; the row still says the action failed.
    expect(point.blobs?.[5]).toBe('');
    expect(point.blobs?.[2]).toBe('failed');
  });

  test('a closed classification word does reach the reason slot', () => {
    // The other direction: the drop above must not be "reason never arrives".
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: 'digest', outcome: 'failed', reason: 'name_mismatch', code: 'bad_input',
      });
    });
    const point = onlyPoint(plane.ops);
    expect(point.blobs?.[5]).toBe('name_mismatch');
    expect(point.blobs?.[3]).toBe('bad_input');
  });

  test('a code field that is not one of core\'s nine codes is dropped', () => {
    // `code`'s vocabulary is closed by core, so membership is the check.
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: 'digest', outcome: 'failed', code: 'ENOENT: no such file or directory',
      });
    });
    expect(onlyPoint(plane.ops).blobs?.[3]).toBe('');
  });

  test('a KinuError\'s own code wins over a field that disagrees', () => {
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.failure(
        'control_plane.workspace_remove',
        new KinuError('timeout', 'the workspace did not answer'),
        { actor: 'digest', code: 'io' },
      );
    });
    expect(onlyPoint(plane.ops).blobs?.[3]).toBe('timeout');
  });

  test('an unrecognised field is dropped rather than stringified into a dimension', () => {
    const plane = fakeEnv();
    throughSink(plane, () => { diagnostics.event('turn.settled', { somethingNew: 'x' }); });
    expect(JSON.stringify(onlyPoint(plane.agent))).not.toContain('somethingNew');
  });

  test('an actor value that looks like an address is digested even on the seam path', () => {
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: 'admin@kinu.run',
        outcome: 'ok',
      });
    });
    expect(JSON.stringify(onlyPoint(plane.ops))).not.toContain('admin@kinu.run');
  });

  test('an already-digested actor passes through unchanged, so the reader can filter', () => {
    const plane = fakeEnv();
    const digest = analyticsDigest('admin@kinu.run');
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: digest,
        outcome: 'ok',
      });
    });
    expect(onlyPoint(plane.ops).indexes?.[0]).toBe(digest);
  });
});

describe('the diagnostics sink routes by event name', () => {
  test('a control_plane event lands on the audit dataset with the tail as its operation', () => {
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('control_plane.workspace_remove', {
        actor: 'digest', outcome: 'denied', reason: 'not_allowlisted', targetKind: 'workspace',
        durationMs: 12, affected: 0,
      });
    });
    expect(plane.agent.points).toHaveLength(0);
    const point = onlyPoint(plane.ops);
    expect(point.blobs?.[0]).toBe('op');
    expect(point.blobs?.[1]).toBe('workspace_remove');
    expect(point.blobs?.[2]).toBe('denied');
    expect(point.blobs?.[4]).toBe('workspace');
    expect(point.blobs?.[5]).toBe('not_allowlisted');
    expect(point.doubles).toEqual([1, 12, 0]);
  });

  test('every other event lands on the agent dataset, stamped with its family', () => {
    const plane = fakeEnv();
    throughSink(plane, () => { diagnostics.event('rpc_gate.denied', { tool: 'setModel' }); });
    expect(plane.ops.points).toHaveLength(0);
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'kind')).toBe('event');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'family')).toBe('rpc_gate');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('rpc_gate.denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'tool')).toBe('setModel');
  });

  test('a line with no workspace is unattributed, never attributed to another actor', () => {
    // Cloudflare co-locates Durable Objects and the sink is module-global, so attribution must come
    // off the line, not from whichever actor installed first.
    const plane = fakeEnv();
    const restore = installSink(plane);
    // A second install must not wrap the composite again: `installAnalyticsDiagnostics` is idempotent per isolate.
    const second = installAnalyticsDiagnostics(plane.env);

    try {
      diagnostics.event('rpc_gate.denied', { workspace: 'first-actor' });
      diagnostics.event('rpc_gate.denied', {});
      diagnostics.event('rpc_gate.denied', { workspace: 'second-actor' });
    } finally {
      second();
      restore();
    }

    expect(plane.agent.points).toHaveLength(3);
    expect(plane.agent.points[0].indexes?.[0]).toBe(analyticsDigest('first-actor'));
    // Absent, and specifically not the first actor's digest.
    expect(plane.agent.points[1].indexes?.[0]).toBe('');
    expect(plane.agent.points[2].indexes?.[0]).toBe(analyticsDigest('second-actor'));
  });

  test('automatic titling is attributed by workspace, and the title is not published', () => {
    // The title stays out: it is derived from the mission, the person's own sentence.
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('agent.auto_titled', {
        workspace: 'help-me-file-my-divorce-paperwork-a1b2',
        title: 'Divorce paperwork',
      });
    });
    const point = onlyPoint(plane.agent);
    expect(point.indexes?.[0]).toBe(analyticsDigest('help-me-file-my-divorce-paperwork-a1b2'));
    const serialized = JSON.stringify(point);
    expect(serialized).not.toContain('divorce');
    expect(serialized).not.toContain('Divorce paperwork');
  });

  test('an identity reported under an un-allowlisted name is dropped, not indexed', () => {
    // The negative that makes the rename above load-bearing rather than cosmetic:
    // `agent` is not a slot, so a row naming itself that way is unattributed.
    const plane = fakeEnv();
    throughSink(plane, () => {
      diagnostics.event('agent.auto_titled', { agent: 'some-workspace' });
    });
    const point = onlyPoint(plane.agent);
    expect(point.indexes?.[0]).toBe('');
    expect(JSON.stringify(point)).not.toContain('some-workspace');
  });
});

describe('a denial is a row that says denied', () => {
  /** Async twin of `throughSink`: drives the real emit site through the real sink. */
  async function throughAsyncSink(plane: FakePlane, emit: () => Promise<void>): Promise<void> {
    const restore = installSink(plane);

    try {
      await emit();
    } finally {
      restore();
    }
  }

  test('an admin-plane denial lands as denied, with its reason and no request text', () => {
    // A denial must not read as `outcome: 'ok'` with an empty reason.
    const plane = fakeEnv();
    throughSink(plane, () => {
      reportAdminDenial('not_admin', '/api/control/users/help-me-with-my-divorce', 'GET');
    });
    const point = onlyPoint(plane.ops);
    expect(point.blobs?.[1]).toBe('denied');
    expect(point.blobs?.[2]).toBe('denied');
    expect(point.blobs?.[5]).toBe('not_admin');
    // The path can name a workspace (user text); it reaches Workers Logs only.
    expect(JSON.stringify(point)).not.toContain('divorce');
  });

  test('every admin denial reason reaches the slot as itself', () => {
    // Checked whole: every `access_*` arm answers the same 404 by design, so this row is the only
    // place they are told apart.
    const denials: readonly AdminDenial[] = [
      'unconfigured', 'no_admins_configured', 'not_admin',
      'dev_identity', 'token_identity', 'stale_auth',
      'access_unconfigured', 'access_missing', 'access_invalid', 'access_no_email',
      'access_mismatch',
    ];

    for (const denial of denials) {
      const plane = fakeEnv();
      throughSink(plane, () => { reportAdminDenial(denial, '/api/control', 'POST'); });
      expect(onlyPoint(plane.ops).blobs?.[5]).toBe(denial);
    }
  });

  test('an out-of-scope RPC lands as denied, naming the method and the arm that refused', () => {
    // Both arms: a wrong scope set is our client; a method no token reaches is probing.
    const arms = [
      { method: 'getAgentStatus', scopes: 'ai.proxy', reason: 'scope_missing' },
      { method: 'setModel', scopes: 'workspace.read', reason: 'interactive_only' },
    ] as const;

    for (const arm of arms) {
      const plane = fakeEnv();
      const tag = cliScopesConnectionTag(arm.scopes);
      expect(tag).not.toBeNull();
      throughSink(plane, () => {
        rejectOutOfScopeRpc([tag ?? ''], JSON.stringify({
          type: 'rpc', id: '1', method: arm.method, args: [],
        }));
      });
      const point = onlyPoint(plane.agent);
      expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('rpc_gate.denied');
      expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('denied');
      expect(blobAt(point, AGENT_METRICS_SCHEMA, 'tool')).toBe(arm.method);
      expect(blobAt(point, AGENT_METRICS_SCHEMA, 'reason')).toBe(arm.reason);
    }
  });

  test('a capability refusal lands as denied, with its reason and no workspace prose', async () => {
    const plane = fakeEnv();

    const sql: SqlExec = {
      exec(): never { throw new Error('the refused path must not reach SQL'); },
    };

    const env: OwnerCapabilityEnv = {};
    await throughAsyncSink(plane, async () => {
      await expect(requireTier(sql, env, { caller: {} }, 'credentials.other')).rejects.toThrow(/no valid caller identity/);
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('capability.denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'source')).toBe('workspace_capability');
    // The deciding arm: `owner_only` (policy) and `unrecognized_workspace` (broken identity) need
    // opposite operator responses.
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'reason')).toBe('no_caller_identity');
    // The refusal MESSAGE names the workspace; the row never does.
    expect(JSON.stringify(point)).not.toContain('capability token');
  });
});

describe('the record adapters write the rows their boundaries promise', () => {
  test('a settled turn carries its duration, shape and the provider\'s own token report', () => {
    const plane = fakeEnv();
    recordTurnRow(plane.env, {
      workspace: 'ws', agentKind: 'orchestrator', provider: 'workers-ai', model: 'deepseek-v4',
      outcome: 'failed', code: 'timeout', durationMs: 4200, steps: 6, toolCalls: 9,
      usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 12, reasoning: 45, neurons: 7 },
      usd: 0.0031,
    });
    const point = onlyPoint(plane.agent);
    expect(point.blobs).toEqual([
      'turn', 'turn', 'turn.settled', 'failed', 'timeout', 'turn.settled',
      'orchestrator', 'workers-ai', 'deepseek-v4', '', '', '',
    ]);
    // The trailing 0 is `attempts`: a turn is not a delivery.
    expect(point.doubles).toEqual([1, 4200, 0, 6, 9, 1200, 340, 900, 12, 45, 7, 0.0031, 1, 0]);
  });

  test('an unpriced call reports priced 0, so an average cost cannot be diluted', () => {
    const plane = fakeEnv();
    recordModelRow(plane.env, {
      workspace: 'ws', agentKind: 'orchestrator', provider: 'workers-ai', model: 'judge-model',
      source: 'judge', usage: { input: 10, output: 5 }, usd: undefined,
    });
    const point = onlyPoint(plane.agent);
    expect(doubleColumn(AGENT_METRICS_SCHEMA, 'usd')).toBe('double12');
    expect(point.doubles?.[11]).toBe(0);
    expect(point.doubles?.[12]).toBe(0);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'source')).toBe('judge');
  });

  test('a tool row carries a verdict and a duration and nothing the tool touched', () => {
    const plane = fakeEnv();
    recordToolRow(plane.env, {
      workspace: 'ws', agentKind: 'orchestrator', tool: 'shell', failed: true, durationMs: 91,
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'kind')).toBe('tool');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'tool')).toBe('shell');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('failed');
    expect(point.doubles?.[1]).toBe(91);
    expect(point.doubles?.[4]).toBe(1);
    // No token report or price on a tool row: a zero would pool into spend aggregates.
    expect(point.doubles?.slice(5)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('a first-token row is its own kind, so a silent turn is absent rather than zero', () => {
    const plane = fakeEnv();
    recordTtftRow(plane.env, {
      workspace: 'ws', agentKind: 'orchestrator', provider: 'workers-ai',
      model: 'deepseek-v4', ttftMs: 380,
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'kind')).toBe('ttft');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('turn.first_token');
    expect(point.doubles?.[2]).toBe(380);
    expect(point.doubles?.[1]).toBe(0);
  });

  test('a job operation records the verb and whether it took effect, never the job id', () => {
    const plane = fakeEnv();
    recordJobSettled(plane.env, {
      workspace: 'ws', agentKind: 'orchestrator', operation: 'retry', outcome: 'refused',
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'source')).toBe('retry');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('refused');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'boundary')).toBe('job.settled');
  });

  test('a release transition lands on the audit dataset, not the agent one', () => {
    const plane = fakeEnv();
    recordReleaseTransition(plane.env, {
      actor: 'user-42', operation: 'deployment', reason: 'production',
      target: 'change-9', outcome: 'ok', code: '',
    });
    expect(plane.agent.points).toHaveLength(0);
    const point = onlyPoint(plane.ops);
    expect(point.blobs?.[1]).toBe('release_deployment');
    expect(point.blobs?.[4]).toBe('release_change');
    expect(point.blobs?.[5]).toBe('production');
  });
});

describe('a feedback marker carries no report', () => {
  test('an accepted submission records size and length, never the note', () => {
    const plane = fakeEnv();
    writeFeedbackMarker(plane.env, {
      feedbackId: 'fb_01',
      outcome: 'accepted',
      rejectReason: '',
      routeFamily: 'workspace',
      hasScreenshot: true,
      screenshotBytes: 240_128,
      noteLength: 87,
      annotated: true,
    });
    const point = onlyPoint(plane.feedback);
    expect(point.indexes).toEqual(['fb_01']);
    expect(point.blobs).toEqual(['feedback', 'accepted', '', 'workspace']);
    expect(point.doubles).toEqual([1, 240_128, 87, 1, 1]);
  });

  test('a rejection is a row too, because a lost report is invisible otherwise', () => {
    const plane = fakeEnv();

    for (const reason of ['too_large', 'storage_unavailable', 'row_write_failed'] as const) {
      writeFeedbackMarker(plane.env, {
        feedbackId: `fb_${reason}`,
        outcome: 'rejected',
        rejectReason: reason,
        routeFamily: 'other',
        hasScreenshot: false,
        screenshotBytes: 0,
        noteLength: 0,
        annotated: false,
      });
    }

    expect(plane.feedback.points.map((p) => p.blobs?.[2]))
      .toEqual(['too_large', 'storage_unavailable', 'row_write_failed']);
    // Accepted rows carry '' and rejections never do, so `rejectReason != ''` is the rejection set.
    expect(plane.feedback.points.every((p) => p.blobs?.[2] !== '')).toBe(true);
  });

  test('a screenshot-bearing refusal reports the screenshot it carried', () => {
    // Presence and size are separate slots: a refusal before measuring still reports the screenshot sent.
    const plane = fakeEnv();
    writeFeedbackMarker(plane.env, {
      feedbackId: 'fb_reject', outcome: 'rejected', rejectReason: 'bad_content_type',
      routeFamily: 'workspace', hasScreenshot: true, screenshotBytes: 41_233,
      noteLength: 12, annotated: false,
    });
    const point = onlyPoint(plane.feedback);
    expect(point.doubles?.[1]).toBe(41_233);
    expect(point.doubles?.[4]).toBe(1);
  });

  test('a note-only report is distinguishable from one whose screenshot was refused', () => {
    // Same 0 bytes; only the presence slot tells them apart.
    const plane = fakeEnv();
    writeFeedbackMarker(plane.env, {
      feedbackId: 'fb_note', outcome: 'accepted', rejectReason: '', routeFamily: 'home',
      hasScreenshot: false, screenshotBytes: 0, noteLength: 3, annotated: false,
    });
    writeFeedbackMarker(plane.env, {
      feedbackId: 'fb_empty_shot', outcome: 'rejected', rejectReason: 'malformed',
      routeFamily: 'home', hasScreenshot: true, screenshotBytes: 0, noteLength: 3,
      annotated: false,
    });
    expect(plane.feedback.points.map((point) => point.doubles?.[4])).toEqual([0, 1]);
  });

  test('a route becomes a family, so no workspace slug reaches the index or a blob', () => {
    expect(feedbackRouteFamily('/workspace/help-me-with-my-taxes-9f2a')).toBe('workspace');
    expect(feedbackRouteFamily('/mcts/abc?run=1')).toBe('explore');
    expect(feedbackRouteFamily('/settings')).toBe('settings');
    expect(feedbackRouteFamily('/')).toBe('home');
    expect(feedbackRouteFamily('/user/settings')).toBe('settings');
    expect(feedbackRouteFamily('/control')).toBe('control');
    expect(feedbackRouteFamily('/triggers/ws')).toBe('triggers');
    expect(feedbackRouteFamily('/something-nobody-mapped')).toBe('other');
  });
});

describe('every aggregate is weighted, because the dataset is sampled', () => {
  // The expression builders are module-private; panel SQL is where their output is observable.

  test('the four primitives implement the platform\'s own translation table', () => {
    const { turns, tokens, firstToken } =
      controlPlaneMetricsQueries({ sinceHours: 24 });

    // Weighted count: each surviving row stands for `_sample_interval` originals.
    expect(turns).toContain('SUM(_sample_interval) AS turns');
    expect(tokens).toContain('SUM(_sample_interval * double6) AS inputTokens');
    expect(turns)
      .toContain('SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgDurationMs');
    expect(firstToken)
      .toContain('quantileExactWeighted(0.95)(double3, _sample_interval) AS p95TtftMs');
  });

  test('a ratio divides by a measured denominator, not by the row count', () => {
    // `usd` is 0 for unpriced and free calls alike, so the denominator is `priced`, not the row count.
    const { tokens } = controlPlaneMetricsQueries({ sinceHours: 24 });
    expect(tokens).toContain(
      'SUM(_sample_interval * double12) / SUM(_sample_interval * double13) AS usdPerPricedCall',
    );
  });

  test('a quantile outside (0,1) is refused rather than emitted as SQL', () => {
    // A percentage where a fraction belongs gets a column of nulls from AE, not an error.
    expect(() => assertQuantileLevel(0)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(1)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(95)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(0.95)).not.toThrow();
  });

  test('a built query names the dataset, bounds the window, and aliases by slot name', () => {
    const sql = controlPlaneMetricsQueries({ sinceHours: 24 }).latency;
    expect(sql).toContain('FROM kinu_agent_metrics');
    expect(sql).toContain('blob9 AS model');
    expect(sql).toContain("WHERE timestamp > NOW() - INTERVAL '24' HOUR");
    expect(sql).toContain('GROUP BY blob9');
    expect(sql).toContain('ORDER BY turns DESC');
    expect(sql).toContain('LIMIT 50');
  });

  test('a panel whose group-by has open cardinality carries a row bound', () => {
    // `model` and `tool` values are uncapped and the surface renders every row, so the panel's top-N is the bound.
    const built = controlPlaneMetricsQueries({ sinceHours: 24 });

    for (const name of ['latency', 'tokens', 'toolFailures', 'firstToken'] as const) {
      expect(built[name]).toContain('LIMIT 50');
      expect(built[name]).toMatch(/ORDER BY \w+ DESC/u);
    }

    // A closed vocabulary takes no bound: it could only hide a row.
    for (const name of ['turns', 'adminOps'] as const) {
      expect(built[name]).not.toContain('LIMIT');
    }
  });

  test('no shipped query uses an unweighted aggregate', () => {
    const queries = Object.values(controlPlaneMetricsQueries({ sinceHours: 24 }));

    for (const sql of queries) {
      // Bare forms an unsampled dataset would allow; `SUM(` is legal only weighted by the sample interval.
      expect(sql).not.toMatch(/\bCOUNT\s*\(/);
      expect(sql).not.toMatch(/\bAVG\s*\(/);
      expect(sql).not.toMatch(/SUM\((?!_sample_interval)/);
      expect(sql).not.toMatch(/quantileExactWeighted\([^)]*\)\((?![^)]*_sample_interval)/);
      // An unbounded scan over three months times out in AE.
      expect(sql).toContain('timestamp > NOW() - INTERVAL');
    }
  });

  test('the control plane gets exactly the panels it is promised', () => {
    const queries = controlPlaneMetricsQueries({ sinceHours: 24 });
    expect(Object.keys(queries).sort())
      .toEqual(['adminOps', 'firstToken', 'latency', 'tokens', 'toolFailures', 'turns']);
    expect(queries.firstToken).toContain("blob1 = 'ttft'");
    expect(queries.firstToken).toContain('quantileExactWeighted(0.95)(double3, _sample_interval)');
    expect(queries.turns).toContain("blob1 = 'turn'");
    expect(queries.tokens).toContain("blob1 = 'model'");
    expect(queries.toolFailures).toContain("blob1 = 'tool'");
    expect(queries.toolFailures).toContain("blob4 != 'ok'");
    expect(queries.adminOps).toContain('FROM kinu_control_plane_ops');
  });

  test('a workspace filter compares index1 to a digest, and never leaks to the audit dataset', () => {
    const digest = analyticsDigest('my-workspace');

    const queries = controlPlaneMetricsQueries({
      sinceHours: 6, workspaceDigest: digest,
    });

    expect(queries.turns).toContain(`index1 = '${digest}'`);
    expect(queries.latency).toContain(`index1 = '${digest}'`);
    expect(queries.tokens).toContain(`index1 = '${digest}'`);
    // Different dataset and index: the same string would silently match nothing.
    expect(queries.adminOps).not.toContain(digest);
  });

  test('the lookback is a whole positive number of hours whatever the caller passes', () => {
    const hours = (sinceHours: number): string =>
      controlPlaneMetricsQueries({ sinceHours }).turns;

    expect(hours(0)).toContain("INTERVAL '1' HOUR");
    expect(hours(-5)).toContain("INTERVAL '1' HOUR");
    expect(hours(24.9)).toContain("INTERVAL '24' HOUR");
  });

  test('nothing in the query builders reads an environment or a binding', () => {
    // The control plane renders the not-configured arm with no secret or binding, so builders are pure.
    const queries = controlPlaneMetricsQueries({ sinceHours: 1 });
    expect(queries.turns).toContain("INTERVAL '1' HOUR");
  });
});

describe('the composite sink adds a destination instead of replacing one', () => {
  test('installing puts the analytics half in the composite, not in place of it', () => {
    const plane = fakeEnv();
    const restore = installAnalyticsDiagnostics(plane.env);

    try {
      // The install announces itself through its own sink; the other tests consume this row, asserted here.
      expect(plane.agent.points).toHaveLength(1);
      expect(blobAt(plane.agent.points[0], AGENT_METRICS_SCHEMA, 'event'))
        .toBe('analytics.sink_installed');
      diagnostics.event('turn.settled', { provider: 'workers-ai' });
      expect(plane.agent.points).toHaveLength(2);
      expect(blobAt(plane.agent.points[1], AGENT_METRICS_SCHEMA, 'provider')).toBe('workers-ai');
    } finally {
      restore();
    }

    // The restore really restores: the sink is module-global.
    diagnostics.event('turn.settled', { provider: 'workers-ai' });
    expect(plane.agent.points).toHaveLength(2);
  });

  test('both members receive the line, in order', () => {
    const first = createRecordingLogger();
    const second = createRecordingLogger();
    createCompositeLogger([first, second]).event('turn.settled', { provider: 'workers-ai' });
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toHaveLength(1);
  });

  test('a broken member does not stop the others, and the failure is not hidden', () => {
    const reached = createRecordingLogger();

    const broken = {
      event(): void { throw new Error('sink is down'); },
      failure(): void { throw new Error('sink is down'); },
    };

    const after = createRecordingLogger();
    const composite = createCompositeLogger([reached, broken, after]);
    expect(() => composite.event('turn.settled', {})).toThrow('sink is down');
    // A failing destination must not cost the others their copy.
    expect(reached.emitted).toHaveLength(1);
    expect(after.emitted).toHaveLength(1);
  });
});
