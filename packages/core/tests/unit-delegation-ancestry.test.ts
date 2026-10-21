/**
 * A hire whose recorded line of hirers cannot be walked to the root is refused, and says why (BD-011): a hirer the
 * directory does not describe, or a line that returns to itself, leaves its depth unknown, where the walk once granted
 * the room left below the depth it had counted, or never ended. Rows written outside the directory (an import, a
 * corruption) are the only way there, so the test writes them directly.
 */
import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { createTestActor } from './helpers';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { actorReferenceOf } from '../src/identity/actor-handle';
import { hireLifecycle } from '../src/subagents/hire-lifecycle';
import { KinuError } from '../src/obs/error';
import { delegationBudgetOf } from '../src/subagents/depth';
import { agentsActionsFor, dispatchAgentsCall, type AgentsToolDeps } from '../src/delegation/agents-tool';
import { makeTeam } from './helpers-agents';
import * as v from 'valibot';

const unused = async (): Promise<never> => { throw new KinuError('unsupported', 'A refused hire asks nothing else.'); };

/** A workspace with `subagent` hired by main, its ancestry then rewritten by `corrupt` as an import might leave it. */
function hirerWith(corrupt: (sql: ReturnType<typeof createTestSql>, ids: { readonly subagent: string; readonly second: string }) => void) {
  const database = createTestSql();

  createTestActor(database.sql, database.execRaw, 'workspace', 'main');

  const before = new WorkspaceActorDirectory(database.sql, { workspaceId: 'workspace', ownerUserId: '' });
  const main = before.main();
  const subagent = before.apply(main, [], { action: 'register', name: 'subagent', creationId: 'c-subagent', origin: 'agent', lifetime: 'durable' }).reference;
  const second = before.apply(subagent, before.storagePath(subagent), { action: 'register', name: 'second', creationId: 'c-second', origin: 'agent', lifetime: 'durable' }).reference;

  database.execRaw('PRAGMA foreign_keys = OFF');
  corrupt(database, { subagent: subagent.actorId, second: second.actorId });

  // Read fresh, as the next process reads what the import left.
  const directory = new WorkspaceActorDirectory(database.sql, { workspaceId: 'workspace', ownerUserId: '' });
  const record = directory.retained(second.actorId);

  if (record === null) throw new Error('the hirer under test is gone');

  const lifecycle = hireLifecycle({
    parent: () => ({ reference: actorReferenceOf(record), record }),
    directory,
    born: unused, asHire: unused, deliver: unused, hirerName: () => 'second', announce: () => {}, retireJobs: unused, roster: () => { throw new Error('no roster is read'); }, retire: unused,
  });

  return { directory, lifecycle, record };
}

const seed = { name: 'third', displayName: 'Third', nameOrigin: 'auto', role: 'general', mission: 'Go one deeper.', lifetime: 'durable', origin: 'agent', creationId: 'c-third' } as const;

describe('a hirer whose line of hirers cannot be walked', () => {
  test('one hired by an agent the workspace no longer records is refused, saying its depth is unknown', async () => {
    const { directory, lifecycle } = hirerWith((database, { subagent }) => {
      void database.sql`UPDATE workspace_actors SET parent_actor_id = 'actor-gone' WHERE actor_id = ${subagent}`;
    });

    expect(lifecycle.spawn(seed)).rejects.toThrow(/no longer recorded.*unknown/u);
    expect(directory.list().some((actor) => actor.name === 'third')).toBe(false);
  });

  test('one whose recorded hirers lead back to one another is refused, and the walk ends', async () => {
    const { directory, lifecycle } = hirerWith((database, { subagent, second }) => {
      void database.sql`UPDATE workspace_actors SET parent_actor_id = ${second} WHERE actor_id = ${subagent}`;
    });

    expect(lifecycle.spawn(seed)).rejects.toThrow(/lead back to one another.*unknown/u);
    expect(directory.list().some((actor) => actor.name === 'third')).toBe(false);
  });
});

// The public surface: the `agents` tool a hirer is handed reads the same walk, so it offers nothing to start an agent
// with, and a call a toolset served before the line broke still offers is refused, saying the depth is unknown.
describe('the agents tool of a hirer whose line of hirers cannot be walked', () => {
  test('offers no hire and no search, and refuses either as an unknown depth', async () => {
    const { directory, record } = hirerWith((database, { subagent }) => {
      void database.sql`UPDATE workspace_actors SET parent_actor_id = 'actor-gone' WHERE actor_id = ${subagent}`;
    });

    const team = makeTeam({ delegation: delegationBudgetOf((actorId) => directory.retained(actorId), record) });
    const deps: AgentsToolDeps = { mode: 'build', swarms: true, team: team.deps };

    expect(agentsActionsFor(deps)).toEqual([]);

    const refusals = await Promise.allSettled([
      dispatchAgentsCall(deps, { op: 'hire', fields: { role: 'task', message: 'Go one deeper.' } }),
      dispatchAgentsCall(deps, { op: 'swarm', fields: { task: 'Three ways to go deeper', preset: 'ideate' } }),
    ]);

    const reasons = refusals.map((settled) => (settled.status === 'rejected' ? v.parse(v.object({ code: v.string(), message: v.string() }), settled.reason) : null));

    expect(reasons.map((reason) => [reason?.code, reason?.message.includes('no longer recorded')])).toEqual([['denied', true], ['denied', true]]);
    expect(team.calls).toEqual([]);
  });
});
