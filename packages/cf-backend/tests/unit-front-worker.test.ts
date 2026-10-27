/**
 * The front Worker (src/front.ts) as a deployment on its own domain runs it, holding none of the main Worker's secrets.
 * A page open's requests are answered by the front or by the object they belong to, which checks the session itself;
 * everything else, and every other host, goes on to the main Worker. Driven through the front's own `fetch`, a real
 * account object with real sessions, and a real workspace object (L29).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { routedAgentRequests } from './helpers/agents-sdk';
import { makeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
import { HOSTED_ACTOR_ID_HEADER } from '@kinu.run/core';
import { SESSION_BEARER_HEADER } from '../src/cli/rpc-gate';

// Dynamic: the helpers above install the agents-SDK mock at load.
const { accountIdFor, createSession } = await import('../src/auth/store');

const { SESSION_COOKIE_NAME } = await import('../src/auth/cookies');

const { default: front } = await import('../src/front');

type FrontEnv = Parameters<typeof front.fetch>[1];

/** A deployment that signs in through OAuth: an address is the account its OAuth sign-in mints. */
const OAUTH_DEPLOYMENT = { SIGN_IN_PROVIDERS: 'google' };

const ORIGIN = 'https://kinu.example.com';

const PREVIEW_SUFFIX = 'kinu.example.com';

const OWNER_EMAIL = 'owner@kinu.example.com';

const WORKSPACE = 'front-own';

const SHELL = '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>';

interface Front {
  readonly user: TestUserDO;
  readonly ownerUserId: string;
  readonly session: string;
  /** What reached the main Worker, by URL. */
  readonly main: string[];
  fetch(path: string, init?: RequestInit & { readonly session?: string; readonly host?: string }): Promise<Response>;
  close(): Promise<void>;
}

const open: Front[] = [];

afterEach(async () => {
  routedAgentRequests.splice(0);

  while (open.length > 0) await open.pop()?.close();
});

async function seam(): Promise<Front> {
  const ownerUserId = await accountIdFor(OAUTH_DEPLOYMENT, OWNER_EMAIL);
  const actors = new Map<string, ActorHarness<HarnessOrchestratorAgent>>();
  const kv = makeKv();

  const workspaceActor = (name: string) => {
    const actor = actors.get(name);

    if (!actor) throw new Error(`no workspace actor named ${name}`);

    return actor.agent;
  };

  const user = createTestUserDO({ durableObjectId: ownerUserId, pages: { AUTH_KV: kv, workspace: workspaceActor } });
  const token = await provisionTestWorkspace(user, WORKSPACE, WORKSPACE);
  const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace: WORKSPACE, ownerUserId });

  actor.agent.harnessHoldsCapability(token);
  actors.set(WORKSPACE, actor);

  const UserDO = { idFromName: (name: string) => name, get: () => user.userDO };
  const OrchestratorAgent = { idFromName: (name: string) => name, get: workspaceActor };
  const main: string[] = [];

  const assets = async (input: RequestInfo | URL) => new Response(new URL(new Request(input).url).pathname === '/landing.html' ? 'the landing page' : SHELL, {
    headers: { 'content-type': 'text/html' },
  });

  // The main Worker's env, which mints the session the browser holds; the front's holds no secret of it.
  const mainEnv: Partial<Env> = {};

  Object.assign(mainEnv, { ...OAUTH_DEPLOYMENT, AUTH_KV: kv, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY, UserDO });

  const frontEnv: Partial<FrontEnv> = {};

  Object.assign(frontEnv, {
    UserDO, OrchestratorAgent, ASSETS: { fetch: assets },
    CLI_PUBLIC_ORIGIN: ORIGIN, PREVIEW_HOST_SUFFIX: PREVIEW_SUFFIX, CF_VERSION_METADATA: { id: 'front-v', tag: '', timestamp: '' },
    MAIN: {
      fetch: async (input: RequestInfo | URL) => {
        main.push(new Request(input).url);

        return new Response('the main Worker', { headers: { 'x-kinu-version': 'main-v' } });
      },
    },
  });

  // SAFETY: the session store reads exactly the bindings constructed above.
  const session = (await createSession(mainEnv as Env, {
    provider: 'cloudflare', providerSub: 'cf-owner', email: OWNER_EMAIL, emailVerified: true, displayName: null,
  })).token;

  const ctx = workerContext();

  const built: Front = {
    user,
    ownerUserId,
    session,
    main,
    fetch: async (path, init = {}) => {
      const headers = new Headers(init.headers);

      if (init.session !== undefined) headers.set('cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(init.session)}`);

      // SAFETY: the front reads exactly the bindings constructed above, `MAIN` among them.
      return await front.fetch(new Request(`https://${init.host ?? 'kinu.example.com'}${path}`, { ...init, headers }), frontEnv as FrontEnv, ctx);
    },
    close: async () => {
      await user.joinFibers();
      user.close();
    },
  };

  open.push(built);

  return built;
}

describe('the front Worker', () => {
  test('a visitor with no session is shown the landing page by the front, and every other request goes on', async () => {
    const seen = await seam();

    const landing = await seen.fetch('/');
    const api = await seen.fetch('/api/user/profile');
    const preview = await seen.fetch('/', { host: `p-3000-abc.${PREVIEW_SUFFIX}` });

    expect({
      landing: [landing.status, await landing.text(), landing.headers.get('x-kinu-version')],
      api: [await api.text(), api.headers.get('x-kinu-version')],
      preview: await preview.text(),
      main: seen.main,
      routed: routedAgentRequests.length,
    }).toEqual({
      landing: [200, 'the landing page', 'front-v'],
      api: ['the main Worker', 'main-v'],
      preview: 'the main Worker',
      main: [`${ORIGIN}/api/user/profile`, `https://p-3000-abc.${PREVIEW_SUFFIX}/`],
      routed: 0,
    });
  });

  test('a signed-in page is the account object\'s, which checks the session itself', async () => {
    const seen = await seam();
    const page = await seen.fetch(`/workspace/${WORKSPACE}`, { session: seen.session, headers: { accept: 'text/html' } });

    await seen.user.userDO.revokeBrowserSession(await testOwner(), (await seen.user.db
      .query<{ token_hash: string }, []>('SELECT token_hash FROM user_browser_sessions').get())?.token_hash ?? '');

    const signedOut = await seen.fetch(`/workspace/${WORKSPACE}`, { session: seen.session, headers: { accept: 'text/html' } });

    // The object serves the page from its own assets (the harness's shell), never the front's.
    expect({
      page: [page.status, (await page.text()).includes('<title>Kinu</title>')],
      signedOut: [signedOut.status, new URL(signedOut.headers.get('location') ?? '', ORIGIN).pathname],
      main: seen.main,
    }).toEqual({ page: [200, true], signedOut: [302, '/login'], main: [] });
  });

  // The account's object is an Agent, whose own fetch would take any handshake as a socket of its own: on 2026-10-27 a
  // page's agent socket, asked of an account object still on the build before the front (the deploy of ec37304a3,
  // 03:58Z), was opened on it, and the page never reconnected. A Worker retries a refusal; a socket on the wrong object
  // it keeps.
  test('the account\'s object refuses a handshake on a path it does not route', async () => {
    const seen = await seam();
    const handshake = { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
    // A route an object of another build may not have, as the agent socket's admission once was.
    const stray = await seen.user.userDO.fetch(new Request(`${ORIGIN}/a-path-no-build-routes`, { headers: handshake }));

    expect([stray.status, stray.headers.get('x-harness-agent')]).toEqual([404, null]);
  });

  test('an agent socket reaches its workspace only through the account\'s admission, as the identity it verified', async () => {
    const seen = await seam();
    const socket = `/agents/orchestrator-agent/${WORKSPACE}`;
    const forged = { 'x-kinu-user-id': 'someone-else', [SESSION_BEARER_HEADER]: 'forged', [HOSTED_ACTOR_ID_HEADER]: 'forged-actor', origin: ORIGIN };

    await seen.fetch(socket, { session: seen.session, headers: { ...forged, upgrade: 'websocket' } });
    await seen.fetch(`${socket}/get-messages`, { session: seen.session, method: 'POST', headers: forged, body: 'kept whole' });
    await seen.fetch(socket, { session: seen.session, method: 'HEAD', headers: forged });

    const [opened, posted, head] = routedAgentRequests;

    const refused = {
      crossSite: (await seen.fetch(socket, { session: seen.session, headers: { upgrade: 'websocket', origin: 'https://evil.example' } })).status,
      foreign: (await seen.fetch('/agents/user-d-o/victim', { session: seen.session, headers: { origin: ORIGIN } })).status,
      unheld: (await seen.fetch('/agents/orchestrator-agent/someone-elses', { session: seen.session, headers: { upgrade: 'websocket', origin: ORIGIN } })).status,
    };

    expect({
      identity: [opened?.headers.get('x-kinu-user-id'), opened?.headers.has(SESSION_BEARER_HEADER), opened?.headers.get(SESSION_BEARER_HEADER) === 'forged',
        opened?.headers.has(HOSTED_ACTOR_ID_HEADER)],
      posted: [posted?.method, await posted?.text()],
      head: head?.method,
      refused,
      routed: routedAgentRequests.length,
    }).toEqual({
      identity: [seen.ownerUserId, true, false, false],
      posted: ['POST', 'kept whole'],
      head: 'HEAD',
      refused: { crossSite: 403, foreign: 404, unheld: 404 },
      routed: 3,
    });
  });
});
