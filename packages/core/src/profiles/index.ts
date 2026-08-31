export {
  TIER_IDS, ROLE_ID_RE, DEFAULT_ROLE_ID,
  isValidRoleId, validateProfileCatalog, validateProfileCatalogEnvelope,
  profileCatalogDigest, deriveRoleLabel, effectiveRoleCatalog,
  BUILTIN_ROLE_DEFINITIONS, BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema,
} from './catalog';
export type {
  TierId, BuiltinRoleId, RoleId,
  TierAssignment, TierAssignments, RoleDefinition, RoleCatalog, ProfileCatalog,
  ProfileAuthority, ProfileCatalogEnvelope,
} from './catalog';
export {
  loadProfileAuthorityInputs, resolveTurnProfile, resolveAgentTurnProfile, resolveRoutingProfile,
} from './resolve';
export type {
  ProfileAuthorityInputs, ProviderCatalogSnapshot, TierSource,
  ProviderCacheOutcome, ProviderSnapshotRead,
  ResolveTurnProfileInput, ResolveAgentTurnProfileInput, ResolvedTurnProfile,
} from './resolve';
export {
  resolveModelRoute,
  type ModelRoutePolicy, type ProfileRoutedSource, type ModelRouteResolution,
  type FixedTierSource,
} from './model-route';
export {
  buildProviderCatalogSnapshot, ProviderListingCache,
  type ProviderListing,
} from './provider-catalog';
export {
  changeActiveRole, roleChangeOutcomeText,
  type RoleChangeActor, type RoleChangePolicy, type RoleChangeOutcome,
  type RoleChangeRefusal, type RoleStateStore,
} from './role-change';
export {
  validateSwarmProfileSnapshot,
} from './snapshot';
export type {
  ProfileProvenance, SwarmProfileSnapshot,
} from './snapshot';
