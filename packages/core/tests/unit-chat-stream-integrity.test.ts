// The shared turn has no elapsed deadline; a stream that closes without a finish reason must not fake-complete.
import { describe, test, expect } from 'bun:test';
import { stepCountIs, tool, type StopCondition, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  INTERRUPTED_TURN, runChat, createChatModel, isRateLimitedTurnError,
  type ChatEvent,
} from '../src/index';

/** Spelled out rather than imported, so rewording either sentence fails this file. */
const STALLED_OPENING = 'Turn stalled:';

const RATE_LIMITED_OPENING = 'Turn ended by provider rate limiting:';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

function healthyToolStep(): Response {
  return new Response(sse([
    JSON.stringify({ choices: [{ delta: { content: 'Let me look' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'tc1', type: 'function', function: { name: 'shell', arguments: '{"command":"wc -l"}' } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    '[DONE]',
  ]), { headers: SSE_HEADERS });
}

async function driveTurn(
  step2: () => Response,
  opts: {
    step1?: () => Response;
    stopWhen?: StopCondition<ToolSet>;
    signal?: AbortSignal;
    onEvent?: (event: ChatEvent) => void;
  } = {},
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

  const tools: ToolSet = {
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
      tools,
      stopWhen: opts.stopWhen,
      signal: opts.signal,
    })) {
      events.push(ev);
      opts.onEvent?.(ev);
    }
  } catch (e) {
    threw = e instanceof Error ? e : new Error(String(e));
  } finally {
    await server.stop(true);
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

  const finished = [
    { name: 'a model-chosen stop with text still completes the turn', text: 'answer', reason: 'stop' },
  ] as const;

  for (const step of finished) {
    test(step.name, async () => {
      const { threw, done } = await driveTurn(() => new Response(sse([
        JSON.stringify({ choices: [{ delta: { content: step.text } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: step.reason }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }),
        '[DONE]',
      ]), { headers: SSE_HEADERS }));

      expect(threw).toBeNull();
      expect(done && done.type === 'done' ? done.text : '').toContain(step.text);
    });
  }

  test('a model-chosen stop WITHOUT content is still a completion, not an error', async () => {
    const { threw, done } = await driveTurn(() => new Response(sse([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS }));

    expect(threw).toBeNull();
    expect(done?.type).toBe('done');
  });
});

// The detector needs an unmapped reason and an empty step together: 'other'/'unknown' are routine for several providers.
describe('an unmapped finish reason alone is not a dead stream', () => {
  test('a FINAL step whose only output was a TOOL CALL survives an unmapped reason', async () => {
    // A tool-call step emits no text; it must be the last step because the verdict is read after the loop.
    const toolStepEndingOnOther = () => new Response(sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'tc9', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
      ] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'other' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      '[DONE]',
    ]), { headers: SSE_HEADERS });

    const { threw, events } = await driveTurn(
      () => { throw new Error('the turn must stop after one step'); },
      { step1: toolStepEndingOnOther, stopWhen: stepCountIs(1) },
    );

    expect(threw).toBeNull();
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
  });
});

describe('a stream has no elapsed deadline', () => {
  test('an arbitrarily delayed active stream stays pending until it completes', async () => {
    const started = Promise.withResolvers<void>();
    const enc = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    const pending = driveTurn(() => new Response(new ReadableStream({
      start(c) {
        controller = c;
        c.enqueue(enc.encode(sse([
          JSON.stringify({ choices: [{ delta: { content: 'started' } }] }),
        ])));
        started.resolve();
      },
    }), { headers: SSE_HEADERS }));

    let settled = false;
    const settledPending = pending.finally(() => { settled = true; });

    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    controller?.enqueue(enc.encode(sse([
      JSON.stringify({ choices: [{ delta: { content: ' and completed' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }),
      '[DONE]',
    ])));
    controller?.close();

    const { threw, done } = await settledPending;
    expect(threw).toBeNull();
    expect(done && done.type === 'done' ? done.text : '').toContain('started and completed');
  });

  test('explicit user cancellation ends a pending active stream and keeps its partial turn', async () => {
    const started = Promise.withResolvers<void>();
    const sawPartial = Promise.withResolvers<void>();
    const enc = new TextEncoder();
    const abort = new AbortController();

    const pending = driveTurn(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sse([
          JSON.stringify({ choices: [{ delta: { content: 'partial work' } }] }),
        ])));
        started.resolve();
      },
    }), { headers: SSE_HEADERS }), {
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === 'text-delta' && event.delta.includes('partial work')) sawPartial.resolve();
      },
    });

    await started.promise;
    await sawPartial.promise;
    abort.abort(new Error('cancelled by user'));
    const { threw, done } = await pending;

    expect(done && done.type === 'done' ? done.text : '').toContain('partial work');
    expect(threw?.message).toBe(INTERRUPTED_TURN);
  });
});

describe('definitive provider failures propagate', () => {
  test('the provider error reaches the caller instead of becoming a timeout retry', async () => {
    const { threw, done } = await driveTurn(() => new Response(JSON.stringify({
      error: { message: 'definitive upstream failure', type: 'transport_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    expect(done).toBeUndefined();
    // Only closed facts (HTTP status, provider error type), never provider prose (KINU-043).
    expect(threw?.message ?? '').toContain('the provider refused the request');
    expect(threw?.message ?? '').toContain('400');
    expect(threw?.message ?? '').toContain('transport_error');
    expect(threw?.message ?? '').not.toContain('definitive upstream failure');
  });
});

describe('failure prose persisted by a node stays classifiable', () => {
  test('the classifier reads a reason from the chain a node persisted', () => {
    expect(isRateLimitedTurnError(
      `run agent n1 to a report: ${RATE_LIMITED_OPENING} the provider asked this turn to wait 60s`,
    )).toBe(true);
    expect(isRateLimitedTurnError(
      `run agent n1 to a report: ${STALLED_OPENING} nothing flowed for 300s`,
    )).toBe(false);
  });
});
