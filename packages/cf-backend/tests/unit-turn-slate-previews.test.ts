/**
 * Owner 2026-09-25 (SLATE-INLINE-0925): when the agent changes a slate, its new preview appears at the bottom of the
 * chat. The product adds it, not the model: an answer carries the slates its turn wrote, once each, and the chat
 * draws their previews after it.
 */
import { expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { CHAT_SESSION_ID, slatesChanged, type JsonValue } from '@kinu.run/core';
import {
  chatSessionTurns, gatewayWorkspace, hostedSubordinateHarness, orchestratorHarness, runDelegatedTask, storedChat, workspaceFiles,
} from './helpers/actor-harness';
import { scriptedGateway } from './helpers/platform-gateway';

test('an answer carries each slate its turn wrote, once, and nothing else', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  const files = workspaceFiles(agent);

  await files.mkdir('/slates/board', { recursive: true });
  await files.mkdir('/slates/notes', { recursive: true });
  agent.harnessDrivingUserMessage('Add an expiry column.', { kinuMode: 'build' });
  const turns = chatSessionTurns(agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'Add an expiry column.' }] });

  if (tools.file === undefined) throw new Error('Build has no file tool');
  const write = toolExecute<JsonValue, JsonValue>(tools.file);

  await write({ action: 'write', path: '/slates/board/client.tsx', content: 'export default () => null;' });
  await write({ action: 'write', path: '/slates/board/server.ts', content: 'export class Slate {}' });
  await write({ action: 'write', path: '/slates/notes/client.tsx', content: 'export default () => null;' });
  await write({ action: 'write', path: '/home/main/readme.md', content: 'not a slate' });
  await turns.settle({ messageId: 'a-board', text: 'Added the column.' });

  const answer = (await storedChat(harness)).filter((message) => message.role === 'assistant').at(-1);

  expect(slatesChanged({ metadata: answer?.metadata })).toEqual(['board', 'notes']);
});

test('a slate written outside any turn is not claimed by the next answer', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  const files = workspaceFiles(agent);

  await files.mkdir('/slates/board', { recursive: true });
  await files.writeFile('/slates/board/client.tsx', 'written by the owner, between turns');
  agent.harnessDrivingUserMessage('Say hi.', { kinuMode: 'build' });
  const turns = chatSessionTurns(agent);

  await turns.prepare({ messages: [{ role: 'user', content: 'Say hi.' }] });
  await turns.settle({ messageId: 'a-hi', text: 'Hi.' });

  const answer = (await storedChat(harness)).filter((message) => message.role === 'assistant').at(-1);

  expect(slatesChanged({ metadata: answer?.metadata })).toEqual([]);
});

// Review job 186: a hire that edits a slate while the root is idle still gives the owner its preview, once, on the
// hire's own answer; the root's next answer does not claim it.
test("a hire's slate edit is previewed on the hire's answer, and nowhere else", async () => {
  const gateway = scriptedGateway([
    { tool: 'file', args: { action: 'write', path: '/slates/board/client.tsx', content: 'export default () => null;' } },
  ], 'Updated the board.');

  const workspace = gatewayWorkspace(gateway);

  await workspaceFiles(workspace.agent).mkdir('/slates/board', { recursive: true });

  const hire = await hostedSubordinateHarness(workspace, {
    name: 'board-keeper', displayName: 'Board keeper', nameOrigin: 'user', mission: 'keep the board current',
  });

  // A hire the owner has spoken to: its chat has a row, so its answer is recorded there.
  const history = hire.actor.stores.history;

  const opened = await history.append({
    id: 'u-1', turnId: 'u-1', message: { role: 'user', content: 'Keep the board.' }, origin: 'input', assertOwner: () => hire.actor.handle.assertCurrent(),
  });

  const transcript = history.transcript(CHAT_SESSION_ID);

  transcript.appendUser(await transcript.prepareUser({ id: 'u-1', turnId: 'u-1', message: opened }));
  await runDelegatedTask(workspace, hire.actor.handle.actorId, 'Add an expiry column to the board.');

  const hireAnswers = (await storedChat(workspace, hire.actor.handle)).filter((message) => message.role === 'assistant');

  expect(hireAnswers.map((message) => slatesChanged({ metadata: message.metadata }))).toEqual([['board']]);
  expect(await workspace.agent.readWorkspaceFile('/slates/board/client.tsx')).toMatchObject({ ok: true });

  const rootAnswers = (await storedChat(workspace)).filter((message) => message.role === 'assistant');

  expect(rootAnswers.flatMap((message) => slatesChanged({ metadata: message.metadata }))).toEqual([]);
});

test('a slate the turn wrote and then removed is not previewed', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  const files = workspaceFiles(agent);

  await files.mkdir('/slates/scratch', { recursive: true });
  agent.harnessDrivingUserMessage('Try a board, then drop it.', { kinuMode: 'build' });
  const turns = chatSessionTurns(agent);
  const { tools } = await turns.prepare({ messages: [{ role: 'user', content: 'Try a board, then drop it.' }] });

  if (tools.file === undefined) throw new Error('Build has no file tool');
  await toolExecute<JsonValue, JsonValue>(tools.file)({ action: 'write', path: '/slates/scratch/client.tsx', content: 'x' });
  expect(await agent.execWorkspaceCommand('rm -rf /slates/scratch')).toMatchObject({ ok: true });
  await turns.settle({ messageId: 'a-scratch', text: 'Dropped it.' });

  const answer = (await storedChat(harness)).filter((message) => message.role === 'assistant').at(-1);

  expect(slatesChanged({ metadata: answer?.metadata })).toEqual([]);
});
