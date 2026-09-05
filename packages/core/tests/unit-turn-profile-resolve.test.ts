/**
 * Turn-profile resolution — every fallback, every refusal, and the narrowing
 * guarantee, proved against the public resolver.
 *
 * The two failures this file exists to keep impossible: a resolver that
 * silently substitutes a model when the configured one is unavailable (spend
 * and reproducibility both lie afterwards), and a role that widens what a turn
 * may do. Everything else here pins the contract's small surface: one tier
 * fallback rule, intersection-only actions, normalized skills, plan-narrows-
 * only, and output that is frozen and deterministic.
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
  // Catalog-grade names only: whitespace and empties are runtime-input
  // concerns, normalized by the resolver, refused by the wire schema.
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
    roleId: 'general',
    workMode: 'build',
    availableTools: ['search', 'read', 'run'],
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
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low',
    });
  });

  test('a role-declared tier resolves itself and says so', () => {
    expect(resolve({ roleId: 'scout', availableTools: [] }).tier).toEqual({
      id: 'fast', source: 'role', model: 'm-fast', reasoningEffort: 'low',
    });
  });

  test('every unconfigured non-default tier aliases default, marked as fallback', () => {
    const defaultOnly = catalog({ tiers: { default: { model: 'm-default' } } });
    for (const missing of ['tiny', 'fast', 'slow', 'deep'] as const) {
      const profile = resolveTurnProfile({
        envelope: envelope(defaultOnly),
        provider: provider(),
        roleId: 'general',
        explicitTier: missing,
        workMode: 'build',
        availableTools: [],
        activeSkills: [],
      });
      expect(profile.tier).toEqual({
        id: 'default', source: 'default', model: 'm-default',
        reasoningEffort: 'medium',
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
    // The fast tier names m-fast; the provider lost it. The failure must name
    // the model — resolving to m-default instead would spend money the caller
    // did not configure.
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

  // A LISTING FAILURE IS NOT AN ABSENCE. `availableModels` is a positive list,
  // so a model missing from it means either "the provider answered and does not
  // have it" or "nobody managed to ask". Treating the second as the first is how
  // one vendor's 503 came to refuse every turn on the account — including turns
  // whose own tier runs somewhere else entirely, because the resolver checks all
  // five slots.
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
    // The configured model stands: it was never looked up, so nothing about it
    // was disproved, and substituting m-default would be the silent swap the
    // test above forbids.
    expect(profile.tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low',
    });
  });

  test('the SAME missing model refuses once the listing is complete', () => {
    // The pair that makes the distinction observable: identical catalog,
    // identical availableModels, and the only difference is whether the
    // snapshot admits a listing failed.
    const clean: ProviderCatalogSnapshot = { revision: 'rev-7', availableModels: ['m-default'] };
    const asking = (snapshot: ProviderCatalogSnapshot) => () => resolve({
      roleId: 'scout', explicitTier: 'fast', availableTools: [], provider: snapshot,
    });
    // Absent and empty are the SAME assertion — "I enumerated everything" — so
    // a producer with no failure channel is not accidentally treated as
    // degraded, which would disable the check for every caller that predates it.
    expect(asking(clean)).toThrow(/m-fast/);
    expect(asking({ ...clean, unavailableProviders: [] })).toThrow(/m-fast/);
    // A degraded listing keeps the configured model: it was never looked up, so nothing disproved it.
    expect(asking(degraded(['m-default']))().tier).toEqual({
      id: 'fast', source: 'explicit', model: 'm-fast', reasoningEffort: 'low',
    });
  });

  test('a degraded listing does not refuse a turn over an unrelated tier slot', () => {
    // The composed failure: `tierSlot` validates every configured tier, so
    // before this rule an account pinning ANY tier to a degraded provider's
    // model refused every turn, whatever tier that turn itself ran at.
    const profile = resolve({
      roleId: 'general', availableTools: [], provider: degraded(['m-default']),
    });
    expect(profile.tier.model).toBe('m-default');
    expect(profile.tiers.fast.model).toBe('m-fast');
  });
});

describe('role validation', () => {
  test('built-ins resolve from an empty catalog', () => {
    const profile = resolveTurnProfile({
      envelope: envelope(catalog()),
      provider: provider(),
      roleId: 'general',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    });
    expect(profile.role).toEqual({
      id: 'general', label: 'General',
      description: BUILTIN_ROLE_DEFINITIONS.general.description,
      instructions: BUILTIN_ROLE_DEFINITIONS.general.instructions,
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
    expect(message).toContain('general');
  });

  test('malformed ids, tiers and work modes refuse before any lookup', () => {
    expect(() => resolve({ roleId: 'Not_Valid' })).toThrow(/role id/);
    expect(() => resolve({ explicitTier: 'mega' })).toThrow(/explicit tier/);
    expect(() => resolve({ workMode: 'auto' })).toThrow(/work mode/);
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
    expect(resolve({ availableTools: ['run', 'search', 'search'] }).allowedTools)
      .toEqual(['run', 'search']);
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
    expect(resolve({ roleId: 'implementer' }).workMode).toBe('build');
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
      value: 'run',
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
