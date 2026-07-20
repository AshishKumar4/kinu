import { describe, expect, test } from 'bun:test';
import { contextWindowForModel, resolvePromptModelProfile } from '../src/index.ts';

// These are the FALLBACK paths used when the live models.dev catalog is
// unreachable (the catalog's reported contextWindow/capabilities always win).
// A new model release must not silently land on the 128k default window or a
// bare tools+streaming profile — that under-reports the window enough to
// trigger premature compaction and drops reasoning/caching from the prompt.
describe('model fallbacks track new releases', () => {
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
