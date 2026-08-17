import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSystemPromptSync,
  DEFAULT_WORKERS_AI_MODEL_ID,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  parseModelSpec,
} from '@proteus/core';
import { createTestRuntime } from '@proteus/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';
import { pickInitialModel } from '../src/user/workspace-create.ts';
import type { ModelMenuEntry } from '../src/user/available-models.js';
import type { CredentialSummary } from '../src/user/user-do.js';

/** Minimal in-memory UserDO stub satisfying the methods agent-registry calls. */
function fakeUserDOStub(
  creds: Record<string, Record<string, string>> = {},
  baseURLs: Record<string, string> = {},
) {
  const list: CredentialSummary[] = Object.entries(creds).map(([key, headers]) => ({
    key, kind: headers['x-api-key'] ? 'bearer' : 'oauth',
    createdAt: 0, updatedAt: 0,
  }));
  return userCredentialSource({
    getAuthHeaders: async (key: string) => creds[key] ?? null,
    hasCredential: async (key: string) => !!creds[key],
    listCredentials: async () => list,
    getCredentialBaseURL: async (key: string) => baseURLs[key] ?? null,
  });
}

describe('AgentProviderRegistry composition', () => {
  test('registers all 8 providers in preference order', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub(),
    });
    const ids = reg.registry.list().map(p => p.id);
    expect(ids).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
  });

  test('normalizeSpecSync — bare @cf/... prefixes workers-ai', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('normalizeSpecSync — canonical provider/modelId passes through', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    expect(reg.normalizeSpecSync('codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(reg.normalizeSpecSync('anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
  });

  test('normalizeSpecSync — null returns workers-ai default without owner-billed env.AI', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    expect(reg.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(reg.normalizeSpecSync('')).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('normalizeSpecSync — workers-ai remains the sync default even when env ai-gateway is configured', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDO: fakeUserDOStub(),
    });
    expect(reg.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('normalizeSpecSync — catalog-shaped ids pass through, malformed ids throw', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    // models.dev-shaped ids are accepted optimistically (the catalog cannot be
    // consulted synchronously); membership is enforced at request time.
    expect(reg.normalizeSpecSync('groq/llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile');
    expect(() => reg.normalizeSpecSync('Not A Provider/model')).toThrow(/Unknown provider/);
  });

  // The owner runs on the native Workers AI model precisely because it is the
  // one he does not pay per-token for. There used to be a second, async spec
  // resolver that surveyed which BYO credential happened to be stored and
  // preferred it whenever Cloudflare was not connected; it had no production
  // caller and it contradicted this. There is now one resolver.
  test('an unchosen model is the native default, not whichever BYO credential is stored', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub({
        'codex.oauth': { Authorization: 'Bearer codex-token', originator: 'codex_cli_rs' },
        'openai.bearer': { Authorization: 'Bearer sk-test' },
      }),
    });
    expect(reg.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('an explicit BYO choice still wins over the native default', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub({ 'codex.oauth': { Authorization: 'Bearer codex-token', originator: 'codex_cli_rs' } }),
    });
    expect(reg.normalizeSpecSync('codex/gpt-5.5')).toBe('codex/gpt-5.5');
  });

  test('the registry exposes exactly one spec resolver', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    expect(Object.keys(reg).sort()).toEqual(['deps', 'normalizeSpecSync', 'registry', 'resolveModel']);
  });

  test('null userDO → user credential providers unavailable', async () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: null,
    });
    const list = await reg.registry.listProviders(reg.deps);
    const credGated = list.filter((p) =>
      ['workers-ai', 'my-gateway', 'codex', 'openai', 'anthropic', 'openrouter', 'openai-compat'].includes(p.id),
    );
    for (const p of credGated) expect(p.available).toBe(false);
  });
});

describe('default provider with a null UserDO stub (inline-branch context)', () => {
  // Regression: workers-ai is credential-gated through UserDO; with a null
  // stub its requests are guaranteed 401s, so the default must fall back to
  // the env-bound ai-gateway — which serves the same native model.
  test('falls back to ai-gateway when env-bound gateway is configured', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_AUTH: 'Bearer x' },
      userDO: null,
    });
    expect(reg.normalizeSpecSync(null))
      .toBe(`ai-gateway/${DEFAULT_WORKERS_AI_MODEL_SPEC}`);
  });

  test('throws loudly when no usable provider exists', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: null });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/No default provider available/);
  });

  test('explicit workers-ai specs still pass through unchanged', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: null });
    expect(reg.normalizeSpecSync('workers-ai/@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });
});

describe('default-agent prompt model context', () => {
  // Regression: the orchestrator used to build prompts from the RAW stored
  // model id — null on default-configured agents — so resolveFamily saw ''
  // and nothing family-gated rendered on the primary hosted path. The prompt
  // context must come from the RESOLVED spec rather than an empty raw value.
  test('an unset stored model resolves to DeepSeek V4 Pro before prompt construction', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    const storedModelId: string | null = null; // default-configured agent
    const spec = reg.normalizeSpecSync(storedModelId);
    const { provider, modelId } = parseModelSpec(spec);
    expect(provider).toBe('workers-ai');
    expect(modelId).toBe(DEFAULT_WORKERS_AI_MODEL_ID);

    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      availableTools: ['run', 'memory'],
      backend: 'cf',
      model: { id: modelId, provider },
    });
    expect(prompt).not.toContain('Kimi K2.6 works best when tool use is concrete and continuous');

    // Wiring: both orchestrator prompt-build sites must derive the model
    // context from the resolved spec, never the raw stored id.
    const actor = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
    expect(actor).toContain('private promptModelContext()');
    expect(actor.match(/model: this\.promptModelContext\(\)|const model = this\.promptModelContext\(\)/g)?.length).toBe(2);
    expect(actor).not.toContain('model: { id: modelId ?? undefined }');
  });
});

describe('the model a new workspace starts on', () => {
  const native: ModelMenuEntry = {
    spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
  };
  const byo: ModelMenuEntry = { spec: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'openai' };

  test('no configured default → the native Workers AI model', () => {
    expect(pickInitialModel(null, [native, byo])).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the native model is chosen even when a BYO provider lists first', () => {
    expect(pickInitialModel(null, [byo, native])).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('a configured default wins when the account can serve it', () => {
    expect(pickInitialModel('openai/gpt-5.5', [native, byo])).toBe('openai/gpt-5.5');
  });

  // Regression: this used to fall through to `models[0]`, so a user who signed
  // in with Google and pasted one API key had every new workspace silently
  // created on that paid provider. No native model available and nothing
  // chosen is now an error the caller reports, not a guess.
  test('no native model and no choice resolves to nothing rather than a BYO guess', () => {
    expect(pickInitialModel(null, [byo])).toBeNull();
    expect(pickInitialModel('workers-ai/@cf/meta/llama-4', [byo])).toBeNull();
  });
});
