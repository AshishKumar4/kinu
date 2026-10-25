/**
 * The owner's assistant, as the account holds it (`ASSISTANT_CONFIG_KEY`): its name is claimed once, so installs at once
 * agree on one workspace, and its removal frees the claim, so the next install makes a new one (the rc27 review).
 */
import { expect, test } from 'bun:test';
import { createTestUserDO, testOwner } from './helpers/user-do';

const OWNER = 'abcdef0123456789abcdef0123456789';

test('two claims at once agree on the first name, and a claim held answers what it holds', async () => {
  const { userDO } = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();

  expect(await Promise.all([userDO.claimConfig(owner, 'assistant', 'kinu-a'), userDO.claimConfig(owner, 'assistant', 'kinu-b')])).toEqual(['kinu-a', 'kinu-a']);
  expect(await userDO.claimConfig(owner, 'assistant', 'kinu-c')).toBe('kinu-a');
  expect(await userDO.getConfig(owner, 'assistant')).toBe('kinu-a');
});

test("removing the assistant frees its claim, and removing another workspace leaves it", async () => {
  const { userDO } = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();

  await userDO.registerWorkspace(owner, 'kinu-a');
  await userDO.registerWorkspace(owner, 'ledger');
  await userDO.claimConfig(owner, 'assistant', 'kinu-a');
  await userDO.removeWorkspace(owner, 'ledger', OWNER);
  expect(await userDO.getConfig(owner, 'assistant')).toBe('kinu-a');
  await userDO.removeWorkspace(owner, 'kinu-a', OWNER);
  expect(await userDO.getConfig(owner, 'assistant')).toBeNull();
  expect(await userDO.claimConfig(owner, 'assistant', 'kinu-b')).toBe('kinu-b');
});

// Staging 2026-10-25: an assistant deleted and installed again within the minute claimed the dying name, and the install's
// create waited 39 s for that workspace's teardown. The person's delete frees the claim with its mark, before the job runs.
test("a deletion the person asks for frees the assistant's claim at once, so a reinstall makes a new workspace", async () => {
  const { userDO } = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();

  await userDO.registerWorkspace(owner, 'kinu-a');
  await userDO.claimConfig(owner, 'assistant', 'kinu-a');
  await userDO.requestWorkspaceRemoval(owner, 'kinu-a', OWNER);

  expect(await userDO.getConfig(owner, 'assistant')).toBeNull();
  expect(await userDO.claimConfig(owner, 'assistant', 'kinu-b')).toBe('kinu-b');
  expect((await userDO.registerWorkspace(owner, 'kinu-b')).status).toBe('created');
});
