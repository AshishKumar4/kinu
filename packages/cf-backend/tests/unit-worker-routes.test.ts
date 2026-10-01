/**
 * The Worker entry's dispatch outside `/api`, through the real `server.ts` fetch: which surface answers a
 * method and path, in precedence order (Access, public pages and downloads, the MCP and device doors, the
 * session gate, agent sockets, the app shell). A path that reaches the wrong surface either skips a gate
 * or serves the shell where a door should answer.
 */
import { describe, expect, test } from 'bun:test';
import { DEV_IDENTITY_HEADER, type UserCaller } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext, workerEnv } from './helpers/bindings';
import { makeKv } from './helpers/kv';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's DO graph reaches `cloudflare:*`
// modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';

const DEV_SECRET = 'worker-routes-dev-secret';

/** The workspace the signed-in caller owns. */
const OWNED = 'ws';

type Caller = 'anon' | 'page' | 'signed-in' | 'localhost';

interface Answer {
  readonly status: number;
  /** Paths the app shell (`ASSETS`) was asked for. */
  readonly assets: readonly string[];
  readonly location: string | null;
}

function env(assets: string[]): Env {
  const objects = <Stub>(stub: Stub) => ({ idFromName: (name: string) => name, get: () => stub });

  const reached: Partial<Env> = {
    CLI_PUBLIC_ORIGIN: `https://${APP_HOST}`,
    PREVIEW_HOST_SUFFIX: APP_HOST,
    DEV_USER_EMAIL: 'routes@example.com',
    DEV_IDENTITY_SECRET: DEV_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: 'worker-routes-root-secret',
    CONTROL_PLANE_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    CONTROL_PLANE_ACCESS_AUD: 'aud',
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        assets.push(new URL(input instanceof Request ? input.url : String(input)).pathname);

        return new Response('shell', { headers: { 'content-type': 'text/html' } });
      },
      connect: () => { throw new Error('ASSETS.connect: not reachable in this test'); },
    },
  };

  // Each stub carries only the calls these routes make; the platform types are wider.
  Object.assign(reached, {
    AUTH_KV: makeKv(),
    UserDO: objects({
      async hasWorkspace(_caller: UserCaller, name: string) { return name === OWNED; },
      async ensureWorkspaceCapability() {},
      // No OAuth app is configured, so /login asks whether the deployment has its first account.
      async builtinHasOwner() { return false; },
      async builtinOwnerAccount() { return null; },
    }),
    OrchestratorAgent: objects({
      async claimOwner() { return { owner: 'owner', capabilityHash: null }; },
      async resolveHostedActorRoute() { return { reason: 'missing', error: 'Not hosted here.' }; },
    }),
    ControlPlaneDO: objects({ async observeUser() {}, async observeWorkspace() {}, async touchWorkspace() {} }),
  });

  return workerEnv(reached);
}

async function send(caller: Caller, method: string, path: string): Promise<Answer> {
  const assets: string[] = [];
  const headers: Record<string, string> = {};

  if (caller === 'page') headers.accept = 'text/html';

  if (caller === 'signed-in') headers[DEV_IDENTITY_HEADER] = DEV_SECRET;
  const origin = caller === 'localhost' ? 'http://localhost:8787' : `https://${APP_HOST}`;
  const response = await worker.fetch(new Request(`${origin}${path}`, { method, headers }), env(assets), workerContext());

  return { status: response.status, assets, location: response.headers.get('location') };
}

const shell = (path: string): Partial<Answer> => ({ status: 200, assets: [path] });

const door = (status: number): Partial<Answer> => ({ status, assets: [] });

const ROWS: readonly (readonly [Caller, string, string, Partial<Answer>])[] = [
  // Access runs before every bypass, on `/control*` and `/api/control*` only: its 404 stands where the
  // session gate would answer 401, or the shell 200.
  ['anon', 'GET', '/control', door(404)],
  ['anon', 'GET', '/control/', door(404)],
  ['signed-in', 'POST', '/control/users', door(404)],
  ['anon', 'GET', '/api/control', door(404)],
  ['anon', 'GET', '/api/control/overview', door(404)],
  ['signed-in', 'GET', '/controlpanel', shell('/controlpanel')],
  ['signed-in', 'GET', '/control-plane', shell('/control-plane')],
  ['anon', 'GET', '/api/controlx', door(401)],
  ['anon', 'GET', '/api/controllers/list', door(401)],

  // Landing and sign-in pages; HEAD and other methods on a GET-only page reach the shell.
  ['anon', 'GET', '/', { status: 200, assets: ['/landing.html'] }],
  ['anon', 'HEAD', '/', door(200)],
  ['signed-in', 'GET', '/', shell('/')],
  ['anon', 'GET', '/login', door(200)],
  ['signed-in', 'GET', '/login', door(302)],
  ['anon', 'HEAD', '/login', shell('/login')],
  ['anon', 'POST', '/login', shell('/login')],
  ['anon', 'POST', '/logout', door(302)],
  ['anon', 'PUT', '/logout', shell('/logout')],
  ['anon', 'GET', '/auth/unknown/start', door(404)],
  ['anon', 'HEAD', '/auth/unknown/start', shell('/auth/unknown/start')],
  ['anon', 'GET', '/auth/other', shell('/auth/other')],
  ['anon', 'GET', '/auth', door(401)],
  ['anon', 'GET', '/login/', door(401)],
  ['anon', 'GET', '/%6Cogin', door(401)],

  // Public downloads and pages; a GET route answers HEAD where the page serves it.
  ['anon', 'GET', '/install', door(200)],
  ['anon', 'HEAD', '/install.sh', door(200)],
  ['anon', 'POST', '/install', door(401)],
  ['anon', 'GET', '/downloads/kinu-worker-1.0.0.tar.gz', door(404)],
  ['anon', 'POST', '/downloads/kinu-worker-1.0.0.tar.gz', door(405)],
  ['anon', 'GET', '/downloads/kinu-worker-1.0.0.tar.gz.sha256', { status: 404, assets: ['/downloads/kinu-worker-1.0.0.tar.gz.sha256'] }],
  ['anon', 'GET', '/downloads/kinu-version.json', { status: 404, assets: ['/downloads/kinu-version.json'] }],
  ['anon', 'GET', '/downloads/other', door(401)],
  ['anon', 'HEAD', '/cli/auth', door(401)],
  ['anon', 'GET', '/deploy/callback', door(400)],
  ['anon', 'DELETE', '/deploy/callback', door(400)],
  ['anon', 'GET', '/deploy', shell('/deploy')],
  ['anon', 'GET', '/deploy/x', door(401)],
  ['anon', 'GET', '/assets/main.js', shell('/assets/main.js')],
  ['anon', 'GET', '/assets', door(401)],
  ['anon', 'GET', '/shared/blueprint/abc', shell('/shared/blueprint/abc')],

  // Dev asset paths bypass the session only off a published host.
  ['anon', 'GET', '/src/main.tsx', door(401)],
  ['localhost', 'GET', '/src/main.tsx', shell('/src/main.tsx')],
  ['localhost', 'GET', '/@react-refresh', shell('/@react-refresh')],

  // The MCP and device doors run their own auth.
  ['anon', 'OPTIONS', '/mcp/v1/ws', door(200)],
  ['anon', 'GET', '/mcp/v1/', door(400)],
  ['anon', 'GET', '/mcp/v1/ws', door(401)],
  ['signed-in', 'GET', '/mcp/v1', shell('/mcp/v1')],
  ['anon', 'GET', '/pc/connect', door(426)],
  ['anon', 'GET', '/pc/connect-ticket', door(405)],
  ['anon', 'GET', '/pc/', door(404)],
  ['anon', 'GET', '/pc/daemon.js', door(404)],
  ['anon', 'GET', '/pc', door(401)],

  // `/api/` is its own app; `/api` and `/apix` are not.
  ['anon', 'GET', '/api/health', { status: 200 }],
  ['anon', 'GET', '/api', door(401)],
  ['signed-in', 'GET', '/apix', shell('/apix')],

  // The session gate, then agent sockets, then the shell.
  ['page', 'GET', '/settings', { status: 302, assets: [], location: `https://${APP_HOST}/login?return_to=%2Fsettings` }],
  ['anon', 'GET', '/settings', door(401)],
  ['signed-in', 'GET', '/settings', shell('/settings')],
  ['page', 'GET', '/agents/orchestrator-agent/ws', door(401)],
  ['anon', 'GET', '/agents/user-d-o/victim', door(401)],
  ['signed-in', 'GET', '/agents/user-d-o/victim', door(404)],
  ['signed-in', 'GET', '/agents/', door(404)],
  ['signed-in', 'GET', '/agents/orchestrator-agent/ws/sub/x', door(404)],
  ['signed-in', 'GET', '/agents/orchestrator-agent/other', door(404)],
  ['signed-in', 'GET', '/agents/orchestrator-agent/ws/actor/gone', door(404)],
  ['signed-in', 'GET', '/agents/orchestrator-agent/ws', shell('/agents/orchestrator-agent/ws')],
  ['signed-in', 'GET', '/agents', shell('/agents')],
  ['anon', 'GET', '/agents/orchestrator-agent/ws?ticket=abc', door(400)],
];

describe('the Worker entry routes each method and path to one surface', () => {
  for (const [caller, method, path, expected] of ROWS) {
    test(`${caller} ${method} ${path}`, async () => {
      expect(await send(caller, method, path)).toMatchObject(expected);
    });
  }
});
