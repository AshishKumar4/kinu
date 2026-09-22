// Role changes land at the next turn boundary; policy per agent: allow, approval (agent widening refused), locked.
import {
  DEFAULT_ROLE_ID, effectiveRoleCatalog, isValidRoleId, validateProfileCatalogEnvelope,
  type ProfileCatalogEnvelope, type RoleDefinition, type RoleId,
} from './catalog';
import {
  AGENT_CONFIG_KEYS, parseRoleChangePolicy,
} from '../config/store';

export type RoleChangeActor = 'user' | 'agent';

export type RoleChangePolicy = 'allow' | 'approval' | 'locked';

export type RoleChangeRefusal = 'locked' | 'unknown-role' | 'invalid-role-id' | 'approval-required';

export type RoleChangeOutcome =
  | { readonly kind: 'applied'; readonly from: RoleId; readonly to: RoleId; readonly catalogVersion: number }
  | { readonly kind: 'refused'; readonly reason: RoleChangeRefusal };

/** Total over {@link RoleChangeOutcome}; owned here so both callers (no shared dependency) get a compile error on a new member. */
export function roleChangeOutcomeText(
  requested: string,
  outcome: RoleChangeOutcome,
  currentRole: string,
): string {
  const asked = JSON.stringify(requested);

  switch (outcome.kind) {
    case 'applied':
      return `role is now ${JSON.stringify(outcome.to)}, was ${JSON.stringify(outcome.from)}. `
        + 'It applies from the next turn; this one keeps the profile it already resolved.';
    case 'refused': {
      const live = JSON.stringify(currentRole);

      const because = {
        locked: `role changes are locked on this agent by its owner, so ${asked} cannot be set `
          + `here and retrying will not change that. ${live} stays active.`,
        'unknown-role': `role ${asked} is not in this account's catalog, so there is nothing to `
          + `switch to. ${live} stays active — ask the owner to add the role, or pick one the `
          + 'catalog carries.',
        'invalid-role-id': `${asked} is not a well-formed role id, so it names no role. `
          + `${live} stays active.`,
        'approval-required': `role ${asked} widens what this agent can reach, so the switch needs owner approval. `
          + `${live} stays active.`,
      } satisfies Record<RoleChangeRefusal, string>;

      return because[outcome.reason];
    }
  }
}

export interface RoleStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** An absent allowedTools list is the full surface. */
function roleWidensCapabilities(from: RoleDefinition, to: RoleDefinition): boolean {
  if (to.allowedTools === undefined) return from.allowedTools !== undefined;

  if (from.allowedTools === undefined) return false;
  const fromSet = new Set(from.allowedTools);

  return to.allowedTools.some((action) => !fromSet.has(action));
}

function roleOf(envelope: ProfileCatalogEnvelope, id: RoleId): RoleDefinition | null {
  const roles = effectiveRoleCatalog(envelope.catalog);

  return roles[id] ?? null;
}

interface AppliedRoleChange {
  readonly config: RoleStateStore;
  readonly envelope: ProfileCatalogEnvelope;
  readonly from: RoleId;
  readonly to: RoleId;
  readonly actor: RoleChangeActor;
}

function applyRole(change: AppliedRoleChange): void {
  change.config.set(AGENT_CONFIG_KEYS.roleSelection, change.to);
  change.config.set('role_changed_from', change.from);
  change.config.set('role_changed_by', change.actor);
  change.config.set('role_changed_at', String(Date.now()));
  change.config.set('role_changed_catalog_version', String(change.envelope.version));
}

/** Validates the target against this envelope, so an unknown role is refused rather than stored. */
export function changeActiveRole(input: {
  envelope: ProfileCatalogEnvelope;
  config: RoleStateStore;
  to: RoleId;
  actor: RoleChangeActor;
}): RoleChangeOutcome {
  const envelope = validateProfileCatalogEnvelope({ value: input.envelope });
  const stored = input.config.get(AGENT_CONFIG_KEYS.roleSelection);
  const from = stored !== null && isValidRoleId(stored) ? stored : DEFAULT_ROLE_ID;

  if (!isValidRoleId(input.to)) return { kind: 'refused', reason: 'invalid-role-id' };
  const target = roleOf(envelope, input.to);

  if (!target) return { kind: 'refused', reason: 'unknown-role' };

  const policy = parseRoleChangePolicy(input.config.get(AGENT_CONFIG_KEYS.roleChangePolicy));

  if (policy === 'locked' && input.actor === 'agent') {
    return { kind: 'refused', reason: 'locked' };
  }

  const fromDef = roleOf(envelope, from);

  if (
    policy === 'approval'
    && input.actor === 'agent'
    && fromDef !== null
    && roleWidensCapabilities(fromDef, target)
  ) {
    // No staging row: no owner surface reads one, so a stored request would wait forever.
    return { kind: 'refused', reason: 'approval-required' };
  }

  applyRole({ config: input.config, envelope, from, to: input.to, actor: input.actor });

  return { kind: 'applied', from, to: input.to, catalogVersion: envelope.version };
}

/** The owner's role change, shared by both backends' `setRole`. */
export function changeRoleAsOwner(input: {
  envelope: ProfileCatalogEnvelope;
  config: RoleStateStore;
  to: RoleId;
  active: string;
}) {
  const changed = changeActiveRole({ config: input.config, envelope: input.envelope, to: input.to, actor: 'user' });

  if (changed.kind !== 'applied') throw new Error(roleChangeOutcomeText(input.to, changed, input.active));

  return { role: changed.to };
}
