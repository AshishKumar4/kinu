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
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

const OWNER = 'abcdef0123456789abcdef0123456789';

interface DeletedDuringNaming {
  readonly wrote: readonly string[];
  readonly log: ReturnType<typeof createRecordingLogger>;
  readonly asked: readonly string[];
}

/**
 * A workspace deleted while the root's genesis turn names it: the naming's registry write is held until the quiet has
 * reached the root's rest, and `during` runs in that window, while the quiet waits for the root's close.
 */
async function deletedDuringNaming(during: (workspace: StartedHarness) => Promise<void>): Promise<DeletedDuringNaming> {
  const naming = Promise.withResolvers<void>();
  const named = Promise.withResolvers<void>();
  const wrote: string[] = [];
  const asked: string[] = [];
  let holding = false;

  let workspace: StartedHarness | null = null;

  const user = createTestUserDO({
    durableObjectId: OWNER,
    // The quiet begins while the naming's write is held, and the write goes on once main's isolate is at rest: a quiet
    // that does not wait for it lets the revoke and the destroy run under it.
    quietWorkspaceGate: async (_name, owner) => {
      const quiet = workspace?.agent.quietForDeletion(owner);

      await workspace?.agent.harnessAgentsIdle();

      if (workspace !== null) await during(workspace);
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

  const gateway = stubAiBinding((run) => {
    asked.push(JSON.stringify(requestOf(run).messages));

    return chatCompletion(run, 'Noted.');
  });

  const started = gatewayWorkspace(gateway, { userDO: user.userDO, workspace: 'ledger', ownerUserId: OWNER });

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

  return { wrote, log, asked };
}

test("a deletion during the root's naming waits for it to close, and nothing of the root's is refused", async () => {
  const { wrote, log } = await deletedDuringNaming(async () => {});

  // The write reached the registry under the workspace's capability, before the revoke; already marking the deletion,
  // the registry did not apply it.
  expect(wrote).toEqual(['applied false']);
  expect(log.emitted.filter((line) => line.event === 'capability.denied' || JSON.stringify(line.fields).includes('capability token'))
    .map((line) => line.event)).toEqual([]);
});

test('words sent while a deletion waits for the root to close are refused, and start no turn', async () => {
  const refused: string[] = [];

  const { asked } = await deletedDuringNaming(async (workspace) => {
    const [sent] = await Promise.allSettled([workspace.agent.harnessAdmitMain('Also archive the old ledger.', crypto.randomUUID(), undefined)]);

    if (sent.status === 'rejected') refused.push(String(sent.reason));
  });

  expect(refused).toEqual([expect.stringContaining('being deleted')]);
  expect(asked.some((messages) => messages.includes('Also archive the old ledger.'))).toBe(false);
});
