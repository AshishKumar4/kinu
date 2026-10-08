import { tracing } from 'cloudflare:workers';
import {
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  traceException,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from '@kinu.run/core/obs';

/** What runs where the runtime offers no tracing API: the work, untraced, never a failed request. */
const UNTRACED: ScopedSpan = { isTraced: false, setAttribute: () => undefined, fail: () => undefined };

/** Native spans are invocation-bound; exception records carry classification, never message text. */
export function createWorkersTracer(): Tracer {
  return {
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      // A loaded Worker's compatibility date, not this one's, decides whether the API exists there.
      if (typeof tracing?.enterSpan !== 'function') return fn(UNTRACED);

      return tracing.enterSpan(name, (native) => {
        native.setAttributes({
          [SPAN_ATTR_ISOLATE_GEN]: attributes.isolateGen,
          [SPAN_ATTR_SELF_PATH]: attributes.selfPath,
        });

        const failed = (...rejection: [unknown]): void => {
          native.recordException(traceException({ cause: rejection[0] }));
        };

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
          // Return the original promise: deriving one loses RPC pipelining. Register before the span closes.
          void result.then(undefined, failed);

          return result;
        } catch (error) {
          failed(error);
          throw error;
        }
      });
    },
  };
}
