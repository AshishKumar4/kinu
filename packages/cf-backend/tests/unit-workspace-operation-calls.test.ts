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

test('each actor reaches its own private table rows: what one saves, another does not read', async () => {
  const workspace = orchestratorHarness();

  // An added agent takes the workspace's mission.
  await workspace.agent.setSoul('# Purpose\n\nKeep the drafts.');
  const root = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'build' as const };
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const hosted = { actorId: v.parse(v.string(), subordinate.actorId), turnId: null, mode: 'build' as const };

  await workspace.agent.callOperation(root, 'db.createTable', { spec: { name: 'drafts', scope: 'private', columns: [{ name: 'value', type: 'text' }] } }, call());
  await workspace.agent.callOperation(root, 'db.insert', { table: 'drafts', rows: [{ value: 'the root draft' }] }, call());

  expect({
    root: await workspace.agent.callOperation(root, 'db.select', { table: 'drafts' }, call()),
    hosted: await workspace.agent.callOperation(hosted, 'db.select', { table: 'drafts' }, call()),
  }).toEqual({ root: { value: [{ value: 'the root draft' }] }, hosted: { value: [] } });
});

// The SelfishJaguar audit: the remote search and the agent's own composed one memory search apart; their reach differs on
// purpose, and now says so. The agent's search reads its facts too; a remote caller's reads the notes alone.
test("a remote memory search reads the workspace's notes; the agent's own search reads its facts as well", async () => {
  const workspace = orchestratorHarness();
  const root = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'build' as const };

  await workspace.agent.callOperation(root, 'memory.note', { content: 'the staging cluster runs on kubernetes' }, call());
  await workspace.agent.callOperation(root, 'memory.remember', { key: 'kubernetes_version', value: '1.33' }, call());

  const own = v.parse(v.object({ hits: v.array(v.object({ ref: v.string() })) }), (await workspace.agent.callOperation(root, 'memory.search', { query: 'kubernetes' }, call())).value);
  const remote = await workspace.agent.searchMemoryHybrid('kubernetes');

  expect({
    own: own.hits.map((hit) => hit.ref.startsWith('fact:') ? 'fact' : 'note').sort(),
    remote: remote.map((hit) => hit.label?.startsWith('fact:') === true ? 'fact' : 'note'),
  }).toEqual({ own: ['fact', 'note'], remote: ['note'] });
});

test('a Plan caller lists only what Plan permits, and a write is refused', async () => {
  const workspace = orchestratorHarness();
  const plan = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'plan' as const };
  const ids = (await workspace.agent.listOperations(plan)).map(({ id }) => id);

  expect(ids).toContain('file.read');
  expect(ids).not.toContain('file.write');
  expect(ids).not.toContain('workspace.exec');
  await expect(workspace.agent.callOperation(plan, 'file.write', { path: 'notes.md', content: 'x' }, call())).rejects.toMatchObject({ code: 'denied' });
});

test('a call its caller cancels stops, and its answer is the cancellation', async () => {
  const workspace = orchestratorHarness();
  const root = { actorId: workspaceActorId(workspace.db), turnId: null, mode: 'build' as const };
  const running = call();
  const answered = workspace.agent.callOperation(root, 'workspace.exec', { command: 'sleep 30' }, running);

  await workspace.agent.cancelOperation(running.callId);

  await expect(answered).rejects.toMatchObject({ code: 'cancelled' });
});
