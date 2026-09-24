/**
 * Turn profiles for work that starts outside a turn (evolution, review, scheduled
 * jobs). Built with the runtime, not the session: a session-less runtime must still route.
 */

import type {
  AgentConfigStore, ProfileAuthorityInputs, ProfileCatalog, ProfileCatalogEnvelope,
  ProviderListing, ProviderSnapshotRead, ResolvedTurnProfile, RunEventInput,
} from '@kinu.run/core';
import {
  BUILTIN_PROFILE_CATALOG, ProviderListingCache,
  buildProviderCatalogSnapshot, loadProfileAuthorityInputs, providerListingOf,
  profileCatalogDigest, resolveAgentTurnProfile,
} from '@kinu.run/core';
import type { LocalModelResolver } from './model-resolver';
import { diagnostics } from '@kinu.run/core/obs';

/** The spec a runtime with no model registry reports; static planes are test-only. */
export const STATIC_MODEL_SPEC = 'local/static';

/**
 * The role/tier catalog, read live at every resolution. `null` means none configured:
 * fall back to the bootstrap envelope rather than invent a catalog.
 */
export type ProfileEnvelopeSource =
  () => ProfileCatalogEnvelope | null | Promise<ProfileCatalogEnvelope | null>;

/** The model plane a profile resolves against: spec normalization and reachability. */
export interface LocalProfileModelPlane {
  normalizeSpec(spec: string | null): string;
  /** A non-empty failure set admits configured models unverified rather than
   *  refusing a turn. */
  listModels(): Promise<ProviderListing>;
  /**
   * Provider-configuration revision. The listing invalidates on signal, never time,
   * and `kinu provider connect` mutates from another process.
   */
  revision?(): number;
}

/** One claimed model; never sweeps, so a fixture pays no network. */
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

/** Registry normalization plus a full account sweep; a broken credential lands in `failures`. */
export function resolverModelPlane(
  resolver: LocalModelResolver,
  revision?: () => number,
): LocalProfileModelPlane {
  const plane: LocalProfileModelPlane = {
    normalizeSpec: (spec) => resolver.normalizeSpecSync(spec),
    listModels: async () => providerListingOf(await resolver.listModels()),
  };

  return revision ? { ...plane, revision } : plane;
}

export interface ProfileAuthorityRefinement {
  plane?: LocalProfileModelPlane;
  envelope?: ProfileEnvelopeSource;
  /** Where the `profile_resolution` row lands; absent writes none. */
  record?: (event: Extract<RunEventInput, { type: 'profile_resolution' }>) => void;
}

export interface LocalProfileAuthority {
  normalizeSpec(spec: string | null): string;
  envelope(): Promise<ProfileCatalogEnvelope>;
  inputs(): Promise<ProfileAuthorityInputs>;
  /**
   * Profile for work outside a chat turn: empty tool surface and the default work
   * mode, since these lanes resolve tiers only.
   */
  resolvePreTurn(availableTools?: readonly string[]): Promise<ResolvedTurnProfile>;
  refreshListing(): void;
  /** Replacing the plane drops the listing cached under the old one. */
  refine(inputs: ProfileAuthorityRefinement): void;
}

export function createLocalProfileAuthority(deps: {
  /** The table a session reads, so a lane and a turn cannot resolve different models. */
  config: AgentConfigStore;
  plane: LocalProfileModelPlane;
  envelope?: ProfileEnvelopeSource;
}): LocalProfileAuthority {
  let plane = deps.plane;
  let envelopeSource = deps.envelope ?? null;
  let record: ProfileAuthorityRefinement['record'] | null = null;
  let observedRevision: number | null = null;

  // The sweep reads the current plane, so a refinement needs no second cache.
  const listings = new ProviderListingCache(() => plane.listModels());

  const normalizeSpec = (spec: string | null): string => plane.normalizeSpec(spec);

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
   * Compared before resolution, else an invalidation lands a turn late. Never
   * expired: an unchanged revision means nothing changed.
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
   * The configured spec is folded in here, not in the cache, so a stored model
   * change alters the snapshot's identity with no invalidation to miss.
   */
  const providerSnapshot = async (): Promise<ProviderSnapshotRead> => {
    const { listing, cache } = await listings.read();
    const configured = normalizeSpec(deps.config.getModel());

    return {
      snapshot: buildProviderCatalogSnapshot([configured, ...listing.models], listing.failures, listing.reasoningEfforts),
      cache,
    };
  };

  const inputs = async (): Promise<ProfileAuthorityInputs> => {
    // Before the loads, so another process's provider mutation reaches this resolution.
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
    async resolvePreTurn(availableTools = []) {
      const role = deps.config.getRoleSelection();

      return resolveAgentTurnProfile({
        ...(await inputs()),
        activeRoleId: role,
        workMode: 'build',
        availableTools,
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
