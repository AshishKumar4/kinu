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
import type { RunEventInput } from '../events/types';
import { diagnostics, toKinuError } from '../obs/index';

/** Effort carried when a tier assignment omits one: the stage the rest of core
 *  turns user-visible work at. */
const DEFAULT_TURN_REASONING_EFFORT: ReasoningEffort = REASONING_EFFORT_FOR_STAGE.chat;

/**
 * What the provider plane could enumerate, and what it could not.
 *
 * `availableModels` is a POSITIVE list and nothing else: presence proves a
 * model exists, absence proves nothing on its own. `unavailableProviders`
 * carries the listing calls that failed, so a reader can tell the two apart —
 * without it a vendor 503 is indistinguishable from "not connected", which is
 * how one degraded provider came to refuse every turn on the account,
 * including turns whose own tier ran somewhere else entirely.
 *
 * PRODUCER OBLIGATION on `revision`: it must change when the availability
 * picture changes, the failure set included. A snapshot taken while a provider
 * was down is a DIFFERENT picture from a healthy one, and anything keyed on
 * revision — a cache, a resolved profile's `providerRevision` — would
 * otherwise serve the degraded view as though it were complete. That fact is
 * recorded nowhere else: the resolved profile deliberately carries no
 * "admitted unverified" flag, because a new field there would churn the
 * profile digest and every snapshot already stored under it.
 */
const ProviderCatalogSnapshotSchema = v.looseObject({
  revision: v.string(),
  availableModels: v.array(v.string()),
  /** Provider listings that FAILED, shaped as `providers/registry.ts` reports
   *  them so a producer passes its own failure list through unmapped. Empty
   *  (or absent, for a producer with no failure channel) asserts the listing
   *  was COMPLETE — which is the assertion strict absence rests on. */
  unavailableProviders: v.optional(v.array(v.strictObject({
    provider: v.string(),
    label: v.string(),
    reason: v.string(),
  })), []),
});

/** The shape a PRODUCER supplies. Input-side rather than output-side on
 *  purpose: `unavailableProviders` is optional to emit — a producer with no
 *  failure channel has nothing to say — while the resolver reads the parsed
 *  form, where the default has already filled it in. */
export type ProviderCatalogSnapshot = v.InferInput<typeof ProviderCatalogSnapshotSchema>;

export type TierSource = 'explicit' | 'role' | 'default';
export interface ProfileAuthorityInputs {
  envelope: ProfileCatalogEnvelope;
  provider: ProviderCatalogSnapshot;
}

/** Where a snapshot came from — the cost half of the resolution evidence. */
export type ProviderCacheOutcome = 'hit' | 'joined' | 'miss';

/** A provider snapshot together with how it was obtained. The cache outcome
 *  travels with the snapshot because it is not a fact about the producer's
 *  plumbing, it is part of what this resolution cost. */
export interface ProviderSnapshotRead {
  readonly snapshot: ProviderCatalogSnapshot;
  readonly cache: ProviderCacheOutcome;
}

/**
 * Load both authority inputs, and record what it took.
 *
 * The two loads run concurrently because they are independent and both are on
 * the turn's critical path.
 *
 * THE EVIDENCE ROW IS EMITTED HERE, not by the caller. It answers "why did this
 * turn resolve this model, and what did resolution cost" — and it existed on
 * one backend only, because each caller decided for itself whether to write it,
 * so the question was answerable locally and unanswerable in production.
 * Emitting it where resolution actually happens is what makes the answer follow
 * the work instead of following whoever remembered.
 *
 * `record` is optional and takes the finished row: a caller routes it to its own
 * recorder and run id, which is the only part that is genuinely per backend. A
 * caller that passes nothing gets no row — stated, not guessed — and a failing
 * sink must not fail a turn, so the emit is guarded.
 */
export async function loadProfileAuthorityInputs(input: {
  envelope(): ProfileCatalogEnvelope | Promise<ProfileCatalogEnvelope>;
  provider(): ProviderSnapshotRead | Promise<ProviderSnapshotRead>;
  record?: (event: Extract<RunEventInput, { type: 'profile_resolution' }>) => void;
}): Promise<ProfileAuthorityInputs> {
  const startedAt = Date.now();
  const [envelope, read] = await Promise.all([input.envelope(), input.provider()]);
  const inputs: ProfileAuthorityInputs = { envelope, provider: read.snapshot };
  if (input.record) {
    try {
      input.record({
        type: 'profile_resolution',
        durationMs: Date.now() - startedAt,
        providerCache: read.cache,
        providerRevision: read.snapshot.revision,
        unavailableProviders: read.snapshot.unavailableProviders?.length ?? 0,
        catalogVersion: envelope.version,
        authority: envelope.authority.kind,
      });
    } catch (err) {
      diagnostics.failure('profile.resolution_event_failed', toKinuError({
        doing: 'recording a profile_resolution run event',
        cause: err,
        otherwise: 'io',
      }));
    }
  }
  return inputs;
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
    throw new Error('provider snapshot must carry {revision, availableModels} and, when '
      + 'present, unavailableProviders as {provider, label, reason} rows');
  }
  const provider = parsedProvider.output;
  // ABSENCE IS ONLY EVIDENCE WHEN THE LISTING WAS COMPLETE.
  //
  // `availableModels` is a positive list, so a model missing from it means one
  // of two unrelated things: the provider answered and does not carry it (a
  // misconfiguration, worth catching here at the turn boundary), or a listing
  // call failed and this view never covered it (nothing proved). The snapshot
  // says which by carrying its failures, so the rule is: claim absence only
  // when nothing failed.
  //
  // COMPLETENESS rather than per-provider matching, deliberately. A failure
  // row does not reliably name the model specs it cost: a failed catalog
  // enumeration reports one row for the catalog itself and drops every dynamic
  // provider it would have listed, unnamed. So matching a spec's provider
  // against the failure set would fail open precisely where the outage is
  // widest, which is the shape this rule exists to stop. A partial view proves
  // nothing about anything.
  //
  // The cost, stated rather than rediscovered as a bug: while any listing is
  // degraded, a retired or mistyped model on a HEALTHY provider stops being
  // caught here and fails at call time instead, where the provider names it.
  // That is the trade for never refusing a turn over a model nobody looked up.
  const listingComplete = provider.unavailableProviders.length === 0;
  const requireAvailable = (model: string, id: TierId): void => {
    if (!listingComplete || provider.availableModels.includes(model)) return;
    throw new Error(
      `model ${JSON.stringify(model)} configured for the ${id} tier `
      + `is unavailable on provider revision ${JSON.stringify(provider.revision)}; `
      + 'configure a different model for the tier or pick another tier',
    );
  };
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

  requireAvailable(assignment.model, tierId);

  const availableTools = role.allowedTools === undefined
    ? uniqueTools(input.availableTools)
    : intersectTools(input.availableTools, role.allowedTools);
  const skills = normalizeNames([role.skills ?? [], input.activeSkills]);
  // `plan` narrows only: build becomes plan; plan can never become build.
  const workMode: WorkMode = role.plan === true ? 'plan' : input.workMode;

  // The whole tier table, resolved once: an unconfigured slot aliases the
  // default assignment, and every slot meets the same availability rule as the
  // turn's own tier above, so no producer can meet a misconfiguration later.
  const defaultAssignment = envelope.catalog.tiers.default;
  if (!defaultAssignment) throw new Error('profile catalog has no default tier assignment');
  const tierSlot = (id: TierId): { model: string; reasoningEffort: ReasoningEffort } => {
    const slot = id === 'default' ? defaultAssignment : (envelope.catalog.tiers[id] ?? defaultAssignment);
    requireAvailable(slot.model, id);
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
