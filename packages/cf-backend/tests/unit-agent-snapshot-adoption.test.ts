/**
 * Every call to an agent's isolate carries the roster rows it needs (an `AgentSnapshot`); the isolate keeps copies
 * in its own database. Staging 85a438698: copying them again on each unchanged read made ten spend reads write 110
 * rows. A read writes only what changed.
 */
import { expect, test } from 'bun:test';
import { agentSql, gatewayWorkspace, hostedSubordinateHarness } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

async function helper() {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'done')));
  const child = await hostedSubordinateHarness(workspace, { name: 'scout', displayName: 'Scout', nameOrigin: 'user', mission: 'read' });
  const sql = agentSql(workspace, child.actor.handle.actorId);

  await workspace.agent.accountSpend();

  return { workspace, actorId: child.actor.handle.actorId, sql, written: () => sql<{ n: number }>`SELECT total_changes() AS n`[0]?.n ?? -1 };
}

test("reading a helper's spend ten times writes nothing into its database", async () => {
  const { workspace, written } = await helper();
  const before = written();

  for (let read = 0; read < 10; read += 1) await workspace.agent.accountSpend();

  expect(written() - before).toBe(0);
});

test("a setting the workspace changed reaches the helper's database on its next read", async () => {
  const { workspace, actorId, sql } = await helper();

  workspace.db.query('INSERT INTO actor_config (actor_id, key, value) VALUES (?, ?, ?)').run(actorId, 'probe.setting', 'on');
  await workspace.agent.accountSpend();

  expect(sql<{ value: string }>`SELECT value FROM actor_config WHERE actor_id = ${actorId} AND key = 'probe.setting'`).toEqual([{ value: 'on' }]);

  workspace.db.query('DELETE FROM actor_config WHERE actor_id = ? AND key = ?').run(actorId, 'probe.setting');
  await workspace.agent.accountSpend();

  expect(sql<{ value: string }>`SELECT value FROM actor_config WHERE actor_id = ${actorId} AND key = 'probe.setting'`).toEqual([]);
});
