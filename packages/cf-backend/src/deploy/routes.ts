/**
 * The Cloudflare door's routes: public, since no Kinu account exists yet. Two ways in.
 *
 * The page signs in with Cloudflare: `POST /signin` opens a sign-in object named by the digest of an HttpOnly
 * `__Host-kinu_deploy_session` cookie, the callback lands the grant there and proves the Cloudflare user, and every
 * page read and run after that is that user's (docs/SELF-DEPLOY-FLOW.md § The page's contract). A run is named for
 * the user and the account, so a sign-in on another device finds it again.
 *
 * The CLI (and the old page) hold a run key: never in a URL, a Bearer header or the upgrade's second subprotocol,
 * since query strings reach browser history and invocation logs.
 *
 * Either OAuth leg is bound to its browser by the `__Host-kinu_deploy_state` cookie holding the `state` digest, as
 * `auth/session.ts` does for sign-in.
 */
import { Hono, type Context, type Next } from 'hono';
import { ownRequest } from '../nimbus-route';
import {
  CLOUDFLARE_DEPLOY_SCOPES, DEPLOY_API, DEPLOY_CALLBACK_PATH, DEPLOY_PAGE_PATH, DEPLOY_RUN_ID, DEPLOY_SESSION_STATE,
  DEPLOY_SOCKET_PROTOCOL, DeployDomainsSchema, DeployInputsSchema, DeployPreflightSchema, DeployRunRequestSchema, DeployRunViewSchema,
  DeploySessionSchema, MailPreviewSchema, RELEASE_MANIFEST_PATH, SIGN_IN_AGAIN_NEED,
  accountChoices, authorizeUrl, bearerTransport, buildOf, causeWords, deployedKinus, domainsMatching, fetchReleaseManifest, heard,
  judgeRefusal, mailPreview, mintDeployRun, parseReleaseManifest, plannedRun, preflight, promptedSecrets, runKeyDigest, zoneHeld,
  type CloudflareTransport, type CloudflareUser, type CloudflareWords, type DeployChoice, type DeployOptions, type DeployRunView,
  type DeploySession,
  type UpdateBuild,
} from '@kinu.run/core/deploy';
import {
  APP_ROUTES, ERROR_STATUS, objectNamed, createPkcePair, err, fetchDeployedAsset, json, randomToken, safeJson, serveApp, sha256Hex, timingSafeEqual,
} from '@kinu.run/core';
import * as v from 'valibot';
import { Cause, Effect } from 'effect';
import { attemptInItsWords, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { DEPLOY_SESSION_COOKIE_NAME, DEPLOY_STATE_COOKIE_NAME, readCookie, setCookie } from '../auth/cookies';
import { beneath, noHead, type FamilyEnv } from '../api/context';
import type { DeployRunDO } from './deploy-do';

/** Long enough to read a permission list; short enough that a shared machine carries no usable half-leg. */
const STATE_TTL_MS = 600_000;

/** A page sign-in lasts as long as the grant it holds may be held without its person. */
const SESSION_TTL_MS = 3_600_000;

/** 192 bits: the cookie is the whole of a page sign-in's authority. */
const SESSION_TOKEN_BYTES = 24;

/** An account's or a zone's id, as Cloudflare spells both. */
const CloudflareIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u));

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
  return objectNamed(env.DeployRunDO, runId);
}

/** By the cookie's digest: the cookie itself is stored nowhere. */
function sessionStub(env: Env, token: string): DurableObjectStub<DeployRunDO> {
  return objectNamed(env.DeployRunDO, `deploy-session.${sha256Hex(token)}`);
}

/** One per Cloudflare user and account, so any sign-in of that user finds it again; no other sign-in can name it. */
function ownRun(env: Env, user: CloudflareUser, account: string): DurableObjectStub<DeployRunDO> {
  return objectNamed(env.DeployRunDO, `deploy-run.${user.id}.${account}`);
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
export const deployCallbackRoutes = new Hono<FamilyEnv<Env, object>>();

deployCallbackRoutes.all(DEPLOY_CALLBACK_PATH, noHead<FamilyEnv<Env, object>>((c) => callback(c.req.raw, c.env, new URL(c.req.url))));

export const deployRoutes = new Hono<FamilyEnv<Env, DeployVariables>>();

deployRoutes.all(`${DEPLOY_API}/options`, async (c) => options(c.req.raw, c.env));

/**
 * The page's sign-in is a cookie, and a sibling host under the same site (a preview, a share) is sent it too: every
 * request the page makes with it must come from this origin, by the browser's fetch metadata or its exact `Origin`
 * (`ownRequest`). The CLI's door carries a run key instead and is not the page's.
 */
async function fromThePage(c: Context<FamilyEnv<Env, DeployVariables>>, next: Next): Promise<Response | undefined> {
  const pageRun = c.req.path !== `${DEPLOY_API}/runs` || (c.req.header('content-type') ?? '').includes('application/json');

  if (pageRun && !ownRequest(c.req.raw, new URL(c.req.url).origin, false)) return err(403, 'Only this Kinu\'s deploy page may ask that.');
  await next();

  return undefined;
}

for (const path of ['signin', 'session', 'preflight', 'domains', 'mail', 'runs', 'runs/current', 'runs/current/*']) deployRoutes.use(`${DEPLOY_API}/${path}`, fromThePage);

// The page's door: its sign-in, the reads it shows, and the run it follows.
deployRoutes.post(`${DEPLOY_API}/signin`, async (c) => signIn(c.req.raw, c.env));

deployRoutes.get(`${DEPLOY_API}/session`, noHead<FamilyEnv<Env, DeployVariables>>((c) => sessionAnswer(c.req.raw, c.env)));

deployRoutes.get(`${DEPLOY_API}/preflight`, noHead<FamilyEnv<Env, DeployVariables>>((c) => accountRead(c.req.raw, c.env, c.req.query('account') ?? '', (transport, account, session) => Effect.gen(function* () {
  const checked = yield* preflight(transport, account, Date.now());
  const apiTokens = yield* Effect.promise(async () => session.apiTokens());

  return v.parse(DeployPreflightSchema, { ...checked, apiTokens });
}))));

deployRoutes.get(`${DEPLOY_API}/domains`, noHead<FamilyEnv<Env, DeployVariables>>((c) => accountRead(c.req.raw, c.env, c.req.query('account') ?? '', (transport, account) => Effect.map(domainsMatching(transport, account, c.req.query('q') ?? ''), (body) => v.parse(DeployDomainsSchema, body)))));

deployRoutes.get(`${DEPLOY_API}/mail`, noHead<FamilyEnv<Env, DeployVariables>>((c) => pageRead(c.req.raw, c.env, (transport) => {
  const zone = c.req.query('zone') ?? '';

  return v.is(CloudflareIdSchema, zone)
    ? Effect.map(Effect.flatMap(zoneHeld(transport, zone), (held) => mailPreview(transport, held)), (body) => v.parse(MailPreviewSchema, body))
    : Effect.fail(new KinuError('bad_input', 'That is not a zone id.'));
})));

// A JSON body is the page's run; the CLI's mint carries none and is answered a run key, as before.
deployRoutes.post(`${DEPLOY_API}/runs`, noHead<FamilyEnv<Env, DeployVariables>>((c) => (
  (c.req.header('content-type') ?? '').includes('application/json')
    ? beginRun(c.req.raw, c.env)
    : Effect.promise(async () => create(c.env))
)));

deployRoutes.get(`${DEPLOY_API}/runs/current`, noHead<FamilyEnv<Env, DeployVariables>>((c) => followedRun(c.req.raw, c.env, (run, user) => run.current(user.id))));

deployRoutes.post(`${DEPLOY_API}/runs/current/continue`, noHead<FamilyEnv<Env, DeployVariables>>((c) => followedRun(c.req.raw, c.env, async (run, user, session) => {
  const grant = await run.wantsGrant(user.id) ? await session.surrender() : null;

  return run.carryOn(user.id, grant);
})));

deployRoutes.all(`${DEPLOY_API}/runs/current/socket`, async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return err(426, 'Expected WebSocket');
  const held = await signedIn(c.req.raw, c.env);
  const account = held === null ? '' : await held.session.following();

  if (held === null || account === '') return err(404, 'This sign-in follows no deploy run.');

  return ownRun(c.env, held.user, account).fetch(c.req.raw);
});

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
deployRoutes.get(`${DEPLOY_API}/runs/:run/accounts`, noHead<FamilyEnv<Env, DeployVariables>>((c) => cloudflareRead(() => c.get('run').accounts())));

deployRoutes.get(`${DEPLOY_API}/runs/:run/zones`, noHead<FamilyEnv<Env, DeployVariables>>((c) => cloudflareRead(() => c.get('run').zones())));

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
  handoff.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, sha256Hex(state), STATE_TTL_MS));

  return handoff;
}

function callback(request: Request, env: Env, url: URL): Effect.Effect<Response, KinuError> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const runId = state.split('.')[0] ?? '';
  const refused = url.searchParams.get('error');
  const session = runId === DEPLOY_SESSION_STATE ? readCookie(request, DEPLOY_SESSION_COOKIE_NAME) ?? '' : null;

  // A declined consent or a refused scope (RFC 6749 § 4.1.2.1): the page shows Cloudflare's words and "Sign in again".
  if (refused !== null) return backTo(env, session, { error: refused, error_description: url.searchParams.get('error_description') ?? '' });

  if ((session === null && !DEPLOY_RUN_ID.test(runId)) || code === '') {
    return Effect.succeed(burnt(err(400, 'That is not an authorization this flow started.')));
  }

  // Refused before the run is touched: a forwarded callback URL must stay unauthorized.
  const bound = readCookie(request, DEPLOY_STATE_COOKIE_NAME) ?? '';

  if (bound === '' || !timingSafeEqual(bound, sha256Hex(state)) || session === '') {
    return Effect.succeed(burnt(err(400, 'This browser did not start that authorization.')));
  }

  const clientId = deployClientId(env);

  if (clientId === '') return Effect.succeed(burnt(err(503, 'This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare.')));

  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, url.origin).href;

  const land = session === null
    ? async () => runStub(env, runId).landAuthorization(clientId, redirectUri, code, state)
    : async () => sessionStub(env, session).landSignIn(clientId, redirectUri, code, state);

  // The token endpoint's refusal (a spent code, a client it does not know) reaches the person in its words.
  return attemptInItsWords('io', land).pipe(Effect.flatMap((landed) => {
    if (!landed) return Effect.succeed(burnt(err(400, 'That authorization is not one this run started.')));

    // The sign-in's hour starts once Cloudflare proved who it is, not while its consent screen was open.
    return Effect.map(backTo(env, session, session === null ? { run: runId } : {}), (back) => {
      if (session !== null) back.headers.append('set-cookie', setCookie(DEPLOY_SESSION_COOKIE_NAME, session, SESSION_TTL_MS));

      return back;
    });
  }), Effect.catch((failure) => backTo(env, session, { error: 'token_exchange_failed', error_description: renderThrownChain({ cause: failure }) })));
}

/** The page's sign-in that ran in a helper window ends on the shared finish page, which tells the tab; anything else
 *  goes back to `/deploy`. Never a token in either. */
function backTo(env: Env, session: string | null, params: Readonly<Record<string, string>>): Effect.Effect<Response, KinuError> {
  if (session === null || session === '') return Effect.succeed(burnt(toPage(params)));

  return Effect.map(attemptInItsWords('io', async () => sessionStub(env, session).ending()), (ending) => {
    if (ending.end === 'tab') return burnt(toPage(params));
    const said = new URLSearchParams(params);
    const finish = new URLSearchParams({ service: 'cloudflare-deploy' });
    const error = [said.get('error_description'), said.get('error')].find((words) => words !== null && words !== '') ?? '';

    // The finish page tells only the tab whose connect run it names; with none, it tells no one.
    if (ending.run !== null) finish.set('run', ending.run);

    if (error !== '') finish.set('error', error);

    return burnt(new Response(null, { status: 302, headers: { location: `${APP_ROUTES.connected}?${finish.toString()}`, 'cache-control': 'no-store' } }));
  });
}

/** Back to the page, which reads these: `run` (a door run), nothing (a page sign-in: it reads `/session`), or the OAuth
 *  refusal's `error` and `error_description`. */
function toPage(params: Readonly<Record<string, string>>): Response {
  const query = new URLSearchParams(params).toString();

  return new Response(null, {
    status: 302,
    headers: { location: query === '' ? DEPLOY_PAGE_PATH : `${DEPLOY_PAGE_PATH}?${query}`, 'cache-control': 'no-store' },
  });
}

/** Cloudflare's refusal of a read in its own words (its path, code and message), never a bare route error. */
function cloudflareRead(read: () => Promise<readonly DeployChoice[]>): Effect.Effect<Response, KinuError> {
  return attemptInItsWords('io', read).pipe(Effect.match({
    onFailure: (failure) => err(502, failure.message),
    onSuccess: (body) => json({ body }),
  }));
}

/** Spent whatever the outcome: one leg, one cookie. */
function burnt(response: Response): Response {
  response.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, '', 0));

  return response;
}

/** `helper`: the leg runs in a helper window and ends on the shared finish page, which tells the tab whose connect run
 *  (`run`, from `beginConnect`) it names. `tab` (the default): it ends back on `/deploy`. */
// `for: 'api-tokens'`: the page's computer row asked the person to sign in again and tick API Tokens.
const SignInAskSchema = v.object({
  end: v.optional(v.picklist(['helper', 'tab']), 'tab'),
  run: v.optional(v.pipe(v.string(), v.uuid())),
  for: v.optional(v.picklist(['api-tokens'])),
});

/** The page's sign-in leg. A fresh sign-in object each time, named by a new cookie; the old one's hour runs out alone. */
async function signIn(request: Request, env: Env): Promise<Response> {
  const clientId = deployClientId(env);

  if (clientId === '') return err(503, 'This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare.');
  const asked = (request.headers.get('content-type') ?? '').includes('application/json') ? await safeJson(request, SignInAskSchema) : v.parse(SignInAskSchema, {});

  if (asked === null) return err(400, 'That is not a sign-in this page can start.');
  const token = randomToken(SESSION_TOKEN_BYTES);
  const session = sessionStub(env, token);
  const pkce = await createPkcePair();

  await session.openSession();
  const state = await session.holdSignIn(pkce.verifier, { end: asked.end, run: asked.run ?? null, forApiTokens: asked.for === 'api-tokens' });
  const redirectUri = new URL(DEPLOY_CALLBACK_PATH, new URL(request.url).origin).href;

  const handoff = json({
    body: { location: authorizeUrl({ clientId, redirectUri, state, challenge: pkce.challenge, scopes: CLOUDFLARE_DEPLOY_SCOPES }) },
  });

  handoff.headers.set('cache-control', 'no-store');
  handoff.headers.append('set-cookie', setCookie(DEPLOY_SESSION_COOKIE_NAME, token, SESSION_TTL_MS));
  handoff.headers.append('set-cookie', setCookie(DEPLOY_STATE_COOKIE_NAME, sha256Hex(state), STATE_TTL_MS));

  return handoff;
}

interface SignedIn {
  readonly session: DurableObjectStub<DeployRunDO>;
  readonly user: CloudflareUser;
  /** The sign-in's access token for this request's reads; empty once it lapsed, which Cloudflare then refuses in its words. */
  readonly token: string;
}

/** The cookie's sign-in, once the callback proved its Cloudflare user; null when nobody is signed in here. */
async function signedIn(request: Request, env: Env): Promise<SignedIn | null> {
  const cookie = readCookie(request, DEPLOY_SESSION_COOKIE_NAME) ?? '';

  if (cookie === '') return null;
  const session = sessionStub(env, cookie);
  const user = await session.signedIn();

  if (user === null) return null;

  return { session, user, token: await session.readToken() ?? '' };
}

const SIGNED_OUT: DeploySession = { signedIn: false, email: '', accounts: [], resume: null, deployments: [], unreadable: [], apiTokens: 'granted' };

/** Nobody signed in: the page offers "Continue with Cloudflare". */
function signInFirst(): Response {
  return json({ body: { error: SIGN_IN_AGAIN_NEED.sentence, need: SIGN_IN_AGAIN_NEED } }, { status: 401 });
}

/** A refusal as the page shows it: a need it can meet (401 to sign in again, 409 otherwise), or Cloudflare's words with
 *  one sentence and one action (502). A refusal of ours (a bad request, a Kinu that is not there) keeps its own status. */
function refusedAnswer(failed: Cause.Cause<KinuError>, account: string): Response {
  const cause = Cause.squash(failed);

  return cause instanceof KinuError ? err(ERROR_STATUS[cause.code], cause.message) : wordedAnswer(causeWords(failed), account);
}

function wordedAnswer(words: CloudflareWords, account: string): Response {
  const judged = judgeRefusal(words, account);

  if ('need' in judged) return json({ body: { error: judged.need.sentence, need: judged.need } }, { status: judged.need.id === 'signin-again' ? 401 : 409 });

  return json({ body: { error: judged.refused.sentence, refused: judged.refused } }, { status: 502 });
}

/** A read with the sign-in's grant: its answer, or its refusal as `refusedAnswer` words it. */
function pageRead<A>(
  request: Request,
  env: Env,
  read: (transport: CloudflareTransport, user: CloudflareUser, session: DurableObjectStub<DeployRunDO>) => Effect.Effect<A, KinuError>,
): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const held = yield* Effect.promise(async () => signedIn(request, env));

    if (held === null) return signInFirst();

    return yield* answered(read(bearerTransport(held.token), held.user, held.session), '');
  });
}

function accountRead<A>(
  request: Request,
  env: Env,
  account: string,
  read: (transport: CloudflareTransport, account: string, session: DurableObjectStub<DeployRunDO>) => Effect.Effect<A, KinuError>,
): Effect.Effect<Response, KinuError> {
  if (!v.is(CloudflareIdSchema, account)) return Effect.succeed(err(400, 'That is not a Cloudflare account id.'));

  return pageRead(request, env, (transport, _user, session) => read(transport, account, session));
}

/** Our own refusals stay ours; Cloudflare's arrive in its words through the catalog. */
function answered<A>(read: Effect.Effect<A, KinuError>, account: string): Effect.Effect<Response> {
  return read.pipe(Effect.matchCause({
    onSuccess: (body) => json({ body }),
    onFailure: (failed) => refusedAnswer(failed, account),
  }));
}

/**
 * Who is signed in, their accounts, the run they left unfinished (in any account; the first found), and the Kinus the
 * accounts already run, each with the update it would be offered. The run is found by its name alone: a sign-in on
 * another device is the same Cloudflare user.
 */
function sessionAnswer(request: Request, env: Env): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const held = yield* Effect.promise(async () => signedIn(request, env));

    if (held === null) return json({ body: SIGNED_OUT });
    const transport = bearerTransport(held.token);
    const accounts = yield* heard(accountChoices(transport));

    if ('words' in accounts) return wordedAnswer(accounts.words, '');
    const origin = env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
    const channel = { http: (url: string) => fetch(url), origin, available: yield* channelBuild(origin) };

    const kinus = yield* Effect.forEach(accounts.answer, (account) => Effect.map(heard(deployedKinus(transport, account.id, channel)), (found) => ({ account: account.id, found })), { concurrency: 4 });

    const views = yield* Effect.forEach(accounts.answer, (account) => Effect.promise(async () => ownRun(env, held.user, account.id).view(held.user.id)));
    const unfinished = views.find((run) => run !== null && (run.state !== 'live' || run.live?.pending !== undefined)) ?? null;
    const followed = unfinished?.account ?? '';

    if (followed !== '') yield* Effect.promise(async () => held.session.follow(followed));

    const session: DeploySession = {
      signedIn: true,
      email: held.user.email,
      accounts: accounts.answer,
      resume: unfinished === null ? null : { runId: unfinished.runId, account: followed, phase: unfinished.phase.id, state: unfinished.state },
      deployments: kinus.flatMap(({ found }) => ('answer' in found ? found.answer : [])),
      // An account whose Kinus could not be read is not one without Kinus: it is named, in Cloudflare's words.
      unreadable: kinus.flatMap(({ account, found }) => ('words' in found ? [{ account, words: found.words }] : [])),
      apiTokens: yield* Effect.promise(async () => held.session.apiTokens()),
    };

    // Held to the page's contract before it leaves.
    return json({ body: v.parse(DeploySessionSchema, session) });
  });
}

/** The build the channel publishes now; null when it cannot be read, which the offer then says. */
function channelBuild(origin: string): Effect.Effect<UpdateBuild | null> {
  return Effect.map(heard(Effect.promise(async () => buildOf(await fetchReleaseManifest(origin)))), (read) => ('answer' in read ? read.answer : null));
}

/**
 * A run of this sign-in's user in the asked account: its answers settled from the account (`plannedRun`), then the
 * grant moved into it. Refused while a plan is going there: the page continues that one instead.
 */
function beginRun(request: Request, env: Env): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const asked = yield* Effect.promise(async () => safeJson(request, DeployRunRequestSchema));

    if (asked === null) return err(400, 'That is not a run this page can start.');
    const held = yield* Effect.promise(async () => signedIn(request, env));

    if (held === null) return signInFirst();
    const run = ownRun(env, held.user, asked.account);

    if (yield* Effect.promise(async () => run.busy())) return err(409, 'A run is already going in this account; continue it.');

    const planned = yield* plannedRun(bearerTransport(held.token), held.user, asked).pipe(Effect.matchCause({
      onSuccess: (plan) => ({ plan }),
      onFailure: (failed) => ({ refused: refusedAnswer(failed, asked.account) }),
    }));

    if ('refused' in planned) return planned.refused;
    const grant = yield* Effect.promise(async () => held.session.surrender());

    if (grant === null) return signInFirst();
    const runId = yield* Effect.promise(async () => run.begin(held.user.id, planned.plan, grant));

    if (runId === null) return err(409, 'A run is already going in this account; continue it.');
    yield* Effect.promise(async () => held.session.follow(asked.account));

    return json({ body: { runId } });
  });
}

/** The run this sign-in follows, for its own user; 404 when it follows none. */
function followedRun(
  request: Request,
  env: Env,
  act: (run: DurableObjectStub<DeployRunDO>, user: CloudflareUser, session: DurableObjectStub<DeployRunDO>) => Promise<DeployRunView | null>,
): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const held = yield* Effect.promise(async () => signedIn(request, env));

    if (held === null) return signInFirst();
    const account = yield* Effect.promise(async () => held.session.following());
    const view = account === '' ? null : yield* Effect.promise(async () => act(ownRun(env, held.user, account), held.user, held.session));

    return view === null ? err(404, 'This sign-in follows no deploy run.') : json({ body: v.parse(DeployRunViewSchema, view) });
  });
}
