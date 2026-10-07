// The signed-in AI proxy (/api/user/ai/v1/*): local CLI agents use the user's Cloudflare AI without
// the Cloudflare token leaving the server. Auth: CLI bearer only (pta_ needs ai.proxy; no cookie path).
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { serveFamily } from './helpers/api';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CliRoutesEnv } from '../src/cli/routes';
import { aiProxyRoutes } from '../src/user/ai-proxy';
import { cliAccount, unreachableAssets, unreachableKv, unreachableNamespace } from './helpers/bindings';
import {
  asFetchFunction,
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from '@kinu.run/core';
import type { AccessTokenScope, AuthRequest, AuthResolution, UserCaller, WorkersAIRunOptions } from '@kinu.run/core';
import * as v from 'valibot';
import { requestUrl } from '@kinu.run/core';


const aiProxy = serveFamily(aiProxyRoutes);

const USER_ID = '0123456789abcdef0123456789abcdef';

const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

const AI_TOKEN = `pta_${USER_ID}_${'a'.repeat(44)}`;

const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;

function scopesFor(bearer: string): AccessTokenScope[] | null {
  if (bearer === AI_TOKEN) return ['ai.proxy'];

  if (bearer === READ_TOKEN) return ['workspace.read'];

  return null;
}

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

/** What a streamed turn really gets back from `Ai.run`, not a finished completion. */
const DIRECT_SSE = [
  'data: {"response":"ok"}\n\n',
  'data: {"response":"","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('');

function setupEnv(opts: {
  gatewayId?: string | null;
  token?: string;
  freshToken?: string;
  evalService?: boolean;
  directOutput?: JsonObject;
  directStream?: string;
  /** A model that will not stream: the adapter refuses it. */
  directRefusal?: JsonObject;
  /** The binding's raw refusal, status and headers included. */
  directFailure?: () => Response;
} = {}) {
  const gatewayId = opts.gatewayId === undefined ? 'my-gw' : opts.gatewayId;
  const token = opts.token ?? 'cf-user';

  const userDO = cliAccount({
    async verifyCliToken(_caller: UserCaller, bearer: string) {
      return {
        ok: bearer === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(_caller: UserCaller, bearer: string) {
      const scopes = scopesFor(bearer);

      if (!scopes) return { ok: false, error: 'invalid token' };

      return {
        ok: true,
        tokenHash: `${scopes.join('+')}-hash`,
        scopes,
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async getAuth(_caller: UserCaller, key: string, o?: AuthRequest): Promise<AuthResolution | null> {
      const bearer = o?.rejected === undefined ? token : (opts.freshToken ?? token);

      if (key === 'cloudflare.oauth') return { headers: { authorization: `Bearer ${bearer}` }, baseURL: AI_BASE_URL };

      if (key === 'cloudflare.ai-gateway') {
        return gatewayId ? { headers: { authorization: `Bearer ${bearer}`, 'cf-aig-gateway-id': gatewayId }, baseURL: AI_BASE_URL } : null;
      }

      return null;
    },
    async listCredentials(_caller: UserCaller) {
      return [{ key: 'cloudflare.oauth', kind: 'oauth' as const, createdAt: 0, updatedAt: 0 }];
    },
  });

  const directRuns: Array<{ model: string; inputs: JsonObject }> = [];
  const directOptions: Array<WorkersAIRunOptions | undefined> = [];

  const env: CliRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => userDO },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
    AUTH_KV: unreachableKv('AUTH_KV'),
    ASSETS: unreachableAssets(),
  };

  if (opts.evalService) {
    // The direct path calls only `run`; the gateway half is the same binding's `gateway`.
    env.WORKERS_AI_VIA_BINDING = 'on';

    env.AI = {
      gateway: () => ({ run: () => { throw new Error('AI.gateway: not reachable in this test'); } }),
      async run(model: string, inputs: JsonObject, options?: WorkersAIRunOptions) {
        directRuns.push({ model, inputs });
        directOptions.push(options);

        if (opts.directFailure) return opts.directFailure();

        if (inputs.stream !== true) {
          return opts.directOutput ?? {
            response: 'ok',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }

        if (opts.directRefusal) return opts.directRefusal;

        return new Response(opts.directStream ?? DIRECT_SSE, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
  }

  return { env, directRuns, directOptions };
}

function chatRequest(token: string | null, body: JsonValue, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');

  if (token) headers.set('authorization', `Bearer ${token}`);

  return new Request('https://kinu.example.com/api/user/ai/v1/chat/completions', {
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
      url: requestUrl(input),
      headers: new Headers(init?.headers),
      body: parseJsonObject(await new Request(input, init).text()),
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
    const res = await aiProxy(chatRequest(null, { model: '@cf/x/y', messages: [] }), env);
    expect(res?.status).toBe(401);
  });

  test('other /api/user routes stay outside the CLI handler', async () => {
    const { env } = setupEnv();
    const res = await aiProxy(new Request('https://kinu.example.com/api/user/profile'), env);
    expect(res).toBeNull();
  });

  test('pta_ tokens need the ai.proxy scope; ptc_ session tokens always pass', async () => {
    const { env } = setupEnv();
    captureUpstream(() => completionResponse('@cf/moonshotai/kimi-k2.6'));

    const denied = await aiProxy(chatRequest(READ_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(denied?.status).toBe(403);
    expect(v.parse(StringErrorSchema, await handled(denied).json()).error).toContain('ai.proxy');

    const scoped = await aiProxy(chatRequest(AI_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(scoped?.status).toBe(200);

    const session = await aiProxy(chatRequest(SESSION_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env);
    expect(session?.status).toBe(200);
  });
});

describe('AI proxy model → upstream selection', () => {
  test('@cf models ride the Workers AI credential to {account}/ai/v1', async () => {
    const { env } = setupEnv({ token: 'cf-user-token' });
    const captured = captureUpstream(() => completionResponse('@cf/moonshotai/kimi-k2.6'));

    const res = await aiProxy(chatRequest(SESSION_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
    }, { 'x-session-affinity': 'kinu-jarvis' }), env);

    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(captured[0].headers.get('authorization')).toBe('Bearer cf-user-token');
    expect(captured[0].headers.get('x-session-affinity')).toBe('kinu-jarvis');
    expect(captured[0].body.model).toBe('@cf/moonshotai/kimi-k2.6');
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // The proxied CLI bearer must never leak upstream.
    expect(captured[0].headers.get('authorization')).not.toContain(SESSION_TOKEN);
  });

  test('the eval identity streams over the direct Workers AI binding', async () => {
    const { env, directRuns, directOptions } = setupEnv({ evalService: true });

    const res = await aiProxy(chatRequest(AI_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }, { 'x-session-affinity': 'eval-run' }), env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/event-stream');
    const body = await res?.text();
    expect(body).toContain('"content":"ok"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"prompt_tokens":1');
    expect(body?.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // Usage is requested: an OpenAI-style stream reports it only on request.
    expect(directRuns).toEqual([{
      model: '@cf/moonshotai/kimi-k2.6',
      inputs: {
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        stream_options: { include_usage: true },
      },
    }]);
    // The raw answer keeps a refusal's status for the CLI's retry; the replica pin rides the binding's headers.
    expect(directOptions[0]?.returnRawResponse).toBe(true);
    expect(directOptions[0]?.extraHeaders).toEqual({ 'x-session-affinity': 'eval-run' });
  });

  test('a binding stream held open after [DONE] still ends', async () => {
    const encoder = new TextEncoder();

    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(DIRECT_SSE));
      },
    });

    const { env } = setupEnv({ evalService: true });

    if (env.AI === undefined) throw new Error('the binding fixture is missing');
    env.AI = { ...env.AI, run: async () => new Response(held, { headers: { 'content-type': 'text/event-stream' } }) };

    const res = await aiProxy(chatRequest(AI_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'ping' }], stream: true,
    }), env);

    expect((await handled(res).text()).trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('a native whole completion reaches the client as an OpenAI completion, tool calls included', async () => {
    const { env } = setupEnv({
      evalService: true,
      directOutput: {
        response: 'done',
        tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    });

    const res = await aiProxy(chatRequest(AI_TOKEN, { model: '@cf/meta/llama-4-scout-17b-16e-instruct', messages: [{ role: 'user', content: 'ping' }] }), env);

    const completion = v.parse(v.object({
      choices: v.tuple([v.object({
        message: v.object({ content: v.string(), tool_calls: v.array(v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) })) }),
        finish_reason: v.string(),
      })]),
      usage: v.object({ prompt_tokens: v.number() }),
    }), await handled(res).json());

    expect(completion.choices[0].message.content).toBe('done');
    expect(completion.choices[0].message.tool_calls[0]?.function).toEqual({ name: 'shell', arguments: '{"cmd":"ls"}' });
    expect(completion.choices[0].finish_reason).toBe('tool_calls');
    expect(completion.usage.prompt_tokens).toBe(3);
  });

  test('a tool-only assistant turn reaches the binding with string content', async () => {
    // KINU-085: the binding refuses `content: null` beside `tool_calls`, which the CLI's SDK sends.
    const { env, directRuns } = setupEnv({ evalService: true });

    await aiProxy(chatRequest(AI_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [
        { role: 'user', content: 'add' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: '2' },
      ],
    }), env);

    expect(v.parse(v.array(v.looseObject({ content: v.string() })), directRuns[0]?.inputs.messages)[1]?.content).toBe('');
  });

  test('a binding refusal keeps its status, its Retry-After and its own words, for the CLI\'s retry', async () => {
    const { env, directRuns } = setupEnv({
      evalService: true,
      directFailure: () => new Response(JSON.stringify({ errors: [{ code: 3040, message: 'Out of capacity' }] }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' },
      }),
    });

    const res = handled(await aiProxy(chatRequest(AI_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }), env));

    // No retry here: the caller's model stack owns it.
    expect(directRuns).toHaveLength(1);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(v.parse(MessageErrorSchema, await res.json()).error.message).toBe('3040: Out of capacity');
  });

  test('OpenAI-shaped binding chunks reach the client unchanged', async () => {
    const { env } = setupEnv({
      evalService: true,
      directStream: [
        'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,'
          + '"model":"@cf/moonshotai/kimi-k2.6","choices":[{"index":0,"delta":{"role":"assistant","content":"streamed"}}]}\n\n',
        'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,'
          + '"model":"@cf/moonshotai/kimi-k2.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
          + '"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    });

    const res = await aiProxy(chatRequest(AI_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }), env);

    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/event-stream');
    const body = await res?.text();
    expect(body).toContain('"content":"streamed"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"prompt_tokens":2');
    expect(body).toContain('data: [DONE]');
  });

  test('a binding that answers a whole completion refuses the streamed request', async () => {
    const { env } = setupEnv({
      evalService: true,
      directRefusal: {
        id: 'chatcmpl-direct',
        object: 'chat.completion',
        created: 1,
        model: '@cf/moonshotai/kimi-k2.6',
        choices: [{ index: 0, message: { role: 'assistant', content: 'never-replayed' }, finish_reason: 'stop' }],
      },
    });

    const res = await aiProxy(chatRequest(AI_TOKEN, {
      model: '@cf/moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }), env);

    // Told the model does not stream, not handed a finished answer dressed as a stream.
    expect(res?.status).toBe(502);
    const message = v.parse(MessageErrorSchema, await handled(res).json()).error.message;
    expect(message).toContain('did not stream');
    expect(message).not.toContain('never-replayed');
  });

  test('the REST route answers each request once, the caller\'s model stack retrying, and carries its cancel', async () => {
    const { env } = setupEnv({ token: 'cf-user-token' });
    const signals: Array<AbortSignal | null | undefined> = [];
    let sent = 0;

    globalThis.fetch = asFetchFunction(async (_input, init) => {
      sent++;
      signals.push(init?.signal);

      return new Response('limited', { status: 429, headers: { 'retry-after': '0' } });
    });

    for (const retries of [0, 1]) {
      sent = 0;
      const cancel = new AbortController();
      const request = chatRequest(SESSION_TOKEN, { model: '@cf/moonshotai/kimi-k2.6', messages: [] }, { 'x-kinu-retries': String(retries) });
      await aiProxy(new Request(request, { signal: cancel.signal }), env);

      expect(sent).toBe(1);
      cancel.abort();
      expect(signals.at(-1)?.aborted).toBe(true);
    }
  });

  test('{author}/{model} ids ride the AI Gateway credential with cf-aig-gateway-id', async () => {
    const { env } = setupEnv({ gatewayId: 'prod-gw', token: 'cf-user-token' });
    const captured = captureUpstream(() => completionResponse('openai/gpt-4.1'));

    const res = await aiProxy(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(200);
    expect(captured[0].url).toBe(`${AI_BASE_URL}/chat/completions`);
    expect(captured[0].headers.get('cf-aig-gateway-id')).toBe('prod-gw');
    expect(captured[0].body.model).toBe('openai/gpt-4.1');
  });

  test('a bare model id cannot be routed — 400 with the accepted shapes', async () => {
    const { env } = setupEnv();
    const res = await aiProxy(chatRequest(SESSION_TOKEN, { model: 'gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(400);
    expect(v.parse(MessageErrorSchema, await handled(res).json()).error.message).toContain('@cf/{model}');
  });

  test('a missing Cloudflare connection is an actionable 401, not an upstream call', async () => {
    const { env } = setupEnv({ gatewayId: null });
    const captured = captureUpstream(() => completionResponse('openai/gpt-4.1'));
    const res = await aiProxy(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
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

    const res = await aiProxy(chatRequest(SESSION_TOKEN, {
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

    const res = await aiProxy(chatRequest(SESSION_TOKEN, { model: 'openai/gpt-4.1', messages: [] }), env);
    expect(res?.status).toBe(200);
    expect(captured.map((c) => c.headers.get('authorization'))).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
  });

  test('gateway failures map to the same actionable my-gateway messages', async () => {
    const { env } = setupEnv({ gatewayId: 'my-gw' });
    captureUpstream(() => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 2021, message: 'Invalid User Credentials' }],
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    const res = await aiProxy(chatRequest(SESSION_TOKEN, { model: 'minimax/m3', messages: [] }), env);
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
      const url = requestUrl(input);

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
        return Response.json({ success: true, result: [{ id: 'pc-0', provider_slug: 'openai', alias: 'default' }] });
      }

      if (url.includes('/billing/credit-balance')) {
        return Response.json({ success: true, result: { balance: 0 } });
      }

      if (url.endsWith('/ai-gateway/gateways/byok-gw')) return Response.json({ success: true, result: { id: 'byok-gw' } });

      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await aiProxy(new Request('https://kinu.example.com/api/user/ai/v1/models', {
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

describe('the decision models through the proxy (/api/user/ai/run)', () => {
  /** Clef's answer shape (`providers/decision-model.ts`). */
  const ANSWER = { result: { answers: { corrected: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 12 } }, success: true };

  function runRequest(token: string | null, model: string): Request {
    const headers = new Headers({ 'content-type': 'application/json' });

    if (token) headers.set('authorization', `Bearer ${token}`);

    return new Request(`https://kinu.example.com/api/user/ai/run/${model}`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'clef', state: 's', questions: {} }),
    });
  }

  test('a signed-in CLI rates through the owner\'s Cloudflare login at /ai/run', async () => {
    const { env } = setupEnv({ token: 'cf-user-token' });
    const captured = captureUpstream(() => Response.json(ANSWER));

    const res = await aiProxy(runRequest(AI_TOKEN, '@cf/cloudflare/clef'), env);

    expect(res?.status).toBe(200);
    expect(parseJsonObject(await handled(res).text())).toEqual(ANSWER);
    expect(captured.map((seen) => [seen.url, seen.headers.get('authorization')]))
      .toEqual([[`${ACCOUNT_ROOT}/ai/run/@cf/cloudflare/clef`, 'Bearer cf-user-token']]);
  });

  test('refuses anonymous callers, and runs only the decision models', async () => {
    const { env } = setupEnv();
    const captured = captureUpstream(() => Response.json(ANSWER));

    expect((await aiProxy(runRequest(null, '@cf/cloudflare/clef'), env))?.status).toBe(401);
    expect((await aiProxy(runRequest(READ_TOKEN, '@cf/cloudflare/clef'), env))?.status).toBe(403);
    expect((await aiProxy(runRequest(AI_TOKEN, '@cf/moonshotai/kimi-k2.6'), env))?.status).toBe(404);
    expect(captured).toEqual([]);
  });
});
