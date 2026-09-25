// Profile catalogs: pure data, validation and hashing. Resolution lives in ./resolve.ts.
// Role ids live only as record keys; version and digest live on the envelope.
import task from "../prompts/role-task.md" with { type: 'text' };
import researcher from "../prompts/role-researcher.md" with { type: 'text' };
import planner from "../prompts/role-planner.md" with { type: 'text' };
import auditor from "../prompts/role-auditor.md" with { type: 'text' };
import designer from "../prompts/role-designer.md" with { type: 'text' };
import * as v from 'valibot';
import { definePromptSection } from '../prompting/template';

import { NAMED_SWARM_PRESETS } from '../strategy/swarm-presets';
import { REASONING_EFFORTS } from '../providers/effort';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../providers/workers-ai';
import { isAccountName, isProviderScope } from '../credentials/accounts';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';
import {
  BUILTIN_ROLE_IDS, RoleIdSchema, TIER_IDS, TierIdSchema,
  type BuiltinRoleId, type ProfileCatalog, type RoleCatalog, type RoleId,
  type TierAssignments, type TierId, type RoleDefinition, type ProfileCatalogEnvelope,
} from '../types/profile';

export type {
  BuiltinTierId, ProfileAuthority, ProfileCatalog, RoleCatalog, RoleId,
  TierAssignment, TierAssignments, TierId, RoleDefinition, ProfileCatalogEnvelope,
} from '../types/profile';

export { TIER_IDS, TierIdSchema } from '../types/profile';

const ModelSpecSchema = v.pipe(v.string(), v.minLength(1));

const TierAssignmentSchema = v.pipe(
  v.strictObject({
    model: ModelSpecSchema,
    reasoningEffort: v.optional(v.picklist(REASONING_EFFORTS)),
    fallbacks: v.optional(v.pipe(v.array(ModelSpecSchema), v.minLength(1))),
  }),
  v.check(
    (tier) => new Set([tier.model, ...(tier.fallbacks ?? [])]).size === 1 + (tier.fallbacks?.length ?? 0),
    'a tier names each model once: a fallback repeats neither the tier model nor another fallback',
  ),
);

const TierAssignmentsSchema = v.pipe(
  v.objectWithRest({ default: TierAssignmentSchema }, TierAssignmentSchema),
  v.check(
    (tiers) => Object.keys(tiers).every((id) => v.safeParse(TierIdSchema, id).success),
    'a tier id is lowercase kebab-case, at most 32 characters',
  ),
);

/** Builtin tiers first in stable order, then the catalog's own; the one list every surface reads. */
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
  accounts: v.optional(v.record(
    v.pipe(v.string(), v.check(isProviderScope, 'a provider id is a-z, 0-9, dots, colons and dashes')),
    v.pipe(v.string(), v.check(isAccountName, 'an account name is a-z, 0-9 and dashes')),
  )),
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

/** Checked at write, so an unconfigured tier is refused before storage, not at the first turn. */
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
  // Counts writes: a pristine authority is 0; digest distinguishes default from custom content.
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  digest: DigestSchema,
  catalog: ProfileCatalogSchema,
});

export function formatProfileValidationIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.slice(0, 3).map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join('.') ?? '(root)';

    return `${path}: ${issue.message}`;
  }).join('; ');
}

/** Throws, naming the offending paths, on any shape violation. */
export function validateProfileCatalog(input: { value: unknown }): ProfileCatalog {
  const parsed = v.safeParse(ProfileCatalogSchema, input.value);

  if (!parsed.success) {
    throw new Error(`invalid profile catalog: ${formatProfileValidationIssues(parsed.issues)}`);
  }

  return parsed.output;
}

export function validateProfileCatalogEnvelope(input: { value: unknown }): ProfileCatalogEnvelope {
  const parsed = v.safeParse(ProfileCatalogEnvelopeSchema, input.value);

  if (!parsed.success) {
    throw new Error(`invalid profile catalog envelope: ${formatProfileValidationIssues(parsed.issues)}`);
  }

  return parsed.output;
}

/** Canonical JSON the digest covers (catalog only, never version or authority); exposed for WebCrypto hashing. */
export function profileCatalogCanonical(catalog: ProfileCatalog): string {
  return stableStringify(v.parse(JsonValueSchema, catalog));
}

export function profileCatalogDigest(catalog: ProfileCatalog): string {
  return sha256Hex(profileCatalogCanonical(catalog));
}

/**
 * Each instruction block covers ownership, limits, deliverable shape and blocked behaviour (unit-prompt.test.ts).
 * Several specifics are borrowed from oh-my-pi (can1357/oh-my-pi, MIT, `packages/coding-agent/src/prompts/`).
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

export function effectiveRoleCatalog(catalog: ProfileCatalog): RoleCatalog {
  return Object.freeze({ ...BUILTIN_ROLE_DEFINITIONS, ...catalog.roles });
}

export function deriveRoleLabel(id: RoleId): string {
  return id.split('-').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Stores only overrides and custom roles; builtins stay implicit. */
export const BUILTIN_PROFILE_CATALOG: ProfileCatalog = Object.freeze({
  roles: Object.freeze({}),
  tiers: Object.freeze({ default: Object.freeze({ model: DEFAULT_WORKERS_AI_MODEL_SPEC }) }),
});
