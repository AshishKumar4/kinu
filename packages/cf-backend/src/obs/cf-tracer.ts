/**
 * The Cloudflare `Tracer`. Native runtime tracer, zero bundle cost.
 *
 * Two things about this file are measured facts rather than choices:
 *
 * 1. `tracing.enterSpan` is the ONLY entry point available at our pin.
 *    `tracing.startActiveSpan` does not exist, a `Span` has no `end()`, and
 *    `Span.prototype` is exactly `["isTraced","setAttribute"]` — there is no
 *    native `setAttributes`, so a multi-attribute write is a loop, and there is
 *    no native OUTCOME either, which is why a failure is an attribute here.
 * 2. `ctx.tracing` is `undefined`. Only the module import works. Probing
 *    `typeof tracing` proves nothing; the member is what can be absent.
 * 3. An absent or non-callable `enterSpan` used to take the CALLER down with it.
 *    `tests/workerd/tracing-fallback.test.ts` measured it on real workerd: the
 *    wrapped callback ran zero times and a `TypeError` escaped, so an
 *    instrumented request would have failed for no reason but the instrument.
 *    The pinned runtime does supply a callable member, which is why this is a
 *    guard and not a migration — but a capability that is checked only by being
 *    used is one whose absence is indistinguishable from a broken caller.
 *
 * Every span here reports `isTraced === false` under `wrangler dev` or
 * Miniflare with no tail consumer attached, and `true` with one — which is why
 * the local gate that proves this wiring alive must attach a sink, and why a
 * local run can never prove the tree's SHAPE.
 *
 * ## The four properties this file is built to
 *
 * Taken from `~/cloudflare-os/packages/backend-utils/src/tracing.ts`, which
 * solved the same problem against the same beta API:
 *
 *   1. AMBIENT CONTEXT IS STAMPED ON EVERY SPAN. Here that is
 *      `SpanOpenAttributes` — `isolateGen` and `selfPath` — which the type makes
 *      unforgettable rather than conventional.
 *   2. TRACING ONLY. Never logs, never mutates anything a caller can see. A log
 *      line from inside an instrument doubles every failure report and puts the
 *      duplicate on a sink the caller did not choose.
 *   3. EXCEPTIONS PROPAGATE UNCHANGED, marked with a boolean. Error TEXT is
 *      deliberately absent: it is unbounded and possibly sensitive, and a trace
 *      attribute is neither the place to bound it nor the place to redact it. The
 *      chain belongs to `Logger.failure`, which requires a classification and
 *      renders the whole `cause` chain. THIS FILE USED TO RECORD
 *      `kinu.error_message = error.message` — a secret in an upstream error's
 *      message would have been written to the trace stream, where
 *      `ReservedLogField` does not reach, and only on the non-throwing `fail`
 *      path, so a THROWN failure was not marked at all.
 *   4. THE SPAN STAYS OPEN UNTIL THE PROMISE SETTLES. `enterSpan` does that
 *      itself, by watching the promise the callback returns — so the marker must
 *      be attached to THAT promise, before returning it, or the span closes
 *      successfully and the rejection arrives after it.
 *
 * And the one prohibition that comes with property 4: NEVER wrap a pipelined RPC
 * stub. Marking a rejection means deriving a promise from the returned value, and
 * a derived promise is not a stub — pipelining is lost and the call becomes a
 * round trip.
 */
import { tracing } from 'cloudflare:workers';
import {
  SPAN_ATTR_ERROR,
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from '@kinu.run/core/obs';

/**
 * The span a callback is handed when the runtime has no tracer.
 *
 * `isTraced` is FALSE, which is the truth rather than a fallback's apology:
 * nothing recorded this call. Attributes and failures go nowhere, and
 * deliberately NOT to a log. Property 2 above is the reason — an instrument that
 * logs when it cannot trace doubles every failure report onto a sink the caller
 * did not choose, and on a runtime with no tracing at all it would do that on
 * every span rather than once.
 *
 * One frozen value, not one per call: it holds no state, and a tracer is on the
 * path of everything.
 */
const UNTRACED_SPAN: ScopedSpan = Object.freeze({
  isTraced: false,
  setAttribute(): void {},
  fail(): void {},
});

/** The one native entry point this file spends. Named so the capability below
 *  has a type rather than a shape asserted at a call site. */
type NativeEnterSpan = typeof tracing.enterSpan;

/**
 * The platform's tracer, bound and ready to call, or `null` on a runtime that
 * has none.
 *
 * THE WHOLE RUNTIME QUESTION LIVES HERE, once. The module's declaration says
 * `enterSpan` is always a callable member and fact 3 above says workerd is what
 * decides, so the local annotation states the honest shape and the narrowing
 * hands back a VALUE instead of a verdict — which is what keeps `span` below a
 * plain null check, with nothing to re-derive and nothing to cast.
 *
 * Bound rather than returned bare: `enterSpan` is inherited from
 * `Tracing.prototype` and reads `this`, so an unbound reference would call
 * against the wrong receiver.
 */
function nativeEnterSpan(): NativeEnterSpan | null {
  const entry: NativeEnterSpan | undefined = tracing.enterSpan;
  return entry instanceof Function ? entry.bind(tracing) : null;
}

export function createWorkersTracer(): Tracer {
  return {
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      // CAPABILITY, CHECKED BEFORE IT IS SPENT, and asked exactly once.
      const enter = nativeEnterSpan();
      if (enter === null) {
        // EXACTLY ONCE, and the value untouched — sync result, promise, thenable
        // or throw, all by identity. There is no try/catch and no wrapper here on
        // purpose: this arm must be indistinguishable from calling `fn` directly,
        // because that is what it is.
        return fn(UNTRACED_SPAN);
      }
      // And no attempt is made to recover from a CALLABLE `enterSpan` that
      // throws. The callback may already have run and may already have had
      // effects, so a retry there would be the instrument duplicating the work
      // it was measuring.
      return enter(name, (native) => {
        native.setAttribute(SPAN_ATTR_ISOLATE_GEN, attributes.isolateGen);
        native.setAttribute(SPAN_ATTR_SELF_PATH, attributes.selfPath);
        const failed = (): void => { native.setAttribute(SPAN_ATTR_ERROR, true); };
        const span: ScopedSpan = {
          get isTraced(): boolean {
            return native.isTraced;
          },
          setAttribute(key: string, value: SpanAttributeValue): void {
            native.setAttribute(key, value);
          },
          fail: failed,
        };
        try {
          const result = fn(span);
          if (!(result instanceof Promise)) return result;
          // The marker is attached for its SIDE EFFECT and `result` is returned
          // untouched. Three things fall out of that, all of them wanted:
          //
          //   - No derived promise is returned, so no cast is needed and nothing
          //     about the value a caller receives changes — the rejection is the
          //     same rejection, with the same identity.
          //   - A pipelined RPC stub survives. `.catch(…)` as the RETURN value
          //     would replace the stub with an ordinary promise and turn a
          //     pipelined call into a round trip; the reference pattern carries
          //     that prohibition and this shape does not need it.
          //   - The marker runs BEFORE the span closes. `enterSpan` watches the
          //     promise this callback returns, which is `result`; our handler is
          //     registered on `result` first, and promise reactions run in
          //     registration order.
          //
          // `then(undefined, …)` and not `.catch(…)`: the derivation must settle
          // SUCCESSFULLY, or the instrument produces an unhandled rejection of its
          // own on every traced failure.
          void result.then(undefined, failed);
          return result;
        } catch (error) {
          failed();
          throw error;
        }
      });
    },
  };
}
