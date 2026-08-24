// Turn-profile resolution — the one function that turns a catalog envelope, a
// provider snapshot and a role into everything a single turn runs under.
//
// The rules are narrow on purpose:
//   - A missing non-default tier aliases `default`; that is the only fallback.
//   - A configured model the provider snapshot does not list is an ERROR. The
//     resolver never quietly substitutes another model — silent model swaps
//     corrupt spend accounting and break reproducibility.
//   - A role narrows. Its action list intersects the caller's surface, its
//     `plan` flag can push build toward plan but never the reverse, and its
//     skills add to the turn's active set without removing anything.
//   - Output is deeply frozen and deterministic: same inputs, same profile.
//
// The envelope's digest is re-derived here, so a catalog tampered with between
// storage and resolution fails at the turn boundary instead of running under
// configuration nobody signed off.

import * as v from 'valibot';

import { isWorkMode, type WorkMode } from '../prompting/surface';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';
import { REASONING_EFFORT_FOR_STAGE, type ReasoningEffort } from '../strategy/effort';
import type { NamedSwarmPreset } from '../strategy/swarm-presets';
import {
  ROLE_ID_RE, TIER_IDS,
  deriveRoleLabel, effectiveRoleCatalog, isValidRoleId,
  profileCatalogDigest, validateProfileCatalogEnvelope,
  type ProfileAuthority, type ProfileCatalogEnvelope, type RoleId, type TierId,
} from './catalog';

/** Effort carried when a tier assignment omits one: the stage the rest of core
 *  turns user-visible work at. */
const DEFAULT_TURN_REASONING_EFFORT: ReasoningEffort = REASONING_EFFORT_FOR_STAGE.chat;

export const ProviderCatalogSnapshotSchema = v.looseObject({
  revision: v.string(),
  availableModels: v.array(v.string()),
});

export type ProviderCatalogSnapshot = v.InferOutput<typeof ProviderCatalogSnapshotSchema>;

export type TierSource = 'explicit' | 'role' | 'default';
export interface ProfileAuthorityInputs {
  envelope: ProfileCatalogEnvelope;
  provider: ProviderCatalogSnapshot;
}

export async function loadProfileAuthorityInputs(input: {
  envelope(): ProfileCatalogEnvelope | Promise<ProfileCatalogEnvelope>;
  provider(): ProviderCatalogSnapshot | Promise<ProviderCatalogSnapshot>;
}): Promise<ProfileAuthorityInputs> {
  const [envelope, provider] = await Promise.all([input.envelope(), input.provider()]);
  return { envelope, provider };
}


export interface ResolveTurnProfileInput {
  envelope: ProfileCatalogEnvelope;
  provider: ProviderCatalogSnapshot;
  roleId: string;
  explicitTier?: string | undefined;
  workMode: string;
  availableTools: readonly string[];
  activeSkills: readonly string[];
}

export type ResolveAgentTurnProfileInput = Omit<ResolveTurnProfileInput, 'roleId'> & {
  activeRoleId: string;
};

export interface ResolvedTurnProfile {
  readonly role: {
    readonly id: RoleId;
    readonly label: string;
    readonly description: string;
    readonly instructions: string;
  };
  readonly tier: {
    /** The tier whose assignment supplied the model — after any fallback. */
    readonly id: TierId;
    /** Why: the caller asked (`explicit`), the role declares it (`role`), or
     *  the asked-for tier had no row and aliased to `default`. */
    readonly source: TierSource;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort;
  };
  readonly tiers: Readonly<Record<TierId, {
    model: string;
    reasoningEffort: ReasoningEffort;
  }>>;
  readonly workMode: WorkMode;
  readonly skills: readonly string[];
  readonly allowedTools: readonly string[];
  readonly defaultPreset: NamedSwarmPreset;
  readonly authority: ProfileAuthority;
  readonly catalogVersion: number;
  readonly providerRevision: string;
  readonly digest: string;
}

/** Trimmed, empty-free, de-duplicated names in first-seen order across every
 *  contributing list. */
function normalizeNames(lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const name = raw.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function uniqueTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tool of tools) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    unique.push(tool);
  }
  return unique;
}

/** The caller's surface restricted to what the role allows: available order
 * stays stable, duplicates disappear, and a tool the runtime does not expose
 * never appears. Tool ids stay byte-exact; only skill names normalize
 * whitespace. */
function intersectTools(available: readonly string[], allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  const permitted = available.filter((tool) => allow.has(tool));
  return uniqueTools(permitted);
}



export function resolveTurnProfile(input: ResolveTurnProfileInput): ResolvedTurnProfile {
  const envelope = validateProfileCatalogEnvelope(input.envelope);
  const catalogDigest = profileCatalogDigest(envelope.catalog);
  if (catalogDigest !== input.envelope.digest) {
    throw new Error(
      `profile catalog digest mismatch: envelope carries ${input.envelope.digest} `
      + `but the catalog hashes to ${catalogDigest}`,
    );
  }

  if (!isWorkMode(input.workMode)) {
    throw new Error(`invalid work mode: ${JSON.stringify(input.workMode)}`);
  }
  if (!isValidRoleId(input.roleId)) {
    throw new Error(`invalid role id ${JSON.stringify(input.roleId)}: must match ${ROLE_ID_RE.source}`);
  }
  let explicitTier: TierId | undefined;
  if (input.explicitTier !== undefined) {
    const parsedTier = v.safeParse(v.picklist(TIER_IDS), input.explicitTier);
    if (!parsedTier.success) {
      throw new Error(`invalid explicit tier: ${JSON.stringify(input.explicitTier)}`);
    }
    explicitTier = parsedTier.output;
  }
  const parsedProvider = v.safeParse(ProviderCatalogSnapshotSchema, input.provider);
  if (!parsedProvider.success) {
    throw new Error('provider snapshot must carry {revision, availableModels}');
  }
  const provider = parsedProvider.output;
  const roles = effectiveRoleCatalog(envelope.catalog);

  const role = roles[input.roleId];
  if (!role) {
    throw new Error(`unknown role ${JSON.stringify(input.roleId)}: known roles are ${Object.keys(roles).sort().join(', ')}`);
  }

  // Tier selection. One fallback exists: an unconfigured non-default tier
  // aliases `default`, which validation guarantees present.
  const requested: TierId = explicitTier ?? role.tier;
  let tierId: TierId = requested;
  let source: TierSource;
  let assignment = envelope.catalog.tiers[requested];
  if (assignment) {
    source = explicitTier !== undefined ? 'explicit' : 'role';
  } else {
    tierId = 'default';
    source = 'default';
    assignment = envelope.catalog.tiers.default;
  }

  if (!provider.availableModels.includes(assignment.model)) {
    throw new Error(
      `model ${JSON.stringify(assignment.model)} configured for the ${tierId} tier `
      + `is unavailable on provider revision ${JSON.stringify(provider.revision)}; `
      + 'configure a different model for the tier or pick another tier',
    );
  }

  const availableTools = role.allowedTools === undefined
    ? uniqueTools(input.availableTools)
    : intersectTools(input.availableTools, role.allowedTools);
  const skills = normalizeNames([role.skills ?? [], input.activeSkills]);
  // `plan` narrows only: build becomes plan; plan can never become build.
  const workMode: WorkMode = role.plan === true ? 'plan' : input.workMode;

  // The whole tier table, resolved once: an unconfigured slot aliases the
  // default assignment, and a configured model the provider does not list is
  // an error — the same rule the turn's own tier follows above, applied to
  // every slot so no producer can meet a misconfiguration later.
  const defaultAssignment = envelope.catalog.tiers.default;
  if (!defaultAssignment) throw new Error('profile catalog has no default tier assignment');
  const tierSlot = (id: TierId): { model: string; reasoningEffort: ReasoningEffort } => {
    const slot = id === 'default' ? defaultAssignment : (envelope.catalog.tiers[id] ?? defaultAssignment);
    if (!provider.availableModels.includes(slot.model)) {
      throw new Error(
        `model ${JSON.stringify(slot.model)} configured for the ${id} tier `
        + `is unavailable on provider revision ${JSON.stringify(provider.revision)}; `
        + 'configure a different model for the tier or pick another tier',
      );
    }
    return Object.freeze({
      model: slot.model,
      reasoningEffort: slot.reasoningEffort ?? DEFAULT_TURN_REASONING_EFFORT,
    });
  };
  const tiers = Object.freeze({
    tiny: tierSlot('tiny'),
    fast: tierSlot('fast'),
    default: tierSlot('default'),
    slow: tierSlot('slow'),
    deep: tierSlot('deep'),
  });

  const resolved = {
    role: Object.freeze({
      id: input.roleId,
      label: role.label ?? deriveRoleLabel(input.roleId),
      description: role.description,
      instructions: role.instructions,
    }),
    tier: Object.freeze({
      id: tierId,
      source,
      model: assignment.model,
      reasoningEffort: assignment.reasoningEffort ?? DEFAULT_TURN_REASONING_EFFORT,
    }),
    workMode,
    skills: Object.freeze(skills),
    allowedTools: Object.freeze(availableTools),
    defaultPreset: role.preset,
    authority: Object.freeze({ ...envelope.authority }),
    catalogVersion: envelope.version,
    providerRevision: provider.revision,
    tiers: Object.freeze(tiers),
  };
  const profileDigest = sha256Hex(stableStringify(v.parse(JsonValueSchema, resolved)));
  return Object.freeze({ ...resolved, digest: profileDigest });
}

/** Resolve a backend agent's active role through the shared turn resolver. */
export function resolveAgentTurnProfile(
  input: ResolveAgentTurnProfileInput,
): ResolvedTurnProfile {
  const { activeRoleId, ...turn } = input;
  return resolveTurnProfile({ ...turn, roleId: activeRoleId });
}
