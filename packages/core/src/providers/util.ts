// Shared provider internals: the auth-injecting fetch wrapper used by the
// simple providers (codex keeps its richer 401-refresh/WAF variant) and the
// small parse helpers the catalog adapters share.
import type { AuthResolution, ModelInfo, ModelProvider, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';
import { withRateLimitRetry } from './rate-limit-retry.js';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../utils/json.js';

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
    const headers = new Headers(init?.headers);
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
 *  provider/model is unknown or the catalog is unreachable. The catalog is
 *  the source of truth for per-model metadata — context window AND input
 *  modalities — so callers prefer it over static fallbacks when it resolves.
 *  Shared by the cf orchestrator's per-spec lookup and the CLI resolver. */
export async function catalogModelInfo(
  provider: Pick<ModelProvider, 'listModels'> | undefined,
  deps: ProviderDeps,
  modelId: string,
): Promise<ModelInfo | null> {
  if (!provider) return null;
  try {
    const models = await provider.listModels(deps);
    return models.find((m) => m.id === modelId) ?? null;
  } catch {
    return null;
  }
}

export function nonEmptyString<T>(value: T): string | undefined {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);
  return parsed.success ? parsed.output : undefined;
}

export function positiveInteger<T>(value: T): number | undefined {
  const parsed = v.safeParse(v.pipe(v.number(), v.finite(), v.gtValue(0)), value);
  return parsed.success ? Math.floor(parsed.output) : undefined;
}

export function isRecord<T>(value: T): value is T & JsonObject {
  try {
    return v.safeParse(JsonObjectSchema, value).success;
  } catch {
    return false;
  }
}

/** How deep to follow nested `{ error: … }` envelopes. OpenAI-shaped bodies
 *  nest once; two spare levels cover the gateways that re-wrap them. */
const PROVIDER_ERROR_MAX_DEPTH = 3;
const PROVIDER_ERROR_MAX_CHARS = 800;
const ErrorResponseSchema = v.object({
  responseBody: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
});

/**
 * Human-readable text for anything a provider can fail with.
 *
 * The AI SDK routes provider failures into the stream as an `error` chunk whose
 * payload is whatever the endpoint sent — frequently a plain object
 * (`{error: {message, code}}` from an OpenAI-shaped SSE body), not an `Error`.
 * `String(thatObject)` is `"[object Object]"`, which is exactly the message
 * users were shown. Dig the message out instead, and fall back to the JSON
 * rather than to a stringification that carries no information.
 */
export function describeProviderError<T>(error: T, depth = 0): string {
  if (error instanceof Error) {
    const summary = error.message || error.name;
    const response = v.safeParse(ErrorResponseSchema, error);
    const responseBody = response.success ? response.output.responseBody : undefined;
    return responseBody ? `${summary}: ${responseBody}`.slice(0, PROVIDER_ERROR_MAX_CHARS) : summary;
  }
  const text = v.safeParse(v.string(), error);
  if (text.success) return text.output.trim() || 'unknown provider error';
  if (isRecord(error)) {
    const message = nonEmptyString(error.message)
      ?? nonEmptyString(error.error_description)
      ?? nonEmptyString(error.detail);
    if (message) {
      const code = nonEmptyString(error.code) ?? nonEmptyString(error.type);
      return code && !message.toLowerCase().includes(code.toLowerCase()) ? `${message} (${code})` : message;
    }
    if (error.error !== undefined && depth < PROVIDER_ERROR_MAX_DEPTH) {
      return describeProviderError(error.error, depth + 1);
    }
  }
  return jsonOrString(error).slice(0, PROVIDER_ERROR_MAX_CHARS);
}

function jsonOrString<T>(value: T): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch { /* circular — fall through */ }
  const record = v.safeParse(v.record(v.string(), v.unknown()), value);
  if (record.success) {
    return `unserializable provider error (${Object.keys(record.output).join(', ') || 'no fields'})`;
  }
  return String(value);
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
