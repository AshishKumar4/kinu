/**
 * One flow, four doors (docs/SELF-DEPLOY.md). The plan of idempotent steps,
 * their inputs, their progress and their ledger live here; the guided page,
 * the deploy Durable Object, the CLI and the local installer are adapters.
 */
export {
  RELEASE_ARTIFACT_ROUTE, RELEASE_MANIFEST_PATH, ReleaseManifestSchema, parseReleaseManifest,
  workerArtifactPath,
  type BindingKind, type ReleaseBinding, type ReleaseFile, type ReleaseManifest,
  type ReleaseMigration, type ReleaseSecret, type ReleaseSeed, type ReleaseVar,
  type ReleaseVectorIndex, type ReleaseWorker, type SecretHandling, type VarPolicy,
} from './manifest';

export { TarArtifact, sha256Hex } from './artifact';

export {
  CLI_DEPLOY_REDIRECT_PORT, CLI_DEPLOY_REDIRECT_URI, CLOUDFLARE_DEPLOY_SCOPES,
  authorizeUrl, createPkcePair, exchangeDeployCode,
  type AuthorizeRequest, type DeployToken, type PkcePair, type TokenExchange,
} from './pkce';

export {
  DEPLOY_RUN_ID, mintDeployRun, runKeyAdmits, runKeyDigest, type DeployRunTicket,
} from './session';

export {
  CloudflareApiError, bearerTransport, cloudflareResult, readEnvelope,
  type CloudflareCall, type CloudflareErrorDetail, type CloudflareHttpResponse,
  type CloudflareTransport, type MultipartUpload, type UploadPart,
} from './cloudflare';

export {
  ACCESS_TOKEN_KEY, DEFAULT_INSTANCE_NAME, DEPLOYMENT_RECORD_SECRET, DEPLOYMENT_REFRESH_SECRET,
  DeployInputsSchema, MINTED_SECRETS, REFRESH_TOKEN_KEY, promptedSecrets,
  type DeployAddress, type DeployAddressKind, type DeployInputs, type DeploymentRecord,
} from './inputs';

export {
  FACT_ACCESS_APP, FACT_ACCOUNT_NAME, FACT_ADDRESS, FACT_GATEWAY_URL, FACT_OWNER_EMAIL,
  FACT_VERSION_ID,
  FACT_WORKERS_SUBDOMAIN, kvFact,
  type ArtifactSource, type DeployContext, type DeployFacts, type DeploySecretVault, type HttpGet,
} from './context';

export { deployPlan, type DeployStep } from './steps';

export {
  deployDoor, deployOptions, mintRun,
  type DeployChoice, type DeployDoor, type DeployRunAddress, type DeployTokenPair,
} from './door';

export {
  factsFrom, runDeployPlan,
  type DeployLedger, type DeployProgress, type DeployProgressSink, type DeployRunOutcome,
  type DeployRunState, type DeployStepFailure, type DeployStepRow, type DeployStepSeed,
  type DeployStepState,
} from './runner';

export {
  DeployFrameSchema, DeployOptionsSchema, DeployRunPhaseSchema, DeploySnapshotSchema,
  DeployStepRowSchema, DeployTicketSchema,
  type DeployFrame, type DeployOptions, type DeployRunPhase, type DeploySnapshot,
} from './frames';
