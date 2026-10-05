/**
 * The only way an agent opens a span. Context dies across `alarm()`, a wake or a cold start, so a
 * handle is revoked on settle; no `AsyncLocalStorage`, which has no revocation point.
 */
import { Effect } from 'effect';
import { analyticsDigest } from './analytics/privacy';
import { settleSync } from './effect';
import { KinuError } from './error';
import {
  renderSelfPath, type ScopedSpan, type SpanOpenAttributes, type Tracer,
} from './tracer';

/** In-memory, never persisted: restarts after a cold start while
 *  `kinu.isolate_gen` does not, so the pair signals discontinuity. */
export const SPAN_ATTR_INVOCATION = 'kinu.invocation';

const SPAN_ATTR_ACTOR = 'kinu.actor';

const SPAN_ATTR_ACTOR_KIND = 'kinu.actor_kind';

const SPAN_ATTR_TURN = 'kinu.turn';

const SPAN_ATTR_TURN_EPOCH = 'kinu.turn.epoch';

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

export interface TurnIdentity {
  readonly turnId: string;
  readonly epoch: number;
}

export interface TurnUnitTimer {
  end(stamp?: (span: ScopedSpan) => void): void;
}

export interface TurnTrace {
  begin(name: string): TurnUnitTimer;
  atStep(step: number): void;
  settle(startedAt: number, stamp: (span: ScopedSpan) => void): void;
}

export interface TurnTracing {
  admitted(turn: TurnIdentity, startedAt: number, stamp: (span: ScopedSpan) => void): TurnTrace;
  recovered(turn: TurnIdentity, outcome: string): void;
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

function escaped(name: string, label: string, unit: 'invocation' | 'turn'): KinuError {
  return new KinuError(
    'unsupported',
    `span ${JSON.stringify(name)} was opened after ${label} settled: the work escaped its ${unit}, `
      + 'so the span would claim coverage of time nothing measured',
  );
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

  return {
    invocation<T>(
      kind: InvocationKind,
      name: string,
      fn: (invocation: TracedInvocation, span: ScopedSpan) => T,
    ): T {
      invocations += 1;
      const ordinal = invocations;
      const label = `${kind} invocation ${String(ordinal)}`;
      const actorId = analyticsDigest(deps.actor.id);
      let live = true;

      const open = <U>(spanName: string, body: (span: ScopedSpan) => U): U => deps.tracer.span(spanName, attributes, (span) => {
        span.setAttribute(SPAN_ATTR_ACTOR, actorId);
        span.setAttribute(SPAN_ATTR_ACTOR_KIND, deps.actor.kind);
        span.setAttribute(SPAN_ATTR_INVOCATION, ordinal);

        return body(span);
      });

      const handle: TracedInvocation = {
        span<U>(childName: string, childFn: (span: ScopedSpan) => U): U {
          return settleSync(live ? Effect.sync(() => open(childName, childFn)) : Effect.fail(escaped(childName, label, 'invocation')));
        },
      };

      return open(`${kind}.${name}`, (span) => {
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
    turns(actor: SpanActor): TurnTracing {
      const actorId = analyticsDigest(actor.id);

      const record = (name: string, turn: TurnIdentity, startedAt: number, stamp: (span: ScopedSpan) => void): void => {
        const endedAt = Date.now();

        deps.tracer.span(name, attributes, (span) => {
          span.setAttribute(SPAN_ATTR_ACTOR, actorId);
          span.setAttribute(SPAN_ATTR_ACTOR_KIND, actor.kind);
          span.setAttribute(SPAN_ATTR_TURN, analyticsDigest(turn.turnId));
          span.setAttribute(SPAN_ATTR_TURN_EPOCH, turn.epoch);
          span.setAttribute('kinu.started_at_ms', startedAt);
          span.setAttribute('kinu.duration_ms', Math.max(0, endedAt - startedAt));
          stamp(span);
        });
      };

      return {
        admitted(turn, startedAt, stamp) {
          record('turn.admitted', turn, startedAt, stamp);
          let live = true;
          let step: number | null = null;

          return {
            begin(name) {
              return settleSync(Effect.gen(function* () {
                if (!live) return yield* escaped(name, 'the turn', 'turn');

                const startedAtUnit = Date.now();
                const atStep = step;

                return {
                  end(unitStamp) {
                    record(name, turn, startedAtUnit, (span) => {
                      if (atStep !== null) span.setAttribute('kinu.step', atStep);
                      unitStamp?.(span);
                    });
                  },
                };
              }));
            },
            atStep(next) {
              step = next;
            },
            settle(settleStartedAt, settleStamp) {
              live = false;
              record('turn.settled', turn, settleStartedAt, settleStamp);
            },
          };
        },
        recovered(turn, outcome) {
          record('turn.settled', turn, Date.now(), (span) => {
            span.setAttribute('kinu.turn.outcome', outcome);
            span.setAttribute('kinu.turn.recovered', true);
          });
        },
      };
    },
  };
}
