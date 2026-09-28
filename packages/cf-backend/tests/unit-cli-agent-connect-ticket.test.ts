// The CLI agent websocket connect ticket against a real UserDO: every other test replaces the store with a fake.
import { expect, test } from 'bun:test';
import { ORCHESTRATOR_AGENT_SLUG } from '@kinu.run/core';
import { createTestUserDO, testOwner } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

test('an issued ticket redeems once, for its workspace, with the expiry it was issued with', async () => {
  const harness = createTestUserDO({ durableObjectId: USER_ID });
  const owner = await testOwner();
  await harness.userDO.ensureProfile(owner, 'owner@example.com', 'Owner');
  await harness.userDO.registerWorkspace(owner, 'jarvis', 'Jarvis');
  const session = await harness.userDO.mintCliToken(owner, USER_ID, 'a'.repeat(64), 'ticket test');

  const issued = await harness.userDO.issueCliAgentConnectTicket(owner, {
    userId: USER_ID, agentClass: ORCHESTRATOR_AGENT_SLUG, agentName: 'jarvis', cliTokenHash: session.tokenHash,
  });

  expect(issued.ok).toBe(true);
  expect(issued.expiresAt).toBeGreaterThan(Date.now());

  const expected = { userId: USER_ID, agentClass: ORCHESTRATOR_AGENT_SLUG, agentName: 'jarvis', capability: 'agent.websocket' } as const;
  const redeemed = await harness.userDO.verifyCliAgentConnectTicket(owner, issued.ticket ?? '', expected);

  expect(redeemed).toMatchObject({ ok: true, tokenHash: session.tokenHash, expiresAt: issued.expiresAt, capabilities: ['agent.websocket'] });
  expect(await harness.userDO.verifyCliAgentConnectTicket(owner, issued.ticket ?? '', expected))
    .toEqual({ ok: false, error: 'invalid ticket' });
  harness.close();
});
