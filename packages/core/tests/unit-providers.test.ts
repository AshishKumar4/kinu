import { describe, test, expect } from 'bun:test';
import {
  parseModelSpec, formatModelSpec,
  createProviderRegistry,
  createOpenAICompatProvider,
  createCodexProvider,
  CODEX_CRED_KEY,
  type ModelProvider, type ProviderDeps, type AuthResolution,
} from '../src/index.ts';

/** Tiny in-memory auth fixture for tests. */
function createTestAuth(store: Map<string, AuthResolution> = new Map()): Pick<ProviderDeps, 'getAuth' | 'hasCredential'> {
  return {
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

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

  const baseDeps = (): ProviderDeps => ({ env: {}, ...createTestAuth() });

  test('register + resolve', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'm1', true));
    const model = r.resolve('alpha/m1', baseDeps());
    expect((model as { provider?: string }).provider).toBe('alpha');
  });

  test('resolve throws on unknown provider', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'm1', true));
    expect(() => r.resolve('beta/m', baseDeps())).toThrow('Unknown provider');
  });

  test('defaultSpec picks first available provider', async () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a-default', false));
    r.register(fakeProvider('beta', 'b-default', true));
    r.register(fakeProvider('gamma', 'g-default', true));
    expect(await r.defaultSpec(baseDeps())).toBe('beta/b-default');
  });

  test('listProviders returns availability info for all', async () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a', true));
    r.register(fakeProvider('beta', 'b', false));
    const list = await r.listProviders(baseDeps());
    expect(list.map(p => [p.id, p.available])).toEqual([['alpha', true], ['beta', false]]);
  });

  test('register rejects duplicate ids', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'a', true));
    expect(() => r.register(fakeProvider('alpha', 'a2', true))).toThrow('already registered');
  });
});

describe('OpenAI-compat provider', () => {
  test('isAvailable reflects credential presence via hasCredential', async () => {
    const store = new Map<string, AuthResolution>();
    const deps: ProviderDeps = { env: {}, ...createTestAuth(store) };
    const provider = createOpenAICompatProvider();
    expect(await provider.isAvailable(deps)).toBe(false);

    store.set('openai-compat.default', {
      headers: { Authorization: 'Bearer gsk_test' },
      baseURL: 'https://api.groq.com/openai/v1',
    });
    expect(await provider.isAvailable(deps)).toBe(true);
  });
});

describe('Codex provider', () => {
  test('isAvailable false when no credential stored', async () => {
    const provider = createCodexProvider();
    expect(await provider.isAvailable({ env: {}, ...createTestAuth() })).toBe(false);
  });

  test('isAvailable true when codex.oauth credential exists', async () => {
    const store = new Map<string, AuthResolution>([[CODEX_CRED_KEY, { headers: { Authorization: 'Bearer fake' } }]]);
    const provider = createCodexProvider();
    expect(await provider.isAvailable({ env: {}, ...createTestAuth(store) })).toBe(true);
  });
});
