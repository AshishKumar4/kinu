/**
 * The agent's tracing seam: the only way a Kinu agent opens a span.
 *
 * SHARED, not cf-only, and the split is the answer to "is tracing hosted-only".
 * This file takes a `Tracer`, an `isolateGen` and a `selfPath` and owns the
 * SCOPING RULES; it imports no platform. What is hosted-only is the two things it
 * is handed: `createWorkersTracer` (cf-backend/src/obs/cf-tracer.ts, which imports
 * `cloudflare:workers`) and the pair of values, since `selfPath` comes from the
 * agents SDK and `isolateGen` from a Durable Object's persisted config. A CLI
 * backend that acquires a `Tracer` gets the scoping rules for free rather than a
 * second implementation of them — which is what `gate:capability-parity` is for.
 *
 * `Tracer` (core/src/obs/tracer.ts) takes `SpanOpenAttributes` — `isolateGen` and
 * `selfPath` — on every call, and REQUIRES them because no lint or dead-code gate
 * can see a missing attribute on a span. That leaves one thing the type cannot
 * do: make the two values CORRECT. A call site that computes `selfPath` itself,
 * or reads a boot-time counter for `isolateGen`, produces a span that is
 * well-typed, recorded, and mislabelled. So the values are computed here, once,
 * and no call site is given the chance.
 *
 * ## The property this file exists for
 *
 * TRACE CONTEXT DOES NOT SURVIVE `alarm()`, A HIBERNATION WAKE, OR A COLD START.
 * A turn that begins in a `fetch` and finishes after an alarm is TWO invocations
 * of the same object, and a span presented as covering both is lying about what
 * was measured — the gap between them is unbounded and unmeasured, and the isolate
 * in between may have been reset.
 *
 * Documenting that is not enough, because the failure is silent: the span exists,
 * carries plausible attributes and closes cleanly. Three mechanisms make it
 * unreachable instead:
 *
 *   1. NO SPAN OUTLIVES ITS CALLBACK. `Tracer.span` has no `startSpan`/`end`
 *      pair, so there is no open span object to carry across a return. Inherited
 *      from the seam, not added here.
 *   2. NO INVOCATION HANDLE OUTLIVES ITS INVOCATION. `invocation()` hands the
 *      callback a `TracedInvocation`, the only object that can open a child span,
 *      and REVOKES it when the callback settles. A handle stashed on `this` and
 *      reused after the alarm returns throws (`unsupported`) instead of quietly
 *      parenting new work under a finished span. This is the one an `await` on a
 *      floating promise would otherwise defeat.
 *   3. EVERY SPAN NAMES ITS INVOCATION. `proteus.invocation` is minted at the
 *      entry point from a counter that lives in memory and is NEVER persisted, so
 *      it restarts at 1 after a cold start; `proteus.isolate_gen` is persisted and
 *      bumped per construction, so it does NOT. Together the pair is a positive
 *      discontinuity signal rather than an inferred one: same gen + different
 *      invocation is one isolate serving two invocations (the alarm-on-a-live-
 *      object case), and a different gen is a reconstruction. Neither can be
 *      forged by a span, because a span does not choose either value.
 *
 * What is deliberately NOT here: an `AsyncLocalStorage` context. It would let a
 * span find its parent implicitly from anywhere, which is precisely the ability
 * that makes mechanism 2 unenforceable — an implicit context has no revocation
 * point, so a continuation running after the invocation would still find a
 * parent. Passing the handle down is the enforcement.
 */
import { ProteusError } from './error';
import {
  renderSelfPath, type ScopedSpan, type SpanOpenAttributes, type Tracer,
} from './tracer';

/** Span attribute holding the in-memory invocation counter. Not persisted, by
 *  design — see mechanism 3. */
export const SPAN_ATTR_INVOCATION = 'proteus.invocation';

/**
 * How the runtime entered the object. It prefixes the root span's name because
 * the same work reached from two entry points is not the same measurement: an
 * `alarm` tick competes with nothing, a `fetch` holds a client, and separating
 * them is the difference between reading a latency figure and averaging two.
 */
export type InvocationKind = 'fetch' | 'alarm' | 'rpc' | 'websocket';

/** The only object that can open a child span, and only until its invocation
 *  settles. Obtained from `AgentTracing.invocation`; never stored. */
export interface TracedInvocation {
  /**
   * Opens a span nested inside this invocation's root span.
   *
   * Throws `ProteusError('unsupported')` once the invocation has settled. That is
   * a programming error, not a runtime condition — it means a span was opened
   * from work that escaped its invocation, and the span it would have produced
   * would have claimed coverage of time nobody measured.
   */
  span<T>(name: string, fn: (span: ScopedSpan) => T): T;
}

export interface AgentTracing {
  /**
   * Runs `fn` as ONE invocation: opens the root span `<kind>.<name>`, hands the
   * callback its span and a handle for children, and revokes the handle when the
   * callback settles.
   *
   * The `fn` signature takes the handle FIRST because the common shape uses it and
   * ignores the root span; a caller that needs neither should not be opening a
   * span at all.
   */
  invocation<T>(
    kind: InvocationKind,
    name: string,
    fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
  ): T;
}

/**
 * `isolateGen` is read once at construction and passed in, never read per span:
 * a value re-read on every span could change mid-invocation and split one
 * invocation's spans across two apparent constructions.
 */
export function createAgentTracing(deps: {
  tracer: Tracer;
  isolateGen: number;
  selfPath: ReadonlyArray<{ className: string; name: string }>;
}): AgentTracing {
  const attributes: SpanOpenAttributes = {
    isolateGen: deps.isolateGen,
    selfPath: renderSelfPath(deps.selfPath),
  };
  let invocations = 0;

  return {
    invocation<T>(
      kind: InvocationKind,
      name: string,
      fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
    ): T {
      invocations += 1;
      const ordinal = invocations;
      let live = true;
      const handle: TracedInvocation = {
        span<U>(childName: string, childFn: (span: ScopedSpan) => U): U {
          if (!live) {
            throw new ProteusError(
              'unsupported',
              `span ${JSON.stringify(childName)} was opened after ${kind} invocation `
                + `${String(ordinal)} settled — the work escaped its invocation, so the span `
                + 'would claim coverage of time nothing measured',
            );
          }
          return deps.tracer.span(childName, attributes, (span) => {
            span.setAttribute(SPAN_ATTR_INVOCATION, ordinal);
            return childFn(span);
          });
        },
      };
      return deps.tracer.span(`${kind}.${name}`, attributes, (span) => {
        span.setAttribute(SPAN_ATTR_INVOCATION, ordinal);
        const revoke = (): void => { live = false; };
        let revokesLater = false;
        try {
          const result = fn(handle, span);
          if (result instanceof Promise) {
            revokesLater = true;
            // `then(ok, err)` and not `finally`: `finally` derives a promise that
            // REJECTS whenever `result` does, and nothing awaits this derivation —
            // an unhandled rejection produced by the instrument itself, on every
            // traced invocation that fails. Both arms settle it successfully;
            // `result` still rejects for its real caller, and `Tracer.span` marks
            // the span from that same rejection.
            void result.then(revoke, revoke);
          }
          return result;
        } finally {
          if (!revokesLater) revoke();
        }
      });
    },
  };
}
