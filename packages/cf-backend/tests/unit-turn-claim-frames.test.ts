/**
 * Every tab of a workspace hears its main actor's turn claim when a turn closes. The claim is what the header, the
 * composer and the thread's tail fold "is a turn live" from; a tab read it only when it loaded, so a page opened
 * during a turn (every new workspace opens on its first turn) kept Stop and Thinking after that turn ended (#29).
 * The turn runs as production runs one, on the platform gateway, and the frames are read as the workspace's sockets
 * are sent them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { TurnClaimFrameSchema, type TurnClaimState } from '@kinu.run/core';
import { admittedTurnClaim, catalogTurn, gatewayWorkspace, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { answeringGateway } from './helpers/platform-gateway';

/** Every claim the workspace's sockets are sent from here on, in order. */
function claimsHeard(agent: HarnessOrchestratorAgent): TurnClaimState[] {
  const heard: TurnClaimState[] = [];

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const frame = v.safeParse(TurnClaimFrameSchema, JSON.parse(payload));

      if (frame.success) heard.push(frame.output.claim);
    },
  });

  return heard;
}

test('a closing turn tells every tab its claim has settled, what a tab loading now reads', async () => {
  const { agent } = gatewayWorkspace(answeringGateway('Done.'));
  const heard = claimsHeard(agent);

  await catalogTurn(agent, 'Say done.');

  expect(heard).toEqual([{ kind: 'settled' }]);
  expect(heard.at(-1)).toEqual((await agent.getWorkspaceSnapshot()).turnClaim);
});

test('recovering a stranded turn reaches every tab, so its Recover control retires', async () => {
  const workspace = gatewayWorkspace(answeringGateway('Done.'));
  await admittedTurnClaim(workspace, 'turn-evicted');
  expect((await workspace.agent.getWorkspaceSnapshot()).turnClaim.kind).toBe('stranded');
  const heard = claimsHeard(workspace.agent);

  await workspace.agent.recoverStrandedTurn();

  expect(heard).toEqual([{ kind: 'settled' }]);
});
