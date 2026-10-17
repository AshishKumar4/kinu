// A CLI signed in to the deployment searches the web through the deployment's own search: the same Cloudflare Web
// Search API call a workspace makes through the AI binding, behind the inference proxy's bearer gate. The binding is
// faked at its edge; the route and the gate are the product's.
import { expect, test } from 'bun:test';
import { createDefaultWebSearchProvider, routeWebSearch, USER_WEB_SEARCH_PATH, type UserCaller, type WorkersAiWebSearch } from '@kinu.run/core';
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
function world(answer: () => Response, opts: { gateway?: string } = {}) {
  const asked: Array<Parameters<WorkersAiWebSearch['websearch']>[0]> = [];

  const userDO = cliAccount({
    async verifyCliToken(_caller: UserCaller, bearer: string) {
      return { ok: bearer === SESSION_TOKEN, tokenHash: 'session-hash', user: { id: USER_ID, email: 'ana@example.com', displayName: 'Ana' } };
    },
    async verifyAccessToken(_caller: UserCaller, bearer: string) {
      return bearer === READ_TOKEN
        ? { ok: true, tokenHash: 'read-hash', scopes: ['workspace.read' as const], user: { id: USER_ID, email: 'ana@example.com', displayName: 'Ana' } }
        : { ok: false, error: 'invalid token' };
    },
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
  const viaCli = (token: string) => routeWebSearch({
    origin: ORIGIN, token, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const answered = await served(new Request(input, init), env);

      return answered ?? new Response('no route', { status: 404 });
    }, { preconnect: fetch.preconnect }),
  });

  return { asked, viaCli, served, env };
}

const answers = () => Response.json({ items: [{ url: 'https://example.com/a', title: 'First', description: 'The first.' }], metadata: { query: 'q', requestId: 'r', latencyMs: 600 } });

test("a signed-in CLI's search is the deployment's own: the API's answer, read as a workspace reads it", async () => {
  const { asked, viaCli } = world(answers);
  const provider = createDefaultWebSearchProvider({ fetch, browser: NO_BROWSER, firstParty: viaCli(SESSION_TOKEN) });

  expect(await provider.search('raleigh events', { limit: 3 })).toEqual({
    query: 'raleigh events', source: 'ceramic', results: [{ title: 'First', url: 'https://example.com/a', snippet: 'The first.', position: 1 }],
  });
  expect(asked).toEqual([{ gatewayId: 'kinu-ai-gateway', query: 'raleigh events', limit: 3, provider: 'ceramic' }]);
});

test("the deployment's refusal reaches the CLI in the same words, and no one else's token reaches the search", async () => {
  const spent = world(() => Response.json({ ok: false, error: { code: 'web_search_payment_required', status: 402, message: 'Your AI Gateway credit balance is zero' } }, { status: 402 }));
  const provider = createDefaultWebSearchProvider({ fetch, browser: NO_BROWSER, firstParty: spent.viaCli(SESSION_TOKEN) });

  await expect(provider.search('raleigh events')).rejects.toThrow('Web search is not available on this deployment right now');

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

test('a deployment with no gateway to search on says so', async () => {
  const { viaCli, asked } = world(answers, { gateway: 'not a url' });
  const provider = createDefaultWebSearchProvider({ fetch, browser: NO_BROWSER, firstParty: viaCli(SESSION_TOKEN) });

  await expect(provider.search('q')).rejects.toThrow('Web search failed (503)');
  expect(asked).toEqual([]);
});
