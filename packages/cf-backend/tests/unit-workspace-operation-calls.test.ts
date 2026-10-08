/**
 * The workspace answers an actor's operations to a caller outside eval: a slate, or an isolate running that actor's
 * turn. Each actor reaches its own stores; a Plan caller reaches only what Plan permits; a call still running stops when
 * its caller cancels it.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import type { Database } from 'bun:sqlite';
import { orchestratorHarness } from './helpers/actor-harness';

/** The workspace's own actor: the one with no parent. */
function workspaceActorId(db: Database): string {
  return v.parse(v.object({ actor_id: v.string() }), db.query('SELECT actor_id FROM workspace_actors WHERE parent_actor_id IS NULL').get()).actor_id;
}

const call = () => ({ callId: crypto.randomUUID() });

test('each actor reaches its own state: what one saves, another does not read', async () => {
  const workspace = orchestratorHarness();
  const root = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'build' as const };
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const hosted = { actorId: v.parse(v.string(), subordinate.actorId), turnId: null, mode: 'build' as const };

  await workspace.agent.callOperation(root, 'state.set', { key: 'draft', value: 'the root draft' }, call());

  expect({
    root: await workspace.agent.callOperation(root, 'state.get', { key: 'draft' }, call()),
    hosted: await workspace.agent.callOperation(hosted, 'state.get', { key: 'draft' }, call()),
  }).toEqual({ root: { value: 'the root draft' }, hosted: { value: null } });
});

test('a Plan caller lists only what Plan permits, and a write is refused as unreached', async () => {
  const workspace = orchestratorHarness();
  const plan = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'plan' as const };
  const ids = (await workspace.agent.listOperations(plan)).map(({ id }) => id);

  expect(ids).toContain('state.get');
  expect(ids).toContain('memory.recall');
  expect(ids).not.toContain('memory.remember');
  await expect(workspace.agent.callOperation(plan, 'memory.remember', { key: 'k', value: 'v' }, call())).rejects.toMatchObject({ code: 'missing' });
});

test('a call its caller cancels stops, and its answer is the cancellation', async () => {
  const workspace = orchestratorHarness();
  const root = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'build' as const };
  const running = call();
  const answered = workspace.agent.callOperation(root, 'shell.run', { command: 'sleep 30' }, running);

  await workspace.agent.cancelOperation(running.callId);

  await expect(answered).rejects.toMatchObject({ code: 'cancelled' });
});
