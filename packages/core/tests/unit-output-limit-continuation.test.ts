// KINU-041: a provider `length` finish is owed exactly one continuation, with no completed tool call replayed.
import { describe, test, expect } from 'bun:test';
import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, type ChatEvent } from '../src/chat';
import {
  OUTPUT_LIMIT_REACHED, owesOutputLimitContinuation,
} from '../src/orchestrator/turn-lifecycle';

type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

type UnifiedFinish = FinishPart['finishReason']['unified'];

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

function finish(reason: UnifiedFinish): FinishPart {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage: USAGE };
}

function textStream(parts: readonly LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });

      for (const part of parts) c.enqueue(part);
      c.close();
    },
  });
}

function text(id: string, delta: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
  ];
}

/** Plays one scripted stream per request and records each request's prompt. */
function scriptedModel(scripts: ReadonlyArray<readonly LanguageModelV3StreamPart[]>) {
  const prompts: LanguageModelV3Prompt[] = [];
  let call = 0;

  const model = new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options: LanguageModelV3CallOptions) => {
      prompts.push(options.prompt);
      const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
      call += 1;

      return { stream: textStream(script), response: { headers: {} } };
    },
  });

  return { model, prompts };
}

async function drain(model: LanguageModel, tools: ToolSet = {}): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];

  for await (const ev of runChat({
    model,
    system: 'sys',
    history: [{ role: 'user', content: 'write the long thing' }] satisfies ModelMessage[],
    tools,
  })) {
    events.push(ev);
  }

  return events;
}

function roles(prompt: LanguageModelV3Prompt): string[] {
  return prompt.map((message) => message.role);
}

function partTypes(prompt: LanguageModelV3Prompt): string[] {
  return prompt.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.map((part) => part.type)
      : ['text']);
}

describe('output-limit continuation', () => {
  test('truncated prose is continued once, over the same prefix plus what it produced', async () => {
    const { model, prompts } = scriptedModel([
      [...text('t1', 'first half'), finish('length')],
      [...text('t2', ' second half'), finish('stop')],
    ]);

    const events = await drain(model);
    const done = events.find((e) => e.type === 'done');

    expect(prompts.length).toBe(2);
    expect(done?.type === 'done' && done.text).toBe('first half second half');
    expect(roles(prompts[0] ?? [])).toEqual(['system', 'user']);
    expect(roles(prompts[1] ?? [])).toEqual(['system', 'user', 'assistant']);
    const produced = done?.type === 'done' ? done.responseMessages : [];
    expect(produced.filter((m) => m.role === 'assistant').length).toBe(2);
  });

  test('a narrated multi-step turn answers with its FINAL step, not everything it said', async () => {
    let looked = 0;

    const tools: ToolSet = {
      look: tool({
        description: 'look something up',
        inputSchema: z.object({}),
        execute: async () => {
          looked += 1;

          return 'looked';
        },
      }),
    };

    const { model } = scriptedModel([
      [...text('n1', "I'll look at the workspace first."),
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'look', input: '{}' }, finish('tool-calls')],
      [...text('n2', 'Files in place. Starting the preview.'),
        { type: 'tool-call', toolCallId: 'tc2', toolName: 'look', input: '{}' }, finish('tool-calls')],
      [...text('a1', 'pong\n\nhttps://preview.invalid/'), finish('stop')],
    ]);

    const events = await drain(model, tools);
    const done = events.find((e) => e.type === 'done');

    expect(looked).toBe(2);
    expect(done?.type === 'done' && done.text).toBe('pong\n\nhttps://preview.invalid/');
    expect(events.flatMap((e) => e.type === 'text-delta' ? [e.delta] : [])).toEqual([
      "I'll look at the workspace first.",
      'Files in place. Starting the preview.',
      'pong\n\nhttps://preview.invalid/',
    ]);
  });

  test('a narration step cut at the limit with a completed call is not joined into the answer', async () => {
    const tools: ToolSet = {
      look: tool({ description: 'look', inputSchema: z.object({}), execute: async () => 'looked' }),
    };

    const { model } = scriptedModel([
      [...text('n1', 'Looking first, and the narration ran long'),
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'look', input: '{}' }, finish('length')],
      [...text('a1', 'the answer'), finish('stop')],
    ]);

    const events = await drain(model, tools);
    const done = events.find((e) => e.type === 'done');

    expect(done?.type === 'done' && done.text).toBe('the answer');
  });

  test('an output limit after a completed tool continues without replaying the call', async () => {
    let executions = 0;

    const tools: ToolSet = {
      look: tool({
        description: 'look something up',
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          executions += 1;

          return 'the answer is 41';
        },
      }),
    };

    const { model, prompts } = scriptedModel([
      [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'look', input: '{}' }, finish('tool-calls')],
      [...text('t1', 'the tool said'), finish('length')],
      [...text('t2', ' 41, and here is the rest'), finish('stop')],
    ]);

    const events = await drain(model, tools);
    const done = events.find((e) => e.type === 'done');

    expect(prompts.length).toBe(3);
    expect(done?.type === 'done' && done.text).toBe('the tool said 41, and here is the rest');
    // The completed call rides as history paired with its result, so the tool never runs twice.
    expect(executions).toBe(1);
    expect(partTypes(prompts[2] ?? [])).toContain('tool-call');
    expect(partTypes(prompts[2] ?? [])).toContain('tool-result');
    expect(events.filter((e) => e.type === 'tool-call').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool-result').length).toBe(1);
  });

  test('a second output limit is partial completion, not another request', async () => {
    const { model, prompts } = scriptedModel([
      [...text('t1', 'part one'), finish('length')],
      [...text('t2', ' part two'), finish('length')],
      [...text('t3', ' never asked for'), finish('stop')],
    ]);

    const events = await drain(model);
    const done = events.find((e) => e.type === 'done');

    expect(prompts.length).toBe(2);
    expect(done?.type === 'done' && done.text).toBe('part one part two');
  });

  test('a model that finished on its own is not continued', async () => {
    const { model, prompts } = scriptedModel([
      [...text('t1', 'the whole answer'), finish('stop')],
      [...text('t2', ' spurious'), finish('stop')],
    ]);

    const events = await drain(model);
    const done = events.find((e) => e.type === 'done');

    expect(prompts.length).toBe(1);
    expect(done?.type === 'done' && done.text).toBe('the whole answer');
  });

  test('the finish reason the continuation reads is the SDK-mapped one', () => {
    // The adapter normalizes `max_tokens`, `MAX_TOKENS` and `length` onto this one word.
    expect(OUTPUT_LIMIT_REACHED).toBe('length');
  });
});

/** Think's loop cannot extend a `length` finish, so the cloud backend asks this same predicate for a continuation turn. */
describe('the continuation a loop cannot run inside its turn', () => {
  const cut = {
    completed: true, lastFinishReason: OUTPUT_LIMIT_REACHED, turnWasContinuation: false,
  };

  test('a completed turn cut at the output limit owes one', () => {
    expect(owesOutputLimitContinuation(cut)).toBe(true);
  });

  test('a turn that finished on its own owes none', () => {
    expect(owesOutputLimitContinuation({ ...cut, lastFinishReason: 'stop' })).toBe(false);
    // Mid-work is the other impossible ending (TURN_ENDED_MID_WORK), not an answer to finish.
    expect(owesOutputLimitContinuation({ ...cut, lastFinishReason: 'tool-calls' })).toBe(false);
    expect(owesOutputLimitContinuation({ ...cut, lastFinishReason: undefined })).toBe(false);
  });

  test('a turn that did not reach its own end owes none', () => {
    // A cut turn was stopped by its owner and a failed one has overflow recovery.
    expect(owesOutputLimitContinuation({ ...cut, completed: false })).toBe(false);
  });

  test('the allowance is exactly one, whichever way the continuation arrived', () => {
    expect(owesOutputLimitContinuation({ ...cut, turnWasContinuation: true })).toBe(false);
  });
});
