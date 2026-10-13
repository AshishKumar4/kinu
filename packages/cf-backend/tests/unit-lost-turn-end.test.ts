/**
 * An agent's turn ends in its own isolate, which tells the workspace; the telling is no execution authority. An isolate
 * that commits its turn and dies before the end arrives tells the workspace it rests once it comes back, and that word
 * is the agent's own: the workspace holds no later work behind a turn that no longer runs.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { loseNextTurnEnd } from './helpers/agent-facets';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

test("a turn whose end never reached the workspace holds no later signal once its agent says it rests", async () => {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    asked.push(JSON.stringify(requestOf(run).messages));

    return chatCompletion(run, 'Noted.');
  });

  const workspace = gatewayWorkspace(gateway);

  loseNextTurnEnd(workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId).storageKey);
  await catalogTurn(workspace.agent, 'Start the ledger.');

  expect(await workspace.agent.runTaskFromMcp('Tally the refunds.')).toEqual({ status: 'queued' });
  await driveUntil(workspace, 'the signal waited behind a turn that had ended', () => asked.some((messages) => messages.includes('Tally the refunds.')));
});
