/**
 * The Cloudflare door's routes: public, authorized only by the run key (no Kinu account exists yet).
 * The key is never in a URL: a Bearer header, or the upgrade's second subprotocol, since query strings
 * reach browser history and invocation logs. The OAuth leg is bound to its browser by the
 * `__Host-kinu_deploy_state` cookie holding the `state` digest, as `auth/session.ts` does for sign-in.
 */
import { Hono } from 'hono';
import {
  CLOUDFLARE_DEPLOY_SCOPES, DEPLOY_API, DEPLOY_CALLBACK_PATH, DEPLOY_PAGE_PATH, DEPLOY_RUN_ID,
  DEPLOY_SOCKET_PROTOCOL, DeployInputsSchema, RELEASE_MANIFEST_PATH, authorizeUrl, createPkcePair,
  mintDeployRun, parseReleaseManifest, promptedSecrets, runKeyDigest,
  type DeployOptions,
} from '@kinu.run/core/deploy';
import { err, fetchDeployedAsset, json, safeJson, serveApp, sha256Hex, timingSafeEqual } from '@kinu.run/core';
import * as v from 'valibot';
import { DEPLOY_STATE_COOKIE_NAME, readCookie, setCookie } from '../auth/session';
import { beneath, type FamilyEnv } from '../api/context';
import type { DeployRunDO } from './deploy-do';

/** Long enough to read a permission list; short enough that a shared machine carries no usable half-leg. */
const STATE_TTL_MS = 600_000;

const ProviderKeySchema = v.object({
  name: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/u)),
  value: v.pipe(v.string(), v.minLength(1)),
});

const TokenSchema = v.object({
  accessToken: v.pipe(v.string(), v.minLength(1)),
  refreshToken: v.pipe(v.string(), v.minLength(1)),
  /** Stored so a late retry refreshes instead of failing every step. */
  expiresInSeconds: v.pipe(v.number(), v.minValue(0)),
});

function runStub(env: Env, runId: string): DurableObjectStub<DeployRunDO> {
  return env.DeployRunDO.get(env.DeployRunDO.idFromName(runId));
}

/** Absent means the Cloudflare door is not open: said plainly, not an authorize URL with empty `client_id`. */
function deployClientId(env: Env): string {
  return (env.CLOUDFLARE_DEPLOY_CLIENT_ID ?? '').trim();
}

/** Header for fetches; for the socket upgrade, the second subprotocol token. A query parameter is
 *  never read, so a caller that put the key there is refused. */
function presentedKey(request: Request): string {
  const header = request.headers.get('authorization') ?? '';

  if (/^bearer /iu.test(header)) return header.slice('bearer '.length).trim();

  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((token) => token.trim());

  return offered[0] === DEPLOY_SOCKET_PROTOCOL ? offered[1] ?? '' : '';
}

interface DeployVariables {
  run: DurableObjectStub<DeployRunDO>;
  tail: string;
}

const RUN_PATH = /^\/api\/deploy\/runs\/([A-Za-z0-9_-]+)(\/[a-z/-]*)?$/u;

/** The OAuth return; the door's API is `deployRoutes`. */
export async function handleDeployCallback(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  return url.pathname === DEPLOY_CALLBACK_PATH ? callback(request, env, url) : null;
}

export const deployRoutes = new Hono<FamilyEnv<Env, DeployVariables>>();

deployRoutes.all(`${DEPLOY_API}/options`, async (c) => options(c.req.raw, c.env));

deployRoutes.post(`${DEPLOY_API}/runs`, async (c) => create(c.env));

deployRoutes.use(`${DEPLOY_API}/runs/:run/*`, async (c, next) => {
  const run = RUN_PATH.exec(c.req.path);

  if (run === null) return serveApp(c.req.raw, c.env);
  const runId = run[1] ?? '';

  if (!DEPLOY_RUN_ID.test(runId)) return err(404, 'No such deploy run.');
  const stub = runStub(c.env, runId);

  if (!await stub.admits(presentedKey(c.req.raw))) return err(403, 'This deploy run does not know that key.');
  c.set('run', stub);
  c.set('tail', run[2] ?? '');
  await next();
});

deployRoutes.all(`${DEPLOY_API}/runs/:run/socket`, async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return err(426, 'Expected WebSocket');

  return c.get('run').fetch(c.req.raw);
});

deployRoutes.get(`${DEPLOY_API}/runs/:run`, async (c) => json({ body: await c.get('run').snapshot() }));

// Read with the person's own token; neither answer is stored.
deployRoutes.get(`${DEPLOY_API}/runs/:run/accounts`, async (c) => json({ body: await c.get('run').accounts() }));

deployRoutes.get(`${DEPLOY_API}/runs/:run/zones`, async (c) => json({ body: await c.get('run').zones() }));

// A POST, so the key authorizes it in a header; the navigated `location` carries only `state` and the challenge.
deployRoutes.post(`${DEPLOY_API}/runs/:run/authorize`, async (c) => authorize(c.req.raw, c.env, c.get('run')));

deployRoutes.post(`${DEPLOY_API}/runs/:run/start`, async (c) => {
  const inputs = await safeJson(c.req.raw, DeployInputsSchema);

  if (inputs === null) return err(400, 'Those answers are not a deployment this flow can run.');
  const stub = c.get('run');

  if (!await stub.authorized()) return err(409, 'This run is not authorized with Cloudflare yet.');

  return json({ body: await stub.start(inputs) });
});

deployRoutes.post(`${DEPLOY_API}/runs/:run/retry/*`, async (c, next) => {
  const tail = c.get('tail');

  if (!tail.startsWith('/retry/')) return next();

  return json({ body: await c.get('run').retry(tail.slice('/retry/'.length)) });
});

deployRoutes.post(`${DEPLOY_API}/runs/:run/keys`, async (c) => {
  const parsed = await safeJson(c.req.raw, ProviderKeySchema);

  if (parsed === null) return err(400, 'That is not a provider key this flow stores.');
  await c.get('run').holdProviderKey(parsed.name, parsed.value);

  return json({ body: { held: parsed.name } });
});

// The CLI authorizes on its own localhost redirect, like wrangler, and hands over the token pair.
deployRoutes.post(`${DEPLOY_API}/runs/:run/token`, async (c) => {
  const parsed = await safeJson(c.req.raw, TokenSchema);

  if (parsed === null) return err(400, 'That is not a Cloudflare token pair.');
  const clientId = deployClientId(c.env);

  if (clientId === '') return err(503, 'This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare.');
  await c.get('run').landToken(clientId, parsed.accessToken, parsed.refreshToken, parsed.expiresInSeconds);

  return json({ body: { authorized: true } });
});

deployRoutes.all(`${DEPLOY_API}/runs/:run/*`, async () => err(404, 'No such deploy route.'));

// The door's other paths are the app's.
deployRoutes.all(`${DEPLOY_API}/*`, beneath<FamilyEnv<Env, DeployVariables>>(DEPLOY_API, async (c) => serveApp(c.req.raw, c.env)));

/** Read from this deployment's own asset bundle via `fetchDeployedAsset`, which handles the SPA shell
 *  answering a missing file (`core/src/http/deployed-assets.ts`). */
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

    return json({ body: offline });
  }

  const manifest = parseReleaseManifest(await response.text());

  const offer: DeployOptions = {
    cloudflare: configured,
    clientId: configured ? deployClientId(env) : '',
    version: manifest.version,
    prompts: promptedSecrets(manifest),
    reason: configured
      ? ''
      : 'This Kinu has no Cloudflare OAuth client configured yet.',
  };

  return json({ body: offer });
}

async function create(env: Env): Promise<Response> {
  const ticket = mintDeployRun();

  await runStub(env, ticket.runId).open(ticket.runId, runKeyDigest(ticket.runKey));

  // The only time the key is ever sent; never stored or logged, so a lost key is a lost run.
  return json({ body: ticket });
}

/** The cookie holds the `state` digest; `/deploy/callback` lands tokens only for that browser, so a
 *  consent screen completed from a forwarded URL puts tokens nowhere. */
async function authorize(request: Request, env: Env, stub: DurableObjectStub<DeployRunDO>): Promise<Response> {
  const clientId = deployClientId(env);

  if (clientId === '') return err(503, 'This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare.');

  const pkce = await createPkcePair();
  const state = await stub.holdAuthorization(pkce.verifier);
  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, new URL(request.url).origin).href;

  const handoff = json({
    body: {
      location: authorizeUrl({
        clientId, redirectUri, state, challenge: pkce.challenge, scopes: CLOUDFLARE_DEPLOY_SCOPES,
      }),
    },
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

  // Refused before the run is touched: a forwarded callback URL must stay unauthorized.
  const bound = readCookie(request, DEPLOY_STATE_COOKIE_NAME) ?? '';

  if (bound === '' || !timingSafeEqual(bound, sha256Hex(state))) {
    return burnt(err(400, 'This browser did not start that authorization.'));
  }

  const clientId = deployClientId(env);

  if (clientId === '') return burnt(err(503, 'This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare.'));

  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, url.origin).href;

  const landed = await runStub(env, runId).landAuthorization(clientId, redirectUri, code, state);

  if (!landed) return burnt(err(400, 'That authorization is not one this run started.'));

  return burnt(new Response(null, {
    status: 302,
    headers: { location: `${DEPLOY_PAGE_PATH}?run=${encodeURIComponent(runId)}`, 'cache-control': 'no-store' },
  }));
}

/** Spent whatever the outcome: one leg, one cookie. */
function burnt(response: Response): Response {
  response.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, '', 0));

  return response;
}
