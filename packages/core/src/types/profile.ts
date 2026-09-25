import * as v from 'valibot';
import type { ReasoningEffort } from '../providers/reasoning-effort';
import type { NamedSwarmPreset } from './swarm';

/** Kebab-case, lowercase-first: the same discipline role and skill names follow. */
export type RoleId = string;

/** Roles every authority implicitly ships; a catalog may override but not remove them. */
export const BUILTIN_ROLE_IDS = [
  'task', 'researcher', 'planner', 'auditor', 'designer',
] as const;

export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

/** Declared, not the array's first slot, so reordering builtins cannot move the default. */
export const DEFAULT_ROLE_ID = 'task' as const satisfies BuiltinRoleId;

export const ROLE_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const ROLE_ID_MAX_LEN = 64;

export const RoleIdSchema = v.pipe(v.string(), v.regex(ROLE_ID_RE), v.maxLength(ROLE_ID_MAX_LEN));

export function isValidRoleId(value: string): value is RoleId {
  return value.length <= ROLE_ID_MAX_LEN && ROLE_ID_RE.test(value);
}

/**
 * Builtin tiers in UI order. Only `default` must be configured; unconfigured tiers alias it, and a
 * role naming a tier the catalog lacks is refused at read.
 */
export const TIER_IDS = ['fast', 'default', 'deep'] as const;

export type BuiltinTierId = (typeof TIER_IDS)[number];

export type TierId = string;

const TIER_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const TIER_ID_MAX_LEN = 32;

export const TierIdSchema = v.pipe(v.string(), v.regex(TIER_ID_RE), v.maxLength(TIER_ID_MAX_LEN));

/** Well-formedness only (durable rows may come from another build); existence is checked at resolve time. */
export function isTierId(value: string): value is TierId {
  return v.safeParse(TierIdSchema, value).success;
}

export interface TierAssignment {
  model: string;
  reasoningEffort?: ReasoningEffort | undefined;
  fallbacks?: readonly string[] | undefined;
}

export interface TierAssignments {
  readonly default: TierAssignment;
  readonly [tier: TierId]: TierAssignment | undefined;
}

export interface RoleDefinition {
  /** Absent derives from the id at resolve time (`deriveRoleLabel`). */
  label?: string | undefined;
  description: string;
  instructions: string;
  tier: TierId;
  preset: NamedSwarmPreset;
  /** Absent inherits the full merged tool set. Never widens it. */
  allowedTools?: readonly string[] | undefined;
  skills?: readonly string[] | undefined;
  /** Absent inherits structural reach. */
  spawns?: '*' | readonly RoleId[] | undefined;
  /** Absent inherits the turn's permission mode; `true` can only narrow. */
  plan?: true | undefined;
}

export type RoleCatalog = Readonly<Record<RoleId, RoleDefinition>>;

export interface ProfileCatalog {
  roles: RoleCatalog;
  tiers: TierAssignments;
  /** Per provider: the default account. */
  accounts?: Readonly<Record<string, string>> | undefined;
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
