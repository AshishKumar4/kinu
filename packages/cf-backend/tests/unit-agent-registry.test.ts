import { describe, test, expect } from 'bun:test';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';

function fakeAiBinding() {
  return { run: async () => ({ result: '' }) } as unknown as object;
}

/** Minimal in-memory UserDO stub satisfying the methods agent-registry calls. */
function fakeUserDOStub(creds: Record<string, Record<string, string>> = {}) {
  const list = Object.entries(creds).map(([key, headers]) => ({
    key, kind: headers['x-api-key'] ? 'bearer' : 'oauth' as const,
    createdAt: 0, updatedAt: 0,
  }));
  return {
    getAuthHeaders: async (key: string) => creds[key] ?? null,
    hasCredential: async (key: string) => !!creds[key],
    listCredentials: async () => list,
    getCredentialBaseURL: async (_key: string) => null,
  } as unknown as Parameters<typeof createAgentProviderRegistry>[0]['userDOStub'];
}

describe('AgentProviderRegistry composition', () => {
  test('registers all 7 providers in preference order (ai-gateway first)', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      userDOStub: fakeUserDOStub(),
    });
    const ids = reg.registry.list().map(p => p.id);
    expect(ids).toEqual([
      'ai-gateway', 'workers-ai', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
  });

  test('normalizeSpecSync — bare @cf/... prefixes workers-ai', () => {
    const reg = createAgentProviderRegistry({ env: { AI: fakeAiBinding() }, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — canonical provider/modelId passes through', () => {
    const reg = createAgentProviderRegistry({ env: { AI: fakeAiBinding() }, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(reg.normalizeSpecSync('anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
  });

  test('normalizeSpecSync — null defaults to ai-gateway/minimax/m3 in prod (gateway + binding)', () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding(), AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDOStub: fakeUserDOStub(),
    });
    expect(reg.normalizeSpecSync(null)).toBe('ai-gateway/minimax/m3');
    expect(reg.normalizeSpecSync('')).toBe('ai-gateway/minimax/m3');
  });

  test('normalizeSpecSync — null falls back to workers-ai/kimi when gateway not configured', () => {
    const reg = createAgentProviderRegistry({ env: { AI: fakeAiBinding() }, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — gateway-only env defaults to minimax/m3', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDOStub: fakeUserDOStub(),
    });
    expect(reg.normalizeSpecSync(null)).toBe('ai-gateway/minimax/m3');
  });

  test('normalizeSpecSync — throws when no sync-resolvable provider', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/sync-resolvable/);
  });

  test('normalizeSpecSync — throws on unknown provider id', () => {
    const reg = createAgentProviderRegistry({ env: { AI: fakeAiBinding() }, userDOStub: fakeUserDOStub() });
    expect(() => reg.normalizeSpecSync('nonsense/model')).toThrow(/Unknown provider/);
  });

  test('async resolveSpec — picks first available provider via cred-aware ordering', async () => {
    // Only codex creds available; workers-ai binding absent.
    const reg = createAgentProviderRegistry({
      env: {},
      userDOStub: fakeUserDOStub({
        'codex.oauth': { Authorization: 'Bearer codex-token', originator: 'codex_cli_rs' },
      }),
    });
    const spec = await reg.resolveSpec(null);
    expect(spec).toBe('codex/gpt-5.5');
  });

  test('null userDOStub → only env-bound providers available', async () => {
    const reg = createAgentProviderRegistry({
      env: { AI: fakeAiBinding() },
      userDOStub: null,
    });
    const list = await reg.registry.listProviders(reg.deps);
    const credGated = list.filter((p) =>
      ['codex', 'openai', 'anthropic', 'openrouter', 'openai-compat'].includes(p.id),
    );
    for (const p of credGated) expect(p.available).toBe(false);
    expect(list.find((p) => p.id === 'workers-ai')?.available).toBe(true);
  });
});
