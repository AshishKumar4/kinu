/**
 * KINU-017: `reoriginateRequest` (container egress and preview host) must keep a known-length body
 * fixed-length, or an upstream refusing chunked uploads answers 411. `SELF` is a real workerd peer:
 * an author-written `content-length` is discarded there, so the body is the control.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { kinuUserAgent, reoriginateRequest } from '@kinu.run/core';

const PAYLOAD = 'hello-world-1234';

const ArrivedSchema = v.object({
  contentLength: v.nullable(v.string()),
  transferEncoding: v.nullable(v.string()),
  userAgent: v.nullable(v.string()),
  bytes: v.number(),
});

type Arrived = v.InferOutput<typeof ArrivedSchema>;

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
    // Control: identical bytes and headers, but the runtime cannot see the length.
    const source = inbound(PAYLOAD);

    // Refusing here makes a silently-skipped control group fail by name.
    if (source.body === null) throw new Error('the control group needs a body to lose the length of');

    // `duplex` is required by the fetch spec for a stream body and absent from Workers' `RequestInit` type.
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
    // Identity and framing policy share one builder; neither may cost the other.
    expect(arrived.contentLength).toBe(String(PAYLOAD.length));
  });
});
