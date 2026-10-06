/**
 * Provider proxy for signed-in CLI clients: lists proxyable credentials and forwards one upstream
 * request with the credential attached inside the Worker; the raw secret never reaches the client.
 * The target origin, path, and method are checked against the provider base (`proxyTargetAllowed`)
 * so the key cannot reach other hosts or key-minting/deletion routes.
 * Bodies pass through byte-for-byte; no cached-usage repair is applied here.
 */
import { Hono } from 'hono';
import {
  PROVIDER_PROXY_PATH,
  PROXY_CRED_HEADER, PROXY_TARGET_HEADER, isProxyDeniedCredentialKey,
  providerProxyBaseURL, proxyTargetAllowed,
} from '@kinu.run/core';
import type { UserDO } from './user-do';
import { errorResponse } from '@kinu.run/core';
import { json } from '@kinu.run/core';
import { ownerCaller, type UserCaller } from '@kinu.run/core';
import { validateCredentialKey } from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { authoredRefusal, diagnostics, renderThrownChain, settle } from '@kinu.run/core/obs';
import { beneath, type FamilyEnv } from '../api/context';
import { inferenceProxyGate, type CliBearerEnv, type CliBearerVariables } from '../api/cli-bearer';
import type { CliAuthAuthority } from '../cli/auth-store';

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

type ProxyAuthority = CliAuthAuthority & ProxyCredentialSource;

export const providerProxyRoutes = new Hono<FamilyEnv<CliBearerEnv<ProxyAuthority>, CliBearerVariables<ProxyAuthority>>>();

providerProxyRoutes.use(`${PROVIDER_PROXY_PATH}/*`, beneath(PROVIDER_PROXY_PATH, inferenceProxyGate()));

providerProxyRoutes.get(`${PROVIDER_PROXY_PATH}/credentials`, (c) => settle(Effect.gen(function* () {
  const owner = yield* Effect.promise(() => ownerCaller(c.env));

  return json({ body: { credentials: yield* listProxyableCredentials(c.get('cli').userDO, owner) } });
})));

// Any method: `forwardUpstream` checks the target.
providerProxyRoutes.all(`${PROVIDER_PROXY_PATH}/forward`, (c) => settle(Effect.gen(function* () {
  const owner = yield* Effect.promise(() => ownerCaller(c.env));

  return yield* forwardUpstream(c.req.raw, c.get('cli').userDO, owner);
})));

providerProxyRoutes.all(`${PROVIDER_PROXY_PATH}/*`, beneath(PROVIDER_PROXY_PATH, async (c) =>
  errorResponse(404, `No such provider proxy route: ${c.req.method} ${c.req.path.slice(PROVIDER_PROXY_PATH.length)}`)));

/** Proxyable = a base URL is derivable (credential or provider layer); others are omitted
 * rather than advertised and refused at send time. */
function listProxyableCredentials(
  userDO: ProxyCredentialSource,
  owner: UserCaller,
): Effect.Effect<ProxyableCredential[]> {
  return Effect.gen(function* () {
    const stored = yield* Effect.promise(() => userDO.listCredentials(owner));
    const out: ProxyableCredential[] = [];

    for (const { key } of stored) {
      if (isProxyDeniedCredentialKey(key)) continue;

      const read = yield* Effect.matchCause(Effect.promise(() => userDO.getCredentialBaseURL(owner, key)), {
        onSuccess: (credentialBase) => ({ credentialBase }),
        onFailure: (failed) => {
          const error = authoredRefusal({ doing: 'reading a credential\'s base URL', cause: Cause.squash(failed) });
          diagnostics.failure('provider_proxy.base_url_unread', error, { key });

          return { refused: renderThrownChain({ cause: error }) };
        },
      });

      if ('refused' in read) {
        out.push({ key, failure: read.refused });
        continue;
      }

      const credentialBase = read.credentialBase;

      if (credentialBase) {
        // Forwarding is https-only; non-https endpoints (e.g. the owner's own machine) are not proxyable.
        if (credentialBase.startsWith('https://')) out.push({ key, baseURL: credentialBase });
        continue;
      }

      if (yield* Effect.promise(() => providerProxyBaseURL(key, { fetch }))) out.push({ key });
    }

    return out;
  });
}

function forwardUpstream(
  request: Request,
  userDO: ProxyCredentialSource,
  owner: UserCaller,
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const credKey = request.headers.get(PROXY_CRED_HEADER)?.trim();
    const target = request.headers.get(PROXY_TARGET_HEADER)?.trim();

    if (!credKey) return errorResponse(400, `${PROXY_CRED_HEADER} is required: name the credential to attach.`);

    if (!target) return errorResponse(400, `${PROXY_TARGET_HEADER} is required: name the upstream URL.`);

    const malformed = yield* Effect.catchCause(Effect.as(Effect.sync(() => validateCredentialKey(credKey)), null), (failed) => Effect.succeed(
      errorResponse(400, renderThrownChain({ cause: authoredRefusal({ doing: 'reading the credential key', cause: Cause.squash(failed) }) })),
    ));

    if (malformed !== null) return malformed;

    if (isProxyDeniedCredentialKey(credKey)) {
      return errorResponse(403, `${credKey} is not served by this proxy: Cloudflare-backed models go through /api/user/ai/v1, and Codex must be connected on the machine that uses it.`);
    }

    const base = (yield* Effect.promise(() => userDO.getCredentialBaseURL(owner, credKey)))
      ?? (yield* Effect.promise(() => providerProxyBaseURL(credKey, { fetch })));

    if (!base) {
      return errorResponse(400, `No upstream endpoint is known for credential "${credKey}", so it cannot be proxied.`);
    }

    if (!proxyTargetAllowed(target, base, request.method)) {
      return errorResponse(403, `${request.method} "${target}" is outside what credential "${credKey}" may be spent on (${base}).`);
    }

    const auth = yield* Effect.promise(() => userDO.getAuthHeaders(owner, credKey));

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

    if (hasBody) init.body = yield* Effect.promise(() => request.arrayBuffer());

    return yield* Effect.promise(() => fetch(target, init));
  });
}
