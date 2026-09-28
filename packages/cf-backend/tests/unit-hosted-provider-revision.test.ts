// Issue #34: a hosted child resolves its route from the provider settings the account holds when it calls the model,
// never from a revision it was handed once. Read where the child's own model call runs: the operation profile its
// turn carries into the gateway.
import { expect, test } from 'bun:test';
import { activeOperationProfile } from '@kinu.run/core';
import { gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test("a hired child's model call carries the account's provider revision, the new one after the settings move", async () => {
  const seen: { actorId: string | undefined; revision: string | undefined }[] = [];

  const gateway = stubAiBinding((run) => {
    const operation = activeOperationProfile();
    seen.push({ actorId: operation?.actor.actorId, revision: operation?.profile.providerRevision });

    return chatCompletion(run, 'done');
  });

  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'revision-child', displayName: 'Revision Child', nameOrigin: 'user', mission: 'answer once',
  });

  const childId = child.actor.handle.actorId;
  const childRevisions = () => seen.filter((call) => call.actorId === childId).map((call) => call.revision);

  workspace.agent.harnessProviderRevision('settings-1');
  await runDelegatedTask(workspace, childId, 'first task');
  expect(childRevisions().length).toBeGreaterThan(0);
  expect(new Set(childRevisions())).toEqual(new Set(['settings-1']));

  seen.length = 0;
  workspace.agent.harnessProviderRevision('settings-2');
  await runDelegatedTask(workspace, childId, 'second task');
  expect(new Set(childRevisions())).toEqual(new Set(['settings-2']));
});
