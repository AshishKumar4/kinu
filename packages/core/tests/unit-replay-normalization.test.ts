import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { normalizeReplayForDestination, ReplayProgress } from '../src/prompting/replay-normalization';

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
    const normalized = normalizeReplayForDestination(SOURCE, { providerId: 'openai' });
    expect(normalized).toBeDefined();
    const assistant = normalized?.[0];
    const tool = normalized?.[1];

    const call = assistant?.role === 'assistant' && Array.isArray(assistant.content)
      ? assistant.content.find((part) => part.type === 'tool-call')
      : undefined;

    const result = tool?.role === 'tool' ? tool.content[0] : undefined;

    expect(call?.type === 'tool-call' && call.toolCallId).not.toBe('toolu_01SOURCE');
    expect(result?.type === 'tool-result' ? result.toolCallId : null).toBe(call?.toolCallId ?? null);
    expect(SOURCE[0]?.role === 'assistant' && Array.isArray(SOURCE[0].content)
      ? SOURCE[0].content.find((part) => part.type === 'tool-call')?.toolCallId
      : undefined).toBe('toolu_01SOURCE');
  });

  test('is deterministic and leaves a text-only request untouched', () => {
    const textOnly: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    expect(normalizeReplayForDestination(textOnly, { providerId: 'openai' })).toBeUndefined();
    expect(normalizeReplayForDestination(SOURCE, undefined)).toBeUndefined();
  });

  test('a turn resumed step by step keeps each result on its call through woven blocks and edits', () => {
    const pair = (n: number): ModelMessage[] => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `toolu_${String(n)}`, toolName: 'look', input: { n } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `toolu_${String(n)}`, toolName: 'look', output: { type: 'text', value: String(n) } }] },
    ];

    const toolParts = (messages: ModelMessage[] | undefined) => (messages ?? []).flatMap((message) => (
      (message.role === 'assistant' || message.role === 'tool') && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
        : []));

    const checkReplay = (messages: ModelMessage[]): void => {
      const parts = toolParts(normalizeReplayForDestination(messages, { providerId: 'openai' }, progress));
      expect(parts.map(({ toolCallId: _toolCallId, ...part }) => part))
        .toEqual(toolParts(messages).map(({ toolCallId: _toolCallId, ...part }) => part));
      const calls = parts.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId);
      const results = parts.filter((part) => part.type === 'tool-result').map((part) => part.toolCallId);
      expect(new Set(calls).size).toBe(calls.length);
      expect(results).toEqual(calls);
    };

    const progress = new ReplayProgress();
    const input: ModelMessage = { role: 'user', content: 'go' };
    let history: ModelMessage[] = [input, ...SOURCE];

    for (let n = 0; n < 4; n++) {
      // A new list a step, its earlier messages the same objects, as each step's history is.
      history = history.concat(pair(n));
      checkReplay(history);
    }

    const woven: ModelMessage = { role: 'user', content: '<dynamic-context>state</dynamic-context>' };
    checkReplay([input, woven, ...history.slice(1)]);
    // One pair edited out of the middle: the remaining results still follow their calls.
    checkReplay([...history.slice(0, 3), ...history.slice(5)]);
    checkReplay(history);
  });
});
