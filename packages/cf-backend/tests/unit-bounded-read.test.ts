/**
 * The ONE bounded-read policy, through both shapes that use it.
 *
 * Two readers pull request bodies here — one materialises the whole body
 * (`readBounded`, for JSON ingress), one streams it onward without ever holding
 * it (`readBoundedStream`, for the file plane's upload). They each had their own
 * loop, which is how the materialising one came to be missing the
 * declared-length pre-filter its own comment promised: an honest oversized
 * sender was pulled byte by byte until the count caught it, rather than refused
 * on a header parse.
 *
 * The bound itself is the count of ARRIVING bytes, never the announced length,
 * because an absent `content-length` reads as 0 and passes every declared-size
 * check. Both halves are asserted here, in both directions.
 */
import { describe, expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { readBounded, readBoundedStream } from '../src/lib/http';

/**
 * `duplex: 'half'` is REQUIRED by the runtime whenever a Request body is a
 * stream, and is absent from the DOM `RequestInit` this TypeScript target
 * ships. Named once here so neither construction below needs a cast.
 */
type StreamingRequestInit = RequestInit & { duplex: 'half' };

/** A request whose body arrives in the given chunks, with no declared length. */
function streamed(chunks: readonly Uint8Array[], headers: Record<string, string> = {}): Request {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[pulled]!);
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
    // The pre-filter's whole point: an honest oversized sender costs a header
    // parse, not a full transfer. `pulled` proves nothing was read.
    const parts: number[] = [];
    const request = streamed([chunk(1, 8)], { 'content-length': '4096' });
    const outcome = await readBoundedStream(request, 1024, (part) => { parts.push(part.byteLength); });
    expect(outcome).toBe('too_large');
    expect(parts).toEqual([]);
  });

  test('an absent declared length is no defence — the arriving count is the gate', async () => {
    // `Number(null)` is 0, which passes every declared-size check, so a chunked
    // sender with no header must still be refused at the first byte past.
    const parts: number[] = [];
    const outcome = await readBoundedStream(streamed([chunk(1, 4), chunk(2, 4)]), 5, (part) => {
      parts.push(part.byteLength);
    });
    expect(outcome).toBe('too_large');
    // The first chunk fits and is handed on; the second crosses and is not.
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
    // The file upload has to tell "the body stopped" from "the actor refused a
    // chunk" apart, because only one of those aborts a half-written transfer.
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
