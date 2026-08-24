// Focused proofs for the profile integration slice:
//   - MODEL_ROUTE_POLICY is compiler-exhaustive and resolves every producer
//     through the immutable turn profile (platform excepted).
//   - The resolver carries the whole tier table so producers never re-resolve.
//   - Durable role change: persistence, next-turn resolution, locked/approval
//     policy, capability-widening classification.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PROFILE_CATALOG, TIER_IDS,
  profileCatalogDigest,
} from '../src/profiles/catalog';
import { resolveTurnProfile } from '../src/profiles/resolve';
import {
  MODEL_ROUTE_POLICY, SPEND_SOURCES, isPlatformRouted, modelRouteTable, resolveModelRoute,
} from '../src/profiles/model-route';
import { changeActiveRole, roleChangeOutcomeText, roleWidensCapabilities } from '../src/profiles/role-change';
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
    'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813', '@cf/a/model-a', '@cf/b/model-b',
  ],
};

function baseInput(overrides: Partial<Parameters<typeof resolveTurnProfile>[0]> = {}) {
  return {
    envelope: envelope(),
    provider: PROVIDER,
    roleId: 'general',
    workMode: 'build' as const,
    availableTools: ['file', 'run', 'agents', 'mcp_github_search'],
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

describe('exhaustive model routing', () => {
  test('every SpendSource has a policy row', () => {
    for (const source of SPEND_SOURCES) expect(MODEL_ROUTE_POLICY[source]).toBeDefined();
  });

  test('the PRD lane map is the shipped policy', () => {
    expect(MODEL_ROUTE_POLICY.agent).toEqual({ kind: 'invocation' });
    for (const s of ['head', 'mcts', 'swarm', 'sandbox'] as const) {
      expect(MODEL_ROUTE_POLICY[s]).toEqual({ kind: 'invocation' });
    }
    expect(MODEL_ROUTE_POLICY.scaffold).toEqual({ kind: 'fixed', tier: 'deep' });
    expect(MODEL_ROUTE_POLICY.judge).toEqual({ kind: 'fixed', tier: 'deep' });
    expect(MODEL_ROUTE_POLICY.advisor).toEqual({ kind: 'fixed', tier: 'slow' });
    expect(MODEL_ROUTE_POLICY.compaction).toEqual({ kind: 'fixed', tier: 'fast' });
    expect(MODEL_ROUTE_POLICY.fast).toEqual({ kind: 'fixed', tier: 'tiny' });
    expect(MODEL_ROUTE_POLICY.reflection).toEqual({ kind: 'fixed', tier: 'fast' });
    expect(MODEL_ROUTE_POLICY.platform).toEqual({ kind: 'platform' });
  });

  test('producers resolve concrete models off the turn profile; platform refuses', () => {
    const tiers = {
      tiny: { model: '@cf/b/model-b' }, fast: { model: '@cf/b/model-b' },
      default: { model: '@cf/a/model-a' }, slow: { model: '@cf/b/model-b' },
      deep: { model: '@cf/b/model-b' },
    };
    const profile = resolveTurnProfile(baseInput({
      envelope: envelope({ roles: { ...BUILTIN_PROFILE_CATALOG.roles }, tiers }),
    }));
    const judge = resolveModelRoute('judge', profile);
    expect(judge).toMatchObject({ source: 'judge', tier: 'deep', model: '@cf/b/model-b' });
    // invocation routes ride the ROLE's tier (researcher → fast), not a pin.
    const researcherProfile = resolveTurnProfile(baseInput({ roleId: 'researcher' }));
    // The built-in catalog ships only `default`, so the role's `fast` slot
    // aliases it — the invocation route still follows the ROLE.
    expect(resolveModelRoute('agent', researcherProfile)?.tier).toBe('default');
    expect(isPlatformRouted('platform')).toBe(true);
    expect(resolveModelRoute('platform', researcherProfile)).toBeNull();
    // Every non-platform producer resolves in one pass.
    for (const [source, route] of modelRouteTable(researcherProfile)) {
      if (source === 'platform') expect(route).toBeNull();
      else expect(route).not.toBeNull();
    }
  });
});

describe('resolver tier snapshot', () => {
  test('unset slots alias default across all five slots', () => {
    const p = resolveTurnProfile(baseInput());
    expect(Object.keys(p.tiers).sort()).toEqual([...TIER_IDS].sort());
    for (const id of ['tiny', 'fast', 'slow', 'deep'] as const) {
      expect(p.tiers[id].model).toBe(BUILTIN_PROFILE_CATALOG.tiers.default!.model);
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
    // Authority is part of the profile cache identity, so its digest differs too.
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
    expect(out).toEqual({ kind: 'applied', from: 'general', to: 'auditor', catalogVersion: 3 });
    expect(config.get('active_role_id')).toBe('auditor');
    expect(config.get('role_changed_by')).toBe('user');
    const nextTurn = resolveTurnProfile(baseInput({ roleId: config.get('active_role_id')! }));
    expect(nextTurn.role.id).toBe('auditor');
    expect(nextTurn.tier.id).toBe('default'); // slow unset → aliases default
  });

  test('locked refuses agent self-switch but not the owner', () => {
    const config = memoryConfig();
    config.set('role_change_policy', 'locked');
    expect(changeActiveRole({ envelope: envelope(), config, to: 'planner', actor: 'agent' }))
      .toEqual({ kind: 'refused', reason: 'locked' });
    expect(changeActiveRole({ envelope: envelope(), config, to: 'planner', actor: 'user' }))
      .toEqual({ kind: 'applied', from: 'general', to: 'planner', catalogVersion: 3 });
  });
  test('approval stages a widening self-switch and lands a narrowing one', () => {
    const config = memoryConfig();
    config.set('role_change_policy', 'approval');
    const restricted = envelope({
      roles: {
        ...BUILTIN_PROFILE_CATALOG.roles,
        scout: {
          description: 'narrow', instructions: 'stay narrow.', tier: 'default',
          preset: 'ideate', allowedTools: ['file'],
        },
        generalist: {
          description: 'wide', instructions: 'go wide.', tier: 'default',
          preset: 'ideate', allowedTools: ['file', 'run', 'web'],
        },
      },
      tiers: { ...BUILTIN_PROFILE_CATALOG.tiers },
    });
    // general (full surface) → scout (narrow): not widening, lands now.
    const narrowed = changeActiveRole({ envelope: restricted, config, to: 'scout', actor: 'agent' });
    expect(narrowed.kind).toBe('applied');
    // scout → generalist widens: staged for the owner, active unchanged.
    const widened = changeActiveRole({ envelope: restricted, config, to: 'generalist', actor: 'agent' });
    expect(widened).toEqual({ kind: 'staged', from: 'scout', to: 'generalist' });
    expect(config.get('active_role_id')).toBe('scout');
    expect(roleWidensCapabilities(
      restricted.catalog.roles.scout!, restricted.catalog.roles.generalist!,
    )).toBe(true);
  });
  test('unknown roles are refused with nothing stored', () => {
    const config = memoryConfig();
    expect(changeActiveRole({ envelope: envelope(), config, to: 'no-such-role', actor: 'agent' }))
      .toEqual({ kind: 'refused', reason: 'unknown-role' });
    expect(config.get('active_role_id')).toBeNull();
  });
});

/** The one sentence both backends speak about a role change. Owned in core
 *  because the two callers live in packages with no dependency between them:
 *  written twice, a new outcome member earns a wrong sentence in two places
 *  instead of a compile error in one. */
describe('what a caller is told about a role change', () => {
  const say = (outcome: RoleChangeOutcome, requested = 'auditor', current = 'general') =>
    roleChangeOutcomeText(requested, outcome, current);

  test('a STAGED change is not reported as a failure', () => {
    // The defect this replaces: both backends threw `role "x" was refused:
    // staged`, which tells the agent to retry something already pending and
    // makes an approval policy read as a broken one. Staged SUCCEEDED; its
    // effect is waiting on the owner.
    const text = say({ kind: 'staged', from: 'general', to: 'auditor' });
    expect(text).toContain('awaiting owner approval');
    expect(text).not.toContain('refused');
    // And it names what runs meanwhile, which is the actionable half.
    expect(text).toContain('"general"');
  });

  test('the two outcomes retrying cannot fix say so', () => {
    expect(say({ kind: 'refused', reason: 'locked' })).toContain('retrying will not change that');
    expect(say({ kind: 'refused', reason: 'unknown-role' })).toContain('not in this account\'s catalog');
    expect(say({ kind: 'refused', reason: 'invalid-role-id' })).toContain('not a well-formed role id');
  });

  test('every outcome names the role that is live afterwards', () => {
    const outcomes: RoleChangeOutcome[] = [
      { kind: 'applied', from: 'general', to: 'auditor', catalogVersion: 3 },
      { kind: 'staged', from: 'general', to: 'auditor' },
      { kind: 'dismissed', from: 'general', to: 'auditor' },
      { kind: 'refused', reason: 'locked' },
      { kind: 'refused', reason: 'unknown-role' },
      { kind: 'refused', reason: 'invalid-role-id' },
      { kind: 'none' },
    ];
    for (const outcome of outcomes) {
      const text = say(outcome);
      expect(text.length).toBeGreaterThan(0);
      // The role a caller has to act on appears in every arm: the new one where
      // the change landed, the standing one where it did not.
      expect(text).toMatch(/"(auditor|general)"/);
    }
  });

  test('an applied change says when it takes effect, not that it already has', () => {
    // profiles/role-change.ts's contract: the running step keeps the profile it
    // already resolved. A message claiming the switch is live now would
    // contradict the turn the agent is in.
    const text = say({ kind: 'applied', from: 'general', to: 'auditor', catalogVersion: 3 });
    expect(text).toContain('next turn');
  });

  test('the message reads the OUTCOME\'s roles, not the caller\'s guess', () => {
    // `currentRole` is consulted only for the members carrying no `from`, so a
    // stale read passed by a caller cannot make the sentence disagree with what
    // actually happened.
    const text = say({ kind: 'staged', from: 'scout', to: 'generalist' }, 'generalist', 'stale-value');
    expect(text).toContain('"scout"');
    expect(text).not.toContain('stale-value');
  });
});
