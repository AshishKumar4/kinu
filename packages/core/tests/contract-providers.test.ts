// Provider contract tests — verify each provider sends the right HTTP shape.
//
// What we assert per provider:
//   1. URL (base path + endpoint)
//   2. Auth header (Authorization: Bearer vs x-api-key)
//   3. Special headers (originator/User-Agent/X-Title/anthropic-version/etc.)
//   4. Custom fetch handles 401 → refresh → retry (Codex only)
//
// Strategy: build the provider's LanguageModel with a mocked fetch (via
// @proteus/test-utils createMockFetch), call generateText() through the AI
// SDK, inspect what was sent. The AI SDK's request shape is implementation
// detail of the SDK, so we only assert on the things THE PROVIDER controls
// (URL, headers, auth scheme) — not on the JSON body shape.
import { describe, test, expect } from 'bun:test';
import { generateText } from 'ai';
import {
  createOpenAIProvider, createOpenRouterProvider, createOpenAICompatProvider,
  createAnthropicProvider, createCodexProvider,
  CODEX_CRED_KEY, CODEX_USER_AGENT, CODEX_ORIGINATOR,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY, OPENAI_COMPAT_CRED_KEY,
  type ProviderDeps,
} from '../src/index.ts';
import {
  createMockFetch, createTestCredentials, freshOAuthCredential, expiredOAuthCredential,
} from '@proteus/test-utils';

// ── helpers ────────────────────────────────────────────────────────────

/** Drive an LLM call through the AI SDK without caring about the response
 *  text — only the request shape matters for contract tests. */
async function tryCall(model: Awaited<ReturnType<typeof generateText>> extends infer T
                              ? T extends { text: infer _ } ? Parameters<typeof generateText>[0]['model'] : never
                              : never): Promise<void> {
  try {
    await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
  } catch { /* response shape may be invalid for our minimal mocks — that's fine */ }
}

// ── OpenAI direct ──────────────────────────────────────────────────────

describe('OpenAI provider contract', () => {
  test('sends Authorization: Bearer <key> to api.openai.com', async () => {
    const credentials = createTestCredentials({
      [OPENAI_CRED_KEY]: { kind: 'bearer', token: 'sk-test-key' },
    });
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('api.openai.com');
    expect(req.headers['authorization']).toBe('Bearer sk-test-key');
  });

  test('responds 401 when no credential stored', async () => {
    const credentials = createTestCredentials({});
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: {} } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);
    // Request should never reach the upstream — customFetch short-circuits.
    expect(mock.requests.length).toBe(0);
  });
});

// ── OpenRouter ─────────────────────────────────────────────────────────

describe('OpenRouter provider contract', () => {
  test('sends Bearer + HTTP-Referer + X-Title to openrouter.ai/api/v1', async () => {
    const credentials = createTestCredentials({
      [OPENROUTER_CRED_KEY]: { kind: 'bearer', token: 'sk-or-test' },
    });
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { choices: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
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

  test('omits attribution headers when not configured', async () => {
    const credentials = createTestCredentials({
      [OPENROUTER_CRED_KEY]: { kind: 'bearer', token: 'sk-or' },
    });
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { choices: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createOpenRouterProvider();   // no opts
    const model = provider.createModel('x/y', deps);
    await tryCall(model);

    const req = mock.requests[0];
    expect(req.headers['http-referer']).toBeUndefined();
    expect(req.headers['x-title']).toBeUndefined();
  });
});

// ── OpenAI-compatible (BYO base URL) ──────────────────────────────────

describe('OpenAI-compat provider contract', () => {
  test('rewrites placeholder URL to credential.baseURL + applies extra headers', async () => {
    const credentials = createTestCredentials({
      [OPENAI_COMPAT_CRED_KEY]: {
        kind: 'openai-compat',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk_test',
        extraHeaders: { 'X-Custom': 'value' },
      },
    });
    const mock = createMockFetch([
      { match: 'api.groq.com', respond: { status: 200, body: { choices: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
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

  test('401 short-circuit when no credential stored', async () => {
    const credentials = createTestCredentials({});
    const mock = createMockFetch([
      { match: 'http', respond: { status: 200, body: {} } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createOpenAICompatProvider();
    const model = provider.createModel('x', deps);
    await tryCall(model);
    expect(mock.requests.length).toBe(0);
  });
});

// ── Anthropic direct ──────────────────────────────────────────────────

describe('Anthropic provider contract', () => {
  test('sends x-api-key + anthropic-version (NOT Authorization) to api.anthropic.com', async () => {
    const credentials = createTestCredentials({
      [ANTHROPIC_CRED_KEY]: { kind: 'bearer', token: 'sk-ant-test' },
    });
    const mock = createMockFetch([
      { match: 'api.anthropic.com', respond: { status: 200, body: { content: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createAnthropicProvider();
    const model = provider.createModel('claude-opus-4-7', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('api.anthropic.com');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBeDefined();
    // Anthropic auth is x-api-key, NOT Bearer — verify we don't leak the
    // real key into Authorization. The SDK may set a placeholder; check it
    // doesn't carry our credential value.
    if (req.headers['authorization']) {
      expect(req.headers['authorization']).not.toContain('sk-ant-test');
    }
  });
});

// ── Codex via ChatGPT subscription ────────────────────────────────────

describe('Codex provider contract', () => {
  test('sends Bearer + originator + User-Agent + ChatGPT-Account-ID to chatgpt.com/backend-api/codex', async () => {
    const credentials = createTestCredentials({
      [CODEX_CRED_KEY]: freshOAuthCredential({ accountId: 'acct-test-123' }),
    });
    const mock = createMockFetch([
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createCodexProvider({
      refresh: async () => { throw new Error('refresh should not be called on fresh token'); },
    });
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('chatgpt.com/backend-api/codex');
    expect(req.headers['authorization']).toMatch(/^Bearer /);
    expect(req.headers['user-agent']).toBe(CODEX_USER_AGENT);
    expect(req.headers['originator']).toBe(CODEX_ORIGINATOR);
    expect(req.headers['chatgpt-account-id']).toBe('acct-test-123');
  });

  test('refreshes expiring token before request', async () => {
    const credentials = createTestCredentials({
      [CODEX_CRED_KEY]: expiredOAuthCredential(),
    });
    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls++;
      return {
        accessToken: freshOAuthCredential().accessToken,
        refreshToken: 'rfsh-new',
        expiresAt: Date.now() + 3_600_000,
      };
    };
    const mock = createMockFetch([
      { match: 'chatgpt.com', respond: { status: 200, body: { id: 'r', output: [] } } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createCodexProvider({ refresh });
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    expect(refreshCalls).toBeGreaterThanOrEqual(1);
  });

  test('refreshes + retries on 401', async () => {
    const credentials = createTestCredentials({
      [CODEX_CRED_KEY]: freshOAuthCredential(),
    });
    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls++;
      return {
        accessToken: freshOAuthCredential().accessToken,
        refreshToken: 'rfsh-new',
        expiresAt: Date.now() + 3_600_000,
      };
    };
    // Mock: first call returns 401, second returns 200.
    let callCount = 0;
    const mock = createMockFetch([
      {
        match: 'chatgpt.com',
        respond: () => {
          callCount++;
          return callCount === 1
            ? { status: 401, body: { error: 'token expired' } }
            : { status: 200, body: { id: 'r', output: [] } };
        },
      },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createCodexProvider({ refresh });
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);

    // Should see at least 2 requests (initial + retry-after-refresh)
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
  });

  test('returns 401 when no credential stored (no upstream call)', async () => {
    const credentials = createTestCredentials({});
    const mock = createMockFetch([
      { match: 'chatgpt.com', respond: { status: 200, body: {} } },
    ]);
    const deps: ProviderDeps = { env: {}, credentials, fetch: mock.fetch };
    const provider = createCodexProvider({
      refresh: async () => { throw new Error('should not refresh without creds'); },
    });
    const model = provider.createModel('gpt-5.5', deps);
    await tryCall(model);
    expect(mock.requests.length).toBe(0);
  });
});
