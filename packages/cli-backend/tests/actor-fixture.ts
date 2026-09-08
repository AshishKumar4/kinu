import type { Database } from 'bun:sqlite';
import { explorationActorKey, type WriteObserver } from '@kinu.run/core';
import { registerLocalActor, seedLocalActor } from '../src/actor-identity';
import { buildCLIHeadRuntime, makeSqlExec, type CLIRuntime } from '../src/runtime';

/** Test adapters use the production directory and durable facet identity. */
export async function createHeadRuntime(db: Database, parent: CLIRuntime, id: string, observer?: WriteObserver) {
  const binding = registerLocalActor(parent.actor, { name: explorationActorKey(id), creationId: id, kind: 'head', lifetime: 'task', dbPathForKey: () => db.filename });
  seedLocalActor(db, makeSqlExec(db), binding);
  return buildCLIHeadRuntime(db, { parentRuntime: parent, actorBinding: binding, writeObserver: observer });
}
