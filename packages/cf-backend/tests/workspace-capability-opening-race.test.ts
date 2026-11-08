import { expect, test } from 'bun:test';
import { Result } from 'effect';
import { renderSoulMarkdown } from '@kinu.run/core';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { chatSessionTurns, unstartedOrchestratorHarness } from './helpers/actor-harness';
import { claimOwnedWorkspace } from '../src/user/workspace-ownership';

const USER_ID = '0123456789abcdef0123456789abcdef';

const WORKSPACE = 'brisk-anvil-repro';

// Production 7d6143458, 2026-11-08: a workspace's /wake claimed it before birth issued its identity, answered after, and
// minted a second identity while the first turn ran on the first: "Unrecognized workspace capability token".
test('an opening that observed the pre-birth identity preserves the first turn\'s account access', async () => {
  const claimRead = Promise.withResolvers<void>();
  const claimAnswer = Promise.withResolvers<void>();
  const replacing = Promise.withResolvers<void>();
  const deliverReplacement = Promise.withResolvers<void>();
  let installations = 0;

  const user = createTestUserDO({
    durableObjectId: USER_ID,
    installWorkspaceCapability: async (_name, token) => {
      installations += 1;

      if (installations > 1) {
        replacing.resolve();
        await deliverReplacement.promise;
      }

      await actor.agent.installWorkspaceCapability(token);
    },
  });

  const actor = unstartedOrchestratorHarness({ userDO: user.userDO, workspace: WORKSPACE, ownerUserId: USER_ID }, WORKSPACE);
  const owner = await testOwner();
  await user.userDO.registerWorkspace(owner, WORKSPACE);
  await actor.agent.claimOwner(USER_ID);

  const env = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name: string) => name, get: () => user.userDO },
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: () => ({
        async claimOwner(userId: string) {
          const observed = await actor.agent.claimOwner(userId);
          claimRead.resolve();
          await claimAnswer.promise;

          return observed;
        },
      }),
    },
  };

  const opening = claimOwnedWorkspace(env, USER_ID, WORKSPACE);

  try {
    await claimRead.promise;
    // Birth finishes its identity exchange while the independent opening's old observation is in flight.
    await user.userDO.ensureWorkspaceCapability(WORKSPACE, null);
    await actor.agent.setSoul(renderSoulMarkdown({ name: WORKSPACE, mission: 'Audit the OAuth callback flow.' }));
    claimAnswer.resolve();
    // On the defective path, the hash is replaced before that replacement reaches the workspace.
    await Promise.race([replacing.promise, opening]);
    const turn = await chatSessionTurns(actor.agent).run('Audit the OAuth callback flow.');
    expect(turn.status).toBe('completed');
    expect(turn.message?.role).toBe('assistant');
  } finally {
    claimAnswer.resolve();
    deliverReplacement.resolve();
    expect(Result.isSuccess(await opening)).toBe(true);
    await actor.agent.harnessAgentsIdle();
    await actor.agent.harnessJoinDetachedFibers();
    actor.db.close();
    user.close();
  }
});
