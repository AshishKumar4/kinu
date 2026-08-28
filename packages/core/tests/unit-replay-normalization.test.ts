import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { normalizeReplayForDestination } from '../src/prompting/replay-normalization';

const SOURCE: ModelMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'source thought', providerOptions: { anthropic: { signature: 'source-signature' } } },
      { type: 'tool-call', toolCallId: 'toolu_01SOURCE', toolName: 'look', input: { path: 'a.txt' } },
    ],
  },
  {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'toolu_01SOURCE', toolName: 'look',
      output: { type: 'text', value: 'answer' },
    }],
  },
];

describe('destination replay normalization', () => {
  test('rekeys both halves of a replayed tool pair without changing durable source messages', () => {
    const normalized = normalizeReplayForDestination(SOURCE, 'openai');
    expect(normalized).toBeDefined();
    const assistant = normalized?.[0];
    const tool = normalized?.[1];
    const call = assistant?.role === 'assistant' && Array.isArray(assistant.content)
      ? assistant.content.find((part) => part.type === 'tool-call')
      : undefined;
    const result = tool?.role === 'tool' ? tool.content[0] : undefined;

    expect(call?.type === 'tool-call' && call.toolCallId).toBe('kinu-i-1');
    expect(result?.type === 'tool-result' && result.toolCallId).toBe('kinu-i-1');
    expect(SOURCE[0]?.role === 'assistant' && Array.isArray(SOURCE[0].content)
      ? SOURCE[0].content.find((part) => part.type === 'tool-call')?.toolCallId
      : undefined).toBe('toolu_01SOURCE');
  });

  test('is deterministic and leaves a text-only request untouched', () => {
    const once = normalizeReplayForDestination(SOURCE, 'anthropic');
    const twice = normalizeReplayForDestination(SOURCE, 'anthropic');
    expect(once).toEqual(twice);
    const textOnly: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    expect(normalizeReplayForDestination(textOnly, 'openai')).toBeUndefined();
    expect(normalizeReplayForDestination(SOURCE, undefined)).toBeUndefined();
  });
});
