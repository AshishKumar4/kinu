/**
 * An answer's slates are taken once it committed (#75): a death between its final step and its commit would otherwise
 * ask the model again, or run a delivered run again. A chat turn's take is a row of the roster committed with its answer,
 * so an isolate that dies after the workspace gave the slates, before they were stamped, stamps the same ones on its next
 * start. A delivered run asks for none: the node or head it runs on holds no conversation, so its run records no answer.
 */
import { expect, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { slatesChanged } from '@kinu.run/core';
import { driveUntil, gatewayWorkspace, mainDatabase, storedChat, workspaceFiles, workspaceMainActor } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import { delayNextSlateStamp } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const ASK = 'Add an expiry column to the board.';

const SEARCH = 'Find a board layout that reads faster.';

const owner = socketConnection({ id: 'owner', send: () => {} });

const writeBoard = { tool: 'file', args: { op: 'write', path: '/slates/board/client.tsx', content: 'export default () => null;' } };

test("an answer whose isolate dies after its slates were taken, before they were stamped, carries them after its next start", async () => {
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Done.');
    asked += 1;

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Added the column.')
      : toolCallCompletion(run, writeBoard, 'call_0');
  }));

  await workspaceFiles(workspace.agent).mkdir('/slates/board', { recursive: true });
  const main = workspaceMainActor(workspace.db).actorId;
  const { storageKey } = workspace.agent.agentOf(main);
  const stamp = delayNextSlateStamp((key) => key === storageKey);

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

test("a delivered run asks its workspace for no slates before its end commits: its node records no answer to carry them", async () => {
  let nodeCalls = 0;

  const gateway = stubAiBinding((run) => {
    const toolAnswered = requestOf(run).messages.some((message) => message.role === 'tool');

    if (!openingOf(run).includes(SEARCH)) {
      nodeCalls += 1;

      return toolAnswered ? chatCompletion(run, 'A two-column board reads faster.') : toolCallCompletion(run, writeBoard, 'board_0');
    }

    return toolAnswered
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: 'Lay out the board.', preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  });

  const workspace = gatewayWorkspace(gateway);
  const id = crypto.randomUUID();

  await workspaceFiles(workspace.agent).mkdir('/slates/board', { recursive: true });
  await workspace.agent.onMessage(owner, JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text: SEARCH }] }], trigger: 'submit-message' }) },
  }));
  await driveUntil(workspace, 'the search never settled', () => workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status === 'completed');

  // The node ran its two steps and wrote the slate; nothing crossed for slates between its last step and its end.
  expect(nodeCalls).toBe(2);
  expect(workspace.agent.harnessAgentTraceCalls().filter((call) => call === 'answerMetadata')).toEqual([]);
});
