import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { testOwner } from './helpers/user-do';
import { generateText } from 'ai';
import { createMockFetch } from '@kinu/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedModelServices } from '../src/owned-model-services';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu/core';
import type { LanguageModel } from 'ai';
import type { CredentialHeaders } from '../src/user/credential-headers';
import type { UserCaller } from '../src/user/workspace-capability';
import { platformGatewayEnv } from './helpers/platform-gateway';
import type { ProviderEnv } from '@kinu/core';

/** `LanguageModel` is `string | LanguageModelV3`; a resolver hands back the
 *  object half, and these tests read its provider/model ids. */
const ResolvedModelSchema = v.object({ provider: v.string(), modelId: v.string() });

function resolved(model: LanguageModel): v.InferOutput<typeof ResolvedModelSchema> {
  return v.parse(ResolvedModelSchema, model);
}

interface FakeUserDO {
  getAuthHeaders(caller: UserCaller, key: string): Promise<CredentialHeaders | null>;
  getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null>;
  listCredentials(caller: UserCaller): Promise<Array<{ key: string; kind: 'bearer'; createdAt: number; updatedAt: number }>>;
}

function fakeUserDO(credentials: Readonly<Record<string, CredentialHeaders>> = {}): FakeUserDO {
  return {
    async getAuthHeaders(_caller, key) { return credentials[key] ?? null; },
    async getCredentialBaseURL() { return null; },
    async listCredentials() {
      return Object.keys(credentials).map((key) => ({ key, kind: 'bearer' as const, createdAt: 0, updatedAt: 0 }));
    },
  };
}

function fakeEnv(stub: FakeUserDO = fakeUserDO(), extra: Partial<ProviderEnv> = {}): Env {
  const bindings = {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };
  const env: Partial<Env> = {};
  Object.assign(env, bindings, extra);
  // SAFETY: OwnedModelServices only reads the constructed UserDO namespace, the
  // credential secret, and whatever `extra` supplies in these tests; every
  // reachable stub method exists.
  return env as Env;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OwnedModelServices', () => {
  test('ActorAgent and ExplorationAgent wire their distinct settled policies', () => {
    const source = (file: string) => readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');
    const actor = source('actor-agent.ts');
    const exploration = source('exploration.ts');

    expect(actor).toContain("appTitle: 'Kinu',\n    ownerRequired: true,");
    expect(exploration).toContain("appTitle: 'Kinu (exploration)',\n    ownerRequired: false,");
    expect(actor).toContain('return this.ownedModelServices.providerRegistry();');
    expect(actor).toContain('return this.ownedModelServices.getWebSearchProvider();');
    expect(actor).toContain('this.ownedModelServices.invalidate();');
    expect(exploration).not.toContain('createAgentProviderRegistry');
    expect(exploration).not.toMatch(/\n  getModel\(/);
  });

  test('required owners fail with ActorAgent\'s established error', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(),
      agentName: () => 'actor',
      appTitle: 'Kinu',
      ownerRequired: true,
      getOwnerUserId: () => null,
      getUserCaller: async () => await testOwner(),
    });

    expect(() => services.providerRegistry()).toThrow(
      'Agent has no owner_user_id yet — Worker must call claimOwner before any model use.',
    );
  });

  test('optional owners retain env-only registry behavior and provider order', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(fakeUserDO(), platformGatewayEnv()),
      agentName: () => 'head',
      appTitle: 'Kinu (exploration)',
      ownerRequired: false,
      getOwnerUserId: () => null,
      getUserCaller: async () => await testOwner(),
    });

    expect(services.providerRegistry().registry.list().map((provider) => provider.id)).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
    const model = resolved(services.resolveModel());
    expect(model.provider).toBe('ai-gateway.chat');
    expect(model.modelId).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('resolves explicit specs and supplies the stable per-agent affinity key', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(),
      agentName: () => 'research-head',
      appTitle: 'Kinu (exploration)',
      ownerRequired: false,
      getUserCaller: async () => ({ workspaceToken: 'wt' }),
      getOwnerUserId: () => 'owner-1',
    });

    const model = resolved(services.resolveModel('openrouter/anthropic/claude-sonnet-4'));
    expect(model.provider).toBe('openrouter.chat');
    expect(model.modelId).toBe('anthropic/claude-sonnet-4');
    expect(services.affinityKey).toBe('kinu-research-head');
  });

  test.each([
    ['Kinu', 'actor'],
    ['Kinu (exploration)', 'head'],
  ])('preserves OpenRouter X-Title %s', async (appTitle, agentName) => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { choices: [] } } },
    ]);
    globalThis.fetch = mock.fetch;
    const services = new OwnedModelServices({
      env: fakeEnv(fakeUserDO({
        'openrouter.bearer': { Authorization: 'Bearer openrouter-token' },
      })),
      agentName: () => agentName,
      appTitle,
      ownerRequired: true,
      getUserCaller: async () => ({ workspaceToken: 'wt' }),
      getOwnerUserId: () => 'owner-1',
    });

    // The minimal mock response does not satisfy the AI SDK decoder. Asserted
    // rather than swallowed: this test is about the OUTGOING request headers, so a
    // mock that starts decoding cleanly should fail here, not pass silently.
    await expect(generateText({
      model: services.resolveModel('openrouter/anthropic/claude-sonnet-4'),
      prompt: 'hello',
      maxOutputTokens: 16,
    })).rejects.toThrow();

    expect(mock.requests[0]?.headers['x-title']).toBe(appTitle);
  });

  test('invalidate rebuilds owner-bound registry while the cached web provider resolves auth per call', async () => {
    const mock = createMockFetch([
      { match: 'duckduckgo.com', respond: { status: 200, body: '<html></html>', headers: { 'content-type': 'text/html' } } },
      {
        match: 'tavily.com',
        respond: {
          status: 200,
          body: { answer: 'owner result', results: [] },
          headers: { 'content-type': 'application/json' },
        },
      },
    ]);
    globalThis.fetch = mock.fetch;
    let owner: string | null = null;
    const services = new OwnedModelServices({
      env: fakeEnv(fakeUserDO({ 'tavily': { Authorization: 'Bearer tavily-token' } })),
      agentName: () => 'head',
      appTitle: 'Kinu (exploration)',
      ownerRequired: false,
      getUserCaller: async () => ({ workspaceToken: 'wt' }),
      getOwnerUserId: () => owner,
    });
    const web = services.getWebSearchProvider();
    const beforeRegistry = services.providerRegistry();

    expect((await web.search('before claim')).source).toBe('duckduckgo');
    owner = 'owner-1';
    services.invalidate();
    expect(services.providerRegistry()).not.toBe(beforeRegistry);
    expect(services.getWebSearchProvider()).toBe(web);
    expect((await web.search('after claim')).source).toBe('tavily');
  });
});
