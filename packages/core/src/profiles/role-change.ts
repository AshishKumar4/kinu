// Durable role change — how an agent's active role moves at a turn boundary.
//
// The active role is durable per-agent state (agent_config), so a change made
// now applies to the NEXT resolved turn; the running step keeps the profile it
// already resolved. Policy is the owner's, per agent:
//
//   allow     any switch lands immediately
//   approval  a capability-INCREASING agent self-switch is refused and names
//             the owner approval it needs; a pure narrowing lands immediately
//   locked    the agent cannot switch at all — only the owner can
//
// Every applied move records provenance (actor, previous id, catalog version),
// which is exactly what the typed run event and the changelog row carry.
import {
  DEFAULT_ROLE_ID, effectiveRoleCatalog, isValidRoleId, validateProfileCatalogEnvelope,
  type ProfileCatalogEnvelope, type RoleDefinition, type RoleId,
} from './catalog';
import {
  AGENT_CONFIG_KEYS, parseRoleChangePolicy,
} from '../config/store';

export type RoleChangeActor = 'user' | 'agent';
export type RoleChangePolicy = 'allow' | 'approval' | 'locked';

/** Why a change could not be made. Named because two places speak it: the
 *  outcome union below and the message table over it. */
export type RoleChangeRefusal = 'locked' | 'unknown-role' | 'invalid-role-id' | 'approval-required';

export type RoleChangeOutcome =
  | { readonly kind: 'applied'; readonly from: RoleId; readonly to: RoleId; readonly catalogVersion: number }
  | { readonly kind: 'refused'; readonly reason: RoleChangeRefusal };

/**
 * What to tell the caller about a role change, for every outcome the union has.
 *
 * TOTAL over {@link RoleChangeOutcome}, and owned here rather than at the
 * callsites because the two callers sit in packages with no dependency between
 * them: written twice, a new member earns a wrong sentence in two places
 * instead of a compile error in one.
 *
 * An approval-policy widening is a REFUSAL, not a queue ticket: no owner
 * surface reads a staged request, so calling one "staged" promises an
 * approval that never arrives. "Refused" covers `locked`, the roles the
 * catalog cannot carry, and the widenings the owner must make instead.
 * Every message says which role is live afterwards, because that is the thing
 * the caller has to act on. `currentRole` is consulted ONLY by `refused`, the
 * one member carrying no `from` of its own, so the sentence can never disagree
 * with the outcome about which role that is.
 */
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

/** The slice of AgentConfigStore a role change reads and writes. Generic
 *  get/set keeps callers free of the store type; the keys and the policy
 *  reading live in config/store beside the accessors that own them. */
export interface RoleStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Whether `to` can reach any tool `from` could not. An absent allowedTools
 *  list IS the full surface: restricted to full widens, full to anything does
 *  not, and two restricted lists compare by membership. */
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

function applyRole(
  config: RoleStateStore,
  envelope: ProfileCatalogEnvelope,
  from: RoleId,
  to: RoleId,
  actor: RoleChangeActor,
): void {
  config.set(AGENT_CONFIG_KEYS.roleSelection, to);
  config.set('role_changed_from', from);
  config.set('role_changed_by', actor);
  config.set('role_changed_at', String(Date.now()));
  config.set('role_changed_catalog_version', String(envelope.version));
}

/** Apply one role change under the owner's policy. Validates the target
 *  against THIS envelope, so an unknown role is refused rather than stored to
 *  fail later at resolution. */
export function changeActiveRole(input: {
  envelope: ProfileCatalogEnvelope;
  config: RoleStateStore;
  to: RoleId;
  actor: RoleChangeActor;
}): RoleChangeOutcome {
  const envelope = validateProfileCatalogEnvelope(input.envelope);
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
    // No staging row: no owner surface reads one, so a stored request would
    // wait forever. Refuse and name the approval the switch needs.
    return { kind: 'refused', reason: 'approval-required' };
  }

  applyRole(input.config, envelope, from, input.to, input.actor);
  return { kind: 'applied', from, to: input.to, catalogVersion: envelope.version };
}
