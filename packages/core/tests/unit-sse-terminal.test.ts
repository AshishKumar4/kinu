/**
 * `withSseTerminal` — end an SSE stream at `data: [DONE]` with the upstream
 * reader cancelled, instead of at producer close. Every case drives the
 * public fetch-level entry with a scripted upstream, so the assertions pin
 * the shipped path including the content-type gate: the producer-open case
 * (content, [DONE], then silence with the producer holding the connection)
 * must still close the wrapper AND call the upstream cancel — that call is
 * the whole fix.
 */
import { describe, test, expect } from 'bun:test';
import { withSseTerminal } from '../src/providers/sse-terminal';
import { asFetchFunction } from '../src/providers/fetch-shim';

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

/** An upstream the test owns: scripted bytes, then whatever lifecycle
 *  the case leaves it in, with cancel calls counted. */
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

describe('withSseTerminal', () => {
  test('closes at [DONE] and cancels the open producer', async () => {
    const upstream = scripted();

    upstream.enqueue(sseData('{"content":"hello"}'));
    upstream.enqueue(sseData('[DONE]'));
    // The producer stays open with the connection held behind the
    // terminator — the case that wedged the turn awaiting stream end.

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

    // The lock is released, not just marked settled: acquiring a reader on
    // the upstream would throw while it is still held.
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

    // The rejection propagates to the consumer instead of becoming success,
    // and the lock is released either way — a second reader acquires cleanly.
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
    // 300k in one chunk: spreading it into an argument list would blow the
    // call stack, so the queue must move it by copy.
    const big = `data: {"content":"${'x'.repeat(300_000)}"}\n\n`;
    const body = big + sseData('[DONE]');

    upstream.enqueue(body);

    const response = await through(upstream);
    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text).toBe(body);
    expect(upstream.calls).toHaveLength(1);
  });

  test('non-SSE bodies pass through untouched', async () => {
    const fetchImpl = asFetchFunction(async () => Response.json({ data: [{ id: 'probe' }] }));
    const wrapped = withSseTerminal(fetchImpl);
    const json = await wrapped('http://fake.invalid/v1/models');

    expect(await json.json()).toEqual({ data: [{ id: 'probe' }] });
  });
});
