// Provider contract tests — verify each provider sends the right HTTP shape.
//
// What we assert per provider:
//   1. URL (base path + endpoint)
//   2. Auth header (Authorization: Bearer vs x-api-key)
//   3. Special headers (originator/User-Agent/X-Title/anthropic-version/etc.)
//
// Strategy: build the provider's LanguageModel with a mocked fetch + an
// inline AuthResolver. Call generateText() through the AI SDK, inspect what
// was sent. The AI SDK's request shape is implementation detail of the SDK,
// so we only assert on the things THE PROVIDER controls (URL, headers,
// auth scheme).
import { describe, test, expect } from 'bun:test';
import { generateText } from 'ai';
import {
  createOpenAIProvider, createOpenRouterProvider, createOpenAICompatProvider,
  createAnthropicProvider, createCodexProvider,
  CODEX_CRED_KEY,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY,
  type ProviderDeps, type AuthResolution,
} from '../src/index.ts';
import { createMockFetch } from '@proteus/test-utils';

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));
  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

async function tryCall(model: Parameters<typeof generateText>[0]['model']): Promise<void> {
  try {
    await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
  } catch { /* response shape may be invalid for our minimal mocks — that's fine */ }
}

// ── OpenAI direct ──────────────────────────────────────────────────────

describe('OpenAI provider contract', () => {
  test('sends Authorization: Bearer <key> to api.openai.com', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps = makeDeps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test-key' } },
    }, mock.fetch);
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests[0].headers['authorization']).toBe('Bearer sk-test-key');
  });

  test('short-circuits 401 when no credential stored', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: {} } },
    ]);
    const deps = makeDeps({}, mock.fetch);
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);
    expect(mock.requests.length).toBe(0);
  });

  test('routes model requests through the patient rate-limit fetch', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? new Response('limited', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ id: 'r', output: [] });
    }) as typeof fetch;
    const deps = makeDeps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test-key' } },
    }, fetchImpl);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);

    try {
      await generateText({ model, prompt: 'hello', maxOutputTokens: 16, maxRetries: 0 });
    } catch { /* minimal success body may not parse; the fetch route is the assertion */ }

    expect(calls).toBe(2);
  });
});

// ── OpenRouter ─────────────────────────────────────────────────────────

describe('OpenRouter provider contract', () => {
  test('sends Bearer + HTTP-Referer + X-Title to openrouter.ai/api/v1', async () => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { choices: [] } } },
    ]);
    const deps = makeDeps({
      [OPENROUTER_CRED_KEY]: { headers: { Authorization: 'Bearer sk-or-test' } },
    }, mock.fetch);
    const provider = createOpenRouterProvider({
      refererURL: 'https://proteus.test',
      appTitle: 'Proteus-Contract-Test',
    });
    const model = provider.createModel('anthropic/claude-3.5-sonnet', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('openrouter.ai/api/v1');
    expect(req.headers['authorization']).toBe('Bearer sk-or-test');
    expect(req.headers['http-referer']).toBe('https://proteus.test');
    expect(req.headers['x-title']).toBe('Proteus-Contract-Test');
  });
});

// ── OpenAI-compatible ─────────────────────────────────────────────────

describe('OpenAI-compat provider contract', () => {
  test('rewrites placeholder URL to credential.baseURL', async () => {
    const mock = createMockFetch([
      { match: 'api.groq.com', respond: { status: 200, body: { choices: [] } } },
    ]);
    const deps = makeDeps({
      'openai-compat.default': {
        headers: { Authorization: 'Bearer gsk_test', 'X-Custom': 'value' },
        baseURL: 'https://api.groq.com/openai/v1',
      },
    }, mock.fetch);
    const provider = createOpenAICompatProvider();
    const model = provider.createModel('llama-3', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('api.groq.com/openai/v1');
    expect(req.url).not.toContain('openai-compat.invalid');
    expect(req.headers['authorization']).toBe('Bearer gsk_test');
    expect(req.headers['x-custom']).toBe('value');
  });
});

// ── Anthropic direct ──────────────────────────────────────────────────

describe('Anthropic provider contract', () => {
  test('sends x-api-key + anthropic-version to api.anthropic.com', async () => {
    const mock = createMockFetch([
      { match: 'api.anthropic.com', respond: { status: 200, body: { content: [] } } },
    ]);
    const deps = makeDeps({
      [ANTHROPIC_CRED_KEY]: {
        headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' },
      },
    }, mock.fetch);
    const provider = createAnthropicProvider();
    const model = provider.createModel('claude-opus-4-7', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('api.anthropic.com');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
  });
});

// ── Codex via ChatGPT subscription ────────────────────────────────────

describe('Codex provider contract', () => {
  test('attaches every WAF-bypass header returned by getAuth', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps = makeDeps({
      [CODEX_CRED_KEY]: {
        headers: {
          Authorization: 'Bearer codex-token',
          'User-Agent': 'codex_cli_rs/0.0.0 (Proteus Agent)',
          originator: 'codex_cli_rs',
          'ChatGPT-Account-ID': 'acct-test-123',
        },
      },
    }, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('chatgpt.com/backend-api/codex');
    expect(req.headers['authorization']).toBe('Bearer codex-token');
    expect(req.headers['originator']).toBe('codex_cli_rs');
    expect(req.headers['chatgpt-account-id']).toBe('acct-test-123');
  });

  test('sends system instructions in the shape required by the Codex backend', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps = makeDeps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } },
    }, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    try {
      await generateText({ model, system: 'You are concise.', prompt: 'hello', maxOutputTokens: 16 });
    } catch { /* minimal mock response may not satisfy the SDK parser */ }

    expect(mock.requests.length).toBeGreaterThan(0);
    const body = JSON.parse(String(mock.requests[0].body)) as { instructions?: string; store?: boolean; input?: Array<{ role?: string }> };
    expect(body.instructions).toBe('You are concise.');
    expect(body.store).toBe(false);
    expect(body.input?.some((item) => item.role === 'developer' || item.role === 'system')).toBe(false);
  });

  test('refreshes on 401 by calling getAuth with forceRefresh', async () => {
    let calls = 0;
    let forceRefreshSeen = false;
    const deps: ProviderDeps = {
      env: {},
      async getAuth(key, opts) {
        if (key !== CODEX_CRED_KEY) return null;
        if (opts?.forceRefresh) forceRefreshSeen = true;
        return { headers: { Authorization: opts?.forceRefresh ? 'Bearer refreshed' : 'Bearer stale' } };
      },
      async hasCredential() { return true; },
      fetch: undefined,
    };
    const mock = createMockFetch([
      {
        match: 'chatgpt.com',
        respond: () => {
          calls++;
          return calls === 1
            ? { status: 401, body: { error: 'token expired' } }
            : { status: 200, body: { id: 'r', output: [] } };
        },
      },
    ]);
    deps.fetch = mock.fetch;
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(forceRefreshSeen).toBe(true);
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests[1].headers['authorization']).toBe('Bearer refreshed');
  });

  test('returns 401 when no credential stored (no upstream call)', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com', respond: { status: 200, body: {} } },
    ]);
    const deps = makeDeps({}, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);
    expect(mock.requests.length).toBe(0);
  });
});

// ── Catalog caches keyed by credential ────────────────────────────────

describe('listModels cache invalidation on credential change', () => {
  function makeSwappableDeps(fetchFn: typeof fetch): { deps: ProviderDeps; set: (key: string, auth: AuthResolution | null) => void } {
    const store = new Map<string, AuthResolution>();
    return {
      deps: {
        env: {},
        fetch: fetchFn,
        async getAuth(key) { return store.get(key) ?? null; },
        async hasCredential(key) { return store.has(key); },
      },
      set: (key, auth) => { auth ? store.set(key, auth) : store.delete(key); },
    };
  }

  test('OpenRouter: swapping the API key refetches the catalog with the new key', async () => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { data: [{ id: 'meta/m1' }] } } },
    ]);
    const { deps, set } = makeSwappableDeps(mock.fetch);
    const provider = createOpenRouterProvider();

    set(OPENROUTER_CRED_KEY, { headers: { Authorization: 'Bearer key-A' } });
    await provider.listModels(deps);
    await provider.listModels(deps); // cache hit — same credential
    expect(mock.requests.length).toBe(1);

    set(OPENROUTER_CRED_KEY, { headers: { Authorization: 'Bearer key-B' } });
    await provider.listModels(deps);
    expect(mock.requests.length).toBe(2);
    expect(mock.requests[1].headers['authorization']).toBe('Bearer key-B');
  });

  test('OpenRouter: removing the credential clears the catalog instead of serving the cache', async () => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { data: [{ id: 'meta/m1' }] } } },
    ]);
    const { deps, set } = makeSwappableDeps(mock.fetch);
    const provider = createOpenRouterProvider();

    set(OPENROUTER_CRED_KEY, { headers: { Authorization: 'Bearer key-A' } });
    expect((await provider.listModels(deps)).length).toBe(1);

    set(OPENROUTER_CRED_KEY, null);
    expect(await provider.listModels(deps)).toEqual([]);
  });

  test('Codex: swapping the ChatGPT account refetches the model catalog', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com', respond: { status: 200, body: { models: [{ slug: 'gpt-5.5', visibility: 'list' }] } } },
    ]);
    const { deps, set } = makeSwappableDeps(mock.fetch);
    const provider = createCodexProvider();

    set(CODEX_CRED_KEY, { headers: { Authorization: 'Bearer acct-A' } });
    await provider.listModels(deps);
    await provider.listModels(deps); // cache hit — same credential
    expect(mock.requests.length).toBe(1);

    set(CODEX_CRED_KEY, { headers: { Authorization: 'Bearer acct-B' } });
    await provider.listModels(deps);
    expect(mock.requests.length).toBe(2);
    expect(mock.requests[1].headers['authorization']).toBe('Bearer acct-B');
  });
});
