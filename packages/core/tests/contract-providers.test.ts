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
import { asFetchFunction } from '../src/providers/fetch-shim';
import { normalizeCodexResponsesRequest } from '../src/providers/codex';
import { generateText } from 'ai';
import * as v from 'valibot';
import {
  createOpenAIProvider, createOpenRouterProvider, createOpenAICompatProvider,
  createAnthropicProvider, createCodexProvider, createCodexOAuthClient,
  CodexOAuthTokenError,
  CODEX_CRED_KEY,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY,
  type ProviderDeps, type AuthResolution,
} from '../src/index';
import {
  createMockFetch, ANTHROPIC_MESSAGE_BODY, CHAT_COMPLETION_BODY, OPENAI_RESPONSES_BODY,
} from '@kinu.run/test-utils';

const CodexRequestBodySchema = v.object({
  instructions: v.optional(v.string()),
  store: v.optional(v.boolean()),
  input: v.optional(v.array(v.object({ role: v.optional(v.string()) }))),
});
const CodexStoredBodySchema = v.object({
  instructions: v.optional(v.string()),
  store: v.optional(v.boolean()),
  input: v.optional(v.unknown()),
});
const CodexFailureSurfaceSchema = v.object({
  message: v.optional(v.string()),
  responseBody: v.optional(v.string()),
});


function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));
  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

/**
 * Drive one completion through the SDK. The mock bodies are complete, so this
 * is awaited rather than absorbed: a provider that sends the right request and
 * then cannot read the answer back used to pass every assertion below.
 */
async function call(model: Parameters<typeof generateText>[0]['model']): Promise<void> {
  const { text } = await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
  expect(text).toBe('ok');
}

// ── OpenAI direct ──────────────────────────────────────────────────────

describe('OpenAI provider contract', () => {
  test('sends Authorization: Bearer <key> to api.openai.com', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test-key' } },
    }, mock.fetch);
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await call(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests[0].headers['authorization']).toBe('Bearer sk-test-key');
  });

  test('short-circuits 401 when no credential stored', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({}, mock.fetch);
    const provider = createOpenAIProvider();
    const model = provider.createModel('gpt-5.5', deps);
    // The 401 is the assertion, not an inconvenience: a provider that silently
    // returned an empty completion here would send an uncredentialed request
    // the moment the short-circuit regressed.
    await expect(call(model)).rejects.toThrow();
    expect(mock.requests.length).toBe(0);
  });

  test('routes model requests through the patient rate-limit fetch', async () => {
    let calls = 0;
    const fetchImpl = asFetchFunction(async () => {
      calls++;
      return calls === 1
        ? new Response('limited', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json(OPENAI_RESPONSES_BODY);
    });
    const deps = makeDeps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test-key' } },
    }, fetchImpl);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);

    await generateText({ model, prompt: 'hello', maxOutputTokens: 16, maxRetries: 0 });

    expect(calls).toBe(2);
  });
});

// ── OpenRouter ─────────────────────────────────────────────────────────

describe('OpenRouter provider contract', () => {
  test('sends Bearer + HTTP-Referer + X-Title to openrouter.ai/api/v1', async () => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: CHAT_COMPLETION_BODY } },
    ]);
    const deps = makeDeps({
      [OPENROUTER_CRED_KEY]: { headers: { Authorization: 'Bearer sk-or-test' } },
    }, mock.fetch);
    const provider = createOpenRouterProvider({
      refererURL: 'https://kinu.test',
      appTitle: 'Kinu-Contract-Test',
    });
    const model = provider.createModel('anthropic/claude-3.5-sonnet', deps);
    await call(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('openrouter.ai/api/v1');
    expect(req.headers['authorization']).toBe('Bearer sk-or-test');
    expect(req.headers['http-referer']).toBe('https://kinu.test');
    expect(req.headers['x-title']).toBe('Kinu-Contract-Test');
  });
});

// ── OpenAI-compatible ─────────────────────────────────────────────────

describe('OpenAI-compat provider contract', () => {
  test('rewrites placeholder URL to credential.baseURL', async () => {
    const mock = createMockFetch([
      { match: 'api.groq.com', respond: { status: 200, body: CHAT_COMPLETION_BODY } },
    ]);
    const deps = makeDeps({
      'openai-compat.default': {
        headers: { Authorization: 'Bearer gsk_test', 'X-Custom': 'value' },
        baseURL: 'https://api.groq.com/openai/v1',
      },
    }, mock.fetch);
    const provider = createOpenAICompatProvider();
    const model = provider.createModel('llama-3', deps);
    await call(model);

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
      { match: 'api.anthropic.com', respond: { status: 200, body: ANTHROPIC_MESSAGE_BODY } },
    ]);
    const deps = makeDeps({
      [ANTHROPIC_CRED_KEY]: {
        headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' },
      },
    }, mock.fetch);
    const provider = createAnthropicProvider();
    const model = provider.createModel('claude-opus-4-7', deps);
    await call(model);

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
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({
      [CODEX_CRED_KEY]: {
        headers: {
          Authorization: 'Bearer codex-token',
          'User-Agent': 'codex_cli_rs/0.0.0 (Kinu Agent)',
          originator: 'codex_cli_rs',
          'ChatGPT-Account-ID': 'acct-test-123',
        },
      },
    }, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await call(model);

    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.url).toContain('chatgpt.com/backend-api/codex');
    expect(req.headers['authorization']).toBe('Bearer codex-token');
    expect(req.headers['originator']).toBe('codex_cli_rs');
    expect(req.headers['chatgpt-account-id']).toBe('acct-test-123');
  });

  test('sends system instructions in the shape required by the Codex backend', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } },
    }, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await generateText({ model, system: 'You are concise.', prompt: 'hello', maxOutputTokens: 16 });

    expect(mock.requests.length).toBeGreaterThan(0);
    const body = v.parse(CodexRequestBodySchema, JSON.parse(String(mock.requests[0].body)));
    expect(body.instructions).toBe('You are concise.');
    expect(body.store).toBe(false);
    expect(body.input?.some((item) => item.role === 'developer' || item.role === 'system')).toBe(false);
  });

  test('opts out of storage even when instructions are already set', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com/backend-api/codex', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } },
    }, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await generateText({
      model, prompt: 'hello', maxOutputTokens: 16,
      providerOptions: { openai: { instructions: 'Stay sharp.', store: true } },
    });

    expect(mock.requests.length).toBeGreaterThan(0);
    const body = v.parse(CodexStoredBodySchema, JSON.parse(String(mock.requests[0].body)));
    expect(body.instructions).toBe('Stay sharp.');
    expect(body.store).toBe(false);
  });

  test('leaves a non-array input untouched while opting out of storage', () => {
    const out = normalizeCodexResponsesRequest({
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.5', instructions: 'Stay sharp.', store: true, input: 'hello' }),
    });

    expect(out).toBeDefined();
    const body = v.parse(CodexStoredBodySchema, JSON.parse(String(out?.body)));
    expect(body.instructions).toBe('Stay sharp.');
    expect(body.store).toBe(false);
    expect(body.input).toBe('hello');
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
            : { status: 200, body: OPENAI_RESPONSES_BODY };
        },
      },
    ]);
    deps.fetch = mock.fetch;
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await call(model);

    expect(forceRefreshSeen).toBe(true);
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests[1].headers['authorization']).toBe('Bearer refreshed');
  });

  test('a refresh the resolver refuses up front surfaces as the named remedy', async () => {
    // The local store's shape: its own proactive refresh hit invalid_grant and
    // it throws out of getAuth BEFORE any request exists. The user-visible
    // answer must be the reconnection remedy, not a raw thrown chain.
    let wireCalls = 0;
    const deps: ProviderDeps = {
      env: {},
      fetch: asFetchFunction(async () => {
        wireCalls += 1;
        return new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 });
      }),
      async getAuth(key) {
        if (key !== CODEX_CRED_KEY) return null;
        throw new CodexOAuthTokenError('invalid_grant', 'Codex token refresh failed: 400 invalid_grant');
      },
      async hasCredential() { return true; },
    };
    const model = createCodexProvider().createModel('gpt-5.5', deps);

    let failure = '';
    try {
      await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
    } catch (rejection) {
      const surface = v.safeParse(CodexFailureSurfaceSchema, rejection);
      failure = surface.success
        ? `${surface.output.message ?? ''}\n${surface.output.responseBody ?? ''}`
        : String(rejection);
    }
    expect(failure).toContain('Your ChatGPT login is no longer valid');
    expect(failure).toContain('kinu setup');
    // The opaque chain the resolver threw must not survive to the surface.
    expect(failure).not.toContain('Codex token refresh failed');
    expect(wireCalls).toBe(0);
  });

  test('a 401 that survives the forced refresh names the reconnection remedy', async () => {
    const deps = makeDeps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-dead' } },
    }, asFetchFunction(async () =>
      new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 })));
    const model = createCodexProvider().createModel('gpt-5.5', deps);
    let failure = '';
    try {
      await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
    } catch (rejection) {
      const surface = v.safeParse(CodexFailureSurfaceSchema, rejection);
      failure = surface.success
        ? `${surface.output.message ?? ''}\n${surface.output.responseBody ?? ''}`
        : String(rejection);
    }
    expect(failure).toContain('Your ChatGPT login is no longer valid');
    // The bare upstream word is what the owner was shown for the Cloudflare
    // credential; it must not survive here either.
    expect(failure).not.toMatch(/(^|\W)Unauthorized(\W|$)/);
  });

  test('returns 401 when no credential stored (no upstream call)', async () => {
    const mock = createMockFetch([
      { match: 'chatgpt.com', respond: { status: 200, body: OPENAI_RESPONSES_BODY } },
    ]);
    const deps = makeDeps({}, mock.fetch);
    const provider = createCodexProvider();
    const model = provider.createModel('gpt-5.5', deps);
    await expect(call(model)).rejects.toThrow();
    expect(mock.requests.length).toBe(0);
  });
});

// ── Codex OAuth client ────────────────────────────────────────────────

describe('Codex OAuth client', () => {
  test('a rejected refresh token surfaces as a typed invalid_grant error', async () => {
    const client = createCodexOAuthClient(asFetchFunction(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    try {
      await client.refresh('codex-refresh-revoked');
    } catch (err) {
      if (!(err instanceof CodexOAuthTokenError)) throw err;
      expect(err.oauthError).toBe('invalid_grant');
      // The message must never quote the credential it failed on.
      expect(err.message).not.toContain('codex-refresh-revoked');
      return;
    }
    throw new Error('expected CodexOAuthTokenError');
  });

  test('a transient refresh failure carries no OAuth code a caller could treat as terminal', async () => {
    const client = createCodexOAuthClient(asFetchFunction(async () =>
      new Response('upstream exploded', { status: 502 })));
    try {
      await client.refresh('codex-refresh');
    } catch (err) {
      if (!(err instanceof CodexOAuthTokenError)) throw err;
      expect(err.oauthError).toBe('unknown');
      return;
    }
    throw new Error('expected CodexOAuthTokenError');
  });
});

// ── Catalog caches keyed by credential ────────────────────────────────

describe('listModels cache invalidation on credential change', () => {
  interface SwappableDeps {
    deps: ProviderDeps;
    set: (key: string, auth: AuthResolution | null) => void;
  }

  function makeSwappableDeps(fetchFn: typeof fetch): SwappableDeps {
    const store = new Map<string, AuthResolution>();
    return {
      deps: {
        env: {},
        fetch: fetchFn,
        async getAuth(key) { return store.get(key) ?? null; },
        async hasCredential(key) { return store.has(key); },
      },
      set: (key, auth) => {
        if (auth) store.set(key, auth);
        else store.delete(key);
      },
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
