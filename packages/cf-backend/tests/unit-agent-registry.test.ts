import { generateText, streamText } from 'ai';
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import {
  buildSystemPromptSync,
  DEFAULT_WORKERS_AI_MODEL_ID,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  defaultSpecFor,
  parseModelSpec,
} from '@kinu.run/core';
import { createTestRuntime } from '@kinu.run/test-utils';
import { createAgentProviderRegistry, type AgentProviderRegistry } from '../src/providers/agent-registry';
import type { ModelMenuEntry } from '../src/user/available-models';
import type { CredentialSummary } from '../src/user/user-do';
import { platformGatewayEnv, stubAiBinding, TEST_GATEWAY_URL } from './helpers/platform-gateway';

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

  test('an admission count is keyed on the spec the request will use, for every BC form', () => {
    // The turn's admission counter parses the profile tier's spec to pick the
    // provider it asks for a count. It used to parse the RAW spec while the
    // submitted model came from `resolveModel`, which normalises first — so the
    // two disagreed on exactly the forms normalisation exists to accept. A bare
    // model id has no slash and `parseModelSpec` THROWS on it, inside turn
    // assembly; a bare `@cf/…` parses to provider `@cf`, which no registry
    // knows, so the count was asked of a provider that does not exist.
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    for (const raw of ['@cf/moonshotai/kimi-k2.6', 'gpt-5.5', 'codex/gpt-5.5', '']) {
      const keyed = parseModelSpec(reg.normalizeSpecSync(raw));
      // The provider the counter names is one the registry can actually serve.
      expect(reg.registry.get(keyed.provider)).toBeDefined();
      // And it is the same spec the model resolution would take.
      expect(`${keyed.provider}/${keyed.modelId}`).toBe(reg.normalizeSpecSync(raw));
    }
    // The two directions that used to break, stated as themselves: raw parsing
    // throws on the bare id and mis-keys the bare `@cf/…`.
    expect(() => parseModelSpec('gpt-5.5')).toThrow(/expected "<provider>\/<modelId>"/);
    expect(parseModelSpec('@cf/moonshotai/kimi-k2.6').provider).toBe('@cf');
    expect(reg.registry.get('@cf')).toBeUndefined();
  });

  test('normalizeSpecSync — null returns workers-ai default without owner-billed env.AI', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });
    expect(reg.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(reg.normalizeSpecSync('')).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('normalizeSpecSync — workers-ai remains the sync default even when the platform gateway is configured', () => {
    const reg = createAgentProviderRegistry({
      env: platformGatewayEnv(),
      userDO: fakeUserDOStub(),
    });
    expect(reg.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the staging identity runs Workers AI through the direct binding', async () => {
    const calls: Array<{ model: string; stream: boolean }> = [];
    const ai = Object.assign(stubAiBinding().binding, {
      async run(model: string, inputs: { stream?: boolean }) {
        const stream = inputs.stream === true;
        calls.push({ model, stream });
        if (!stream) {
          return {
            response: 'direct binding',
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          };
        }
        // A streamed turn goes over the binding as a real event stream. It is
        // never a finished completion replayed as one frame: that is what the
        // adapter refuses, so a stub answering the old way would fail here.
        return new Response([
          'data: {"response":"direct binding"}\n\n',
          'data: {"response":"","usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const directBinding: Ai = Object.create(ai);
    const env = {
      DEV_USER_EMAIL: 'eval-service@kinu.run',
      AI: directBinding,
    };
    const reg = createAgentProviderRegistry({ env, userDO: fakeUserDOStub() });
    expect(await reg.registry.get('workers-ai')!.isAvailable(reg.deps)).toBe(true);
    const model = reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6');
    const generated = await generateText({ model, prompt: 'reply' });
    expect(generated.text).toBe('direct binding');
    const streamed = streamText({ model, prompt: 'reply again' });
    expect(await streamed.text).toBe('direct binding');
    expect(await streamed.usage).toMatchObject({ inputTokens: 2, outputTokens: 2 });
    expect(calls).toEqual([
      { model: '@cf/moonshotai/kimi-k2.6', stream: false },
      { model: '@cf/moonshotai/kimi-k2.6', stream: true },
    ]);
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
    const gated = [
      'workers-ai', 'my-gateway', 'codex', 'openai', 'anthropic', 'openrouter', 'openai-compat',
    ];
    const list = await reg.registry.listProviders(reg.deps);
    const credGated = list.filter((p) => gated.includes(p.id));
    // Every one of them, by name. A filter is a denominator: an empty list, or an
    // id renamed out from under this array, would make "no credential-gated
    // provider is available without a UserDO" a claim about nothing — which is
    // the reading a provider that silently became reachable would produce.
    expect(credGated.map((p) => p.id).sort()).toEqual([...gated].sort());
    for (const p of credGated) expect(p.available).toBe(false);
  });
});

describe('default provider with a null UserDO stub (inline-branch context)', () => {
  // Regression: workers-ai is credential-gated through UserDO; with a null
  // stub its requests are guaranteed 401s, so the default must fall back to
  // the env-bound ai-gateway — which serves the same native model.
  test('falls back to ai-gateway when the platform gateway is usable', () => {
    const reg = createAgentProviderRegistry({
      env: platformGatewayEnv(),
      userDO: null,
    });
    expect(reg.normalizeSpecSync(null))
      .toBe(`ai-gateway/${DEFAULT_WORKERS_AI_MODEL_SPEC}`);
  });

  // The registry's sync default and the provider's own isAvailable() must agree:
  // a default naming ai-gateway when createModel() would throw is the exact
  // "measured set ≠ governed set" defect. Each half alone must fail.
  test('a gateway URL without the AI binding is not a usable default', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: TEST_GATEWAY_URL },
      userDO: null,
    });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/Workers AI binding \(env\.AI\) missing/);
  });

  test('the AI binding without a parseable gateway URL is not a usable default', () => {
    const reg = createAgentProviderRegistry({
      env: { AI_GATEWAY_URL: 'https://gw', AI: stubAiBinding().binding },
      userDO: null,
    });
    expect(() => reg.normalizeSpecSync(null)).toThrow(/AI_GATEWAY_URL is not an AI Gateway URL/);
  });

  test('registry default and provider availability answer the same question', async () => {
    const usable = createAgentProviderRegistry({ env: platformGatewayEnv(), userDO: null });
    const unusable = createAgentProviderRegistry({ env: { AI_GATEWAY_URL: TEST_GATEWAY_URL }, userDO: null });
    const availability = async (reg: AgentProviderRegistry) =>
      (await reg.registry.listProviders(reg.deps)).find((p) => p.id === 'ai-gateway')?.available;
    expect(await availability(usable)).toBe(true);
    expect(usable.normalizeSpecSync(null)).toStartWith('ai-gateway/');
    expect(await availability(unusable)).toBe(false);
    expect(() => unusable.normalizeSpecSync(null)).toThrow(/Workers AI binding \(env\.AI\) missing/);
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
  });
});

describe('the model a new workspace starts on', () => {
  // The RULE is core's `defaultSpecFor` now; what is asserted here is what this
  // backend hands it — the specs of the models the ACCOUNT can serve, projected
  // off the credential menu exactly as `createCloudWorkspaceForUser` projects
  // them. The rule used to be a cf-local `pickInitialModel` while the CLI
  // answered the same question its own way.
  const native: ModelMenuEntry = {
    spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
  };
  const byo: ModelMenuEntry = { spec: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'openai' };
  const servable = (models: ModelMenuEntry[]) => models.map((entry) => entry.spec);

  test('no configured default → the native Workers AI model', () => {
    expect(defaultSpecFor(null, servable([native, byo]))).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the native model is chosen even when a BYO provider lists first', () => {
    expect(defaultSpecFor(null, servable([byo, native]))).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('a configured default wins when the account can serve it', () => {
    expect(defaultSpecFor('openai/gpt-5.5', servable([native, byo]))).toBe('openai/gpt-5.5');
  });

  // Regression: this used to fall through to `models[0]`, so a user who signed
  // in with Google and pasted one API key had every new workspace silently
  // created on that paid provider. No native model available and nothing
  // chosen is now an error the caller reports, not a guess.
  test('no native model and no choice resolves to nothing rather than a BYO guess', () => {
    expect(defaultSpecFor(null, servable([byo]))).toBeNull();
    expect(defaultSpecFor('workers-ai/@cf/meta/llama-4', servable([byo]))).toBeNull();
  });
});
