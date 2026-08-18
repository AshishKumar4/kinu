import { describe, expect, test } from 'bun:test';
import {
  ModelCatalogSession, contextWindowForModel, resolvePromptModelProfile,
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
