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

    expect(call?.type === 'tool-call' && call.toolCallId).toBe('kinu-i-1');
    expect(result?.type === 'tool-result' && result.toolCallId).toBe('kinu-i-1');
    expect(SOURCE[0]?.role === 'assistant' && Array.isArray(SOURCE[0].content)
      ? SOURCE[0].content.find((part) => part.type === 'tool-call')?.toolCallId
      : undefined).toBe('toolu_01SOURCE');
  });

  test('is deterministic and leaves a text-only request untouched', () => {
    const once = normalizeReplayForDestination(SOURCE, { providerId: 'anthropic' });
    const twice = normalizeReplayForDestination(SOURCE, { providerId: 'anthropic' });
    expect(once).toEqual(twice);
    const textOnly: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    expect(normalizeReplayForDestination(textOnly, { providerId: 'openai' })).toBeUndefined();
    expect(normalizeReplayForDestination(SOURCE, undefined)).toBeUndefined();
  });

  test('a turn resumed step by step keeps each result on its call, numbered in call order, through woven blocks and edits', () => {
    const pair = (n: number): ModelMessage[] => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `toolu_${String(n)}`, toolName: 'look', input: { n } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `toolu_${String(n)}`, toolName: 'look', output: { type: 'text', value: String(n) } }] },
    ];

    const sent = (messages: ModelMessage[] | undefined): string[] => (messages ?? []).flatMap((message) => (
      (message.role === 'assistant' || message.role === 'tool') && Array.isArray(message.content) ? message.content.flatMap((part) => (
        part.type === 'tool-call' || part.type === 'tool-result' ? [`${part.type}:${part.toolCallId}`] : [])) : []));

    const numbered = (calls: number): string[] => Array.from({ length: calls }, (_, index) => [`tool-call:kinu-i-${String(index + 1)}`, `tool-result:kinu-i-${String(index + 1)}`]).flat();
    const progress = new ReplayProgress();
    const input: ModelMessage = { role: 'user', content: 'go' };
    let history: ModelMessage[] = [input, ...SOURCE];

    for (let n = 0; n < 4; n++) {
      // A new list a step, its earlier messages the same objects, as each step's history is.
      history = history.concat(pair(n));
      expect(sent(normalizeReplayForDestination(history, { providerId: 'openai' }, progress))).toEqual(numbered(n + 2));
    }

    const woven: ModelMessage = { role: 'user', content: '<dynamic-context>state</dynamic-context>' };
    expect(sent(normalizeReplayForDestination([input, woven, ...history.slice(1)], { providerId: 'openai' }, progress))).toEqual(numbered(5));
    // One pair edited out of the middle: the calls after it renumber, each result still on its call.
    expect(sent(normalizeReplayForDestination([...history.slice(0, 3), ...history.slice(5)], { providerId: 'openai' }, progress))).toEqual(numbered(4));
    expect(sent(normalizeReplayForDestination(history, { providerId: 'openai' }, progress))).toEqual(numbered(5));
  });
});
