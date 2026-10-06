import { generateText, streamText } from 'ai';
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import {
  asFetchFunction,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  defaultSpecFor,
  parseModelSpec,
  KINU_USER_AGENT,
  requestUrl,
} from '@kinu.run/core';
import { createMockFetch, OPENCODE_GO_CATALOG, OPENAI_RESPONSES_BODY, present } from '@kinu.run/test-utils';
import { createAgentProviderRegistry, type UserCredentialClient } from '../src/providers/agent-registry';
import type { ModelMenuEntry } from '../src/user/available-models';
import type { CredentialSummary } from '../src/user/credentials';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { serveFamily } from './helpers/api';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { platformGatewayEnv, stubAiBinding } from './helpers/platform-gateway';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';

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
    hasCredential: async (key: string) => Boolean(creds[key]),
    listCredentials: async () => list,
    getCredentialBaseURL: async (key: string) => baseURLs[key] ?? null,
  });
}

describe('AgentProviderRegistry composition', () => {
  test('OpenCode Go receives the hosted conversation identity through Responses', async () => {
    const mock = createMockFetch([
      { match: 'models.dev/api.json', respond: { body: OPENCODE_GO_CATALOG } },
      { match: 'https://opencode.ai/zen/go/v1/responses', respond: { body: OPENAI_RESPONSES_BODY } },
    ]);

    const reg = createAgentProviderRegistry({
      env: {}, userDO: fakeUserDOStub({ 'opencode-go.bearer': { Authorization: 'Bearer hosted-key' } }),
      fetch: mock.fetch,
    });

    const model = reg.resolveModel('opencode-go/muse-spark-1.3-contributor', 'kinu-hosted-conversation');

    await generateText({ model, prompt: 'hello' });
    await generateText({ model, prompt: 'continue' });
    const calls = mock.requests.filter((request) => request.url.endsWith('/responses'));

    expect(calls).toHaveLength(2);

    for (const request of calls) {
      expect(request.headers['x-opencode-session']).toBe('kinu-hosted-conversation');
      expect(request.headers['user-agent']).toBe(KINU_USER_AGENT);
      expect(request.headers.authorization).toBe('Bearer hosted-key');
    }
  });

  test('registers all 10 providers in preference order', () => {
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub(),
    });

    const ids = reg.registry.list().map(p => p.id);
    expect(ids).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'chatgpt', 'codex', 'claude', 'openai',
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
    // The counter must parse the normalised spec `resolveModel` submits: the raw
    // one throws on a bare id and keys a bare `@cf/…` to an unknown provider.
    const reg = createAgentProviderRegistry({ env: {}, userDO: fakeUserDOStub() });

    for (const raw of ['@cf/moonshotai/kimi-k2.6', 'codex/gpt-5.5']) {
      const keyed = parseModelSpec(reg.normalizeSpecSync(raw));
      expect(reg.registry.get(keyed.provider)).toBeDefined();
      expect(`${keyed.provider}/${keyed.modelId}`).toBe(reg.normalizeSpecSync(raw));
    }

    expect(() => parseModelSpec('gpt-5.5')).toThrow(/expected "<provider>\/<modelId>"/);
    expect(parseModelSpec('@cf/moonshotai/kimi-k2.6').provider).toBe('@cf');
    expect(reg.registry.get('@cf')).toBeUndefined();
  });

  test('a spec that names no provider is refused: an unpinned actor runs on its profile\'s tier model', () => {
    const reg = createAgentProviderRegistry({ env: platformGatewayEnv(), userDO: fakeUserDOStub() });

    expect(() => reg.normalizeSpecSync('')).toThrow(/names its provider/);
    expect(() => reg.normalizeSpecSync('gpt-5.5')).toThrow(/names its provider/);
  });

  test('explicit workers-ai specs still pass through unchanged', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: null });
    expect(reg.normalizeSpecSync('workers-ai/@cf/moonshotai/kimi-k2.6'))
      .toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('WORKERS_AI_VIA_BINDING runs Workers AI through the direct binding, and nothing else does', async () => {
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

        // The adapter refuses a finished completion replayed as one stream frame.
        return new Response([
          'data: {"response":"direct binding"}\n\n',
          'data: {"response":"","usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    });

    const directBinding: Ai = Object.create(ai);

    // KINU-001(b): a bound AI alone routes nothing directly; the eval identity's email is not even an input.
    const unflagged = createAgentProviderRegistry({ env: { AI: directBinding }, userDO: fakeUserDOStub() });

    await expect(generateText({ model: unflagged.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', 'kinu-test'), prompt: 'reply' })).rejects.toThrow();
    expect(calls).toEqual([]);

    const env = {
      WORKERS_AI_VIA_BINDING: 'on',
      AI: directBinding,
    };

    const reg = createAgentProviderRegistry({ env, userDO: fakeUserDOStub() });
    expect(await present(reg.registry.get('workers-ai'), 'the workers-ai provider').isAvailable(reg.deps)).toBe(true);
    const model = reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', 'kinu-test');
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
      'workers-ai', 'my-gateway', 'codex', 'claude', 'openai', 'anthropic', 'openrouter', 'openai-compat',
    ];

    const list = await reg.registry.listProviders(reg.deps);
    const credGated = list.filter((p) => gated.includes(p.id));
    // Named explicitly: an empty or stale list would make this a claim about nothing.
    expect(credGated.map((p) => p.id).sort()).toEqual([...gated].sort());

    for (const p of credGated) expect(p.available).toBe(false);
  });
});

describe('the model a new workspace starts on', () => {
  // The rule is core's `defaultSpecFor`; asserted here is the input this backend
  // hands it, projected as `createCloudWorkspaceForUser` does.
  const native: ModelMenuEntry = {
    spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
  };

  const byo: ModelMenuEntry = { spec: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'openai' };
  const servable = (models: ModelMenuEntry[]) => models.map((entry) => entry.spec);
  const NONE_FAILED: ReadonlySet<string> = new Set();

  test('no configured default → the native Workers AI model', () => {
    expect(defaultSpecFor(null, servable([native, byo]), NONE_FAILED)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('the native model is chosen even when a BYO provider lists first', () => {
    expect(defaultSpecFor(null, servable([byo, native]), NONE_FAILED)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('a configured default wins when the account can serve it', () => {
    expect(defaultSpecFor('openai/gpt-5.5', servable([native, byo]), NONE_FAILED)).toBe('openai/gpt-5.5');
  });

  // No native model and nothing chosen is an error, not a fall-through to `models[0]`.
  test('no native model and no choice resolves to nothing rather than a BYO guess', () => {
    expect(defaultSpecFor(null, servable([byo]), NONE_FAILED)).toBeNull();
    expect(defaultSpecFor('workers-ai/@cf/meta/llama-4', servable([byo]), NONE_FAILED)).toBeNull();
  });
});

describe('what a model call asks of the account', () => {
  // Every model call read its credential in two UserDO round trips, headers then base URL: 633 + 518 of the UserDO
  // calls sampled on staging while 180 workspaces of one account ran (2026-10-01 01:06:40-01:07:20Z).
  test('its credential arrives in one round trip', async () => {
    const user = createTestUserDO({ durableObjectId: '0123456789abcdef0123456789abcdef' });
    const owner = await testOwner();
    const asked: string[] = [];

    await user.userDO.setCredential(owner, 'openai.bearer', { kind: 'bearer', token: 'sk-one-trip' });
    const account = user.userDO;

    function recorded<Args extends unknown[], Answer>(member: string, call: (...args: Args) => Promise<Answer>) {
      return async (...args: Args): Promise<Answer> => {
        asked.push(member);

        return await call(...args);
      };
    }

    // Every member a registry can reach on the account, each call recorded.
    const counted: UserCredentialClient = {
      getAuth: recorded('getAuth', account.getAuth.bind(account)),
      listCredentials: recorded('listCredentials', account.listCredentials.bind(account)),
      relayDevice: recorded('relayDevice', account.relayDevice.bind(account)),
      relayModelCall: recorded('relayModelCall', account.relayModelCall.bind(account)),
      cancelModelRelay: recorded('cancelModelRelay', account.cancelModelRelay.bind(account)),
    };

    const mock = createMockFetch([{ match: 'api.openai.com', respond: { body: OPENAI_RESPONSES_BODY } }]);
    const reg = createAgentProviderRegistry({ env: {}, userDO: { stub: counted, caller: owner }, fetch: mock.fetch });

    try {
      await generateText({ model: reg.resolveModel('openai/gpt-5.5', 'kinu-test'), prompt: 'hello' });

      expect(asked).toHaveLength(1);
      expect(mock.requests[0]?.headers.authorization).toBe('Bearer sk-one-trip');
    } finally {
      await user.joinFibers();
      user.close();
    }
  });
});

describe("Settings' model test", () => {
  test('a test of an OpenCode Go model names a conversation, as OpenCode Go requires', async () => {
    const userId = '0123456789abcdef0123456789abcdef';
    const user = createTestUserDO({ durableObjectId: userId });
    const owner = await testOwner();
    const original = globalThis.fetch;
    const sessions: (string | null)[] = [];

    await user.userDO.ensureProfile(owner, 'owner@example.test');
    await user.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'go-key' });
    globalThis.fetch = asFetchFunction(async (input, init) => {
      if (requestUrl(input).includes('models.dev')) return Response.json(OPENCODE_GO_CATALOG);
      sessions.push(new Headers(init?.headers).get('x-opencode-session'));

      return new Response('refused by the test', { status: 400 });
    });

    try {
      const env: UserRoutesEnv<string> = {
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
        UserDO: { idFromName: (name) => name, get: () => user.userDO },
        OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
      };

      const response = await serveFamily(userRoutes, { identity: { userId, email: 'owner@example.test', sub: 'model-test' }, ctx: workerContext() })(
        new Request('https://kinu.example.com/api/user/models/test', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: 'opencode-go/muse-spark-1.3-contributor' }),
        }),
        env,
      );

      expect(response?.status).toBe(200);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toStartWith('kinu-');
    } finally {
      globalThis.fetch = original;
      await user.joinFibers();
      user.close();
    }
  });
});
