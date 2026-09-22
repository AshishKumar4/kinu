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
import task from "../prompts/role-task.md" with { type: 'text' };
import researcher from "../prompts/role-researcher.md" with { type: 'text' };
import planner from "../prompts/role-planner.md" with { type: 'text' };
import auditor from "../prompts/role-auditor.md" with { type: 'text' };
import designer from "../prompts/role-designer.md" with { type: 'text' };
import * as v from 'valibot';
import { definePromptSection } from '../prompting/template';

import { NAMED_SWARM_PRESETS } from '../strategy/swarm-presets';
import { REASONING_EFFORTS } from '../strategy/effort';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../providers/workers-ai';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';
import {
  TIER_IDS, TierIdSchema,
  type ProfileCatalog, type RoleCatalog, type RoleId,
  type TierAssignments, type TierId, type RoleDefinition, type ProfileCatalogEnvelope,
} from '../types/profile';

export type {
  BuiltinTierId, ProfileAuthority, ProfileCatalog, RoleCatalog, RoleId,
  TierAssignment, TierAssignments, TierId, RoleDefinition, ProfileCatalogEnvelope,
} from '../types/profile';

export { TIER_IDS, TierIdSchema } from '../types/profile';


// ── Vocabulary ───────────────────────────────────────────────────


/** The roles every authority implicitly ships. A catalog may override any of
 *  them by key; it cannot remove them. */
const BUILTIN_ROLE_IDS = [
  'task', 'researcher', 'planner', 'auditor', 'designer',
] as const;

export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

/**
 * The role an agent runs as when nobody has chosen one.
 *
 * Declared, not derived from the array's first slot: reordering the builtins
 * would then silently move the default. `satisfies` still makes removing this
 * role from the builtins a compile error, so the constant cannot outlive the
 * role it names. Config-store fallbacks read through this constant. The other
 * bare spellings sit in other lanes, inside core and out.
 */
export const DEFAULT_ROLE_ID = 'task' as const satisfies BuiltinRoleId;

/** Kebab-case, lowercase-first: the same discipline skill names follow. */
export const ROLE_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const ROLE_ID_MAX_LEN = 64;

const RoleIdSchema = v.pipe(v.string(), v.regex(ROLE_ID_RE), v.maxLength(ROLE_ID_MAX_LEN));

export function isValidRoleId(value: string): value is RoleId {
  return value.length <= ROLE_ID_MAX_LEN && ROLE_ID_RE.test(value);
}

/** Whether a stored string is a well-formed tier id. A GUARD rather than an
 *  assertion at the read sites: a durable row can hold a value written by
 *  another build. Whether the tier EXISTS is the catalog's question, answered
 *  at resolve time against the tiers it holds. */
export function isTierId(value: string): value is TierId {
  return v.safeParse(TierIdSchema, value).success;
}

// ── Wire shapes ──────────────────────────────────────────────────

const TierAssignmentSchema = v.strictObject({
  model: v.pipe(v.string(), v.minLength(1)),
  reasoningEffort: v.optional(v.picklist(REASONING_EFFORTS)),
});

const TierAssignmentsSchema = v.pipe(
  v.objectWithRest({ default: TierAssignmentSchema }, TierAssignmentSchema),
  v.check(
    (tiers) => Object.keys(tiers).every((id) => v.safeParse(TierIdSchema, id).success),
    'a tier id is lowercase kebab-case, at most 32 characters',
  ),
);

/** Every tier a catalog offers, the builtins first in their stable order, then
 *  the owner's own in the order the catalog holds them. The one list a settings
 *  control, a TUI cycler and a resolver all read, so a tier added in one place
 *  is offered everywhere. */
export function tierIdsOf(catalog: { readonly tiers: TierAssignments }): TierId[] {
  return [...new Set([...TIER_IDS, ...Object.keys(catalog.tiers)])];
}

const RoleDefinitionSchema = v.strictObject({
  label: v.optional(v.pipe(v.string(), v.minLength(1))),
  description: v.pipe(v.string(), v.minLength(1)),
  instructions: v.pipe(v.string(), v.minLength(1)),
  tier: TierIdSchema,
  preset: v.picklist(NAMED_SWARM_PRESETS),
  allowedTools: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  skills: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  spawns: v.optional(v.union([v.literal('*'), v.array(RoleIdSchema)])),
  plan: v.optional(v.literal(true)),
});

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

/** A role's tier is one the catalog offers: a builtin (which aliases default
 *  when unconfigured) or a tier this catalog holds. Checked at write, so a
 *  catalog naming a tier nobody configured is refused before it is stored
 *  rather than at the first turn that resolves through it. */
function allRoleTiersExist(catalog: v.InferOutput<typeof ProfileCatalogObjectSchema>): boolean {
  const known = new Set<string>(tierIdsOf(catalog));

  return Object.values(catalog.roles).every((role) => known.has(role.tier));
}

const ProfileCatalogSchema = v.pipe(
  ProfileCatalogObjectSchema,
  v.check(
    allSpawnReferencesExist,
    'every spawns entry must name a built-in role or a role in this catalog',
  ),
  v.check(allRoleTiersExist, 'every role tier must name a built-in tier or a tier in this catalog'),
);

export const ProfileAuthoritySchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('account'), accountId: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal('local') }),
]);

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
export function validateProfileCatalog(input: { value: unknown }): ProfileCatalog {
  const parsed = v.safeParse(ProfileCatalogSchema, input.value);

  if (!parsed.success) {
    throw new Error(`invalid profile catalog: ${formatProfileValidationIssues(parsed.issues)}`);
  }

  return parsed.output;
}

/** Same contract for a whole envelope: authority, CAS version, digest, catalog. */
export function validateProfileCatalogEnvelope(input: { value: unknown }): ProfileCatalogEnvelope {
  const parsed = v.safeParse(ProfileCatalogEnvelopeSchema, input.value);

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
/** The bytes the digest is over: the catalog as canonical JSON. Exposed so a
 *  surface without `node:crypto` (the browser gallery) hashes the same thing
 *  with WebCrypto rather than carrying a precomputed digest that goes stale. */
export function profileCatalogCanonical(catalog: ProfileCatalog): string {
  return stableStringify(v.parse(JsonValueSchema, catalog));
}

export function profileCatalogDigest(catalog: ProfileCatalog): string {
  return sha256Hex(profileCatalogCanonical(catalog));
}

// ── Built-in roles ───────────────────────────────────────────────

/**
 * The six roles shipped with the product, keyed by {@link BUILTIN_ROLE_IDS}.
 * Labels stay absent: display labels derive from ids unless an authority
 * overrides them.
 *
 * Every instruction block has the same four sections under its opening line:
 * what the role owns, what it never does, what it hands back and in what
 * shape, and what it does when blocked. A role with a boundary but no
 * deliverable shape hands back prose the parent has to re-derive; a role with
 * a deliverable but no blocked rule either guesses past the gap or gives up
 * on a question it could have answered. The prompt renders exactly this text
 * (prompt.ts renderRoleSection), and unit-prompt.test.ts holds every built-in
 * to the four sections.
 *
 * The shape is Kinu's. Several specifics are borrowed from oh-my-pi
 * (can1357/oh-my-pi, MIT, `packages/coding-agent/src/prompts/`) and named at
 * the role that carries them: the reviewer's criteria for what counts as a
 * finding and its consumer-side rule (`agents/reviewer.md`), the scout's
 * second-strategy rule for an empty search (`agents/scout.md`), the security
 * reviewer's empty-result contract (`agents/security-reviewer.md`), the
 * planner's closing critical-files list (`system/plan-mode-subagent.md`), and
 * the generic worker's task contract (`agents/task.md`), and the sub-agent
 * contract's blocked rule and its no-project-wide-validation
 * rule beside concurrent siblings (`system/subagent-system-prompt.md`).
 *
 * What the text names is only what every actor has: the `file`, `shell`, `web`,
 * `memory` and `agents` tools, the workspace file plane, and the `report`
 * handoff fields (events/hub/types.ts SUBORDINATE_REPORT_HANDOFF_FIELDS),
 * gated on "when you were hired" because `report` is a subordinate's tool.
 */
export const BUILTIN_ROLE_DEFINITIONS = {
  task: {
    description: 'General work: implement, run, fix.',
    instructions: definePromptSection('role/task', '', task.trimEnd()).render({}),
    tier: 'default',
    preset: 'ideate',
  },
  researcher: {
    description: 'Gathers evidence from files, tools and the web, then reports findings with sources.',
    instructions: definePromptSection('role/researcher', '', researcher.trimEnd()).render({}),
    tier: 'fast',
    preset: 'research',
  },
  planner: {
    description: 'Designs the approach before anything changes.',
    instructions: definePromptSection('role/planner', '', planner.trimEnd()).render({}),
    tier: 'deep',
    preset: 'ideate',
    plan: true,
  },
  auditor: {
    description: 'Reviews changes for defects, regressions and security risks.',
    instructions: definePromptSection('role/auditor', '', auditor.trimEnd()).render({}),
    tier: 'deep',
    preset: 'audit',
  },
  designer: {
    description: 'Shapes product surfaces: flows, interfaces and visual language.',
    instructions: definePromptSection('role/designer', '', designer.trimEnd()).render({}),
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
