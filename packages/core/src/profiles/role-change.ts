// Durable role change — how an agent's active role moves at a turn boundary.
//
// The active role is durable per-agent state (agent_config), so a change made
// now applies to the NEXT resolved turn; the running step keeps the profile it
// already resolved. Policy is the owner's, per agent:
//
//   allow     any switch lands immediately
//   approval  a capability-INCREASING switch stages for owner approval; a
//             pure narrowing lands immediately
//   locked    the agent cannot switch at all — only the owner can
//
// Every applied move records provenance (actor, previous id, catalog version),
// which is exactly what the typed run event and the changelog row carry.
import {
  effectiveRoleCatalog, isValidRoleId, validateProfileCatalogEnvelope,
  type ProfileCatalogEnvelope, type RoleDefinition, type RoleId,
} from './catalog';

export type RoleChangeActor = 'user' | 'agent';
export type RoleChangePolicy = 'allow' | 'approval' | 'locked';

export type RoleChangeOutcome =
  | { readonly kind: 'applied'; readonly from: RoleId; readonly to: RoleId; readonly catalogVersion: number }
  | { readonly kind: 'staged'; readonly from: RoleId; readonly to: RoleId }
  | { readonly kind: 'dismissed'; readonly from: RoleId; readonly to: RoleId }
  | { readonly kind: 'refused'; readonly reason: 'locked' | 'unknown-role' | 'invalid-role-id' }
  | { readonly kind: 'none' };

/** The slice of AgentConfigStore a role change reads and writes. Generic
 *  get/set keeps this module free of a store import cycle; the typed
 *  accessors live beside the keys they own. */
export interface RoleStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const ROLE_POLICY_KEY = 'role_change_policy';
const ACTIVE_ROLE_KEY = 'active_role_id';
const PENDING_ROLE_KEY = 'pending_role_id';

/** Whether `to` can reach any tool `from` could not. An absent allowedTools
 *  list IS the full surface: restricted to full widens, full to anything does
 *  not, and two restricted lists compare by membership. */
export function roleWidensCapabilities(from: RoleDefinition, to: RoleDefinition): boolean {
  if (to.allowedTools === undefined) return from.allowedTools !== undefined;
  if (from.allowedTools === undefined) return false;
  const fromSet = new Set(from.allowedTools);
  return to.allowedTools.some((action) => !fromSet.has(action));
}

function roleOf(envelope: ProfileCatalogEnvelope, id: RoleId): RoleDefinition | null {
  const roles = effectiveRoleCatalog(envelope.catalog);
  return roles[id] ?? null;
}

function readPolicy(config: RoleStateStore): RoleChangePolicy {
  const stored = config.get(ROLE_POLICY_KEY);
  return stored === 'approval' || stored === 'locked' ? stored : 'allow';
}

function applyRole(
  config: RoleStateStore,
  envelope: ProfileCatalogEnvelope,
  from: RoleId,
  to: RoleId,
  actor: RoleChangeActor,
): void {
  config.set(ACTIVE_ROLE_KEY, to);
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
  const from = input.config.get(ACTIVE_ROLE_KEY) ?? 'general';
  if (!isValidRoleId(input.to)) return { kind: 'refused', reason: 'invalid-role-id' };
  const target = roleOf(envelope, input.to);
  if (!target) return { kind: 'refused', reason: 'unknown-role' };

  const policy = readPolicy(input.config);
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
    input.config.set(PENDING_ROLE_KEY, input.to);
    return { kind: 'staged', from, to: input.to };
  }

  applyRole(input.config, envelope, from, input.to, input.actor);
  return { kind: 'applied', from, to: input.to, catalogVersion: envelope.version };
}

/** The owner's answer to a staged change: land it as the owner's own act, or
 *  dismiss it. No staged change reads as `none`. */
export function decideStagedRole(input: {
  envelope: ProfileCatalogEnvelope;
  config: RoleStateStore;
  approve: boolean;
}): RoleChangeOutcome {
  const staged = input.config.get(PENDING_ROLE_KEY);
  if (!staged) return { kind: 'none' };
  const from = input.config.get(ACTIVE_ROLE_KEY) ?? 'general';
  input.config.set(PENDING_ROLE_KEY, '');
  if (!input.approve) return { kind: 'dismissed', from, to: staged };
  const envelope = validateProfileCatalogEnvelope(input.envelope);
  applyRole(input.config, envelope, from, staged, 'user');
  return { kind: 'applied', from, to: staged, catalogVersion: envelope.version };
}
