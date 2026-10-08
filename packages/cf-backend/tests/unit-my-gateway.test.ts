// my-gateway: the user's own AI Gateway via their Cloudflare OAuth credential
// (POST {account}/ai/v1/chat/completions + cf-aig-gateway-id header).
import { describe, test, expect, setSystemTime } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { createTestUserDO, testOwner } from './helpers/user-do';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { asFetchFunction, parseJsonObject, type JsonValue, type OAuthCredential, type AuthRequest } from '@kinu.run/core';
import {
  CLOUDFLARE_AI_GATEWAY_CRED_KEY,
  CLOUDFLARE_OAUTH_CRED_KEY,
  cloudflareAccountAPIRoot,
  
  fetchCloudflareAIGateways,
} from '@kinu.run/core';
import { requestUrl } from '@kinu.run/core';

import { present } from '@kinu.run/test-utils';

const ACCOUNT_ROOT = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1';

const AI_BASE_URL = `${ACCOUNT_ROOT}/ai/v1`;

function gatewayStub(opts: {
  gatewayId?: string | null;
  token?: string;
  freshToken?: string;
} = {}) {
  const gatewayId = opts.gatewayId === undefined ? 'my-gw' : opts.gatewayId;

  const headersFor = (token: string) => gatewayId
    ? { authorization: `Bearer ${token}`, 'cf-aig-gateway-id': gatewayId }
    : null;

  return userCredentialSource({
    getAuthHeaders: async (key: string, o?: AuthRequest) => {
      if (key === 'cloudflare.oauth') return { authorization: `Bearer ${opts.token ?? 'cf-user'}` };

      if (key !== CLOUDFLARE_AI_GATEWAY_CRED_KEY) return null;

      return headersFor(o?.rejected === undefined ? (opts.token ?? 'cf-user') : (opts.freshToken ?? opts.token ?? 'cf-user'));
    },
    listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
    getCredentialBaseURL: async (key: string) =>
      (key === 'cloudflare.oauth' || key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) ? AI_BASE_URL : null,
  });
}

function chatCompletionResponse(model: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } });
}

/** models.dev knows none of these authors, so each is sent on the gateway's unified chat API. */
function uncatalogued(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => (requestUrl(input).startsWith('https://models.dev/')
    ? Response.json({})
    : await fetch(input, init)));
}

describe('my-gateway request shape', () => {
  test('routes through the account /ai/v1 endpoint with bearer + cf-aig-gateway-id', async () => {
    const seen: Array<{ url: string; auth: string | null; gateway: string | null; model: unknown }> = [];

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'prod-gw', token: 'cf-user-token' }),
      fetch: uncatalogued(asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const body = parseJsonObject(await new Request(input, init).text());
        seen.push({
          url: requestUrl(input),
          auth: headers.get('authorization'),
          gateway: headers.get('cf-aig-gateway-id'),
          model: body.model,
        });

        return chatCompletionResponse('google/gemini-2.5-flash');
      })),
    });

    const result = await generateText({
      model: reg.resolveModel('my-gateway/google/gemini-2.5-flash', 'kinu-test'),
      prompt: 'ping',
    });

    expect(result.text).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(seen[0].auth).toBe('Bearer cf-user-token');
    expect(seen[0].gateway).toBe('prod-gw');
    expect(seen[0].model).toBe('google/gemini-2.5-flash');
  });

  test('a mid-flight 401 forces one refresh and retries with the fresh token', async () => {
    const wire: Array<string | null> = [];

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ token: 'cf-stale', freshToken: 'cf-fresh' }),
      fetch: uncatalogued(asFetchFunction(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        wire.push(headers.get('authorization'));

        if (headers.get('authorization') === 'Bearer cf-stale') {
          return new Response(JSON.stringify({ errors: [{ code: 10000, message: 'Invalid access token' }] }), {
            status: 401, headers: { 'content-type': 'application/json' },
          });
        }

        return chatCompletionResponse('xai/grok-4.7');
      })),
    });

    const result = await generateText({
      model: reg.resolveModel('my-gateway/xai/grok-4.7', 'kinu-test'),
      prompt: 'ping',
    });

    expect(result.text).toBe('ok');
    expect(wire).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
  });
});

describe('my-gateway availability gating', () => {
  test('unavailable until a gateway is selected; available once it is', async () => {
    const noGateway = createAgentProviderRegistry({ env: {}, userDO: gatewayStub({ gatewayId: null }) });
    expect(await present(noGateway.registry.get('my-gateway'), 'the my-gateway provider').isAvailable(noGateway.deps)).toBe(false);

    const selected = createAgentProviderRegistry({ env: {}, userDO: gatewayStub() });
    expect(await present(selected.registry.get('my-gateway'), 'the my-gateway provider').isAvailable(selected.deps)).toBe(true);
  });

  test('without a usable Cloudflare credential the provider drops out', async () => {
    const dead = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    });

    const reg = createAgentProviderRegistry({ env: {}, userDO: dead });
    const provider = present(reg.registry.get('my-gateway'), 'the my-gateway provider');

    expect(await provider.isAvailable(reg.deps)).toBe(false);
    expect(present(await provider.unavailableReason?.(reg.deps), "the my-gateway provider's unavailable reason")).toMatch(/select an AI Gateway/i);
  });
});

describe('my-gateway model discovery', () => {
  /** The gateway's own catalog rows, in the ids its REST API takes (models.dev `cloudflare-ai-gateway`, 2026-10-06). */
  const modelsDevBody = JSON.stringify({
    'cloudflare-ai-gateway': {
      id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', npm: 'ai-gateway-provider',
      models: {
        'openai/gpt-4.1': { id: 'openai/gpt-4.1', name: 'GPT-4.1', tool_call: true, limit: { context: 1047576 }, provider: { npm: '@ai-sdk/openai' } },
        'anthropic/claude-sonnet-4.5': { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', tool_call: true, limit: { context: 200000 }, provider: { npm: '@ai-sdk/anthropic' } },
        'xai/grok-4.7': { id: 'xai/grok-4.7', name: 'Grok 4.7', tool_call: true, limit: { context: 256000 } },
      },
    },
    // OpenAI's and Google's own ids are REST ids too, and these rows are absent from the gateway's. A realtime or
    // live model answers in audio over another API, so no REST endpoint serves it.
    openai: { id: 'openai', npm: '@ai-sdk/openai', models: {
      'gpt-6.1-sol': { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } },
      'gpt-realtime-2.1': { id: 'gpt-realtime-2.1', name: 'GPT-Realtime-2.1', tool_call: true, modalities: { input: ['text', 'audio'], output: ['text', 'audio'] } },
    } },
    google: { id: 'google', npm: '@ai-sdk/google', models: {
      'gemini-2.5-pro': { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tool_call: true },
      'gemini-3.1-flash-live-preview': { id: 'gemini-3.1-flash-live-preview', name: 'Gemini 3.1 Flash Live', tool_call: true, modalities: { input: ['audio'], output: ['text', 'audio'] } },
    } },
    anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic', models: { 'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tool_call: true } } },
  });

  /** The account's management API: keys stored under `default` (`slugs`) or another alias, its credits and its policy. */
  function discoveryFetch(opts: {
    slugs: string[];
    otherAlias?: string[];
    balance?: number | 'denied';
    byokOnly?: boolean;
    onRequest?: (url: string) => void;
  }): typeof fetch {
    return asFetchFunction(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      opts.onRequest?.(url);

      if (url.startsWith('https://models.dev/')) {
        return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
      }

      if (url.includes('/provider_configs')) {
        const stored = [...opts.slugs.map((slug) => [slug, 'default']), ...(opts.otherAlias ?? []).map((slug) => [slug, 'production'])];

        return Response.json({
          success: true,
          result: stored.map(([slug, alias], i) => ({ id: `pc-${String(i)}`, provider_slug: slug, alias, default_config: alias === 'default' })),
        });
      }

      if (/\/ai-gateway\/gateways\/[^/?]+$/.test(url)) return Response.json({ success: true, result: { id: 'gw', byok_only: opts.byokOnly ?? false } });

      if (url.includes('/billing/credit-balance')) {
        if (opts.balance === 'denied') {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
            status: 403, headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, result: { balance: opts.balance ?? 0 } }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  // The REST API pays with an author's key stored under `default`, else with credits unless the gateway requires keys
  // (developers.cloudflare.com/ai-gateway/features/unified-billing). A Google key is stored as `google-ai-studio` and an
  // xAI key as `grok`, while their REST ids are authored `google/` and `xai/`.
  test('the menu follows what the account pays with: default keys by author, then credits, then keys only', async () => {
    const account = { slugs: ['google-ai-studio', 'grok', 'workers-ai'], otherAlias: ['openai'], balance: 0, byokOnly: false };
    const reg = createAgentProviderRegistry({ env: {}, userDO: gatewayStub({ gatewayId: 'byok-gw', token: `t-${Math.random()}` }), fetch: discoveryFetch(account) });
    const provider = present(reg.registry.get('my-gateway'), 'the my-gateway provider');
    const menu = async () => (await provider.listModels(reg.deps)).map((model) => model.id).sort();

    try {
      const keyed = await menu();
      account.balance = 12.5;
      setSystemTime(new Date(Date.now() + 61_000));
      const billed = await menu();
      account.byokOnly = true;
      setSystemTime(new Date(Date.now() + 61_000));
      const keysOnly = await menu();

      expect({ keyed, billed, keysOnly }).toEqual({
        keyed: ['google/gemini-2.5-pro', 'xai/grok-4.7'],
        // Anthropic's own `claude-sonnet-4-5` is no REST id; the gateway's row is.
        billed: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'openai/gpt-4.1', 'openai/gpt-6.1-sol', 'xai/grok-4.7'],
        keysOnly: ['google/gemini-2.5-pro', 'xai/grok-4.7'],
      });
    } finally {
      setSystemTime();
    }
  });

  test('the management reads are in flight together, not one after the other', async () => {
    let creditAsked = false;
    let overlapped = false;
    const answer = discoveryFetch({ slugs: ['openai'], balance: 0 });

    const fetchFn = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);

      if (url.includes('/billing/credit-balance')) creditAsked = true;

      if (url.includes('/provider_configs')) {
        // The configs read answers once the credit read is out; a serial read gives up after a few turns.
        for (let turn = 0; turn < 50 && !creditAsked; turn += 1) {
          const next = Promise.withResolvers<void>();
          setImmediate(next.resolve);
          await next.promise;
        }

        overlapped = creditAsked;
      }

      return answer(input, init);
    });

    const reg = createAgentProviderRegistry({ env: {}, userDO: gatewayStub({ gatewayId: 'parallel-gw', token: `t-${Math.random()}` }), fetch: fetchFn });

    await present(reg.registry.get('my-gateway'), 'the my-gateway provider').listModels(reg.deps);
    expect(overlapped).toBe(true);
  });

  test('denied management reads narrow the menu to empty instead of throwing', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'old-scope-gw', token: `t-${Math.random()}` }),
      fetch: asFetchFunction(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.startsWith('https://models.dev/')) {
          return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
        }

        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }),
    });

    expect(await present(reg.registry.get('my-gateway'), 'the my-gateway provider').listModels(reg.deps)).toEqual([]);
  });

  test('a 5xx keeps the last catalog the account was shown, and caches nothing', async () => {
    // A non-ok answer must not be cached as "this gateway serves no providers".
    const token = `t-${Math.random()}`;
    let upstream: 'ok' | 'down' = 'ok';

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'byok-gw', token }),
      fetch: asFetchFunction(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.startsWith('https://models.dev/')) {
          return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
        }

        if (upstream === 'down') return new Response('upstream is unwell', { status: 500 });

        if (url.includes('/provider_configs')) {
          return new Response(JSON.stringify({ success: true, result: [{ provider_slug: 'openai', alias: 'default' }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, result: { balance: 0 } }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    });

    const provider = present(reg.registry.get('my-gateway'), 'the my-gateway provider');

    expect((await provider.listModels(reg.deps)).map((m) => m.id)).toEqual(['openai/gpt-4.1', 'openai/gpt-6.1-sol']);

    // Past the catalog TTL, so the cache is consulted rather than short-circuited.
    try {
      upstream = 'down';
      setSystemTime(new Date(Date.now() + 61_000));
      expect((await provider.listModels(reg.deps)).map((m) => m.id)).toEqual(['openai/gpt-4.1', 'openai/gpt-6.1-sol']);

      upstream = 'ok';
      setSystemTime(new Date(Date.now() + 61_000));
      expect((await provider.listModels(reg.deps)).map((m) => m.id)).toEqual(['openai/gpt-4.1', 'openai/gpt-6.1-sol']);
    } finally {
      setSystemTime();
    }
  });

  test('a 429 with no catalog to keep fails the provider instead of serving an empty menu', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'busy-gw', token: `t-${Math.random()}` }),
      fetch: asFetchFunction(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);

        if (url.startsWith('https://models.dev/')) {
          return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
        }

        return new Response('slow down', { status: 429 });
      }),
    });

    await expect(present(reg.registry.get('my-gateway'), 'the my-gateway provider').listModels(reg.deps)).rejects.toThrow(/429/);
  });
});

describe('my-gateway error mapping', () => {
  async function failWith(body: JsonValue, status = 400): Promise<string> {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'my-gw' }),
      fetch: uncatalogued(asFetchFunction(async () => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      }))),
    });

    try {
      await generateText({ model: reg.resolveModel('my-gateway/minimax/m3', 'kinu-test'), prompt: 'ping' });
      throw new Error('expected generateText to fail');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  test('2008 invalid provider → names the gateway and the rejected provider', async () => {
    const message = await failWith({ error: { code: 2008, message: 'Invalid provider' } });
    expect(message).toContain('AI Gateway "my-gw"');
    expect(message).toContain('minimax/m3');
    expect(message).not.toContain('{"error"');
  });

  test('2021 invalid user credentials → suggests BYOK key or Unified Billing', async () => {
    const message = await failWith({ success: false, errors: [{ code: 2021, message: 'Invalid User Credentials' }] });
    expect(message).toContain('AI Gateway "my-gw"');
    expect(message).toMatch(/Provider Keys \(BYOK\)/);
    expect(message).toMatch(/Unified Billing/);
    expect(message).toContain('minimax');
  });

  test('a 401 that survives the refresh retry → reconnect Cloudflare', async () => {
    const message = await failWith({ errors: [{ code: 10000, message: 'Authentication error' }] }, 401);
    expect(message).toMatch(/reconnect Cloudflare/i);
  });
});

describe('my-gateway registry precedence', () => {
  test('workers-ai and dynamic catalog ids stay authoritative for their own specs', async () => {
    const wire: string[] = [];

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub(),
      fetch: asFetchFunction(async (input: RequestInfo | URL) => {
        wire.push(requestUrl(input));

        return chatCompletionResponse('@cf/moonshotai/kimi-k2.6');
      }),
    });

    // `workers-ai/...` resolves through the bespoke workers-ai provider —
    // same /ai/v1 endpoint, no my-gateway involvement.
    await generateText({ model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', 'kinu-test'), prompt: 'ping' });
    expect(wire).toEqual([`${AI_BASE_URL}/chat/completions`]);
    expect(reg.registry.get('my-gateway')).toBeDefined();
    expect(reg.registry.canResolve('my-gateway')).toBe(true);
  });
});

describe('Cloudflare AI Gateway discovery helpers', () => {
  test('cloudflareAccountAPIRoot recovers the account root from the /ai/v1 base URL', () => {
    expect(cloudflareAccountAPIRoot(AI_BASE_URL)).toBe(ACCOUNT_ROOT);
    expect(cloudflareAccountAPIRoot(`${AI_BASE_URL}/`)).toBe(ACCOUNT_ROOT);
    expect(cloudflareAccountAPIRoot('https://evil.example/accounts/x/ai/v1')).toBeNull();
    expect(cloudflareAccountAPIRoot('https://api.cloudflare.com/client/v4/accounts/x/other')).toBeNull();
  });

  test('fetchCloudflareAIGateways parses the management listing', async () => {
    const gateways = await fetchCloudflareAIGateways('abc123abc123abc1', 'tok', asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe(`${ACCOUNT_ROOT}/ai-gateway/gateways?per_page=50`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');

      return new Response(JSON.stringify({
        success: true,
        result: [
          { id: 'default', authentication: false, created_at: '2026-01-01T00:00:00Z' },
          { id: 'prod-gw', authentication: true },
          { id: 'bad id with spaces' },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }));

    expect(gateways).toEqual([
      { id: 'default', authenticated: false, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'prod-gw', authenticated: true, createdAt: null },
    ]);
  });

  test('a 403 listing failure tells the user to reconnect (missing aig.write)', async () => {
    await expect(fetchCloudflareAIGateways('abc123abc123abc1', 'old-scope-token', asFetchFunction(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
        status: 403, headers: { 'content-type': 'application/json' },
      })))).rejects.toThrow(/Reconnect Cloudflare/);
  });
});

describe('UserDO gateway credential derivation', () => {
  function oauthCredential(): OAuthCredential {
    return {
      kind: 'oauth',
      accessToken: 'cf-access',
      refreshToken: 'cf-refresh',
      metadata: {
        tokenType: 'bearer',
        accountId: 'aaa111aaa111aaa111aaa111aaa111aa',
        accountName: 'Personal',
      },
    };
  }

  /** The Cloudflare management listing answer, for whatever the UserDO asks. */
  function stubGatewayListing(gateways: Array<{ id: string; authentication: boolean }>): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      success: true,
      result: gateways.map((gateway) => ({ id: gateway.id, authentication: gateway.authentication })),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    return () => { globalThis.fetch = original; };
  }

  test('the derived cloudflare.ai-gateway view rides the stored cloudflare.oauth credential', async () => {
    // Two gateways, so login-time discovery selects nothing.
    const restore = stubGatewayListing([
      { id: 'gw-one', authentication: false },
      { id: 'gw-two', authentication: false },
    ]);

    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, oauthCredential());

      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_AI_GATEWAY_CRED_KEY)).toBeNull();

      await harness.userDO.selectAIGateway(owner, 'gw-one');
      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_AI_GATEWAY_CRED_KEY)).toMatchObject({
        Authorization: 'Bearer cf-access',
        'cf-aig-gateway-id': 'gw-one',
      });

      // The derived key can never be stored as a credential.
      await expect(harness.userDO.setCredential(owner, CLOUDFLARE_AI_GATEWAY_CRED_KEY, oauthCredential())).rejects.toThrow();

      // Workers AI keeps a gateway header: user selection first, env default second.
      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_OAUTH_CRED_KEY))
        .toMatchObject({ 'cf-aig-gateway-id': 'gw-one' });
      await harness.userDO.selectAIGateway(owner, null);
      // With no selection and no gateway named in the env, Cloudflare's own `default` gateway.
      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_OAUTH_CRED_KEY))
        .toMatchObject({ 'cf-aig-gateway-id': 'default' });
    } finally {
      harness.close();
      restore();
    }
  });

  test('login-time discovery auto-selects a sole gateway', async () => {
    const restore = stubGatewayListing([{ id: 'gw-solo', authentication: false }]);
    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      // setCredential(cloudflare.oauth) discovers and persists the only gateway inline.
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, oauthCredential());
      expect(await harness.userDO.listAIGateways(owner)).toMatchObject({
        connected: true,
        selectedId: 'gw-solo',
      });
      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_AI_GATEWAY_CRED_KEY))
        .toMatchObject({ 'cf-aig-gateway-id': 'gw-solo' });
    } finally {
      harness.close();
      restore();
    }
  });

  test('a login whose refresh fails is connected with the failure, never disconnected', async () => {
    const original = globalThis.fetch;
    // The issuer cannot be asked: every token refresh meets a 503.
    globalThis.fetch = asFetchFunction(async () => new Response('upstream unavailable', { status: 503 }));
    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, { ...oauthCredential(), expiresAt: Date.now() - 60_000 });

      expect(await harness.userDO.listAIGateways(owner)).toMatchObject({
        connected: true, gateways: [], error: expect.stringContaining('refreshing the Cloudflare credential'),
      });
    } finally {
      harness.close();
      globalThis.fetch = original;
    }
  });
});
