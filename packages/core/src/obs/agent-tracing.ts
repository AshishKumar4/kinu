/**
 * The only way an agent opens a span. Context dies across `alarm()`, a wake or a cold start, so a
 * handle is revoked on settle; no `AsyncLocalStorage`, which has no revocation point.
 */
import { analyticsDigest } from './analytics/privacy';
import { KinuError } from './error';
import {
  renderSelfPath, type ScopedSpan, type SpanOpenAttributes, type Tracer,
} from './tracer';

/** In-memory, never persisted: restarts after a cold start while
 *  `kinu.isolate_gen` does not, so the pair signals discontinuity. */
export const SPAN_ATTR_INVOCATION = 'kinu.invocation';

const SPAN_ATTR_ACTOR = 'kinu.actor';

const SPAN_ATTR_ACTOR_KIND = 'kinu.actor_kind';

/** Prefixes the root span name: one work unit from two entry points is two measurements. */
export type InvocationKind = 'fetch' | 'alarm' | 'rpc' | 'websocket';

export interface SpanActor {
  readonly id: string;
  readonly kind: string;
}

/** Opens child spans only until its invocation settles; never store it. */
export interface TracedInvocation {
  /** Throws `KinuError('unsupported')` once the invocation has settled. */
  span<T>(name: string, fn: (span: ScopedSpan) => T): T;
}

export interface TurnTracing {
  turn<T>(fn: (turn: TracedInvocation, span: ScopedSpan) => T): T;
}

export interface AgentTracing {
  /** Runs `fn` as one invocation under root span `<kind>.<name>`; revokes the handle on settle. */
  invocation<T>(
    kind: InvocationKind,
    name: string,
    fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
  ): T;
  turns(actor: SpanActor): TurnTracing;
}

interface RootScope {
  readonly root: string;
  readonly unit: 'invocation' | 'turn';
  readonly label: string;
  readonly actor: SpanActor;
  readonly stamp: (span: ScopedSpan) => void;
}

/** `isolateGen` is read once here, never per span, so one invocation cannot straddle two gens. */
export function createAgentTracing(deps: {
  tracer: Tracer;
  isolateGen: number;
  selfPath: ReadonlyArray<{ className: string; name: string }>;
  actor: SpanActor;
}): AgentTracing {
  const attributes: SpanOpenAttributes = {
    isolateGen: deps.isolateGen,
    selfPath: renderSelfPath(deps.selfPath),
  };

  let invocations = 0;

  const scoped = <T>(scope: RootScope, fn: (handle: TracedInvocation, span: ScopedSpan) => T): T => {
    const { root, actor, stamp } = scope;
    const actorId = analyticsDigest(actor.id);
    let live = true;

    const open = <U>(name: string, body: (span: ScopedSpan) => U): U => deps.tracer.span(name, attributes, (span) => {
      span.setAttribute(SPAN_ATTR_ACTOR, actorId);
      span.setAttribute(SPAN_ATTR_ACTOR_KIND, actor.kind);
      stamp(span);

      return body(span);
    });

    const handle: TracedInvocation = {
      span<U>(childName: string, childFn: (span: ScopedSpan) => U): U {
        if (!live) {
          throw new KinuError(
            'unsupported',
            `span ${JSON.stringify(childName)} was opened after ${scope.label} settled: the work escaped `
              + `its ${scope.unit}, so the span would claim coverage of time nothing measured`,
          );
        }

        return open(childName, childFn);
      },
    };

    return open(root, (span) => {
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
  };

  return {
    invocation<T>(
      kind: InvocationKind,
      name: string,
      fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
    ): T {
      invocations += 1;
      const ordinal = invocations;

      return scoped({
        root: `${kind}.${name}`, unit: 'invocation', label: `${kind} invocation ${String(ordinal)}`, actor: deps.actor,
        stamp: (span) => { span.setAttribute(SPAN_ATTR_INVOCATION, ordinal); },
      }, fn);
    },
    turns(actor: SpanActor): TurnTracing {
      return {
        turn: (fn) => scoped({ root: 'turn', unit: 'turn', label: 'the turn', actor, stamp: () => {} }, fn),
      };
    },
  };
}
