// A dead provider stream must fail the turn, never fake-complete it.
//
// Observed in the bench (circuit-fibsqrt, 2026-08-08): mid-task, a request
// went silent for ~4 minutes and then the remote closed the socket with no
// frames sent. The AI SDK records that as a normal EMPTY step (finishReason
// 'other', no content) and ends the loop as if the model chose to stop —
// the turn "completed" with hadError:false after 2 steps of a 100+-step
// task. Had the remote NOT closed the socket, nothing in the stack bounds
// the wait (the SDK's chunk timeout only arms after a first chunk), so the
// same failure's non-self-resolving variant stalls the turn indefinitely.
//
// These tests drive runChat through the REAL openai-compatible provider
// against a local scripted server (no live model calls) and pin the
// contract: a model-chosen stop ends the turn; a dead or stalled stream
// throws so the caller records the failure.
import { describe, test, expect } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { runChat, createChatModel, type ChatEvent } from '../src/index.ts';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

/** Step 1: text + one `run` tool call, finishing normally on tool_calls. */
function healthyToolStep(): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: 'Let me look' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"command":"wc -l"}' } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

async function driveTurn(
  step2: () => Response,
  opts: { stallTimeoutMs?: number; step1?: () => Response; maxSteps?: number } = {},
) {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      call += 1;
      return call === 1 ? (opts.step1 ?? healthyToolStep)() : step2();
    },
  });
  const model = createChatModel({
    kind: 'openai-compat', name: 'openrouter',
    baseURL: `http://localhost:${server.port}/v1`,
    headers: { Authorization: 'Bearer test' }, modelId: 'test-model',
  });
  const tools = {
    run: tool({
      description: 'shell',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }: { command: string }) => `ran: ${command}`,
    }),
  };
  const events: ChatEvent[] = [];
  let threw: Error | null = null;
  try {
    for await (const ev of runChat({
      model, system: 'sys', history: [{ role: 'user', content: 'go' }],
      tools: tools as never, maxSteps: opts.maxSteps ?? 500,
      ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
    })) events.push(ev);
  } catch (e) {
    threw = e instanceof Error ? e : new Error(String(e));
  } finally {
    server.stop(true);
  }
  return { events, threw, done: events.find((e) => e.type === 'done') };
}

describe('dead provider stream fails the turn', () => {
  test('an empty SSE close mid-task throws instead of fake-completing', async () => {
    const { threw, done } = await driveTurn(() => new Response('', { headers: SSE_HEADERS }));
    expect(done).toBeUndefined();
    expect(threw?.message ?? '').toContain('terminated prematurely');
  });

  test('a [DONE]-only SSE mid-task throws instead of fake-completing', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse(['[DONE]']), { headers: SSE_HEADERS }));
    expect(done).toBeUndefined();
    expect(threw?.message ?? '').toContain('terminated prematurely');
  });

  test('a model-chosen stop with text still completes the turn', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));
    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('answer');
  });

  test('a model-chosen stop WITHOUT content is still a completion, not an error', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));
    expect(threw).toBeNull();
    expect(done).toBeDefined();
  });
});

// The detector fires on the CONJUNCTION of an unmapped finish reason and an
// empty step. The cases above cover unmapped+empty (dead) and mapped+content
// (alive); these are the two remaining cells, and they are the ones that would
// take real turns down if the detector ever widened to the reason alone.
// 'other' and 'unknown' are routine for several providers.
describe('an unmapped finish reason alone is not a dead stream', () => {
  test('a step that produced TEXT and finished on "other" completes normally', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: { content: 'a real answer' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'other' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));

    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('a real answer');
  });

  test('a FINAL step whose only output was a TOOL CALL survives an unmapped reason', async () => {
    // A tool-call step legitimately emits no text, so it is the step most
    // easily mistaken for empty. It has to be the LAST step to be worth
    // asserting — the dead-stream verdict is read once, after the loop, so a
    // mid-turn step could not exercise it and the case would be untestable.
    const toolStepEndingOnOther = () => new Response(sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'tc9', type: 'function', function: { name: 'run', arguments: '{"command":"ls"}' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'other' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS });

    const { threw, events } = await driveTurn(
      () => { throw new Error('the turn must stop after one step'); },
      { step1: toolStepEndingOnOther, maxSteps: 1 },
    );

    expect(threw).toBeNull();
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
  });
});

describe('stalled provider stream aborts the turn', () => {
  test('a stream that never sends anything is aborted by the stall watchdog', async () => {
    const t0 = performance.now();
    const { threw, done } = await driveTurn(
      () => new Response(new ReadableStream({ start() { /* stall forever */ } }), { headers: SSE_HEADERS }),
      { stallTimeoutMs: 400 },
    );
    expect(done).toBeUndefined();
    expect(threw?.message ?? '').toContain('stalled');
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 15_000);

  test('a slow but live stream does not trip the watchdog', async () => {
    const enc = new TextEncoder();
    const { threw, done } = await driveTurn(
      () => new Response(new ReadableStream({
        async start(c) {
          await new Promise((r) => setTimeout(r, 200));
          c.enqueue(enc.encode(sse([JSON.stringify({ choices: [{ delta: { content: 'slow' } }] })])));
          await new Promise((r) => setTimeout(r, 200));
          c.enqueue(enc.encode(sse([
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }),
            '[DONE]',
          ])));
          c.close();
        },
      }), { headers: SSE_HEADERS }),
      { stallTimeoutMs: 1_000 },
    );
    expect(threw).toBeNull();
    expect(done).toBeDefined();
  }, 15_000);
});
