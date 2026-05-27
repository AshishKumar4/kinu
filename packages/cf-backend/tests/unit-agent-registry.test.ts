import { describe, test, expect } from 'bun:test';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';
import { createTestCredentials, freshOAuthCredential } from '@proteus/test-utils';
import { CODEX_CRED_KEY } from '@proteus/core';

// Minimal fake `Ai` binding — workers-ai-provider's factory only calls .run()
// at request time, never at construction; this satisfies the isAvailable check.
function fakeAiBinding() {
  return { run: async () => ({ result: '' }) } as unknown as object;
}

describe('AgentProviderRegistry composition', () => {
  test('registers all 7 providers in preference order', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    const ids = reg.registry.list().map(p => p.id);
    expect(ids).toEqual([
      'workers-ai', 'ai-gateway', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
  });

  test('normalizeSpecSync — bare @cf/... prefixes workers-ai', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(reg.normalizeSpecSync('@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — canonical provider/modelId passes through', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(reg.normalizeSpecSync('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(reg.normalizeSpecSync('anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
  });

  test('normalizeSpecSync — null/empty returns workers-ai default when env.AI present', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(reg.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(reg.normalizeSpecSync('')).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(reg.normalizeSpecSync(undefined)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — null falls back to ai-gateway when no env.AI but vars set', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      credentials: createTestCredentials(),
    });
    expect(reg.normalizeSpecSync(null)).toBe('ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — throws when no sync-resolvable provider', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      credentials: createTestCredentials(),
    });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/sync-resolvable/);
  });

  test('normalizeSpecSync — throws on unknown provider id', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(() => reg.normalizeSpecSync('nonsense/model')).toThrow(/Unknown provider/);
  });

  test('normalizeSpecSync — bare modelId wraps with sync-default provider', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(reg.normalizeSpecSync('gpt-5.5')).toBe('workers-ai/gpt-5.5');
  });

  test('async resolveSpec — picks first available provider via cred-aware ordering', async () => {
    // Only codex creds available; workers-ai binding absent.
    const reg = createAgentProviderRegistry({
      env: {},
      credentials: createTestCredentials({ [CODEX_CRED_KEY]: freshOAuthCredential() }),
    });
    const spec = await reg.resolveSpec(null);
    expect(spec).toBe('codex/gpt-5.5');
  });

  test('async resolveSpec — accepts canonical spec unchanged', async () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      credentials: createTestCredentials(),
    });
    expect(await reg.resolveSpec('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });
});
