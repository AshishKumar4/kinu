/** Profile identity vocabulary, declared at the platform layer: a role id is
 *  the one token every layer passes around, resolved by the catalog. */

import type { ReasoningEffort } from '../providers/reasoning-effort';
import type { NamedSwarmPreset } from './swarm';

/** Kebab-case, lowercase-first: the same discipline role and skill names follow. */
export type RoleId = string;

/** The inference tiers every authority ships, in their stable UI order. Only
 *  `default` must be configured: it is the model the account runs on, the one
 *  a new workspace starts with, and the one any other tier aliases when it has
 *  no row. `tiny` and `slow` were removed (#7): they overlapped `fast` and
 *  `deep`. A catalog may add tiers of its own by key (`TIER_ID_RE`), exactly
 *  as it adds roles; a role naming a tier the catalog lacks is refused at
 *  read rather than aliased. */
export const TIER_IDS = ['fast', 'default', 'deep'] as const;

export type BuiltinTierId = (typeof TIER_IDS)[number];

/** A tier the catalog holds: one of the builtins or one the owner added. */
export type TierId = string;

export interface TierAssignment {
  model: string;
  reasoningEffort?: ReasoningEffort | undefined;
}

/** Every tier the catalog holds, keyed by id: `default`, which every catalog
 *  must carry, the builtins the owner configured, and the tiers the owner
 *  added. */
export interface TierAssignments {
  readonly default: TierAssignment;
  readonly [tier: TierId]: TierAssignment | undefined;
}

export interface RoleDefinition {
  /** Absent derives from the id at resolve time (`deriveRoleLabel`). */
  label?: string | undefined;
  /** What the role is FOR — catalog and schema discovery. */
  description: string;
  /** The role's one system-prompt section. */
  instructions: string;
  tier: TierId;
  preset: NamedSwarmPreset;
  /** Absent inherits the full merged tool set. Never widens it. */
  allowedTools?: readonly string[] | undefined;
  skills?: readonly string[] | undefined;
  /** Which roles this role may hire: everything, a narrowing list, or inherited
   *  structural reach when absent. */
  spawns?: '*' | readonly RoleId[] | undefined;
  /** Absent inherits the turn's permission mode; `true` can only narrow. */
  plan?: true | undefined;
}

export type RoleCatalog = Readonly<Record<RoleId, RoleDefinition>>;

export interface ProfileCatalog {
  roles: RoleCatalog;
  tiers: TierAssignments;
}

export type ProfileAuthority =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'local' };

export interface ProfileCatalogEnvelope {
  authority: ProfileAuthority;
  version: number;
  digest: string;
  catalog: ProfileCatalog;
}
