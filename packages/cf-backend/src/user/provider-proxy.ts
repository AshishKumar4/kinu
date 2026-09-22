/**
 * Provider proxy for signed-in CLI clients: lists proxyable credentials and forwards one upstream
 * request with the credential attached inside the Worker; the raw secret never reaches the client.
 * The target origin, path, and method are checked against the provider base (`proxyTargetAllowed`)
 * so the key cannot reach other hosts or key-minting/deletion routes; see `PROXY_DENIED_CRED_KEYS`.
 * Bodies pass through byte-for-byte; no cached-usage repair is applied here.
 */
import {
  PROVIDER_PROXY_PATH,
  PROXY_CRED_HEADER, PROXY_DENIED_CRED_KEYS, PROXY_TARGET_HEADER,
  providerProxyBaseURL, proxyTargetAllowed,
} from '@kinu.run/core';
import type { UserDO } from './user-do';
import { errorResponse } from '@kinu.run/core';
import { json } from '@kinu.run/core';
import { ownerCaller, type OwnerCapabilityEnv, type UserCaller } from '@kinu.run/core';
import { validateCredentialKey } from '@kinu.run/core';
import { renderCauseChain, renderThrownChain } from '@kinu.run/core/obs';

export const USER_AI_PROXY_FORWARD_PREFIX = PROVIDER_PROXY_PATH;

/** Client view of a proxyable credential; never carries secret material. `baseURL` is set for
 * openai-compat credentials; `failure` marks an unreadable entry without failing the listing. */
export interface ProxyableCredential {
  key: string;
  baseURL?: string;
  failure?: string;
}

/** Headers not replayed upstream: Kinu bearer, proxy control and hop-by-hop headers, and
 * Cloudflare edge headers, which would disclose the CLI user's IP to the provider. */
const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  'authorization', 'cookie', 'host',
  PROXY_CRED_HEADER, PROXY_TARGET_HEADER,
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
];

export type ProxyCredentialSource = Pick<UserDO, 'listCredentials' | 'getCredentialBaseURL' | 'getAuthHeaders'>;

export async function handleUserProviderProxyRequest(
  request: Request,
  env: OwnerCapabilityEnv,
  cli: { userDO: ProxyCredentialSource },
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(USER_AI_PROXY_FORWARD_PREFIX.length);
  const owner = await ownerCaller(env);

  if (path === '/credentials' && request.method === 'GET') {
    return json({ body: { credentials: await listProxyableCredentials(cli.userDO, owner) } });
  }

  if (path === '/forward') {
    return forwardUpstream(request, cli.userDO, owner);
  }

  return errorResponse(404, `No such provider proxy route: ${request.method} ${path}`);
}

/** Proxyable = a base URL is derivable (credential or provider layer); others are omitted
 * rather than advertised and refused at send time. */
async function listProxyableCredentials(
  userDO: ProxyCredentialSource,
  owner: UserCaller,
): Promise<ProxyableCredential[]> {
  const stored = await userDO.listCredentials(owner);
  const out: ProxyableCredential[] = [];

  for (const { key } of stored) {
    if (PROXY_DENIED_CRED_KEYS.includes(key)) continue;
    let credentialBase: string | null;

    try {
      credentialBase = await userDO.getCredentialBaseURL(owner, key);
    } catch (cause) {
      out.push({ key, failure: renderThrownChain({ cause }) });
      continue;
    }

    if (credentialBase) {
      // Forwarding is https-only; non-https endpoints (e.g. the owner's own machine) are not proxyable.
      if (credentialBase.startsWith('https://')) out.push({ key, baseURL: credentialBase });
      continue;
    }

    if (await providerProxyBaseURL(key, { fetch })) out.push({ key });
  }

  return out;
}

async function forwardUpstream(
  request: Request,
  userDO: ProxyCredentialSource,
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

  if (!proxyTargetAllowed(target, base, request.method)) {
    return errorResponse(403, `${request.method} "${target}" is outside what credential "${credKey}" may be spent on (${base}).`);
  }

  const auth = await userDO.getAuthHeaders(owner, credKey);

  if (!auth) {
    return errorResponse(401, `No usable credential is connected for "${credKey}". Connect it in your Kinu user settings.`);
  }

  const headers = new Headers(request.headers);

  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);

  for (const [name, value] of Object.entries(auth)) headers.set(name, value);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  // Manual redirect: following a 3xx would re-send the credential to an origin outside the
  // allowlist. The 3xx is returned to the caller.
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (hasBody) init.body = await request.arrayBuffer();

  return fetch(target, init);
}
