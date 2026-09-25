import { describe, expect, test } from 'bun:test';
import {
  ModelCatalogSession, contextWindowForModel, resolvePromptModelProfile, resolveEffectiveModelSpec,
  outputReserveTokens, stepContextLimit,
  type ModelInfo,
} from '../src/index';

// Fallbacks for when models.dev is unreachable: a new release must not land on the default window or a bare profile.
describe('model fallbacks track new releases', () => {
  test('DeepSeek V4 Pro keeps its documented context window without a catalog', () => {
    expect(contextWindowForModel('workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813'))
      .toEqual({ measured: true, window: 1_048_576 });
  });

  test('Kimi context windows by generation', () => {
    expect(contextWindowForModel('moonshotai/kimi-k3').window).toBe(1_048_576);
    expect(contextWindowForModel('openrouter/moonshotai/kimi-k3').window).toBe(1_048_576);
    expect(contextWindowForModel('workers-ai/@cf/moonshotai/kimi-k2.6').window).toBe(262_144);
    expect(contextWindowForModel('workers-ai/@cf/moonshotai/kimi-k2.7-code').window).toBe(262_144);
  });

  test('the whole Kimi family keeps reasoning + caching without a catalog', () => {
    for (const id of ['moonshotai/kimi-k3', '@cf/moonshotai/kimi-k2.6', 'kimi-k2.7-code']) {
      const profile = resolvePromptModelProfile({ id });
      expect(profile.family).toBe('kimi');
      expect([...profile.capabilities]).toContain('reasoning');
      expect([...profile.capabilities]).toContain('prompt-caching');
      expect([...profile.capabilities]).toContain('tools');
    }
  });

  test('catalog-reported capabilities still win over the family fallback', () => {
    const profile = resolvePromptModelProfile({
      id: 'moonshotai/kimi-k3',
      capabilities: ['tools', 'streaming'],
    });

    expect([...profile.capabilities].sort()).toEqual(['streaming', 'tools']);
  });
});

// Pricing is null until the catalog lands, so the budget ledger blends and says so.
describe('ModelCatalogSession.pricing', () => {
  test('null until the lookup lands, then the catalog rates', async () => {
    let resolveLookup: (info: ModelInfo | null) => void = () => {};

    const landed = new Promise<ModelInfo | null>((r) => { resolveLookup = r; });

    const session = new ModelCatalogSession({
      effectiveSpec: () => 'anthropic/claude-sonnet-4-6',
      lookup: () => landed,
    });

    expect(session.pricing()).toBeNull();
    resolveLookup({ id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cacheRead: 0.3 } });
    await landed;
    expect(session.pricing()).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  });

  test('a model the catalog does not price stays null rather than guessing', async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => ({ id: '@cf/moonshotai/kimi-k2.6', contextWindow: 262_144 }),
    });

    session.pricing();
    await Promise.resolve();
    expect(session.pricing()).toBeNull();
    expect(session.contextWindow()).toBe(262_144);
  });

  test('another model prices at its own rate once warmed, and never at the session model\u2019s', async () => {
    const rates = new Map<string, ModelInfo>([
      ['anthropic/claude-sonnet-4-6', { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15 } }],
      ['openai/gpt-5.5', { id: 'gpt-5.5', cost: { input: 5, output: 40 } }],
    ]);

    const session = new ModelCatalogSession({
      effectiveSpec: () => 'anthropic/claude-sonnet-4-6',
      lookup: async (spec) => rates.get(spec) ?? null,
    });

    await session.resolved();
    expect(session.pricing('openai/gpt-5.5')).toBeNull();
    await session.warm(['openai/gpt-5.5', 'openai/unlisted']);
    expect(session.pricing('openai/gpt-5.5')).toEqual({ input: 5, output: 40 });
    expect(session.pricing('openai/unlisted')).toBeNull();
    expect(session.pricing('anthropic/claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
  });
});

// KINU-045: admission reserves the answer allowance, so the catalog reports it or nothing, never a guess.
describe('ModelCatalogSession.modelOutputLimit', () => {
  test('an operation awaits limits for its selected model instead of borrowing the chat cache', async () => {
    const selected = Promise.withResolvers<{ id: string; contextWindow: number; modelOutputLimit: number }>();
    const lookedUp: string[] = [];

    const session = new ModelCatalogSession({
      effectiveSpec: () => 'chat/fast',
      lookup: async spec => {
        lookedUp.push(spec);

        return spec === 'deep/selected'
          ? selected.promise
          : { id: spec, contextWindow: 8_000, modelOutputLimit: 1_000 };
      },
    });

    const pending = session.contextFor('deep/selected');
    selected.resolve({ id: 'deep/selected', contextWindow: 200_000, modelOutputLimit: 32_000 });

    expect(await pending).toEqual({
      id: 'deep/selected', contextWindow: 200_000, modelOutputLimit: 32_000, windowMeasured: true,
    });
    expect(lookedUp).toEqual(['deep/selected']);
  });

  test('the reported allowance is what admission reserves', async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'anthropic/claude-opus-4-7',
      lookup: async () => ({
        id: 'claude-opus-4-7', contextWindow: 1_000_000, modelOutputLimit: 128_000,
      }),
    });

    session.info();
    await Promise.resolve();

    expect(session.modelOutputLimit()).toBe(128_000);

    const limits = {
      contextWindow: session.contextWindow(),
      modelOutputLimit: session.modelOutputLimit(),
    };

    expect(outputReserveTokens(limits)).toBe(128_000);
    expect(stepContextLimit(limits)).toBe(872_000);
  });

  test('an unanswered catalog reports NO allowance rather than the whole window', async () => {
    // Absent, not "all of it": `outputReserveTokens` would otherwise withhold half of every unpublished window.
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => null,
    });

    session.info();
    await Promise.resolve();

    expect(session.contextWindow()).toBe(262_144);
    expect(session.modelOutputLimit()).toBeNull();
    expect(outputReserveTokens({
      contextWindow: session.contextWindow(), modelOutputLimit: session.modelOutputLimit(),
    })).toBe(0);
  });

  test('a catalog that reports a window but no allowance reserves nothing for the answer', async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => ({ id: '@cf/moonshotai/kimi-k2.6', contextWindow: 262_144 }),
    });

    session.info();
    await Promise.resolve();

    expect(session.modelOutputLimit()).toBeNull();
    expect(stepContextLimit({
      contextWindow: session.contextWindow(), modelOutputLimit: session.modelOutputLimit(),
    })).toBe(262_144);
  });

  test('`resolved` waits for the lookup the synchronous reads answered without', async () => {
    // A gate that refuses work must wait for the catalog answer, not the stand-in table.
    const landed = Promise.withResolvers<ModelInfo>();

    const session = new ModelCatalogSession({
      effectiveSpec: () => 'some/unlisted-model',
      lookup: async () => landed.promise,
    });

    expect(session.contextWindow()).toBe(128_000);
    expect(session.windowMeasured()).toBe(false);
    landed.resolve({ id: 'some/unlisted-model', contextWindow: 1_048_576, modelOutputLimit: 131_072 });

    expect(await session.resolved()).toEqual({
      contextWindow: 1_048_576, modelOutputLimit: 131_072, windowMeasured: true,
    });
  });

  test('a spec nothing has measured says so, and keeps saying so', async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'some/unlisted-model',
      lookup: async () => null,
    });

    expect(await session.resolved()).toEqual({
      contextWindow: 128_000, modelOutputLimit: null, windowMeasured: false,
    });
  });
});

// The one model spelling every model_call row is priced against; both backends resolve it here.
describe('resolveEffectiveModelSpec', () => {
  const canonical = (spec: string | null): string => {
    const trimmed = spec?.trim() ?? '';

    if (trimmed === '' || trimmed === 'house-model') return 'openai-compatible/house-model';

    if (trimmed === 'openai-compatible/house-model') return trimmed;
    throw new Error(`unknown model ${trimmed}`);
  };

  test('one model under two spellings resolves to one spec', () => {
    const spellings = ['house-model', 'openai-compatible/house-model', '  house-model '];

    const resolved = new Set(spellings.map((stored) => resolveEffectiveModelSpec({
      live: () => undefined, stored: () => stored, normalize: canonical,
    })));

    expect([...resolved]).toEqual(['openai-compatible/house-model']);
  });

  test('the claimed tier outranks the stored spec, and is normalized too', () => {
    expect(resolveEffectiveModelSpec({
      live: () => 'house-model', stored: () => 'openai-compatible/other', normalize: canonical,
    })).toBe('openai-compatible/house-model');
  });

  test('a spec the backend cannot resolve yet reads back raw rather than costing the caller', () => {
    expect(resolveEffectiveModelSpec({
      live: () => undefined, stored: () => 'vendor/unlisted', normalize: canonical,
    })).toBe('vendor/unlisted');
    expect(resolveEffectiveModelSpec({
      live: () => undefined, stored: () => null, normalize: () => { throw new Error('no registry yet'); },
    })).toBe('');
  });
});
