/**
 * The Cloudflare door's routes — public, and gated by the run key rather than
 * by a Kinu session.
 *
 * A person deploying their own Kinu has no account here yet, so there is
 * nothing to sign in to. What authorizes every call is the key the run was
 * created with: minted once, returned once, presented on every later call and
 * on the socket upgrade, and compared inside the Durable Object against a
 * digest. That is why these routes answer before the auth gate, and why none
 * of them trusts anything but the key.
 *
 * THE KEY IS NEVER IN A URL. `authorization: Bearer <key>` on every call, and
 * the socket upgrade's second subprotocol token where a browser can set no
 * header. A query parameter would be in the browser's history and in this
 * deployment's own invocation logs (`wrangler.jsonc` samples them at 100%),
 * and this key writes into somebody's Cloudflare account.
 *
 * THE OAUTH LEG CARRIES NO KEY EITHER: `state` names the run and a nonce the
 * object holds, and `/deploy/callback` is a navigation. What proves the browser
 * finishing the leg is the browser that started it is the
 * `__Host-kinu_deploy_state` cookie, set to the digest of that `state` — the
 * same binding `auth/session.ts` puts on a Kinu sign-in, for the same reason.
 */
import {
  CLOUDFLARE_DEPLOY_SCOPES, DEPLOY_API, DEPLOY_CALLBACK_PATH, DEPLOY_PAGE_PATH, DEPLOY_RUN_ID,
  DEPLOY_SOCKET_PROTOCOL, DeployInputsSchema, RELEASE_MANIFEST_PATH, authorizeUrl, createPkcePair,
  isDeployPath, mintDeployRun, parseReleaseManifest, promptedSecrets, runKeyDigest,
  type DeployOptions,
} from '@kinu.run/core/deploy';
import { err, fetchDeployedAsset, json, safeJson, sha256Hex, timingSafeEqual } from '@kinu.run/core';
import * as v from 'valibot';
import { DEPLOY_STATE_COOKIE_NAME, readCookie, setCookie } from '../auth/session';
import type { DeployRunDO } from './deploy-do';

/** How long a person has to finish the Cloudflare consent screen before the
 *  binding cookie expires. Ten minutes: long enough to read a permission list,
 *  short enough that a shared machine does not carry a usable half-leg. */
const STATE_TTL_MS = 600_000;

const ProviderKeySchema = v.object({
  name: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/u)),
  value: v.pipe(v.string(), v.minLength(1)),
});

const TokenSchema = v.object({
  accessToken: v.pipe(v.string(), v.minLength(1)),
  refreshToken: v.pipe(v.string(), v.minLength(1)),
  /** What the token endpoint said the access token's life is. The run stores
   *  it so a retry an hour later refreshes instead of failing every step. */
  expiresInSeconds: v.pipe(v.number(), v.minValue(0)),
});

function runStub(env: Env, runId: string): DurableObjectStub<DeployRunDO> {
  return env.DeployRunDO.get(env.DeployRunDO.idFromName(runId));
}

/** The client the owner registered. Absent means the Cloudflare door is not
 *  open yet — said plainly, rather than sending a person to an authorize URL
 *  with an empty `client_id`. */
function deployClientId(env: Env): string {
  return (env.CLOUDFLARE_DEPLOY_CLIENT_ID ?? '').trim();
}

/**
 * The key the caller presented, from the one place each caller can put it.
 *
 * An `authorization` header for every fetch. For the socket upgrade — where a
 * browser can set no header — the offered subprotocols, whose first token names
 * the scheme and whose second IS the key. Anything else is no key at all: a
 * query parameter is not read here, so a caller that put one there is refused
 * rather than quietly admitted.
 */
function presentedKey(request: Request): string {
  const header = request.headers.get('authorization') ?? '';

  if (/^bearer /iu.test(header)) return header.slice('bearer '.length).trim();

  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((token) => token.trim());

  return offered[0] === DEPLOY_SOCKET_PROTOCOL ? offered[1] ?? '' : '';
}

export async function handleDeployRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!isDeployPath(path)) return null;

  if (path === `${DEPLOY_API}/options`) return options(request, env);

  if (path === `${DEPLOY_API}/runs` && request.method === 'POST') return create(env);

  if (path === DEPLOY_CALLBACK_PATH) return callback(request, env, url);

  const run = /^\/api\/deploy\/runs\/([A-Za-z0-9_-]+)(\/[a-z/-]*)?$/u.exec(path);

  if (run === null) return null;
  const runId = run[1] ?? '';
  const tail = run[2] ?? '';

  if (!DEPLOY_RUN_ID.test(runId)) return err(404, 'No such deploy run.');

  const stub = runStub(env, runId);
  const key = presentedKey(request);

  if (!await stub.admits(key)) return err(403, 'This deploy run does not know that key.');

  if (tail === '/socket') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return err(426, 'Expected WebSocket');

    return stub.fetch(request);
  }

  if (tail === '' && request.method === 'GET') return json(await stub.snapshot());

  // What the person picks between, read with their own token: the door has no
  // list of its own and stores neither answer.
  if (tail === '/accounts' && request.method === 'GET') return json(await stub.accounts());

  if (tail === '/zones' && request.method === 'GET') return json(await stub.zones());

  // The authorization leg starts here rather than at a navigated GET: the key
  // authorizes this POST in its header, and what the browser navigates to is
  // the answer's `location`, which carries only `state` and the challenge.
  if (tail === '/authorize' && request.method === 'POST') return authorize(request, env, stub);

  if (tail === '/start' && request.method === 'POST') {
    const inputs = await safeJson(request, DeployInputsSchema);

    if (inputs === null) return err(400, 'Those answers are not a deployment this flow can run.');

    if (!await stub.authorized()) return err(409, 'This run is not authorized with Cloudflare yet.');

    return json(await stub.start(inputs));
  }

  if (tail.startsWith('/retry/') && request.method === 'POST') {
    return json(await stub.retry(tail.slice('/retry/'.length)));
  }

  if (tail === '/keys' && request.method === 'POST') {
    const parsed = await safeJson(request, ProviderKeySchema);

    if (parsed === null) return err(400, 'That is not a provider key this flow stores.');
    await stub.holdProviderKey(parsed.name, parsed.value);

    return json({ held: parsed.name });
  }

  // The CLI door authorizes on its own localhost redirect, the way wrangler
  // does, and hands the run the token pair it got. The steps then run in the
  // same object, over the same ledger, as the page's door.
  if (tail === '/token' && request.method === 'POST') {
    const parsed = await safeJson(request, TokenSchema);

    if (parsed === null) return err(400, 'That is not a Cloudflare token pair.');
    const clientId = deployClientId(env);

    if (clientId === '') return err(503, 'The Cloudflare door has no OAuth client configured.');
    await stub.landToken(clientId, parsed.accessToken, parsed.refreshToken, parsed.expiresInSeconds);

    return json({ authorized: true });
  }

  return err(404, 'No such deploy route.');
}

/** What the door can offer before anything is created: whether the Cloudflare
 *  half is configured at all, what version a run would install, and which
 *  secrets this release asks a person for.
 *
 *  The manifest is read out of this deployment's own asset bundle rather than
 *  fetched from its own origin: a subrequest per page load for a file the
 *  binding already serves, and — because the bundle answers a missing file
 *  with the SPA shell — a read that had to be told apart from an HTML page.
 *  `fetchDeployedAsset` is the one place that knows both
 *  (`core/src/http/deployed-assets.ts`). */
async function options(request: Request, env: Env): Promise<Response> {
  const response = await fetchDeployedAsset(env, request.url, RELEASE_MANIFEST_PATH);
  const configured = deployClientId(env) !== '';

  if (response === null) {
    const offline: DeployOptions = {
      cloudflare: false,
      clientId: '',
      version: '',
      prompts: [],
      reason: 'This deployment publishes no release channel, so there is nothing to install.',
    };

    return json(offline);
  }

  const manifest = parseReleaseManifest(await response.text());

  const offer: DeployOptions = {
    cloudflare: configured,
    clientId: configured ? deployClientId(env) : '',
    version: manifest.version,
    prompts: promptedSecrets(manifest),
    reason: configured
      ? ''
      : 'The Cloudflare door needs an OAuth client, and this deployment has none configured yet.',
  };

  return json(offer);
}

async function create(env: Env): Promise<Response> {
  const ticket = mintDeployRun();

  await runStub(env, ticket.runId).open(ticket.runId, runKeyDigest(ticket.runKey));

  // The only time the key is ever sent. It is not stored here, not logged, and
  // not recoverable: a lost key is a lost run, which is the correct trade for a
  // capability that can write into somebody's Cloudflare account.
  return json(ticket);
}

/**
 * One authorization leg, and the binding that makes it this browser's.
 *
 * The answer carries the URL to navigate to and a cookie holding the digest of
 * the `state` that URL names. `/deploy/callback` lands a token pair only when
 * the browser presents that digest, so a consent screen completed by somebody
 * who was handed the URL puts their Cloudflare tokens nowhere.
 */
async function authorize(request: Request, env: Env, stub: DurableObjectStub<DeployRunDO>): Promise<Response> {
  const clientId = deployClientId(env);

  if (clientId === '') return err(503, 'The Cloudflare door has no OAuth client configured.');

  const pkce = await createPkcePair();
  const state = await stub.holdAuthorization(pkce.verifier);
  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, new URL(request.url).origin).href;

  const handoff = json({
    location: authorizeUrl({
      clientId, redirectUri, state, challenge: pkce.challenge, scopes: CLOUDFLARE_DEPLOY_SCOPES,
    }),
  });

  handoff.headers.set('cache-control', 'no-store');
  handoff.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, sha256Hex(state), Date.now() + STATE_TTL_MS));

  return handoff;
}

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const runId = state.split('.')[0] ?? '';

  if (!DEPLOY_RUN_ID.test(runId) || code === '') {
    return burnt(err(400, 'That is not an authorization this flow started.'));
  }

  // The one check that makes a callback this browser's. Refused before the run
  // is touched at all: a run whose leg this browser did not start must come out
  // of a forwarded callback URL exactly as unauthorized as it went in.
  const bound = readCookie(request, DEPLOY_STATE_COOKIE_NAME) ?? '';

  if (bound === '' || !timingSafeEqual(bound, sha256Hex(state))) {
    return burnt(err(400, 'This browser did not start that authorization.'));
  }

  const clientId = deployClientId(env);

  if (clientId === '') return burnt(err(503, 'The Cloudflare door has no OAuth client configured.'));

  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, url.origin).href;

  const landed = await runStub(env, runId).landAuthorization(clientId, redirectUri, code, state);

  if (!landed) return burnt(err(400, 'That authorization is not one this run started.'));

  // Back to the page, which still holds the run key in the tab that minted it.
  return burnt(new Response(null, {
    status: 302,
    headers: { location: `${DEPLOY_PAGE_PATH}?run=${encodeURIComponent(runId)}`, 'cache-control': 'no-store' },
  }));
}

/** The binding cookie, spent. One leg, one cookie, whatever the outcome: a
 *  browser that keeps it is a browser that keeps offering it. */
function burnt(response: Response): Response {
  response.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, '', 0));

  return response;
}
