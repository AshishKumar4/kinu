// Shared wire path to the user's Cloudflare AI endpoint (workers-ai, my-gateway, /api/user/ai/v1 proxy).
import { authenticatedSend } from './authenticated-send';
import type { AuthResolution, AuthResolver } from './types';
import { cloudflareAccountAPIRoot } from './cloudflare-oauth';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import { diagnostics, tolerate, toKinuError } from '../obs/index';
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
  /** Provider id the model resolved under; named in refusal diagnostics. */
  provider: string;
  /** Placeholder base URL, rewritten per request because the credential can rotate mid-session. */
  placeholder: string;
  /** 401 message when the credential is missing or unusable. */
  missingCredentialMessage: string;
  /** Extra headers attached after auth injection (e.g. x-session-affinity). */
  requestHeaders?: Record<string, string>;
  /** Maps non-ok responses (after the refresh retry) into actionable errors; without it they pass through. */
  mapError?: (res: Response, resolved: AuthResolution) => Promise<Response> | Response;
}

/**
 * An author's own API at the gateway's endpoint for that author, which takes the request as the author's SDK writes it
 * (its ids, `system` as blocks), where the account endpoint wants the gateway's ids and `system` as one string. The
 * gateway's token goes as `cf-aig-authorization`: there `Authorization` and `x-api-key` are the author's own key (staging
 * gateway, 200 for each, 2026-10-08).
 */
const AUTHOR_ENDPOINTS: ReadonlyMap<string, string> = new Map([['/responses', 'openai/responses'], ['/messages', 'anthropic/v1/messages']]);

const GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com/v1';

/** A Cloudflare credential still rejected after the forced-refresh retry. */
const DEAD_CLOUDFLARE_LOGIN =
  'Your Cloudflare login is no longer valid. Reconnect Cloudflare in User settings.';

export function createCloudflareAIFetch(opts: CloudflareAIFetchOptions): typeof globalThis.fetch {
  const baseFetch = opts.fetch ?? fetch;

  return asFetchFunction(async (input, init) => {
    const auth = await opts.getAuth(opts.credKey);

    if (!auth?.baseURL) return errorResponse(401, opts.missingCredentialMessage);

    const originalUrl = input instanceof Request ? input.url : input.toString();

    const send = async (resolved: AuthResolution) => {
      const headers = copyHeaders(init?.headers);

      for (const [key, value] of Object.entries(resolved.headers)) headers.set(key, value);

      for (const [key, value] of Object.entries(opts.requestHeaders ?? {})) headers.set(key, value);

      const path = originalUrl.startsWith(opts.placeholder) ? originalUrl.slice(opts.placeholder.length) : null;

      if (path === null || !resolved.baseURL) return baseFetch(originalUrl, { ...init, headers });
      const [route = ''] = path.split('?');
      const author = AUTHOR_ENDPOINTS.get(route);
      const gateway = headers.get('cf-aig-gateway-id');
      const account = cloudflareAccountAPIRoot(resolved.baseURL)?.split('/').at(-1);

      if (author === undefined || gateway === null || account === undefined) return baseFetch(resolved.baseURL.replace(/\/+$/, '') + path, { ...init, headers });
      headers.set('cf-aig-authorization', headers.get('authorization') ?? '');

      for (const name of ['authorization', 'x-api-key', 'cf-aig-gateway-id']) headers.delete(name);

      return baseFetch(`${GATEWAY_ORIGIN}/${account}/${encodeURIComponent(gateway)}/${author}${path.slice(route.length)}`, { ...init, headers });
    };

    // A token revoked mid-flight comes back 401 despite the proactive refresh. A renewal without an endpoint is no login.
    const answer = await authenticatedSend({
      key: opts.credKey, auth, send,
      getAuth: async (key, request) => {
        const renewed = await opts.getAuth(key, request);

        return renewed?.baseURL ? renewed : null;
      },
    });

    const res = answer.kind === 'absent' ? errorResponse(401, opts.missingCredentialMessage) : answer.response;
    const resolved = answer.kind === 'answered' ? answer.auth : auth;

    if (!res.ok) {
      // Counted before mapping: status and credential-key name only, never the credential or body
      // (a gateway error body can carry an upstream key).
      diagnostics.failure('provider.error', toKinuError({
        doing: `a request to the account's AI endpoint (HTTP ${res.status})`,
        cause: new Error(`upstream answered ${res.status}`),
        otherwise: res.status === 401 || res.status === 403 ? 'denied' : 'unavailable',
      }), { provider: opts.credKey, source: String(res.status) });
    }

    if (res.ok) return res;

    if (opts.mapError) return inProviderWords(await opts.mapError(res, resolved));

    // A 401 after the forced refresh is a dead shared login, answered here for consumers without a mapper.
    // A mapper keeps first refusal: a gateway 401 can carry a more specific cause (2021).
    return res.status === 401 ? errorResponse(401, DEAD_CLOUDFLARE_LOGIN) : inProviderWords(res);
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
    friendly = `${gateway} cannot route "${modelId}": the unified endpoint only accepts "{provider}/{model}" ids for providers it supports (got provider "${author}").`;
  } else if (code === 2021 || /invalid user credentials/i.test(message ?? '') || /insufficient.*(credit|balance)/i.test(message ?? '')) {
    friendly = `${gateway} has no working credentials for "${author}": add a ${author} key under AI Gateway -> Provider Keys (BYOK), or load Unified Billing credits in your Cloudflare account.`;
  } else if (res.status === 401) {
    // Still 401 after the forced-refresh retry, and no gateway code claimed it.
    friendly = DEAD_CLOUDFLARE_LOGIN;
  }

  if (!friendly) {
    // Unknown failure — keep the original payload intact for the caller.
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  const detail = message && !friendly.includes(message) ? ` (upstream: ${message})` : '';

  return errorResponse(res.status, `${friendly}${detail}`, undefined, res.headers);
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

export function errorResponse(status: number, message: string, code?: number, upstream?: Headers): Response {
  const error = code === undefined ? { message } : { message, code: String(code) };
  // Only the body is new; the refusal's headers, Retry-After among them, still apply (m1820).
  const headers = new Headers(upstream);

  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');

  return new Response(JSON.stringify({ error }), { status, headers });
}

/** A refusal in Cloudflare's v4 envelope, in the OpenAI shape the SDK adapters read, so its own code and words
 *  reach the user rather than the status text. */
async function inProviderWords(res: Response): Promise<Response> {
  const body = await res.text();
  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
  const envelope = v.safeParse(V4ErrorSchema, decoded);
  const first = envelope.success ? envelope.output.errors[0] : undefined;

  if (first?.message !== undefined) return errorResponse(res.status, first.message, first.code, res.headers);

  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
