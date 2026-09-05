/**
 * Where a LOCAL runtime's turn profile comes from.
 *
 * Every routed model lane — judge, explorer, fast, advisor, reflection,
 * compaction — asks the runtime for a resolved profile before it can name a
 * model. A turn installs one; work that begins OUTSIDE a turn (the evolution
 * cadence, the review lane, `kinu evolve`, a scheduled job) has none, so the
 * runtime resolves one here instead of refusing every lane.
 *
 * This used to live inside `LocalAgentSession`, which meant a local runtime
 * opened without a session — the shape `kinu evolve` and every session-less
 * surface has — routed nothing at all: `ensureProfile()` threw
 * "this runtime has no profile resolver" after the search had already spent
 * real model calls. Resolution is a property of the WORKSPACE (its durable
 * `agent_config`, its catalog authority, its provider plane), not of the chat
 * loop on top of it, so it is built where the runtime is built and a session
 * refines its inputs rather than supplying the capability.
 */

import type {
  AgentConfigStore, ProfileAuthorityInputs, ProfileCatalog, ProfileCatalogEnvelope,
  ProviderListing, ProviderSnapshotRead, ResolvedTurnProfile, RunEventInput,
} from '@kinu.run/core';
import {
  BUILTIN_PROFILE_CATALOG, ProviderListingCache,
  buildProviderCatalogSnapshot, loadProfileAuthorityInputs,
  profileCatalogDigest, resolveAgentTurnProfile,
} from '@kinu.run/core';
import type { LocalModelResolver } from './model-resolver';
import { diagnostics } from '@kinu.run/core/obs';

/**
 * The spec a runtime with no model registry reports for its one model.
 *
 * Fixed rather than an option, because a static plane is a TEST shape: every
 * production surface resolves through the registry. The interactive client
 * REQUIRES a resolver (`LocalAgentClientDeps.modelResolver`, cli/src/local-agent
 * -client.ts) and the daemon's host always builds one (cli/src/commands/
 * daemon.ts, `openDaemonAgent`), so a caller free to name its own static spec
 * would be naming it for nobody.
 */
export const STATIC_MODEL_SPEC = 'local/static';

/**
 * Where a local agent's role/tier catalog comes from, read LIVE.
 *
 * Re-invoked at every resolution rather than captured once, so a catalog
 * written after the runtime opened — the signed-out `/model` that creates the
 * local authority mid-session, an account catalog pushed while a daemon is
 * resident — is observed by the next turn instead of the next process.
 *
 * `null` means "no explicit authority is configured", which is NOT the same as
 * "no authority": resolution falls back to the bootstrap envelope built from
 * this workspace's stored model. A caller that cannot answer must return null
 * rather than invent a catalog, because substituting one silently swaps the
 * model every producer resolves (profiles/resolve.ts:5-8).
 */
export type ProfileEnvelopeSource =
  () => ProfileCatalogEnvelope | null | Promise<ProfileCatalogEnvelope | null>;

/**
 * The model plane a profile resolves AGAINST: how a stored spec is spelled in
 * full, and what the account can actually reach.
 *
 * Deliberately two methods and no model factory. What RUNS a lane is the
 * runtime's route factory; what this answers is which model a tier may name and
 * whether that name is reachable — the pair the resolver needs and nothing more.
 */
export interface LocalProfileModelPlane {
  /** A stored (possibly bare, possibly empty) spec as a resolvable one. */
  normalizeSpec(spec: string | null): string;
  /** Every model this plane can reach, and the listings that FAILED. A
   *  non-empty failure set admits configured models unverified rather than
   *  refusing a turn over a provider nobody could look up. */
  listModels(): Promise<ProviderListing>;
  /**
   * This machine's provider-configuration revision, when the plane publishes
   * one — a counter every credential connected, revoked or signed in advances.
   *
   * It exists because the provider listing is invalidated by SIGNAL and never
   * by elapsed time, and the one signal a long-lived runtime cannot see is a
   * mutation made by ANOTHER PROCESS: `kinu provider connect` runs in its own
   * process while a daemon or a chat session stays resident.
   */
  revision?(): number;
}

/**
 * The plane a runtime with no model registry has: its one model, claimed and
 * nothing else. Never sweeps, so a fixture pays no network for a profile.
 */
export function staticModelPlane(): LocalProfileModelPlane {
  return {
    normalizeSpec(spec) {
      const trimmed = (spec ?? '').trim();
      if (!trimmed || trimmed === STATIC_MODEL_SPEC) return STATIC_MODEL_SPEC;
      throw new Error(
        'Model switching is unavailable for this local runtime; open it with a modelResolver.',
      );
    },
    listModels: () => Promise.resolve({ models: [STATIC_MODEL_SPEC], failures: [] }),
  };
}

/**
 * The plane a runtime with a provider registry has: the registry's own
 * normalization, and the full account sweep — one broken credential never
 * empties the menu, it lands in `failures` and admits configured models
 * unverified.
 */
export function resolverModelPlane(
  resolver: LocalModelResolver,
  revision?: () => number,
): LocalProfileModelPlane {
  const plane: LocalProfileModelPlane = {
    normalizeSpec: (spec) => resolver.normalizeSpecSync(spec),
    async listModels() {
      const menu = await resolver.listModels();
      return {
        models: menu.models.map((model) => `${model.provider}/${model.id}`),
        failures: menu.failures,
      };
    },
  };
  return revision ? { ...plane, revision } : plane;
}

/** What a caller may replace on an already-built authority. Everything omitted
 *  keeps the runtime's own. */
export interface ProfileAuthorityRefinement {
  plane?: LocalProfileModelPlane;
  envelope?: ProfileEnvelopeSource;
  /** Where the `profile_resolution` evidence row lands. A runtime with no
   *  durable run-event log has nowhere to put it, so it writes none. */
  record?: (event: Extract<RunEventInput, { type: 'profile_resolution' }>) => void;
}

export interface LocalProfileAuthority {
  /** A stored spec spelled in full by the CURRENT plane. */
  normalizeSpec(spec: string | null): string;
  /** The catalog in force: the configured authority, or this workspace's own
   *  bootstrap when nothing configured one. */
  envelope(): Promise<ProfileCatalogEnvelope>;
  /** Both authority inputs, with the resolution evidence recorded. */
  inputs(): Promise<ProfileAuthorityInputs>;
  /**
   * A profile for work that starts outside a chat turn. Same authority, same
   * provider snapshot, same role and tier as a turn — only the tool surface is
   * empty, because these lanes resolve TIERS and never call a tool, and the
   * work mode is the unnarrowed default, because a lane that runs between turns
   * runs under no turn's mode. A role that declares `plan` still narrows it.
   */
  resolvePreTurn(): Promise<ResolvedTurnProfile>;
  /** Drop the cached provider listing: something this authority cannot observe
   *  changed (a credential added or revoked, a provider connected, a sign-in). */
  refreshListing(): void;
  /** Adopt richer inputs. Replacing the plane drops the listing cached under
   *  the old one, which described a different world. */
  refine(inputs: ProfileAuthorityRefinement): void;
}

export function createLocalProfileAuthority(deps: {
  /** The durable per-workspace config — the same table a session reads, so a
   *  session-less lane and a turn cannot resolve different models. */
  config: AgentConfigStore;
  /** The plane a runtime is born with; a session refines it. */
  plane: LocalProfileModelPlane;
  envelope?: ProfileEnvelopeSource;
}): LocalProfileAuthority {
  let plane = deps.plane;
  let envelopeSource = deps.envelope ?? null;
  let record: ProfileAuthorityRefinement['record'] | null = null;
  let observedRevision: number | null = null;

  // The one expensive half of a resolution: it sweeps every configured
  // provider, network included, and sits on the turn's critical path ahead of
  // the first token. The four rules that make caching it safe are core's; the
  // sweep reads the CURRENT plane so a refinement is observed without a second
  // cache existing anywhere.
  const listings = new ProviderListingCache(() => plane.listModels());

  const normalizeSpec = (spec: string | null): string => plane.normalizeSpec(spec);

  /** This workspace's own catalog, built from its stored model: the roles core
   *  ships, and one default tier every other tier aliases. */
  const bootstrapEnvelope = (): ProfileCatalogEnvelope => {
    const catalog: ProfileCatalog = {
      roles: BUILTIN_PROFILE_CATALOG.roles,
      tiers: { default: { model: normalizeSpec(deps.config.getModel()) } },
    };
    return {
      authority: { kind: 'local' },
      version: 0,
      digest: profileCatalogDigest(catalog),
      catalog,
    };
  };

  const envelope = async (): Promise<ProfileCatalogEnvelope> =>
    (await envelopeSource?.()) ?? bootstrapEnvelope();

  /**
   * Compared BEFORE the resolution rather than after, because the envelope and
   * the listing load together and an invalidation that landed after the
   * snapshot was taken would apply to the turn after this one. That off-by-one
   * turn is the whole bug: a tier that moved to a model a newly connected
   * provider exposes fails resolution until the process restarts.
   *
   * Compared, never expired. An unchanged revision means nothing changed, so
   * there is nothing a clock could usefully do here — and a model an account
   * stopped offering must keep failing rather than come back by waiting.
   */
  const observeRevision = (): void => {
    if (!plane.revision) return;
    const revision = plane.revision();
    const previous = observedRevision;
    observedRevision = revision;
    if (previous === null || previous === revision) return;
    diagnostics.event('provider.listing_invalidated', { from: previous, to: revision });
    listings.invalidate();
  };

  /**
   * What the plane could list, and what it could not — plus what this read
   * cost, which is the evidence core writes the `profile_resolution` row from.
   *
   * The CONFIGURED spec is folded in HERE rather than inside the cache, and
   * that is the reason the cache holds listings instead of snapshots: a stored
   * model change alters the snapshot's identity with no invalidation to miss.
   */
  const providerSnapshot = async (): Promise<ProviderSnapshotRead> => {
    const { listing, cache } = await listings.read();
    const configured = normalizeSpec(deps.config.getModel());
    return {
      snapshot: buildProviderCatalogSnapshot([configured, ...listing.models], listing.failures),
      cache,
    };
  };

  const inputs = async (): Promise<ProfileAuthorityInputs> => {
    // Before the loads below, so a provider mutation made in another process
    // reaches THIS resolution rather than the next one.
    observeRevision();
    const load: Parameters<typeof loadProfileAuthorityInputs>[0] = {
      envelope,
      provider: providerSnapshot,
    };
    if (record) load.record = record;
    return loadProfileAuthorityInputs(load);
  };

  return {
    normalizeSpec,
    envelope,
    inputs,
    async resolvePreTurn() {
      const role = deps.config.getRoleSelection();
      return resolveAgentTurnProfile({
        ...(await inputs()),
        activeRoleId: role,
        workMode: 'build',
        availableTools: [],
        activeSkills: [],
        explicitTier: deps.config.getAssignedTier() ?? undefined,
      });
    },
    refreshListing() {
      listings.invalidate();
    },
    refine(refinement) {
      if (refinement.plane && refinement.plane !== plane) {
        plane = refinement.plane;
        observedRevision = null;
        listings.invalidate();
      }
      if (refinement.envelope) envelopeSource = refinement.envelope;
      if (refinement.record) record = refinement.record;
    },
  };
}
