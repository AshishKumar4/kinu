import { describe, expect, test } from 'bun:test';
import {
  ModelCatalogSession, contextWindowForModel, resolvePromptModelProfile,
  outputReserveTokens, stepContextLimit,
  type ModelInfo,
} from '../src/index';

// These are the FALLBACK paths used when the live models.dev catalog is
// unreachable (the catalog's reported contextWindow/capabilities always win).
// A new model release must not silently land on the 128k default window or a
// bare tools+streaming profile — that under-reports the window enough to
// trigger premature compaction and drops reasoning/caching from the prompt.
describe('model fallbacks track new releases', () => {
  test('DeepSeek V4 Pro keeps its documented context window without a catalog', () => {
    expect(contextWindowForModel('workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813')).toBe(1_048_576);
  });

  test('Kimi context windows by generation', () => {
    expect(contextWindowForModel('moonshotai/kimi-k3')).toBe(1_048_576);
    expect(contextWindowForModel('openrouter/moonshotai/kimi-k3')).toBe(1_048_576);
    expect(contextWindowForModel('workers-ai/@cf/moonshotai/kimi-k2.6')).toBe(262_144);
    expect(contextWindowForModel('workers-ai/@cf/moonshotai/kimi-k2.7-code')).toBe(262_144);
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

// The catalog session is what turns an async lookup into a synchronous answer
// for the whole turn: the static fallbacks hold until it lands, and nothing
// ever blocks on it. Pricing joins the window and the media policy there —
// null until the catalog answers, so the budget ledger blends and says so.
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
});

// KINU-045. Context admission reserves the resolved model's answer allowance,
// so the catalog has to report one — and has to say nothing rather than guess
// when it has not answered.
describe('ModelCatalogSession.modelOutputLimit', () => {
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

  test('an unanswered catalog reads as the whole window, so the split decides', async () => {
    // The alternative would be a picked number in the catalog's mouth. Saying
    // "the answer may take all of it" is the only honest reading, and
    // outputReserveTokens then reserves half — more conservative than the flat
    // 0.7 share this replaced, never less.
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => null,
    });
    session.info();
    await Promise.resolve();

    expect(session.contextWindow()).toBe(262_144);
    expect(session.modelOutputLimit()).toBe(262_144);
    expect(stepContextLimit({
      contextWindow: session.contextWindow(),
      modelOutputLimit: session.modelOutputLimit(),
    })).toBe(131_072);
  });

  test('a catalog that reports a window but no allowance still reserves the split', async () => {
    const session = new ModelCatalogSession({
      effectiveSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      lookup: async () => ({ id: '@cf/moonshotai/kimi-k2.6', contextWindow: 262_144 }),
    });
    session.info();
    await Promise.resolve();

    expect(session.modelOutputLimit()).toBe(262_144);
  });
});
