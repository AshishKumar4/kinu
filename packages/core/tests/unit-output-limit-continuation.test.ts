// KINU-041. A model response that ends because the PROVIDER cut it at its
// output limit was accepted as the turn's answer: `runChat` read the mapped
// finish reason only to detect a dead stream ('other'), and the AI SDK's own
// loop re-issues a request only while a step ended with tool calls whose
// outputs all landed. So a `length` finish with no pending call ended the loop
// and the turn published truncated prose — and, when the truncation landed
// after a completed tool result, published a turn whose actual work was never
// done.
//
// These tests drive the public `runChat` against a mock provider that reports
// `length`, and assert the continuation the turn is owed: exactly one, over the
// same prefix plus what the turn already produced, with no completed tool call
// replayed, and a second `length` accepted as honest partial completion rather
// than continued forever.
import { describe, test, expect } from 'bun:test';
import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { runChat, type ChatEvent } from '../src/chat';
import { OUTPUT_LIMIT_REACHED } from '../src/orchestrator/turn-lifecycle';

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

/** A mock provider that plays one scripted stream per request and records the
 *  prompt each request carried — the evidence for what a continuation replays
 *  and what it does not. */
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

/** Every role in one converted request, in order — enough to say what a
 *  continuation was handed. */
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
    // The turn is ONE answer: the continuation's text is appended, not replacing.
    expect(done?.type === 'done' && done.text).toBe('first half second half');
    // The second request is the first request's prefix plus the truncated
    // assistant message the turn already produced.
    expect(roles(prompts[0] ?? [])).toEqual(['system', 'user']);
    expect(roles(prompts[1] ?? [])).toEqual(['system', 'user', 'assistant']);
    // Both halves ride the durable history the caller persists.
    const produced = done?.type === 'done' ? done.responseMessages : [];
    expect(produced.filter((m) => m.role === 'assistant').length).toBe(2);
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
      // Step 1: the model calls the tool. Step 2: it starts reporting and the
      // provider cuts it at the output limit.
      [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'look', input: '{}' }, finish('tool-calls')],
      [...text('t1', 'the tool said'), finish('length')],
      [...text('t2', ' 41, and here is the rest'), finish('stop')],
    ]);

    const events = await drain(model, tools);
    const done = events.find((e) => e.type === 'done');

    // Two requests inside the SDK's own loop, then exactly one continuation.
    expect(prompts.length).toBe(3);
    expect(done?.type === 'done' && done.text).toBe('the tool said 41, and here is the rest');
    // THE POINT: the completed call is carried as history, paired with its
    // result, so the SDK sees it as finished and the tool never runs twice.
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
    // Everything the turn produced is kept, and nothing beyond the second call
    // was requested.
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
    // Not a provider payload string: the adapter normalizes `max_tokens`,
    // `MAX_TOKENS` and `length` onto this one word, which is why detection reads
    // it rather than matching on the endpoint's own prose.
    expect(OUTPUT_LIMIT_REACHED).toBe('length');
  });
});
