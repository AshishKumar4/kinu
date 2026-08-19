/**
 * The general provider proxy for signed-in CLI clients:
 *
 *   GET /api/user/ai/proxy/credentials   — which stored credentials can be proxied
 *   ANY /api/user/ai/proxy/forward       — send one upstream request with one attached
 *
 * `/api/user/ai/v1` fronts the two Cloudflare-backed providers with an
 * endpoint this server pins itself. This route is the general form: a key the
 * owner connected in the web UI (OpenRouter, OpenAI, Anthropic, any models.dev
 * provider) becomes usable by local agents with no second copy of the secret on
 * the user's disk. The credential is resolved and attached HERE, inside the
 * Worker, exactly as the DO-backed cloud path does — the raw value never
 * travels to the client in either direction.
 *
 * The client names the credential (`x-proteus-proxy-cred`) and the upstream URL
 * (`x-proteus-proxy-target`); this route decides whether that URL is one the
 * credential may be spent on, by resolving the provider's own base URL and
 * checking the target against it — same https origin, under that path, and one
 * of the inference endpoints (`proxyTargetAllowed`). Without the origin check
 * the route would attach the owner's API key to any host a caller named;
 * without the endpoint list it would reach the provider's own key-minting
 * routes, which sit under the same base as `/chat/completions`. Some
 * credentials are not the proxy's to spend at all — see
 * `PROXY_DENIED_CRED_KEYS` for each one's reason.
 *
 * Bodies and responses pass through byte-for-byte, so streaming works and the
 * provider's own usage/cost fields reach the caller's `step_finish` accounting
 * unaltered. No cached-usage repair is applied here — that repair is a fix for
 * one Cloudflare endpoint's duplicate usage chunk, not a general truth.
 */
import {
  PROVIDER_PROXY_PATH,
  PROXY_CRED_HEADER, PROXY_DENIED_CRED_KEYS, PROXY_TARGET_HEADER,
  providerProxyBaseURL, proxyTargetAllowed,
} from '@proteus/core';
import type { UserDO } from './user-do';
import { errorResponse } from '../providers/cloudflare-ai-fetch';
import { json } from '../lib/http';
import { ownerCaller, type UserCaller } from './workspace-capability';
import { validateCredentialKey } from './validate';
import { renderCauseChain } from '@proteus/core/obs';

export const USER_AI_PROXY_FORWARD_PREFIX = PROVIDER_PROXY_PATH;

/** One proxyable credential, as the client sees it: the key it can name, and
 *  the base URL when only this side knows it (an openai-compat credential
 *  carries its own endpoint). No secret material, ever. */
export interface ProxyableCredential {
  key: string;
  baseURL?: string;
}

/** Request headers that must not be replayed upstream: the caller's Proteus
 *  bearer (replaced by the provider credential), the proxy's own control
 *  headers, the hop-by-hop set the runtime owns, and the edge headers
 *  Cloudflare adds on the way in — `cf-connecting-ip` and friends would tell a
 *  third-party provider the CLI user's IP address, which is not the proxy's to
 *  disclose. */
const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  'authorization', 'cookie', 'host',
  PROXY_CRED_HEADER, PROXY_TARGET_HEADER,
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
];

export async function handleUserProviderProxyRequest(
  request: Request,
  env: Env,
  cli: { userDO: DurableObjectStub<UserDO> },
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(USER_AI_PROXY_FORWARD_PREFIX.length);
  const owner = await ownerCaller(env);

  if (path === '/credentials' && request.method === 'GET') {
    return json({ credentials: await listProxyableCredentials(cli.userDO, owner) });
  }
  if (path === '/forward') {
    return forwardUpstream(request, cli.userDO, owner);
  }
  return errorResponse(404, `No such provider proxy route: ${request.method} ${path}`);
}

/**
 * The stored credentials this route can front. A credential is proxyable when
 * a base URL can be derived for it — from the credential itself (openai-compat)
 * or from the provider layer (a static provider, or a models.dev catalog entry
 * with an OpenAI-surface endpoint). Everything else is omitted rather than
 * advertised and then refused at send time.
 */
async function listProxyableCredentials(
  userDO: DurableObjectStub<UserDO>,
  owner: UserCaller,
): Promise<ProxyableCredential[]> {
  const stored = await userDO.listCredentials(owner);
  const out: ProxyableCredential[] = [];
  for (const { key } of stored) {
    if (PROXY_DENIED_CRED_KEYS.includes(key)) continue;
    const credentialBase = await userDO.getCredentialBaseURL(owner, key);
    if (credentialBase) {
      // The forward route sends to https only, so a credential naming anything
      // else is not proxyable however well-formed it is — an endpoint on the
      // owner's own machine is the common case, and it is theirs to reach
      // directly, not through here.
      if (credentialBase.startsWith('https://')) out.push({ key, baseURL: credentialBase });
      continue;
    }
    if (await providerProxyBaseURL(key, { fetch })) out.push({ key });
  }
  return out;
}

async function forwardUpstream(
  request: Request,
  userDO: DurableObjectStub<UserDO>,
  owner: UserCaller,
): Promise<Response> {
  const credKey = request.headers.get(PROXY_CRED_HEADER)?.trim();
  const target = request.headers.get(PROXY_TARGET_HEADER)?.trim();
  if (!credKey) return errorResponse(400, `${PROXY_CRED_HEADER} is required — name the credential to attach.`);
  if (!target) return errorResponse(400, `${PROXY_TARGET_HEADER} is required — name the upstream URL.`);
  try { validateCredentialKey(credKey); }
  catch (err) { return errorResponse(400, err instanceof Error ? renderCauseChain(err) : 'Invalid credential key.'); }
  if (PROXY_DENIED_CRED_KEYS.includes(credKey)) {
    return errorResponse(403, `${credKey} is not served by this proxy — Cloudflare-backed models go through /api/user/ai/v1, and Codex must be connected on the machine that uses it.`);
  }

  const base = await userDO.getCredentialBaseURL(owner, credKey)
    ?? await providerProxyBaseURL(credKey, { fetch });
  if (!base) {
    return errorResponse(400, `No upstream endpoint is known for credential "${credKey}", so it cannot be proxied.`);
  }
  if (!proxyTargetAllowed(target, base)) {
    return errorResponse(403, `"${target}" is outside the endpoint credential "${credKey}" may be spent on (${base}).`);
  }

  const auth = await userDO.getAuthHeaders(owner, credKey);
  if (!auth) {
    return errorResponse(401, `No usable credential is connected for "${credKey}". Connect it in your Proteus user settings.`);
  }

  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  for (const [name, value] of Object.entries(auth)) headers.set(name, value);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // `redirect: 'manual'` is load-bearing, not tidiness: following a 3xx would
  // re-send the attached credential to whatever origin the provider named,
  // which is the one way a target that passed the allowlist could still end up
  // somewhere else. The 3xx is handed back to the caller instead.
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (hasBody) init.body = await request.arrayBuffer();
  return fetch(target, init);
}
