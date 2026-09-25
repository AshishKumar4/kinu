import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PROFILE_CATALOG, TIER_IDS,
  profileCatalogDigest,
} from '../src/profiles/catalog';
import { resolveTurnProfile } from '../src/profiles/resolve';
import { SPEND_SOURCES, resolveModelRoute } from '../src/profiles/model-route';
import type { SpendSource } from '../src/events/model-call';
import { AGENT_CONFIG_KEYS } from '../src/config/store';
import { changeActiveRole, roleChangeOutcomeText } from '../src/profiles/role-change';
import type { RoleChangeOutcome, RoleStateStore } from '../src/profiles/role-change';
import type { ProfileCatalogEnvelope } from '../src/profiles';


function envelope(catalog = BUILTIN_PROFILE_CATALOG): ProfileCatalogEnvelope {
  const value: ProfileCatalogEnvelope = {
    authority: { kind: 'local' },
    version: 3,
    digest: profileCatalogDigest(catalog),
    catalog,
  };

  return Object.freeze(value);
}

const PROVIDER = {
  revision: 'r1',
  availableModels: [
    'workers-ai/@cf/zai-org/glm-5.3', '@cf/a/model-a', '@cf/b/model-b',
  ],
};

function baseInput(overrides: Partial<Parameters<typeof resolveTurnProfile>[0]> = {}) {
  return {
    envelope: envelope(),
    provider: PROVIDER,
    roleId: 'task',
    workMode: 'build' as const,
    availableTools: ['file', 'shell', 'agents', 'mcp_github_search'],
    activeSkills: [],
    ...overrides,
  };
}

function memoryConfig(): RoleStateStore & { dump: () => Map<string, string> } {
  const rows = new Map<string, string>();

  return {
    get: (k) => rows.get(k) ?? null,
    set: (k, v) => { rows.set(k, v); },
    dump: () => rows,
  };
}

/** Lanes whose tier the account fixes, so a turn cannot move them. */
const FIXED_LANES = [
  ['scaffold', 'deep'], ['judge', 'deep'], ['advisor', 'deep'],
  ['compaction', 'fast'], ['fast', 'fast'], ['reflection', 'fast'],
] as const;

const INVOCATION_LANES = ['agent', 'head', 'mcts', 'swarm'] as const;

/** Producers no turn profile routes: a binding-bound platform call, and a cache warm replaying a frozen spec. */
const UNROUTED: readonly SpendSource[] = ['platform', 'warming', 'test'];

describe('exhaustive model routing', () => {
  test('every producer resolves, and only the unrouted pair refuses', () => {
    const profile = resolveTurnProfile(baseInput());

    for (const source of SPEND_SOURCES) {
      const route = resolveModelRoute(source, profile);

      if (UNROUTED.includes(source)) expect(route).toBeNull();
      else expect(route).toMatchObject({ source });
    }
  });

  test('the PRD lane map is the shipped policy', () => {
    const profile = resolveTurnProfile(baseInput());

    for (const [source, tier] of FIXED_LANES) {
      expect(resolveModelRoute(source, profile)?.tier).toBe(tier);
    }

    for (const source of INVOCATION_LANES) {
      expect(resolveModelRoute(source, profile)?.tier).toBe(profile.tier.id);
    }
  });

  test('producers resolve concrete models off the turn profile; platform refuses', () => {
    const tiers = {
      fast: { model: '@cf/b/model-b' },
      default: { model: '@cf/a/model-a' },
      deep: { model: '@cf/b/model-b' },
    };

    const profile = resolveTurnProfile(baseInput({
      envelope: envelope({ roles: { ...BUILTIN_PROFILE_CATALOG.roles }, tiers }),
    }));

    const judge = resolveModelRoute('judge', profile);
    expect(judge).toMatchObject({ source: 'judge', tier: 'deep', model: '@cf/b/model-b' });
    expect(resolveModelRoute('agent', profile)?.model).toBe('@cf/a/model-a');
    const researcherProfile = resolveTurnProfile(baseInput({ roleId: 'researcher' }));
    // The built-in catalog ships only `default`, so the role's `fast` slot aliases it.
    expect(resolveModelRoute('agent', researcherProfile)?.tier).toBe('default');
    expect(resolveModelRoute('platform', researcherProfile)).toBeNull();
  });

  test("invocation lanes answer the turn's pinned model, fixed lanes the catalog slot", () => {
    // The pin overrides the turn's tier model while catalog slots stay the account's.
    const profile = resolveTurnProfile(baseInput({ workspaceModel: '@cf/a/model-a' }));

    expect(profile.tier).toMatchObject({ source: 'workspace', model: '@cf/a/model-a' });

    for (const source of INVOCATION_LANES) {
      expect(resolveModelRoute(source, profile)).toMatchObject({
        source, tier: profile.tier.id, model: '@cf/a/model-a',
      });
    }

    expect(resolveModelRoute('judge', profile)?.model).toBe(profile.tiers.deep.model);
    expect(profile.tiers.deep.model).not.toBe('@cf/a/model-a');
  });
});

describe('resolver tier snapshot', () => {
  test('an account that never set a tier runs every role and every lane on GLM 5.3', () => {
    for (const roleId of ['task', 'researcher', 'planner', 'auditor', 'designer']) {
      const profile = resolveTurnProfile(baseInput({ roleId }));

      expect(profile.tier.model).toBe('workers-ai/@cf/zai-org/glm-5.3');
      expect(Object.values(profile.tiers).map((route) => route.model)).toEqual(TIER_IDS.map(() => 'workers-ai/@cf/zai-org/glm-5.3'));
    }
  });

  test('cloud and local authorities produce identical profiles for identical inputs', () => {
    const localEnv = envelope();

    const accountEnv: ProfileCatalogEnvelope = {
      ...localEnv,
      authority: { kind: 'account', accountId: 'acct-1' },
    };

    const a = resolveTurnProfile(baseInput({ envelope: localEnv }));
    const b = resolveTurnProfile(baseInput({ envelope: accountEnv }));
    expect({ ...a, authority: null, digest: null })
      .toEqual({ ...b, authority: null, digest: null });
    expect(a.authority).toEqual({ kind: 'local' });
    expect(b.authority).toEqual({ kind: 'account', accountId: 'acct-1' });
  });
});

describe('durable role change', () => {
  test('applied switch persists provenance and the next turn resolves the new role', () => {
    const config = memoryConfig();
    const out = changeActiveRole({ envelope: envelope(), config, to: 'auditor', actor: 'user' });
    expect(out).toEqual({ kind: 'applied', from: 'task', to: 'auditor', catalogVersion: 3 });
    expect(config.get(AGENT_CONFIG_KEYS.roleSelection)).toBe('auditor');
    expect(config.get('role_changed_by')).toBe('user');
    const nextTurn = resolveTurnProfile(baseInput({ roleId: 'auditor' }));
    expect(nextTurn.role.id).toBe('auditor');
    expect(nextTurn.tier.id).toBe('default');
  });

  test('locked refuses agent self-switch but not the owner', () => {
    const config = memoryConfig();
    config.set(AGENT_CONFIG_KEYS.roleChangePolicy, 'locked');
    expect(changeActiveRole({ envelope: envelope(), config, to: 'planner', actor: 'agent' }))
      .toEqual({ kind: 'refused', reason: 'locked' });
    expect(changeActiveRole({ envelope: envelope(), config, to: 'planner', actor: 'user' }))
      .toEqual({ kind: 'applied', from: 'task', to: 'planner', catalogVersion: 3 });
  });
  test('approval refuses a widening self-switch and lands a narrowing one', () => {
    const config = memoryConfig();
    config.set(AGENT_CONFIG_KEYS.roleChangePolicy, 'approval');

    const restricted = envelope({
      roles: {
        ...BUILTIN_PROFILE_CATALOG.roles,
        scout: {
          description: 'narrow', instructions: 'stay narrow.', tier: 'default',
          preset: 'ideate', allowedTools: ['file'],
        },
        generalist: {
          description: 'wide', instructions: 'go wide.', tier: 'default',
          preset: 'ideate', allowedTools: ['file', 'shell', 'web'],
        },
      },
      tiers: { ...BUILTIN_PROFILE_CATALOG.tiers },
    });

    const narrowed = changeActiveRole({ envelope: restricted, config, to: 'scout', actor: 'agent' });
    expect(narrowed.kind).toBe('applied');
    const widened = changeActiveRole({ envelope: restricted, config, to: 'generalist', actor: 'agent' });
    expect(widened).toEqual({ kind: 'refused', reason: 'approval-required' });
    expect(config.get(AGENT_CONFIG_KEYS.roleSelection)).toBe('scout');
    expect(config.get('pending_role_id')).toBeNull();
  });
  test('unknown roles are refused with nothing stored', () => {
    const config = memoryConfig();
    expect(changeActiveRole({ envelope: envelope(), config, to: 'no-such-role', actor: 'agent' }))
      .toEqual({ kind: 'refused', reason: 'unknown-role' });
    expect(config.get(AGENT_CONFIG_KEYS.roleSelection)).toBeNull();
  });
});

/** Owned in core so both backends share one sentence and a new outcome member is one compile error. */
describe('what a caller is told about a role change', () => {
  const say = (outcome: RoleChangeOutcome, requested = 'auditor', current = 'task') =>
    roleChangeOutcomeText(requested, outcome, current);

  test('an approval widening is refused with the approval named', () => {
    // A widening self-switch must not answer `staged`: no surface delivers that approval.
    const text = say({ kind: 'refused', reason: 'approval-required' });
    expect(text).toContain('approval');
    expect(text).not.toContain('awaiting owner approval');
    expect(text).toContain('"task"');
  });

  test('the two outcomes retrying cannot fix say so', () => {
    expect(say({ kind: 'refused', reason: 'locked' })).toContain('retrying will not change that');
    expect(say({ kind: 'refused', reason: 'unknown-role' })).toContain('not in this account\'s catalog');
    expect(say({ kind: 'refused', reason: 'invalid-role-id' })).toContain('not a well-formed role id');
  });

  test('every outcome names the role that is live afterwards', () => {
    const outcomes: RoleChangeOutcome[] = [
      { kind: 'applied', from: 'task', to: 'auditor', catalogVersion: 3 },
      { kind: 'refused', reason: 'locked' },
      { kind: 'refused', reason: 'unknown-role' },
      { kind: 'refused', reason: 'invalid-role-id' },
      { kind: 'refused', reason: 'approval-required' },
    ];

    for (const outcome of outcomes) {
      const text = say(outcome);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/"(auditor|general)"/);
    }
  });

  test('an applied change says when it takes effect, not that it already has', () => {
    // The running step keeps its resolved profile (profiles/role-change.ts), so the switch is never live now.
    const text = say({ kind: 'applied', from: 'task', to: 'auditor', catalogVersion: 3 });
    expect(text).toContain('next turn');
  });

  test('the message reads the OUTCOME\'s roles, not the caller\'s guess', () => {
    const text = say({ kind: 'applied', from: 'scout', to: 'generalist', catalogVersion: 3 }, 'generalist', 'stale-value');
    expect(text).toContain('"scout"');
    expect(text).not.toContain('stale-value');
  });
});
