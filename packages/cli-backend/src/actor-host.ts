import { actorScaffoldPath, createActorHost, EventLog, type ActorHost, type ActorHostDeps, type BoundActor } from '@kinu.run/core';
import { createLocalOrchestration, type LocalOrchestration, type LocalSessionOwner } from './orchestration';
import { buildLocalActorRuntime, type CLIRuntime } from './runtime';
import { localActorScaffoldSource } from './schema-genesis';

type LocalActorHostDeps = Omit<ActorHostDeps, 'tracing' | 'runtimeFor' | 'filesFor' | 'scaffoldFor' | 'orchestrationFor' | 'contextEvents'> & {
  parentRuntimeFor(bound: Pick<BoundActor, 'reference' | 'record' | 'handle'>): CLIRuntime;
  actorRuntimeFor: ActorHostDeps['runtimeFor'];
  sessionFor(bound: BoundActor): LocalSessionOwner;
  readonly oneShot: boolean;
  orchestrationCreated?(bound: BoundActor, orchestration: LocalOrchestration): void;
};

export function createLocalActorHost(deps: LocalActorHostDeps): ActorHost {
  const scaffoldFor: ActorHostDeps['scaffoldFor'] = async (bound) => {
    const parent = deps.parentRuntimeFor(bound);

    return await localActorScaffoldSource({ actor: bound.handle, sql: parent.storage.sql,
      source: { path: actorScaffoldPath(bound.record), vfs: parent.agentStateVfs ?? parent.storage.vfs } });
  };

  return createActorHost({
    ...deps,
    tracing: undefined,
    runtimeFor: async (bound, seat) => {
      await scaffoldFor(bound);

      return await (seat.kind === 'actor' ? deps.actorRuntimeFor(bound, seat)
        : buildLocalActorRuntime(deps.parentRuntimeFor(bound), bound, seat.kind, seat.writes));
    },
    filesFor: (bound) => deps.parentRuntimeFor(bound).filesForActor(bound.handle),
    scaffoldFor,
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
