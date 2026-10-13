/**
 * A turn's end and its prompt's warm: main's isolate asks the workspace to arm the warm as its turn settles, and tells
 * the turn's end without waiting for that answer, which on deployed objects waits out the workspace's flush of it. The
 * next turn's preparation notes its request where the warm is armed, so it waits for the arming first.
 */
import { expect, test } from 'bun:test';
import { driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { delayNextCacheWarm } from './helpers/agent-facets';
import { chatCompletion, openingOf, stubAiBinding } from './helpers/platform-gateway';

test("a turn ends in its room while its warm's arming is still on the way, and the next turn opens after it", async () => {
  let released = false;
  let secondAskedEarly = false;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (openingOf(run).includes('Second.') && !released) secondAskedEarly = true;

    return chatCompletion(run, 'Noted.');
  }));

  const { storageKey } = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);
  const warm = delayNextCacheWarm(storageKey);

  await workspace.agent.harnessAdmitMain('First.', crypto.randomUUID(), undefined);
  await warm.reached;
  await driveUntil(workspace, 'the turn did not end while its warm was held', () => !workspace.agent.harnessMainTurnInFlight());

  const second = crypto.randomUUID();
  let laps = 0;

  // The next turn is given two hundred laps to reach its model while the warm is still held: it must not.
  await workspace.agent.harnessAdmitMain('Second.', second, undefined);
  await driveUntil(workspace, 'the next turn stopped short of its laps', () => secondAskedEarly || ++laps > 200);
  released = true;
  warm.release();
  await workspace.agent.harnessMainLanding(second);
  await workspace.agent.harnessAgentsIdle();

  expect(secondAskedEarly).toBe(false);
});
