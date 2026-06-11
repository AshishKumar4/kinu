// my-gateway — the USER'S own Cloudflare AI Gateway, authenticated with the
// same Cloudflare OAuth credential as workers-ai. One taxonomy, no drift:
//   workers-ai  — the user's Workers AI quota (`@cf/...` models)
//   my-gateway  — the user's own AI Gateway: third-party models paid by the
//                 gateway's stored BYOK provider keys or Unified Billing credits
//   ai-gateway  — the PLATFORM's env-bound gateway (deploy-time fallback)
//
// Wire path (the documented REST API, the recommended successor of the
// deprecated `/compat` endpoint — developers.cloudflare.com/ai-gateway/usage/rest-api/):
//   POST {account}/ai/v1/chat/completions
//   Authorization:     Bearer <user OAuth token>   (aig.run scope)
//   cf-aig-gateway-id: <the user's selected gateway>
//
// Model specs are `my-gateway/{author}/{model}` — the modelId after the first
// slash is exactly the wire `author/model` id (e.g. `openai/gpt-4.1`).
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo, ProviderDeps, AuthResolution } from '@proteus/core';
import { asFetchFunction, authCacheKey, listModelsDevProviderModels } from '@proteus/core';
import { CLOUDFLARE_AI_GATEWAY_CRED_KEY, cloudflareAccountAPIRoot } from '../lib/cloudflare-oauth.js';

export const MY_GATEWAY_PROVIDER_ID = 'my-gateway';

/** Gateway BYOK `provider_slug` values the OpenAI-compatible REST surface can
 *  serve, mapped to the models.dev catalog id that carries model metadata AND
 *  doubles as the wire author prefix (`author/model`). `google-ai-studio` is
 *  the one slug whose author differs from the slug itself. */
const GATEWAY_SLUG_TO_CATALOG: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'google-ai-studio': 'google',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  deepseek: 'deepseek',
  cerebras: 'cerebras',
  perplexity: 'perplexity',
  cohere: 'cohere',
};

/** Providers Unified Billing can pay for without a stored key
 *  (developers.cloudflare.com/ai-gateway/features/unified-billing/). Listed
 *  only when the account actually holds credits. */
const UNIFIED_BILLING_SLUGS = ['openai', 'anthropic', 'google-ai-studio', 'xai', 'groq'] as const;

const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();

export function createMyGatewayProvider(): ModelProvider {
  return {
    id: MY_GATEWAY_PROVIDER_ID,
    label: 'Your AI Gateway',
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);
      return !!auth?.baseURL;
    },
    unavailableReason: () =>
      'Connect Cloudflare and select an AI Gateway in User settings to use your own gateway (BYOK provider keys or Unified Billing credits).',

    async listModels(deps): Promise<ModelInfo[]> {
      const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);
      if (!auth?.baseURL) return [];
      const cacheKey = authCacheKey(auth);
      const cached = catalogCache.get(cacheKey);
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;

      const slugs = await servableProviderSlugs(auth, deps);
      const models: ModelInfo[] = [];
      for (const slug of slugs) {
        const catalogId = GATEWAY_SLUG_TO_CATALOG[slug];
        if (!catalogId) continue; // slug the OpenAI-compat surface can't serve
        for (const model of await listModelsDevProviderModels(catalogId, deps)) {
          models.push({ ...model, id: `${catalogId}/${model.id}` });
        }
      }
      catalogCache.set(cacheKey, { at: Date.now(), models });
      return models;
    },

    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const placeholder = 'https://proteus-my-gateway.invalid';
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY);
        if (!auth?.baseURL) {
          return errorResponse(401, 'Connect Cloudflare and select an AI Gateway in User settings before using my-gateway models.');
        }

        const originalUrl = typeof input === 'string' ? input
          : input instanceof URL ? input.toString()
            : input.url;
        const send = async (resolved: AuthResolution) => {
          const headers = new Headers(init?.headers);
          for (const [key, value] of Object.entries(resolved.headers)) headers.set(key, value);
          const url = originalUrl.startsWith(placeholder) && resolved.baseURL
            ? resolved.baseURL.replace(/\/+$/, '') + originalUrl.slice(placeholder.length)
            : originalUrl;
          return baseFetch(url, { ...init, headers });
        };

        let res = await send(auth);
        // Same expiry-401 contract as workers-ai/codex: one forced refresh.
        if (res.status === 401) {
          const refreshed = await deps.getAuth(CLOUDFLARE_AI_GATEWAY_CRED_KEY, { forceRefresh: true });
          if (refreshed?.baseURL) res = await send(refreshed);
        }
        if (!res.ok) return mapGatewayError(res, modelId, auth.headers['cf-aig-gateway-id']);
        return res;
      });

      return createOpenAICompatible({
        name: MY_GATEWAY_PROVIDER_ID,
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}

/** Which provider slugs THIS gateway can actually serve: its stored BYOK
 *  provider keys, plus the Unified-Billing set when the account has credits.
 *  Both reads are best-effort — a denied management call (e.g. a credential
 *  predating the aig.read scope) just narrows the menu, never throws. */
async function servableProviderSlugs(auth: AuthResolution, deps: ProviderDeps): Promise<string[]> {
  const account = cloudflareAccountAPIRoot(auth.baseURL!);
  const gatewayId = auth.headers['cf-aig-gateway-id'];
  if (!account || !gatewayId) return [];
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { ...auth.headers, accept: 'application/json' };
  const slugs = new Set<string>();

  try {
    const res = await fetchImpl(
      `${account}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs?per_page=100`,
      { headers },
    );
    if (res.ok) {
      const body = await res.json() as { result?: Array<{ provider_slug?: unknown }> };
      for (const row of body.result ?? []) {
        if (typeof row?.provider_slug === 'string') slugs.add(row.provider_slug);
      }
    }
  } catch { /* BYOK listing unavailable — fall through to unified billing */ }

  try {
    const res = await fetchImpl(`${account}/ai-gateway/billing/credit-balance`, { headers });
    if (res.ok) {
      const body = await res.json() as { result?: { balance?: unknown } };
      if (typeof body.result?.balance === 'number' && body.result.balance > 0) {
        for (const slug of UNIFIED_BILLING_SLUGS) slugs.add(slug);
      }
    }
  } catch { /* no credit visibility — BYOK-only menu */ }

  return [...slugs].sort();
}

/** Rewrite gateway/provider failures into actionable messages that name the
 *  gateway and the upstream provider — never raw Cloudflare error envelopes.
 *  Known shapes: 2008 "Invalid provider" (model id the unified surface can't
 *  route) and 2021 "Invalid User Credentials" (no BYOK key + no credits). */
async function mapGatewayError(res: Response, modelId: string, gatewayId: string | undefined): Promise<Response> {
  const body = await res.text();
  const { code, message } = extractGatewayError(body);
  const author = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId;
  const gateway = gatewayId ? `AI Gateway "${gatewayId}"` : 'your AI Gateway';

  let friendly: string | null = null;
  if (code === 2008 || /invalid provider/i.test(message ?? '')) {
    friendly = `${gateway} cannot route "${modelId}" — the unified endpoint only accepts "{provider}/{model}" ids for providers it supports (got provider "${author}").`;
  } else if (code === 2021 || /invalid user credentials/i.test(message ?? '') || /insufficient.*(credit|balance)/i.test(message ?? '')) {
    friendly = `${gateway} has no working credentials for "${author}" — add a ${author} key under AI Gateway → Provider Keys (BYOK), or load Unified Billing credits in your Cloudflare account.`;
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

function extractGatewayError(body: string): { code: number | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // Cloudflare v4 envelope: { success, errors: [{ code, message }] }
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const first = errors[0] as Record<string, unknown> | undefined;
    if (first) {
      return {
        code: typeof first.code === 'number' ? first.code : null,
        message: typeof first.message === 'string' ? first.message : null,
      };
    }
    // Gateway / OpenAI-style: { error: { code?, message } } or { error: "..." }
    const error = parsed.error;
    if (typeof error === 'string') return { code: null, message: error };
    if (error && typeof error === 'object') {
      const obj = error as Record<string, unknown>;
      return {
        code: typeof obj.code === 'number' ? obj.code : null,
        message: typeof obj.message === 'string' ? obj.message : null,
      };
    }
  } catch { /* not JSON */ }
  return { code: null, message: body.trim() ? body.trim().slice(0, 200) : null };
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
