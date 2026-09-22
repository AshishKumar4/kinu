/**
 * The Cloudflare `Tracer`. Measured facts at our pin: `tracing.enterSpan` is the only entry point (a `Span` has only
 * `isTraced`/`setAttribute`, so failure is an attribute); `ctx.tracing` is undefined; an absent or non-callable `enterSpan`
 * throws into the caller (`tests/workerd/tracing-fallback.test.ts`). `isTraced` is false without a tail consumer.
 * Rules: never log; exceptions propagate unchanged, marked by a boolean, never their text (secrets); the span stays open until
 * the promise settles; never wrap a pipelined RPC stub (a derived promise loses pipelining).
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

/** `isTraced` false: nothing recorded. Attributes go nowhere, deliberately not to a log. */
const UNTRACED_SPAN: ScopedSpan = Object.freeze({
  isTraced: false,
  setAttribute(): void {},
  fail(): void {},
});

type NativeEnterSpan = typeof tracing.enterSpan;

/** `null` on a runtime with no tracer. Bound because `enterSpan` is inherited from `Tracing.prototype` and reads `this`. */
function nativeEnterSpan(): NativeEnterSpan | null {
  if (!(tracing.enterSpan instanceof Function)) return null;

  return tracing.enterSpan.bind(tracing);
}

export function createWorkersTracer(): Tracer {
  return {
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      const enter = nativeEnterSpan();

      if (enter === null) {
        // Exactly once, value untouched: this arm must be indistinguishable from calling `fn` directly.
        return fn(UNTRACED_SPAN);
      }

      // No recovery from a callable `enterSpan` that throws: the callback may already have had effects.
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
          // Attached for its side effect; `result` is returned untouched so a pipelined stub survives, and the handler runs before
          // the span closes (reactions run in registration order). `then(undefined, …)` settles successfully: no unhandled rejection.
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
