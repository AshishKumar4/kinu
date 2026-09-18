/**
 * One flow, four doors (docs/SELF-DEPLOY.md). What a release IS lives here; the
 * guided page, the deploy Durable Object, the CLI and the local installer are
 * adapters over it.
 */
export {
  RELEASE_ARTIFACT_ROUTE, ReleaseManifestSchema,
  type BindingKind, type ReleaseBinding, type ReleaseFile, type ReleaseManifest,
  type ReleaseMigration, type ReleaseSecret, type ReleaseSeed, type ReleaseVar,
  type ReleaseVectorIndex, type ReleaseWorker, type SecretHandling, type VarPolicy,
} from './manifest';
