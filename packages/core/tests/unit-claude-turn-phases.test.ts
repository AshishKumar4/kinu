// A Claude turn's one-call steps make one phase, live and on reload. Production, 2026-10-23: the owner's Claude Opus
// turn drew each `shell` call as its own row. Every step of a turn on Anthropic's provider carries a `custom` part
// (`anthropic.message_start`, the provider's own record of the step: its id, model and opening usage), and the chat took
// it as a part of the answer, which ends a run of calls. Its steps here are as the owner's turn stored them
// (hearthlit-field-04d5879b): the record, empty reasoning signed by Anthropic, and the call.
import { expect, test } from 'bun:test';
import { isStepCount, readUIMessageStream, streamText, tool, validateUIMessages, type TextStreamPart, type ToolSet, type UIMessage, type UIMessageChunk } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { ChatRelay } from '../src/chat-relay';
import { groupMessageParts } from '../src/read-models/tool-call-grouping';
import { drawnStep } from '../src/session/transcript';
import * as v from 'valibot';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../src/utils/json';

type FinishPart = Extract<LanguageModelV4StreamPart, { type: 'finish' }>;

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const CALLS = ['git log -3', 'sed -n 1,40p a.ts', 'git grep -n openingRow'];

const tools: ToolSet = {
  shell: tool({ description: 'shell', inputSchema: z.object({ command: z.string() }), execute: async ({ command }: { command: string }) => `ran: ${command}` }),
};

/** Anthropic's record of a step, as `@ai-sdk/anthropic` streams it on each `message_start`. */
const messageStart = (step: number) => ({ anthropic: { id: `msg_${String(step)}`, model: 'claude-opus-5-5', usage: { input_tokens: 4, output_tokens: 7 } } });

const SIGNED = { anthropic: { signature: 'signed-thinking' } };

function claudeStep(step: number): LanguageModelV4StreamPart[] {
  const command = CALLS[step] ?? '';

  return [
    { type: 'stream-start', warnings: [] },
    { type: 'custom', kind: 'anthropic.message_start', providerMetadata: messageStart(step) },
    { type: 'reasoning-start', id: `r${String(step)}`, providerMetadata: SIGNED },
    { type: 'reasoning-end', id: `r${String(step)}`, providerMetadata: SIGNED },
    { type: 'tool-call', toolCallId: `c${String(step)}`, toolName: 'shell', input: JSON.stringify({ command }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
  ];
}

const ANSWER: LanguageModelV4StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'custom', kind: 'anthropic.message_start', providerMetadata: messageStart(CALLS.length) },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'Found it.' },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
];

/** Three one-call steps and an answer, as the chat loop reads them; with the steps' response messages, as stored. */
async function claudeTurn(): Promise<{ readonly parts: TextStreamPart<ToolSet>[]; readonly stored: readonly JsonValue[][] }> {
  let step = 0;

  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = step < CALLS.length ? claudeStep(step) : ANSWER;

      step += 1;

      return { stream: convertArrayToReadableStream(parts) };
    },
  });

  const parts: TextStreamPart<ToolSet>[] = [];
  const result = streamText({ model, prompt: 'go', tools, stopWhen: isStepCount(CALLS.length + 1) });

  for await (const part of result.stream) parts.push(part);

  const steps = await result.steps;

  return { parts, stored: steps.map((each) => v.parse(v.array(JsonValueSchema), parseJsonValue(JSON.stringify(each.response.messages)))) };
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const read: T[] = [];

  for await (const chunk of stream) read.push(chunk);

  return read;
}

/** The answer the owner's tab assembles from what the relay sends it. */
async function shownLive(parts: readonly TextStreamPart<ToolSet>[]): Promise<UIMessage> {
  const shown: UIMessageChunk[] = [];
  const relay = new ChatRelay(async (chunks) => { shown.push(...await readAll(chunks)); }, { tools, describe: () => 'failed' });

  for (const part of parts) relay.push(part);
  relay.end();
  await relay.observed;

  const start: UIMessageChunk = { type: 'start' };
  const finish: UIMessageChunk = { type: 'finish' };
  let message: UIMessage | undefined;

  for await (const read of readUIMessageStream({ stream: convertArrayToReadableStream([start, ...shown, finish]) })) message = read;

  if (message === undefined) return { id: 'none', role: 'assistant', parts: [] };

  return message;
}

/** How many calls each run of the answer holds: one run of three is one phase. */
const runs = (parts: UIMessage['parts']): number[] => groupMessageParts(parts)
  .flatMap((block) => (block.kind === 'run' ? [block.steps.filter((step) => step.kind === 'tool').length] : []));

test("live, a Claude turn's one-call steps are one phase, and the provider's record of each step is not a part", async () => {
  const { parts } = await claudeTurn();
  const message = await shownLive(parts);

  expect(parts.filter((part) => part.type === 'custom')).toHaveLength(CALLS.length + 1);
  expect(message.parts.map((part) => part.type)).not.toContain('custom');
  expect(runs(message.parts)).toEqual([CALLS.length]);
});

test("reloaded, the stored steps draw the same one phase", async () => {
  const { stored } = await claudeTurn();
  const drawn = stored.flatMap((messages) => drawnStep(messages));
  const [message] = await validateUIMessages({ messages: [{ id: 'answer', role: 'assistant', parts: drawn }] });

  expect(stored.flat().some((each) => JSON.stringify(each).includes('anthropic.message_start'))).toBe(true);
  expect(drawn.map((part) => part.type)).not.toContain('custom');
  expect(runs(message?.parts ?? [])).toEqual([CALLS.length]);
});

// #125 (2026-10-25): any part the chat draws nothing of ended a phase, as the provider's record did above; a source or
// a data part between one-call steps split the phase into rows the same way.
test("a part the chat draws nothing of, between one-call steps, leaves them one phase", async () => {
  const { parts } = await claudeTurn();
  const message = await shownLive(parts);

  const between: UIMessage['parts'] = [
    { type: 'source-url', sourceId: 's', url: 'https://example.com' },
    { type: 'data-kinu-note', data: { at: 1 } },
  ];

  const spliced = message.parts.flatMap((part) => (part.type === 'step-start' ? [...between, part] : [part]));

  expect(runs(spliced)).toEqual([CALLS.length]);
  // The phase, then the answer: nothing of its own for either part.
  expect(groupMessageParts(spliced).map((block) => block.kind)).toEqual(['run', 'part']);
});
