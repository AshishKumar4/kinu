import { createActorHost, EventLog, type ActorHost, type ActorHostDeps, type BoundActor } from '@kinu.run/core';
import { createLocalOrchestration, type LocalOrchestration, type LocalSessionOwner } from './orchestration';
import { buildLocalActorRuntime, type CLIRuntime } from './runtime';

type LocalActorHostDeps = Omit<ActorHostDeps, 'tracing' | 'runtimeFor' | 'filesFor' | 'orchestrationFor' | 'contextEvents'> & {
  parentRuntimeFor(bound: Pick<BoundActor, 'reference' | 'record' | 'handle'>): CLIRuntime;
  actorRuntimeFor: ActorHostDeps['runtimeFor'];
  sessionFor(bound: BoundActor): LocalSessionOwner;
  readonly oneShot: boolean;
  orchestrationCreated?(bound: BoundActor, orchestration: LocalOrchestration): void;
};

export function createLocalActorHost(deps: LocalActorHostDeps): ActorHost {
  return createActorHost({
    ...deps,
    tracing: undefined,
    runtimeFor: (bound, seat) => seat.kind === 'actor'
      ? deps.actorRuntimeFor(bound, seat)
      : buildLocalActorRuntime(deps.parentRuntimeFor(bound), bound, seat.kind, seat.writes),
    filesFor: (bound) => deps.parentRuntimeFor(bound).filesForActor(bound.handle),
    orchestrationFor: (bound) => {
      const orchestration = createLocalOrchestration({
        runtime: bound.runtime, history: bound.stores.history, stores: bound.stores,
        eventLog: new EventLog(deps.storage, bound.handle),
        session: deps.sessionFor(bound), oneShot: deps.oneShot,
      });

      deps.orchestrationCreated?.(bound, orchestration);

      return orchestration.deps;
    },
    contextEvents: (bound) => bound.stores.eventRecorder,
  });
}
