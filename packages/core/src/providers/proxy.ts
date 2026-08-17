/**
 * The general provider proxy — the wire contract that lets a client with no
 * secret of its own drive a provider whose API key is held somewhere else.
 *
 * The shape of the problem: every provider adapter here reaches its endpoint
 * through `deps.getAuth(credKey)` (headers) and `deps.fetch` (the send). A
 * client that HAS the key resolves real headers and sends directly. A client
 * that does not can resolve a MARKER instead — a header naming the credential
 * key, carrying no secret — and let a fetch wrapper relocate the request to a
 * server that holds the key, attaches it there, and streams the answer back.
 * Nothing else in the provider layer changes, which is why this works for
 * every adapter at once (bespoke and models.dev catalog alike) instead of
 * needing a proxy shim per provider.
 *
 * Two rules make it safe to be general:
 *
 *   1. The client names the credential and the target URL; the SERVER decides
 *      whether that URL is one the credential may be spent on, by resolving
 *      the provider's own base URL from `providerProxyBaseURL` and requiring
 *      the target to sit under it. Without that check the route would be an
 *      open forwarder that attaches the owner's API key to any host a caller
 *      names — key exfiltration in one request.
 *   2. `PROXY_DENIED_CRED_KEYS` — some credentials are not the proxy's to
 *      spend at all. See that list for each one's reason.
 */
import { ANTHROPIC_BASE_URL, ANTHROPIC_CRED_KEY } from './anthropic.js';
import { getModelsDevProvider, modelsDevCompatBaseURL } from './models-dev.js';
import { OPENAI_BASE_URL, OPENAI_CRED_KEY } from './openai.js';
import { OPENROUTER_BASE_URL, OPENROUTER_CRED_KEY } from './openrouter.js';
import { asFetchFunction } from './fetch-shim.js';
import type { AuthResolution, ProviderDeps } from './types.js';

/** Names the credential the server must attach. Present on a request means
 *  "this one is proxied"; absent means the caller resolved real auth and the
 *  request goes out directly. Never carries secret material. */
export const PROXY_CRED_HEADER = 'x-proteus-proxy-cred';
/** The upstream URL the proxied request was built for. */
export const PROXY_TARGET_HEADER = 'x-proteus-proxy-target';
/** The route both sides agree on. Owned here so the client that builds the
 *  URL and the server that mounts it cannot drift. */
export const PROVIDER_PROXY_PATH = '/api/user/ai/proxy';

export function providerProxyForwardURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PROVIDER_PROXY_PATH}/forward`;
}

export function providerProxyCredentialsURL(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PROVIDER_PROXY_PATH}/credentials`;
}

/**
 * Credentials the general proxy refuses to front.
 *
 * The two Cloudflare keys authorize more than inference — the same bearer
 * drives the AI Gateway management API — so they must only ever meet an
 * endpoint the server pinned itself, and the `/api/user/ai/v1` proxy is where
 * they are served.
 *
 * `codex.oauth` is refused for a different and entirely practical reason: the
 * Codex endpoint refuses Cloudflare Workers egress as bot traffic (the WAF
 * case codex.ts already handles). Proxying it would turn a local credential
 * that works today into a 403, so a machine that wants Codex keeps its own.
 */
export const PROXY_DENIED_CRED_KEYS: readonly string[] = [
  'cloudflare.oauth', 'cloudflare.ai-gateway', 'codex.oauth',
];

/** Base URLs owned by a statically registered provider. These win over the
 *  models.dev catalog for the same reason the registry's static tier wins:
 *  the adapter, not the catalog, decides where a bespoke provider talks. */
interface StaticProviderBaseUrls {
  readonly [credentialKey: string]: string;
}

const STATIC_PROVIDER_BASE_URLS: StaticProviderBaseUrls = {
  [OPENAI_CRED_KEY]: OPENAI_BASE_URL,
  [ANTHROPIC_CRED_KEY]: ANTHROPIC_BASE_URL,
  [OPENROUTER_CRED_KEY]: OPENROUTER_BASE_URL,
};

const CATALOG_CRED_KEY_PATTERN = /^([a-z0-9][a-z0-9._-]*)\.bearer$/;

/**
 * Where a credential is allowed to be spent — the single answer both sides
 * need. The client uses it to know a proxied provider has a reachable
 * endpoint at all; the server uses it as the allowlist a client-named target
 * must fall under.
 *
 * Null means "this key has no base URL derivable from the provider layer".
 * `openai-compat.*` credentials return null here on purpose: their base URL
 * is part of the stored credential, so only the side holding the credential
 * can supply it.
 */
export async function providerProxyBaseURL(
  credKey: string,
  deps: Pick<ProviderDeps, 'fetch'>,
): Promise<string | null> {
  if (PROXY_DENIED_CRED_KEYS.includes(credKey)) return null;
  const staticBase = STATIC_PROVIDER_BASE_URLS[credKey];
  if (staticBase) return staticBase;
  const catalogId = CATALOG_CRED_KEY_PATTERN.exec(credKey)?.[1];
  if (!catalogId) return null;
  const info = await getModelsDevProvider(catalogId, deps);
  return info ? modelsDevCompatBaseURL(info) : null;
}

/**
 * The endpoints a proxied credential may be spent on, relative to its base URL.
 *
 * Origin and path-prefix alone are not enough. A provider's API root holds more
 * than inference: `https://openrouter.ai/api/v1/keys` and
 * `https://api.openai.com/v1/organization/admin_api_keys` sit directly under
 * the same base as `/chat/completions`, and a key with provisioning rights
 * would mint a fresh cleartext key through them. Proxying is for running
 * models, so this is what running models needs and nothing else.
 */
const PROXY_ALLOWED_PATHS: readonly RegExp[] = [
  /^\/chat\/completions$/,
  /^\/completions$/,
  /^\/responses(\/[^/]+)?$/,
  /^\/messages(\/count_tokens)?$/,
  /^\/embeddings$/,
  /^\/models(\/.+)?$/,
];

/**
 * Whether `target` may be reached with the credential whose base URL is
 * `base`: same https origin, under `base`'s path, and one of the inference
 * endpoints above. A base of `https://api.groq.com/openai/v1` therefore admits
 * `/openai/v1/chat/completions` and refuses `/openai/v1x`, another host, and
 * the provider's own account-management routes.
 */
export function proxyTargetAllowed(target: string, base: string): boolean {
  // Asked, not caught: `URL.parse` reports an unparseable URL as null, so a
  // refusal here is always a refusal this predicate decided.
  const targetURL = URL.parse(target);
  const baseURL = URL.parse(base);
  if (!targetURL || !baseURL) return false;
  if (targetURL.protocol !== 'https:' || baseURL.protocol !== 'https:') return false;
  // A URL carrying credentials cannot be handed to fetch, and its authority is
  // exactly the shape used to make a target look like somewhere it is not.
  if (targetURL.username || targetURL.password) return false;
  if (targetURL.origin !== baseURL.origin) return false;
  const basePath = baseURL.pathname.replace(/\/+$/, '');
  if (targetURL.pathname !== basePath && !targetURL.pathname.startsWith(`${basePath}/`)) return false;
  const endpoint = targetURL.pathname.slice(basePath.length) || '/';
  return PROXY_ALLOWED_PATHS.some((allowed) => allowed.test(endpoint));
}

/** The secret-free `AuthResolution` a proxied credential resolves to: a marker
 *  naming the key, plus the base URL when the resolver knows it (openai-compat
 *  and the models.dev catalog path both need one to rewrite their placeholder
 *  base). The provider layer treats it like any other resolution.
 *
 *  There is no proxied form of `forceRefresh`. The only provider that asks for
 *  one is codex, whose credential the proxy refuses outright — so a refresh
 *  marker would be a wire feature nothing could ever set. */
export function proxyAuthResolution(credKey: string, baseURL?: string | null): AuthResolution {
  const resolution: AuthResolution = { headers: { [PROXY_CRED_HEADER]: credKey } };
  if (baseURL) resolution.baseURL = baseURL;
  return resolution;
}

export interface ProviderProxyFetchOptions {
  /** Absolute URL of the server's forward route. */
  forwardURL: string;
  /** Value for the `authorization` header identifying the caller to the
   *  server (a Proteus CLI bearer). Not a provider credential. */
  authorization: string;
  /** Extra headers to attach to proxied requests only (e.g. session affinity). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * Wrap a fetch so requests carrying `PROXY_CRED_HEADER` are relocated to the
 * server's forward route and everything else goes out untouched. One wrapper
 * covers a whole registry: the marker travels on the request because it came
 * from that credential's `AuthResolution`, so a provider resolving a local key
 * and a provider resolving a proxied one share this fetch without knowing it.
 */
export function createProviderProxyFetch(opts: ProviderProxyFetchOptions): typeof globalThis.fetch {
  const baseFetch = opts.fetch ?? fetch;
  return asFetchFunction(async (input, init) => {
    const request = describeRequest(input, init);
    const credKey = request.headers.get(PROXY_CRED_HEADER);
    if (!credKey) return baseFetch(input, init);

    const headers = new Headers(request.headers);
    headers.set('authorization', opts.authorization);
    headers.set(PROXY_TARGET_HEADER, request.url);
    for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);

    return baseFetch(opts.forwardURL, { ...init, method: request.method, headers });
  });
}

/** Read method/url/headers out of the two call shapes a fetch can take,
 *  preferring `init` exactly as the platform does. The body is not read here:
 *  the provider layer always calls its fetch as `(url, init)` (see
 *  `createAuthedFetch`), so spreading `init` forwards the body untouched. */
function describeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const fromRequest = input instanceof Request ? input : null;
  return {
    url: fromRequest ? fromRequest.url : String(input),
    method: init?.method ?? fromRequest?.method ?? 'GET',
    headers: new Headers(init?.headers ?? fromRequest?.headers),
  };
}
