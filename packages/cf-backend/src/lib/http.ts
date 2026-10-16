/**
 * The browser's one transport for the app's own JSON routes; the session rides the HttpOnly cookie. Endpoint modules
 * keep their route schemas and read their answers; how a request is sent, timed, retried and refused is decided here.
 */
import { Data, Effect } from 'effect';
import type { JsonValue } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

/** A route's refusal, in the server's own words when it gave any. */
export class ApiError extends Data.TaggedError('ApiError')<{ readonly message: string; readonly status: number }> {}

export interface HttpRequest {
  readonly method?: string;
  /** A JSON body, sent as `application/json`. */
  readonly json?: JsonValue | object;
  /** A raw body (a file, an archive), sent as is. */
  readonly body?: BodyInit;
  /** The caller's own end: a mutation is never ended on a timer, since it may already have landed. */
  readonly signal?: AbortSignal;
  /** Told how many bytes of `body` have gone, as they go: an upload's progress. */
  readonly sent?: (bytes: number) => void;
}

/** Answers with no body, which a `Response` refuses one for. */
const BODILESS = new Set([101, 204, 205, 304]);

/** A body sent through XMLHttpRequest, the one browser transport that says how much of a body has gone. */
function watched(url: string, method: string, asked: HttpRequest, sent: (bytes: number) => void): Effect.Effect<Response> {
  return Effect.callback<Response>((resume) => {
    const xhr = new XMLHttpRequest();
    const stop = (): void => { xhr.abort(); };

    xhr.open(method, url);
    xhr.responseType = 'blob';
    xhr.upload.addEventListener('progress', (event) => { sent(event.loaded); });
    xhr.addEventListener('load', () => {
      const body: Blob | null = BODILESS.has(xhr.status) ? null : xhr.response;

      resume(Effect.succeed(new Response(body, { status: xhr.status })));
    });
    xhr.addEventListener('error', () => { resume(Effect.die(new TypeError(`${method} ${url}: the connection dropped`))); });
    xhr.addEventListener('abort', () => { resume(Effect.die(asked.signal?.reason ?? new DOMException('The upload was stopped.', 'AbortError'))); });
    asked.signal?.addEventListener('abort', stop, { once: true });
    xhr.send(asked.body instanceof Blob ? asked.body : null);

    return Effect.sync(() => { asked.signal?.removeEventListener('abort', stop); });
  });
}

const ErrorBodySchema = v.object({ error: v.optional(v.string()) });

/**
 * The route's answer, refused or not. A read times out and is asked again once when the connection dropped; a write
 * is sent once, never timed out and never retried, since an ambiguous retry could land it twice (KINU-073).
 */
export function respond(url: string, asked: HttpRequest = {}): Effect.Effect<Response> {
  const method = asked.method ?? 'GET';
  const read = method === 'GET';

  const ask = asked.sent === undefined ? Effect.promise(() => fetch(url, {
    method,
    ...(asked.json !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(asked.json) }),
    ...(asked.body !== undefined && { body: asked.body }),
    signal: asked.signal ?? (read ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined),
  })) : watched(url, method, asked, asked.sent);

  return read ? Effect.catchDefect(ask, (dropped) => (dropped instanceof TypeError ? ask : Effect.die(dropped))) : ask;
}

/** A refused answer as an error: the server's `{ error }` when its body has one, else what was asked and its status. */
export function refusal(response: Response, method: string, url: string): Effect.Effect<ApiError> {
  return Effect.map(
    Effect.promise(() => tolerateAsync(() => response.json(), 'malformed-input')),
    (body) => {
      const said = v.safeParse(ErrorBodySchema, body);
      const words = said.success && said.output.error !== '' ? said.output.error : undefined;

      return new ApiError({ message: words ?? `${method} ${url} → ${String(response.status)}`, status: response.status });
    },
  );
}

/** The route's answer read by `schema`; a refusal dies as its `ApiError`, a body the schema cannot read as its issue. */
export function request<Schema extends v.GenericSchema>(schema: Schema, url: string, init: HttpRequest = {}): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.gen(function* () {
    const response = yield* respond(url, init);

    if (!response.ok) return yield* Effect.die(yield* refusal(response, init.method ?? 'GET', url));

    return v.parse(schema, yield* Effect.promise(() => response.json()));
  });
}

/** A POST whose answer carries nothing past its status: done, or the refusal as a defect `settle` turns into the rejection. */
export function posted(url: string, json: HttpRequest['json']): Effect.Effect<void> {
  return Effect.gen(function* () {
    const answer = yield* respond(url, { method: 'POST', json });

    if (!answer.ok) return yield* Effect.die(yield* refusal(answer, 'POST', url));
  });
}
