// Shared provider internals: the auth-injecting fetch wrapper used by the
// simple providers (codex keeps its richer 401-refresh/WAF variant) and the
// small parse helpers the catalog adapters share.
import type { AuthResolution, ModelInfo, ProviderDeps } from './types.js';
import { asFetchFunction } from './fetch-shim.js';

export interface AuthedFetchOptions {
  /** Credential key passed to the AuthResolver on every request. */
  credKey: string;
  /** 401 JSON body `error` text when no credential is configured. */
  missingCredentialError: string;
  /** Reject (401) when the credential lacks a baseURL (openai-compat). */
  requireBaseURL?: boolean;
  /** Adjust headers and/or return a replacement URL after auth injection. */
  mutate?: (ctx: { url: string; headers: Headers; auth: AuthResolution }) => string | void;
}

/**
 * Build the resolve-auth → 401-if-missing → merge-headers → fetch wrapper
 * every API-key provider needs. Auth is re-resolved per request so credential
 * changes take effect without rebuilding the model.
 */
export function createAuthedFetch(deps: ProviderDeps, opts: AuthedFetchOptions): typeof globalThis.fetch {
  const baseFetch = deps.fetch ?? fetch;
  return asFetchFunction(async (input, init) => {
    const auth = await deps.getAuth(opts.credKey);
    if (!auth || (opts.requireBaseURL && !auth.baseURL)) {
      return new Response(
        JSON.stringify({ error: opts.missingCredentialError }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(auth.headers)) headers.set(k, v);
    const url = typeof input === 'string' ? input
              : input instanceof URL ? input.toString()
              : input.url;
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
  }));
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
