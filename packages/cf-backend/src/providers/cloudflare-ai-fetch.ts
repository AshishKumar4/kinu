// Shared wire path for everything that drives the user's Cloudflare AI
// endpoint ({account}/ai/v1) with a UserDO-held OAuth credential: the
// workers-ai and my-gateway providers, and the CLI-facing /api/user/ai/v1
// proxy. One implementation of resolve-auth → placeholder-URL rewrite →
// refresh-on-401 retry → error mapping, so the request shape cannot drift
// between the three consumers.
import type { AuthResolution, AuthResolver } from '@kinu.run/core';
import { asFetchFunction, withRateLimitRetry } from '@kinu.run/core';
import { diagnostics, tolerate, toKinuError } from '@kinu.run/core/obs';
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
  /** Credential key resolved through `getAuth` on every request
   *  (`cloudflare.oauth` for Workers AI, `cloudflare.ai-gateway` for the
   *  user's own AI Gateway). */
  credKey: string;
  getAuth: AuthResolver;
  fetch?: typeof fetch;
  /** Placeholder base URL rewritten to the credential's account-scoped
   *  baseURL on every request (the credential can rotate mid-session). */
  placeholder: string;
  /** 401 message when the credential is missing or unusable. */
  missingCredentialMessage: string;
  /** Extra headers attached after auth injection (e.g. x-session-affinity). */
  requestHeaders?: Record<string, string>;
  /** Rewrites non-ok responses (after the refresh retry) into actionable
   *  errors. Without it, upstream failures pass through untouched. */
  mapError?: (res: Response, resolved: AuthResolution) => Promise<Response> | Response;
}

/** A Cloudflare credential still rejected after the forced-refresh retry. One
 *  sentence, two decision points: the shared path answers with it when the
 *  consumer has no mapper, and {@link mapGatewayError} answers with it when no
 *  gateway-specific code claimed the failure first. */
export const DEAD_CLOUDFLARE_LOGIN =
  'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.';

export function createCloudflareAIFetch(opts: CloudflareAIFetchOptions): typeof globalThis.fetch {
  // Retry the raw provider response before auth/error/stream processing so
  // usage repair only ever sees the final response selected by this layer.
  const baseFetch = withRateLimitRetry(opts.fetch ?? fetch);
  return asFetchFunction(async (input, init) => {
    const auth = await opts.getAuth(opts.credKey);
    if (!auth?.baseURL) return errorResponse(401, opts.missingCredentialMessage);

    const originalUrl = v.is(v.string(), input) ? input
      : input instanceof URL ? input.toString()
        : input.url;
    const send = async (resolved: AuthResolution) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(resolved.headers)) headers.set(key, value);
      for (const [key, value] of Object.entries(opts.requestHeaders ?? {})) headers.set(key, value);
      const url = originalUrl.startsWith(opts.placeholder) && resolved.baseURL
        ? resolved.baseURL.replace(/\/+$/, '') + originalUrl.slice(opts.placeholder.length)
        : originalUrl;
      return baseFetch(url, { ...init, headers });
    };

    // Expiry-401 contract shared with the codex provider: UserDO's proactive
    // refresh covers normal expiry, but a token revoked or expired mid-flight
    // comes back 401 — force one refresh and retry once.
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
      // The upstream refusal, counted before it is mapped into a message. What a
      // consumer's `mapError` returns is prose for a person, and the prose is
      // where the cause is currently the ONLY record: a dead Cloudflare login
      // reached six production runs as the plain text `Unauthorized` and left no
      // fleet signal at all, which is why status and credential-key NAME are a
      // row here. Never the credential, never the body — a gateway's error body
      // can carry an upstream key.
      diagnostics.failure('provider.error', toKinuError({
        doing: `a request to the account's AI endpoint (HTTP ${res.status})`,
        cause: new Error(`upstream answered ${res.status}`),
        otherwise: res.status === 401 || res.status === 403 ? 'denied' : 'unavailable',
      }), { provider: opts.credKey, source: String(res.status) });
    }
    if (!res.ok && opts.mapError) return opts.mapError(res, resolved);
    // A 401 that survived the forced refresh is a dead Cloudflare login, and it
    // belongs to the SHARED credential rather than to any one consumer — so the
    // consumers with no mapper of their own are answered here. A consumer that
    // HAS one keeps first refusal above, because a gateway 401 can carry a more
    // specific cause (2021 BYOK/credits) that this sentence would bury.
    //
    // Without this, `workers-ai.ts` — which passes no mapper, and is the
    // provider the owner's workspaces run on — let the upstream body through
    // untouched: Cloudflare answers a rejected credential with the plain text
    // `Unauthorized`, which is what reached `run_end {reason:'error',
    // error:'Unauthorized'}` on six runs in `stone-ash-71f2` and
    // `sunlit-stone-4a20` on 2026-08-17, and the chat's failed-turn card.
    if (res.status === 401) return errorResponse(401, DEAD_CLOUDFLARE_LOGIN);
    // The endpoint's trailing duplicate usage chunk can zero cached_tokens
    // (see stream-usage-repair.ts) — repair it so cache accounting survives.
    return repairSseCachedUsage(res);
  });
}

/** Rewrite gateway/provider failures into actionable messages that name the
 *  gateway and the upstream provider — never raw Cloudflare error envelopes.
 *  Known shapes: 2008 "Invalid provider" (model id the unified surface can't
 *  route) and 2021 "Invalid User Credentials" (no BYOK key + no credits). */
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
    // Still 401 AFTER the forced-refresh retry, and no gateway code claimed it.
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
  // A gateway error body is not required to be JSON; plain text is a real
  // response shape, so the raw text is the answer rather than a fallback for
  // one we failed to read.
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
