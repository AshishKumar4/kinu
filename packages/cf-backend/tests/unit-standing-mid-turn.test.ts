/**
 * What the workspace shows of a turn while it runs: the run it is on, from its opening. An opening whose wake the
 * workspace already holds tells no report of its own (its arm asks nothing new), so what it moved of the agent's standing
 * rides its preparation: the overview's latest run and the panel read the turn that runs, never the one before it.
 */
import { expect, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, requestOf, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const FIRST = 'Migrate the ledger.';

const SECOND = 'Summarize the release.';

const owner = socketConnection({ id: 'owner', send: () => {} });

/** The words a model call was asked last: a later turn's request carries the turns before it. */
function lastAsked(run: RecordedGatewayRun): string {
  const asked = requestOf(run).messages.filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context'));

  return JSON.stringify(asked.at(-1)?.content ?? '');
}

/** The owner's message, as the pane sends it. */
function ownerMessage(text: string): string {
  const id = crypto.randomUUID();

  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }], trigger: 'submit-message' }) },
  });
}

test("a turn's opening shows as the latest run while it runs, and a failed turn before it does not mark the agent failed", async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  // The first turn fails at its model; the second holds at its model until released.
  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    if (lastAsked(run).includes(FIRST)) return Response.json({ error: { message: 'Bad Request' } }, { status: 400 });

    if (lastAsked(run).includes(SECOND)) {
      reached.resolve();
      await release.promise;
    }

    return chatCompletion(run, 'Done.');
  }));

  const main = workspaceMainActor(workspace.db).actorId;

  await workspace.agent.onMessage(owner, ownerMessage(FIRST));
  await workspace.agent.harnessAgentsIdle();
  expect((await workspace.agent.listWorkspaceAgents()).find((agent) => agent.actorId === main)?.activity).toBe('failed');

  // Answered as its turn ends, which waits on the model held below.
  const sending = workspace.agent.onMessage(owner, ownerMessage(SECOND));

  await reached.promise;

  try {
    const overview = await workspace.agent.foldOverview();
    const panel = (await workspace.agent.listWorkspaceAgents()).find((agent) => agent.actorId === main);

    expect({ latest: overview.latestRun?.task ?? null, failed: panel?.activity === 'failed' }).toEqual({ latest: SECOND, failed: false });
  } finally {
    release.resolve();
  }

  await sending;
  await workspace.agent.harnessAgentsIdle();
});
