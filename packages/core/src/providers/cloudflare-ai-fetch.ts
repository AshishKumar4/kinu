// Shared wire path to the user's Cloudflare AI endpoint (workers-ai, my-gateway, /api/user/ai/v1 proxy).
import type { AuthResolution, AuthResolver, ProviderWaitInfo } from './types';
import { asFetchFunction } from './fetch-shim';
import { withRateLimitRetry } from './rate-limit-retry';
import { diagnostics, tolerate, toKinuError } from '../obs/index';
import { repairSseCachedUsage } from './stream-usage-repair';
import * as v from 'valibot';

interface GatewayErrorDetail { code: number | null; message: string | null }

const V4ErrorSchema = v.object({
  errors: v.array(v.object({ code: v.optional(v.number()), message: v.optional(v.string()) })),
});

const OpenAIErrorSchema = v.object({
  error: v.union([
    v.string(),
    v.object({ code: v.optional(v.number()), message: v.optional(v.string()) }),
  ]),
});

export interface CloudflareAIFetchOptions {
  /** Credential key resolved through `getAuth` on every request. */
  credKey: string;
  getAuth: AuthResolver;
  fetch?: typeof fetch;
  /** Provider id the model resolved under; named in wait notices. */
  provider: string;
  /** The model the requests are for — carried into the same notices. */
  modelId?: string;
  /** The rate-limit wait listener (ProviderDeps.onProviderWait). */
  onProviderWait?: (info: ProviderWaitInfo) => void;
  /** Placeholder base URL, rewritten per request because the credential can rotate mid-session. */
  placeholder: string;
  /** 401 message when the credential is missing or unusable. */
  missingCredentialMessage: string;
  /** Extra headers attached after auth injection (e.g. x-session-affinity). */
  requestHeaders?: Record<string, string>;
  /** Maps non-ok responses (after the refresh retry) into actionable errors; without it they pass through. */
  mapError?: (res: Response, resolved: AuthResolution) => Promise<Response> | Response;
}

/** A Cloudflare credential still rejected after the forced-refresh retry. */
const DEAD_CLOUDFLARE_LOGIN =
  'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.';

export function createCloudflareAIFetch(opts: CloudflareAIFetchOptions): typeof globalThis.fetch {
  // Retry before auth/error/stream processing so usage repair sees only the final response.
  const baseFetch = withRateLimitRetry(opts.fetch ?? fetch, {
    provider: opts.provider,
    ...(opts.modelId !== undefined && { modelId: opts.modelId }),
    ...(opts.onProviderWait !== undefined && { onWait: opts.onProviderWait }),
  });

  return asFetchFunction(async (input, init) => {
    const auth = await opts.getAuth(opts.credKey);

    if (!auth?.baseURL) return errorResponse(401, opts.missingCredentialMessage);

    const originalUrl = input instanceof Request ? input.url : input.toString();

    const send = async (resolved: AuthResolution) => {
      // Copied by shape, not `new Headers(init?.headers)`: some lib combinations reject the iterable HeadersInit arm.
      const headers = new Headers();
      const incoming = init?.headers;

      if (incoming !== undefined) {
        if (incoming instanceof Headers) for (const [key, value] of incoming) headers.set(key, value);
        else if (Symbol.iterator in incoming) {
          for (const [key, value] of incoming) headers.set(key, value);
        } else for (const [key, value] of Object.entries(incoming)) headers.set(key, value);
      }

      for (const [key, value] of Object.entries(resolved.headers)) headers.set(key, value);

      for (const [key, value] of Object.entries(opts.requestHeaders ?? {})) headers.set(key, value);

      const url = originalUrl.startsWith(opts.placeholder) && resolved.baseURL
        ? resolved.baseURL.replace(/\/+$/, '') + originalUrl.slice(opts.placeholder.length)
        : originalUrl;

      return baseFetch(url, { ...init, headers });
    };

    // A token revoked mid-flight comes back 401 despite UserDO's proactive refresh: force one refresh, retry once.
    let resolved = auth;
    let res = await send(resolved);

    if (res.status === 401) {
      const refreshed = await opts.getAuth(opts.credKey, { forceRefresh: true });

      if (refreshed?.baseURL) {
        resolved = refreshed;
        res = await send(resolved);
      }
    }

    if (!res.ok) {
      // Counted before mapping: status and credential-key name only, never the credential or body
      // (a gateway error body can carry an upstream key).
      diagnostics.failure('provider.error', toKinuError({
        doing: `a request to the account's AI endpoint (HTTP ${res.status})`,
        cause: new Error(`upstream answered ${res.status}`),
        otherwise: res.status === 401 || res.status === 403 ? 'denied' : 'unavailable',
      }), { provider: opts.credKey, source: String(res.status) });
    }

    if (!res.ok && opts.mapError) return opts.mapError(res, resolved);

    // A 401 after the forced refresh is a dead shared login, answered here for consumers without a mapper.
    // A mapper keeps first refusal: a gateway 401 can carry a more specific cause (2021).
    if (res.status === 401) return errorResponse(401, DEAD_CLOUDFLARE_LOGIN);

    // Repair the endpoint's trailing duplicate usage chunk, which can zero cached_tokens.
    return repairSseCachedUsage(res);
  });
}

/** Rewrite gateway failures into messages naming the gateway and upstream provider.
 *  Known: 2008 "Invalid provider" and 2021 "Invalid User Credentials" (no BYOK key, no credits). */
export async function mapGatewayError(res: Response, modelId: string, gatewayId: string | undefined): Promise<Response> {
  const body = await res.text();
  const { code, message } = extractGatewayError(body);
  const author = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId;
  const gateway = gatewayId ? `AI Gateway "${gatewayId}"` : 'your AI Gateway';

  let friendly: string | null = null;

  if (code === 2008 || /invalid provider/i.test(message ?? '')) {
    friendly = `${gateway} cannot route "${modelId}" — the unified endpoint only accepts "{provider}/{model}" ids for providers it supports (got provider "${author}").`;
  } else if (code === 2021 || /invalid user credentials/i.test(message ?? '') || /insufficient.*(credit|balance)/i.test(message ?? '')) {
    friendly = `${gateway} has no working credentials for "${author}" — add a ${author} key under AI Gateway → Provider Keys (BYOK), or load Unified Billing credits in your Cloudflare account.`;
  } else if (res.status === 401) {
    // Still 401 after the forced-refresh retry, and no gateway code claimed it.
    friendly = DEAD_CLOUDFLARE_LOGIN;
  }

  if (!friendly) {
    // Unknown failure — keep the original payload intact for the caller.
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    });
  }

  const detail = message && !friendly.includes(message) ? ` (upstream: ${message})` : '';

  return errorResponse(res.status, `${friendly}${detail}`);
}

function extractGatewayError(body: string): GatewayErrorDetail {
  // A gateway error body need not be JSON; plain text is a real answer.
  const rawText: GatewayErrorDetail = {
    code: null,
    message: body.trim() ? body.trim().slice(0, 200) : null,
  };

  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');

  if (decoded === undefined) return rawText;

  // Cloudflare v4 envelope: { success, errors: [{ code, message }] }
  const v4 = v.safeParse(V4ErrorSchema, decoded);
  const first = v4.success ? v4.output.errors[0] : undefined;

  if (first) return { code: first.code ?? null, message: first.message ?? null };

  // Gateway / OpenAI-style: { error: { code?, message } } or { error: "..." }
  const openAI = v.safeParse(OpenAIErrorSchema, decoded);

  if (!openAI.success) return rawText;
  const error = openAI.output.error;

  return v.is(v.string(), error)
    ? { code: null, message: error }
    : { code: error.code ?? null, message: error.message ?? null };
}

export function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
