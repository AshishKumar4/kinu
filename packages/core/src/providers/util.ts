// Shared provider internals: the auth-injecting fetch wrapper used by the
// simple providers (codex keeps its richer 401-refresh/WAF variant) and the
// small parse helpers the catalog adapters share.
import type { AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types';
import { asFetchFunction } from './fetch-shim';
import { withRateLimitRetry } from './rate-limit-retry';
import { evidenceWindow } from '../prompts/evidence-window';
import * as v from 'valibot';
import {
  KinuError, classifyErrorCode, tolerate, type ErrorCode,
} from '../obs/index';

export interface AuthedFetchOptions {
  /** Credential key passed to the AuthResolver on every request. */
  credKey: string;
  /** 401 JSON body `error` text when no credential is configured. */
  missingCredentialError: string;
  /** Reject (401) when the credential lacks a baseURL (openai-compat). */
  requireBaseURL?: boolean;
  /** Async fallback for `auth.baseURL` (catalog providers source their
   *  endpoint from models.dev, not the credential). A credential-supplied
   *  baseURL still wins. Resolving to null rejects the request (401) with
   *  `missingBaseURLError`. */
  resolveBaseURL?: () => Promise<string | null>;
  /** Error text when `resolveBaseURL` comes up empty. */
  missingBaseURLError?: string;
  /** Adjust headers and/or return a replacement URL after auth injection. */
  mutate?: (ctx: { url: string; headers: Headers; auth: AuthResolution }) => string | void;
}

function isHeaderIterable(value: HeadersInit): value is HeadersInit & Iterable<Iterable<string>> {
  return Symbol.iterator in Object(value);
}

/** Copy every web-platform HeadersInit form without passing the DOM iterable
 * union into Bun's narrower constructor overload. */
export function copyHeaders(init: HeadersInit | undefined): Headers {
  const headers = new Headers();
  if (init === undefined) return headers;
  if (init instanceof Headers) {
    init.forEach((value, name) => { headers.append(name, value); });
    return headers;
  }
  if (isHeaderIterable(init)) {
    for (const pair of init) {
      const [name, value] = pair;
      if (name === undefined || value === undefined) {
        throw new Error('header pair must contain a name and value');
      }
      headers.append(name, value);
    }
    return headers;
  }
  for (const [name, value] of Object.entries(init)) headers.append(name, value);
  return headers;
}


/**
 * Build the resolve-auth → 401-if-missing → merge-headers → fetch wrapper
 * every API-key provider needs. Auth is re-resolved per request so credential
 * changes take effect without rebuilding the model.
 */
export function createAuthedFetch(deps: ProviderDeps, opts: AuthedFetchOptions): typeof globalThis.fetch {
  const baseFetch = withRateLimitRetry(deps.fetch ?? fetch);
  return asFetchFunction(async (input, init) => {
    const resolved = await deps.getAuth(opts.credKey);
    if (!resolved || (opts.requireBaseURL && !resolved.baseURL)) {
      return new Response(
        JSON.stringify({ error: opts.missingCredentialError }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    let auth = resolved;
    if (!auth.baseURL && opts.resolveBaseURL) {
      const baseURL = await opts.resolveBaseURL();
      if (!baseURL) {
        return new Response(
          JSON.stringify({ error: opts.missingBaseURLError ?? opts.missingCredentialError }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      auth = { ...auth, baseURL };
    }
    const headers = copyHeaders(init?.headers);
    for (const [k, v] of Object.entries(auth.headers)) headers.set(k, v);
    const url = input instanceof Request ? input.url : input.toString();
    const rewritten = opts.mutate?.({ url, headers, auth });
    return baseFetch(rewritten ?? input, { ...init, headers });
  });
}

/** Stable identity of a resolved credential — used to key catalog caches so
 *  a credential swap invalidates them. */
export function authCacheKey(auth: AuthResolution): string {
  return JSON.stringify([auth.headers, auth.baseURL ?? null]);
}

export function cloneModelInfos(models: readonly ModelInfo[] | undefined): ModelInfo[] {
  return (models ?? []).map((model) => ({
    ...model,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    cost: model.cost ? { ...model.cost } : undefined,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
  }));
}

/** One model's catalog entry from a provider's listModels, or null when the
 *  provider is unknown or its catalog holds no such model. The catalog is
 *  the source of truth for per-model metadata — context window AND input
 *  modalities — so callers prefer it over static fallbacks when it resolves.
 *
 *  A catalog that cannot be READ throws rather than resolving null: null
 *  shared between "no such model" and "models.dev is down" is how every model
 *  silently gets a static context window. `ModelCatalogSession`'s lookup seam
 *  is documented to accept a throwing lookup and keep the static fallbacks
 *  authoritative, so the degraded path survives — it is now visible.
 *  Shared by the cf orchestrator's per-spec lookup and the CLI resolver. */
export async function catalogModelInfo(
  provider: Pick<ModelProvider, 'listModels'> | undefined,
  deps: ProviderDeps,
  modelId: string,
): Promise<ModelInfo | null> {
  if (!provider) return null;
  const models = await provider.listModels(deps);
  return models.find((m) => m.id === modelId) ?? null;
}

export function nonEmptyString<T>(value: T): string | undefined {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);
  return parsed.success ? parsed.output : undefined;
}

export function positiveInteger<T>(value: T): number | undefined {
  const parsed = v.safeParse(v.pipe(v.number(), v.finite(), v.gtValue(0)), value);
  return parsed.success ? Math.floor(parsed.output) : undefined;
}

/** How deep to follow nested `{ error: … }` envelopes. OpenAI-shaped bodies
 *  nest once; two spare levels cover the gateways that re-wrap them. */
const PROVIDER_ERROR_MAX_DEPTH = 3;
const PROVIDER_ERROR_MAX_CHARS = 800;

/** The two fields the AI SDK's `APICallError` carries that this boundary
 *  reads: the status the call failed with, and the body the endpoint answered.
 *  Declared structurally rather than by `instanceof` so a gateway's own
 *  re-thrown shape is read the same way. */
const ApiCallErrorSchema = v.looseObject({
  statusCode: v.optional(v.number()),
  responseBody: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
});

/** A status a plain error payload states about itself. Stream `error` chunks
 *  from openai-compat endpoints carry one without being an `Error` at all. */
const StatusFieldSchema = v.looseObject({
  status: v.optional(v.number()),
  statusCode: v.optional(v.number()),
});

/**
 * What a provider failure carries once it has crossed this boundary.
 *
 * Kept as fields rather than folded into one string because every consumer
 * downstream used to recover them by re-matching the prose: the CLI's guidance
 * layer regex-matched a rendered sentence, and the turn-failure classifier
 * matched a different one. A status is part of the HTTP protocol and a
 * provider's `code`/`type` is its own published identifier; neither drifts the
 * way wording does.
 */
export interface ProviderFailureFacts {
  /** The provider's own reason, safe to show a user. Never a raw response
   *  body: see {@link providerFailureFacts}. */
  readonly message: string;
  /** The provider's stable error code (`code`, else `type`), verbatim. */
  readonly providerCode?: string;
  /** The HTTP status the call failed with, when one was reported. */
  readonly status?: number;
}

/**
 * Read a provider failure down to its facts.
 *
 * The AI SDK routes provider failures into the stream as an `error` chunk whose
 * payload is whatever the endpoint sent — frequently a plain object
 * (`{error: {message, code}}` from an OpenAI-shaped SSE body), not an `Error`.
 * `String(thatObject)` is `"[object Object]"`, which is exactly the message
 * users were shown, so the message is dug out of the shape instead.
 *
 * A response BODY is read as the envelope it is and never forwarded verbatim.
 * That distinction is the whole point: an unparseable body is an HTML error
 * page, a signed URL, or a gateway echo of the request that failed — the
 * request Kinu sent, headers included — and none of those is text for a user's
 * terminal. The same rule kills the whole-object `JSON.stringify` this used to
 * fall back to, which forwarded every field an SDK happened to attach.
 */
export function providerFailureFacts(failure: { readonly cause: unknown }): ProviderFailureFacts {
  return readProviderFailure({ cause: failure.cause, depth: 0 })
    ?? { message: 'unknown provider error' };
}

/** The reader behind {@link providerFailureFacts}. Null means the payload said
 *  nothing readable at all, which is what lets a caller keep the reason it
 *  already had rather than be handed a placeholder that displaces it. */
function readProviderFailure(
  input: { readonly cause: unknown; readonly depth: number },
): ProviderFailureFacts | null {
  const { cause: error, depth } = input;
  if (error instanceof Error) {
    const envelope = v.safeParse(ApiCallErrorSchema, error);
    const status = envelope.success ? envelope.output.statusCode : undefined;
    const body = envelope.success ? envelope.output.responseBody : undefined;
    // The SDK's message for an HTTP failure is the status line
    // ("AI_APICallError", "Bad Request"), so the provider's reason lives in the
    // body — read it, never print it. A body that reads as nothing leaves the
    // SDK's own message standing, and the name is reached with `||` and not
    // `??` because an Error built with '' HAS a message and it says nothing.
    const parsed = body === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
      ? undefined
      : tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
    const fromBody = parsed === undefined
      ? null
      : readProviderFailure({ cause: parsed, depth: depth + 1 });
    // Assigned rather than spread-when-present: `exactOptionalPropertyTypes` is
    // off, so an absent fact IS `undefined` on an optional field, and a
    // conditional empty spread only obscures that.
    return {
      message: fromBody?.message ?? (error.message || error.name),
      providerCode: fromBody?.providerCode,
      status,
    };
  }

  const text = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), error);
  if (text.success) return { message: text.output };
  if (v.is(v.string(), error)) return null;

  // Shallow on purpose. This used to go through a `JsonObject` guard, and
  // `JsonObjectSchema` is RECURSIVE: a provider error object that references
  // itself — the shape a gateway produces the moment it attaches the request it
  // failed on — overflowed valibot's stack instead of failing to match, and the
  // guard's `catch { return false }` reported that overflow as "not an object".
  // Nothing here needs deep JSON validity: each field below re-validates.
  const record = v.safeParse(v.record(v.string(), v.unknown()), error);
  if (!record.success) return null;

  const fields = record.output;
  const status = v.safeParse(StatusFieldSchema, fields);
  const reported = status.success ? status.output.status ?? status.output.statusCode : undefined;
  const providerCode = nonEmptyString(fields.code) ?? nonEmptyString(fields.type);
  const stated = nonEmptyString(fields.message)
    ?? nonEmptyString(fields.error_description)
    ?? nonEmptyString(fields.detail);
  // A gateway wraps the provider's reason and stamps its own code and status on
  // the outside, so the envelope's identifiers still count when the payload
  // inside states neither.
  const nested = stated !== undefined || fields.error === undefined || depth >= PROVIDER_ERROR_MAX_DEPTH
    ? null
    : readProviderFailure({ cause: fields.error, depth: depth + 1 });
  // No reason anywhere: name what the payload carried rather than stringify it.
  // The keys are the diagnosis; the values are the leak.
  const named = Object.keys(fields).join(', ') || 'no fields';
  return {
    message: stated ?? nested?.message ?? `unrecognised provider error (fields: ${named})`,
    providerCode: nested?.providerCode ?? providerCode,
    status: nested?.status ?? reported,
  };
}

/**
 * Human-readable text for anything a provider can fail with: the reason, plus
 * the stable identifiers that would otherwise be lost, and never a code the
 * reason already states.
 *
 * Bounded through `evidenceWindow` rather than a head slice. A failure's
 * useful sentence is usually its LAST one — a tool that throws after a long
 * preamble puts the reason at the end — so clipping the head off is clipping
 * the answer off, and `unit-chat-event-fidelity.test.ts` pins exactly that.
 * Within budget the text passes through byte-identical.
 */
export function describeProviderError(failure: { readonly cause: unknown }): string {
  const facts = providerFailureFacts({ cause: failure.cause });
  const tags: string[] = [];
  if (facts.status !== undefined) tags.push(`HTTP ${String(facts.status)}`);
  const code = facts.providerCode;
  if (code !== undefined && !facts.message.toLowerCase().includes(code.toLowerCase())) tags.push(code);
  const rendered = tags.length > 0 ? `${facts.message} (${tags.join(', ')})` : facts.message;
  return evidenceWindow(rendered, PROVIDER_ERROR_MAX_CHARS);
}

/**
 * HTTP status → the one classification vocabulary (`obs/error.ts`).
 *
 * Statuses, not provider wording: a status is part of the protocol, every
 * provider Kinu resolves speaks it, and it does not drift when a gateway
 * rephrases its bodies. Null for a status that says nothing about the class.
 */
function codeForStatus(status: number): ErrorCode | null {
  if (status === 401 || status === 402 || status === 403) return 'denied';
  if (status === 404) return 'missing';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 413 || status === 422) return 'bad_input';
  if (status === 429 || status >= 500) return 'unavailable';
  return null;
}

/**
 * A provider failure as a classified Kinu error: the code the rest of the
 * system switches on, safe actionable prose, and the raw failure retained on
 * `cause` for diagnostics.
 *
 * This is the boundary. Above it a provider failure is an opaque SDK object
 * carrying a response body; below it, it is a {@link KinuError} like every
 * other failure in the process, and `renderCauseChain` renders messages only —
 * so the body stays available to an observability sink that inspects `cause`
 * and never reaches a terminal or a chat surface.
 */
export function toProviderError(input: { doing: string; cause: unknown }): KinuError {
  const facts = providerFailureFacts({ cause: input.cause });
  const code = classifyErrorCode({ cause: input.cause })
    ?? (facts.status === undefined ? null : codeForStatus(facts.status))
    ?? 'unavailable';
  return new KinuError(code, `${input.doing}: ${describeProviderError({ cause: input.cause })}`, {
    cause: input.cause,
  });
}

/** "131k" / "1M" / "1.05M" — compact context-window text shared by the web
 *  and TUI model pickers. Null when unknown. */
export function formatContextWindow(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
