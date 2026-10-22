// The facet names a workspace has given out, which bound the facet ids its object uses for life (`do.facet.count`):
// one per actor row, released ones included, and a name given again to a new actor is a new facet name.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { facetNamesGiven, WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { wrapDatabase } from '../src/identity/inline-primitives';

test('every actor ever registered names one facet of its own, a released one and its namesake included', () => {
  const db = new Database(':memory:');
  const { sql } = wrapDatabase(db);

  initWorkspaceSchema({ execRaw: (ddl) => { db.exec(ddl); }, sql, exec: makeSqlExec(db), transactionSync: (write) => db.transaction(write)() });
  const workspaceId = crypto.randomUUID();

  void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'facets')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });
  const main = directory.createMain({ name: 'facets' });
  const empty = facetNamesGiven(sql);
  const reviewer = directory.create({ parent: main, name: 'reviewer', creationId: 'c-1', origin: 'agent', lifetime: 'durable' });

  directory.create({ parent: main, name: 'exp:head', creationId: 'c-2', origin: 'swarm', lifetime: 'task' });
  // Released as a retirement leaves it: the row stays, so its id stays counted.
  void sql`UPDATE workspace_actors SET retiring_at = 1, deleted_at = 2 WHERE actor_id = ${reviewer.actorId}`;
  directory.create({ parent: main, name: 'reviewer', creationId: 'c-3', origin: 'agent', lifetime: 'durable' });

  // As the workspace names each facet (`orchestrator.ts` `agentOf`): main by its id, any other agent by its storage key.
  const names = sql<{ facet: string }>`SELECT CASE WHEN parent_actor_id IS NULL THEN actor_id ELSE storage_key END AS facet FROM workspace_actors`;

  expect({ empty, given: facetNamesGiven(sql), distinct: new Set(names.map((row) => row.facet)).size })
    .toEqual({ empty: 1, given: 4, distinct: 4 });
});
