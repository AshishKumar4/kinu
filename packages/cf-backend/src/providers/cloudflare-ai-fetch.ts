// Shared wire path for everything that drives the user's Cloudflare AI
// endpoint ({account}/ai/v1) with a UserDO-held OAuth credential: the
// workers-ai and my-gateway providers, and the CLI-facing /api/user/ai/v1
// proxy. One implementation of resolve-auth → placeholder-URL rewrite →
// refresh-on-401 retry → error mapping, so the request shape cannot drift
// between the three consumers.
import type { AuthResolution, AuthResolver } from '@proteus/core';
import { asFetchFunction, withRateLimitRetry } from '@proteus/core';
import { tolerate } from '@proteus/core/obs';
import { repairSseCachedUsage } from './stream-usage-repair.js';
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
    if (!res.ok && opts.mapError) return opts.mapError(res, resolved);
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
    // Still 401 AFTER the forced-refresh retry → the Cloudflare login is dead.
    friendly = 'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.';
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
