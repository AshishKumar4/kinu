import { TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO } from './helpers/user-do';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { testOwner } from './helpers/user-do';
import { generateText } from 'ai';
import { createMockFetch } from '@kinu.run/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedModelServices } from '../src/owned-model-services';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, asFetchFunction, profileCatalogDigest,
  resolveTurnProfile,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
} from '@kinu.run/core';
import type { LanguageModel } from 'ai';
import type { CredentialHeaders } from '../src/user/credential-headers';
import type { UserCaller } from '../src/user/workspace-capability';
import { platformGatewayEnv } from './helpers/platform-gateway';
import type { ProviderEnv } from '@kinu.run/core';

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
 * The provider snapshot: what it preserves, and when it is allowed to be reused.
 *
 * NOTE ON DETERMINISM — no test here mocks a HEALTHY models.dev. `models-dev.ts`
 * memoizes its catalog in a module-level variable for 5 minutes, so a healthy
 * fetch anywhere in this file would be served to every later test and the
 * degraded cases below would silently stop being degraded. A 503 is not cached
 * (it takes the `models_dev.catalog_fallback` path), so 503-only mocking is
 * order-independent.
 *
 * The two shapes used below are chosen because they differ in EXACTLY the failure
 * set: an owner-bound registry consults the dynamic catalog source, so a 503
 * there is a listing that failed; an unowned one has no dynamic source at all,
 * so the same 503 leaves its listing complete. Same models, one failure apart.
 */
function snapshotServices(
  owner: string | null,
  credentials: Readonly<Record<string, CredentialHeaders>> = {},
  /** The account credential revision this cache measures itself against. A
   *  constant is a world where nothing changed; a reader that moves is a
   *  mutation the fan-out may or may not have delivered. */
  getCredentialsRevision: () => Promise<number> = async () => 0,
): OwnedModelServices {
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

/** An owner-bound registry holding a CATALOG-backed credential: enumerating it
 *  needs models.dev, so a 503 there is a listing that genuinely FAILED. Without
 *  the credential there is nothing to enumerate and the same 503 is only a
 *  metadata fallback — which is exactly the clean case beside it. */
function degradedServices(): OwnedModelServices {
  return snapshotServices('owner-1', { 'groq.bearer': { Authorization: 'Bearer gsk' } });
}

function catalogDown() {
  const mock = createMockFetch([
    { match: 'models.dev/api.json', respond: { status: 503, body: 'upstream down' } },
  ]);
  globalThis.fetch = mock.fetch;
  return mock;
}

describe('OwnedModelServices — the provider snapshot', () => {
  // `profileProviderSnapshot()` now answers with core's `ProviderSnapshotRead`:
  // the snapshot AND how it was obtained. The cache outcome is what core writes
  // into the `profile_resolution` evidence row, and it is also what these tests
  // assert on — the previous ones compared object identity as a proxy for "was
  // the sweep re-run", which stopped meaning that once the snapshot became a
  // pure function of a cached LISTING. Asserting the reported outcome states the
  // claim directly.
  test('a failed provider listing is preserved, never dropped into model absence', async () => {
    catalogDown();

    const { snapshot } = await degradedServices().profileProviderSnapshot();

    expect(snapshot.unavailableProviders?.map((p) => p.provider)).toEqual(['catalog']);
    // The row is carried whole: a reader has the provider, a human label and the
    // real reason, so "could not ask" is distinguishable from "asked, absent".
    expect(snapshot.unavailableProviders?.[0]).toEqual({
      provider: 'catalog',
      label: 'models.dev catalog',
      reason: 'models.dev returned HTTP 503',
    });
  });

  test('revision moves when only the failure set moves', async () => {
    catalogDown();

    const degraded = (await degradedServices().profileProviderSnapshot()).snapshot;
    const clean = (await snapshotServices(null).profileProviderSnapshot()).snapshot;

    // Identical positive listings...
    expect(degraded.availableModels).toEqual(clean.availableModels);
    expect(clean.unavailableProviders).toEqual([]);
    // ...and still different revisions, which is the producer obligation: nothing
    // keyed on revision may serve a partial picture as though it were complete.
    expect(degraded.revision).not.toBe(clean.revision);
  });

  test('a complete listing is memoized, and only a change expires it', async () => {
    catalogDown();
    const services = snapshotServices(null);

    const first = await services.profileProviderSnapshot();
    expect(first.cache).toBe('miss');
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');

    services.invalidate();
    const afterChange = await services.profileProviderSnapshot();
    // Re-swept, and the world had not changed, so the revision is identical.
    // Nothing here expires on a clock.
    expect(afterChange.cache).toBe('miss');
    expect(afterChange.snapshot.revision).toBe(first.snapshot.revision);
  });

  test('a degraded listing is never memoized, so recovery lands on the next turn', async () => {
    catalogDown();
    const services = degradedServices();

    const first = await services.profileProviderSnapshot();
    const second = await services.profileProviderSnapshot();

    expect(first.snapshot.unavailableProviders).toHaveLength(1);
    // Swept again: caching this would hold the unverified-admission window open
    // past the fault and freeze `revision` at a degraded value.
    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('miss');
  });

  test('concurrent callers share one sweep instead of racing their own', async () => {
    const mock = catalogDown();
    // Baseline: what ONE sweep costs. Not a fixed number — a single sweep issues
    // more than one catalog request (enumeration, then metadata fallback), so
    // the claim being tested is "three callers cost one sweep", not "one fetch".
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

    // One sweep, and the two that arrived while it ran say so rather than
    // reporting a cache hit they never had.
    expect([a.cache, b.cache, c.cache].filter((outcome) => outcome === 'miss')).toHaveLength(1);
    expect([a.cache, b.cache, c.cache].filter((outcome) => outcome === 'joined')).toHaveLength(2);
    expect(b.snapshot.revision).toBe(a.snapshot.revision);
    expect(c.snapshot.revision).toBe(a.snapshot.revision);
    // This is the TTFT half: three streams opening together used to start three
    // credential sweeps, each one a models.dev and Codex refresh deep.
    expect(mock.matching('models.dev/api.json')).toHaveLength(oneSweep);
  });

  test('a sweep the change landed on top of is answered, and never becomes the next turn\'s answer', async () => {
    // The interleaving that matters, held open where it really happens: INSIDE
    // the sweep. `profileProviderSnapshot` now reads the account's credential
    // revision before it reads the listing, so a change arriving before that
    // read produces a post-change sweep (which is correct to cache, and is
    // covered by the revision compare below). What must still never be cached
    // is a sweep the change landed in the MIDDLE of.
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
    // The sweep is in flight once its first upstream call is parked.
    while (mock.matching('models.dev/api.json').length === 0) await Promise.resolve();
    services.invalidate();
    held.resolve();
    const answered = await inFlight;

    // Its own caller is answered — the listing really happened — but the result
    // describes the world before the change, so it must not become the answer
    // for every turn after it: the next read sweeps again rather than hitting.
    expect(answered.snapshot.availableModels.length).toBeGreaterThan(0);
    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
  });

  test('a credential change the fan-out never delivered is caught at the next use', async () => {
    // THE DURABLE HALF. The notification is a timeliness optimization and can
    // fail silently — a workspace that was unreachable, a waitUntil that lost
    // its request. Nothing here calls `invalidate()`: the only signal is the
    // account's own revision, compared before the cache is read.
    catalogDown();
    let revision = 7;
    const services = snapshotServices(null, {}, async () => revision);

    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');

    revision = 8;

    // Swept again, with no notification anywhere in the story. Before this, a
    // dropped notification meant the workspace served its stale catalog until
    // an unrelated invalidation happened to land.
    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    // And it settles: the same revision twice is a hit again, so the compare
    // costs one round trip rather than a sweep per turn.
    expect((await services.profileProviderSnapshot()).cache).toBe('hit');
  });

  test('an authority that cannot answer leaves the cache alone rather than failing the turn', async () => {
    catalogDown();
    let refuse = false;
    const services = snapshotServices(null, {}, async () => {
      if (refuse) throw new Error('UserDO unreachable');
      return 1;
    });

    expect((await services.profileProviderSnapshot()).cache).toBe('miss');
    refuse = true;

    // A cache-freshness question that cannot be answered must not cost the
    // turn: the fan-out and the next successful compare still repair it.
    const answered = await services.profileProviderSnapshot();
    expect(answered.cache).toBe('hit');
    expect(answered.snapshot.availableModels.length).toBeGreaterThan(0);
  });

  test('the account revision the compare reads rises with every credential mutation', async () => {
    // The write half, in the object that owns the store — so the number the
    // workspace compares against is the one the mutation actually moved.
    const harness = createTestUserDO({ durableObjectId: 'owner-1' });
    const owner = await testOwner();

    const before = await harness.userDO.getCredentialsRevision(owner);
    await harness.userDO.setCredential(owner, 'openrouter.bearer', { kind: 'bearer', token: 'sk-or-1' });
    const afterConnect = await harness.userDO.getCredentialsRevision(owner);
    await harness.userDO.deleteCredential(owner, 'openrouter.bearer');
    const afterDisconnect = await harness.userDO.getCredentialsRevision(owner);

    expect(afterConnect).toBeGreaterThan(before);
    // A DISCONNECT moves it too. That direction is the dangerous one: a
    // workspace holding the old listing would keep offering a provider whose
    // credential no longer exists.
    expect(afterDisconnect).toBeGreaterThan(afterConnect);
    harness.close();
  });
});

/**
 * The seam this producer exists to serve: a real snapshot resolved by core.
 *
 * The whole point of carrying failures is what the RESOLVER does with them, and
 * that is one decision made in two places — this file produces the evidence,
 * `profiles/resolve.ts` acts on it. Asserted end to end rather than on the shape
 * alone, because a snapshot that carries a perfect failure list into a resolver
 * that ignores it fixes nothing.
 */
describe('a degraded listing versus a confirmed-missing model', () => {
  /** A tier pinned to a model no listing here can see. Deliberately a catalog
   *  provider: on a models.dev outage its models vanish AND the only failure row
   *  says `catalog`, which is the case a prefix match would have missed. */
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
      roleId: 'general',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    });
  }

  test('one provider listing 503 does not classify its pinned tier as confirmed missing', async () => {
    catalogDown();
    const degraded = (await degradedServices().profileProviderSnapshot()).snapshot;
    expect(degraded.unavailableProviders).toHaveLength(1);

    const profile = resolveWith(degraded);

    // Admitted UNVERIFIED: the listing could not prove the model absent, and the
    // owner's signed catalog stands. Before this, one vendor being unreachable
    // refused every turn on the account — including turns whose own tier ran on
    // a provider that was answering perfectly.
    expect(profile.tiers.deep.model).toBe(PINNED);
    expect(profile.providerRevision).toBe(degraded.revision);
  });

  test('a provider that answers without the model still refuses', async () => {
    catalogDown();
    const clean = (await snapshotServices(null).profileProviderSnapshot()).snapshot;
    expect(clean.unavailableProviders).toEqual([]);

    // An empty failure set ASSERTS the listing was complete, so absence is proof
    // and the refusal is the correct answer rather than a guess.
    expect(() => resolveWith(clean)).toThrow(/unavailable on provider revision/);
  });
});
