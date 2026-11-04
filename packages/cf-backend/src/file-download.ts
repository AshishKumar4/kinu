/**
 * A download's response, framed by the size it opened with: a body that breaks off before its end reaches the client as
 * a broken response, never a short or empty success. Unframed, an interrupted read answered 200 and Bun read its body
 * as "" (production 914ae51e8, 2026-11-04: "Network connection lost." at the second chunk of a 15-byte file; armada
 * 20261104201125-6feef09a). Compression would drop the length, so the body goes as it is.
 */
export function framedDownload(headers: Headers, body: ReadableStream<Uint8Array>, size: number): Response {
  headers.set('content-encoding', 'identity');
  headers.set('cache-control', 'no-store, no-transform');

  return new Response(body.pipeThrough(new FixedLengthStream(size)), { headers });
}
