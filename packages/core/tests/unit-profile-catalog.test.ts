/**
 * The profile catalog wire format — what an authority may ship, and what every
 * validator refuses.
 *
 * Two defect classes live here. First, duplicated identity: role ids are record
 * keys and catalog version is envelope metadata, so a definition carrying `id`
 * or a catalog carrying `version` is a second source of truth in the making —
 * strict parsing rejects both rather than stripping them. Second, digest drift:
 * the digest must be pure content, so key insertion order cannot move it and
 * envelope metadata cannot hide inside it.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PROFILE_CATALOG, BUILTIN_ROLE_DEFINITIONS, BUILTIN_ROLE_IDS,
  TIER_IDS, deriveRoleLabel, profileCatalogDigest, validateProfileCatalog,
  validateProfileCatalogEnvelope,
  type BuiltinRoleId, type ProfileCatalog,
  type ProfileCatalogEnvelope, type RoleDefinition, type TierId,
} from '../src/profiles';
import type { NamedSwarmPreset } from '../src/strategy/swarm';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../src/providers/workers-ai';
import type { JsonValue } from '../src/utils/json';

const SCOUT: RoleDefinition = {
  description: 'Explores.',
  instructions: 'Go look.',
  tier: 'fast',
  preset: 'research',
};

const BUILTINS: Readonly<Record<BuiltinRoleId, RoleDefinition>> = BUILTIN_ROLE_DEFINITIONS;

const VALID_CATALOG = {
  roles: { scout: SCOUT },
  tiers: { default: { model: 'm-default' } },
} satisfies ProfileCatalog;

interface EnvelopeOverrides {
  authority?: JsonValue;
  version?: number;
  digest?: string;
  label?: string;
}

function envelopeWith(
  catalogInput: ProfileCatalog,
  overrides: EnvelopeOverrides = {},
): ProfileCatalogEnvelope {
  return validateProfileCatalogEnvelope({
    authority: { kind: 'local' },
    version: 0,
    digest: profileCatalogDigest(VALID_CATALOG),
    catalog: catalogInput,
    ...overrides,
  });
}

describe('catalog validation', () => {
  test('a minimal valid catalog parses', () => {
    expect(validateProfileCatalog(VALID_CATALOG)).toEqual(VALID_CATALOG);
  });

  test('unknown tier, unnamed preset and empty prose all refuse', () => {
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { x: { ...VALID_CATALOG.roles.scout, tier: 'ultra' } } }))
      .toThrow(/invalid profile catalog/);
    // `custom` is deliberately NOT a named preset: it means "no preset".
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { x: { ...VALID_CATALOG.roles.scout, preset: 'custom' } } }))
      .toThrow(/invalid profile catalog/);
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { x: { ...VALID_CATALOG.roles.scout, description: '' } } }))
      .toThrow(/description/);
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { x: { ...SCOUT, skills: ['ok', ''] } } }))
      .toThrow(/skills/);
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, tiers: { default: { model: '' } } }))
      .toThrow(/model/);
  });

  test('role keys must be kebab-case ids within the length cap', () => {
    for (const bad of ['Bad', '-lead', 'ok-', 'has_underscore', `${'a'.repeat(65)}`]) {
      const roles = { [bad]: VALID_CATALOG.roles.scout };
      expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles })).toThrow(/invalid profile catalog/);
    }
  });

  test('a definition carrying its own id is rejected, not stripped', () => {
    // Ids live only as record keys; a second copy invites the two drifting.
    const roles = { scout: { id: 'scout', ...VALID_CATALOG.roles.scout } };
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles })).toThrow(/id/);
  });

  test('a catalog carrying envelope version is rejected', () => {
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, version: 4 })).toThrow(/version/);
  });

  test('spawns accepts wildcard, built-ins and roles in the same catalog only', () => {
    const base = VALID_CATALOG.roles.scout;
    expect(() => validateProfileCatalog({
      ...VALID_CATALOG,
      roles: {
        a: { ...base, spawns: '*' },
        b: { ...base, spawns: ['a', 'general'] },
      },
    })).not.toThrow();
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { b: { ...base, spawns: ['NOPE'] } } }))
      .toThrow(/invalid profile catalog/);
    // `not-there` is well-formed but resolves to no current role.
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: { b: { ...base, spawns: ['not-there'] } } }))
      .toThrow(/spawns/);
  });

  test('plan narrows only: false is not `true`', () => {
    const roles = { p: { ...VALID_CATALOG.roles.scout, plan: true } };
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles })).not.toThrow();
    const roles2 = { p: { ...VALID_CATALOG.roles.scout, plan: false } };
    expect(() => validateProfileCatalog({ ...VALID_CATALOG, roles: roles2 })).toThrow(/invalid profile catalog/);
  });
});

describe('envelope validation', () => {
  test('version 0 is legal: a pristine authority has never been written', () => {
    const env = envelopeWith(VALID_CATALOG);
    expect(env.version).toBe(0);
  });

  test('fractional and negative versions, bad authorities and short digests refuse', () => {
    expect(() => envelopeWith(VALID_CATALOG, { version: 1.5 })).toThrow(/version/);
    expect(() => envelopeWith(VALID_CATALOG, { version: -1 })).toThrow(/version/);
    expect(() => envelopeWith(VALID_CATALOG, { authority: { kind: 'team' } })).toThrow(/authority/);
    expect(() => envelopeWith(VALID_CATALOG, { authority: { kind: 'account' } })).toThrow(/accountId/);
    expect(() => envelopeWith(VALID_CATALOG, { digest: 'nothex' })).toThrow(/digest/);
    expect(() => envelopeWith(VALID_CATALOG, { digest: `${'ab'.repeat(31)}g` })).toThrow();
  });

  test('an envelope carrying an extra top-level field refuses', () => {
    expect(() => envelopeWith(VALID_CATALOG, { label: 'x' })).toThrow(/label/);
  });
});

describe('the digest', () => {
  test('is insertion-order independent', () => {
    const reordered: ProfileCatalog = {
      tiers: { default: { model: 'm-default' } },
      roles: { scout: { preset: 'research', tier: 'fast', instructions: 'Go look.', description: 'Explores.' } },
    };
    expect(profileCatalogDigest(reordered)).toBe(profileCatalogDigest(VALID_CATALOG));
  });

  test('moves when content moves', () => {
    const changed = structuredClone(VALID_CATALOG);
    changed.tiers.default.model = 'm-other';
    expect(profileCatalogDigest(changed)).not.toBe(profileCatalogDigest(VALID_CATALOG));
  });

  test('is full-length hexadecimal', () => {
    expect(profileCatalogDigest(VALID_CATALOG)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('built-in defaults', () => {
  test('six roles, exactly the declared ids', () => {
    expect(Object.keys(BUILTIN_ROLE_DEFINITIONS).sort()).toEqual([...BUILTIN_ROLE_IDS].sort());
    expect(BUILTIN_ROLE_IDS).toHaveLength(6);
  });

  test('each ships the contracted tier and preset', () => {
    const expected = {
      general: ['default', 'ideate'],
      researcher: ['fast', 'research'],
      planner: ['slow', 'ideate'],
      implementer: ['default', 'optimise'],
      auditor: ['slow', 'audit'],
      designer: ['default', 'ideate'],
    } satisfies Record<BuiltinRoleId, readonly [TierId, NamedSwarmPreset]>;
    for (const id of BUILTIN_ROLE_IDS) {
      expect(BUILTINS[id].tier).toBe(expected[id][0]);
      expect(BUILTINS[id].preset).toBe(expected[id][1]);
    }
    expect(BUILTINS.planner.plan).toBe(true);
    for (const id of BUILTIN_ROLE_IDS) {
      if (id !== 'planner') expect(BUILTINS[id].plan).toBeUndefined();
    }
  });

  test('built-ins carry no labels and no duplicate identity fields', () => {
    for (const role of Object.values(BUILTINS)) {
      expect(role.label).toBeUndefined();
      expect('id' in role).toBe(false);
    }
  });

  test('the builtin catalog validates, pins the platform default model, and digests stably', () => {
    expect(() => validateProfileCatalog(BUILTIN_PROFILE_CATALOG)).not.toThrow();
    expect(Object.keys(BUILTIN_PROFILE_CATALOG.tiers)).toEqual(['default']);
    expect(BUILTIN_PROFILE_CATALOG.tiers.default.model).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(profileCatalogDigest(BUILTIN_PROFILE_CATALOG))
      .toBe(profileCatalogDigest(structuredClone(BUILTIN_PROFILE_CATALOG)));
  });

  test('every tier id the resolver knows is declared', () => {
    expect([...TIER_IDS]).toEqual(['tiny', 'fast', 'default', 'slow', 'deep']);
  });
});

describe('labels', () => {
  test('derive from the id when absent', () => {
    expect(deriveRoleLabel('general')).toBe('General');
    expect(deriveRoleLabel('release-captain')).toBe('Release Captain');
  });
});

describe('envelope round trip', () => {
  test('account authority survives validation unchanged', () => {
    const env = envelopeWith(VALID_CATALOG, { authority: { kind: 'account', accountId: 'acct-1' }, version: 7 });
    expect(env.authority).toEqual({ kind: 'account', accountId: 'acct-1' });
    expect(env.catalog).toEqual(VALID_CATALOG);
  });
});
