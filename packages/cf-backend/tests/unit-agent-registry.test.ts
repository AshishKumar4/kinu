import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPromptSync, parseModelSpec } from '@proteus/core';
import { createTestRuntime } from '@proteus/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';

/** Minimal in-memory UserDO stub satisfying the methods agent-registry calls. */
function fakeUserDOStub(
  creds: Record<string, Record<string, string>> = {},
  baseURLs: Record<string, string> = {},
) {
  const list = Object.entries(creds).map(([key, headers]) => ({
    key, kind: headers['x-api-key'] ? 'bearer' : 'oauth' as const,
    createdAt: 0, updatedAt: 0,
  }));
  return {
    getAuthHeaders: async (key: string) => creds[key] ?? null,
    hasCredential: async (key: string) => !!creds[key],
    listCredentials: async () => list,
    getCredentialBaseURL: async (key: string) => baseURLs[key] ?? null,
  } as unknown as Parameters<typeof createAgentProviderRegistry>[0]['userDOStub'];
}

describe('AgentProviderRegistry composition', () => {
  test('registers all 8 providers in preference order', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDOStub: fakeUserDOStub(),
    });
    const ids = reg.registry.list().map(p => p.id);
    expect(ids).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
  });

  test('normalizeSpecSync — bare @cf/... prefixes workers-ai', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — canonical provider/modelId passes through', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(reg.normalizeSpecSync('anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
  });

  test('normalizeSpecSync — null returns workers-ai default without owner-billed env.AI', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    expect(reg.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(reg.normalizeSpecSync('')).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — workers-ai remains the sync default even when env ai-gateway is configured', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDOStub: fakeUserDOStub(),
    });
    expect(reg.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — catalog-shaped ids pass through, malformed ids throw', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    // models.dev-shaped ids are accepted optimistically (the catalog cannot be
    // consulted synchronously); membership is enforced at request time.
    expect(reg.normalizeSpecSync('groq/llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile');
    expect(() => reg.normalizeSpecSync('Not A Provider/model')).toThrow(/Unknown provider/);
  });

  test('async resolveSpec — picks workers-ai when Cloudflare OAuth has an account base URL', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDOStub: fakeUserDOStub(
        { 'cloudflare.oauth': { Authorization: 'Bearer cf-user-token' } },
        { 'cloudflare.oauth': 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1' },
      ),
    });
    const spec = await reg.resolveSpec(null);
    expect(spec).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
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

  test('null userDOStub → user credential providers unavailable', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDOStub: null,
    });
    const list = await reg.registry.listProviders(reg.deps);
    const credGated = list.filter((p) =>
      ['workers-ai', 'my-gateway', 'codex', 'openai', 'anthropic', 'openrouter', 'openai-compat'].includes(p.id),
    );
    for (const p of credGated) expect(p.available).toBe(false);
  });
});

describe('sync default provider with a null UserDO stub (inline-branch context)', () => {
  // Regression: workers-ai is credential-gated through UserDO; with a null
  // stub its requests are guaranteed 401s, so the sync default must fall
  // back to the env-bound ai-gateway instead of picking workers-ai.
  test('falls back to ai-gateway when env-bound gateway is configured', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDOStub: null,
    });
    expect(reg.normalizeSpecSync(null))
      .toBe('ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('throws loudly when no sync-usable provider exists', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: null });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/No sync-resolvable provider/);
  });

  test('explicit workers-ai specs still pass through unchanged', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: null });
    expect(reg.normalizeSpecSync('workers-ai/@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });
});

describe('default-agent prompt model context (Kimi family gating)', () => {
  // Regression: the orchestrator used to build prompts from the RAW stored
  // model id — null on default-configured agents — so resolveFamily saw ''
  // and the Kimi bare tool-name index never rendered on the primary hosted
  // path. The prompt context must come from the RESOLVED spec.
  test('an unset stored model resolves to a spec whose prompt renders the kimi index', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDOStub: fakeUserDOStub() });
    const storedModelId: string | null = null; // default-configured agent
    const spec = reg.normalizeSpecSync(storedModelId);
    const { provider, modelId } = parseModelSpec(spec);
    expect(provider).toBe('workers-ai');
    expect(modelId).toBe('@cf/moonshotai/kimi-k2.6');

    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['run', 'memory'],
      backend: 'cf',
      model: { id: modelId, provider },
    });
    // Kimi family: bare names, no per-tool summary prose.
    expect(prompt).toContain('\n- run\n');
    expect(prompt).not.toContain('**run**');

    // Wiring: both orchestrator prompt-build sites must derive the model
    // context from the resolved spec, never the raw stored id.
    const orchestrator = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf8');
    expect(orchestrator).toContain('private promptModelContext()');
    expect(orchestrator.match(/model: this\.promptModelContext\(\)|const model = this\.promptModelContext\(\)/g)?.length).toBe(2);
    expect(orchestrator).not.toContain('model: { id: modelId ?? undefined }');
  });
});
