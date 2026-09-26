/**
 * Owner 2026-09-25 (SLATE-INLINE-0925): when the agent changes a slate, its new preview appears at the bottom of the
 * chat. The product adds it, not the model: an answer carries the slates its turn wrote, once each, and the chat
 * draws their previews after it.
 */
import { expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { slatesChanged, type JsonValue } from '@kinu.run/core';
import { chatSessionTurns, orchestratorHarness, storedChat, workspaceFiles } from './helpers/actor-harness';

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
