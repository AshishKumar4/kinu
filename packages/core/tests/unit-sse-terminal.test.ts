/**
 * `withSseTerminal`: end an SSE stream at `data: [DONE]` with the upstream reader cancelled, and give up on a
 * producer that holds the socket open while sending no content.
 */
import { describe, test, expect } from 'bun:test';
import { handClock } from '@kinu.run/test-utils';
import { withSseTerminal } from '../src/providers/sse-terminal';
import { asFetchFunction } from '../src/providers/fetch-shim';
import type { Clock } from '../src/types/clock';

const encoder = new TextEncoder();

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

interface Scripted {
  calls: string[];
  stream: ReadableStream<Uint8Array>;
  enqueue: (text: string) => void;
  close: () => void;
}

/** An upstream the test owns: scripted bytes, then the case's lifecycle, with cancel calls counted. */
function scripted(cancel?: () => Promise<void> | void): Scripted {
  const calls: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      calls.push('cancelled');

      if (cancel !== undefined) return cancel();
    },
  });

  return {
    calls,
    stream,
    enqueue: (text: string) => {
      controller?.enqueue(encoder.encode(text));
    },
    close: () => {
      controller?.close();
    },
  };
}

function eventStream(upstream: Scripted): Response {
  return new Response(upstream.stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    text += decoder.decode(next.value, { stream: true });
  }

  text += decoder.decode();
  reader.releaseLock();

  return text;
}

async function through(upstream: Scripted): Promise<Response> {
  const fetchImpl = asFetchFunction(async () => eventStream(upstream));

  return withSseTerminal(fetchImpl)('http://fake.invalid/v1/chat/completions');
}

/** The wrapper over a scripted upstream on a clock the test advances. */
function throughClock(upstream: Scripted, clock: Clock): Promise<Response> {
  const fetchImpl = asFetchFunction(async () => eventStream(upstream));

  return withSseTerminal(fetchImpl, clock)('http://fake.invalid/v1/chat/completions');
}

/** One whole SSE message off the wrapper, which forwards a line at a time. */
async function readMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const next = await reader.read();

    if (next.done || text.endsWith('\n\n')) return text;

    text += decoder.decode(next.value, { stream: true });

    if (text.endsWith('\n\n')) return text;
  }
}

describe('withSseTerminal', () => {
  test('closes at [DONE] and cancels the open producer', async () => {
    const upstream = scripted();

    upstream.enqueue(sseData('{"content":"hello"}'));
    upstream.enqueue(sseData('[DONE]'));
    // The producer holds the connection open behind the terminator.

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(sseData('{"content":"hello"}') + sseData('[DONE]'));
    expect(upstream.calls).toHaveLength(1);
  });

  test('detects a terminator split across chunks', async () => {
    const upstream = scripted();

    upstream.enqueue(sseData('{"content":"hi"}'));
    upstream.enqueue('data: [DO');
    upstream.enqueue('NE]\n\n');

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(sseData('{"content":"hi"}') + sseData('[DONE]'));
    expect(upstream.calls).toHaveLength(1);
  });

  test('a content line containing the marker inside a larger message passes through', async () => {
    const upstream = scripted();
    const body = 'data: {"content":"say [DONE] when ready"}\n\ndata: {"content":"done"}\n\n';

    upstream.enqueue(body);
    upstream.close();

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(body);
    expect(upstream.calls).toHaveLength(0);
  });

  test('upstream close without a terminator closes cleanly', async () => {
    const upstream = scripted();
    const body = sseData('{"content":"hi"}');

    upstream.enqueue(body);
    upstream.close();

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(body);
    expect(upstream.calls).toHaveLength(0);
  });

  test('downstream cancel propagates upstream with the lock released', async () => {
    const upstream = scripted();

    upstream.enqueue(sseData('{"content":"hi"}'));

    const response = await through(upstream);

    await response.body?.cancel(new Error('stop'));

    expect(upstream.calls).toHaveLength(1);

    // The lock is released: acquiring a reader would throw while it is held.
    const reader = upstream.stream.getReader();

    reader.releaseLock();
  });

  test('a rejecting upstream cancel reaches the caller with the lock released', async () => {
    const upstream = scripted(() => Promise.reject(new Error('boom')));

    upstream.enqueue(sseData('{"content":"hi"}'));
    upstream.enqueue(sseData('[DONE]'));

    const response = await through(upstream);
    let outcome: string;

    try {
      await drain(response.body ?? new ReadableStream<Uint8Array>());
      outcome = 'resolved';
    } catch (cause) {
      outcome = cause instanceof Error ? cause.message : String(cause);
    }

    // The rejection reaches the consumer, and the lock is released either way.
    expect(outcome).toBe('boom');
    expect(upstream.calls).toHaveLength(1);

    const reader = upstream.stream.getReader();

    reader.releaseLock();
  });

  test('a CRLF-framed terminator still terminates', async () => {
    const upstream = scripted();
    const body = 'data: {"content":"hi"}\r\n\r\ndata: [DONE]\r\n\r\n';

    upstream.enqueue(body);

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(body);
    expect(upstream.calls).toHaveLength(1);
  });

  test('a terminator split across CRLF chunk boundaries terminates', async () => {
    const upstream = scripted();

    upstream.enqueue('data: {"content":"hi"}\r\n\r\ndata: [DO');
    upstream.enqueue('NE]\r');
    upstream.enqueue('\n\r\n');

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe('data: {"content":"hi"}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(upstream.calls).toHaveLength(1);
  });

  test('a single frame larger than the engine argument limit passes through', async () => {
    const upstream = scripted();
    // 300k in one chunk: spreading it into an argument list would blow the call stack.
    const big = `data: {"content":"${'x'.repeat(300_000)}"}\n\n`;
    const body = big + sseData('[DONE]');

    upstream.enqueue(body);

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(body);
    expect(upstream.calls).toHaveLength(1);
  });

  test('a failing upstream read rejects with the same cause and unlocks the body', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(sseData('{"content":"hi"}')));
        c.error(new Error('upstream broke'));
      },
    });

    const fetchImpl = asFetchFunction(async () => new Response(
      upstream,
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const response = await withSseTerminal(fetchImpl)('http://fake.invalid/v1/chat/completions');

    let outcome: string;

    try {
      await drain(response.body ?? new ReadableStream<Uint8Array>());
      outcome = 'resolved';
    } catch (cause) {
      outcome = cause instanceof Error ? cause.message : String(cause);
    }

    // The same rejection reaches the consumer unwrapped, and the upstream body is unlocked.
    expect(outcome).toBe('upstream broke');
    expect(upstream.locked).toBe(false);
  });
  test('non-SSE bodies pass through untouched', async () => {
    const fetchImpl = asFetchFunction(async () => Response.json({ data: [{ id: 'probe' }] }));
    const wrapped = withSseTerminal(fetchImpl);
    const json = await wrapped('http://fake.invalid/v1/models');

    expect(await json.json()).toEqual({ data: [{ id: 'probe' }] });
  });
});

/**
 * A producer that sends nothing, run to its stall. The window is measured, not imported, so this reads what the
 * terminal actually armed.
 */
async function silentProducerStall(): Promise<{ window: number; calls: readonly string[] }> {
  const clock = handClock();
  const upstream = scripted();
  const response = await throughClock(upstream, clock);
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
  const stalled = readMessage(reader);

  await clock.whenArmed(1);
  clock.tick();
  await expect(stalled).rejects.toMatchObject({ code: 'timeout' });

  return { window: clock.now(), calls: upstream.calls };
}

describe('a producer that holds the socket open without sending content', () => {
  test('a producer that sends nothing at all is given up on, and the upstream cancelled', async () => {
    expect((await silentProducerStall()).calls).toEqual(['cancelled']);
  });

  test('a keepalive comment does not reset the content deadline, and the stall is named', async () => {
    const { window } = await silentProducerStall();
    const clock = handClock();
    const upstream = scripted();
    const response = await throughClock(upstream, clock);
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
    const content = readMessage(reader);

    await clock.whenArmed(1);
    upstream.enqueue(sseData('{"content":"hello"}'));
    expect(await content).toBe(sseData('{"content":"hello"}'));

    // A keepalive comment line reaches the consumer but buys the producer no time.
    const keepalive = readMessage(reader);

    await clock.whenArmed(2);
    clock.advance(60_000);
    upstream.enqueue(': keepalive\n\n');
    expect(await keepalive).toBe(': keepalive\n\n');

    const stalled = readMessage(reader);

    await clock.whenArmed(3);
    clock.tick();

    // Fired one window after the content frame at 0, not after the keepalive.
    expect(clock.now()).toBe(window);
    await expect(stalled).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining(new Date(0).toISOString()),
    });
    expect(upstream.calls).toEqual(['cancelled']);
  });

  test('content keeps the stream alive however long it runs', async () => {
    const { window } = await silentProducerStall();
    const clock = handClock();
    const upstream = scripted();
    const response = await throughClock(upstream, clock);
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
    let armed = 0;

    // A slow reasoning model is not a stalled one: content inside each window keeps it alive.
    for (let frame = 0; frame < 4; frame += 1) {
      const next = readMessage(reader);

      armed += 1;
      await clock.whenArmed(armed);
      clock.advance(window - 1);
      upstream.enqueue(sseData(`{"content":"${String(frame)}"}`));
      expect(await next).toBe(sseData(`{"content":"${String(frame)}"}`));
    }

    expect(upstream.calls).toHaveLength(0);

    const done = readMessage(reader);

    await clock.whenArmed(armed + 1);
    upstream.enqueue(sseData('[DONE]'));
    expect(await done).toBe(sseData('[DONE]'));
    expect((await reader.read()).done).toBe(true);
    expect(upstream.calls).toEqual(['cancelled']);
  });
});
