/**
 * An exploration head is a hosted actor with no chat: its transcript is the head journal, so a pager naming it is
 * refused. Paging itself, actor apart, and an unknown id's refusal are the workerd public-surface journey's.
 */
import { expect, test } from 'bun:test';
import { hostedExplorationHarness, orchestratorHarness } from './helpers/actor-harness';

test('a hosted actor with no chat pane is refused', async () => {
  const workspace = orchestratorHarness();
  await workspace.agent.activateActor();
  const head = await hostedExplorationHarness(workspace, 'head-without-a-pane');

  await expect(workspace.agent.getChatHistoryPage({ limit: 10, actor: head.actor.handle.actorId }))
    .rejects.toThrow(/does not name a chat/);
});
