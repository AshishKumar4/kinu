// Envelope, provider snapshot and role to a turn's profile. A missing tier aliases `default`; a stored tier its
// provider no longer lists runs on the account default, then Kinu's; an unlisted pin is an error.

import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError, settleSync } from '../obs/index';

import { isWorkMode, type WorkMode } from '../types/turn';
import { sha256Hex, stableStringify } from '../safety/argument-digest';
import { JsonValueSchema } from '../utils/json';
import { REASONING_EFFORT_FOR_STAGE, REASONING_EFFORTS, type ReasoningEffort } from '../providers/effort';
import type { NamedSwarmPreset } from '../types/swarm';
import { DEFAULT_PROVIDER_RETRIES, ROLE_ID_RE, isValidRoleId } from '../types/profile';
import { DEFAULT_DECISION_MODEL, type DecisionModel } from '../providers/decision-model';
import { TierIdSchema, tierIdsOf,
  BUILTIN_PROFILE_CATALOG, SYSTEM_ROLE_DEFINITIONS, deriveRoleLabel, effectiveRoleCatalog,
  profileCatalogDigest, validateProfileCatalogEnvelope,
  type ProfileAuthority, type ProfileCatalogEnvelope, type RoleCatalog, type RoleId, type TierAssignment, type TierId,
} from './catalog';
import type { RunEventInput } from '../events/types';
import { diagnostics, settleLoggedSync } from '../obs/index';
import { specWithoutAccount } from '../providers/types';
import { declaredReasoningEffort } from '../providers/reasoning-effort';
import { currentOperationProfile } from './operation';
import type { ActorReference } from '../identity/actor-handle';
import type { AgentConfigStore } from '../config/store';

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

  const record = input.record;

  if (record) {
    settleLoggedSync('profile.resolution_event_failed', { doing: 'recording a profile_resolution run event', otherwise: 'io' }, () => {
      record({
        type: 'profile_resolution',
        durationMs: Date.now() - startedAt,
        providerCache: read.cache,
        providerRevision: read.snapshot.revision,
        unavailableProviders: read.snapshot.unavailableProviders?.length ?? 0,
        catalogVersion: envelope.version,
        authority: envelope.authority.kind,
      });
    });
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
  /** The effort a hire's parent runs at ({@link parentReasoningEffort}): under the tier's own, over the default. */
  inheritedEffort?: ReasoningEffort | null | undefined;
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
  readonly retries: number;
  /** The decision model that rates this actor's turns. */
  readonly decisionModel: DecisionModel;
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

/** The checked envelope and listing, with the rules that read them. */
interface CheckedAuthority {
  readonly envelope: ProfileCatalogEnvelope;
  readonly provider: v.InferOutput<typeof ProviderCatalogSnapshotSchema>;
  readonly roles: RoleCatalog;
  readonly defaultAssignment: TierAssignment;
  /** A stored tier that cannot serve runs on the account default, then Kinu's. */
  serving(id: TierId, stored: TierAssignment): TierAssignment;
  /** A pin is refused when no model of the chain is listed. */
  requireAvailable(model: string, fallbacks: readonly string[], id: TierId): Effect.Effect<void>;
  effortFor(spec: string, wanted: ReasoningEffort): ReasoningEffort | null;
  chainOf(model: string, tierChain: readonly string[], wanted: ReasoningEffort): readonly TierFallback[];
}

function checkedAuthority(input: ProfileAuthorityInputs): Effect.Effect<CheckedAuthority> {
  return Effect.gen(function* () {
    const envelope = validateProfileCatalogEnvelope({ value: input.envelope });
    const catalogDigest = profileCatalogDigest(envelope.catalog);

    if (catalogDigest !== input.envelope.digest) {
      return yield* Effect.die(new Error(
        `profile catalog digest mismatch: envelope carries ${input.envelope.digest} `
        + `but the catalog hashes to ${catalogDigest}`,
      ));
    }

    const parsedProvider = v.safeParse(ProviderCatalogSnapshotSchema, input.provider);

    if (!parsedProvider.success) {
      return yield* Effect.die(new Error('provider snapshot must carry {revision, availableModels} and, when '
        + 'present, unavailableProviders as {provider, label, reason} rows'));
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

    const defaultAssignment = envelope.catalog.tiers.default;

    if (!defaultAssignment) return yield* Effect.die(new Error('profile catalog has no default tier assignment'));

    const effortFor = (spec: string, wanted: ReasoningEffort): ReasoningEffort | null =>
      declaredReasoningEffort(wanted, provider.reasoningEfforts[specWithoutAccount(spec)]);

    return {
      envelope,
      provider,
      roles: { ...effectiveRoleCatalog(envelope.catalog), ...SYSTEM_ROLE_DEFINITIONS },
      defaultAssignment,
      serving(id, stored) {
        if (servable(stored.model, stored.fallbacks ?? [])) return stored;

        const replacement = [defaultAssignment, BUILTIN_PROFILE_CATALOG.tiers.default]
          .find((candidate) => candidate !== undefined && servable(candidate.model, candidate.fallbacks ?? []));

        if (replacement === undefined) throw unavailable(stored.model, stored.fallbacks ?? [], id);
        diagnostics.event('profile.tier_model_unlisted', { tier: id, model: stored.model, served: replacement.model });

        return replacement;
      },
      requireAvailable(model, fallbacks, id) {
        return Effect.gen(function* () {
          if (!servable(model, fallbacks)) return yield* Effect.die(unavailable(model, fallbacks, id));
        });
      },
      effortFor,
      chainOf: (model, tierChain, wanted) => Object.freeze(
        (envelope.catalog.modelFallbacks?.[model] ?? tierChain).filter((spec) => spec !== model)
          .map((spec) => Object.freeze({ model: spec, reasoningEffort: effortFor(spec, wanted) })),
      ),
    };
  });
}

type TierChoice = Pick<ResolveTurnProfileInput, 'roleId' | 'explicitTier' | 'workspaceModel' | 'actorModel' | 'explicitEffort' | 'inheritedEffort'>;

/** The role, tier, model and effort a turn, or a hire's parent, runs at. */
function chosenTier(authority: CheckedAuthority, input: TierChoice) {
  return Effect.gen(function* () {
    const { envelope } = authority;

    if (!isValidRoleId(input.roleId)) {
      return yield* Effect.die(new Error(`invalid role id ${JSON.stringify(input.roleId)}: must match ${ROLE_ID_RE.source}`));
    }

    let explicitTier: TierId | undefined;

    if (input.explicitTier !== undefined) {
      const parsedTier = v.safeParse(TierIdSchema, input.explicitTier);

      if (!parsedTier.success) {
        return yield* Effect.die(new Error(`invalid explicit tier: ${JSON.stringify(input.explicitTier)}`));
      }

      explicitTier = parsedTier.output;
    }

    const role = authority.roles[input.roleId];

    if (!role) {
      return yield* Effect.die(new Error(`unknown role ${JSON.stringify(input.roleId)}: known roles are ${Object.keys(authority.roles).sort().join(', ')}`));
    }

    const requested: TierId = explicitTier ?? role.tier;

    if (!tierIdsOf(envelope.catalog).includes(requested)) {
      return yield* Effect.die(new Error(`unknown tier ${JSON.stringify(requested)}: known tiers are ${tierIdsOf(envelope.catalog).join(', ')}`));
    }

    let tierId: TierId = requested;
    let source: TierSource;
    let stored = envelope.catalog.tiers[requested];

    if (stored) {
      source = explicitTier !== undefined ? 'explicit' : 'role';
    } else {
      tierId = 'default';
      source = 'default';
      stored = authority.defaultAssignment;
    }

    const assignment = authority.serving(tierId, stored);
    let replaced: string | null = null;

    if (assignment !== stored) {
      tierId = 'default';
      source = 'default';
      replaced = stored.model;
    }

    const fallbacks = assignment.fallbacks ?? [];

    let model = assignment.model;

    for (const pin of modelPins(input)) {
      yield* authority.requireAvailable(pin.model, fallbacks, tierId);
      model = pin.model;
      source = pin.source;
      replaced = null;
    }

    const wantedEffort = input.explicitEffort ?? assignment.reasoningEffort ?? input.inheritedEffort ?? DEFAULT_TURN_REASONING_EFFORT;

    return { role, tierId, source, model, replaced, fallbacks, wantedEffort, reasoningEffort: authority.effortFor(model, wantedEffort) };
  });
}

export function resolveTurnProfile(input: ResolveTurnProfileInput): ResolvedTurnProfile {
  return settleSync(Effect.gen(function* () {
    const authority = yield* checkedAuthority(input);
    const { envelope, provider } = authority;

    if (!isWorkMode(input.workMode)) {
      return yield* Effect.die(new Error(`invalid work mode: ${JSON.stringify(input.workMode)}`));
    }

    const chosen = yield* chosenTier(authority, input);
    const { role } = chosen;

    const availableTools = role.allowedTools === undefined
      ? uniqueTools(input.availableTools)
      : intersectTools(input.availableTools, role.allowedTools);

    const skills = normalizeNames([role.skills ?? [], input.activeSkills]);
    const workMode: WorkMode = role.plan === true ? 'plan' : input.workMode;

    const tierSlot = (id: TierId): TierRoute => {
      const slot = authority.serving(id, id === 'default' ? authority.defaultAssignment : (envelope.catalog.tiers[id] ?? authority.defaultAssignment));
      const wanted = slot.reasoningEffort ?? DEFAULT_TURN_REASONING_EFFORT;

      return Object.freeze({
        model: slot.model,
        reasoningEffort: authority.effortFor(slot.model, wanted),
        fallbacks: authority.chainOf(slot.model, slot.fallbacks ?? [], wanted),
      });
    };

    const tiers: Record<TierId, TierRoute> = {};

    for (const id of tierIdsOf(envelope.catalog)) tiers[id] = tierSlot(id);
    Object.freeze(tiers);

    const resolved = {
      role: Object.freeze({
        id: input.roleId,
        label: role.label ?? deriveRoleLabel(input.roleId),
        description: role.description,
        instructions: role.instructions,
      }),
      tier: Object.freeze({
        id: chosen.tierId,
        source: chosen.source,
        model: chosen.model,
        reasoningEffort: chosen.reasoningEffort,
        fallbacks: authority.chainOf(chosen.model, chosen.fallbacks, chosen.wantedEffort),
        replaced: chosen.replaced,
      }),
      workMode,
      skills: Object.freeze(skills),
      allowedTools: Object.freeze(availableTools),
      defaultPreset: role.preset,
      authority: Object.freeze({ ...envelope.authority }),
      catalogVersion: envelope.version,
      providerRevision: provider.revision,
      tiers: Object.freeze(tiers),
      retries: envelope.catalog.retries ?? DEFAULT_PROVIDER_RETRIES,
      decisionModel: envelope.catalog.decisionModel ?? DEFAULT_DECISION_MODEL,
    };

    const profileDigest = sha256Hex(stableStringify(v.parse(JsonValueSchema, resolved)));

    return Object.freeze({ ...resolved, digest: profileDigest });
  }));
}

/** The pins a turn's model takes, weakest first: the workspace's, then the actor's own. A runtime preset takes
 *  none: the advisor's second opinion is not the model it reviews. */
function modelPins(input: Pick<ResolveTurnProfileInput, 'roleId' | 'workspaceModel' | 'actorModel'>): readonly {
  readonly model: string;
  readonly source: 'workspace' | 'actor';
}[] {
  if (Object.hasOwn(SYSTEM_ROLE_DEFINITIONS, input.roleId)) return [];

  return [
    ...(input.workspaceModel === undefined || input.workspaceModel === null ? [] : [{ model: input.workspaceModel, source: 'workspace' as const }]),
    ...(input.actorModel === undefined || input.actorModel === null ? [] : [{ model: input.actorModel, source: 'actor' as const }]),
  ];
}

export function resolveAgentTurnProfile(
  input: ResolveAgentTurnProfileInput,
): ResolvedTurnProfile {
  const { activeRoleId, ...turn } = input;

  return resolveTurnProfile({ ...turn, roleId: activeRoleId });
}

/** What an actor's own configuration pins, which its turn resolves from. */
export type PinnedProfile = Pick<AgentConfigStore, 'getRoleSelection' | 'getAssignedTier' | 'getModel' | 'getReasoningEffort'>;

/**
 * The effort a hire's parent runs at, each ancestor chosen from the root down as its own turn is. `ancestors` runs
 * nearest first and ends at the root, whose model pin is the workspace's.
 */
export function parentReasoningEffort(authority: ProfileAuthorityInputs, ancestors: readonly PinnedProfile[]): ReasoningEffort | null {
  return settleSync(Effect.gen(function* () {
    const checked = yield* checkedAuthority(authority);
    const workspaceModel = ancestors.at(-1)?.getModel() ?? null;
    let inherited: ReasoningEffort | null = null;

    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const actor = ancestors[index];

      if (actor === undefined) break;
      inherited = (yield* chosenTier(checked, {
        roleId: actor.getRoleSelection(),
        explicitTier: actor.getAssignedTier() ?? undefined,
        workspaceModel,
        actorModel: index === ancestors.length - 1 ? null : actor.getModel(),
        explicitEffort: actor.getReasoningEffort(),
        inheritedEffort: inherited,
      })).reasoningEffort;
    }

    return inherited;
  }));
}

/** A hosted actor's ancestors' pins, nearest first, ending at the root's; `parentOf` reads one registered actor. */
export function ancestorPins(
  parentActorId: string | null,
  root: { readonly actorId: string; readonly pins: PinnedProfile },
  parentOf: (actorId: string) => { readonly parentActorId: string | null; readonly pins: PinnedProfile } | null,
): PinnedProfile[] {
  return settleSync(Effect.suspend(() => {
    const ancestors: PinnedProfile[] = [];

    for (let id = parentActorId; id !== null && id !== root.actorId;) {
      const parent = parentOf(id);

      if (parent === null) return Effect.fail(new KinuError('missing', `the hosted actor's parent ${id} is not registered`));
      ancestors.push(parent.pins);
      id = parent.parentActorId;
    }

    return Effect.succeed([...ancestors, root.pins]);
  }));
}

export function ownProfileChoices(
  config: PinnedProfile,
  authority: ProfileAuthorityInputs,
  ancestors?: readonly PinnedProfile[],
  request: Pick<ResolveTurnProfileInput, 'explicitTier' | 'explicitEffort'> = {},
): Pick<ResolveAgentTurnProfileInput, 'activeRoleId' | 'explicitTier' | 'workspaceModel' | 'actorModel' | 'explicitEffort' | 'inheritedEffort'> {
  const root = ancestors?.at(-1);

  return {
    activeRoleId: config.getRoleSelection(),
    explicitTier: request.explicitTier ?? config.getAssignedTier() ?? undefined,
    workspaceModel: root === undefined ? config.getModel() : root.getModel(),
    actorModel: root === undefined ? null : config.getModel(),
    explicitEffort: request.explicitEffort ?? config.getReasoningEffort(),
    inheritedEffort: ancestors === undefined ? null : parentReasoningEffort(authority, ancestors),
  };
}

/** Detached work inherits its issuer; new work reads current authority. */
export async function resolveRoutingProfile(deps: {
  readonly actor: ActorReference;
  readonly resolve: () => Promise<ResolvedTurnProfile>;
}): Promise<ResolvedTurnProfile> {
  return currentOperationProfile(deps.actor)?.profile ?? await deps.resolve();
}
