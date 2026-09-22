/**
 * KINU-085, hosted half: tool-call ids replayed to a different provider must be
 * normalized; driven through `beforeStep`, where the actor supplies the destination.
 */
import { describe, expect, test } from 'bun:test';
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { isPortableToolCallId } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** Anthropic's own id grammar, which no other family mints. */
const SOURCE_ID = 'toolu_01SourceMinted';

const SOURCE_REASONING = 'I should look this up.';

const SOURCE_REASONING_SIGNATURE = 'anthropic-source-signature';

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'what is the answer' },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: SOURCE_REASONING,
        providerOptions: { anthropic: { signature: SOURCE_REASONING_SIGNATURE } },
      },
      { type: 'tool-call', toolCallId: SOURCE_ID, toolName: 'look', input: { topic: 'life' } },
    ],
  } satisfies AssistantModelMessage,
  {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: SOURCE_ID, toolName: 'look',
      output: { type: 'text', value: 'the answer is 41' },
    }],
  } satisfies ToolModelMessage,
  { role: 'assistant', content: 'the answer is 41' },
  { role: 'user', content: 'are you sure' },
];

/** Awaited: the pipeline becomes a Promise when an extension must finish I/O first. */
async function stepMessages(
  agent: HarnessOrchestratorAgent, messages: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  return [...await chatSessionTurns(agent).step(0, messages)];
}

function pairing(messages: readonly ModelMessage[]) {
  const calls: string[] = [];
  const results: string[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type === 'tool-call') calls.push(part.toolCallId);

      if (part.type === 'tool-result') results.push(part.toolCallId);
    }
  }

  return { calls, results } as const;
}

describe('a hosted step whose history came from another provider', () => {
  test('is handed destination-neutral ids, still paired', async () => {
    const { agent } = orchestratorHarness();
    // beforeStep refuses an unprepared turn: open it through beforeTurn, as production does.
    await chatSessionTurns(agent).prepare({ messages: [...HISTORY] });

    const carried = pairing(await stepMessages(agent, [...HISTORY]));

    expect(carried.calls).toHaveLength(1);
    expect(carried.results).toEqual(carried.calls);

    for (const id of carried.calls) expect(isPortableToolCallId(id)).toBe(true);
    expect(carried.calls).not.toContain(SOURCE_ID);
  });

  test('converts source reasoning to portable text and removes its signature', async () => {
    const { agent } = orchestratorHarness();
    await chatSessionTurns(agent).prepare({ messages: [...HISTORY] });

    const messages = await stepMessages(agent, [...HISTORY]);

    const assistant = messages.find((message) =>
      message.role === 'assistant' && Array.isArray(message.content));

    const content = assistant?.role === 'assistant' && Array.isArray(assistant.content)
      ? assistant.content
      : [];

    expect(content.some((part) => part.type === 'text' && part.text === SOURCE_REASONING)).toBe(true);
    expect(content.some((part) => part.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(messages)).not.toContain(SOURCE_REASONING_SIGNATURE);
    expect(JSON.stringify(HISTORY)).toContain(SOURCE_REASONING_SIGNATURE);
  });

  test('pairs the same way on every step, so a re-issued request is stable', async () => {
    const { agent } = orchestratorHarness();
    await chatSessionTurns(agent).prepare({ messages: [...HISTORY] });

    const first = pairing(await stepMessages(agent, [...HISTORY]));
    const second = pairing(await stepMessages(agent, [...HISTORY]));

    expect(second).toEqual(first);
  });
});
