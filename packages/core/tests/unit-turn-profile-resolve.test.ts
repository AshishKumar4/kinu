/**
 * Turn-profile resolution: a resolver must never silently substitute an unavailable model, and a
 * role must never widen what a turn may do.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ROLE_DEFINITIONS,
  profileCatalogDigest, resolveTurnProfile,
  type ProfileCatalogEnvelope, type ProviderCatalogSnapshot,
  type ResolveTurnProfileInput, type RoleDefinition, type TierAssignments,
} from '../src/profiles';

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
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
    });
  });

  test('a role-declared tier resolves itself and says so', () => {
    expect(resolve({ roleId: 'scout', availableTools: [] }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
    });
  });

  test("a workspace model overrides the role's tier model and reports source 'workspace'", () => {
    // A per-workspace pin from the composer's picker overrides the role's tier default.
    const profile = resolve({
      roleId: 'scout', availableTools: [], workspaceModel: 'm-pinned',
      provider: provider(['m-default', 'm-fast', 'm-pinned']),
    });

    expect(profile.tier).toEqual({
      id: 'fast', source: 'workspace', model: 'm-pinned', reasoningEffort: 'low', fallbacks: [],
    });
    // Catalog slots stay the account's: fixed-tier lanes never route through the pin.
    expect(profile.tiers.fast.model).toBe('m-fast');
  });

  test("a null workspace model leaves the tier's model", () => {
    expect(resolve({ roleId: 'scout', availableTools: [] }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
    });
    expect(resolve({ roleId: 'scout', availableTools: [], workspaceModel: null }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
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
        reasoningEffort: 'medium', fallbacks: [],
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

describe('provider availability', () => {
  test('a configured but unavailable model is an error, never a silent swap', () => {
    // Resolving to m-default instead would spend money the caller did not configure.
    expect(() => resolve({ roleId: 'scout', explicitTier: 'fast', availableTools: [], provider: provider(['m-default']) }))
      .toThrow(/m-fast/);
    expect(() => resolve({ roleId: 'scout', availableTools: [], provider: provider(['m-default']) }))
      .toThrow(/unavailable/);
  });

  test('the error names the tier and provider revision so the fix is findable', () => {
    const message = refusalMessage(() => {
      resolve({ explicitTier: 'fast', availableTools: [], provider: provider(['m-default']) });
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

    // Never looked up, so nothing disproved it; substituting m-default is the swap forbidden above.
    expect(profile.tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
    });
  });

  test('the SAME missing model refuses once the listing is complete', () => {
    // Identical catalog and availableModels; only the snapshot's listing-failure admission differs.
    const clean: ProviderCatalogSnapshot = { revision: 'rev-7', availableModels: ['m-default'] };

    const asking = (snapshot: ProviderCatalogSnapshot) => () => resolve({
      roleId: 'scout', explicitTier: 'fast', availableTools: [], provider: snapshot,
    });

    // Absent and empty both mean "enumerated everything", so producers without a failure channel are
    // not treated as degraded.
    expect(asking(clean)).toThrow(/m-fast/);
    expect(asking({ ...clean, unavailableProviders: [] })).toThrow(/m-fast/);
    expect(asking(degraded(['m-default']))().tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low', fallbacks: [],
    });
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

  test("the turn and every tier slot carry the tier's fallbacks in order", () => {
    const profile = run({});

    expect(profile.tier).toMatchObject({ id: 'default', model: 'm-default', fallbacks: ['m-backup', 'm-last'] });
    expect(profile.tiers.default?.fallbacks).toEqual(['m-backup', 'm-last']);
    expect(profile.tiers.fast?.fallbacks).toEqual([]);
    // An unconfigured slot aliases default, chain included.
    expect(profile.tiers.deep?.fallbacks).toEqual(['m-backup', 'm-last']);
  });

  test('a workspace pin runs first; the fallbacks follow it, never repeating it', () => {
    expect(run({ workspaceModel: 'm-backup' }).tier).toMatchObject({ model: 'm-backup', fallbacks: ['m-last'] });
  });

  test('an unlisted model with a listed fallback resolves: its call fails and yields to the fallback', () => {
    const profile = run({ provider: provider(['m-fast', 'm-last']) });

    expect(profile.tier).toMatchObject({ model: 'm-default', fallbacks: ['m-backup', 'm-last'] });
  });

  test('a chain none of whose models is listed refuses, naming the tier model and its fallbacks', () => {
    expect(refusalMessage(() => run({ provider: provider(['m-fast']) })))
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

    expect(run({ explicitTier: 'review' }).tier).toEqual({ id: 'review', source: 'explicit', model: 'm-review', reasoningEffort: 'high', fallbacks: [] });
    expect(run({ roleId: 'critic' }).tier).toEqual({ id: 'review', source: 'role', model: 'm-review', reasoningEffort: 'high', fallbacks: [] });
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
