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
 * The OAuth leg never carries the key: `state` names the run and a nonce the
 * object holds, and the page keeps its key in the tab it minted it from. A
 * redirect that leaked the key would put it in a referrer, a browser history
 * entry and Cloudflare's own logs.
 */
import {
  CLOUDFLARE_DEPLOY_SCOPES, DEPLOY_RUN_ID, DeployInputsSchema, RELEASE_MANIFEST_PATH, authorizeUrl,
  createPkcePair, mintDeployRun, parseReleaseManifest, promptedSecrets, runKeyDigest,
  type DeployOptions,
} from '@kinu.run/core/deploy';
import { err, json, safeJson } from '@kinu.run/core';
import * as v from 'valibot';
import type { DeployRunDO } from './deploy-do';

const API = '/api/deploy';

const DEPLOY_PAGE_PATH = '/deploy';

const DEPLOY_CALLBACK_PATH = '/deploy/callback';

const DEPLOY_AUTHORIZE_PATH = '/deploy/authorize';

/** Paths this module owns. `server.ts` answers them before the auth gate, and
 *  the SPA page itself before the login redirect. */
export function isDeployPath(pathname: string): boolean {
  return pathname === DEPLOY_PAGE_PATH
    || pathname.startsWith(`${API}/`)
    || pathname === DEPLOY_AUTHORIZE_PATH
    || pathname === DEPLOY_CALLBACK_PATH;
}

const ProviderKeySchema = v.object({
  name: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/u)),
  value: v.pipe(v.string(), v.minLength(1)),
});

const TokenSchema = v.object({
  accessToken: v.pipe(v.string(), v.minLength(1)),
  refreshToken: v.pipe(v.string(), v.minLength(1)),
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

export async function handleDeployRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!isDeployPath(path)) return null;

  if (path === `${API}/options`) return options(env);

  if (path === `${API}/runs` && request.method === 'POST') return create(env);

  if (path === DEPLOY_AUTHORIZE_PATH) return authorize(request, env, url);

  if (path === DEPLOY_CALLBACK_PATH) return callback(env, url);

  const run = /^\/api\/deploy\/runs\/([A-Za-z0-9_-]+)(\/[a-z/-]*)?$/u.exec(path);

  if (run === null) return null;
  const runId = run[1] ?? '';
  const tail = run[2] ?? '';

  if (!DEPLOY_RUN_ID.test(runId)) return err(404, 'No such deploy run.');

  const stub = runStub(env, runId);
  const key = url.searchParams.get('key') ?? '';

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
    await stub.landToken(clientId, parsed.accessToken, parsed.refreshToken);

    return json({ authorized: true });
  }

  return err(404, 'No such deploy route.');
}

/** What the door can offer before anything is created: whether the Cloudflare
 *  half is configured at all, what version a run would install, and which
 *  secrets this release asks a person for. */
async function options(env: Env): Promise<Response> {
  const origin = env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
  const response = await fetch(new URL(RELEASE_MANIFEST_PATH, origin));
  const configured = deployClientId(env) !== '';

  if (!response.ok) {
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

  await runStub(env, ticket.runId).open(ticket.runId, await runKeyDigest(ticket.runKey));

  // The only time the key is ever sent. It is not stored here, not logged, and
  // not recoverable: a lost key is a lost run, which is the correct trade for a
  // capability that can write into somebody's Cloudflare account.
  return json(ticket);
}

async function authorize(request: Request, env: Env, url: URL): Promise<Response> {
  const clientId = deployClientId(env);

  if (clientId === '') return err(503, 'The Cloudflare door has no OAuth client configured.');

  const runId = url.searchParams.get('run') ?? '';

  if (!DEPLOY_RUN_ID.test(runId)) return err(400, 'That is not a deploy run.');

  const stub = runStub(env, runId);

  if (!await stub.admits(url.searchParams.get('key') ?? '')) {
    return err(403, 'This deploy run does not know that key.');
  }

  const pkce = await createPkcePair();
  const state = await stub.holdAuthorization(pkce.verifier);
  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, new URL(request.url).origin).href;

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl({ clientId, redirectUri, state, challenge: pkce.challenge, scopes: CLOUDFLARE_DEPLOY_SCOPES }),
      'cache-control': 'no-store',
      // The authorize URL carries the state and the challenge; a referrer
      // would hand both to Cloudflare's page for no reason.
      'referrer-policy': 'no-referrer',
    },
  });
}

async function callback(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const runId = state.split('.')[0] ?? '';

  if (!DEPLOY_RUN_ID.test(runId) || code === '') return err(400, 'That is not an authorization this flow started.');

  const clientId = deployClientId(env);

  if (clientId === '') return err(503, 'The Cloudflare door has no OAuth client configured.');

  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, url.origin).href;

  await runStub(env, runId).landAuthorization(clientId, redirectUri, code, state);

  // Back to the page, which still holds the run key in the tab that minted it.
  return new Response(null, {
    status: 302,
    headers: { location: `${DEPLOY_PAGE_PATH}?run=${encodeURIComponent(runId)}`, 'cache-control': 'no-store' },
  });
}
