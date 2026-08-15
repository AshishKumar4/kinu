// Behavior tests for the signed-in AI proxy (/api/user/ai/v1/*) — the route
// that lets LOCAL CLI agents run on the user's Cloudflare AI without any
// Cloudflare token leaving the server.
//
// Contract under test:
//   - auth: CLI bearer only (ptc_ session ok; pta_ needs ai.proxy; no cookie path)
//   - model → upstream selection: @cf/… rides cloudflare.oauth, {author}/{model}
//     rides the derived cloudflare.ai-gateway view (cf-aig-gateway-id header)
//   - streaming SSE passthrough, refresh-on-401 retry, my-gateway error mapping
//   - GET /models lists the proxy-served wire ids in OpenAI list shape
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';
import { asFetchFunction, parseJsonObject, type JsonObject, type JsonValue } from '@proteus/core';
import type { UserCaller } from '../src/user/workspace-capability.js';
import * as v from 'valibot';

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const AI_TOKEN = `pta_${USER_ID}_${'a'.repeat(44)}`;
const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;

const ACCOUNT_ROOT = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1';
const AI_BASE_URL = `${ACCOUNT_ROOT}/ai/v1`;
const StringErrorSchema = v.object({ error: v.string() });
const MessageErrorSchema = v.object({ error: v.object({ message: v.string() }) });
const ModelListSchema = v.object({
  object: v.string(),
  data: v.array(v.object({ id: v.string(), object: v.string(), owned_by: v.string() })),
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function setupEnv(opts: { gatewayId?: string | null; token?: string; freshToken?: string } = {}) {
  const gatewayId = opts.gatewayId === undefined ? 'my-gw' : opts.gatewayId;
  const token = opts.token ?? 'cf-user';
  const userDO = {
    async verifyCliToken(_caller: UserCaller, bearer: string) {
      return {
        ok: bearer === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(_caller: UserCaller, bearer: string) {
      const scopes = bearer === AI_TOKEN ? ['ai.proxy'] : bearer === READ_TOKEN ? ['workspace.read'] : null;
      if (!scopes) return { ok: false, error: 'invalid token' };
      return {
        ok: true,
        tokenHash: `${scopes.join('+')}-hash`,
        scopes,
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async getAuthHeaders(_caller: UserCaller, key: string, o?: { forceRefresh?: boolean }) {
      const bearer = o?.forceRefresh ? (opts.freshToken ?? token) : token;
      if (key === 'cloudflare.oauth') return { authorization: `Bearer ${bearer}` };
      if (key === 'cloudflare.ai-gateway') {
        return gatewayId ? { authorization: `Bearer ${bearer}`, 'cf-aig-gateway-id': gatewayId } : null;
      }
      return null;
    },
    async getCredentialBaseURL(_caller: UserCaller, key: string) {
      return (key === 'cloudflare.oauth' || key === 'cloudflare.ai-gateway') ? AI_BASE_URL : null;
    },
    async listCredentials(_caller: UserCaller) {
      return [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }];
    },
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: AI proxy tests reach only the constructed UserDO namespace and
  // credential key; every binding they access is present above.
  const env = partialEnv as Env;
  return { env };
}

function chatRequest(token: string | null, body: JsonValue, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('https://proteus.example.com/api/user/ai/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

interface CapturedUpstream { url: string; headers: Headers; body: JsonObject }

function captureUpstream(respond: (seen: CapturedUpstream) => Response): CapturedUpstream[] {
  const captured: CapturedUpstream[] = [];
  globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: CapturedUpstream = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: parseJsonObject(String(init?.body)),
    };
    captured.push(seen);
    return respond(seen);
  });
  return captured;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('AI proxy route did not handle the request');
  return response;
}

function completionResponse(model: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } });
}

describe('AI proxy auth gate', () => {
  test('requires a CLI bearer — no token is 401, never a cookie fallthrough', async () => {
    const { env } = setupEnv();
    const res = await handleCliRequest(chatRequest(null, { model: '@cf/x/y', messages: [] }), env);
    expect(res?.status).toBe(401);
  });

  test('other /api/user routes stay outside the CLI handler', async () => {
    const { env } = setupEnv();
    const res = await handleCliRequest(new Request('https://proteus.example.com/api/user/profile'), env);
    expect(res).toBeNull();
  });

  test('pta_ tokens need the ai.proxy scope; ptc_ session tokens always pass', async () => {
    const { env } = setupEnv();
    captureUpstream(() => completionResponse('@cf/moonshotai/kimi-k2.6'));

    const denied = await handleCliRequest(chatRequest(READ_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(denied?.status).toBe(403);
    expect(v.parse(StringErrorSchema, await handled(denied).json()).error).toContain('ai.proxy');

    const scoped = await handleCliRequest(chatRequest(AI_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(scoped?.status).toBe(200);

    const session = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(session?.status).toBe(200);
  });
});

describe('AI proxy model → upstream selection', () => {
  test('@cf models ride the Workers AI credential to {account}/ai/v1', async () => {
    const { env } = setupEnv({ token: 'cf-user-token' });
    const captured = captureUpstream(() => completionResponse('@cf/moonshotai/kimi-k2.6'));

    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
    }, { 'x-session-affinity': 'proteus-jarvis' }), env);

    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(captured[0].headers.get('authorization')).toBe('Bearer cf-user-token');
    expect(captured[0].headers.get('x-session-affinity')).toBe('proteus-jarvis');
    expect(captured[0].body.model).toBe('@cf/moonshotai/kimi-k2.6');
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // The proxied CLI bearer must never leak upstream.
    expect(captured[0].headers.get('authorization')).not.toContain(SESSION_TOKEN);
  });

  test('{author}/{model} ids ride the AI Gateway credential with cf-aig-gateway-id', async () => {
    const { env } = setupEnv({ gatewayId: 'prod-gw', token: 'cf-user-token' });
    const captured = captureUpstream(() => completionResponse('openai/gpt-4.1'));

    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(200);
    expect(captured[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(captured[0].headers.get('cf-aig-gateway-id')).toBe('prod-gw');
    expect(captured[0].body.model).toBe('openai/gpt-4.1');
  });

  test('a bare model id cannot be routed — 400 with the accepted shapes', async () => {
    const { env } = setupEnv();
    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: 'gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(400);
    expect(v.parse(MessageErrorSchema, await handled(res).json()).error.message).toContain('@cf/{model}');
  });

  test('a missing Cloudflare connection is an actionable 401, not an upstream call', async () => {
    const { env } = setupEnv({ gatewayId: null });
    const captured = captureUpstream(() => completionResponse('openai/gpt-4.1'));
    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(401);
    expect(v.parse(MessageErrorSchema, await handled(res).json()).error.message).toContain('select an AI Gateway');
    expect(captured).toHaveLength(0);
  });
});

describe('AI proxy streaming + refresh + error mapping', () => {
  test('SSE responses stream through untouched', async () => {
    const { env } = setupEnv();
    const chunk = (data: JsonValue) => `data: ${JSON.stringify(data)}\n\n`;
    captureUpstream(() => new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(chunk({ choices: [{ index: 0, delta: { content: 'hel' } }] })));
          controller.enqueue(enc.encode(chunk({ choices: [{ index: 0, delta: { content: 'lo' } }] })));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [],
      stream: true,
    }), env);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/event-stream');
    const text = await handled(res).text();
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain('data: [DONE]');
  });

  test('a mid-flight 401 forces one refresh and retries with the fresh token', async () => {
    const { env } = setupEnv({ token: 'cf-stale', freshToken: 'cf-fresh' });
    const captured = captureUpstream((seen) =>
      seen.headers.get('authorization') === 'Bearer cf-stale'
        ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'Invalid access token' }] }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
        : completionResponse('openai/gpt-4.1'));

    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(200);
    expect(captured.map((c) => c.headers.get('authorization'))).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
  });

  test('gateway failures map to the same actionable my-gateway messages', async () => {
    const { env } = setupEnv({ gatewayId: 'my-gw' });
    captureUpstream(() => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 2021, message: 'Invalid User Credentials' }],
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    const res = await handleCliRequest(chatRequest(SESSION_TOKEN, { model: 'minimax/m3', messages: [] }), env);
    expect(res?.status).toBe(400);
    const message = v.parse(MessageErrorSchema, await handled(res).json()).error.message;
    expect(message).toContain('AI Gateway "my-gw"');
    expect(message).toMatch(/Provider Keys \(BYOK\)/);
    expect(message).toContain('minimax');
  });
});

describe('AI proxy model listing', () => {
  test('GET /models lists the proxy-served wire ids in OpenAI list shape', async () => {
    const { env } = setupEnv({ gatewayId: 'byok-gw', token: `t-${Math.random()}` });
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://models.dev/')) {
        return Response.json({
          'cloudflare-workers-ai': {
            id: 'cloudflare-workers-ai', name: 'Workers AI', env: [],
            models: {
              '@cf/moonshotai/kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', tool_call: true, limit: { context: 262144 } },
            },
          },
          openai: {
            id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'],
            models: {
              'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1', tool_call: true, limit: { context: 1047576 } },
            },
          },
        });
      }
      if (url.includes('/provider_configs')) {
        return Response.json({ success: true, result: [{ id: 'pc-0', provider_slug: 'openai' }] });
      }
      if (url.includes('/billing/credit-balance')) {
        return Response.json({ success: true, result: { balance: 0 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await handleCliRequest(new Request('https://proteus.example.com/api/user/ai/v1/models', {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    }), env);
    expect(res?.status).toBe(200);
    const body = v.parse(ModelListSchema, await handled(res).json());
    expect(body.object).toBe('list');
    expect(body.data).toContainEqual({ id: '@cf/moonshotai/kimi-k2.6', object: 'model', owned_by: 'workers-ai' });
    expect(body.data).toContainEqual({ id: 'openai/gpt-4.1', object: 'model', owned_by: 'my-gateway' });
    // Every listed id is routable by POST /chat/completions as-is.
    for (const model of body.data) {
      expect(model.id.startsWith('@cf/') || model.id.includes('/')).toBe(true);
    }
  });
});
