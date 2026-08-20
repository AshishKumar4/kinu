// The PLATFORM gateway provider rides the Workers AI binding, not HTTPS
// (src/providers/gateway-binding-fetch.ts). What these tests defend:
//   - the AI SDK's request reaches the binding as the universal request the
//     gateway actually accepts (verified live: provider `workers-ai`, endpoint
//     `v1/chat/completions`, no auth header → 200 + an OpenAI-shaped completion)
//   - no auth header is ever forwarded — a supplied one overrides the binding's
//     in-account pre-authentication and the gateway answers 401 (also measured)
//   - the USER-billed providers stay on the credential path, so a user's model
//     spend cannot silently move onto the platform account
//   - unavailability is honest and specific, upstream of any request
import { describe, expect, test } from 'bun:test';
import { generateText, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  asFetchFunction,
  createGatewayBindingFetch,
  parseGatewayTarget,
  type GatewayTarget,
} from '@kinu/core';
import { createWorkersAIProvider } from '../src/providers/workers-ai';
import { createMyGatewayProvider } from '../src/providers/my-gateway';
import { createAIGatewayProvider, resolvePlatformGateway } from '../src/providers/ai-gateway';
import { platformGatewayEnv, stubAiBinding, TEST_GATEWAY_URL } from './helpers/platform-gateway';

const providerDeps = (env: Parameters<typeof resolvePlatformGateway>[0]) => ({
  env,
  getAuth: async () => null,
  hasCredential: async () => false,
});

/** The target every transport test posts through, parsed the way the provider
 *  parses it — not hand-built, so a parser change cannot pass unnoticed. */
function testTarget(): GatewayTarget {
  const target = parseGatewayTarget(TEST_GATEWAY_URL);
  if ('reason' in target) throw new Error(`fixture URL should parse: ${target.reason}`);
  return target;
}

const completion = {
  id: 'id-1', object: 'chat.completion', created: 1, model: '@cf/test/model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'BINDING' } }],
  usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, neurons: 6.2 },
};

describe('parseGatewayTarget', () => {
  test('splits a gateway URL into the gateway id and the prefix requests sit under', () => {
    expect(parseGatewayTarget(TEST_GATEWAY_URL)).toEqual({
      id: 'test-gateway',
      origin: 'https://gateway.ai.cloudflare.com',
      prefix: '/v1/testaccount0000000000000000000/test-gateway/',
    });
  });

  test('a non-gateway URL reports why rather than reporting absence', () => {
    // A sentinel `undefined` here would make "not configured" and "configured
    // wrong" indistinguishable, which is how a misconfigured deploy goes quiet.
    expect(parseGatewayTarget('https://gw')).toEqual({
      reason: 'AI_GATEWAY_URL is not an AI Gateway URL (expected '
        + '{origin}/v1/{account}/{gateway}/{provider}/...), got "https://gw".',
    });
    expect(parseGatewayTarget(undefined)).toEqual({ reason: 'AI_GATEWAY_URL var missing.' });
    expect(parseGatewayTarget('not a url')).toMatchObject({ reason: expect.stringContaining('is not a URL') });
  });

  test('a gateway URL missing its account or gateway segment is rejected', () => {
    for (const url of [
      'https://gateway.ai.cloudflare.com/v1',
      'https://gateway.ai.cloudflare.com/v1/acct',
      'https://gateway.ai.cloudflare.com/v2/acct/gw/workers-ai/v1',
    ]) {
      expect(parseGatewayTarget(url)).toHaveProperty('reason');
    }
  });
});

describe('gateway binding transport', () => {
  test('an AI SDK chat call arrives as the universal request the gateway accepts', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const model = createOpenAICompatible({
      name: 'ai-gateway',
      baseURL: TEST_GATEWAY_URL,
      fetch: createGatewayBindingFetch({ binding: stub.binding, target: testTarget() }),
    }).chatModel('@cf/test/model');

    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('BINDING');
    expect(stub.runs).toHaveLength(1);
    const run = stub.runs[0]!;
    expect(run.gateway).toBe('test-gateway');
    expect(run.provider).toBe('workers-ai');
    expect(run.endpoint).toBe('v1/chat/completions');
    expect(run.query).toMatchObject({ model: '@cf/test/model' });
  });

  test('a streamed call arrives as one universal request and the SSE body survives', async () => {
    const sse = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"BIND"}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ING"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const stub = stubAiBinding(() => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const model = createOpenAICompatible({
      name: 'ai-gateway',
      baseURL: TEST_GATEWAY_URL,
      fetch: createGatewayBindingFetch({ binding: stub.binding, target: testTarget() }),
    }).chatModel('@cf/test/model');

    let text = '';
    for await (const delta of (await streamText({ model, prompt: 'hi' })).textStream) text += delta;

    expect(text).toBe('BINDING');
    expect(stub.runs).toHaveLength(1);
    expect(stub.runs[0]!.query).toMatchObject({ stream: true });
  });

  test('auth headers are never forwarded — a forwarded one would answer 401', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    await transport(`${TEST_GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer platform-api-token',
        'CF-AIG-Authorization': 'Bearer gateway-token',
        'cf-aig-cache-ttl': '3600',
      },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });

    const headers = stub.runs[0]!.headers;
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cf-aig-authorization');
    // Gateway control headers that are NOT credentials must still get through.
    expect(headers['cf-aig-cache-ttl']).toBe('3600');
    expect(headers['content-type']).toBe('application/json');
    // Derived headers the binding would re-send wrongly.
    expect(headers).not.toHaveProperty('content-length');
  });

  test('a Request input is read the same way as an init pair', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    await transport(new Request(`${TEST_GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }));

    expect(stub.runs[0]!.endpoint).toBe('v1/chat/completions');
    expect(stub.runs[0]!.query).toMatchObject({ model: 'm' });
    expect(stub.runs[0]!.headers).not.toHaveProperty('authorization');
  });

  test('a query string stays on the endpoint, as the wire would have carried it', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    await transport(`${TEST_GATEWAY_URL}/chat/completions?beta=1`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });

    expect(stub.runs[0]!.endpoint).toBe('v1/chat/completions?beta=1');
  });

  test('an abort signal reaches the binding so a cancelled turn stops upstream work', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });
    const controller = new AbortController();

    await transport(`${TEST_GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
      signal: controller.signal,
    });

    expect(stub.runs[0]!.signal).toBe(controller.signal);
  });

  test('a provider error comes back as the response, not as a thrown transport fault', async () => {
    const stub = stubAiBinding(() => Response.json(
      { name: 'AiGatewayError', internalCode: 2008, message: 'Invalid provider' },
      { status: 400 },
    ));
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    const res = await transport(`${TEST_GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ internalCode: 2008 });
  });

  // Silently forwarding an out-of-prefix URL is the failure that matters: it
  // would send this gateway's traffic — and any header on it — to another host.
  test.each([
    ['another gateway in another account', `https://gateway.ai.cloudflare.com/v1/other/other-gw/workers-ai/v1/chat/completions`, 'POST'],
    ['another origin entirely', 'https://evil.example/v1/testaccount0000000000000000000/test-gateway/workers-ai/v1/chat/completions', 'POST'],
    ['a non-POST method', `${TEST_GATEWAY_URL}/chat/completions`, 'GET'],
  ])('refuses %s rather than forwarding it', async (_case, url, method) => {
    const stub = stubAiBinding();
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    await expect(transport(url, { method, body: '{}' }))
      .rejects.toThrow(/ai-gateway binding transport cannot serve/);
    expect(stub.runs).toHaveLength(0);
  });

  test('refuses a path with no provider/endpoint split', async () => {
    const stub = stubAiBinding();
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });

    await expect(transport(
      'https://gateway.ai.cloudflare.com/v1/testaccount0000000000000000000/test-gateway/workers-ai',
      { method: 'POST', body: '{}' },
    )).rejects.toThrow(/no provider\/endpoint in the path/);
    expect(stub.runs).toHaveLength(0);
  });

  test('refuses a body the universal request cannot carry', async () => {
    const stub = stubAiBinding();
    const transport = createGatewayBindingFetch({ binding: stub.binding, target: testTarget() });
    const post = `${TEST_GATEWAY_URL}/chat/completions`;

    await expect(transport(post, { method: 'POST' })).rejects.toThrow(/no request body/);
    await expect(transport(post, { method: 'POST', body: 'not json' }))
      .rejects.toThrow(/non-JSON request body/);
    expect(stub.runs).toHaveLength(0);
  });
});

describe('platform gateway availability', () => {
  test('both halves are required and each missing half names itself', async () => {
    const provider = createAIGatewayProvider();
    const binding = stubAiBinding().binding;

    expect(await provider.isAvailable(providerDeps(platformGatewayEnv()))).toBe(true);
    expect(await provider.unavailableReason?.(providerDeps(platformGatewayEnv()))).toBeUndefined();

    expect(await provider.isAvailable(providerDeps({ AI_GATEWAY_URL: TEST_GATEWAY_URL }))).toBe(false);
    expect(await provider.unavailableReason?.(providerDeps({ AI_GATEWAY_URL: TEST_GATEWAY_URL })))
      .toMatch(/Workers AI binding \(env\.AI\) missing/);

    expect(await provider.isAvailable(providerDeps({ AI: binding }))).toBe(false);
    expect(await provider.unavailableReason?.(providerDeps({ AI: binding })))
      .toBe('AI_GATEWAY_URL var missing.');
  });

  test('createModel refuses an env isAvailable would have rejected', () => {
    const provider = createAIGatewayProvider();
    expect(() => provider.createModel('@cf/test/model', providerDeps({ AI_GATEWAY_URL: TEST_GATEWAY_URL })))
      .toThrow(/ai-gateway unavailable: Workers AI binding/);
  });

  test('an available env builds a model whose requests reach the binding', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const provider = createAIGatewayProvider();
    const model = provider.createModel('@cf/test/model', providerDeps(platformGatewayEnv(stub)));

    const result = await generateText({ model, prompt: 'hi' });

    expect(result.text).toBe('BINDING');
    expect(stub.runs).toHaveLength(1);
    expect(stub.runs[0]!.headers).not.toHaveProperty('authorization');
  });
});

// The billing property this whole design turns on. The platform gateway is
// in-account, so a binding call bills us and that is correct. workers-ai and
// my-gateway carry the logged-in user's Cloudflare OAuth credential precisely so
// their usage bills the USER; routing either over the binding would move every
// user's model spend onto the platform account without any visible change.
describe('user-billed providers stay off the platform binding', () => {
  const userAuth = {
    headers: { authorization: 'Bearer user-oauth-token' },
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/user-acct/ai/v1',
  };

  test('a bound binding is not enough to make them use it — they demand a credential', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const env = platformGatewayEnv(stub);

    for (const provider of [createWorkersAIProvider(), createMyGatewayProvider()]) {
      const model = provider.createModel('@cf/test/model', {
        env, getAuth: async () => null, hasCredential: async () => false,
      });
      // No user credential ⇒ the credential path answers 401. It must NOT take a
      // free ride on the platform binding sitting right there in the same env.
      await expect(generateText({ model, prompt: 'hi' })).rejects.toThrow();
      expect(stub.runs).toHaveLength(0);
    }
  });

  test('they bill the user: each request carries the user credential to the user account', async () => {
    const stub = stubAiBinding(() => Response.json(completion));
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const deps = {
      env: platformGatewayEnv(stub),
      getAuth: async () => userAuth,
      hasCredential: async () => true,
      fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
        return Response.json(completion);
      }),
    };

    for (const provider of [createWorkersAIProvider(), createMyGatewayProvider()]) {
      await generateText({ model: provider.createModel('@cf/test/model', deps), prompt: 'hi' });
    }

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url).toStartWith(userAuth.baseURL);
      expect(call.authorization).toBe('Bearer user-oauth-token');
    }
    // The platform binding was available the whole time and was never called.
    expect(stub.runs).toHaveLength(0);
  });
});
