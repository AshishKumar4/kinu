// A step's words reach the caller before the step's record does.
import { expect, test } from 'bun:test';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { createChatModel, runChat } from '../src/index';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

const WORDS = Array.from({ length: 60 }, (_, at) => `word${String(at)} `);

function sse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(''), { headers: SSE_HEADERS });
}

/** Many words, then a call: a relay that reads the stream eagerly pulls the SDK's processor ahead of a caller that reads
 *  slowly. */
function wordyToolStep(): Response {
  return sse([
    ...WORDS.map((word) => JSON.stringify({ choices: [{ delta: { content: word } }] })),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"command":"ls"}' } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]);
}

function answer(): Response {
  return sse([
    JSON.stringify({ choices: [{ delta: { content: 'done' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }),
    '[DONE]',
  ]);
}

// next-rc 0a4fb372f, 2026-10-19: with nothing else pulling the SDK's stream ahead, a head's step record reached its
// workspace before the step's last words, and the words opened a stream of their own after it.
test("a step's record and its step-finish event come after every word the step streamed, however slowly they are read", async () => {
  let calls = 0;

  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls += 1;

      return calls === 1 ? wordyToolStep() : answer();
    },
  });

  const model = createChatModel({
    kind: 'openai-compat', name: 'openrouter', baseURL: `http://localhost:${String(server.port)}/v1`,
    headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
  });

  const tools: ToolSet = {
    run: tool({ description: 'shell', inputSchema: z.object({ command: z.string() }), execute: async ({ command }: { command: string }) => `ran: ${command}` }),
  };

  const seen: string[] = [];

  try {
    for await (const event of runChat({
      modelSpec: 'test/model', model, system: 'sys', history: [{ role: 'user', content: 'go' }], tools,
      onStep: () => { seen.push('record'); },
      // The tabs' relay, which reads the stream as it comes.
      observeStream: async (stream) => { for await (const chunk of stream) void chunk; },
    })) {
      if (event.type === 'text-delta') seen.push('word');

      if (event.type === 'step-finish') seen.push('step-finish');

      // A caller that hands the event loop on between words, as one relaying each word over a call does: no wait for a
      // duration, so the SDK's pipeline runs ahead by what its stages hold, and no further.
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  } finally {
    await server.stop(true);
  }

  const firstStep = seen.slice(0, seen.indexOf('record'));

  expect(firstStep.filter((entry) => entry === 'word')).toHaveLength(WORDS.length);
  expect(seen.indexOf('step-finish')).toBeGreaterThan(seen.lastIndexOf('word', seen.indexOf('record')));
});
