import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { runChat } from '../src/index';

test('the shared chat driver, given no stop condition, completes work beyond ten tool steps', async () => {
  let calls = 0;
  let executed = 0;

  const model = scriptedTurnModel({
    doGenerate: () => {
      const working = calls++ < 14;

      return {
        content: working
          ? [{ type: 'tool-call', toolCallId: String(calls), toolName: 'advance', input: '{}' }]
          : [{ type: 'text', text: 'work complete' }],
        finishReason: { unified: working ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  let answer = '';

  for await (const event of runChat({
    modelSpec: 'test/model',
    model, system: 'Complete the work.', history: [{ role: 'user', content: 'go' }],
    tools: { advance: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: async () => ++executed }) },
  })) {
    if (event.type === 'text-delta') answer += event.delta;
  }

  expect(executed).toBe(14);
  expect(answer).toBe('work complete');
});

