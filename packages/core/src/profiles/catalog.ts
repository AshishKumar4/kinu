// Profile catalogs — the tier/role configuration an authority ships.
//
// Two authorities exist and both arrive here as one wire shape: an account
// catalog stored in UserDO user_config under CAS version, and the signed-out
// local catalog in KinuConfig. The envelope carries version and digest, so the
// catalog itself stays free of metadata about its own freshness and role ids
// live only as record keys — a definition that repeats its id is invalid input,
// not a second source of truth.
//
// Resolution lives in ./resolve.ts; everything here is pure data, validation
// and hashing.
import * as v from 'valibot';

import { NAMED_SWARM_PRESETS, type NamedSwarmPreset } from '../strategy/swarm-presets';
import { REASONING_EFFORTS, type ReasoningEffort } from '../strategy/effort';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../providers/workers-ai';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';

// ── Vocabulary ───────────────────────────────────────────────────

/** Named inference tiers in their stable UI order. Only `default` must be
 *  configured; every other tier aliases it when absent. */
export const TIER_IDS = ['tiny', 'fast', 'default', 'slow', 'deep'] as const;
export type TierId = (typeof TIER_IDS)[number];

/** The roles every authority implicitly ships. A catalog may override any of
 *  them by key; it cannot remove them. */
export const BUILTIN_ROLE_IDS = [
  'general', 'researcher', 'planner', 'implementer', 'auditor', 'designer',
] as const;
export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

/** Kebab-case, lowercase-first: the same discipline skill names follow. */
export const ROLE_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const ROLE_ID_MAX_LEN = 64;

export type RoleId = string;

const RoleIdSchema = v.pipe(v.string(), v.regex(ROLE_ID_RE), v.maxLength(ROLE_ID_MAX_LEN));

export function isValidRoleId(value: string): value is RoleId {
  return value.length <= ROLE_ID_MAX_LEN && ROLE_ID_RE.test(value);
}

// ── Wire shapes ──────────────────────────────────────────────────

export interface TierAssignment {
  model: string;
  reasoningEffort?: ReasoningEffort | undefined;
}

export const TierAssignmentSchema = v.strictObject({
  model: v.pipe(v.string(), v.minLength(1)),
  reasoningEffort: v.optional(v.picklist(REASONING_EFFORTS)),
});

export interface TierAssignments {
  default: TierAssignment;
  tiny?: TierAssignment | undefined;
  fast?: TierAssignment | undefined;
  slow?: TierAssignment | undefined;
  deep?: TierAssignment | undefined;
}

export const TierAssignmentsSchema = v.strictObject({
  default: TierAssignmentSchema,
  tiny: v.optional(TierAssignmentSchema),
  fast: v.optional(TierAssignmentSchema),
  slow: v.optional(TierAssignmentSchema),
  deep: v.optional(TierAssignmentSchema),
});

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

export const RoleDefinitionSchema = v.strictObject({
  label: v.optional(v.pipe(v.string(), v.minLength(1))),
  description: v.pipe(v.string(), v.minLength(1)),
  instructions: v.pipe(v.string(), v.minLength(1)),
  tier: v.picklist(TIER_IDS),
  preset: v.picklist(NAMED_SWARM_PRESETS),
  allowedTools: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  skills: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  spawns: v.optional(v.union([v.literal('*'), v.array(RoleIdSchema)])),
  plan: v.optional(v.literal(true)),
});
export type RoleCatalog = Readonly<Record<RoleId, RoleDefinition>>;

export interface ProfileCatalog {
  roles: RoleCatalog;
  tiers: TierAssignments;
}

const ProfileCatalogObjectSchema = v.strictObject({
  roles: v.record(RoleIdSchema, RoleDefinitionSchema),
  tiers: TierAssignmentsSchema,
});

function allSpawnReferencesExist(
  catalog: v.InferOutput<typeof ProfileCatalogObjectSchema>,
): boolean {
  const known = new Set<string>([...BUILTIN_ROLE_IDS, ...Object.keys(catalog.roles)]);
  for (const role of Object.values(catalog.roles)) {
    if (role.spawns === undefined || role.spawns === '*') continue;
    for (const target of role.spawns) {
      if (!known.has(target)) return false;
    }
  }
  return true;
}

export const ProfileCatalogSchema = v.pipe(
  ProfileCatalogObjectSchema,
  v.check(
    allSpawnReferencesExist,
    'every spawns entry must name a built-in role or a role in this catalog',
  ),
);

export type ProfileAuthority =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'local' };

export const ProfileAuthoritySchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('account'), accountId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal('local') }),
]);

export interface ProfileCatalogEnvelope {
  authority: ProfileAuthority;
  version: number;
  digest: string;
  catalog: ProfileCatalog;
}

const DigestSchema = v.pipe(v.string(), v.hexadecimal(), v.length(64));

export const ProfileCatalogEnvelopeSchema = v.strictObject({
  authority: ProfileAuthoritySchema,
  // Version counts writes, so a pristine authority presents 0 with the built-in
  // catalog; the first CAS write moves it to 1. Digest distinguishes default
  // from custom content at every version.
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  digest: DigestSchema,
  catalog: ProfileCatalogSchema,
});

// ── Validation ───────────────────────────────────────────────────

export function formatProfileValidationIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.slice(0, 3).map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join('.') ?? '(root)';
    return `${path}: ${issue.message}`;
  }).join('; ');
}

/** Parse and cross-check a catalog from storage or the network. Throws,
 *  naming the offending paths, on any shape violation — including a role or
 *  catalog that duplicates fields the record keys and envelope already own. */
export function validateProfileCatalog<Input>(input: Input): ProfileCatalog {
  const parsed = v.safeParse(ProfileCatalogSchema, input);
  if (!parsed.success) {
    throw new Error(`invalid profile catalog: ${formatProfileValidationIssues(parsed.issues)}`);
  }
  return parsed.output;
}

/** Same contract for a whole envelope: authority, CAS version, digest, catalog. */
export function validateProfileCatalogEnvelope<Input>(input: Input): ProfileCatalogEnvelope {
  const parsed = v.safeParse(ProfileCatalogEnvelopeSchema, input);
  if (!parsed.success) {
    throw new Error(`invalid profile catalog envelope: ${formatProfileValidationIssues(parsed.issues)}`);
  }
  return parsed.output;
}

// ── Digest ───────────────────────────────────────────────────────

/** Deterministic content digest of a catalog: SHA-256 over the canonical
 *  serialization, so equal catalogs hash equally regardless of key insertion
 *  order. Covers the catalog only — never version or authority, which are
 *  envelope metadata and change for reasons a content digest must not see. */
export function profileCatalogDigest(catalog: ProfileCatalog): string {
  return sha256Hex(stableStringify(v.parse(JsonValueSchema, catalog)));
}

// ── Built-in roles ───────────────────────────────────────────────

/** The six roles shipped with the product, keyed by {@link BUILTIN_ROLE_IDS}.
 *  Labels stay absent: display labels derive from ids unless an authority
 *  overrides them. */
export const BUILTIN_ROLE_DEFINITIONS = {
  general: {
    description: 'The everyday agent for open-ended work in this workspace.',
    instructions: 'Take the request directly. Work in small verified steps and say what you did. When a task fans out into independent lines of work, hand the breadth to a swarm and weigh the results yourself.',
    tier: 'default',
    preset: 'ideate',
  },
  researcher: {
    description: 'Gathers evidence from files, tools and the web, then reports findings with sources.',
    instructions: 'Search before you conclude. Separate what a source states from what you infer, and say where each finding came from. State plainly when evidence is thin or contradicts itself.',
    tier: 'fast',
    preset: 'research',
  },
  planner: {
    description: 'Designs the approach before anything changes.',
    instructions: 'Read the relevant code and state before proposing anything. Produce a plan that names the files touched, the order of steps, the risks, and how each step gets verified. Change nothing yourself; another role executes the plan.',
    tier: 'slow',
    preset: 'ideate',
    plan: true,
  },
  implementer: {
    description: 'Turns an agreed plan or task into working code.',
    instructions: 'Implement what the plan or task asks, in the style of the surrounding code. Check each change against its stated acceptance before you report it done.',
    tier: 'default',
    preset: 'optimise',
  },
  auditor: {
    description: 'Reviews changes for defects, regressions and security risks.',
    instructions: 'Read the actual diff and the code it touches, not just the summary. Lead each finding with its evidence, rank by severity, and separate confirmed defects from suspicions.',
    tier: 'slow',
    preset: 'audit',
  },
  designer: {
    description: 'Shapes product surfaces: flows, interfaces and visual language.',
    instructions: 'Ground every choice in how a user meets the product. Keep the existing visual language rather than inventing beside it, and look at the result at real viewport sizes before calling it finished.',
    tier: 'default',
    preset: 'ideate',
  },
} as const satisfies Record<BuiltinRoleId, RoleDefinition>;

/** Built-in roles plus authority overrides through one canonical projection. */
export function effectiveRoleCatalog(catalog: ProfileCatalog): RoleCatalog {
  return Object.freeze({ ...BUILTIN_ROLE_DEFINITIONS, ...catalog.roles });
}
/** Display label for a role id with no explicit label: kebab words, capitalised. */
export function deriveRoleLabel(id: RoleId): string {
  return id.split('-').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The catalog an authority starts from. Built-in roles are implicit and live
 * only in BUILTIN_ROLE_DEFINITIONS; this payload stores overrides and custom
 * roles, so a fresh authority does not duplicate them. */
export const BUILTIN_PROFILE_CATALOG: ProfileCatalog = Object.freeze({
  roles: Object.freeze({}),
  tiers: Object.freeze({ default: Object.freeze({ model: DEFAULT_WORKERS_AI_MODEL_SPEC }) }),
});
