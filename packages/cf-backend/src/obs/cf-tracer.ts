/**
 * The Cloudflare `Tracer`. Native runtime tracer, zero bundle cost.
 *
 * Two things about this file are measured facts rather than choices:
 *
 * 1. `tracing.enterSpan` is the ONLY entry point available at our pin.
 *    `tracing.startActiveSpan` does not exist, a `Span` has no `end()`, and
 *    `Span.prototype` is exactly `["isTraced","setAttribute"]` — there is no
 *    native `setAttributes`, so a multi-attribute write is a loop.
 * 2. `ctx.tracing` is `undefined`. Only the module import works. Probing
 *    `typeof tracing` proves nothing; the member is what can be absent.
 *
 * Every span here reports `isTraced === false` under `wrangler dev` or
 * Miniflare with no tail consumer attached, and `true` with one — which is why
 * the local gate that proves this wiring alive must attach a sink, and why a
 * local run can never prove the tree's SHAPE.
 */
import { tracing } from 'cloudflare:workers';
import {
  SPAN_ATTR_ERROR_MESSAGE,
  SPAN_ATTR_ERROR_NAME,
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from '@proteus/core/obs';

export function createWorkersTracer(): Tracer {
  return {
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      return tracing.enterSpan(name, (native) => {
        native.setAttribute(SPAN_ATTR_ISOLATE_GEN, attributes.isolateGen);
        native.setAttribute(SPAN_ATTR_SELF_PATH, attributes.selfPath);
        const span: ScopedSpan = {
          get isTraced(): boolean {
            return native.isTraced;
          },
          setAttribute(key: string, value: SpanAttributeValue): void {
            native.setAttribute(key, value);
          },
          fail(error: Error): void {
            native.setAttribute(SPAN_ATTR_ERROR_NAME, error.name);
            native.setAttribute(SPAN_ATTR_ERROR_MESSAGE, error.message);
          },
        };
        return fn(span);
      });
    },
  };
}
