/**
 * A workspace object's tables exist from its constructor, whatever event reaches it first: a native RPC does not run
 * `onStart`. The constructor makes tables only, so a call that lands after the workspace was destroyed finds no
 * workspace instead of writing a new, ownerless one. A Nimbus sibling object (`nbf:` name) gets no tables at all.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness, unstartedOrchestratorHarness } from './helpers/actor-harness';

const OWNER = 'a'.repeat(32);

function identityRows(db: ReturnType<typeof orchestratorHarness>['db']): number {
  return db.query<{ n: number }, []>('SELECT count(*) AS n FROM workspace_identity').get()?.n ?? 0;
}

describe('a workspace object is whole from its constructor', () => {
  test('a native RPC that is an activation\u2019s first event reads the workspace\u2019s tables', async () => {
    const born = orchestratorHarness(undefined, { workspace: 'first-rpc', ownerUserId: OWNER });
    const { agent } = unstartedOrchestratorHarness({ workspace: 'first-rpc' }, undefined, born.db);

    expect(await agent.accountSpend()).toEqual([]);
  });

  test('a call landing after the workspace was destroyed writes no workspace', async () => {
    const born = orchestratorHarness(undefined, { workspace: 'destroyed', ownerUserId: OWNER });
    await born.agent.destroyAgent(OWNER);

    const late = unstartedOrchestratorHarness({ workspace: 'destroyed' }, undefined, born.db);

    await expect(late.agent.accountSpend()).rejects.toThrow('The workspace has no durable identity.');
    expect(identityRows(born.db)).toBe(0);
  });

  test('a Nimbus sibling object holds no Kinu workspace, and its alarm runs as the SDK\u2019s', async () => {
    const sibling = unstartedOrchestratorHarness(undefined, 'nbf:npm-resolve-fanout:0123abcd:0');

    expect(sibling.tableNames()).not.toContain('workspace_identity');
    expect(sibling.tableNames()).not.toContain('run_events');
    await sibling.agent.alarm();
  });
});
