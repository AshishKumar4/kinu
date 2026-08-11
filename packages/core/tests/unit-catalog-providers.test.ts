// models.dev catalog widening — any catalog provider with a stored
// `<id>.bearer` key resolves through the openai-compat wire path, while
// bespoke (statically registered) providers stay authoritative for their ids.
import { describe, test, expect } from 'bun:test';
import { generateText } from 'ai';
import {
  createProviderRegistry,
  createModelsDevCatalogSource,
  catalogCredKey,
  getModelsDevProvider,
  listModelsDevProviders,
  modelsDevCompatBaseURL,
  type ProviderDeps, type AuthResolution, type ModelProvider,
} from '../src/index.ts';
import { createMockFetch } from '@proteus/test-utils';

const CATALOG = {
  groq: {
    id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models',
    env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible',
    api: 'https://api.groq.com/openai/v1',
    models: {
      'llama-3.3-70b-versatile': {
        id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tool_call: true,
        limit: { context: 131072 }, modalities: { input: ['text'] },
      },
      'no-tools-model': { id: 'no-tools-model', name: 'No Tools', tool_call: false },
    },
  },
  // models.dev lists openai too — the bespoke static provider must win for it.
  openai: {
    id: 'openai', name: 'OpenAI', doc: 'https://platform.openai.com/docs/models',
    env: ['OPENAI_API_KEY'], npm: '@ai-sdk/openai',
    api: 'https://api.openai.com/v1',
    models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', tool_call: true } },
  },
  // Bespoke-SDK provider with no API endpoint and no known compat endpoint
  // — not key-satisfiable.
  'sap-ai-core': {
    id: 'sap-ai-core', name: 'SAP AI Core', doc: 'https://help.sap.com',
    env: ['SAP_AI_CORE_KEY'], npm: '@jerome-benoit/sap-ai-provider-v2',
    models: { 'sap-model': { id: 'sap-model', name: 'SAP Model', tool_call: true } },
  },
  // Bespoke-SDK provider with no `api` but a documented OpenAI-compatible
  // endpoint pinned in the supplement.
  mistral: {
    id: 'mistral', name: 'Mistral', doc: 'https://docs.mistral.ai',
    env: ['MISTRAL_API_KEY'], npm: '@ai-sdk/mistral',
    models: { 'mistral-large': { id: 'mistral-large', name: 'Mistral Large', tool_call: true } },
  },
  // Account-templated endpoint — not satisfiable with a key alone.
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI',
    env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY'], npm: '@ai-sdk/openai-compatible',
    api: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    models: { 'some-model': { id: 'some-model', tool_call: true } },
  },
};

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));
  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
    async listCredentialKeys() { return [...store.keys()]; },
  };
}

function catalogMock(extraHandlers: Parameters<typeof createMockFetch>[0] = []) {
  return createMockFetch([
    { match: 'models.dev/api.json', respond: { status: 200, body: CATALOG } },
    ...extraHandlers,
  ]);
}

function staticProvider(id: string, modelId: string): ModelProvider {
  return {
    id,
    defaultModel: modelId,
    isAvailable: () => true,
    listModels: () => [{ id: modelId, label: `${id} static` }],
    createModel: () => ({ specificationVersion: 'v2', provider: `static-${id}`, modelId } as never),
  };
}

async function tryCall(model: Parameters<typeof generateText>[0]['model']): Promise<void> {
  try {
    await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
  } catch { /* minimal mock bodies may not parse — we assert on requests */ }
}

describe('models.dev provider metadata', () => {
  test('getModelsDevProvider returns id/name/doc/env/npm/api', async () => {
    const mock = catalogMock();
    const info = await getModelsDevProvider('groq', { fetch: mock.fetch });
    expect(info).toEqual({
      id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models',
      env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible',
      api: 'https://api.groq.com/openai/v1',
    });
    expect(await getModelsDevProvider('nope', { fetch: mock.fetch })).toBeNull();
  });

  test('listModelsDevProviders returns every catalog provider', async () => {
    const mock = catalogMock();
    const ids = (await listModelsDevProviders({ fetch: mock.fetch })).map((p) => p.id).sort();
    expect(ids).toEqual(['cloudflare-workers-ai', 'groq', 'mistral', 'openai', 'sap-ai-core']);
  });

  test('modelsDevCompatBaseURL — key-satisfiable OpenAI-surface endpoints only', async () => {
    const mock = catalogMock();
    const byId = new Map((await listModelsDevProviders({ fetch: mock.fetch })).map((p) => [p.id, p]));
    expect(modelsDevCompatBaseURL(byId.get('groq')!)).toBe('https://api.groq.com/openai/v1');
    expect(modelsDevCompatBaseURL(byId.get('openai')!)).toBe('https://api.openai.com/v1');
    // bespoke SDK + no api, but a pinned OpenAI-compatible endpoint exists
    expect(modelsDevCompatBaseURL(byId.get('mistral')!)).toBe('https://api.mistral.ai/v1');
    expect(modelsDevCompatBaseURL(byId.get('sap-ai-core')!)).toBeNull();           // bespoke SDK, no endpoint
    expect(modelsDevCompatBaseURL(byId.get('cloudflare-workers-ai')!)).toBeNull(); // ${…} template
  });
});

describe('models.dev dynamic catalog source', () => {
  test('listIds = stored .bearer keys ∩ key-satisfiable catalog providers', async () => {
    const mock = catalogMock();
    const source = createModelsDevCatalogSource();
    const deps = makeDeps({
      [catalogCredKey('groq')]: { headers: { Authorization: 'Bearer gsk' } },
      [catalogCredKey('sap-ai-core')]: { headers: { Authorization: 'Bearer sk' } }, // not satisfiable
      'codex.oauth': { headers: {} },                                              // not a .bearer key
      'openai-compat.groq': { headers: {}, baseURL: 'https://x' },                 // openai-compat namespace
      [catalogCredKey('unlisted')]: { headers: { Authorization: 'Bearer x' } },    // not in catalog
    }, mock.fetch);
    expect(await source.listIds(deps)).toEqual(['groq']);
  });

  test('excluded ids are never served', async () => {
    const source = createModelsDevCatalogSource({ exclude: ['cloudflare-workers-ai'] });
    expect(source.get('cloudflare-workers-ai')).toBeUndefined();
    const mock = catalogMock();
    const deps = makeDeps({
      [catalogCredKey('cloudflare-workers-ai')]: { headers: { Authorization: 'Bearer t' } },
    }, mock.fetch);
    expect(await source.listIds(deps)).toEqual([]);
  });

  test('get is optimistic for well-formed ids, rejects malformed ones, and memoizes', () => {
    const source = createModelsDevCatalogSource();
    expect(source.get('groq')).toBeDefined();
    expect(source.get('not yet fetched')).toBeUndefined();
    expect(source.get('UPPER')).toBeUndefined();
    expect(source.get('groq')).toBe(source.get('groq')!);
  });
});

describe('registry with dynamic catalog source', () => {
  function makeRegistry() {
    const registry = createProviderRegistry();
    registry.register(staticProvider('openai', 'gpt-5.5'));
    registry.registerDynamic(createModelsDevCatalogSource());
    return registry;
  }

  test('a non-whitelisted catalog provider with a stored key resolves through openai-compat', async () => {
    const mock = catalogMock([
      { match: 'api.groq.com', respond: { status: 200, body: { choices: [] } } },
    ]);
    const registry = makeRegistry();
    const deps = makeDeps({
      [catalogCredKey('groq')]: { headers: { Authorization: 'Bearer gsk-test' } },
    }, mock.fetch);

    const model = registry.resolve('groq/llama-3.3-70b-versatile', deps);
    await tryCall(model);

    const upstream = mock.requests.filter((r) => r.url.includes('api.groq.com'));
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(upstream[0].headers['authorization']).toBe('Bearer gsk-test');
    expect(JSON.parse(upstream[0].body ?? '{}').model).toBe('llama-3.3-70b-versatile');
  });

  test('listAllModels includes catalog models (tool-call only) for connected providers', async () => {
    const mock = catalogMock();
    const registry = makeRegistry();
    const deps = makeDeps({
      [catalogCredKey('groq')]: { headers: { Authorization: 'Bearer gsk' } },
    }, mock.fetch);

    const { models, failures } = await registry.listAllModels(deps);
    expect(failures).toEqual([]);
    const groq = models.filter((m) => m.provider === 'groq');
    expect(groq.map((m) => m.id)).toEqual(['llama-3.3-70b-versatile']); // no-tools-model filtered
    expect(groq[0].contextWindow).toBe(131072);
    expect(groq[0].capabilities).toContain('tools');
  });

  test('bespoke providers stay authoritative — no duplicate resolution path', async () => {
    const mock = catalogMock();
    const registry = makeRegistry();
    const deps = makeDeps({
      [catalogCredKey('openai')]: { headers: { Authorization: 'Bearer sk' } },
      [catalogCredKey('groq')]: { headers: { Authorization: 'Bearer gsk' } },
    }, mock.fetch);

    // resolve() goes through the static provider, not the catalog.
    const model = registry.resolve('openai/gpt-5.5', deps) as { provider?: string };
    expect(model.provider).toBe('static-openai');

    // listings contain openai exactly once (the static entry).
    const { models } = await registry.listAllModels(deps);
    expect(models.filter((m) => m.provider === 'openai')).toEqual([
      { id: 'gpt-5.5', label: 'openai static', provider: 'openai' },
    ]);
    const providers = await registry.listProviders(deps);
    expect(providers.filter((p) => p.id === 'openai')).toHaveLength(1);
    expect(providers.map((p) => p.id)).toEqual(['openai', 'groq']);
  });

  test('canResolve accepts static + well-formed dynamic ids, rejects malformed', () => {
    const registry = makeRegistry();
    expect(registry.canResolve('openai')).toBe(true);
    expect(registry.canResolve('groq')).toBe(true);
    expect(registry.canResolve('not a provider')).toBe(false);
  });

  test('no credential → 401 short-circuit without an upstream call', async () => {
    const mock = catalogMock();
    const registry = makeRegistry();
    const deps = makeDeps({}, mock.fetch);
    const model = registry.resolve('groq/llama-3.3-70b-versatile', deps);
    await tryCall(model);
    expect(mock.requests.filter((r) => r.url.includes('api.groq.com'))).toHaveLength(0);
  });

  test('credentialed id missing from the catalog fails at request time with a clear error', async () => {
    const mock = catalogMock();
    const registry = makeRegistry();
    const deps = makeDeps({
      [catalogCredKey('unlisted')]: { headers: { Authorization: 'Bearer x' } },
    }, mock.fetch);
    const model = registry.resolve('unlisted/some-model', deps);
    let detail = '';
    try {
      await generateText({ model, prompt: 'hello', maxOutputTokens: 16 });
    } catch (err) {
      const e = err as Error & { responseBody?: string };
      detail = `${e.message} ${e.responseBody ?? ''}`;
    }
    expect(detail).toContain('models.dev');
  });
});
