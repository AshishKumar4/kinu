// Behavior tests for the local half of the general provider proxy: a provider
// the owner connected in the web UI is usable from this machine with no key on
// disk, and a local key still wins.
import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import type { LLMProviderConfig } from '@proteus/core';
import { createLocalModelResolver } from '../src/model-resolver.js';

const ORIGIN = 'https://proteus.example.com';
const LLM: LLMProviderConfig = {
  name: 'openai-compat',
  baseURL: 'https://unused.example/v1',
  headers: {},
  model: 'unused',
};

const MODELS_DEV = {
  openrouter: { id: 'openrouter', name: 'OpenRouter', npm: '@ai-sdk/openai-compatible', api: 'https://openrouter.ai/api/v1', models: {} },
  groq: {
    id: 'groq', name: 'Groq', npm: '@ai-sdk/groq',
    models: { 'llama-3.3-70b': { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', tool_call: true, limit: { context: 131_072 } } },
  },
};

interface Recorded { url: string; headers: Headers; body: string }

function completion(content: string, promptTokens: number): Response {
  return Response.json({
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
  });
}

/** A fetch standing in for the whole network: the Proteus worker's credential
 *  listing and forward route (which dispatches on the target header exactly as
 *  the real route does), models.dev, and the providers themselves. */
function networkFetch(opts: {
  credentials?: Array<{ key: string; baseURL?: string }>;
  credentialsStatus?: number;
  recorded?: Recorded[];
}): typeof fetch {
  const credentials = opts.credentials ?? [];

  const upstream = (url: string, proxied: boolean): Response => {
    if (url.startsWith('https://models.dev/')) return Response.json(MODELS_DEV);
    if (url.startsWith('https://openrouter.ai/api/v1/models')) {
      return Response.json({ data: [{ id: 'anthropic/claude-x', name: 'Claude X', context_length: 200_000 }] });
    }
    if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
      return completion(proxied ? 'proxied' : 'direct', proxied ? 11 : 1);
    }
    return new Response(`unexpected ${url}`, { status: 500 });
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    opts.recorded?.push({ url, headers, body: String(init?.body ?? '') });

    if (url === `${ORIGIN}/api/user/ai/proxy/credentials`) {
      if (opts.credentialsStatus) return new Response('nope', { status: opts.credentialsStatus });
      return Response.json({ credentials });
    }
    if (url === `${ORIGIN}/api/user/ai/proxy/forward`) {
      return upstream(headers.get('x-proteus-proxy-target') ?? '', true);
    }
    return upstream(url, false);
  }) as unknown as typeof fetch;
}

function resolverWith(fetchImpl: typeof fetch, credentials?: Parameters<typeof createLocalModelResolver>[0]['credentials']) {
  return createLocalModelResolver({
    llm: LLM,
    ...(credentials ? { credentials } : {}),
    cloud: { origin: ORIGIN, token: 'ptc_test' },
    fetch: fetchImpl,
  });
}

describe('web-UI-connected providers reach local agents', () => {
  test('a connected provider appears in the local model menu with no local key', async () => {
    const resolver = resolverWith(networkFetch({
      credentials: [{ key: 'openrouter.bearer' }, { key: 'groq.bearer' }],
    }));

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'openrouter')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'groq')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'anthropic')?.available).toBe(false);

    const menu = await resolver.listModels();
    expect(menu.models.some((m) => m.provider === 'openrouter' && m.id === 'anthropic/claude-x')).toBe(true);
    expect(menu.models.some((m) => m.provider === 'groq' && m.id === 'llama-3.3-70b')).toBe(true);
  });

  test('a connected catalog provider becomes a routable spec prefix', async () => {
    const resolver = resolverWith(networkFetch({ credentials: [{ key: 'groq.bearer' }] }));
    // Cold, the first segment is still read as part of a slashful model id.
    expect(resolver.normalizeSpecSync('groq/llama-3.3-70b')).toBe('openai-compat/groq/llama-3.3-70b');
    await resolver.listProviders();
    expect(resolver.normalizeSpecSync('groq/llama-3.3-70b')).toBe('groq/llama-3.3-70b');
  });

  test('the request is relocated to the worker and no secret is needed locally', async () => {
    const recorded: Recorded[] = [];
    const resolver = resolverWith(networkFetch({ credentials: [{ key: 'openrouter.bearer' }], recorded }));

    const result = await generateText({
      model: resolver.resolveModel('openrouter/anthropic/claude-x'),
      prompt: 'hello',
    });

    expect(result.text).toBe('proxied');
    const forwarded = recorded.find((r) => r.url.endsWith('/api/user/ai/proxy/forward'));
    expect(forwarded).toBeDefined();
    expect(forwarded?.headers.get('x-proteus-proxy-cred')).toBe('openrouter.bearer');
    expect(forwarded?.headers.get('x-proteus-proxy-target')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(forwarded?.headers.get('authorization')).toBe('Bearer ptc_test');
    // Usage arrives verbatim, so per-step accounting is unaffected by proxying.
    expect(result.usage.inputTokens).toBe(11);
  });

  test('a local key overrides the proxy — the machine keeps working on its own terms', async () => {
    const recorded: Recorded[] = [];
    const resolver = resolverWith(
      networkFetch({ credentials: [{ key: 'openrouter.bearer' }], recorded }),
      { openrouterApiKey: 'sk-local' },
    );

    const result = await generateText({ model: resolver.resolveModel('openrouter/anthropic/claude-x'), prompt: 'hello' });

    expect(result.text).toBe('direct');
    expect(recorded.some((r) => r.url.endsWith('/api/user/ai/proxy/forward'))).toBe(false);
    expect(recorded.find((r) => r.url.startsWith('https://openrouter.ai/api/v1/chat'))?.headers.get('authorization'))
      .toBe('Bearer sk-local');
  });

  test('an unreachable account degrades to "unavailable: reason", never a blank list', async () => {
    const resolver = resolverWith(networkFetch({ credentialsStatus: 503 }));

    const providers = await resolver.listProviders();
    const openrouter = providers.find((p) => p.id === 'openrouter');
    expect(openrouter?.available).toBe(false);
    expect(openrouter?.unavailableReason).toContain('Proteus account');

    const menu = await resolver.listModels();
    expect(menu.failures.some((f) => f.provider === 'openrouter' && f.reason.includes('Proteus account'))).toBe(true);
    // The signed-out placeholders and every other provider are still there.
    expect(providers.length).toBeGreaterThan(3);
  });

  test('signed out, nothing is proxied and no credential listing is attempted', async () => {
    const recorded: Recorded[] = [];
    const resolver = createLocalModelResolver({ llm: LLM, fetch: networkFetch({ recorded }) });
    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'openrouter')?.available).toBe(false);
    expect(recorded.some((r) => r.url.includes('/api/user/ai/proxy/'))).toBe(false);
  });
});

describe('what an unreachable account does and does not claim', () => {
  test('a provider the proxy would never front reports its own honest reason', async () => {
    // Codex is proxy-denied (its endpoint refuses Worker egress), so a missing
    // local credential is the whole answer — not "we could not check".
    const resolver = resolverWith(networkFetch({ credentialsStatus: 503 }));
    const codex = (await resolver.listProviders()).find((p) => p.id === 'codex');
    expect(codex?.available).toBe(false);
    expect(codex?.unavailableReason).not.toContain('Proteus account');
  });
});
