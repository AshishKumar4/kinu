/**
 * Turn-profile resolution: a tier whose model can no longer serve runs on the account's default rather than
 * failing, a pinned model is never swapped, and a role must never widen what a turn may do.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ROLE_DEFINITIONS,
  parentReasoningEffort, profileCatalogDigest, providerListingOf, providerSnapshotOf, resolveTurnProfile,
  type PinnedProfile, type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type ResolveTurnProfileInput, type RoleDefinition, type TierAssignments,
} from '../src/profiles';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../src/providers/workers-ai';

const TIERS: TierAssignments = {
  default: { model: 'm-default' },
  fast: { model: 'm-fast', reasoningEffort: 'low' },
};

const SCOUT: RoleDefinition = {
  description: 'Explores.',
  instructions: 'Go look.',
  tier: 'fast',
  preset: 'research',
  allowedTools: ['search', 'read'],
  // Catalog-grade names only: the resolver normalizes whitespace and the wire schema refuses empties.
  skills: [' web-search ', 'deep-read'],
};

interface CatalogFixture {
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly tiers: TierAssignments;
}

interface CatalogOverrides {
  readonly roles?: Readonly<Record<string, RoleDefinition>>;
  readonly tiers?: TierAssignments;
}


function catalog(overrides: CatalogOverrides = {}): CatalogFixture {
  return { roles: overrides.roles ?? {}, tiers: overrides.tiers ?? TIERS };
}

function envelope(catalogFixture: CatalogFixture): ProfileCatalogEnvelope {
  return {
    authority: { kind: 'local' },
    version: 3,
    digest: profileCatalogDigest(catalogFixture),
    catalog: catalogFixture,
  };
}


function provider(availableModels = ['m-default', 'm-fast']): ProviderCatalogSnapshot {
  return { revision: 'rev-7', availableModels };
}

function resolve(overrides: Partial<ResolveTurnProfileInput> = {}) {
  const catalogFixture = catalog({ roles: { scout: SCOUT } });

  const input: ResolveTurnProfileInput = {
    envelope: envelope(catalogFixture),
    provider: provider(),
    roleId: 'task',
    workMode: 'build',
    availableTools: ['search', 'read', 'shell'],
    activeSkills: [],
    ...overrides,
  };

  return resolveTurnProfile(input);
}

function refusalMessage(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }

  throw new Error('expected resolution to refuse');
}

describe('tier resolution', () => {
  test('an explicit tier resolves itself and says so', () => {
    expect(resolve({ explicitTier: 'fast' }).tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
  });

  test('a role-declared tier resolves itself and says so', () => {
    expect(resolve({ roleId: 'scout', availableTools: [] }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
  });

  test("a workspace model overrides the role's tier model and reports source 'workspace'", () => {
    // A per-workspace pin from the composer's picker overrides the role's tier default.
    const profile = resolve({
      roleId: 'scout', availableTools: [], workspaceModel: 'm-pinned',
      provider: provider(['m-default', 'm-fast', 'm-pinned']),
    });

    expect(profile.tier).toEqual({
      id: 'fast', source: 'workspace', model: 'm-pinned', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
    // Catalog slots stay the account's: fixed-tier lanes never route through the pin.
    expect(profile.tiers.fast.model).toBe('m-fast');
  });

  test("a null workspace model leaves the tier's model", () => {
    expect(resolve({ roleId: 'scout', availableTools: [] }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
    expect(resolve({ roleId: 'scout', availableTools: [], workspaceModel: null }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
  });

  test('a workspace model nothing lists is refused, never silently swapped', () => {
    expect(() => resolve({
      roleId: 'scout', availableTools: [], workspaceModel: 'm-gone',
      provider: provider(['m-default', 'm-fast']),
    })).toThrow(/m-gone/);
  });

  test('every unconfigured non-default tier aliases default, marked as fallback', () => {
    const defaultOnly = catalog({ tiers: { default: { model: 'm-default' } } });

    for (const missing of ['fast', 'deep'] as const) {
      const profile = resolveTurnProfile({
        envelope: envelope(defaultOnly),
        provider: provider(),
        roleId: 'task',
        explicitTier: missing,
        workMode: 'build',
        availableTools: [],
        activeSkills: [],
      });

      expect(profile.tier).toEqual({
        id: 'default', source: 'default', model: 'm-default',
        reasoningEffort: 'medium', fallbacks: [], replaced: null,
      });
    }
  });

  test('a role naming an unconfigured tier aliases default too', () => {
    const catalogFixture = catalog({
      roles: { 'deep-thinker': { ...SCOUT, tier: 'deep' } },
      tiers: TIERS,
    });

    const profile = resolveTurnProfile({
      envelope: envelope(catalogFixture), provider: provider(), roleId: 'deep-thinker',
      workMode: 'build', availableTools: [], activeSkills: [],
    });

    expect(profile.tier.id).toBe('default');
    expect(profile.tier.source).toBe('default');
  });

  test('an omitted effort inherits the chat-stage default, not undefined', () => {
    expect(resolve().tier.reasoningEffort).toBe('medium');
  });
});

describe('declared reasoning efforts', () => {
  const declaring = (efforts: ProviderCatalogSnapshot['reasoningEfforts']): ProviderCatalogSnapshot => ({
    ...provider(), reasoningEfforts: efforts,
  });

  test('a stored effort the model does not declare is sent as the nearest declared level below it, or as its lowest level when none is below', () => {
    const sent = (explicitEffort: NonNullable<ResolveTurnProfileInput['explicitEffort']>) => resolve({
      explicitEffort, provider: declaring({ 'm-default': ['low', 'medium', 'high'] }),
    }).tier.reasoningEffort;

    expect(sent('xhigh')).toBe('high');
    expect(sent('max')).toBe('high');
    expect(sent('minimal')).toBe('low');
    expect(sent('medium')).toBe('medium');
  });

  test('each tier slot sends what its own model declares, and a model whose levels are unknown keeps what is stored', () => {
    // m-fast stores low and declares nothing below medium; m-default's levels are unknown.
    const profile = resolve({ explicitEffort: 'xhigh', provider: declaring({ 'm-fast': ['medium', 'high'] }) });

    expect(profile.tiers.fast.reasoningEffort).toBe('medium');
    expect(profile.tier.reasoningEffort).toBe('xhigh');
  });

  test('a model that declares no level is sent none, its empty list kept by the listing', () => {
    const listing = providerListingOf({
      models: [{ provider: 'anthropic', id: 'claude-haiku-4-5', reasoningEfforts: [] }, { provider: 'anthropic', id: 'claude-opus-4-7' }],
      failures: [],
    });

    const snapshot = providerSnapshotOf(listing);
    const tiers: TierAssignments = { default: { model: 'anthropic/claude-haiku-4-5', reasoningEffort: 'high' }, fast: { model: 'anthropic/claude-opus-4-7' } };

    const profile = resolveTurnProfile({
      envelope: envelope(catalog({ tiers })), provider: snapshot,
      roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [],
    });

    expect(profile.tier.reasoningEffort).toBeNull();
    expect(profile.tiers.fast.reasoningEffort).toBe('medium');
  });

  test('each fallback is sent the level the tier wants as that fallback declares it, like the model it stands in for', () => {
    const tiers: TierAssignments = { ...TIERS, default: { model: 'm-default', reasoningEffort: 'xhigh', fallbacks: ['m-backup', 'm-last'] } };

    const profile = resolveTurnProfile({
      envelope: envelope(catalog({ tiers })),
      provider: { ...provider(['m-default', 'm-fast', 'm-backup', 'm-last']), reasoningEfforts: {
        'm-default': ['low', 'medium', 'high', 'xhigh'], 'm-backup': ['low', 'medium', 'high'], 'm-last': [],
      } },
      roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [],
    });

    expect(profile.tier.reasoningEffort).toBe('xhigh');
    expect(profile.tier.fallbacks).toEqual([{ model: 'm-backup', reasoningEffort: 'high' }, { model: 'm-last', reasoningEffort: null }]);
    expect(profile.tiers.default.fallbacks).toEqual(profile.tier.fallbacks);
  });
});

describe("a hire's effort", () => {
  const tiers: TierAssignments = { ...TIERS, steady: { model: 'm-default', reasoningEffort: 'medium' } };
  const roles = { steady: { ...SCOUT, tier: 'steady' } };

  const authority = {
    envelope: envelope(catalog({ roles, tiers })),
    provider: { ...provider(['m-default', 'm-fast', 'm-small']), reasoningEfforts: {
      'm-default': ['low', 'medium', 'high', 'xhigh'], 'm-small': ['low', 'medium', 'high'],
    } } satisfies ProviderCatalogSnapshot,
  };

  const pinned = (role: string, pins: { readonly model?: string; readonly effort?: 'xhigh' } = {}): PinnedProfile => ({
    getRoleSelection: () => role,
    getAssignedTier: () => null,
    getModel: () => pins.model ?? null,
    getReasoningEffort: () => pins.effort ?? null,
  });

  const hire = (role: string, ancestors: readonly PinnedProfile[], model: string | null = null) => resolveTurnProfile({
    ...authority, roleId: role, actorModel: model, inheritedEffort: parentReasoningEffort(authority, ancestors),
    workMode: 'build', availableTools: [], activeSkills: [],
  }).tier.reasoningEffort;

  test('under an xhigh parent a tier with no effort runs at xhigh as its model takes it; a tier at medium keeps medium', () => {
    const root = [pinned('task', { effort: 'xhigh' })];

    expect(hire('task', root)).toBe('xhigh');
    expect(hire('task', root, 'm-small')).toBe('high');
    expect(hire('steady', root)).toBe('medium');
  });

  test("a hire's hire takes the effort its parent runs at, which that parent took from the root", () => {
    const chain = [pinned('task'), pinned('task', { effort: 'xhigh' })];

    expect(hire('task', chain)).toBe('xhigh');
    expect(hire('task', [pinned('steady'), pinned('task', { effort: 'xhigh' })])).toBe('medium');
  });
});

describe('provider availability', () => {
  test('a stored tier whose model a complete listing no longer holds is served by the account default tier', () => {
    // A retired model cannot serve, so the tier's turns run on the account's default instead of failing.
    const profile = resolve({ roleId: 'scout', explicitTier: 'fast', availableTools: [], provider: provider(['m-default']) });

    // The swap names what it replaced, so the person is told which model runs and why.
    expect(profile.tier).toEqual({ id: 'default', source: 'default', model: 'm-default', reasoningEffort: 'medium', fallbacks: [], replaced: 'm-fast' });
    expect(profile.tiers.fast.model).toBe('m-default');
  });

  test("with the account default retired too, Kinu's default model serves the tier", () => {
    // Retired from the provider that serves Kinu's default, so its listing proves them gone.
    const retired = catalog({ roles: { scout: SCOUT }, tiers: { default: { model: 'workers-ai/m-gone' }, fast: { model: 'workers-ai/m-also-gone' } } });

    const profile = resolve({
      envelope: envelope(retired), roleId: 'scout', availableTools: [], provider: provider([DEFAULT_WORKERS_AI_MODEL_SPEC]),
    });

    expect(profile.tier.model).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(profile.tiers.default.model).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
  });

  test('with no default listed either, the tier refuses, naming itself and the provider revision', () => {
    // Kinu's default is on a provider that lists another model, so it is proven gone too.
    const message = refusalMessage(() => {
      resolve({ explicitTier: 'fast', availableTools: [], provider: provider(['m-other', 'workers-ai/@cf/other']) });
    });

    expect(message).toContain('fast');
    expect(message).toContain('rev-7');
  });

  // A listing failure is not an absence: treating it as one let one vendor's 503 refuse every turn on
  // the account.
  const degraded = (models: string[]): ProviderCatalogSnapshot => ({
    revision: 'rev-7-degraded',
    availableModels: models,
    unavailableProviders: [{ provider: 'vendor-b', label: 'Vendor B', reason: 'HTTP 503' }],
  });

  test('a model missing while a listing FAILED resolves, unverified, rather than refusing', () => {
    const profile = resolve({
      roleId: 'scout', explicitTier: 'fast', availableTools: [],
      provider: degraded(['m-default']),
    });

    // Never looked up, so nothing disproved it: the tier keeps its model rather than moving to the default.
    expect(profile.tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low', fallbacks: [], replaced: null,
    });
  });

  test('the SAME missing model moves to the default only once the listing is complete', () => {
    // Identical catalog and availableModels; only the snapshot's listing-failure admission differs.
    const clean: ProviderCatalogSnapshot = { revision: 'rev-7', availableModels: ['m-default'] };

    const asking = (snapshot: ProviderCatalogSnapshot) => resolve({
      roleId: 'scout', explicitTier: 'fast', availableTools: [], provider: snapshot,
    }).tier.model;

    // Absent and empty both mean "enumerated everything", so producers without a failure channel are
    // not treated as degraded.
    expect(asking(clean)).toBe('m-default');
    expect(asking({ ...clean, unavailableProviders: [] })).toBe('m-default');
    expect(asking(degraded(['m-default']))).toBe('m-fast');
  });

  test('a model moves only when its own provider lists models and leaves it out; a provider that lists nothing proves nothing', () => {
    // An OpenAI-compatible endpoint whose `/models` answers an empty list is complete and names nothing.
    const tiers: TierAssignments = {
      default: { model: 'openai/gpt-live' }, fast: { model: 'openai/retired' }, deep: { model: 'openai-compatible/house-model' },
    };

    const profile = resolveTurnProfile({
      envelope: envelope(catalog({ tiers })), provider: provider(['openai/gpt-live']),
      roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [],
    });

    expect(profile.tiers.fast.model).toBe('openai/gpt-live');
    expect(profile.tiers.deep.model).toBe('openai-compatible/house-model');
  });

  test('a degraded listing does not refuse a turn over an unrelated tier slot', () => {
    // tierSlot validates every configured tier, so a degraded pin on one tier must not refuse other tiers.
    const profile = resolve({
      roleId: 'task', availableTools: [], provider: degraded(['m-default']),
    });

    expect(profile.tier.model).toBe('m-default');
    expect(profile.tiers.fast.model).toBe('m-fast');
  });
});

describe('fallback chains', () => {
  const chained: TierAssignments = {
    default: { model: 'm-default', fallbacks: ['m-backup', 'm-last'] },
    fast: { model: 'm-fast', reasoningEffort: 'low' },
  };

  const run = (extra: Partial<ResolveTurnProfileInput>) => resolveTurnProfile({
    envelope: envelope(catalog({ tiers: chained })), provider: provider(['m-default', 'm-fast', 'm-backup', 'm-last']),
    roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [], ...extra,
  });

  // No model here declares its levels, so each entry is sent the tier's own.
  const chainOf = (...models: string[]) => models.map((model) => ({ model, reasoningEffort: 'medium' as const }));

  test("the turn and every tier slot carry the tier's fallbacks in order", () => {
    const profile = run({});

    expect(profile.tier).toMatchObject({ id: 'default', model: 'm-default', fallbacks: chainOf('m-backup', 'm-last') });
    expect(profile.tiers.default?.fallbacks).toEqual(chainOf('m-backup', 'm-last'));
    expect(profile.tiers.fast?.fallbacks).toEqual([]);
    // An unconfigured slot aliases default, chain included.
    expect(profile.tiers.deep?.fallbacks).toEqual(chainOf('m-backup', 'm-last'));
  });

  test('a workspace pin runs first; the fallbacks follow it, never repeating it', () => {
    expect(run({ workspaceModel: 'm-backup' }).tier).toMatchObject({ model: 'm-backup', fallbacks: chainOf('m-last') });
  });

  test('an unlisted model with a listed fallback resolves: its call fails and yields to the fallback', () => {
    const profile = run({ provider: provider(['m-fast', 'm-last']) });

    expect(profile.tier).toMatchObject({ model: 'm-default', fallbacks: chainOf('m-backup', 'm-last') });
  });

  test('a chain none of whose models is listed refuses, naming the tier model and its fallbacks', () => {
    expect(refusalMessage(() => run({ provider: provider(['m-fast', 'workers-ai/@cf/other']) })))
      .toContain('model "m-default" configured for the default tier is unavailable on provider revision "rev-7", as is each of its fallbacks');
  });
});

describe('role validation', () => {
  test('built-ins resolve from an empty catalog', () => {
    const profile = resolveTurnProfile({
      envelope: envelope(catalog()),
      provider: provider(),
      roleId: 'task',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    });

    expect(profile.role).toEqual({
      id: 'task', label: 'Task',
      description: BUILTIN_ROLE_DEFINITIONS.task.description,
      instructions: BUILTIN_ROLE_DEFINITIONS.task.instructions,
    });
    // general declares the default tier, which is always configured.
    expect(profile.tier.source).toBe('role');
    expect(profile.defaultPreset).toBe('ideate');
  });

  test('an unknown role refuses, listing what exists', () => {
    const message = refusalMessage(() => {
      resolve({ roleId: 'wizard' });
    });

    expect(message).toContain('wizard');
    expect(message).toContain('task');
  });

  test('malformed ids, tiers and work modes refuse before any lookup', () => {
    expect(() => resolve({ roleId: 'Not_Valid' })).toThrow(/role id/);
    // Removed tiers (#7) are unknown now, not aliases of their replacements.
    expect(() => resolve({ explicitTier: 'Mega!' })).toThrow(/explicit tier/);
    expect(() => resolve({ explicitTier: 'tiny' })).toThrow(/unknown tier "tiny": known tiers are fast, default, deep/);
    expect(() => resolve({ explicitTier: 'slow' })).toThrow(/unknown tier/);
    expect(() => resolve({ workMode: 'auto' })).toThrow(/work mode/);
  });

  test('an owner-added tier resolves by name, explicitly and through a role, and appears in the tier table', () => {
    const withReview = catalog({
      tiers: { default: { model: 'm-default' }, review: { model: 'm-review', reasoningEffort: 'high' } },
      roles: { critic: { ...SCOUT, tier: 'review' } },
    });

    const run = (extra: Partial<ResolveTurnProfileInput>) => resolveTurnProfile({
      envelope: envelope(withReview), provider: provider(['m-default', 'm-review']), roleId: 'task',
      workMode: 'build', availableTools: [], activeSkills: [], ...extra,
    });

    expect(run({ explicitTier: 'review' }).tier).toEqual({ id: 'review', source: 'explicit', model: 'm-review', reasoningEffort: 'high', fallbacks: [], replaced: null });
    expect(run({ roleId: 'critic' }).tier).toEqual({ id: 'review', source: 'role', model: 'm-review', reasoningEffort: 'high', fallbacks: [], replaced: null });
    expect(Object.keys(run({}).tiers)).toEqual(['fast', 'default', 'deep', 'review']);
  });

  test('a tampered catalog fails digest verification at the turn boundary', () => {
    const catalogFixture = catalog();
    const env = { ...envelope(catalogFixture), digest: `${'0'.repeat(64)}` };
    expect(() => resolve({ envelope: env })).toThrow(/digest mismatch/);
  });
});

describe('action narrowing', () => {
  test('the role list intersects the available set, order preserved', () => {
    expect(resolve({ roleId: 'scout' }).allowedTools).toEqual(['search', 'read']);
  });

  test('no allowedTools field means the full merged surface, de-duplicated', () => {
    expect(resolve({ availableTools: ['shell', 'search', 'search'] }).allowedTools)
      .toEqual(['shell', 'search']);
  });
  test('a role can never widen: names absent from the surface never appear', () => {
    const catalogFixture = catalog({ roles: { 'ghost-hunter': { ...SCOUT, allowedTools: ['seance', 'search'] } } });

    const profile = resolveTurnProfile({
      envelope: envelope(catalogFixture), provider: provider(), roleId: 'ghost-hunter',
      workMode: 'build', availableTools: ['search'], activeSkills: [],
    });

    expect(profile.allowedTools).toEqual(['search']);
  });
});

describe('skills', () => {
  test('role skills join active skills trimmed, deduped, empties gone, order stable', () => {
    expect(resolve({ roleId: 'scout', activeSkills: ['deep-read', ' notes ', ''] }).skills)
      .toEqual(['web-search', 'deep-read', 'notes']);
  });
});

describe('permission mode', () => {
  test('plan:true narrows build to plan', () => {
    const profile = resolve({ roleId: 'planner' });
    expect(profile.workMode).toBe('plan');
    expect(profile.tier.id).toBe('default');
    expect(profile.tier.source).toBe('default');
    expect(profile.defaultPreset).toBe('ideate');
  });

  test('plan stays plan, and nothing widens it back', () => {
    expect(resolve({ roleId: 'planner', workMode: 'plan' }).workMode).toBe('plan');
  });

  test('roles without plan inherit the mode untouched', () => {
    expect(resolve({ roleId: 'task' }).workMode).toBe('build');
  });
});

describe('output discipline', () => {
  test('the resolved profile is deeply immutable', () => {
    const profile = resolve({ roleId: 'scout' });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.role)).toBe(true);
    expect(Object.isFrozen(profile.tier)).toBe(true);
    expect(Object.isFrozen(profile.skills)).toBe(true);
    expect(Object.isFrozen(profile.allowedTools)).toBe(true);
    expect(Object.isFrozen(profile.authority)).toBe(true);
    expect(() => Object.defineProperty(profile.allowedTools, profile.allowedTools.length, {
      value: 'shell',
    })).toThrow();
  });

  test('resolution is deterministic: same inputs, identical output', () => {
    const input = { roleId: 'scout', activeSkills: ['x'] } satisfies Partial<ResolveTurnProfileInput>;
    expect(resolve(input)).toEqual(resolve(input));
    expect(JSON.stringify(resolve(input))).toBe(JSON.stringify(resolve(input)));
  });

  test('authority, versions and revisions ride through', () => {
    const catalogFixture = catalog();
    const env = { ...envelope(catalogFixture), authority: { kind: 'account' as const, accountId: 'acct-9' }, version: 12 };
    const profile = resolve({ envelope: env });
    expect(profile.authority).toEqual({ kind: 'account', accountId: 'acct-9' });
    expect(profile.catalogVersion).toBe(12);
    expect(profile.providerRevision).toBe('rev-7');
    expect(profile.digest).not.toBe(env.digest);
    expect(profile.digest).toHaveLength(64);
  });
});
