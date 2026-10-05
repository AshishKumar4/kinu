/**
 * One bounded-read policy for `readBounded` and `readBoundedStream`: bound by arriving bytes, never the announced
 * length (absent `content-length` reads as 0), plus a declared-length pre-filter.
 */
import { describe, expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { readBounded, readBoundedStream } from '@kinu.run/core';

/** `duplex: 'half'` is required for a streamed Request body and missing from the DOM `RequestInit`. */
type StreamingRequestInit = RequestInit & { duplex: 'half' };

function streamed(chunks: readonly Uint8Array[], headers: Record<string, string> = {}): Request {
  let pulled = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks.length) {
        controller.close();

        return;
      }

      controller.enqueue(chunks[pulled]);
      pulled += 1;
    },
    cancel() { pulled = chunks.length; },
  });

  const init: StreamingRequestInit = { method: 'PUT', body, headers, duplex: 'half' };

  return new Request('https://kinu.example.com/x', init);
}

const chunk = (byte: number, size: number) => new Uint8Array(size).fill(byte);

describe('readBoundedStream', () => {
  test('every chunk reaches the sink, in arrival order, when the body fits', async () => {
    const seen: number[] = [];

    const outcome = await readBoundedStream(streamed([chunk(1, 3), chunk(2, 4)]), 100, (part) => {
      seen.push(part.byteLength);
    });

    expect(outcome).toBe('ok');
    expect(seen).toEqual([3, 4]);
  });

  test('a declared length over the limit is refused before the body is pulled', async () => {
    // An honest oversized sender costs a header parse; `pulled` proves nothing was read.
    const parts: number[] = [];
    const request = streamed([chunk(1, 8)], { 'content-length': '4096' });
    const outcome = await readBoundedStream(request, 1024, (part) => { parts.push(part.byteLength); });
    expect(outcome).toBe('too_large');
    expect(parts).toEqual([]);
  });

  test('an absent declared length is no defence — the arriving count is the gate', async () => {
    const parts: number[] = [];

    const outcome = await readBoundedStream(streamed([chunk(1, 4), chunk(2, 4)]), 5, (part) => {
      parts.push(part.byteLength);
    });

    expect(outcome).toBe('too_large');
    expect(parts).toEqual([4]);
  });

  test('a body that stops arriving comes back classified, not thrown', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('the connection went away')); },
    });

    const init: StreamingRequestInit = { method: 'PUT', body, duplex: 'half' };
    const request = new Request('https://kinu.example.com/x', init);
    const outcome = await readBoundedStream(request, 1024, () => undefined);
    expect(outcome).toBeInstanceOf(KinuError);
  });

  test("the sink's own failure is the caller's, and is not swallowed as a read failure", async () => {
    // Only an actor refusal aborts a half-written transfer, so the two must be distinguishable.
    const attempt = readBoundedStream(streamed([chunk(1, 4)]), 1024, () => {
      throw new Error('the actor refused this chunk');
    });

    await expect(attempt).rejects.toThrow('the actor refused this chunk');
  });

  test('a request with no body at all is an empty read, not a failure', async () => {
    const outcome = await readBoundedStream(new Request('https://kinu.example.com/x'), 16, () => undefined);
    expect(outcome).toBe('ok');
  });
});

describe('readBounded', () => {
  test('the whole body comes back as one array, in order', async () => {
    const out = await readBounded(streamed([chunk(7, 2), chunk(9, 3)]), 100);

    if (!(out instanceof Uint8Array)) throw new Error(`expected bytes, got ${String(out)}`);
    expect([...out]).toEqual([7, 7, 9, 9, 9]);
  });

  test('it now carries the declared-length pre-filter its own comment promised', async () => {
    const out = await readBounded(streamed([chunk(1, 8)], { 'content-length': '4096' }), 1024);
    expect(out).toBe('too_large');
  });

  test('and still refuses a body that lied about its length', async () => {
    const out = await readBounded(streamed([chunk(1, 4), chunk(2, 4)]), 5);
    expect(out).toBe('too_large');
  });
});
