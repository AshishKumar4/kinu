import { createTestUserDO } from './helpers/user-do';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { testOwner } from './helpers/user-do';
import { generateText } from 'ai';
import { createMockFetch } from '@kinu.run/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedModelServices, type OwnedModelEnv } from '../src/owned-model-services';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, asFetchFunction, profileCatalogDigest,
  resolveTurnProfile,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import type { CredentialHeaders } from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import { platformGatewayEnv } from './helpers/platform-gateway';
import { WORKERS_AI_FALLBACK_MODEL_CATALOG } from '@kinu.run/core';
import type { ProviderEnv } from '@kinu.run/core';

/** `LanguageModel` is `string | LanguageModelV3`; resolvers hand back the object half. */
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

function fakeEnv(stub: FakeUserDO = fakeUserDO(), extra: Partial<ProviderEnv> = {}): OwnedModelEnv<string> {
  return {
    UserDO: {
      idFromName: (name) => name,
      get: () => stub,
    },
    ...extra,
  };
}

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

describe('OwnedModelServices', () => {
  test('ActorAgent owns the one registry every mode resolves through', () => {
    const source = (file: string) => readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');
    const actor = source('actor-agent.ts');
    const orchestrator = source('orchestrator.ts');
    const hosting = source('exploration-hosting.ts');

    expect(actor).toContain("appTitle: 'Kinu',\n    ownerRequired: true,");
    expect(actor).toContain('return this.ownedModelServices.providerRegistry();');
    expect(actor).toContain('this.ownedModelServices.invalidate();');
    // No second registry: a hosted head runs in a claimed workspace, so there is no ownerless mode.
    expect(hosting).not.toContain('createAgentProviderRegistry');
    expect(hosting).not.toContain('ownerRequired');
    expect(orchestrator).toContain('resolveModel: (spec) => this.ownedModelServices.resolveModel(spec),');
    expect(actor.match(/new OwnedModelServices\(/g)).toHaveLength(1);
  });

  test('required owners fail with ActorAgent\'s established error', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(),
      agentName: () => 'actor',
      appTitle: 'Kinu',
      ownerRequired: true,
      getOwnerUserId: () => null,
      getUserCaller: async () => await testOwner(),
      getCredentialsRevision: async () => 0,
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
      getCredentialsRevision: async () => 0,
    });

    expect(services.providerRegistry().registry.list().map((provider) => provider.id)).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'codex', 'claude', 'openai',
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
      getCredentialsRevision: async () => 0,
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
      getCredentialsRevision: async () => 0,
    });

    // The mock response fails the AI SDK decoder; asserted so a mock that decodes cleanly fails
    // here.
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
      getCredentialsRevision: async () => 0,
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

/**
 * Only 503s are mocked: `models-dev.ts` memoizes a healthy catalog module-wide, which would leak
 * into later tests; a 503 is not cached. Owner-bound and unowned registries differ by exactly
 * the failure set.
 */
function snapshotServices(
  owner: string | null,
  credentials: Readonly<Record<string, CredentialHeaders>> = {},
  getCredentialsRevision: () => Promise<number> = async () => 0,
): OwnedModelServices<string> {
  return new OwnedModelServices({
    env: fakeEnv(fakeUserDO(credentials), platformGatewayEnv()),
    agentName: () => 'snapshot',
    appTitle: 'Kinu',
    ownerRequired: false,
    getOwnerUserId: () => owner,
    getUserCaller: async () => ({ workspaceToken: 'wt' }),
    getCredentialsRevision,
  });
}

/** A catalog-backed credential: enumerating it needs models.dev, so a 503 is a failed listing. */
function degradedServices(): OwnedModelServices<string> {
  return snapshotServices('owner-1', { 'groq.bearer': { Authorization: 'Bearer gsk' } });
}

function catalogDown() {
  const mock = createMockFetch([
    { match: 'models.dev/api.json', respond: { status: 503, body: 'upstream down' } },
  ]);

  globalThis.fetch = mock.fetch;

  return mock;
}

/** models.dev answering with the Workers AI list only: a complete listing for an account with no catalog credential.
 *  The catalog memo is keyed by the fetch it came through, so it does not outlive this mock. */
function catalogUp() {
  const models = Object.fromEntries(WORKERS_AI_FALLBACK_MODEL_CATALOG.map((model) => [model.id.replace(/^@cf\//, ''), {
    id: model.id,
    name: model.label,
    tool_call: true,
    reasoning: (model.reasoningEfforts?.length ?? 0) > 0,
    reasoning_options: [{ type: 'effort', values: [...model.reasoningEfforts ?? []] }],
    limit: { context: model.contextWindow },
  }]));

  const mock = createMockFetch([
    { match: 'models.dev/api.json', respond: { status: 200, body: { 'cloudflare-workers-ai': { models } } } },
  ]);

  globalThis.fetch = mock.fetch;

  return mock;
}

describe('OwnedModelServices — the provider snapshot', () => {
  // Assert the reported cache outcome (what core writes into `profile_resolution`), not object
  // identity.
  test('a failed provider listing is preserved, never dropped into model absence', async () => {
    catalogDown();

    const { snapshot } = await degradedServices().profileProviderSnapshot();

    expect(snapshot.unavailableProviders).toContainEqual({
      provider: 'catalog',
      label: 'models.dev catalog',
      reason: 'models.dev returned HTTP 503',
    });
  });

  test('revision moves when only the failure set moves', async () => {
    catalogDown();
    const degraded = (await degradedServices().profileProviderSnapshot()).snapshot;

    catalogUp();
    const clean = (await snapshotServices(null).profileProviderSnapshot()).snapshot;

    expect([...degraded.availableModels].sort()).toEqual([...clean.availableModels].sort());
    expect(clean.unavailableProviders).toEqual([]);
    // Different revisions: nothing keyed on revision may serve a partial picture as complete.
    expect(degraded.revision).not.toBe(clean.revision);
  });

  test("a stored effort a listed model lacks is sent as one it declares, read off the snapshot's listing", async () => {
    catalogDown();
    const { snapshot } = await snapshotServices(null).profileProviderSnapshot();
    // GLM 5.3 as the platform gateway lists it; it declares low, medium and high.
    const glm = snapshot.availableModels.find((spec) => spec.endsWith(`/${DEFAULT_WORKERS_AI_MODEL_ID}`));

    if (glm === undefined) throw new Error('the platform gateway lists no GLM 5.3');
    const catalog = { ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model: glm } } };

    const profile = resolveTurnProfile({
      envelope: { authority: { kind: 'account', accountId: 'acct-1' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
      provider: snapshot, roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [], explicitEffort: 'xhigh',
    });

    expect(profile.tier).toMatchObject({ model: glm, reasoningEffort: 'high' });
  });

  test('a complete listing is memoized, and only a change expires it', async () => {
    catalogUp();
    const services = snapshotServices(null);

    const first = await services.profileProviderSnapshot();
    expect(first.cache).toBe('miss');
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');

    services.invalidate();
    const afterChange = await services.profileProviderSnapshot();
    // Nothing here expires on a clock.
    expect(afterChange.cache).toBe('miss');
    expect(afterChange.snapshot.revision).toBe(first.snapshot.revision);
  });

  test('a degraded listing is never memoized, so recovery lands on the next turn', async () => {
    catalogDown();
    const services = degradedServices();

    const first = await services.profileProviderSnapshot();
    const second = await services.profileProviderSnapshot();

    expect(first.snapshot.unavailableProviders?.map((p) => p.provider)).toContain('catalog');
    // Caching this would hold the unverified-admission window open and freeze `revision` degraded.
    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('miss');
  });

  test('concurrent callers share one sweep instead of racing their own', async () => {
    const mock = catalogDown();
    // One sweep issues several catalog requests, so the claim is "three callers cost one sweep".
    await degradedServices().profileProviderSnapshot();
    const oneSweep = mock.matching('models.dev/api.json').length;
    expect(oneSweep).toBeGreaterThan(0);
    mock.reset();

    const services = degradedServices();

    const [a, b, c] = await Promise.all([
      services.profileProviderSnapshot(),
      services.profileProviderSnapshot(),
      services.profileProviderSnapshot(),
    ]);

    expect([a.cache, b.cache, c.cache].filter((outcome) => outcome === 'miss')).toHaveLength(1);
    expect([a.cache, b.cache, c.cache].filter((outcome) => outcome === 'joined')).toHaveLength(2);
    expect(b.snapshot.revision).toBe(a.snapshot.revision);
    expect(c.snapshot.revision).toBe(a.snapshot.revision);
    expect(mock.matching('models.dev/api.json')).toHaveLength(oneSweep);
  });

  test('a sweep the change landed on top of is answered, and never becomes the next turn\'s answer', async () => {
    // The snapshot reads the credential revision before the listing: a change landing mid-sweep
    // must
    // never be cached.
    const mock = catalogDown();
    const upstream = globalThis.fetch;
    const held = Promise.withResolvers<void>();
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await upstream(input, init);
      await held.promise;

      return response;
    });
    const services = snapshotServices(null);

    const inFlight = services.profileProviderSnapshot();

    while (mock.matching('models.dev/api.json').length === 0) await Promise.resolve();
    services.invalidate();
    held.resolve();
    const answered = await inFlight;

    expect(answered.snapshot.availableModels.length).toBeGreaterThan(0);
    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
  });

  test('a credential change the fan-out never delivered is caught at the next use', async () => {
    // The notification can fail silently: the only signal here is the account's own revision,
    // compared before the cache is read.
    catalogUp();
    let revision = 7;
    const services = snapshotServices(null, {}, async () => revision);

    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');

    revision = 8;

    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    // The same revision twice is a hit again: the compare costs one round trip, not a sweep.
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');
  });

  test('an authority that cannot answer leaves the cache alone rather than failing the turn', async () => {
    catalogUp();
    let refuse = false;

    const services = snapshotServices(null, {}, async () => {
      if (refuse) throw new Error('UserDO unreachable');

      return 1;
    });

    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    refuse = true;

    // An unanswerable freshness question must not cost the turn.
    const answered = await services.profileProviderSnapshot();
    expect(answered.cache).toBe('hit');
    expect(answered.snapshot.availableModels.length).toBeGreaterThan(0);
  });

  test('the account revision the compare reads rises with every credential mutation', async () => {
    const harness = createTestUserDO({ durableObjectId: 'owner-1' });
    const owner = await testOwner();

    const before = await harness.userDO.getCredentialsRevision(owner);
    await harness.userDO.setCredential(owner, 'openrouter.bearer', { kind: 'bearer', token: 'sk-or-1' });
    const afterConnect = await harness.userDO.getCredentialsRevision(owner);
    await harness.userDO.deleteCredential(owner, 'openrouter.bearer');
    const afterDisconnect = await harness.userDO.getCredentialsRevision(owner);

    expect(afterConnect).toBeGreaterThan(before);
    // A disconnect moves it too: a stale listing would offer a provider whose credential is gone.
    expect(afterDisconnect).toBeGreaterThan(afterConnect);
    harness.close();
  });
});

/** A snapshot's failure list is acted on by `profiles/resolve.ts`: asserted end to end. */
describe('a degraded listing versus a confirmed-missing model', () => {
  /** A catalog provider: on a models.dev outage its models vanish and the only failure row says
   *  `catalog`. */
  const PINNED = 'groq/llama-3.3-70b-versatile';

  function envelopeWithDeepPin(defaultModel: string): ProfileCatalogEnvelope {
    const catalog = {
      ...BUILTIN_PROFILE_CATALOG,
      tiers: {
        ...BUILTIN_PROFILE_CATALOG.tiers,
        default: { model: defaultModel },
        deep: { model: PINNED },
      },
    };

    return {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    };
  }

  function resolveWith(provider: ProviderCatalogSnapshot) {
    const defaultModel = provider.availableModels[0];

    if (!defaultModel) throw new Error('fixture needs at least one available model');

    return resolveTurnProfile({
      envelope: envelopeWithDeepPin(defaultModel),
      provider,
      roleId: 'task',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    });
  }

  test('one provider listing 503 does not classify its pinned tier as confirmed missing', async () => {
    catalogDown();
    const degraded = (await degradedServices().profileProviderSnapshot()).snapshot;
    expect(degraded.unavailableProviders?.map((p) => p.provider)).toContain('catalog');

    const profile = resolveWith(degraded);

    // Admitted unverified: the listing could not prove the model absent, and the signed catalog
    // stands.
    expect(profile.tiers.deep.model).toBe(PINNED);
    expect(profile.providerRevision).toBe(degraded.revision);
  });

  test('a provider that answers without the model moves its tier to the account default', async () => {
    catalogUp();
    const clean = (await snapshotServices(null).profileProviderSnapshot()).snapshot;
    expect(clean.unavailableProviders).toEqual([]);

    // An empty failure set asserts the listing was complete, so absence is proof the pinned model cannot serve.
    const profile = resolveWith(clean);
    expect(profile.tiers.deep.model).toBe(profile.tiers.default.model);
  });
});
