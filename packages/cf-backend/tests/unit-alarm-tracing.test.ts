/**
 * The tracer, wired, observed on a REAL run of a REAL production method.
 *
 * WHAT THIS PROVES, and what it deliberately does not.
 *
 * PROVEN HERE: `OrchestratorAgent._proteusTimerTick` — the shipped method, not a
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
  createAgentTracing, createRecordingTracer, ProteusError,
  SPAN_ATTR_INVOCATION, SPAN_ATTR_ISOLATE_GEN, SPAN_ATTR_SELF_PATH,
  type AgentTracing, type TracedInvocation,
} from '@proteus/core/obs';

/** The four phases, in the order `_proteusTimerTick` runs them. Named here so a
 *  phase silently dropped from the method fails rather than shrinking the tree. */
const PHASES = [
  'alarm.due_triggers',
  'alarm.peer_outbox',
  'alarm.email_outbox',
  'alarm.timer_rearm',
] as const;

describe('alarm tick tracing', () => {
  test('one real tick produces a rooted span tree with every phase under it', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();

    await agent._proteusTimerTick();

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
    await agent._proteusTimerTick();
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

    await agent._proteusTimerTick();
    await agent._proteusTimerTick();

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
    await first.agent._proteusTimerTick();
    await first.agent._proteusTimerTick();
    const oneObject = new Set(recordedNativeSpans().map((s) => s.attributes.get(SPAN_ATTR_ISOLATE_GEN)));
    // Two ticks, one construction, one generation. A per-tick bump would make a
    // discontinuity meaningless as a reset signal, which is the only thing the
    // attribute is for.
    expect([...oneObject]).toEqual([1]);
  });

  test('the rendered tree is what a reader gets', async () => {
    const { agent } = orchestratorHarness();
    resetNativeSpans();
    await agent._proteusTimerTick();
    // Pinned in full: the tree is the deliverable, so a change to it is a change
    // to what an operator sees and belongs in a diff.
    expect(renderNativeSpanTree()).toBe(
      [
        'alarm.tick  [isolate_gen=1 invocation=1]',
        '  alarm.due_triggers  [isolate_gen=1 invocation=1 triggers_fired=0]',
        '  alarm.peer_outbox  [isolate_gen=1 invocation=1]',
        '  alarm.email_outbox  [isolate_gen=1 invocation=1]',
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
    expect(() => seat.handle?.span('alarm.late', () => undefined)).toThrow(ProteusError);
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
    let refusal: ProteusError | null = null;
    try {
      seat.handle?.span('rpc.late', () => undefined);
    } catch (thrown) {
      // Narrowed, not asserted: the classification is the thing being tested, so a
      // cast would be asserting the answer.
      if (thrown instanceof ProteusError) refusal = thrown;
      else throw thrown;
    }
    // A refusal carries its classification, reason first: `unsupported`, because
    // opening a span from escaped work is not a runtime condition to retry — it is a
    // programming error, and a retry would produce the same lie.
    expect(refusal).toBeInstanceOf(ProteusError);
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
    expect(() => seat.handle?.span('fetch.late', () => undefined)).toThrow(ProteusError);
  });
});
