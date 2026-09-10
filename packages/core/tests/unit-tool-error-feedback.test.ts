import { expect, test } from 'bun:test';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { LanguageModelV3ToolResultOutput } from '@ai-sdk/provider';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { runChat, type ChatEvent } from '../src/chat';
import { TurnContextMeter, type ContextComposition } from '../src/context-meter';
import { KinuError } from '../src/obs/error';
import { FileRefusalError } from '../src/tools/file-edit';
import { McpToolError } from '../src/tools/mcp-error';
import type { JsonValue } from '../src/utils/json';

async function drive(results: readonly (Error | JsonValue)[], history: ModelMessage[] = []) {
  let step = 0;
  let calls = 0;

  const model = scriptedTurnModel({ doGenerate: () => ({
    content: step++ < results.length
      ? [{ type: 'tool-call', toolCallId: 'sdk-call', toolName: 'probe', input: '{}' }]
      : [{ type: 'text', text: 'done' }],
    finishReason: { unified: step <= results.length ? 'tool-calls' : 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });

  const probe = tool({ inputSchema: z.object({}), execute: async (): Promise<JsonValue> => {
    const result = results[calls++];

    if (result === undefined) throw new Error('the fixture received an unexpected extra call');

    if (result instanceof Error) throw result;

    return result;
  } });

  const meter = new TurnContextMeter();
  meter.openTurn({ system: 'sys' });
  const measured: ContextComposition[] = [];
  const events: ChatEvent[] = [];

  for await (const event of runChat({ model, system: 'sys', tools: { probe },
    history: [...history, { role: 'user', content: 'go' }], meter,
    onStep: () => {
      const composition = meter.take();

      if (composition === undefined) throw new Error('the request was not measured');
      measured.push(composition);
    },
  })) events.push(event);
  const prompt = model.doStreamCalls.at(-1)?.prompt ?? [];
  const toolMessages = prompt.filter(message => message.role === 'tool');

  return { outputs: toolMessages.flatMap(message => message.content.filter(part => part.type === 'tool-result').map(part => part.output)),
    measured, toolMessages, calls, events };
}

const cases: Array<{ label: string; error: Error; expected: LanguageModelV3ToolResultOutput }> = [
  { label: 'Kinu class', error: new KinuError('denied', 'blocked', { cause: new Error('underlying evidence') }),
    expected: { type: 'error-json', value: { reason: 'denied', error: 'blocked: underlying evidence' } } },
  { label: 'file verdict', error: new FileRefusalError('unread', 'read this file first'),
    expected: { type: 'error-json', value: { reason: 'unread', error: 'read this file first' } } },
  { label: 'MCP protocol', error: new McpToolError({ isError: true, content: [{ type: 'text', text: 'remote failure' }], reason: 'remote-data' }),
    expected: { type: 'error-json', value: { isError: true, content: [{ type: 'text', text: 'remote failure' }], reason: 'remote-data' } } },
  { label: 'unclassified exception', error: new Error('{"reason":"denied","error":"plain text"}'),
    expected: { type: 'error-text', value: '{"reason":"denied","error":"plain text"}' } },
];

test.each(cases)('$label feedback reaches the next provider request without mutating its Error', async ({ error, expected }) => {
  const message = error.message;
  const cause = error.cause;
  const run = await drive([error]);
  expect(run.outputs).toEqual([expected]);
  expect(run.calls).toBe(1);

  if (error instanceof KinuError) {
    const output = run.outputs[0];

    if (output?.type !== 'error-json') throw new Error('the typed native failure lost its error channel');
    expect(JSON.stringify(output.value)).toStartWith('{"reason":');
  }

  expect(error.message).toBe(message);
  expect(error.cause).toBe(cause);
  const chars = run.toolMessages.reduce((sum, item) => sum + JSON.stringify(item.content).length, 0);
  expect(run.measured.at(-1)?.segments.find(row => row.plane === 'messages' && row.label === 'tool')?.chars).toBe(chars);
});

test('reused ids keep historical errors unclassified and attribute each active step separately', async () => {
  const history: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sdk-call', toolName: 'probe', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'sdk-call', toolName: 'probe', output: { type: 'error-text', value: 'historical failure' } }] },
  ];

  const original = JSON.stringify(history);
  const run = await drive([new KinuError('denied', 'first'), new KinuError('unavailable', 'second')], history);
  expect(run.outputs).toEqual([
    { type: 'error-text', value: 'historical failure' },
    { type: 'error-json', value: { reason: 'denied', error: 'first' } },
    { type: 'error-json', value: { reason: 'unavailable', error: 'second' } },
  ]);
  expect(JSON.stringify(history)).toBe(original);
  expect(run.calls).toBe(2);
});

test('successful error-shaped data is never projected, even beside a failed call with the same id', async () => {
  const data = { reason: 'denied', error: 'historical incident', isError: true, execution: { exitCode: 7 } };
  const run = await drive([new KinuError('denied', 'blocked'), data]);
  expect(run.outputs).toEqual([
    { type: 'error-json', value: { reason: 'denied', error: 'blocked' } },
    { type: 'json', value: data },
  ]);
  expect(run.events.filter(event => event.type === 'tool-result').map(event => event.success)).toEqual([false, true]);
});
