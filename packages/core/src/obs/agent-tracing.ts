/**
 * The only way a Kinu agent opens a span; platform-free, so it computes `isolateGen`/`selfPath` once.
 * Trace context does not survive `alarm()`, a hibernation wake or a cold start, so an invocation
 * handle is revoked when its callback settles; no `AsyncLocalStorage`, which has no revocation point.
 */
import { KinuError } from './error';
import {
  renderSelfPath, type ScopedSpan, type SpanOpenAttributes, type Tracer,
} from './tracer';

/** In-memory invocation counter, never persisted: restarts after a cold start while
 *  `kinu.isolate_gen` does not, so the pair signals discontinuity. */
export const SPAN_ATTR_INVOCATION = 'kinu.invocation';

/** Prefixes the root span name: one work unit from two entry points is two measurements. */
export type InvocationKind = 'fetch' | 'alarm' | 'rpc' | 'websocket';

/** Opens child spans only until its invocation settles; never store it. */
export interface TracedInvocation {
  /** Throws `KinuError('unsupported')` once the invocation has settled. */
  span<T>(name: string, fn: (span: ScopedSpan) => T): T;
}

export interface AgentTracing {
  /** Runs `fn` as one invocation under root span `<kind>.<name>`; revokes the handle on settle. */
  invocation<T>(
    kind: InvocationKind,
    name: string,
    fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
  ): T;
}

/** `isolateGen` is read once here, never per span, so one invocation cannot straddle two gens. */
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
            throw new KinuError(
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
            // `then(ok, err)`, not `finally`: `finally` would derive an unhandled rejection.
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
