/**
 * A workspace deleted while the root agent's settled turn still closes its effects. The deletion revokes the
 * workspace's capability, and an effect that reads the registry after it is refused: staging 44b13e946, 2026-10-09,
 * trace aba7ea25181f183106edf186aafb32fd, the root's naming failed "Unrecognized workspace capability token". The
 * quiet before the revoke joins the root's close, so nothing it owes is refused.
 */
import { expect, test } from 'bun:test';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { createTestUserDO, testOwner } from './helpers/user-do';
import { gatewayWorkspace, type StartedHarness } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const OWNER = 'abcdef0123456789abcdef0123456789';

test("a deletion during the root's naming waits for it to close, and nothing of the root's is refused", async () => {
  const naming = Promise.withResolvers<void>();
  const named = Promise.withResolvers<void>();
  const wrote: string[] = [];
  let holding = false;

  let workspace: StartedHarness | null = null;

  const user = createTestUserDO({
    durableObjectId: OWNER,
    // The quiet begins while the naming's write is held, and the write goes on once main's isolate is at rest: a quiet
    // that does not wait for it lets the revoke and the destroy run under it.
    quietWorkspaceGate: async (_name, owner) => {
      const quiet = workspace?.agent.quietForDeletion(owner);

      await workspace?.agent.harnessAgentsIdle();
      named.resolve();
      await quiet;
    },
    destroyWorkspaceGate: async (_name, owner) => { await workspace?.agent.destroyAgent(owner); },
  });

  // The naming writes the registry with the workspace's capability; that write is held once the genesis turn began.
  const nameWorkspace = user.userDO.setWorkspaceDisplayName.bind(user.userDO);

  user.userDO.setWorkspaceDisplayName = async (...args) => {
    if (!holding || args[3] !== 'auto') return await nameWorkspace(...args);
    holding = false;
    naming.resolve();
    await named.promise;
    const written = await nameWorkspace(...args);

    wrote.push(`applied ${String(written.applied)}`);

    return written;
  };

  // A stand-in title, which the genesis turn replaces.
  await user.userDO.registerWorkspace(await testOwner(), 'ledger', 'ledger', { nameOrigin: 'auto' });
  await user.userDO.ensureWorkspaceCapability('ledger', null);
  const token = user.installed.get('ledger');

  if (token === undefined) throw new Error('the workspace was not provisioned');
  const started = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')), { userDO: user.userDO, workspace: 'ledger', ownerUserId: OWNER });

  workspace = started;
  started.agent.harnessHoldsCapability(token);

  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  try {
    await started.agent.setSoul('# Ledger\n\n## Mission\n\nMigrate the ledger to integer cents.');
    holding = true;
    expect(await started.agent.beginGenesisTurn()).toEqual({ started: true });
    await naming.promise;
    await user.userDO.removeWorkspace(await testOwner(), 'ledger', OWNER);
  } finally {
    restore();
  }

  // The write reached the registry under the workspace's capability, before the revoke; already marking the deletion,
  // the registry did not apply it.
  expect(wrote).toEqual(['applied false']);
  expect(log.emitted.filter((line) => line.event === 'capability.denied' || JSON.stringify(line.fields).includes('capability token'))
    .map((line) => line.event)).toEqual([]);
});
