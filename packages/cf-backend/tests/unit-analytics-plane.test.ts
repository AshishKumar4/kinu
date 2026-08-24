/**
 * The analytics plane, asserted against a fake Analytics Engine binding.
 *
 * WHY A FAKE BINDING IS THE RIGHT SUBSTITUTION HERE. `writeDataPoint` returns
 * `void` and reports nothing — the platform's own documentation says an
 * oversized, over-budget or malformed point is dropped silently and to go look in
 * tail logs. So there is no return value to assert on and no error to catch: the
 * ONLY observable of this whole subsystem is the data point handed to the
 * binding. Capturing that is not a weaker test than a real one, it is the same
 * test with the sampler removed.
 *
 * WHAT THESE ASSERT that nothing else can:
 *   1. FIELD POSITIONS. `blob7` means one thing forever. A transposition returns
 *      strings, not errors, so a query keeps working and every value in the
 *      column is wrong — the failure with no symptom, pinned here by position.
 *   2. PRIVACY. A workspace name is mission-derived user text and an admin's
 *      address is an address; both must be unrecoverable from the dataset, and a
 *      diagnostic's un-allowlisted fields must not reach it at all.
 *   3. THE PLATFORM'S LIMITS, each of which is silent when exceeded.
 *   4. WEIGHTED SQL. An unweighted aggregate over a sampled dataset returns a
 *      plausible smaller number under a column heading that no longer means it.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  KinuError, RESERVED_LOG_FIELDS, createCompositeLogger, createRecordingLogger,
} from '@kinu.run/core/obs';

import {
  MAX_BLOBS, MAX_BLOB_BYTES, MAX_DOUBLES, MAX_INDEX_BYTES, MAX_WRITES_PER_INVOCATION,
} from '../src/analytics/limits';
import {
  AGENT_METRICS_SCHEMA, ANALYTICS_SCHEMAS, CONTROL_PLANE_OPS_SCHEMA, FEEDBACK_MARKERS_SCHEMA,
  blobColumn, defineSchema, doubleColumn, indexColumn, type AnalyticsSchema,
} from '../src/analytics/schemas';
import { analyticsDigest, assertPublishableNames } from '../src/analytics/privacy';
import {
  analyticsPlane, createAnalyticsWindow, createAnalyticsWriter, openAnalyticsWindow,
  type AnalyticsEnv,
} from '../src/analytics/writer';
import {
  recordJobSettled, recordModelRow, recordReleaseTransition, recordToolRow,
  recordTtftRow, recordTurnRow,
} from '../src/analytics/record';
import { feedbackRouteFamily, writeFeedbackMarker } from '../src/analytics/feedback-marker';
import { createAnalyticsLogger } from '../src/analytics/install';
import {
  buildWeightedQuery, controlPlaneMetricsQueries, weightedAvg, weightedCount,
  weightedQuantile, weightedRatio, weightedSum,
} from '../src/analytics/query';

/** One captured data point, in the platform's own shape. */
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

/** A fresh environment per call, because `analyticsPlane` memoises on the object
 *  and a shared one would carry the previous test's spent write budget. */
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

/** The one point a test expected to be written, or a failure naming what it got
 *  instead — `points[0]!` would report `undefined` reads rather than "nothing was
 *  written", which is the interesting answer. */
function onlyPoint(dataset: FakeDataset): Captured {
  expect(dataset.points).toHaveLength(1);
  return dataset.points[0];
}

/** What a blob slot can hold on the wire — the platform's own union. Named so a
 *  reader is not handed `unknown` and made to narrow it again. */
type BlobValue = string | ArrayBuffer | null | undefined;

/** The value in a named blob slot, resolved by NAME through the schema — so the
 *  assertion still reads correctly if a slot moves, and the POSITION tests below
 *  are the ones that catch a move. */
function blobAt(point: Captured, schema: typeof AGENT_METRICS_SCHEMA, name: string): BlobValue {
  return point.blobs?.[schema.blobs.findIndex((slot) => slot.name === name)];
}

describe('the slot layout is one declaration', () => {
  test('every schema fits inside the platform limits it declares against', () => {
    for (const schema of ANALYTICS_SCHEMAS) {
      expect(schema.blobs.length).toBeLessThanOrEqual(MAX_BLOBS);
      expect(schema.doubles.length).toBeLessThanOrEqual(MAX_DOUBLES);
      expect(schema.index.maxBytes).toBeLessThanOrEqual(MAX_INDEX_BYTES);
      const budget = schema.blobs.reduce((sum, slot) => sum + slot.maxBytes, 0);
      expect(budget).toBeLessThanOrEqual(MAX_BLOB_BYTES);
    }
  });

  test('a schema whose blob budgets exceed 16 KiB is refused at definition', () => {
    expect(() => defineSchema({
      binding: 'AGENT_METRICS',
      dataset: 'oversize',
      index: { name: 'workspace', maxBytes: 32 },
      blobs: [{ name: 'huge', maxBytes: MAX_BLOB_BYTES + 1 }],
      doubles: [{ name: 'count' }],
    })).toThrow(/16384/);
  });

  test('a schema declaring more than twenty blobs is refused', () => {
    expect(() => defineSchema({
      binding: 'AGENT_METRICS',
      dataset: 'too-wide',
      index: { name: 'workspace', maxBytes: 32 },
      blobs: Array.from({ length: MAX_BLOBS + 1 }, (_unused, at) => ({ name: `b${at}`, maxBytes: 8 })),
      doubles: [{ name: 'count' }],
    })).toThrow(/exceeds the platform's 20/);
  });

  test('an index over 96 bytes is refused', () => {
    expect(() => defineSchema({
      binding: 'AGENT_METRICS',
      dataset: 'wide-index',
      index: { name: 'workspace', maxBytes: MAX_INDEX_BYTES + 1 },
      blobs: [{ name: 'kind', maxBytes: 8 }],
      doubles: [{ name: 'count' }],
    })).toThrow(/over the platform's 96/);
  });

  test('a slot named for a reserved field is refused — the runtime half of core\'s type ban', () => {
    for (const reserved of ['token', 'prompt', 'headers'] as const) {
      // The slot name goes in through a `string`-typed binding, which is exactly
      // how a dynamically-assembled schema would reach `defineSchema`. The TYPE
      // ban is the stronger half and refuses the literal spelling —
      // `ReservedSlotIsNotWritable` is uninhabited — but a type is erased before
      // anything runs, so widening the name here is what reaches the arm that
      // still holds at runtime. No assertion is needed to do it.
      const name: string = reserved;
      expect(() => defineSchema({
        binding: 'AGENT_METRICS',
        dataset: `leaky-${reserved}`,
        index: { name: 'workspace', maxBytes: 32 },
        blobs: [{ name, maxBytes: 16 }],
        doubles: [{ name: 'count' }],
      })).toThrow(new RegExp(`"${reserved}" is a reserved field name`));
    }
  });

  test('a duplicated slot name is refused: two names for one position is the transposition', () => {
    expect(() => defineSchema({
      binding: 'AGENT_METRICS',
      dataset: 'ambiguous',
      index: { name: 'workspace', maxBytes: 32 },
      blobs: [{ name: 'kind', maxBytes: 8 }, { name: 'kind', maxBytes: 8 }],
      doubles: [{ name: 'count' }],
    })).toThrow(/declared twice/);
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
    // The generic instantiated at the BASE schema, where `BlobName` widens to
    // `string` — so a name outside any one schema's slots is expressible without
    // asserting anything. The type refuses it for a concrete schema; this is the
    // runtime arm, for a caller that reached the resolver dynamically.
    const resolve: (schema: AnalyticsSchema, name: string) => string = blobColumn;
    expect(() => resolve(AGENT_METRICS_SCHEMA, 'sourc')).toThrow(/no blob slot named "sourc"/);
  });

  test('a schema declares no column a resolver cannot name', () => {
    // The inverse of the position tests above: every declared slot resolves, so
    // a schema cannot carry a column that no query is able to reach.
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
    // Parsed rather than `typeof`-tested: the wire union admits an ArrayBuffer and
    // null, and the assertion is that a clamped blob is still a STRING.
    const written = v.parse(v.string(), blobAt(onlyPoint(plane.agent), AGENT_METRICS_SCHEMA, 'model'));
    const bytes = new TextEncoder().encode(written);
    expect(bytes.length).toBeLessThanOrEqual(128);
    // Never mid-character: a re-encode of the decoded text is byte-identical, so
    // no replacement character was produced by the cut.
    expect(new TextDecoder().decode(bytes)).toBe(written);
    expect(analyticsPlane(plane.env).agent.stats.clamped).toBe(1);
  });

  test('the write window admits 250 points and refuses the 251st', () => {
    const window = createAnalyticsWindow();
    const dataset = fakeDataset();
    const writer = createAnalyticsWriter(dataset, FEEDBACK_MARKERS_SCHEMA, window);
    const row = {
      feedbackId: 'f', kind: 'feedback', outcome: 'accepted', rejectReason: '', routeFamily: 'home',
      count: 1, screenshotBytes: 0, noteLength: 0, annotated: 0,
    } as const;
    for (let at = 0; at < MAX_WRITES_PER_INVOCATION + 5; at += 1) writer.write(row);
    expect(dataset.points).toHaveLength(MAX_WRITES_PER_INVOCATION);
    expect(writer.stats.written).toBe(MAX_WRITES_PER_INVOCATION);
    expect(writer.stats.refused).toBe(5);
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
    const window = createAnalyticsWindow(3);
    expect(window.take()).toBe(true);
    window.open();
    expect(window.remaining).toBe(3);
    expect(window.take() && window.take() && window.take()).toBe(true);
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
    expect(new TextEncoder().encode(String(point.indexes?.[0])).length)
      .toBeLessThanOrEqual(MAX_INDEX_BYTES);
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
    expect(analyticsDigest('alpha')).toBe(analyticsDigest('alpha'));
    expect(analyticsDigest('alpha')).not.toBe(analyticsDigest('beta'));
    // Absent stays visibly absent rather than becoming one bucket that looks
    // like a real workspace.
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
    // The target is one user's work, so it is a digest for the same reason.
    expect(point.blobs?.[6]).toBe(analyticsDigest('change-7'));
  });

  test('a diagnostic\'s reserved fields never reach a data point', () => {
    const plane = fakeEnv();
    const logger = createAnalyticsLogger(plane.env, () => 'ws');
    // A PARSED PAYLOAD, which is the case the runtime arm exists for and the one
    // `LoggableFields` cannot see: the declared type names one field, the value
    // carries four. That is what a spread, an RPC hop or a JSON body looks like
    // by the time the sink meets it, and it needs no assertion to build.
    const smuggled: { provider: string } = JSON.parse(JSON.stringify({
      token: 'sk-live-do-not-publish',
      prompt: 'the user asked about their medical results',
      headers: 'authorization: Bearer hunter2',
      provider: 'workers-ai',
    }));
    logger.event('provider.error', smuggled);
    const serialized = JSON.stringify(onlyPoint(plane.agent));
    expect(serialized).not.toContain('sk-live-do-not-publish');
    expect(serialized).not.toContain('medical');
    expect(serialized).not.toContain('hunter2');
    // The allowlisted field DID arrive, so the row is not empty by accident.
    expect(serialized).toContain('workers-ai');
  });

  test('a failure\'s cause chain is never written — only its classification', () => {
    const plane = fakeEnv();
    const logger = createAnalyticsLogger(plane.env, () => 'ws');
    logger.failure(
      'provider.error',
      new KinuError('denied', 'upstream said: key sk-live-leaked is revoked'),
      { provider: 'workers-ai' },
    );
    const point = onlyPoint(plane.agent);
    expect(JSON.stringify(point)).not.toContain('sk-live-leaked');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'code')).toBe('denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('failed');
  });

  test('an unrecognised field is dropped rather than stringified into a dimension', () => {
    const plane = fakeEnv();
    createAnalyticsLogger(plane.env, () => 'ws').event('turn.settled', { somethingNew: 'x' });
    expect(JSON.stringify(onlyPoint(plane.agent))).not.toContain('somethingNew');
  });

  test('an actor value that looks like an address is digested even on the seam path', () => {
    const plane = fakeEnv();
    createAnalyticsLogger(plane.env, () => '').event('control_plane.workspace_remove', {
      actor: 'admin@kinu.run',
      outcome: 'ok',
    });
    expect(JSON.stringify(onlyPoint(plane.ops))).not.toContain('admin@kinu.run');
  });

  test('an already-digested actor passes through unchanged, so the reader can filter', () => {
    const plane = fakeEnv();
    const digest = analyticsDigest('admin@kinu.run');
    createAnalyticsLogger(plane.env, () => '').event('control_plane.workspace_remove', {
      actor: digest,
      outcome: 'ok',
    });
    expect(onlyPoint(plane.ops).indexes?.[0]).toBe(digest);
  });
});

describe('the diagnostics sink routes by event name', () => {
  test('a control_plane event lands on the audit dataset with the tail as its operation', () => {
    const plane = fakeEnv();
    createAnalyticsLogger(plane.env, () => 'ws').event('control_plane.workspace_remove', {
      actor: 'digest', outcome: 'denied', reason: 'not_allowlisted', targetKind: 'workspace',
      durationMs: 12, affected: 0,
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
    createAnalyticsLogger(plane.env, () => 'ws').event('rpc_gate.denied', { tool: 'setModel' });
    expect(plane.ops.points).toHaveLength(0);
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'kind')).toBe('event');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'family')).toBe('rpc_gate');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('rpc_gate.denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'tool')).toBe('setModel');
  });

  test('the installer\'s workspace is used only when the line does not name one', () => {
    const plane = fakeEnv();
    const logger = createAnalyticsLogger(plane.env, () => 'isolate-workspace');
    logger.event('rpc_gate.denied', {});
    logger.event('rpc_gate.denied', { workspace: 'line-workspace' });
    expect(plane.agent.points[0].indexes?.[0]).toBe(analyticsDigest('isolate-workspace'));
    expect(plane.agent.points[1].indexes?.[0]).toBe(analyticsDigest('line-workspace'));
  });
});

describe('the record adapters write the rows their boundaries promise', () => {
  test('a settled turn carries its duration, shape and the provider\'s own token report', () => {
    const plane = fakeEnv();
    recordTurnRow(plane.env, {
      workspace: 'ws', agentKind: 'subordinate', provider: 'workers-ai', model: 'deepseek-v4',
      outcome: 'failed', code: 'timeout', durationMs: 4200, steps: 6, toolCalls: 9,
      usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 12, reasoning: 45, neurons: 7 },
      usd: 0.0031,
    });
    const point = onlyPoint(plane.agent);
    expect(point.blobs).toEqual([
      'turn', 'turn', 'turn.settled', 'failed', 'timeout', 'turn.settled',
      'subordinate', 'workers-ai', 'deepseek-v4', '', '',
    ]);
    expect(point.doubles).toEqual([1, 4200, 0, 6, 9, 1200, 340, 900, 12, 45, 7, 0.0031, 1]);
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
      workspace: 'ws', agentKind: 'orchestrator', tool: 'run', failed: true, durationMs: 91,
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'kind')).toBe('tool');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'tool')).toBe('run');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('failed');
    expect(point.doubles?.[1]).toBe(91);
    expect(point.doubles?.[4]).toBe(1);
    // No token report and no price on a tool row: those belong to a model call,
    // and a plausible-looking zero here would pool into a spend aggregate.
    expect(point.doubles?.slice(5)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
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
    expect(point.doubles).toEqual([1, 240_128, 87, 1]);
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
    // Accepted rows carry '' and rejections never do, so `rejectReason != ''` is
    // exactly the rejection set without enumerating the arms.
    expect(plane.feedback.points.every((p) => p.blobs?.[2] !== '')).toBe(true);
  });

  test('a size is not reported for an absent screenshot', () => {
    const plane = fakeEnv();
    writeFeedbackMarker(plane.env, {
      feedbackId: 'fb_02', outcome: 'accepted', rejectReason: '', routeFamily: 'home',
      hasScreenshot: false, screenshotBytes: 999, noteLength: 3, annotated: false,
    });
    expect(onlyPoint(plane.feedback).doubles?.[1]).toBe(0);
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
  test('the four primitives implement the platform\'s own translation table', () => {
    expect(weightedCount()).toBe('SUM(_sample_interval)');
    expect(weightedSum(AGENT_METRICS_SCHEMA, 'input'))
      .toBe('SUM(_sample_interval * double6)');
    expect(weightedAvg(AGENT_METRICS_SCHEMA, 'durationMs'))
      .toBe('SUM(_sample_interval * double2) / SUM(_sample_interval)');
    expect(weightedQuantile(AGENT_METRICS_SCHEMA, 'ttftMs', 0.95))
      .toBe('quantileExactWeighted(0.95)(double3, _sample_interval)');
  });

  test('a ratio divides by a measured denominator, not by the row count', () => {
    expect(weightedRatio(AGENT_METRICS_SCHEMA, 'usd', 'priced'))
      .toBe('SUM(_sample_interval * double12) / SUM(_sample_interval * double13)');
  });

  test('a quantile outside (0,1) is refused rather than emitted as SQL', () => {
    expect(() => weightedQuantile(AGENT_METRICS_SCHEMA, 'ttftMs', 0)).toThrow(/strictly between/);
    expect(() => weightedQuantile(AGENT_METRICS_SCHEMA, 'ttftMs', 1)).toThrow(/strictly between/);
    expect(() => weightedQuantile(AGENT_METRICS_SCHEMA, 'ttftMs', 95)).toThrow(/strictly between/);
  });

  test('a built query names the dataset, bounds the window, and aliases by slot name', () => {
    const sql = buildWeightedQuery({
      schema: AGENT_METRICS_SCHEMA,
      groupBy: ['model'],
      metrics: [{ as: 'turns', expression: weightedCount() }],
      since: "'24' HOUR",
      orderBy: 'turns',
      limit: 20,
    });
    expect(sql).toContain('FROM kinu_agent_metrics');
    expect(sql).toContain('blob9 AS model');
    expect(sql).toContain("WHERE timestamp > NOW() - INTERVAL '24' HOUR");
    expect(sql).toContain('GROUP BY blob9');
    expect(sql).toContain('ORDER BY turns DESC');
    expect(sql).toContain('LIMIT 20');
  });

  test('no shipped query uses an unweighted aggregate', () => {
    const queries = Object.values(controlPlaneMetricsQueries({ sinceHours: 24 }));
    for (const sql of queries) {
      // The bare forms an unsampled dataset would allow. `SUM(` is legal only in
      // the weighted shape, which always multiplies by the sample interval.
      expect(sql).not.toMatch(/\bCOUNT\s*\(/);
      expect(sql).not.toMatch(/\bAVG\s*\(/);
      expect(sql).not.toMatch(/SUM\((?!_sample_interval)/);
      expect(sql).not.toMatch(/quantileExactWeighted\([^)]*\)\((?![^)]*_sample_interval)/);
      // An unbounded scan over three months reaches AE's 30-second timeout.
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
    const queries = controlPlaneMetricsQueries({ sinceHours: 6, workspaceDigest: digest });
    expect(queries.turns).toContain(`index1 = '${digest}'`);
    expect(queries.latency).toContain(`index1 = '${digest}'`);
    expect(queries.tokens).toContain(`index1 = '${digest}'`);
    // A different dataset with a different index: the same string would match
    // nothing, and a silently empty audit panel is worse than an unfiltered one.
    expect(queries.adminOps).not.toContain(digest);
  });

  test('the lookback is a whole positive number of hours whatever the caller passes', () => {
    expect(controlPlaneMetricsQueries({ sinceHours: 0 }).turns).toContain("INTERVAL '1' HOUR");
    expect(controlPlaneMetricsQueries({ sinceHours: -5 }).turns).toContain("INTERVAL '1' HOUR");
    expect(controlPlaneMetricsQueries({ sinceHours: 24.9 }).turns).toContain("INTERVAL '24' HOUR");
  });

  test('nothing in the query builders reads an environment or a binding', () => {
    // Purity is the control plane's requirement: it owns the not-configured arm
    // and must be able to render it with no secret and no binding present.
    expect(() => controlPlaneMetricsQueries({ sinceHours: 1 })).not.toThrow();
  });
});

describe('the composite sink adds a destination instead of replacing one', () => {
  test('both members receive the line, in order', () => {
    const plane = fakeEnv();
    const console_ = createRecordingLogger();
    const composite = createCompositeLogger([console_, createAnalyticsLogger(plane.env, () => 'ws')]);
    composite.event('turn.settled', { provider: 'workers-ai' });
    expect(console_.emitted).toHaveLength(1);
    expect(plane.agent.points).toHaveLength(1);
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
    // The members either side of the broken one still got the line: a failure in
    // one destination must not cost the others their copy.
    expect(reached.emitted).toHaveLength(1);
    expect(after.emitted).toHaveLength(1);
  });
});
