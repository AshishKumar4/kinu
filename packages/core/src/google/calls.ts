// One request to Google's APIs through the account's Google connection, made here so its token never leaves the
// account: only to the pinned APIs' own addresses, renewed and tried once more when Google refuses the token held.
// Every answer Google gives comes back as it is, with what a caller paces or revalidates by (`ETag`, `Retry-After`);
// an agent's operation says a refusal in Google's words (`tools/google-operations.ts`).
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError, settle, tolerate } from '../obs/index';
import { plainFetch } from '../providers/fetch-shim';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { googleBaseUrls } from './catalog';
import { GOOGLE_VERBS } from './table';

/** Google's answer to one request, whatever its status: its JSON (or its text, where it sent none), and what a caller
 *  paces or revalidates by. */
export interface GoogleAnswer {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers: { readonly etag?: string; readonly retryAfter?: string };
}

export const GoogleCallSchema = v.object({
  method: v.picklist(GOOGLE_VERBS),
  url: v.pipe(v.string(), v.url()),
  body: v.optional(v.string()),
  /** A conditional read: Google answers 304 with no body while the resource still has this `ETag`. */
  ifNoneMatch: v.optional(v.string()),
});

export type GoogleCall = v.InferOutput<typeof GoogleCallSchema>;

/** The connection's token: null with none; `refused`, renewed first, since Google refused the one held. */
export type GoogleTokenRead = (refused: boolean) => Promise<string | null>;

const NOT_CONNECTED = 'Google is not connected to this account. Its owner connects it in Settings > MCP servers; then call again.';

export function callGoogle(asked: GoogleCall, token: GoogleTokenRead, fetchFn: typeof fetch = fetch): Promise<GoogleAnswer> {
  return settle(Effect.gen(function* () {
    if (!(yield* googleBaseUrls()).some((base) => asked.url.startsWith(base))) {
      return yield* new KinuError('denied', 'The Google connection reaches only Google\'s own APIs.');
    }

    const once = (bearer: string) => Effect.promise(() => plainFetch(fetchFn)(asked.url, {
      method: asked.method,
      headers: {
        authorization: `Bearer ${bearer}`, accept: 'application/json',
        ...(asked.body !== undefined && { 'content-type': 'application/json' }), ...(asked.ifNoneMatch !== undefined && { 'if-none-match': asked.ifNoneMatch }),
      },
      ...(asked.body !== undefined && { body: asked.body }),
      // Never followed, so the token goes nowhere else; workerd refuses 'error' (follow or manual only).
      redirect: 'manual',
    }));

    const held = yield* Effect.promise(() => token(false));

    if (held === null) return yield* new KinuError('denied', NOT_CONNECTED);
    let response = yield* once(held);

    if (response.status === 401) {
      const renewed = yield* Effect.promise(() => token(true));

      if (renewed === null) return yield* new KinuError('denied', NOT_CONNECTED);
      response = yield* once(renewed);
    }

    const text = yield* Effect.promise(() => response.text());
    const body: JsonValue = text === '' ? null : tolerate(() => parseJsonValue(text), 'malformed-input') ?? text;
    const etag = response.headers.get('etag');
    const retryAfter = response.headers.get('retry-after');

    return { status: response.status, body, headers: { ...(etag !== null && { etag }), ...(retryAfter !== null && { retryAfter }) } };
  }));
}
