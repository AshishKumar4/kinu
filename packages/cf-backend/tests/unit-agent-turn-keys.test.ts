/**
 * A turn's id names it only within its agent: an owner's message id is unique per agent's chat, so two agents' turns may
 * carry one. The workspace holds each agent's open turns apart: one agent's turn opening under an id another agent's
 * open turn carries takes nothing of that turn, whose calls go on running in the workspace.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace, type StartedHarness } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const SAME_ID = 'same-id';

const ALPHA_ASK = 'ALPHA: note the parser.';

const BETA_ASK = 'BETA: echo your marker.';

/** The owner's ask of an agent's model, the agent naming itself after it aside. */
const asks = (run: RecordedGatewayRun, ask: string): boolean => openingOf(run).includes(ask)
  && !JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT);

async function addedAgent(workspace: StartedHarness): Promise<readonly string[]> {
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  return [actorConnectionTag(v.parse(v.string(), subordinate.actorId))];
}

test("one agent's turn opening under another agent's open turn's id takes nothing of that turn", async () => {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const alphaReached = Promise.withResolvers<void>();
  const alphaReleased = Promise.withResolvers<void>();
  const toolResults: string[] = [];
  let alphaAnswered = false;

  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    if (asks(run, ALPHA_ASK)) {
      alphaReached.resolve();
      await alphaReleased.promise;
      alphaAnswered = true;

      return chatCompletion(run, 'Noted.');
    }

    if (!asks(run, BETA_ASK)) return chatCompletion(run, 'Noted.');
    const results = requestOf(run).messages.filter((message) => message.role === 'tool');

    if (results.length > 0) {
      toolResults.push(...results.map((message) => JSON.stringify(message.content)));

      return chatCompletion(run, 'Echoed.');
    }

    reached.resolve();
    await released.promise;

    return toolCallCompletion(run, { tool: 'shell', args: { command: 'echo BETA_RAN' } }, 'call_beta');
  }));

  await workspace.agent.setSoul('# Purpose\n\nDo what each owner asks.');
  const alpha = await addedAgent(workspace);
  const beta = await addedAgent(workspace);

  // Beta's turn is open under the id, its model call held; alpha's turn opens under the same id, its own call held.
  await asPane(beta, () => workspace.agent.send(BETA_ASK, SAME_ID));
  await reached.promise;
  await asPane(alpha, () => workspace.agent.send(ALPHA_ASK, SAME_ID));
  await alphaReached.promise;

  // Beta's step runs its tool in the workspace under its own turn while alpha's is open there too.
  released.resolve();
  await driveUntil(workspace, "beta's tool result never reached its model", () => toolResults.length > 0);
  alphaReleased.resolve();
  await driveUntil(workspace, "alpha's turn never ended", () => alphaAnswered);

  expect(toolResults.join('\n')).toContain('BETA_RAN');
});
