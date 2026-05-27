import { describe, test, expect } from 'bun:test';
import {
  parseModelSpec, formatModelSpec,
  createProviderRegistry,
  createInMemoryCredentialStore,
  createOpenAICompatProvider,
  createCodexProvider, decodeChatGPTAccountId, accessTokenExpiring,
  CODEX_CRED_KEY,
  type ModelProvider, type ProviderDeps,
} from '../src/index.ts';

describe('parseModelSpec', () => {
  test('splits on first slash so workers-ai/@cf/... survives', () => {
    const s = parseModelSpec('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(s.provider).toBe('workers-ai');
    expect(s.modelId).toBe('@cf/moonshotai/kimi-k2.6');
  });

  test('handles simple provider/modelId', () => {
    expect(parseModelSpec('codex/gpt-5.5')).toEqual({ provider: 'codex', modelId: 'gpt-5.5' });
  });

  test('rejects empty/no-slash', () => {
    expect(() => parseModelSpec('')).toThrow('Empty model spec');
    expect(() => parseModelSpec('gpt-5.5')).toThrow('Invalid model spec');
    expect(() => parseModelSpec('/foo')).toThrow('Invalid model spec');
  });

  test('formatModelSpec is a roundtrip of parseModelSpec', () => {
    const original = 'openrouter/anthropic/claude-3.5-sonnet';
    expect(formatModelSpec(parseModelSpec(original))).toBe(original);
  });
});

describe('ProviderRegistry', () => {
  function fakeProvider(id: string, modelId: string, available: boolean): ModelProvider {
    return {
      id,
      defaultModel: modelId,
      isAvailable: () => available,
      listModels: () => [{ id: modelId }],
      createModel: () => ({ specificationVersion: 'v2', provider: id, modelId } as never),
    };
  }

  test('register + resolve', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'm1', true));
    const deps: ProviderDeps = { env: {}, credentials: createInMemoryCredentialStore() };
    const model = r.resolve('alpha/m1', deps);
    expect((model as { provider?: string }).provider).toBe('alpha');
  });

  test('resolve throws on unknown provider', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'm1', true));
    const deps: ProviderDeps = { env: {}, credentials: createInMemoryCredentialStore() };
    expect(() => r.resolve('beta/m', deps)).toThrow('Unknown provider');
  });

  test('defaultSpec picks first available provider', async () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a-default', false));
    r.register(fakeProvider('beta', 'b-default', true));
    r.register(fakeProvider('gamma', 'g-default', true));
    const deps: ProviderDeps = { env: {}, credentials: createInMemoryCredentialStore() };
    expect(await r.defaultSpec(deps)).toBe('beta/b-default');
  });

  test('listProviders returns availability info for all', async () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a', true));
    r.register(fakeProvider('beta', 'b', false));
    const deps: ProviderDeps = { env: {}, credentials: createInMemoryCredentialStore() };
    const list = await r.listProviders(deps);
    expect(list.map(p => [p.id, p.available])).toEqual([['alpha', true], ['beta', false]]);
  });

  test('register rejects duplicate ids', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a', true));
    expect(() => r.register(fakeProvider('alpha', 'a2', true))).toThrow('already registered');
  });
});

describe('Codex provider — JWT helpers', () => {
  // Build a JWT-shaped token: <header>.<base64url(claims)>.<sig>
  function makeJwt(claims: object): string {
    const b64 = (s: string) => Buffer.from(s).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${b64(JSON.stringify(claims))}.sig`;
  }

  test('decodeChatGPTAccountId returns the claim from a valid JWT', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-abc123' },
    });
    expect(decodeChatGPTAccountId(token)).toBe('acct-abc123');
  });

  test('decodeChatGPTAccountId returns null on missing claim', () => {
    expect(decodeChatGPTAccountId(makeJwt({}))).toBeNull();
  });

  test('decodeChatGPTAccountId returns null on malformed token', () => {
    expect(decodeChatGPTAccountId('not-a-jwt')).toBeNull();
    expect(decodeChatGPTAccountId('')).toBeNull();
  });

  test('accessTokenExpiring is true within skew', () => {
    const exp = Math.floor(Date.now() / 1000) + 30; // 30s away
    expect(accessTokenExpiring(makeJwt({ exp }), 60)).toBe(true);
  });

  test('accessTokenExpiring is false outside skew', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1h away
    expect(accessTokenExpiring(makeJwt({ exp }), 60)).toBe(false);
  });

  test('accessTokenExpiring is true on undecodable token', () => {
    expect(accessTokenExpiring('garbage')).toBe(true);
  });
});

describe('OpenAI-compat provider — base URL rewriting via customFetch', () => {
  test('isAvailable when credential stored', async () => {
    const credentials = createInMemoryCredentialStore();
    const provider = createOpenAICompatProvider();
    expect(await provider.isAvailable({ env: {}, credentials })).toBe(false);

    await credentials.set('openai-compat', {
      kind: 'openai-compat',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test',
    });
    expect(await provider.isAvailable({ env: {}, credentials })).toBe(true);
  });
});

describe('Codex provider — registry integration', () => {
  test('isAvailable false when no credential stored', async () => {
    const credentials = createInMemoryCredentialStore();
    const provider = createCodexProvider({ refresh: async () => { throw new Error('refresh not expected'); } });
    expect(await provider.isAvailable({ env: {}, credentials })).toBe(false);
  });

  test('isAvailable true when oauth credential stored', async () => {
    const credentials = createInMemoryCredentialStore();
    await credentials.set(CODEX_CRED_KEY, {
      kind: 'oauth',
      accessToken: 'fake.eyJleHAiOjk5OTk5OTk5OTl9.sig', // exp far in future
      refreshToken: 'refresh-token',
    });
    const provider = createCodexProvider({ refresh: async () => { throw new Error('refresh not expected'); } });
    expect(await provider.isAvailable({ env: {}, credentials })).toBe(true);
  });
});
