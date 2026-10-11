import { describe, test, expect } from 'bun:test';
import { isStepCount, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { runChat, type ChatEvent, type StepRecord } from '../src/chat';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createChatModel } from '../src/llm';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { KinuError, renderThrownChain } from '../src/obs/index';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

test('a consumer throwing after a tool result still records the completed native call once', async () => {
  const records: StepRecord[] = [];

  const model = new MockLanguageModelV3({ doStream: async ({ abortSignal }) => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'tool-call', toolCallId: 'kept', toolName: 'save', input: '{"note":"retained"}' });
      // ai 7 runs a step's tools once its model call finishes; the stream itself stays open until the cut.
      controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } });
      abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
    },
  }) }) });

  const consume = async () => {
    for await (const event of runChat({ modelSpec: 'test/model', model, system: 'sys', history: [{ role: 'user', content: 'save the note' }],
      tools: { save: tool({ inputSchema: z.object({ note: z.string() }), execute: async () => ({ written: true }) }) },
      persistStep: async (record) => { records.push(record); },
      observeStream: async chunks => { for await (const part of chunks) void part; },
    })) if (event.type === 'tool-result') throw new Error('the consumer failed after seeing the tool result');
  };

  await expect(consume()).rejects.toThrow('the consumer failed after seeing the tool result');
  expect(records.flatMap((record) => record.toolResults)).toMatchObject([
    { args: { note: 'retained' }, event: { toolCallId: 'kept', toolName: 'save', success: true, output: { written: true } } },
  ]);
});

function sse(events: string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('');
}

function toolStep(id: string, command: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: `about to ${command}` } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

function textStep(text: string): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

const tools: ToolSet = {
  shell: tool({
    description: 'shell',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }: { command: string }) => `ran: ${command}`,
  }),
};

function scriptedProvider(script: ReadonlyArray<() => Response>) {
  let call = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      const at = Math.min(call, script.length - 1);
      call += 1;

      return script[at]?.() ?? textStep('done');
    },
  });

  return {
    requests: () => call,
    model: createChatModel({
      kind: 'openai-compat', name: 'openrouter',
      baseURL: `http://localhost:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
    }),
    stop: () => server.stop(true),
  };
}

describe('a native step seals before its hook and ends on a recording failure', () => {
  test('a step whose durable write fails ends the turn with that failure, and no later step runs', async () => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => textStep('never reached'),
    ]);

    const events: ChatEvent[] = [];
    let outcome = 'the turn finished';

    try {
      for await (const event of runChat({
        modelSpec: 'test/model',
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools, stopWhen: isStepCount(20),
        persistStep: async () => { throw new Error('SQLITE_FULL: database or disk is full'); },
      })) events.push(event);
    } catch (error) {
      outcome = renderThrownChain({ cause: error });
    } finally {
      await provider.stop();
    }

    expect(outcome).toContain('SQLITE_FULL: database or disk is full');
    expect(provider.requests()).toBe(1);
    expect(events.filter((event) => event.type === 'step-finish' || event.type === 'done')).toEqual([]);
  });

  const hookThrows = async (thrown: Error) => {
    const provider = scriptedProvider([
      () => toolStep('call_a', 'git status'),
      () => textStep('never reached'),
    ]);

    const persisted: number[] = [];
    let failed = new KinuError('io', 'the turn finished');

    try {
      for await (const _ of runChat({
        modelSpec: 'test/model',
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools, stopWhen: isStepCount(20),
        persistStep: async (record) => { persisted.push(record.messages.length); },
        onStep: async () => { throw thrown; },
      }));
    } catch (error) {
      if (!(error instanceof KinuError)) throw error;
      failed = error;
    } finally {
      await provider.stop();
    }

    return { failed, persisted, requests: provider.requests() };
  };

  test('a classified hook refusal preserves the recorded step and refuses the next request', async () => {
    const { failed, persisted, requests } = await hookThrows(new KinuError('budget', 'the mission is spent'));

    expect(failed.code).toBe('budget');
    expect(renderThrownChain({ cause: failed })).toContain('the mission is spent');
    expect(persisted).toHaveLength(1);
    expect(requests).toBe(1);
  });

  test('an unclassified hook failure preserves its cause and the step already recorded', async () => {
    const { failed, persisted, requests } = await hookThrows(new Error('the hook tripped over a null'));

    expect(failed.code).toBe('io');
    expect(renderThrownChain({ cause: failed })).toContain('the hook tripped over a null');
    expect(persisted).toHaveLength(1);
    expect(requests).toBe(1);
  });
});

test('a boundary with no sealed output cannot invent or repeat another step\'s references', () => {
  const steps: (readonly { messageId: string; partNo: number }[])[] = [];
  const acc = new TurnAccumulator({ onStepEvent: (event) => { steps.push(event.parts); } });
  const first = { messageId: 'first', partNo: 0 };
  const second = { messageId: 'second', partNo: 0 };

  acc.recordStep({}, [first]);
  acc.recordStep({}, []);
  acc.recordStep({}, [second]);

  expect(steps).toEqual([[first], [], [second]]);
});

test('each streamed step retains the breakdown of its own request', async () => {
  const provider = scriptedProvider([
    () => toolStep('call_a', 'git status'),
    () => textStep('all clean'),
  ]);

  const measured: Array<number | undefined> = [];

  try {
    for await (const event of runChat({
      modelSpec: 'test/model',
      model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
      tools, stopWhen: isStepCount(20), measureContext: true,
      observeStream: async (stream) => { for await (const part of stream) void part; },
    })) {
      if (event.type === 'step-finish') measured.push(event.context?.measuredChars);
    }

    expect(measured).toHaveLength(2);
    expect(measured.every((chars) => chars !== undefined)).toBe(true);
    expect(measured[1]).toBeGreaterThan(measured[0] ?? Infinity);
  } finally { await provider.stop(); }
});

test('each step record keeps the body its request sent, which a cache warm replays', async () => {
  const provider = scriptedProvider([
    () => toolStep('call_a', 'git status'),
    () => textStep('all clean'),
  ]);

  const records: StepRecord[] = [];

  try {
    for await (const _ of runChat({
      modelSpec: 'test/model',
      model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
      tools, stopWhen: isStepCount(20), persistStep: async (record) => { records.push(record); },
    })) { /* drain */ }

    const bodies = records.flatMap((record) => (record.step === undefined ? [] : [JSON.stringify(record.step.request?.body)]));

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('test-model');
    expect(bodies[1]).toContain('git status');
  } finally { await provider.stop(); }
});
