// What the owner sees of a model call is read off the chat loop's own reads, not a second branch of the call's stream:
// it is the SDK's own UI stream of the same parts, less the provider's compaction summaries.
import { expect, test } from 'bun:test';
import { isStepCount, streamText, tool, toUIMessageStream, type TextStreamPart, type ToolSet, type UIMessageChunk } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { ChatRelay } from '../src/chat-relay';
import { pulledThrough } from '../src/utils/pulled-stream';

type FinishPart = Extract<LanguageModelV3StreamPart, { type: 'finish' }>;

const USAGE: FinishPart['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const SUMMARY = { anthropic: { type: 'compaction' } };

const tools: ToolSet = {
  run: tool({ description: 'shell', inputSchema: z.object({ command: z.string() }), execute: async ({ command }: { command: string }) => `ran: ${command}` }),
};

/** A summary, words and a call in the first step, an answer in the second, read as the chat loop reads them. */
async function partsOfACall(): Promise<TextStreamPart<ToolSet>[]> {
  let step = 0;

  const model = new MockLanguageModelV3({
    doStream: async () => {
      step += 1;

      const first: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 's1', providerMetadata: SUMMARY },
        { type: 'text-delta', id: 's1', delta: 'The summary.' },
        { type: 'text-end', id: 's1' },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Listing first.' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Looking.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'run', input: '{"command":"ls"}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
      ];

      const second: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Done.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
      ];

      return { stream: convertArrayToReadableStream(step === 1 ? first : second) };
    },
  });

  const parts: TextStreamPart<ToolSet>[] = [];

  for await (const part of streamText({ model, prompt: 'go', tools, stopWhen: isStepCount(2) }).stream) parts.push(part);

  return parts;
}

const describe = (): string => 'The model call failed.';

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const read: T[] = [];

  for await (const chunk of stream) read.push(chunk);

  return read;
}

test("the relay shows the SDK's own UI chunks for the parts the loop read, less the provider's summary", async () => {
  const parts = await partsOfACall();
  const shown: UIMessageChunk[] = [];
  const relay = new ChatRelay(async (chunks) => { shown.push(...await readAll(chunks)); }, { tools, describe });

  for (const part of parts) relay.push(part);
  relay.end();
  await relay.observed;

  const sdk = await readAll(toUIMessageStream({ stream: convertArrayToReadableStream(parts), tools, onError: describe }));
  const ofSummary = (chunk: (typeof sdk)[number]): boolean => 'id' in chunk && chunk.id === 's1';

  expect(shown).toEqual(sdk.filter((chunk) => !ofSummary(chunk)));
  expect(sdk.some(ofSummary)).toBe(true);
});

// Re-review, 2026-10-21: a tool's failure shown live was described as a model call's is, windowed and reworded, so a
// failed program's record in its words was not what the owner saw until a reload.
test("a tool's failure is shown live as it is stored, a failed program's record whole in its words", async () => {
  const shown: UIMessageChunk[] = [];
  const relay = new ChatRelay(async (chunks) => { shown.push(...await readAll(chunks)); }, { tools, describe });
  const files = Array.from({ length: 12 }, (_, n) => ({ path: `notes/plan-${String(n)}.md`, change: 'created' }));
  const words = JSON.stringify({ success: false, reason: null, error: 'half done', effects: { call: 'c1', files } });

  relay.push({ type: 'tool-error', toolCallId: 'c1', toolName: 'run', input: { command: 'ls' }, error: new Error(words) });
  relay.end();
  await relay.observed;

  expect(shown).toEqual([expect.objectContaining({ type: 'tool-output-error', toolCallId: 'c1', errorText: words })]);
});

test('a call that failed fails what the owner reads, after what was queued; one the owner let go queues nothing', async () => {
  const [first] = await partsOfACall();

  if (first === undefined) throw new Error('the call streamed no part');
  const read: UIMessageChunk[] = [];

  const failed = new ChatRelay(async (chunks) => { for await (const chunk of chunks) read.push(chunk); }, { tools, describe });

  failed.push(first);
  failed.end({ error: new Error('the provider reset the connection') });

  await expect(failed.observed).rejects.toThrow('the provider reset the connection');
  expect(read).toHaveLength(1);

  const dropped = new ChatRelay(async (chunks) => { await chunks.cancel('the tab closed'); }, { tools, describe });

  await dropped.observed;
  dropped.push(first);
  dropped.end();

  const unobserved = new ChatRelay(undefined, { tools, describe });

  unobserved.push(first);
  unobserved.end();
  await unobserved.observed;
});

test('a pulled stage maps and drops each chunk as it is read, fails with its source, and lets its source go', async () => {
  expect(await readAll(pulledThrough(convertArrayToReadableStream([1, 2, 3, 4]), (n) => (n % 2 === 0 ? `even ${String(n)}` : undefined))))
    .toEqual(['even 2', 'even 4']);

  const failing = new ReadableStream<number>({ pull: (controller) => { controller.error(new Error('the source broke')); } });

  await expect(readAll(pulledThrough(failing, (n) => n))).rejects.toThrow('the source broke');

  const reasons: string[] = [];
  const source = new ReadableStream<number>({ pull: (controller) => { controller.enqueue(1); }, cancel: (reason: string) => { reasons.push(reason); } });

  await pulledThrough(source, (n) => n).cancel('the reader left');
  expect(reasons).toEqual(['the reader left']);
});
