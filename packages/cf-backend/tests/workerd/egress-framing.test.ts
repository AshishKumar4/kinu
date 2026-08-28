/**
 * KINU-017, executed. A body of known length re-originated to an upstream has
 * to arrive with that length; a body of unknown length has to stay chunked.
 *
 * The subject is `reoriginateRequest` — the one builder container egress
 * (`egress/outbound.ts`) and the workspace preview host (`nimbus-route.ts`)
 * both send through. What it must never do is give the runtime a body whose
 * length the runtime cannot see, because an upstream that refuses chunked
 * uploads answers 411 and the agent's request never lands.
 *
 * `SELF` is a real workerd HTTP peer, so `worker.ts`'s handler reports the
 * framing the runtime chose rather than the framing the caller asked for. That
 * distinction is the finding: an author-written `content-length` is DISCARDED
 * here, so the header is not the control and the body is.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { kinuUserAgent, reoriginateRequest } from '../../src/lib/http';

const PAYLOAD = 'hello-world-1234';

const ArrivedSchema = v.object({
  contentLength: v.nullable(v.string()),
  transferEncoding: v.nullable(v.string()),
  userAgent: v.nullable(v.string()),
  bytes: v.number(),
});
type Arrived = v.InferOutput<typeof ArrivedSchema>;

/** A body whose length nothing knows — what a chunked upload looks like to a
 *  handler after the runtime has parsed it. */
function unknownLength(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function inbound(body: BodyInit | null, headers: HeadersInit = {}): Request {
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers };
  if (body !== null) {
    init.body = body;
    init.duplex = 'half';
  }
  return new Request('https://container.test/upload', init);
}

async function send(request: Request): Promise<Arrived> {
  return v.parse(ArrivedSchema, await (await SELF.fetch(request)).json());
}

describe('re-originated transfer framing', () => {
  test('a fixed-length body keeps its content-length and is not made chunked', async () => {
    const arrived = await send(reoriginateRequest(
      inbound(PAYLOAD),
      'https://upstream.test/upload',
      { headers: new Headers({ 'content-type': 'text/plain' }), redirect: 'manual' },
    ));
    expect(arrived.contentLength).toBe(String(PAYLOAD.length));
    expect(arrived.transferEncoding).toBeNull();
    expect(arrived.bytes).toBe(PAYLOAD.length);
  });

  test('an unknown-length body stays chunked rather than being buffered to find one', async () => {
    const arrived = await send(reoriginateRequest(
      inbound(unknownLength(PAYLOAD)),
      'https://upstream.test/upload',
      { headers: new Headers(), redirect: 'manual' },
    ));
    expect(arrived.transferEncoding).toBe('chunked');
    expect(arrived.contentLength).toBeNull();
    expect(arrived.bytes).toBe(PAYLOAD.length);
  });

  test('piping the same body through a transform is what loses the length', async () => {
    // The control group. Identical bytes, identical headers; the only
    // difference is that the runtime can no longer see how many there are.
    const source = inbound(PAYLOAD);
    // Proven, not asserted: `inbound` was handed a body, so refusing here turns
    // a silently-skipped control group into a failure that names itself.
    if (source.body === null) throw new Error('the control group needs a body to lose the length of');
    // Same declared intersection the production builder uses, stated rather
    // than asserted past: `duplex` is required by the fetch specification for
    // a stream body and absent from the Workers `RequestInit` type.
    const piped: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body: source.body.pipeThrough(new TransformStream()),
      duplex: 'half',
    };
    const arrived = await send(new Request('https://upstream.test/upload', piped));
    expect(arrived.transferEncoding).toBe('chunked');
    expect(arrived.bytes).toBe(PAYLOAD.length);
  });

  test('a bodyless method re-originates with no body and no framing header', async () => {
    const arrived = await send(reoriginateRequest(
      new Request('https://container.test/thing'),
      'https://upstream.test/thing',
      { headers: new Headers(), redirect: 'follow' },
    ));
    expect(arrived.transferEncoding).toBeNull();
    expect(arrived.bytes).toBe(0);
  });

  test('the Kinu identity reaches the wire ahead of the caller its own', async () => {
    const headers = new Headers({ 'user-agent': kinuUserAgent('curl/8.5.0') });
    const arrived = await send(reoriginateRequest(
      inbound(PAYLOAD), 'https://upstream.test/upload', { headers, redirect: 'manual' },
    ));
    expect(arrived.userAgent).toBe('Kinu (+https://kinu.run) curl/8.5.0');
    // Still fixed-length: the identity policy and the framing policy share one
    // builder and neither may cost the other.
    expect(arrived.contentLength).toBe(String(PAYLOAD.length));
  });
});
