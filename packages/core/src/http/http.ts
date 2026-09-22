// Shared HTTP helpers for the backend route modules — one home instead of a
// per-route-file clone of json/err/safeJson/escapeHtml/readBounded, plus the
// one policy for rebuilding an inbound request for an upstream.
import { inlineFileType } from '../read-models/file-types';
import { projectJsonValue } from '../utils/json';
import { KinuError, toKinuError, tolerateAsync } from '../obs/index';
import { PRIVATE_NO_STORE } from './security-headers';
import { copyHeaders } from '../providers/util';
import * as v from 'valibot';

/**
 * A JSON answer.
 *
 * THE CACHE POLICY LIVES HERE. Almost every JSON body this Worker writes is
 * derived from a signed-in identity — a workspace roster, a credential
 * summary, an MCP server list — and none of it may sit in a shared cache or be
 * replayed from a browser's disk cache after the session ends. Scattering
 * `cache-control` over the routes that remembered is what produced a surface
 * where two CLI endpoints said `no-store` and the whole of `/api/user/*` said
 * nothing at all.
 *
 * A caller that names its own `cache-control` keeps it: that is how the public
 * routes (the health stamp) stay revalidatable. Naming one is the way to opt
 * OUT, so the default is the safe direction.
 */
export function json(answer: { body: unknown }, init: ResponseInit = {}): Response {
  const headers = copyHeaders(init.headers);
  headers.set('content-type', 'application/json');

  if (!headers.has('cache-control')) headers.set('cache-control', PRIVATE_NO_STORE);

  return new Response(JSON.stringify(projectJsonValue({ value: answer.body })), { ...init, headers });
}

export function err(status: number, message: string): Response {
  return json({ body: { error: message } }, { status });
}

/**
 * First-match dispatch over a route family's handlers: each is tried in the
 * order the caller composes, the first non-null Response wins, and no match
 * answers null so the caller tries the next family. One composed seam costs
 * the caller one branch however many handlers it joins.
 */
export async function firstResponse(
  request: Request,
  handlers: readonly ((request: Request) => Promise<Response | null>)[],
): Promise<Response | null> {
  for (const handler of handlers) {
    const response = await handler(request);

    if (response !== null) return response;
  }

  return null;
}

export async function safeJson<Schema extends v.GenericSchema>(
  request: Request,
  schema: Schema,
): Promise<v.InferOutput<Schema> | null> {
  const parsed = v.safeParse(schema, await tolerateAsync(() => request.json(), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/**
 * Pull `request.body` under `limit`, handing every arriving chunk to `sink`.
 *
 * THE BOUND LIVES HERE, and it is a count of arriving bytes rather than a
 * declared length: an absent `content-length` is `Number(null) === 0`, which
 * passes every declared-size check, so a chunked or HTTP/2 upload of any size
 * would otherwise be materialised whole before anything measured it. A declared
 * length is still checked first — it refuses an honest oversized sender for the
 * price of a header parse — but it is a pre-filter, never the gate.
 *
 * `'too_large'` is answered at the chunk carrying the first byte past `limit`,
 * and the stream is CANCELLED there rather than drained: the rest is never
 * pulled, EOF is never reached, and no partial body is assembled.
 *
 * A body that stops arriving is the caller's connection, not our defect, so it
 * comes back CLASSIFIED for the route to record under its own event name rather
 * than thrown — an unanswered public-ingress request is the one outcome these
 * endpoints have no marker for.
 *
 * The SINK's failure is deliberately not caught. It is the caller's own work
 * failing, not the read, and a route that streams onward (the file plane's
 * upload) has to tell those two apart to decide whether to abort a transfer.
 *
 * Two shapes read bodies here. One materialises and one streams onward, and
 * this is the one policy under both. They each had their own loop, which is
 * how the materialising one came to be missing the declared-length pre-filter
 * its own comment promised.
 */
export async function readBoundedStream(
  request: Request,
  limit: number,
  sink: (chunk: Uint8Array) => Promise<void> | void,
): Promise<'ok' | 'too_large' | KinuError> {
  const declared = Number(request.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > limit) return 'too_large';
  const body = request.body;

  if (body === null) return 'ok';
  const reader = body.getReader();
  let total = 0;

  for (;;) {
    let arrived: Awaited<ReturnType<typeof reader.read>>;

    try {
      arrived = await reader.read();
    } catch (cause) {
      return toKinuError({ doing: 'reading a request body', cause, otherwise: 'unavailable' });
    }

    const value = arrived.value;

    if (arrived.done || value === undefined) return 'ok';
    total += value.byteLength;

    if (total > limit) {
      await reader.cancel('the request body is over its limit');

      return 'too_large';
    }

    await sink(value);
  }
}

/** The whole body, bounded, or the classified reason there is not one. */
export async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array | 'too_large' | KinuError> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  const outcome = await readBoundedStream(request, limit, (chunk) => {
    chunks.push(chunk);
    total += chunk.byteLength;
  });

  if (outcome !== 'ok') return outcome;
  const bounded = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) {
    bounded.set(chunk, at);
    at += chunk.byteLength;
  }

  return bounded;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/**
 * The file-download route's header policy, split out so the security posture
 * is a tested contract: inline only for types a browser renders harmlessly,
 * `nosniff` always, a `sandbox` CSP on images so an SVG opened as a document
 * cannot run scripts on this origin, attachment for everything else. The PDF
 * viewer keeps its scripts — they are the platform's, not this origin's, and
 * `nosniff` already pins the type.
 */
export function fileResponseHeaders(path: string, download: boolean): Headers {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'file';
  const inlineType = download ? undefined : inlineFileType(path);

  const headers = new Headers({
    'content-type': inlineType ?? 'application/octet-stream',
    'content-disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });

  if (inlineType?.startsWith('image/')) headers.set('content-security-policy', 'sandbox');

  return headers;
}


/**
 * Rebuild an inbound request for an upstream, KEEPING ITS TRANSFER FRAMING.
 *
 * `request.body` is handed over unwrapped, and that is the load-bearing part.
 * workerd derives the wire framing from the BODY it is given, not from any
 * `content-length` a caller writes: a body of known length goes out
 * fixed-length, a body of unknown length goes out chunked, and no header
 * changes which. Both are measured in `tests/workerd/egress-framing.test.ts`;
 * the same file measures the way to lose it, which is to hand over a body
 * whose length the runtime can no longer see. Piping through a
 * `TransformStream` does exactly that — same bytes, `transfer-encoding:
 * chunked`, and an upstream that refuses chunked uploads answers 411.
 *
 * There is therefore nothing to "preserve" at the header, and a fix written
 * there would have been a no-op that read as a fix. What has to be preserved
 * is the body object.
 *
 * Buffering instead would restore a length and cost the whole body in memory
 * on a Worker, so neither transform nor buffer belongs on this path.
 */
export function reoriginateRequest(
  request: Request,
  target: string,
  init: { headers: Headers; redirect: Request['redirect'] },
): Request {
  // `duplex` is absent from the Workers `RequestInit` type and required by the
  // fetch specification whenever the body is a stream. workerd accepts the
  // request without it; undici and Bun throw, and this policy is exercised
  // under `bun test`.
  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: init.headers,
    redirect: init.redirect,
  };

  if (request.body !== null) {
    requestInit.body = request.body;
    requestInit.duplex = 'half';
  }

  return new Request(target, requestInit);
}

/**
 * The URL a `fetch` call names, whichever of its three input shapes the caller
 * used. `String(input)` renders a `Request` as `[object Request]`, so a fake
 * or a relay that reads the URL to route the call reads that shape first; a
 * string is itself and a `URL` stringifies to its href.
 */
export function requestUrl(input: RequestInfo | URL): string {
  const request = v.safeParse(v.instance(Request), input);

  if (request.success) return request.output.url;

  const url = v.safeParse(v.instance(URL), input);

  return url.success ? url.output.href : v.parse(v.string(), input);
}
