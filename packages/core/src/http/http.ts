// Shared HTTP helpers for backend route modules, plus the policy for rebuilding a request for an upstream.
import { inlineFileType } from '../read-models/file-types';
import { projectJsonValue } from '../utils/json';
import { KinuError, toKinuError, tolerateAsync, type ErrorCode } from '../obs/index';
import { PRIVATE_NO_STORE } from './security-headers';
import { copyHeaders } from '../providers/util';
import * as v from 'valibot';

/** A JSON answer, `no-store` by default because nearly every body is identity-derived.
 *  A caller naming its own `cache-control` opts out (e.g. public health stamp). */
export function json(answer: { body: unknown }, init: ResponseInit = {}): Response {
  const headers = copyHeaders(init.headers);
  headers.set('content-type', 'application/json');

  if (!headers.has('cache-control')) headers.set('cache-control', PRIVATE_NO_STORE);

  return new Response(JSON.stringify(projectJsonValue({ value: answer.body })), { ...init, headers });
}

export function err(status: number, message: string): Response {
  return json({ body: { error: message } }, { status });
}

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_input: 400,
  denied: 403,
  missing: 404,
  unsupported: 415,
  budget: 413,
  unavailable: 503,
  timeout: 504,
  cancelled: 400,
  oom: 507,
  io: 500,
};

/** First-match dispatch over a route family's handlers; null when none matches. */
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
 * Pull `request.body` under `limit`, handing each chunk to `sink`. The bound counts arriving bytes:
 * a missing `content-length` reads as 0, so the declared length is only a pre-filter. On overflow the
 * stream is cancelled, not drained. A stalled body returns classified; `sink` failures propagate.
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


/** The file-download header policy: inline only for harmless types, `nosniff` always, a `sandbox` CSP
 *  on images so an SVG cannot run scripts on this origin, attachment otherwise. */
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
 * Rebuild an inbound request for an upstream, keeping its transfer framing. `request.body` must be
 * passed unwrapped: workerd derives framing from the body, and wrapping it (e.g. `TransformStream`)
 * forces chunked encoding (see `tests/workerd/egress-framing.test.ts`). Buffering would cost memory.
 */
export function reoriginateRequest(
  request: Request,
  target: string,
  init: { headers: Headers; redirect: Request['redirect'] },
): Request {
  // `duplex` is missing from the Workers `RequestInit` type but required by undici/Bun for stream bodies.
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

/** The URL a `fetch` call names, for any input shape (`String(request)` is `[object Request]`). */
export function requestUrl(input: RequestInfo | URL): string {
  const request = v.safeParse(v.instance(Request), input);

  if (request.success) return request.output.url;

  const url = v.safeParse(v.instance(URL), input);

  return url.success ? url.output.href : v.parse(v.string(), input);
}
