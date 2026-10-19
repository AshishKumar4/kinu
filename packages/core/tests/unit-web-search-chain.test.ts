// The account's search chain (web/search-chain.ts): who pays for a search through Cloudflare, how a refusal hands over,
// parks and retries, and what the person reads when every entry refused. Cloudflare's API and the AI binding are faked
// at their edges, answering in the shapes measured on 2026-10-17 and 2026-10-19.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  chainWebSearch,
  type AuthResolver, type DeploymentSearch, type ModelCallReport, type WebSearchRoute,
} from '../src/index';
import { ProviderPacer } from '../src/providers/pacing';

const ACCOUNT_BASE = 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1';

const EXA: WebSearchRoute = { provider: 'exa', billing: 'cloudflare' };

const LINKUP: WebSearchRoute = { provider: 'linkup', billing: 'cloudflare' };

const items = (url = 'https://developers.cloudflare.com/durable-objects/api/alarms/') => Response.json({
  items: [{ url, title: 'Alarms · Cloudflare Durable Objects docs', description: 'Schedule the object to wake.' }],
  metadata: { query: 'q', requestId: 'r', latencyMs: 600 },
});

/** The binding's refusal when the account's credits are spent (2026-10-17). */
const spent = (retryAfter?: string) => Response.json(
  { ok: false, error: { code: 'web_search_payment_required', status: 402, message: 'Your AI Gateway credit balance is zero' } },
  { status: 402, ...(retryAfter !== undefined && { headers: { 'retry-after': retryAfter } }) },
);

/** The REST API refusing a token it does not admit, in Cloudflare's v4 envelope (2026-10-19). */
const unauthenticated = () => Response.json(
  { success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null }, { status: 403 },
);

/** A world with a clock: the deployment's binding, Cloudflare's REST API, and what each was asked. */
function world(opts: { binding?: (provider: string) => Response; rest?: (provider: string) => Response; login?: boolean } = {}) {
  let now = 1_000_000;
  const waits: number[] = [];
  const asked: string[] = [];
  const restAsked: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const reports: ModelCallReport[] = [];
  const pacer = new ProviderPacer({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });

  const deployment: DeploymentSearch = async ({ provider, query, limit }) => {
    asked.push(`${provider}:${query}:${limit}`);

    return (opts.binding ?? (() => items()))(provider);
  };

  const fetchImpl = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = v.parse(v.looseObject({ provider: v.string() }), await request.json());
    restAsked.push({ url: request.url, authorization: request.headers.get('authorization'), body });

    return (opts.rest ?? (() => items()))(body.provider);
  }, { preconnect: fetch.preconnect });

  const getAuth: AuthResolver = async (key) => (key === 'cloudflare.web-search' && opts.login === true
    ? { headers: { Authorization: 'Bearer cf-login', 'cf-aig-gateway-id': 'research' }, baseURL: ACCOUNT_BASE }
    : null);

  const searchWith = (routes: readonly WebSearchRoute[], retries = 3) => chainWebSearch({
    fetch: fetchImpl, getAuth, deployment, report: (row) => { reports.push(row); }, pacer, chain: async () => ({ routes, retries }),
  });

  return { asked, restAsked, reports, waits, searchWith, later: (ms: number) => { now += ms; } };
}

describe('who pays for a search through Cloudflare', () => {
  test("an account with no Cloudflare login that grants search is searched on the deployment's gateway, and its answer is ranked, screened and clipped", async () => {
    const w = world({
      binding: () => Response.json({
        items: [
          { url: 'https://developers.cloudflare.com/workers/wrangler/commands/', title: ' wrangler deploy ', description: 'x'.repeat(8_000) },
          { url: 'http://169.254.169.254/latest/meta-data', title: 'Metadata', description: 'never surfaced' },
          { url: 'https://blog.cloudflare.com/' },
        ],
      }),
    });

    expect(await w.searchWith([EXA])({ query: 'wrangler deploy', limit: 7 })).toEqual({
      query: 'wrangler deploy', source: 'exa',
      results: [
        { title: 'wrangler deploy', url: 'https://developers.cloudflare.com/workers/wrangler/commands/', snippet: 'x'.repeat(600), position: 1 },
        { title: 'https://blog.cloudflare.com/', url: 'https://blog.cloudflare.com/', snippet: '', position: 2 },
      ],
    });
    expect(w.asked).toEqual(['exa:wrangler deploy:7']);
    expect(w.restAsked).toEqual([]);
    expect(w.reports).toEqual([{ source: 'search', usage: {}, modelId: 'websearch/exa', account: undefined }]);
  });

  test('an account whose Cloudflare login grants search is searched on its own account and gateway, never the deployment\'s', async () => {
    const w = world({ login: true });

    expect((await w.searchWith([EXA])({ query: 'Durable Objects alarms', limit: 15 })).source).toBe('exa');
    expect(w.asked).toEqual([]);
    expect(w.restAsked).toEqual([{
      url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/websearch/',
      authorization: 'Bearer cf-login',
      // Cloudflare's API answers at most 10 results a request.
      body: { query: 'Durable Objects alarms', limit: 10, provider: 'exa', options: { gateway: { id: 'research' } } },
    }]);
    expect(w.reports).toEqual([{ source: 'search', usage: {}, modelId: 'websearch/exa', account: { provider: 'my-gateway', name: 'main' } }]);
  });

  test("the account's own gateway refusing is the account's answer: Kinu does not bill the deployment instead", async () => {
    const w = world({ login: true, rest: () => spent() });

    await expect(w.searchWith([EXA], 0)({ query: 'q', limit: 5 }))
      .rejects.toMatchObject({ code: 'denied', message: 'Exa on your AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero' });
    expect(w.asked).toEqual([]);
  });

  test('with no Cloudflare login and no deployment to bill (a CLI signed out), the search says so', async () => {
    const reports: ModelCallReport[] = [];

    const search = chainWebSearch({
      fetch, getAuth: async () => null, report: (row) => { reports.push(row); }, chain: async () => ({ routes: [EXA], retries: 3 }),
    });

    await expect(search({ query: 'q', limit: 5 })).rejects.toThrow('Exa through Cloudflare: no Cloudflare account is connected');
    expect(reports).toEqual([]);
  });
});

describe('a refusal along the chain', () => {
  test('hands over at once to the next entry, and the refused one is passed over until its Retry-After', async () => {
    const w = world({ binding: (provider) => (provider === 'exa' ? spent('120') : items()) });
    const search = w.searchWith([EXA, LINKUP]);

    expect((await search({ query: 'one', limit: 5 })).source).toBe('linkup');
    w.later(60_000);
    expect((await search({ query: 'two', limit: 5 })).source).toBe('linkup');
    w.later(70_000);
    expect((await search({ query: 'three', limit: 5 })).source).toBe('linkup');
    expect(w.asked).toEqual(['exa:one:5', 'linkup:one:5', 'linkup:two:5', 'exa:three:5', 'linkup:three:5']);
    expect(w.waits).toEqual([]);
  });

  test("the last entry is asked again after a failure that may pass, up to the account's retries, waiting what the provider stated", async () => {
    let answers = 0;

    const w = world({
      binding: () => {
        answers += 1;

        return answers <= 2 ? new Response('busy', { status: 429, headers: { 'retry-after': '2' } }) : items();
      },
    });

    expect((await w.searchWith([EXA], 2)({ query: 'q', limit: 5 })).source).toBe('exa');
    expect(w.asked).toHaveLength(3);
    expect(w.waits).toEqual([2_000, 2_000]);

    // One retry fewer than it needs: the provider's words stand.
    answers = 0;
    await expect(w.searchWith([EXA], 1)({ query: 'q', limit: 5 })).rejects.toMatchObject({ code: 'unavailable', message: 'Exa on this deployment\'s AI Gateway: Cloudflare answered 429: busy' });
  });

  test('when every entry refused, the person reads each entry and its provider\'s own words, and nothing that cannot pass is asked twice', async () => {
    const w = world({ binding: (provider) => (provider === 'exa' ? spent() : unauthenticated()) });

    const refused = w.searchWith([EXA, LINKUP])({ query: 'q', limit: 5 });

    await expect(refused).rejects.toMatchObject({
      code: 'denied',
      message: 'Exa on this deployment\'s AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero; '
        + 'Linkup on this deployment\'s AI Gateway: Cloudflare answered 403: Authentication error',
    });
    expect(w.asked).toEqual(['exa:q:5', 'linkup:q:5']);
    expect(w.waits).toEqual([]);
  });

  test("a 400 hands over too, and AI Gateway's own refusal is read in its words", async () => {
    // Cloudflare's answer to a search on a gateway the account lacks (2026-10-19).
    const missingGateway = () => Response.json({
      success: false, result: [], messages: [], error: [{ code: 2001, message: 'Please configure AI Gateway in the Cloudflare dashboard' }],
      name: 'AiGatewayError', httpCode: 400, internalCode: 2001,
    }, { status: 400 });

    const w = world({ binding: (provider) => (provider === 'exa' ? missingGateway() : items()) });

    expect((await w.searchWith([EXA, LINKUP])({ query: 'q', limit: 5 })).source).toBe('linkup');
    w.later(10 * 60_000);
    await expect(w.searchWith([EXA])({ query: 'q', limit: 5 })).rejects.toMatchObject({
      code: 'bad_input', message: "Exa on this deployment's AI Gateway: Cloudflare answered 400: Please configure AI Gateway in the Cloudflare dashboard",
    });
    expect(w.asked).toEqual(['exa:q:5', 'linkup:q:5', 'exa:q:5']);
  });

  test('a search its caller cancels ends there: no later entry is asked', async () => {
    const stop = new AbortController();
    const asked: string[] = [];

    const search = chainWebSearch({
      fetch,
      getAuth: async () => null,
      deployment: async ({ provider }) => {
        asked.push(provider);
        stop.abort();

        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      report: () => undefined,
      chain: async () => ({ routes: [EXA, LINKUP], retries: 3 }),
    });

    await expect(search({ query: 'q', limit: 5, signal: stop.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(asked).toEqual(['exa']);
  });
});
