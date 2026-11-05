import { actorScaffoldPath, createActorHost, EventLog, type ActorHost, type ActorHostDeps, type BoundActor } from '@kinu.run/core';
import { createLocalOrchestration, type LocalOrchestration, type LocalSessionOwner } from './orchestration';
import { attemptInItsWords } from '@kinu.run/core/obs';
import { Effect } from 'effect';
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
      source: { path: actorScaffoldPath(bound.record), vfs: parent.agentStateVfs } });
  };

  return createActorHost({
    ...deps,
    tracing: undefined,
    runtimeFor: (bound, seat) => Effect.andThen(
      attemptInItsWords('io', () => scaffoldFor(bound)),
      seat.kind === 'actor' ? deps.actorRuntimeFor(bound, seat)
        : attemptInItsWords('io', () => buildLocalActorRuntime(deps.parentRuntimeFor(bound), bound, seat.kind === 'head' ? 'head' : 'node', seat.writes)),
    ),
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
