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
import {
  KinuError, RESERVED_LOG_FIELDS, createCompositeLogger, createRecordingLogger, diagnostics,
} from '@kinu.run/core/obs';
import type { SqlExec } from '@kinu.run/core';
import * as v from 'valibot';

import {
  MAX_WRITES_PER_INVOCATION, assertQuantileLevel, assertWithinPlatformLimits,
} from '../src/analytics/limits';
import {
  AGENT_METRICS_SCHEMA, ANALYTICS_SCHEMAS, CONTROL_PLANE_OPS_SCHEMA, FEEDBACK_MARKERS_SCHEMA,
  blobColumn, doubleColumn, indexColumn, type AnalyticsSchema,
} from '../src/analytics/schemas';
import { analyticsDigest, assertPublishableNames } from '../src/analytics/privacy';
import {
  analyticsPlane, openAnalyticsWindow,
  type AnalyticsEnv,
} from '../src/analytics/writer';
import {
  recordJobSettled, recordModelRow, recordReleaseTransition, recordToolRow,
  recordTtftRow, recordTurnRow,
} from '../src/analytics/record';
import { feedbackRouteFamily, writeFeedbackMarker } from '../src/analytics/feedback-marker';
import { installAnalyticsDiagnostics } from '../src/analytics/install';
import { controlPlaneMetricsQueries } from '../src/analytics/query';
import { reportAdminDenial, type AdminDenial } from '../src/control-plane/admin-caller';
import { cliScopesConnectionTag, rejectOutOfScopeRpc } from '../src/cli/rpc-gate';
import { requireTier, type OwnerCapabilityEnv } from '../src/user/workspace-capability';

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

/**
 * Install the real composite sink over this environment, and hand back its
 * restore.
 *
 * THE ONLY WAY IN, deliberately. The Analytics half of the composite is
 * module-private, so every projection assertion below reaches it the way
 * production does: install once at an isolate's entry, then emit through core's
 * `diagnostics` seam from anywhere inside it. Asserting a hand-built logger would
 * have proved the projection over a path no caller takes.
 *
 * The install announces itself THROUGH the sink it just installed, so one real
 * agent row exists before the test emits anything. It is asserted on its own
 * below and dropped here, so a test that expects one data point sees one.
 */
function installSink(plane: FakePlane): () => void {
  const restore = installAnalyticsDiagnostics(plane.env);
  plane.agent.points.length = 0;
  return restore;
}

/** Emit through the installed sink, and put the previous one back whatever
 *  happens: the sink is module-global, so a leak here is the next test's
 *  mystery. */
function throughSink(plane: FakePlane, emit: () => void): void {
  const restore = installSink(plane);
  try {
    emit();
  } finally {
    restore();
  }
}

describe('the slot layout is one declaration', () => {
  // THE PLATFORM'S NUMBERS ARE WRITTEN OUT here rather than derived from the
  // constants that hold them, and the constants are private for the same reason:
  // a refusal test whose INPUT and whose EXPECTATION both come from one constant
  // proves the guard is self-consistent and nothing about the platform. Twenty-one
  // blobs refused with "the platform's 20" in the message is the fact pinned from
  // both ends, and it reds if the number is ever quietly changed.

  interface SchemaCensus {
    dataset: string;
    blobBytes: readonly number[];
    doubles: number;
    indexes: readonly { name: string; maxBytes: number }[];
  }

  /** The census `defineSchema` hands `assertWithinPlatformLimits`, built the way
   *  it builds it — so refusing one of these is refusing that schema. Only the
   *  part each test is about is spelled; the rest is a legal minimum. */
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
    // `defineSchema` is module-private, so this is both halves at once: every
    // shipped dataset really is inside every limit, AND the guard the refusals
    // below exercise is the guard the declaration runs. A declaration that stopped
    // calling it would leave those refusals passing and nothing protected.
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
      // The slot name goes in through a `string`-typed binding, which is exactly
      // how a dynamically-assembled schema would reach the guard. The TYPE ban is
      // the stronger half and refuses the literal spelling —
      // `ReservedSlotIsNotWritable` is uninhabited — but a type is erased before
      // anything runs, so widening the name here is what reaches the arm that
      // still holds at runtime. No assertion is needed to do it.
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
    // The two APPENDED slots. Pinned here for the same reason as every slot
    // above: a slot that is appended and not pinned is the one a later append
    // can silently move past, and slot order IS the wire format.
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
    // Asserted at the SHIPPED capacity rather than a small injected one: the
    // window a caller can reach is the plane's, and the number that has to be
    // right is the platform's.
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
    // THE DEFECT THIS REPLACES. Three Durable Objects opened their window in the
    // CONSTRUCTOR — once per activation — so a hot object had 250 rows for its
    // whole life and then went silent, with the one `window_exhausted` event
    // refused by the same spent window that produced it.
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
    // Against the SCHEMA's own declared bound, which is what the writer clamps
    // to. That the bound is itself inside the platform's 96 is the guard's job,
    // asserted over every shipped schema above.
    expect(new TextEncoder().encode(String(point.indexes?.[0])).length)
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
    const restore = installSink(plane);
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
    diagnostics.event('provider.error', smuggled);
    restore();
    const serialized = JSON.stringify(onlyPoint(plane.agent));
    expect(serialized).not.toContain('sk-live-do-not-publish');
    expect(serialized).not.toContain('medical');
    expect(serialized).not.toContain('hunter2');
    // The allowlisted field DID arrive, so the row is not empty by accident.
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
    // The control plane published `reason: row.detail`, and on a thrown failure
    // that detail is a rendered chain: an allowlisted NAME carrying prose, which
    // the name allowlist cannot see. The 48-byte slot then kept the head of the
    // chain — the upstream message — for three months.
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
    // Dropped, not partially kept — and the row still says the action failed.
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
    // `code` is the other slot a caller can now fill by name, and its vocabulary
    // is closed by core rather than by a grammar — so membership is the check.
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
    // THE CO-LOCATION CASE. `setDiagnosticsSink` is module-global and Cloudflare
    // co-locates Durable Objects, so an isolate-level default belonged to
    // whichever actor installed first — and every line the actors beside it
    // emitted without a workspace was indexed as that first actor's, taking AE's
    // per-index sampling isolation with it. One installed sink taking three lines
    // from different actors IS that isolate: attribution has to come off the LINE,
    // because the sink is the thing they share.
    const plane = fakeEnv();
    const restore = installSink(plane);
    // And the second actor to reach the entry re-installs, which must not wrap the
    // composite in another composite — that is one row per event, not two, and it
    // is the reason `installAnalyticsDiagnostics` is idempotent per isolate.
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
    // Honestly absent, and specifically NOT the first actor's digest.
    expect(plane.agent.points[1].indexes?.[0]).toBe('');
    expect(plane.agent.points[2].indexes?.[0]).toBe(analyticsDigest('second-actor'));
  });

  test('automatic titling is attributed by workspace, and the title is not published', () => {
    // The titling telemetry named its identifying field `agent`, which is not an
    // allowlisted slot — so the headline naming feature's rows carried no
    // per-agent dimension at all while looking, at the call site, as though they
    // did. The title itself stays out: it is derived from the mission, which is
    // the person's own sentence.
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
  /** The async twin of `throughSink`. Drive the REAL emit site through the REAL
   *  sink: asserting the projection of a hand-written `.event(...)` would prove
   *  only that this test can spell the fields, and what went wrong was that three
   *  emit sites did not. */
  async function throughAsyncSink(plane: FakePlane, emit: () => Promise<void>): Promise<void> {
    const restore = installSink(plane);
    try {
      await emit();
    } finally {
      restore();
    }
  }

  test('an admin-plane denial lands as denied, with its reason and no request text', () => {
    // Every one of these read `outcome: 'ok'` with an empty reason: the denial
    // was reported under a field name the sink does not publish, so the audit
    // dataset counted operator probes as successful operations and the
    // stale-sign-in-versus-probe discriminator did not exist.
    const plane = fakeEnv();
    throughSink(plane, () => {
      reportAdminDenial('not_admin', '/api/control/users/help-me-with-my-divorce', 'GET');
    });
    const point = onlyPoint(plane.ops);
    expect(point.blobs?.[1]).toBe('denied');
    expect(point.blobs?.[2]).toBe('denied');
    expect(point.blobs?.[5]).toBe('not_admin');
    // The path can name a workspace, and a workspace name is the person's own
    // sentence. It reaches Workers Logs and stops there.
    expect(JSON.stringify(point)).not.toContain('divorce');
  });

  test('every admin denial reason reaches the slot as itself', () => {
    // The vocabulary is closed and small, so it is checked whole rather than
    // sampled: a value the grammar rejected would silently read as no reason.
    //
    // The `access_*` arms MATTER MOST HERE and are the reason this list is
    // exhaustive rather than representative. Every one of them answers an
    // indistinguishable 404 on the wire by design, so this row is the only place
    // "somebody probed the admin path", "requests are reaching the origin around
    // Access", "this deployment never configured Access" and "a token we reject"
    // are told apart. A value the classification grammar silently dropped would
    // collapse all four into an empty reason.
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
    // Both arms, because they are different operator problems: a token whose
    // scope set is wrong is a client we shipped, and a method no token can reach
    // is somebody probing the surface.
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
      await expect(requireTier(sql, env, {}, 'credentials.other')).rejects.toThrow();
    });
    const point = onlyPoint(plane.agent);
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'event')).toBe('capability.denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'outcome')).toBe('denied');
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'source')).toBe('workspace_capability');
    // The arm that decided it. `denied` alone pools `tier_too_low`, a policy
    // outcome, with `unrecognized_workspace`, a broken identity — and those two
    // ask an operator for opposite responses.
    expect(blobAt(point, AGENT_METRICS_SCHEMA, 'reason')).toBe('no_caller_identity');
    // The refusal MESSAGE names the workspace; the row never does.
    expect(JSON.stringify(point)).not.toContain('capability token');
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
      'subordinate', 'workers-ai', 'deepseek-v4', '', '', '',
    ]);
    // The trailing 0 is `attempts`: a turn is not a delivery and counts none,
    // and a plausible 1 there would read as a first attempt in every aggregate
    // over recovery.
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
    // Accepted rows carry '' and rejections never do, so `rejectReason != ''` is
    // exactly the rejection set without enumerating the arms.
    expect(plane.feedback.points.every((p) => p.blobs?.[2] !== '')).toBe(true);
  });

  test('a screenshot-bearing refusal reports the screenshot it carried', () => {
    // THE UNDER-COUNT. The refusal arms that fire before the bytes are measured
    // used to write "no screenshot, zero bytes" for submissions that plainly sent
    // one, so the screenshot columns described every population except the one
    // they exist for. Presence and size are now two slots and neither rewrites
    // the other.
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
    // The two are the same 0 bytes; only the presence slot tells them apart, and
    // "how many reports carry a screenshot" is the question that needs it.
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
  // The expression builders are module-private, so a panel's SQL is where their
  // output is observable — and it is the only form a reader of these tests cares
  // about, because it is what Analytics Engine is actually sent.

  test('the four primitives implement the platform\'s own translation table', () => {
    // Read off the panels that select each one, aliased, so the assertion pins
    // both the expression and the column it is reported under.
    const { turns, tokens, firstToken } =
      controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' });
    // A weighted count: the sample interval IS the count, one surviving row
    // standing for `_sample_interval` originals.
    expect(turns).toContain('SUM(_sample_interval) AS turns');
    expect(tokens).toContain('SUM(_sample_interval * double6) AS inputTokens');
    expect(turns)
      .toContain('SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgDurationMs');
    expect(firstToken)
      .toContain('quantileExactWeighted(0.95)(double3, _sample_interval) AS p95TtftMs');
  });

  test('a ratio divides by a measured denominator, not by the row count', () => {
    // `usd` is 0 for an unpriced call as well as a free one, so the denominator
    // has to be the calls that carried a rate — `priced`, not the row count.
    const { tokens } = controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' });
    expect(tokens).toContain(
      'SUM(_sample_interval * double12) / SUM(_sample_interval * double13) AS usdPerPricedCall',
    );
  });

  test('a quantile outside (0,1) is refused rather than emitted as SQL', () => {
    // The mistake is a percentage where a fraction belongs, and AE answers it
    // with a column of nulls rather than an error — so a p95 panel would read
    // empty and look correct.
    expect(() => assertQuantileLevel(0)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(1)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(95)).toThrow(/strictly between/);
    expect(() => assertQuantileLevel(0.95)).not.toThrow();
  });

  test('a built query names the dataset, bounds the window, and aliases by slot name', () => {
    const sql = controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' }).latency;
    expect(sql).toContain('FROM kinu_agent_metrics');
    expect(sql).toContain('blob9 AS model');
    expect(sql).toContain("WHERE timestamp > NOW() - INTERVAL '24' HOUR");
    expect(sql).toContain('GROUP BY blob9');
    expect(sql).toContain('ORDER BY turns DESC');
    expect(sql).toContain('LIMIT 50');
  });

  test('a panel whose group-by has open cardinality carries a row bound', () => {
    // `model` is a 128-byte slot holding whatever a provider or a user's config
    // names, and `tool` is the name of the tool the model called, crafted tools
    // included — one row per distinct value, and nothing caps the count. The
    // surface renders every row it is handed with no cursor, so the bound is the
    // panel's own top-N, and each of these already orders by volume descending.
    const built = controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' });
    for (const name of ['latency', 'tokens', 'toolFailures', 'firstToken'] as const) {
      expect(built[name]).toContain('LIMIT 50');
      expect(built[name]).toMatch(/ORDER BY \w+ DESC/u);
    }
    // And a closed vocabulary takes none: `outcome` and `code` are a four-member
    // union and core's own error codes, and `operation` is the tail of a declared
    // `control_plane.*` event. A bound there could only hide a row.
    for (const name of ['turns', 'adminOps'] as const) {
      expect(built[name]).not.toContain('LIMIT');
    }
  });

  test('a suffixed deployment reads only its own datasets', () => {
    // Staging binds `*_staging` and shares production's account, so a reader that
    // named the unsuffixed dataset would answer a staging panel with production's
    // rows — a wrong number under the right heading.
    const queries = controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '_staging' });
    // Every FROM in every panel, extracted rather than spot-checked: the defect
    // shape is one builder out of six keeping the old name.
    const named = Object.values(queries).flatMap((sql) => [...sql.matchAll(/FROM (\S+)/gu)]
      .map((match) => match[1]));
    expect(named).toHaveLength(6);
    expect(named.every((dataset) => dataset.endsWith('_staging'))).toBe(true);
    expect(new Set(named)).toEqual(new Set([
      'kinu_agent_metrics_staging', 'kinu_control_plane_ops_staging',
    ]));
  });

  test('a suffix that is not a dataset suffix is refused rather than interpolated', () => {
    // The suffix reaches SQL as text. Falling back to '' would be the defect
    // itself: a misconfigured staging silently reading production.
    expect(() => controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: "'; DROP" }))
      .toThrow(RangeError);
  });

  test('no shipped query uses an unweighted aggregate', () => {
    const queries = Object.values(controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' }));
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
    const queries = controlPlaneMetricsQueries({ sinceHours: 24, datasetSuffix: '' });
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
      sinceHours: 6, datasetSuffix: '', workspaceDigest: digest,
    });
    expect(queries.turns).toContain(`index1 = '${digest}'`);
    expect(queries.latency).toContain(`index1 = '${digest}'`);
    expect(queries.tokens).toContain(`index1 = '${digest}'`);
    // A different dataset with a different index: the same string would match
    // nothing, and a silently empty audit panel is worse than an unfiltered one.
    expect(queries.adminOps).not.toContain(digest);
  });

  test('the lookback is a whole positive number of hours whatever the caller passes', () => {
    const hours = (sinceHours: number): string =>
      controlPlaneMetricsQueries({ sinceHours, datasetSuffix: '' }).turns;
    expect(hours(0)).toContain("INTERVAL '1' HOUR");
    expect(hours(-5)).toContain("INTERVAL '1' HOUR");
    expect(hours(24.9)).toContain("INTERVAL '24' HOUR");
  });

  test('nothing in the query builders reads an environment or a binding', () => {
    // Purity is the control plane's requirement: it owns the not-configured arm
    // and must be able to render it with no secret and no binding present.
    expect(() => controlPlaneMetricsQueries({ sinceHours: 1, datasetSuffix: '' })).not.toThrow();
  });
});

describe('the composite sink adds a destination instead of replacing one', () => {
  test('installing puts the analytics half in the composite, not in place of it', () => {
    const plane = fakeEnv();
    const restore = installAnalyticsDiagnostics(plane.env);
    try {
      // The install announces itself THROUGH the sink it just installed, so this
      // row existing is the analytics half being inside the composite rather than
      // instead of it. Every other test here consumes this row; this is where it
      // is asserted.
      expect(plane.agent.points).toHaveLength(1);
      expect(blobAt(plane.agent.points[0], AGENT_METRICS_SCHEMA, 'event'))
        .toBe('analytics.sink_installed');
      diagnostics.event('turn.settled', { provider: 'workers-ai' });
      expect(plane.agent.points).toHaveLength(2);
      expect(blobAt(plane.agent.points[1], AGENT_METRICS_SCHEMA, 'provider')).toBe('workers-ai');
    } finally {
      restore();
    }
    // And the restore really restores: a line after it reaches whatever sink was
    // there before, not this plane. The sink is module-global, so a restore that
    // did nothing would make every later test's row count somebody else's.
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
    // The members either side of the broken one still got the line: a failure in
    // one destination must not cost the others their copy.
    expect(reached.emitted).toHaveLength(1);
    expect(after.emitted).toHaveLength(1);
  });
});
