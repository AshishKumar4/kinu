/**
 * An answer's slates are taken once it committed (#75): a death between its final step and its commit would otherwise
 * ask the model again. Their take is a row of the roster committed with the answer, so an isolate that dies after the
 * workspace gave them, before they were stamped, stamps the same ones on its next start.
 */
import { expect, test } from 'bun:test';
import { slatesChanged } from '@kinu.run/core';
import { driveUntil, gatewayWorkspace, mainDatabase, storedChat, workspaceFiles, workspaceMainActor } from './helpers/actor-harness';
import { delayNextSlateStamp } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const ASK = 'Add an expiry column to the board.';

test("an answer whose isolate dies after its slates were taken, before they were stamped, carries them after its next start", async () => {
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Done.');
    asked += 1;

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Added the column.')
      : toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: '/slates/board/client.tsx', content: 'export default () => null;' } }, 'call_0');
  }));

  await workspaceFiles(workspace.agent).mkdir('/slates/board', { recursive: true });
  const main = workspaceMainActor(workspace.db).actorId;
  const { storageKey } = workspace.agent.agentOf(main);
  const stamp = delayNextSlateStamp(storageKey);

  await workspace.agent.send(ASK, crypto.randomUUID(), []);
  await stamp.reached;
  const db = mainDatabase(workspace);
  const owed = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM terminal_effects').get()?.n ?? 0;
  const answers = async () => (await storedChat(workspace)).filter((message) => message.role === 'assistant');

  // The answer is committed without its slates, which the workspace has given and the isolate not yet stamped.
  expect((await answers()).map((answer) => slatesChanged({ metadata: answer.metadata }))).toEqual([[]]);

  // Main's isolate dies there; the workspace's recovery wakes the next one, which takes them again.
  workspace.agent.harnessResetAgentIsolate(storageKey);
  await workspace.agent.recoverStrandedTurn();
  await driveUntil(workspace, "the answer's slates stayed owed", () => owed() === 0);
  await workspace.agent.harnessAgentsIdle();

  // Asked for its two steps once each, answered once, and that answer carries the slate its turn wrote.
  expect(asked).toBe(2);
  expect((await answers()).map((answer) => slatesChanged({ metadata: answer.metadata }))).toEqual([['board']]);
});
