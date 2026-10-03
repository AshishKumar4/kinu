import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { runChat, type ChatEvent } from '../src/chat';
import { createChatModel } from '../src/llm';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { KinuError, renderThrownChain } from '../src/obs/index';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

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
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools, stopWhen: stepCountIs(20),
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
        model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools, stopWhen: stepCountIs(20),
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

test('a scaffold step with no response cannot rewind the durable cursor', () => {
  const recorded: Array<ReadonlyArray<ModelMessage> | undefined> = [];
  const acc = new TurnAccumulator({ onStepEvent: (event) => { recorded.push(event.messages); } });
  const first: ModelMessage = { role: 'assistant', content: 'one' };
  const second: ModelMessage = { role: 'assistant', content: 'two' };
  acc.recordStep({ response: { messages: [first] } });
  acc.recordStep({ response: { messages: [] } });
  acc.recordStep({ response: { messages: [first, second] } });

  expect(recorded).toEqual([[first], undefined, [second]]);
});

test('each streamed step retains the breakdown of its own request', async () => {
  const provider = scriptedProvider([
    () => toolStep('call_a', 'git status'),
    () => textStep('all clean'),
  ]);

  const measured: Array<number | undefined> = [];

  try {
    for await (const event of runChat({
      model: provider.model, system: 'sys', history: [{ role: 'user', content: 'go' }],
      tools, stopWhen: stepCountIs(20), measureContext: true,
      observeStream: async (stream) => { for await (const part of stream) void part; },
    })) {
      if (event.type === 'step-finish') measured.push(event.context?.measuredChars);
    }

    expect(measured).toHaveLength(2);
    expect(measured.every((chars) => chars !== undefined)).toBe(true);
    expect(measured[1]).toBeGreaterThan(measured[0] ?? Infinity);
  } finally { await provider.stop(); }
});
