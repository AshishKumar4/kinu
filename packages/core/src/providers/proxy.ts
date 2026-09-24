/** General provider proxy: a client without the key sends a secret-free marker and the
 *  server attaches the key, only for targets under that provider's own base URL. */
import { baseCredentialKey } from '../credentials/accounts';
import { ANTHROPIC_BASE_URL, ANTHROPIC_CRED_KEY } from './anthropic';
import { catalogProviderOfKey } from './catalog';
import { getModelsDevProvider, modelsDevCompatBaseURL } from './models-dev';
import { OPENAI_BASE_URL, OPENAI_CRED_KEY } from './openai';
import { OPENROUTER_BASE_URL, OPENROUTER_CRED_KEY } from './openrouter';
import { asFetchFunction } from './fetch-shim';
import type { AuthResolution, ProviderDeps } from './types';
import { copyHeaders } from './fetch-shim';

/** Names the credential the server must attach; its presence marks a proxied request. */
export const PROXY_CRED_HEADER = 'x-kinu-proxy-cred';

/** The upstream URL the proxied request was built for. */
export const PROXY_TARGET_HEADER = 'x-kinu-proxy-target';

/** Shared by client and server so the route cannot drift. */
export const PROVIDER_PROXY_PATH = '/api/user/ai/proxy';

export function providerProxyForwardURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PROVIDER_PROXY_PATH}/forward`;
}

export function providerProxyCredentialsURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PROVIDER_PROXY_PATH}/credentials`;
}

/** The signed-in worker's OpenAI-compatible inference proxy, which serves the
 *  Cloudflare-backed providers; shared by server and clients. */
export const USER_AI_PROXY_PATH = '/api/user/ai/v1';

export function cloudProxyBaseURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${USER_AI_PROXY_PATH}`;
}

/** Provider ids served by that proxy: the signed-in account's, not a local BYO credential. */
export const CLOUD_PROXY_PROVIDER_IDS = ['workers-ai', 'my-gateway'] as const;

export type CloudProxyProviderId = typeof CLOUD_PROXY_PROVIDER_IDS[number];

/** Cloudflare keys also drive the AI Gateway management API, so only pinned endpoints
 *  get them; Codex rejects Workers egress as bot traffic (403). */
const PROXY_DENIED_CRED_KEYS: readonly string[] = [
  'cloudflare.oauth', 'cloudflare.ai-gateway', 'codex.oauth',
];

export function isProxyDeniedCredentialKey(key: string): boolean {
  return PROXY_DENIED_CRED_KEYS.includes(baseCredentialKey(key));
}

/** Static provider base URLs; they win over the models.dev catalog. */
interface StaticProviderBaseUrls {
  readonly [credentialKey: string]: string;
}

const STATIC_PROVIDER_BASE_URLS: StaticProviderBaseUrls = {
  [OPENAI_CRED_KEY]: OPENAI_BASE_URL,
  [ANTHROPIC_CRED_KEY]: ANTHROPIC_BASE_URL,
  [OPENROUTER_CRED_KEY]: OPENROUTER_BASE_URL,
};

/** Base URL a credential may be spent under; null for `openai-compat.*`, whose base URL
 *  lives in the stored credential. */
export async function providerProxyBaseURL(
  credKey: string,
  deps: Pick<ProviderDeps, 'fetch'>,
): Promise<string | null> {
  if (isProxyDeniedCredentialKey(credKey)) return null;
  const staticBase = STATIC_PROVIDER_BASE_URLS[baseCredentialKey(credKey)];

  if (staticBase) return staticBase;
  const catalogId = catalogProviderOfKey(credKey);

  if (!catalogId) return null;
  const info = await getModelsDevProvider(catalogId, deps);

  return info ? modelsDevCompatBaseURL(info) : null;
}

/** Closed (method, path) matrix for inference: the API root also holds key-provisioning
 *  routes, and `/models/{id}` deletes under DELETE. */
const PROXY_ALLOWED_ENDPOINTS: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'POST', path: /^\/chat\/completions$/ },
  { method: 'POST', path: /^\/completions$/ },
  // Create a response, and cancel one — both POST on the OpenAI Responses API.
  { method: 'POST', path: /^\/responses(\/[^/]+)?$/ },
  { method: 'POST', path: /^\/messages(\/count_tokens)?$/ },
  { method: 'POST', path: /^\/embeddings$/ },
  // Discovery only; other verbs on a model id are model management.
  { method: 'GET', path: /^\/models(\/.+)?$/ },
];

/** Same https origin, under `base`'s path, and an allowed (method, endpoint) pair.
 *  Method match is case-sensitive: fetch upper-cases `delete` to `DELETE`. */
export function proxyTargetAllowed(target: string, base: string, method: string): boolean {
  const targetURL = URL.parse(target);
  const baseURL = URL.parse(base);

  if (!targetURL || !baseURL) return false;

  if (targetURL.protocol !== 'https:' || baseURL.protocol !== 'https:') return false;

  // Userinfo in a URL disguises its real host.
  if (targetURL.username || targetURL.password) return false;

  if (targetURL.origin !== baseURL.origin) return false;
  const basePath = baseURL.pathname.replace(/\/+$/, '');

  if (targetURL.pathname !== basePath && !targetURL.pathname.startsWith(`${basePath}/`)) return false;
  const endpoint = targetURL.pathname.slice(basePath.length) || '/';
  const verb = method.toUpperCase();

  return PROXY_ALLOWED_ENDPOINTS.some((allowed) => allowed.method === verb && allowed.path.test(endpoint));
}

/** Secret-free marker resolution, plus the base URL when known. No proxied
 *  `forceRefresh`: its only user, codex, is refused by the proxy. */
export function proxyAuthResolution(credKey: string, baseURL?: string | null): AuthResolution {
  const resolution: AuthResolution = { headers: { [PROXY_CRED_HEADER]: credKey } };

  if (baseURL) resolution.baseURL = baseURL;

  return resolution;
}

export interface ProviderProxyFetchOptions {
  /** Absolute URL of the server's forward route. */
  forwardURL: string;
  /** Caller's `authorization` to the server (a Kinu CLI bearer), not a provider credential. */
  authorization: string;
  /** Extra headers to attach to proxied requests only (e.g. session affinity). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** Relocate requests carrying `PROXY_CRED_HEADER` to the server's forward route;
 *  everything else goes out untouched. */
export function createProviderProxyFetch(opts: ProviderProxyFetchOptions): typeof globalThis.fetch {
  const baseFetch = opts.fetch ?? fetch;

  return asFetchFunction(async (input, init) => {
    const request = describeRequest(input, init);
    const credKey = request.headers.get(PROXY_CRED_HEADER);

    if (!credKey) return baseFetch(input, init);

    const headers = copyHeaders(request.headers);
    headers.set('authorization', opts.authorization);
    headers.set(PROXY_TARGET_HEADER, request.url);

    for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);

    return baseFetch(opts.forwardURL, { ...init, method: request.method, headers });
  });
}

/** Read method/url/headers from either fetch call shape, preferring `init`; the body
 *  rides along in `init` (callers use `(url, init)`). */
function describeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const fromRequest = input instanceof Request ? input : null;

  return {
    url: input instanceof Request ? input.url : String(input),
    method: init?.method ?? fromRequest?.method ?? 'GET',
    headers: copyHeaders(init?.headers ?? fromRequest?.headers),
  };
}
