/**
 * The tracer on a real run of `OrchestratorAgent._kinuTimerTick`: the span tree's structure and attributes.
 * Only `tracing.enterSpan` is substituted (`tests/helpers/agents-sdk.ts`; `cloudflare:workers` is workerd-only).
 * That spans are actually recorded is proven under real workerd by `scripts/tracing-gate.ts`, not here.
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

/** In `_kinuTimerTick` order, so a phase dropped from the method fails rather than shrinking the tree. */
const PHASES = [
  'alarm.due_triggers',
  'alarm.event_drain',
  'alarm.peer_dispatch',
  'alarm.email_reconcile',
  'alarm.cache_warm',
  'alarm.sleep_time',
  'alarm.timer_rearm',
] as const;

describe('alarm tick tracing', () => {
  test('one real tick produces a rooted span tree with every phase under it', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();

    await agent._kinuTimerTick();

    const spans = recordedNativeSpans();
    // First: an empty array is instrumentation never reached, over which every shape check passes vacuously.
    expect(spans.length).toBeGreaterThan(0);

    const roots = spans.filter((span) => span.parent === null);
    expect(roots.map((span) => span.name)).toEqual(['alarm.tick']);

    const rootIndex = spans.findIndex((span) => span.parent === null);
    const children = spans.filter((span) => span.parent === rootIndex);
    // Reordering changes what the durable timer chain does, not just the trace.
    expect(children.map((span) => span.name)).toEqual([...PHASES]);

    // Siblings, not a chain: distinguishes which phase was slow.
    expect(spans.filter((span) => span.parent !== null && span.parent !== rootIndex)).toEqual([]);
  });

  test('every span carries the two attributes that identify which fork produced it', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();
    await agent._kinuTimerTick();
    const spans = recordedNativeSpans();
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      expect(span.attributes.get(SPAN_ATTR_ISOLATE_GEN)).toBe(1);
      // `<className>:<name>`, never `root`: the SDK getter always includes self. Derived from the harness
      // agent: the invariant is the shape, not the value.
      expect(span.attributes.get(SPAN_ATTR_SELF_PATH)).toBe(`HarnessOrchestratorAgent:${agent.name}`);
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

    // Trace context does not survive a wake: two ticks are two invocation ordinals on one `isolateGen`,
    // and no span outlives its callback.
    const ordinals = new Set(spans.map((span) => span.attributes.get(SPAN_ATTR_INVOCATION)));
    expect([...ordinals].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2]);
    const generations = new Set(spans.map((span) => span.attributes.get(SPAN_ATTR_ISOLATE_GEN)));
    expect([...generations]).toEqual([1]);
  });

  test('isolateGen is bumped once per construction, not once per tick', async () => {
    const first = orchestratorHarness();
    resetNativeSpans();
    await first.agent._kinuTimerTick();
    await first.agent._kinuTimerTick();
    const oneObject = new Set(recordedNativeSpans().map((s) => s.attributes.get(SPAN_ATTR_ISOLATE_GEN)));
    // A per-tick bump would make a discontinuity meaningless as a reset signal.
    expect([...oneObject]).toEqual([1]);
  });

  test('the rendered tree is what a reader gets', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();
    await agent._kinuTimerTick();
    // Pinned in full: a change to the tree is a change to what an operator sees.
    expect(renderNativeSpanTree()).toBe(
      [
        'alarm.tick  [isolate_gen=1 invocation=1]',
        '  alarm.due_triggers  [isolate_gen=1 invocation=1 triggers_fired=0]',
        '  alarm.event_drain  [isolate_gen=1 invocation=1 drain_due=false]',
        '  alarm.peer_dispatch  [isolate_gen=1 invocation=1]',
        '  alarm.email_reconcile  [isolate_gen=1 invocation=1]',
        '  alarm.cache_warm  [isolate_gen=1 invocation=1 cache_warmed=false]',
        '  alarm.sleep_time  [isolate_gen=1 invocation=1 sleep_time_ran=false]',
        '  alarm.timer_rearm  [isolate_gen=1 invocation=1 rearmed=false]',
      ].join('\n'),
    );
  });
});

/**
 * The seam's contract: a span cannot be opened from work that escaped its invocation. The failure is
 * otherwise silent, since such a span looks plausible.
 */
interface HandleSeat {
  handle: TracedInvocation | null;
}

describe('invocation handles are revoked, not merely discouraged', () => {
  const tracing = (): AgentTracing => createAgentTracing({
    tracer: createRecordingTracer(),
    isolateGen: 7,
    selfPath: [{ className: 'OrchestratorAgent', name: 'acme' }],
  });

  /** A property, not a `let`: narrowing collapses a `let` assigned only inside a callback to `null`. */
  const seatFor = (): HandleSeat => ({ handle: null });

  test('a handle stashed out of its invocation refuses to open a span', async () => {
    const seat = seatFor();
    await tracing().invocation('alarm', 'tick', (tick) => {
      seat.handle = tick;
      tick.span('alarm.phase', () => undefined);

      return Promise.resolve();
    });

    expect(seat.handle).not.toBeNull();
    // The alarm-resumed-turn shape: a span opened here would cover an unmeasured gap across a possible isolate reset.
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
    // Revocation is settle-aware, not on the callback returning its pending promise.
    expect(names).toEqual(['after_await', 'second_await']);
  });

  test('the refusal is classified, reason first', () => {
    const seat = seatFor();
    tracing().invocation('rpc', 'call', (call) => { seat.handle = call; });
    let refusal: KinuError | null = null;

    try {
      seat.handle?.span('rpc.late', () => undefined);
    } catch (thrown) {
      // Narrowed, not cast: the classification is what is tested.
      if (thrown instanceof KinuError) refusal = thrown;
      else throw thrown;
    }

    // `unsupported`: opening a span from escaped work is a programming error, not retryable.
    expect(refusal).toBeInstanceOf(KinuError);
    expect(refusal?.code).toBe('unsupported');
  });

  test('a throwing invocation still revokes its handle', () => {
    const seat = seatFor();
    expect(() => tracing().invocation('fetch', 'turn', (turn) => {
      seat.handle = turn;
      throw new Error('phase exploded');
    })).toThrow('phase exploded');
    // The `finally` revokes a handle left live by a throwing invocation.
    expect(() => seat.handle?.span('fetch.late', () => undefined)).toThrow(KinuError);
  });
});

/**
 * The failure contract on the shipped tracer (from `~/cloudflare-os/packages/backend-utils/src/tracing.ts`):
 * an exception is marked and propagates unchanged, and no error text reaches a trace attribute.
 */
describe('a span marks a failure and changes nothing about it', () => {
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
    // Opened once; empty `opened` is instrumentation never reached.
    expect(tracer.opened).toHaveLength(1);
    const span = tracer.opened[0];
    expect(span?.name).toBe('work');
    expect(span?.attributes.get(SPAN_ATTR_ISOLATE_GEN)).toBe(3);
    expect(span?.attributes.get('kinu.rows')).toBe(4);
    // A sibling next span is the only observable a scoped span has for "closed".
    expect(span?.attributes.has(SPAN_ATTR_ERROR)).toBe(false);
    tracer.span('after', { isolateGen: 3, selfPath: 'A:a' }, () => undefined);
    expect(tracer.opened[1]?.parent).toBeNull();
  });

  test('a synchronous throw is marked and propagates UNCHANGED', () => {
    const { tracer, attributes } = spanFor();
    const thrown = new KinuError('io', 'writing the ledger', { cause: new Error('disk full') });
    const caught: Error[] = [];

    try {
      tracer.span('write', { isolateGen: 1, selfPath: 'A:a' }, () => { throw thrown; });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      caught.push(error);
    }

    // Identity, not shape: a wrapped error would destroy the classification and chain.
    expect(caught[0]).toBe(thrown);
    expect(caught[0]).toBeInstanceOf(KinuError);
    expect(renderCauseChain(thrown)).toBe('writing the ledger: disk full');
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });

  test('a rejection is marked and propagates UNCHANGED', async () => {
    const { tracer, attributes } = spanFor();
    const thrown = new KinuError('timeout', 'awaiting the node', { cause: new Error('600s idle') });
    const rejected: Error[] = [];

    try {
      await tracer.span(
        'shell',
        { isolateGen: 1, selfPath: 'A:a' },
        async () => { await Promise.resolve(); throw thrown; },
      );
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      rejected.push(cause);
    }

    expect(rejected[0]).toBe(thrown);
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });

  test('no error text reaches a trace attribute, on either path', async () => {
    const secret = 'sk-live-0000000000000000';
    const { tracer } = spanFor();
    const absorbed: Error[] = [];

    try {
      await tracer.span('thrown', { isolateGen: 1, selfPath: 'A:a' }, async () => {
        throw new Error(`upstream refused: ${secret}`);
      });
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      absorbed.push(cause);
    }

    expect(absorbed).toHaveLength(1);
    tracer.span('tolerated', { isolateGen: 1, selfPath: 'A:a' }, (span) => {
      span.fail(new Error(`upstream refused: ${secret}`));
    });
    expect(tracer.opened).toHaveLength(2);

    for (const span of tracer.opened) {
      // The whole surface, not a named key: the message under any other name is the same leak.
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

    // The phase tolerates its failure, so the span says failed while the caller sees success.
    expect(answer).toBe('continued');
    expect(attributes().get(SPAN_ATTR_ERROR)).toBe(true);
  });
});
