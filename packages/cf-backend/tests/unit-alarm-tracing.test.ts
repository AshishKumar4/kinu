/**
 * The tracer, wired, observed on a REAL run of a REAL production method.
 *
 * WHAT THIS PROVES, and what it deliberately does not.
 *
 * PROVEN HERE: `OrchestratorAgent._kinuTimerTick` — the shipped method, not a
 * copy of its shape — opens a span tree when it runs, and the tree has the
 * structure and the attributes the contract requires. Every layer above the
 * platform is production code: `createWorkersTracer`, `createAgentTracing`,
 * `AgentConfigStore.countIsolateGeneration`, `renderSelfPath`, and the four
 * `tick.span` call sites. The ONLY substitution is `tracing.enterSpan` itself
 * (`tests/helpers/agents-sdk.ts`), which cannot exist under bun because
 * `cloudflare:workers` is a workerd module — and that is the platform boundary,
 * so a substitution there is the most faithful one available. A test that
 * injected our own `Tracer` would be asserting about the injected object.
 *
 * PROVEN ELSEWHERE, and NOT re-asserted here because this runner cannot see it:
 * that a span the shipped tracer opens is actually RECORDED. `isTraced` is false
 * with no collector attached, so recording is a runtime-plus-config fact, and
 * `scripts/tracing-gate.ts` measures it under real workerd in both directions —
 * `isTraced` true with a tail consumer and false without, the negative run being
 * the non-vacuity witness. The two halves are complementary and neither is
 * sufficient: this file proves the tree exists and is shaped right, that gate
 * proves a tree of that shape reaches a collector.
 */
import { describe, expect, test } from 'bun:test';
import {
  recordedNativeSpans, renderNativeSpanTree, resetNativeSpans,
} from './helpers/agents-sdk';
import { orchestratorHarness } from './helpers/actor-harness';

import {
  createAgentTracing, createRecordingTracer, KinuError, renderCauseChain,
  SPAN_ATTR_ERROR, SPAN_ATTR_INVOCATION, SPAN_ATTR_ISOLATE_GEN, SPAN_ATTR_SELF_PATH,
  type AgentTracing, type RecordingTracer, type SpanAttributeValue, type TracedInvocation,
} from '@kinu.run/core/obs';

/** The four phases, in the order `_kinuTimerTick` runs them. Named here so a
 *  phase silently dropped from the method fails rather than shrinking the tree. */
const PHASES = [
  'alarm.due_triggers',
  'alarm.peer_dispatch',
  'alarm.email_reconcile',
  'alarm.timer_rearm',
] as const;

describe('alarm tick tracing', () => {
  test('one real tick produces a rooted span tree with every phase under it', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();

    await agent._kinuTimerTick();

    const spans = recordedNativeSpans();
    // FIRST assertion, before any shape check: an empty array is the shape of
    // instrumentation that was never reached, and every structural assertion below
    // it would pass vacuously over it.
    expect(spans.length).toBeGreaterThan(0);

    const roots = spans.filter((span) => span.parent === null);
    expect(roots.map((span) => span.name)).toEqual(['alarm.tick']);

    const rootIndex = spans.findIndex((span) => span.parent === null);
    const children = spans.filter((span) => span.parent === rootIndex);
    // Order matters: the phases are sequential and a reordering changes what the
    // durable timer chain does, not just what the trace looks like.
    expect(children.map((span) => span.name)).toEqual([...PHASES]);

    // No phase nested inside another. Four siblings, not a chain — which is the
    // difference between "the alarm was slow" and "the email reconcile was slow",
    // and is exactly what a flat list of span names cannot distinguish.
    expect(spans.filter((span) => span.parent !== null && span.parent !== rootIndex)).toEqual([]);
  });

  test('every span carries the two attributes that identify which fork produced it', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();
    await agent._kinuTimerTick();
    const spans = recordedNativeSpans();
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      // Required by `SpanOpenAttributes`, and unforgeable at the call site: the
      // seam supplies both, so no span can be opened without them.
      expect(span.attributes.get(SPAN_ATTR_ISOLATE_GEN)).toBe(1);
      // `<className>:<name>`, never `root`: the SDK's getter is
      // `[...parentPath, { className, name }]`, so self is always present and the
      // empty-path branch of `renderSelfPath` is unreachable on a live agent. The
      // class half is what a Durable Object id cannot tell you, and the name half
      // is what the deployed tail stream has no field for at all.
      expect(span.attributes.get(SPAN_ATTR_SELF_PATH)).toBe('HarnessOrchestratorAgent:harness-actor');
      expect(span.attributes.get(SPAN_ATTR_INVOCATION)).toBe(1);
    }
  });

  test('a second tick is a SEPARATE invocation, and says so', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();

    await agent._kinuTimerTick();
    await agent._kinuTimerTick();

    const spans = recordedNativeSpans();
    expect(spans.filter((span) => span.parent === null)).toHaveLength(2);

    // THE CONTRACT: trace context does not survive a wake. Two ticks are two
    // invocation ordinals on one `isolateGen`, so a reader can tell "one isolate
    // served two wakes" from "the object was reconstructed" — and no span spans
    // both, because there is no span object that outlives its callback.
    const ordinals = new Set(spans.map((span) => span.attributes.get(SPAN_ATTR_INVOCATION)));
    expect([...ordinals].sort()).toEqual([1, 2]);
    const generations = new Set(spans.map((span) => span.attributes.get(SPAN_ATTR_ISOLATE_GEN)));
    expect([...generations]).toEqual([1]);
  });

  test('isolateGen is bumped once per construction, not once per tick', async () => {
    const first = orchestratorHarness();
    resetNativeSpans();
    await first.agent._kinuTimerTick();
    await first.agent._kinuTimerTick();
    const oneObject = new Set(recordedNativeSpans().map((s) => s.attributes.get(SPAN_ATTR_ISOLATE_GEN)));
    // Two ticks, one construction, one generation. A per-tick bump would make a
    // discontinuity meaningless as a reset signal, which is the only thing the
    // attribute is for.
    expect([...oneObject]).toEqual([1]);
  });

  test('the rendered tree is what a reader gets', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();
    await agent._kinuTimerTick();
    // Pinned in full: the tree is the deliverable, so a change to it is a change
    // to what an operator sees and belongs in a diff.
    expect(renderNativeSpanTree()).toBe(
      [
        'alarm.tick  [isolate_gen=1 invocation=1]',
        '  alarm.due_triggers  [isolate_gen=1 invocation=1 triggers_fired=0]',
        '  alarm.peer_dispatch  [isolate_gen=1 invocation=1]',
        '  alarm.email_reconcile  [isolate_gen=1 invocation=1]',
        '  alarm.timer_rearm  [isolate_gen=1 invocation=1 rearmed=false]',
      ].join('\n'),
    );
  });
});

/**
 * The seam's own contract, tested directly because it is the mechanism the whole
 * design rests on: a span cannot be opened from work that escaped its invocation.
 * Documenting that would not be enough — the failure is silent, since the span
 * exists, carries plausible attributes and closes cleanly.
 */
/** Where a test parks the handle a callback captured, so the assertion after the
 *  invocation can still reach it. */
interface HandleSeat {
  handle: TracedInvocation | null;
}

describe('invocation handles are revoked, not merely discouraged', () => {
  const tracing = (): AgentTracing => createAgentTracing({
    tracer: createRecordingTracer(),
    isolateGen: 7,
    selfPath: [{ className: 'OrchestratorAgent', name: 'acme' }],
  });

  /** A property rather than a bare `let`: control-flow narrowing collapses a `let`
   *  assigned only inside a callback to `null`, and the handle that outlived its
   *  invocation is the whole subject here. */
  const seatFor = (): HandleSeat => ({ handle: null });

  test('a handle stashed out of its invocation refuses to open a span', async () => {
    const seat = seatFor();
    await tracing().invocation('alarm', 'tick', (tick) => {
      seat.handle = tick;
      // Live INSIDE the callback, which is what makes the assertion below about
      // revocation rather than about a broken handle.
      tick.span('alarm.phase', () => undefined);
      return Promise.resolve();
    });

    expect(seat.handle).not.toBeNull();
    // THE PROPERTY: this is the alarm-resumed-turn shape in code. The handle was
    // captured during invocation 1 and used after it settled; a span opened here
    // would claim coverage of an unbounded, unmeasured gap in which the isolate may
    // have been reset.
    expect(() => seat.handle?.span('alarm.late', () => undefined)).toThrow(KinuError);
    expect(() => seat.handle?.span('alarm.late', () => undefined)).toThrow(/escaped its invocation/);
  });

  test('revocation waits for an async body to SETTLE, so a phase after an await still works', async () => {
    const names: string[] = [];
    await tracing().invocation('fetch', 'turn', async (turn) => {
      await Promise.resolve();
      turn.span('turn.after_await', () => { names.push('after_await'); });
      await Promise.resolve();
      turn.span('turn.second_await', () => { names.push('second_await'); });
    });
    // A handle revoked when the callback RETURNED its pending promise would have
    // thrown on both of these, which is the bug the settle-aware revocation avoids.
    expect(names).toEqual(['after_await', 'second_await']);
  });

  test('the refusal is classified, reason first', () => {
    const seat = seatFor();
    tracing().invocation('rpc', 'call', (call) => { seat.handle = call; });
    let refusal: KinuError | null = null;
    try {
      seat.handle?.span('rpc.late', () => undefined);
    } catch (thrown) {
      // Narrowed, not asserted: the classification is the thing being tested, so a
      // cast would be asserting the answer.
      if (thrown instanceof KinuError) refusal = thrown;
      else throw thrown;
    }
    // A refusal carries its classification, reason first: `unsupported`, because
    // opening a span from escaped work is not a runtime condition to retry — it is a
    // programming error, and a retry would produce the same lie.
    expect(refusal).toBeInstanceOf(KinuError);
    expect(refusal?.code).toBe('unsupported');
  });

  test('a throwing invocation still revokes its handle', () => {
    const seat = seatFor();
    expect(() => tracing().invocation('fetch', 'turn', (turn) => {
      seat.handle = turn;
      throw new Error('phase exploded');
    })).toThrow('phase exploded');
    // The `finally` is what makes this hold: a handle left live by a throwing
    // invocation is exactly the one a `.catch()` continuation would reach for.
    expect(() => seat.handle?.span('fetch.late', () => undefined)).toThrow(KinuError);
  });
});

/**
 * The failure contract, both directions, on the SHIPPED tracer.
 *
 * Adopted from `~/cloudflare-os/packages/backend-utils/src/tracing.ts`: an
 * exception is MARKED and propagates UNCHANGED, and no error TEXT reaches a trace
 * attribute. Both halves are asserted, because the second is the one a future
 * "make the trace more useful" change breaks: `kinu.error_message` was on this
 * span until 2026-08-19, which put an upstream error's message — possibly a
 * secret, certainly unbounded — on a stream `ReservedLogField` cannot reach, and
 * marked ONLY the non-throwing `fail()` path, so a THROWN failure was not marked
 * at all.
 */
describe('a span marks a failure and changes nothing about it', () => {
  /** The tracer plus the first span's attributes, which is what every assertion
   *  below reads. Inferred, so the fake's own surface is the contract. */
  const spanFor = () => {
    const tracer: RecordingTracer = createRecordingTracer();
    const empty: ReadonlyMap<string, SpanAttributeValue> = new Map();
    return { tracer, attributes: () => tracer.opened[0]?.attributes ?? empty };
  };

  test('a span opens and closes around real async work', async () => {
    const { tracer } = spanFor();
    const order: string[] = [];
    const answer = await tracer.span('work', { isolateGen: 3, selfPath: 'A:a' }, async (span) => {
      order.push('inside');
      await Promise.resolve();
      span.setAttribute('kinu.rows', 4);
      order.push('after_await');
      return 'done';
    });
    expect(answer).toBe('done');
    expect(order).toEqual(['inside', 'after_await']);
    // Opened, and opened ONCE. An empty `opened` is the shape of instrumentation
    // that was never reached, which is the defect a tracing test exists to catch.
    expect(tracer.opened).toHaveLength(1);
    const span = tracer.opened[0];
    expect(span?.name).toBe('work');
    expect(span?.attributes.get(SPAN_ATTR_ISOLATE_GEN)).toBe(3);
    expect(span?.attributes.get('kinu.rows')).toBe(4);
    // Closed: no `kinu.error`, and the next span opened is a SIBLING rather
    // than a child, which is the only observable a scoped span has for "closed".
    expect(span?.attributes.has(SPAN_ATTR_ERROR)).toBe(false);
    tracer.span('after', { isolateGen: 3, selfPath: 'A:a' }, () => undefined);
    expect(tracer.opened[1]?.parent).toBeNull();
  });

  test('a synchronous throw is marked and propagates UNCHANGED', () => {
    const { tracer, attributes } = spanFor();
    const thrown = new KinuError('io', 'writing the ledger', { cause: new Error('disk full') });
    // Collected rather than parked in a `let`: the identity of what came out is the
    // assertion, so nothing here may narrow or default it.
    const caught: Error[] = [];
    try {
      tracer.span('write', { isolateGen: 1, selfPath: 'A:a' }, () => { throw thrown; });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      caught.push(error);
    }
    // IDENTITY, not shape: a wrapped error would satisfy `toThrow(...)` while
    // having destroyed the classification and the chain the caller has to read.
    expect(caught[0]).toBe(thrown);
    expect(caught[0]).toBeInstanceOf(KinuError);
    expect(renderCauseChain(thrown)).toBe('writing the ledger: disk full');
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });

  test('a rejection is marked and propagates UNCHANGED', async () => {
    const { tracer, attributes } = spanFor();
    const thrown = new KinuError('timeout', 'awaiting the node', { cause: new Error('600s idle') });
    const rejected: Error[] = [];
    await tracer
      .span('run', { isolateGen: 1, selfPath: 'A:a' }, async () => { await Promise.resolve(); throw thrown; })
      .catch((error) => {
        if (!(error instanceof Error)) throw error;
        rejected.push(error);
      });
    expect(rejected[0]).toBe(thrown);
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });

  test('no error text reaches a trace attribute, on either path', async () => {
    const secret = 'sk-live-0000000000000000';
    const { tracer } = spanFor();
    const absorbed: Error[] = [];
    await tracer
      .span('thrown', { isolateGen: 1, selfPath: 'A:a' }, async () => {
        throw new Error(`upstream refused: ${secret}`);
      })
      .catch((error) => {
        if (!(error instanceof Error)) throw error;
        absorbed.push(error);
      });
    expect(absorbed).toHaveLength(1);
    tracer.span('tolerated', { isolateGen: 1, selfPath: 'A:a' }, (span) => {
      span.fail(new Error(`upstream refused: ${secret}`));
    });
    expect(tracer.opened).toHaveLength(2);
    for (const span of tracer.opened) {
      // The whole recorded surface, not a named key: a future attribute carrying
      // the message under any other name is the same leak.
      expect([...span.attributes.values()].join(' ')).not.toContain(secret);
      expect(span.attributes.get(SPAN_ATTR_ERROR)).toBe(true);
    }
  });

  test('a tolerated failure marks the span without throwing', () => {
    const { tracer, attributes } = spanFor();
    const answer = tracer.span('phase', { isolateGen: 1, selfPath: 'A:a' }, (span) => {
      span.fail(new Error('the reconcile is degraded but the tick continues'));
      return 'continued';
    });
    // The alarm tick's shape: the phase tolerates its failure and the invocation
    // proceeds, so the span must say it failed while the caller sees success.
    expect(answer).toBe('continued');
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });
});
