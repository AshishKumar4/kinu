// A CLI signed in to the deployment searches the web as its account: the deployment runs the account's own chain where
// its keys are sealed, behind the inference proxy's bearer gate, and hands back the search as the `web` tool reads it.
// The AI binding is faked at its edge; the route, the gate, the chain and the CLI's client are the product's.
import { expect, test } from 'bun:test';
import {
  BUILTIN_PROFILE_CATALOG, createDefaultWebSearchProvider, profileCatalogDigest, routeWebSearch, USER_WEB_SEARCH_PATH,
  type ProfileCatalog, type UserCaller, type WorkersAiWebSearch,
} from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { cliAccount } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { webSearchRoutes } from '../src/user/web-search-route';

const USER_ID = '0123456789abcdef0123456789abcdef';

const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

/** An access token minted for reading workspaces only: it reaches no service of the deployment's. */
const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;

const ORIGIN = 'https://kinu.test';

/** No search here renders a page. */
const NO_BROWSER = { quickActions: async () => new Response('this suite renders no page', { status: 500 }) };

/** The deployment's AI binding at its edge, answering as Cloudflare's Web Search API does; `answer` set per test. */
function world(answer: () => Response, opts: { gateway?: string; catalog?: ProfileCatalog } = {}) {
  const asked: Array<Parameters<WorkersAiWebSearch['websearch']>[0]> = [];
  const catalog = opts.catalog ?? BUILTIN_PROFILE_CATALOG;

  const userDO = cliAccount({
    async verifyCliToken(_caller: UserCaller, bearer: string) {
      return { ok: bearer === SESSION_TOKEN, tokenHash: 'session-hash', user: { id: USER_ID, email: 'ana@example.com', displayName: 'Ana' } };
    },
    async verifyAccessToken(_caller: UserCaller, bearer: string) {
      return bearer === READ_TOKEN
        ? { ok: true, tokenHash: 'read-hash', scopes: ['workspace.read' as const], user: { id: USER_ID, email: 'ana@example.com', displayName: 'Ana' } }
        : { ok: false, error: 'invalid token' };
    },
    // No Cloudflare login and no search key: its Cloudflare entries bill the deployment.
    getAuth: async () => null,
    getProfileCatalog: async () => ({ authority: { kind: 'account' as const, accountId: USER_ID }, version: 1, digest: profileCatalogDigest(catalog), catalog }),
  });

  const served = serveFamily(webSearchRoutes);

  const env: Parameters<typeof served>[1] = {
    UserDO: { idFromName: (name) => name, get: () => userDO },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    AI_GATEWAY_URL: opts.gateway ?? 'https://gateway.ai.cloudflare.com/v1/account/kinu-ai-gateway/workers-ai/v1',
    AI: {
      websearch: async (request) => {
        asked.push(request);

        return answer();
      },
    },
  };

  // The CLI's own client of the route, its transport the route itself.
  const viaCli = (token: string) => createDefaultWebSearchProvider({
    fetch,
    browser: NO_BROWSER,
    search: routeWebSearch({
      origin: ORIGIN, token, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const answered = await served(new Request(input, init), env);

        return answered ?? new Response('no route', { status: 404 });
      }, { preconnect: fetch.preconnect }),
    }),
  });

  return { asked, viaCli, served, env };
}

const answers = () => Response.json({
  items: [{ url: 'https://developers.cloudflare.com/workers/wrangler/', title: 'Wrangler', description: 'The CLI for Workers.' }],
  metadata: { query: 'q', requestId: 'r', latencyMs: 600 },
});

test("a signed-in CLI's search is its account's chain, run by the deployment: with no Cloudflare login, on the deployment's gateway", async () => {
  const { asked, viaCli } = world(answers);

  expect(await viaCli(SESSION_TOKEN).search('wrangler deploy', { limit: 3 })).toEqual({
    query: 'wrangler deploy', source: 'exa',
    results: [{ title: 'Wrangler', url: 'https://developers.cloudflare.com/workers/wrangler/', snippet: 'The CLI for Workers.', position: 1 }],
  });
  expect(asked).toEqual([{ gatewayId: 'kinu-ai-gateway', query: 'wrangler deploy', limit: 3, provider: 'exa' }]);
});

test("the account's own choice is what the CLI searches with", async () => {
  const { asked, viaCli } = world(answers, { catalog: { ...BUILTIN_PROFILE_CATALOG, webSearch: [{ provider: 'linkup', billing: 'cloudflare' }] } });

  expect((await viaCli(SESSION_TOKEN).search('wrangler deploy')).source).toBe('linkup');
  expect(asked.map((request) => request.provider)).toEqual(['linkup']);
});

test("a refusal reaches the CLI in Cloudflare's own words, and no one else's token reaches the search", async () => {
  const spent = world(() => Response.json({ ok: false, error: { code: 'web_search_payment_required', status: 402, message: 'Your AI Gateway credit balance is zero' } }, { status: 402 }));

  await expect(spent.viaCli(SESSION_TOKEN).search('wrangler deploy')).rejects.toMatchObject({
    // With no key stored, the default chain's second entry says one would serve.
    code: 'denied', message: "Exa on this deployment's AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero; Exa with your key: no Exa key is stored. "
      + "To search again, this deployment's search credits are spent: add your own search key in Settings > Web search.",
  });

  // Signed out, or a token not minted for the deployment's services: refused at the gate, nothing searched.
  const gate = world(answers);

  const post = (headers: Record<string, string>, body: { query: string; limit: number }) => gate.served(new Request(`${ORIGIN}${USER_WEB_SEARCH_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), gate.env);

  expect((await post({}, { query: 'q', limit: 5 }))?.status).toBe(401);
  expect((await post({ authorization: `Bearer ${READ_TOKEN}` }, { query: 'q', limit: 5 }))?.status).toBe(403);
  expect((await post({ authorization: `Bearer ${SESSION_TOKEN}` }, { query: '', limit: 5 }))?.status).toBe(400);
  expect(gate.asked).toEqual([]);
});

test('an account with no Cloudflare login on a deployment with no gateway to search on is told so', async () => {
  const { viaCli, asked } = world(answers, { gateway: 'not a url' });

  await expect(viaCli(SESSION_TOKEN).search('q')).rejects.toThrow('Exa through Cloudflare: no Cloudflare account is connected');
  expect(asked).toEqual([]);
});
