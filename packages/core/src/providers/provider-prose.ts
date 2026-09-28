/** Provider prose, for diagnostics only; outside the barrel so no UI or CLI reaches it (KINU-043). */

import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { evidenceWindow } from '../utils/evidence-window';
import { nonEmptyString } from '../utils/json';

/** Nested `{ error: … }` depth: OpenAI nests once, gateways re-wrap. */
const PROVIDER_ERROR_MAX_DEPTH = 3;

const PROVIDER_ERROR_MAX_CHARS = 800;

/** Structural `APICallError` fields, so a gateway's re-thrown shape reads the same. */
const ApiCallErrorSchema = v.looseObject({
  statusCode: v.optional(v.number()),
  responseBody: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
  data: v.optional(v.looseObject({ reason: v.optional(v.string()) })),
});

/** Stream `error` chunks carry a status without being an `Error`. */
const StatusFieldSchema = v.looseObject({
  status: v.optional(v.number()),
  statusCode: v.optional(v.number()),
});

export interface ProviderFailureReading {
  readonly prose: string;
  /** An `Error`'s own message when no provider body came with it. */
  readonly said?: string;
  /** `code`, else `type`, verbatim. */
  readonly providerCode?: string;
  readonly status?: number;
}

/** Read a provider failure (often a plain object, not an `Error`) down to its facts.
 *  A response body is parsed, never forwarded: it may echo the request's headers. */
export function readProviderFailure(failure: { readonly cause: unknown }): ProviderFailureReading {
  return readFailure({ cause: failure.cause, depth: 0 }) ?? { prose: 'unknown provider error' };
}

/** Null when nothing readable, so a caller keeps the reason it already had. */
function readFailure(
  input: { readonly cause: unknown; readonly depth: number },
): ProviderFailureReading | null {
  const { cause: error, depth } = input;

  if (error instanceof Error) return readErrorFailure(error, depth);

  const text = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), error);

  if (text.success) return { prose: text.output };

  if (v.is(v.string(), error)) return null;

  // Shallow, not `JsonObject`: the recursive schema overflows on self-referencing errors.
  const record = v.safeParse(v.record(v.string(), v.unknown()), error);

  if (!record.success) return null;

  const fields = record.output;
  const status = v.safeParse(StatusFieldSchema, fields);
  const reported = status.success ? status.output.status ?? status.output.statusCode : undefined;
  const providerCode = nonEmptyString({ value: fields.code }) ?? nonEmptyString({ value: fields.type });

  const stated = nonEmptyString({ value: fields.message })
    ?? nonEmptyString({ value: fields.error_description })
    ?? nonEmptyString({ value: fields.detail });

  // Gateways stamp code and status on the outer envelope.
  const nested = stated !== undefined || fields.error === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
    ? null
    : readFailure({ cause: fields.error, depth: depth + 1 });

  // Name the keys, never the values: the values may leak.
  const named = Object.keys(fields).join(', ') || 'no fields';

  return {
    prose: stated ?? nested?.prose ?? `unrecognised provider error (fields: ${named})`,
    providerCode: nested?.providerCode ?? providerCode,
    status: nested?.status ?? reported,
  };
}

function readErrorFailure(error: Error, depth: number): ProviderFailureReading {
  const envelope = v.safeParse(ApiCallErrorSchema, error);
  const status = envelope.success ? envelope.output.statusCode : undefined;
  const body = envelope.success ? envelope.output.responseBody : undefined;

  // The reason lives in the body; `||` because an empty message says nothing.
  const parsed = body === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
    ? undefined
    : tolerate<unknown>(() => JSON.parse(body), 'malformed-input');

  const fromBody = parsed === undefined
    ? null
    : readFailure({ cause: parsed, depth: depth + 1 });

  const own = error.message || error.name;
  const reason = envelope.success ? envelope.output.data?.reason : undefined;

  return {
    prose: fromBody?.prose ?? (reason === undefined ? own : `${own}: ${reason}`),
    ...(body === undefined && { said: own }),
    providerCode: fromBody?.providerCode,
    status,
  };
}

/** Reason plus identifiers it does not already state, bounded by `evidenceWindow`
 *  since the useful sentence is usually last. */
export function describeProviderError(failure: { readonly cause: unknown }): string {
  const facts = readProviderFailure({ cause: failure.cause });
  const tags: string[] = [];

  if (facts.status !== undefined) tags.push(`HTTP ${String(facts.status)}`);
  const code = facts.providerCode;

  if (code !== undefined && !facts.prose.toLowerCase().includes(code.toLowerCase())) tags.push(code);
  const rendered = tags.length > 0 ? `${facts.prose} (${tags.join(', ')})` : facts.prose;

  return evidenceWindow(rendered, PROVIDER_ERROR_MAX_CHARS);
}
