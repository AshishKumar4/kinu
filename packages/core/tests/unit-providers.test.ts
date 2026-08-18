import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { asFetchFunction } from '../src/providers/fetch-shim';
import {
  parseModelSpec,
  createProviderRegistry,
  createOpenAICompatProvider,
  createCodexProvider,
  DEFAULT_WORKERS_AI_MODEL_ID,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  CODEX_CRED_KEY,
  type ModelProvider, type ProviderDeps, type AuthResolution,
} from '../src/index';

/** Tiny in-memory auth fixture for tests. */
function createTestAuth(store: Map<string, AuthResolution> = new Map()): Pick<ProviderDeps, 'getAuth' | 'hasCredential'> {
  return {
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

describe('parseModelSpec', () => {
  test('uses DeepSeek V4 Pro as the one canonical Workers AI default', () => {
    expect(DEFAULT_WORKERS_AI_MODEL_ID).toBe('@cf/deepseek-ai/deepseek-v4-pro-0813');
    expect(DEFAULT_WORKERS_AI_MODEL_SPEC).toBe('workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813');
  });

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
});

describe('ProviderRegistry', () => {
  function fakeProvider(id: string, modelId: string, available: boolean): ModelProvider {
    const model = new MockLanguageModelV3({ provider: id, modelId });
    return {
      id,
      defaultModel: modelId,
      isAvailable: () => available,
      listModels: () => [{ id: modelId }],
      createModel: () => model,
    };
  }

  const baseDeps = (): ProviderDeps => ({ env: {}, ...createTestAuth() });

  test('register + resolve', () => {
    const r = createProviderRegistry();
    r.register(fakeProvider('alpha', 'm1', true));
    const model = r.resolve('alpha/m1', baseDeps());
    expect(model).toBeInstanceOf(MockLanguageModelV3);
    expect(model).toHaveProperty('provider', 'alpha');
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

  /** The regression this suite exists for: a connected provider whose token
   *  refresh (or endpoint) is broken used to reject the whole listing, so ONE
   *  failure emptied the model picker for every other provider. */
  describe('one broken provider never empties the menu', () => {
    function throwingProvider(
      id: string,
      where: 'isAvailable' | 'listModels',
      defaultModel?: string,
    ): ModelProvider {
      const model = new MockLanguageModelV3({ provider: id });
      return {
        id,
        label: `${id} label`,
        defaultModel,
        isAvailable: () => {
          if (where === 'isAvailable') throw new Error(`${id} credential is revoked`);
          return true;
        },
        listModels: () => { throw new Error(`${id} credential is revoked`); },
        createModel: () => model,
      };
    }

    for (const where of ['isAvailable', 'listModels'] as const) {
      test(`listAllModels keeps healthy providers when ${where} throws`, async () => {
        const r = createProviderRegistry();
        r.register(fakeProvider('alpha', 'a', true));
        r.register(throwingProvider('codex', where));
        r.register(fakeProvider('gamma', 'g', true));

        const { models, failures } = await r.listAllModels(baseDeps());
        expect(models.map((m) => m.provider)).toEqual(['alpha', 'gamma']);
        expect(failures).toEqual([
          { provider: 'codex', label: 'codex label', reason: 'codex credential is revoked' },
        ]);
      });
    }

    test('listProviders reports the thrown reason instead of rejecting', async () => {
      const r = createProviderRegistry();
      r.register(fakeProvider('alpha', 'a', true));
      r.register(throwingProvider('codex', 'isAvailable'));

      const list = await r.listProviders(baseDeps());
      expect(list).toEqual([
        { id: 'alpha', label: undefined, available: true },
        { id: 'codex', label: 'codex label', available: false, unavailableReason: 'codex credential is revoked' },
      ]);
    });

    test('defaultSpec skips a throwing provider instead of leaving the agent modelless', async () => {
      const r = createProviderRegistry();
      // No static defaultModel, so defaultSpec must reach the throwing
      // listModels to find one — the path that used to reject.
      r.register(throwingProvider('codex', 'listModels'));
      r.register(fakeProvider('beta', 'b-default', true));
      expect(await r.defaultSpec(baseDeps())).toBe('beta/b-default');
    });

    test('a dynamic source that cannot enumerate still leaves the static providers listed', async () => {
      const r = createProviderRegistry();
      r.register(fakeProvider('alpha', 'a', true));
      r.registerDynamic({
        get: () => undefined,
        listIds: () => { throw new Error('models.dev returned HTTP 503'); },
      });

      const { models, failures } = await r.listAllModels(baseDeps());
      expect(models.map((m) => m.provider)).toEqual(['alpha']);
      expect(failures).toEqual([
        { provider: 'catalog', label: 'models.dev catalog', reason: 'models.dev returned HTTP 503' },
      ]);
      expect(await r.defaultSpec(baseDeps())).toBe('alpha/a');
    });
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

  test('discovers models from the standard OpenAI-compatible endpoint', async () => {
    const store = new Map<string, AuthResolution>([[
      'openai-compat.default',
      { headers: { Authorization: 'Bearer local' }, baseURL: 'http://127.0.0.1:4111/v1' },
    ]]);
    const provider = createOpenAICompatProvider();
    const models = await provider.listModels({
      env: {},
      ...createTestAuth(store),
      fetch: asFetchFunction(async (input, init) => {
        expect(String(input)).toBe('http://127.0.0.1:4111/v1/models');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local');
        return Response.json({
          object: 'list',
          data: [
            { id: 'model-a', name: 'Model A', context_window: 131072 },
            { id: 'model-b' },
            { name: 'missing-id' },
          ],
        });
      }),
    });
    expect(models).toEqual([
      { id: 'model-a', label: 'Model A', contextWindow: 131072 },
      { id: 'model-b', label: 'model-b' },
    ]);
  });

  test('keeps model discovery optional for endpoints without /models', async () => {
    const store = new Map<string, AuthResolution>([[
      'openai-compat.default',
      { headers: {}, baseURL: 'http://127.0.0.1:4111/v1' },
    ]]);
    const provider = createOpenAICompatProvider();
    const models = await provider.listModels({
      env: {},
      ...createTestAuth(store),
      fetch: asFetchFunction(async () => new Response('not found', { status: 404 })),
    });
    expect(models).toEqual([]);
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
