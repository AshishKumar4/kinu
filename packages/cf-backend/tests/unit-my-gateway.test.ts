// Behavior tests for the my-gateway provider — the USER'S own Cloudflare AI
// Gateway driven with the user's Cloudflare OAuth credential.
//
// Wire contract under test (AI Gateway REST API):
//   POST {account}/ai/v1/chat/completions
//   Authorization: Bearer <user token> + cf-aig-gateway-id: <selected gateway>
// plus discovery (gateway BYOK provider_configs + credit balance → model menu),
// availability gating (credential usable AND gateway selected), the
// refresh-on-401 retry, and actionable error mapping for the documented
// gateway failures (2008 invalid provider / 2021 invalid user credentials).
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { asFetchFunction, parseJsonObject, type JsonValue } from '@kinu.run/core';
import {
  CLOUDFLARE_AI_GATEWAY_CRED_KEY,
  cloudflareAccountAPIRoot,
  fetchCloudflareAIGateways,
} from '../src/lib/cloudflare-oauth';

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
    getAuthHeaders: async (key: string, o?: { forceRefresh?: boolean }) => {
      if (key === 'cloudflare.oauth') return { authorization: `Bearer ${opts.token ?? 'cf-user'}` };
      if (key !== CLOUDFLARE_AI_GATEWAY_CRED_KEY) return null;
      return headersFor(o?.forceRefresh ? (opts.freshToken ?? opts.token ?? 'cf-user') : (opts.token ?? 'cf-user'));
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

describe('my-gateway request shape', () => {
  test('routes through the account /ai/v1 endpoint with bearer + cf-aig-gateway-id', async () => {
    const seen: Array<{ url: string; auth: string | null; gateway: string | null; model: unknown }> = [];
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'prod-gw', token: 'cf-user-token' }),
      fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const body = parseJsonObject(String(init?.body));
        seen.push({
          url: String(input),
          auth: headers.get('authorization'),
          gateway: headers.get('cf-aig-gateway-id'),
          model: body.model,
        });
        return chatCompletionResponse('openai/gpt-4.1');
      }),
    });

    const result = await generateText({
      model: reg.resolveModel('my-gateway/openai/gpt-4.1'),
      prompt: 'ping',
    });
    expect(result.text).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(seen[0].auth).toBe('Bearer cf-user-token');
    expect(seen[0].gateway).toBe('prod-gw');
    // The spec's modelId after the provider prefix IS the wire author/model id.
    expect(seen[0].model).toBe('openai/gpt-4.1');
  });

  test('a mid-flight 401 forces one refresh and retries with the fresh token', async () => {
    const wire: Array<string | null> = [];
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ token: 'cf-stale', freshToken: 'cf-fresh' }),
      fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        wire.push(headers.get('authorization'));
        if (headers.get('authorization') === 'Bearer cf-stale') {
          return new Response(JSON.stringify({ errors: [{ code: 10000, message: 'Invalid access token' }] }), {
            status: 401, headers: { 'content-type': 'application/json' },
          });
        }
        return chatCompletionResponse('anthropic/claude-sonnet-4-5');
      }),
    });

    const result = await generateText({
      model: reg.resolveModel('my-gateway/anthropic/claude-sonnet-4-5'),
      prompt: 'ping',
    });
    expect(result.text).toBe('ok');
    expect(wire).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
  });
});

describe('my-gateway availability gating', () => {
  test('unavailable until a gateway is selected; available once it is', async () => {
    const noGateway = createAgentProviderRegistry({ env: {}, userDO: gatewayStub({ gatewayId: null }) });
    expect(await noGateway.registry.get('my-gateway')!.isAvailable(noGateway.deps)).toBe(false);

    const selected = createAgentProviderRegistry({ env: {}, userDO: gatewayStub() });
    expect(await selected.registry.get('my-gateway')!.isAvailable(selected.deps)).toBe(true);
  });

  test('without a usable Cloudflare credential the provider drops out', async () => {
    const dead = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [],
      getCredentialBaseURL: async () => null,
    });
    const reg = createAgentProviderRegistry({ env: {}, userDO: dead });
    expect(await reg.registry.get('my-gateway')!.isAvailable(reg.deps)).toBe(false);
    expect(await reg.registry.get('my-gateway')!.unavailableReason!(reg.deps)).toMatch(/select an AI Gateway/i);
  });
});

describe('my-gateway model discovery', () => {
  const modelsDevBody = JSON.stringify({
    openai: {
      id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], npm: '@ai-sdk/openai',
      models: {
        'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1', tool_call: true, limit: { context: 1047576 } },
      },
    },
    google: {
      id: 'google', name: 'Google', env: ['GEMINI_API_KEY'], npm: '@ai-sdk/google',
      models: {
        'gemini-2.5-pro': { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tool_call: true, reasoning: true, limit: { context: 1048576 } },
      },
    },
    anthropic: {
      id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], npm: '@ai-sdk/anthropic',
      models: {
        'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tool_call: true, limit: { context: 200000 } },
      },
    },
  });

  function discoveryFetch(opts: {
    slugs: string[];
    balance?: number | 'denied';
    onRequest?: (url: string) => void;
  }): typeof fetch {
    return asFetchFunction(async (input: RequestInfo | URL) => {
      const url = String(input);
      opts.onRequest?.(url);
      if (url.startsWith('https://models.dev/')) {
        return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/provider_configs')) {
        return new Response(JSON.stringify({
          success: true,
          result: opts.slugs.map((slug, i) => ({ id: `pc-${i}`, provider_slug: slug, alias: 'default', default_config: true })),
        }), { headers: { 'content-type': 'application/json' } });
      }
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

  test('lists models for the gateway BYOK providers, ids prefixed with the wire author', async () => {
    const urls: string[] = [];
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'byok-gw', token: `t-${Math.random()}` }),
      fetch: discoveryFetch({ slugs: ['openai', 'google-ai-studio', 'workers-ai'], onRequest: (u) => urls.push(u) }),
    });
    const models = await reg.registry.get('my-gateway')!.listModels(reg.deps);
    const ids = models.map((m) => m.id).sort();
    // google-ai-studio (gateway slug) → google (wire author + models.dev id);
    // the workers-ai slug is the bespoke workers-ai provider's territory.
    expect(ids).toEqual(['google/gemini-2.5-pro', 'openai/gpt-4.1']);
    expect(models.find((m) => m.id === 'openai/gpt-4.1')?.contextWindow).toBe(1047576);
    expect(urls.some((u) => u.includes('/ai-gateway/gateways/byok-gw/provider_configs'))).toBe(true);
  });

  test('positive Unified Billing balance adds the billable provider set', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'credits-gw', token: `t-${Math.random()}` }),
      fetch: discoveryFetch({ slugs: [], balance: 12.5 }),
    });
    const models = await reg.registry.get('my-gateway')!.listModels(reg.deps);
    const ids = models.map((m) => m.id);
    // Curated unified-billing set ∩ what models.dev knows in this fixture.
    expect(ids).toContain('openai/gpt-4.1');
    expect(ids).toContain('anthropic/claude-sonnet-4-5');
    expect(ids).toContain('google/gemini-2.5-pro');
  });

  test('denied management reads narrow the menu to empty instead of throwing', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'old-scope-gw', token: `t-${Math.random()}` }),
      fetch: asFetchFunction(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://models.dev/')) {
          return new Response(modelsDevBody, { headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }),
    });
    expect(await reg.registry.get('my-gateway')!.listModels(reg.deps)).toEqual([]);
  });
});

describe('my-gateway error mapping', () => {
  async function failWith(body: JsonValue, status = 400): Promise<string> {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: gatewayStub({ gatewayId: 'my-gw' }),
      fetch: asFetchFunction(async () => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      })),
    });
    try {
      await generateText({ model: reg.resolveModel('my-gateway/minimax/m3'), prompt: 'ping' });
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
        wire.push(String(input));
        return chatCompletionResponse('@cf/moonshotai/kimi-k2.6');
      }),
    });
    // `workers-ai/...` resolves through the bespoke workers-ai provider —
    // same /ai/v1 endpoint, no my-gateway involvement.
    await generateText({ model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'), prompt: 'ping' });
    expect(wire).toEqual([`${AI_BASE_URL}/chat/completions`]);
    // …and my-gateway is a static provider, so the dynamic models.dev source
    // is never consulted for its id.
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
      expect(String(input)).toBe(`${ACCOUNT_ROOT}/ai-gateway/gateways?per_page=50`);
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

describe('UserDO gateway selection wiring', () => {
  const userDO = readFileSync(join(import.meta.dir, '..', 'src/user/user-do.ts'), 'utf8');

  test('the derived cloudflare.ai-gateway view rides the stored cloudflare.oauth credential', () => {
    expect(userDO).toContain("key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key");
    // No selected gateway → null headers → my-gateway honestly unavailable.
    expect(userDO).toMatch(/if \(key === CLOUDFLARE_AI_GATEWAY_CRED_KEY\) \{\s*\n\s*const gatewayId = this\.selectedAIGatewayId\(\);\s*\n\s*if \(!gatewayId\) return null;/);
    // Workers AI keeps a gateway header: user selection first, env default second.
    expect(userDO).toContain("this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.env)");
    // The derived key can never be stored as a credential.
    expect(userDO).toContain('is derived from your Cloudflare login');
  });

  test('login-time discovery auto-selects a sole gateway', () => {
    // setCredential(cloudflare.oauth) triggers discovery…
    expect(userDO).toContain('if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(await ownerCaller(this.env));');
    // …and listAIGateways persists the only gateway as the selection.
    expect(userDO).toMatch(/if \(!selectedId && gateways\.length === 1\) \{\s*\n\s*await this\.selectAIGateway\(await ownerCaller\(this\.env\), gateways\[0\]\.id\);/);
  });
});
