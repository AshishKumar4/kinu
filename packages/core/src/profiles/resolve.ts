// Envelope, provider snapshot and role to a turn's profile. A missing tier aliases `default`; a stored tier its
// provider no longer lists runs on the account default, then Kinu's; an unlisted pin is an error.

import * as v from 'valibot';

import { isWorkMode, type WorkMode } from '../types/turn';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';
import { REASONING_EFFORT_FOR_STAGE, REASONING_EFFORTS, type ReasoningEffort } from '../providers/effort';
import type { NamedSwarmPreset } from '../strategy/swarm-presets';
import { ROLE_ID_RE, isValidRoleId } from '../types/profile';
import { TierIdSchema, tierIdsOf,
  BUILTIN_PROFILE_CATALOG, deriveRoleLabel, effectiveRoleCatalog,
  profileCatalogDigest, validateProfileCatalogEnvelope,
  type ProfileAuthority, type ProfileCatalogEnvelope, type RoleId, type TierAssignment, type TierId,
} from './catalog';
import type { RunEventInput } from '../events/types';
import { diagnostics, toKinuError } from '../obs/index';
import { specWithoutAccount } from '../providers/types';
import { declaredReasoningEffort } from '../providers/reasoning-effort';
import { currentOperationProfile } from './operation';
import type { ActorReference } from '../identity/actor-handle';

const DEFAULT_TURN_REASONING_EFFORT: ReasoningEffort = REASONING_EFFORT_FOR_STAGE.chat;

/** Absence from `availableModels` proves nothing unless no listing failed; `revision` changes with availability. */
const ProviderCatalogSnapshotSchema = v.looseObject({
  revision: v.string(),
  availableModels: v.array(v.string()),
  /** Failed listings (`providers/registry.ts`); empty: the listing was complete. */
  unavailableProviders: v.optional(v.array(v.strictObject({
    provider: v.string(),
    label: v.string(),
    reason: v.string(),
  })), []),
  /** Declared levels by spec; a model absent here declares none. */
  reasoningEfforts: v.optional(v.record(v.string(), v.array(v.picklist(REASONING_EFFORTS))), {}),
});

/** Input-side on purpose: `unavailableProviders` is optional to emit. */
export type ProviderCatalogSnapshot = v.InferInput<typeof ProviderCatalogSnapshotSchema>;

export type TierSource = 'explicit' | 'role' | 'default' | 'workspace' | 'actor';

export interface ProfileAuthorityInputs {
  envelope: ProfileCatalogEnvelope;
  provider: ProviderCatalogSnapshot;
}

export type ProviderCacheOutcome = 'hit' | 'joined' | 'miss';

export interface ProviderSnapshotRead {
  readonly snapshot: ProviderCatalogSnapshot;
  readonly cache: ProviderCacheOutcome;
}

/** Loads both inputs at once; `record` gets the `profile_resolution` row, guarded. */
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
  /** Overrides the role's tier model; source `workspace`. */
  workspaceModel?: string | null | undefined;
  /** A hosted actor's own pin: over the workspace's, source `actor`. */
  actorModel?: string | null | undefined;
  /** A stored effort for this actor or workspace: over the tier's. */
  explicitEffort?: ReasoningEffort | null | undefined;
  workMode: string;
  availableTools: readonly string[];
  activeSkills: readonly string[];
}

export type ResolveAgentTurnProfileInput = Omit<ResolveTurnProfileInput, 'roleId'> & {
  activeRoleId: string;
};

export interface TierFallback {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
}

export interface TierRoute {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly fallbacks: readonly TierFallback[];
}

export interface ResolvedTurnProfile {
  readonly role: {
    readonly id: RoleId;
    readonly label: string;
    readonly description: string;
    readonly instructions: string;
  };
  readonly tier: {
    readonly id: TierId;
    readonly source: TierSource;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort | null;
    readonly fallbacks: readonly TierFallback[];
    /** The configured model its provider no longer lists, which `model` stands in for. */
    readonly replaced: string | null;
  };
  readonly tiers: Readonly<Record<TierId, TierRoute>>;
  readonly workMode: WorkMode;
  readonly skills: readonly string[];
  readonly allowedTools: readonly string[];
  readonly defaultPreset: NamedSwarmPreset;
  readonly authority: ProfileAuthority;
  readonly catalogVersion: number;
  readonly providerRevision: string;
  readonly digest: string;
}

function providerOf(spec: string): string {
  const slash = spec.indexOf('/');

  return slash < 1 ? '' : spec.slice(0, slash);
}

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

/** Tool ids stay byte-exact; only skill names normalize whitespace. */
function intersectTools(available: readonly string[], allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  const permitted = available.filter((tool) => allow.has(tool));

  return uniqueTools(permitted);
}

export function resolveTurnProfile(input: ResolveTurnProfileInput): ResolvedTurnProfile {
  const envelope = validateProfileCatalogEnvelope({ value: input.envelope });
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
    const parsedTier = v.safeParse(TierIdSchema, input.explicitTier);

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
  // Failure rows do not name every spec they cost; while degraded, a typo fails at call time.
  const listingComplete = provider.unavailableProviders.length === 0;

  // A provider that lists nothing proves nothing.
  const listing = new Set(provider.availableModels.map(providerOf));

  const listed = (spec: string): boolean => {
    const bare = specWithoutAccount(spec);

    return provider.availableModels.includes(bare) || !listing.has(providerOf(bare));
  };

  const servable = (model: string, fallbacks: readonly string[]): boolean => !listingComplete || [model, ...fallbacks].some(listed);

  const unavailable = (model: string, fallbacks: readonly string[], id: TierId): Error => new Error(
    `model ${JSON.stringify(model)} configured for the ${id} tier `
    + `is unavailable on provider revision ${JSON.stringify(provider.revision)}`
    + `${fallbacks.length > 0 ? ', as is each of its fallbacks' : ''}; `
    + 'configure a different model for the tier or pick another tier',
  );

  // A pin is refused when no model of the chain is listed.
  const requireAvailable = (model: string, fallbacks: readonly string[], id: TierId): void => {
    if (!servable(model, fallbacks)) throw unavailable(model, fallbacks, id);
  };

  const defaultAssignment = envelope.catalog.tiers.default;

  if (!defaultAssignment) throw new Error('profile catalog has no default tier assignment');

  /** A stored tier that cannot serve runs on the account default, then Kinu's. */
  const serving = (id: TierId, stored: TierAssignment): TierAssignment => {
    if (servable(stored.model, stored.fallbacks ?? [])) return stored;

    const replacement = [defaultAssignment, BUILTIN_PROFILE_CATALOG.tiers.default]
      .find((candidate) => candidate !== undefined && servable(candidate.model, candidate.fallbacks ?? []));

    if (replacement === undefined) throw unavailable(stored.model, stored.fallbacks ?? [], id);
    diagnostics.event('profile.tier_model_unlisted', { tier: id, model: stored.model, served: replacement.model });

    return replacement;
  };

  const effortFor = (spec: string, wanted: ReasoningEffort): ReasoningEffort | null =>
    declaredReasoningEffort(wanted, provider.reasoningEfforts[specWithoutAccount(spec)]);

  const chainOf = (specs: readonly string[], wanted: ReasoningEffort): readonly TierFallback[] => Object.freeze(
    specs.map((spec) => Object.freeze({ model: spec, reasoningEffort: effortFor(spec, wanted) })),
  );

  const roles = effectiveRoleCatalog(envelope.catalog);

  const role = roles[input.roleId];

  if (!role) {
    throw new Error(`unknown role ${JSON.stringify(input.roleId)}: known roles are ${Object.keys(roles).sort().join(', ')}`);
  }

  const requested: TierId = explicitTier ?? role.tier;

  if (!tierIdsOf(envelope.catalog).includes(requested)) {
    throw new Error(`unknown tier ${JSON.stringify(requested)}: known tiers are ${tierIdsOf(envelope.catalog).join(', ')}`);
  }

  let tierId: TierId = requested;
  let source: TierSource;
  let stored = envelope.catalog.tiers[requested];

  if (stored) {
    source = explicitTier !== undefined ? 'explicit' : 'role';
  } else {
    tierId = 'default';
    source = 'default';
    stored = defaultAssignment;
  }

  const assignment = serving(tierId, stored);
  let replaced: string | null = null;

  if (assignment !== stored) {
    tierId = 'default';
    source = 'default';
    replaced = stored.model;
  }

  const tierFallbacks = assignment.fallbacks ?? [];

  let model = assignment.model;

  if (input.workspaceModel !== undefined && input.workspaceModel !== null) {
    requireAvailable(input.workspaceModel, tierFallbacks, tierId);
    model = input.workspaceModel;
    source = 'workspace';
    replaced = null;
  }

  if (input.actorModel !== undefined && input.actorModel !== null) {
    requireAvailable(input.actorModel, tierFallbacks, tierId);
    model = input.actorModel;
    source = 'actor';
    replaced = null;
  }

  const availableTools = role.allowedTools === undefined
    ? uniqueTools(input.availableTools)
    : intersectTools(input.availableTools, role.allowedTools);

  const skills = normalizeNames([role.skills ?? [], input.activeSkills]);
  const workMode: WorkMode = role.plan === true ? 'plan' : input.workMode;

  const tierSlot = (id: TierId): TierRoute => {
    const slot = serving(id, id === 'default' ? defaultAssignment : (envelope.catalog.tiers[id] ?? defaultAssignment));
    const wanted = slot.reasoningEffort ?? DEFAULT_TURN_REASONING_EFFORT;

    return Object.freeze({
      model: slot.model,
      reasoningEffort: effortFor(slot.model, wanted),
      fallbacks: chainOf(slot.fallbacks ?? [], wanted),
    });
  };

  const wantedEffort = input.explicitEffort ?? assignment.reasoningEffort ?? DEFAULT_TURN_REASONING_EFFORT;
  const tierIds = tierIdsOf(envelope.catalog);
  const tiers: Record<TierId, TierRoute> = {};

  for (const id of tierIds) tiers[id] = tierSlot(id);
  Object.freeze(tiers);

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
      model,
      reasoningEffort: effortFor(model, wantedEffort),
      fallbacks: chainOf(tierFallbacks.filter((spec) => spec !== model), wantedEffort),
      replaced,
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

export function resolveAgentTurnProfile(
  input: ResolveAgentTurnProfileInput,
): ResolvedTurnProfile {
  const { activeRoleId, ...turn } = input;

  return resolveTurnProfile({ ...turn, roleId: activeRoleId });
}

/** Detached work inherits its issuer; new work reads current authority. */
export async function resolveRoutingProfile(deps: {
  readonly actor: ActorReference;
  readonly resolve: () => Promise<ResolvedTurnProfile>;
}): Promise<ResolvedTurnProfile> {
  return currentOperationProfile(deps.actor)?.profile ?? await deps.resolve();
}
