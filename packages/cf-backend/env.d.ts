// Generated from wrangler.jsonc bindings.
//
// Note on the AI binding: env.AI serves platform-side work billed to the
// Worker's own account — embeddings, HTML→markdown, and the `ai-gateway`
// provider's chat transport, which is pre-authenticated in-account and so needs
// no API token. It is declared OPTIONAL because a deployment can omit the
// binding; the providers that need it report themselves unavailable rather than
// guessing (providers/ai-gateway.ts `resolvePlatformGateway`).
import type { OrchestratorAgent } from "./src/orchestrator";
import type { KinuSandbox } from "./src/kinu-sandbox";
import type { UserDO } from "./src/user/user-do";
import type { MonitorDO } from "./src/monitor/monitor-do";
import type { ControlPlaneDO } from "./src/control-plane/control-plane-do";
import type { NimbusSession } from "@nimbus-sh/sdk/worker";
import type { VectorizeIndex as KinuVectorizeIndex } from "@kinu.run/core";

// This file has top-level imports (for the DO class generics below), which
// makes it a module — so `interface Env` here would be module-scoped, not
// global. The Workers runtime + every DO/Worker references `Env` as a GLOBAL
// type, so we declare it in the global scope explicitly.
declare global {
  interface Env {
    /** Workers AI binding. Absent ⇒ the `ai-gateway` provider and semantic
     *  memory's embedder report unavailable; nothing silently degrades. */
    AI?: Ai;
    /** Optional semantic-memory index. Without it, memory remains FTS-only. */
    MEMORY_VECTORS?: KinuVectorizeIndex;
    /** The Nimbus runtime artifact store a HOSTED workspace installs its
     *  toolchain from — `catalog/v1.json`, per-version manifests and
     *  content-addressed blobs. An R2 BUCKET, not a marker string: the Nimbus
     *  session DO calls `.get()` on it
     *  (external/nimbus/packages/worker/src/runtime/runtime-catalog.ts:117).
     *  Absent ⇒ a hosted `python3`/`ruby`/`clang` exits 127 and the shell says
     *  the binding is missing; the local CLI is unaffected because it ships its
     *  runtimes as npm packages. */
    NIMBUS_RUNTIME_CACHE?: R2Bucket;
    LOADER: WorkerLoader;
    OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
    /** Per-user DO: profile + agent registry + credentials + defaults. */
    UserDO: DurableObjectNamespace<UserDO>;
    /** Singleton DO holding synthetic monitoring's open incidents + alert outbox. */
    MonitorDO: DurableObjectNamespace<MonitorDO>;
    /** Singleton DO holding the admin control plane's cross-user index (users,
     *  workspaces, feedback) and the append-only admin audit log. Reachable only
     *  from Worker code holding a capability token derived from
     *  CREDENTIAL_ENCRYPTION_KEY — see control-plane/admin-caller.ts. */
    ControlPlaneDO: DurableObjectNamespace<ControlPlaneDO>;
    /** Nimbus SDK session DO — built-in lightweight dev environment. */
    NIMBUS_SESSION: DurableObjectNamespace<NimbusSession>;
    /** Sandbox container DO — @cloudflare/sandbox. One per agent.
     *  Binding name is fixed to "Sandbox" because the SDK's proxyToSandbox
     *  looks up `env.Sandbox` directly. */
    Sandbox: DurableObjectNamespace<KinuSandbox>;
    /** Browser sessions, one-time OAuth state, and CLI browser-approval state.
     *  Everything in it expires on its own; nothing in it is a source of truth. */
    AUTH_KV: KVNamespace;
    /** R2 bucket holding sandbox /workspace snapshots. Read directly by
     *  KinuSandbox to verify a snapshot before restoring from it. */
    BACKUP_BUCKET?: R2Bucket;
    /** Presigned-URL credentials for the container↔R2 transfer. Present ⇒ the
     *  SDK moves snapshot bytes over presigned URLs and restores by MOUNTING the
     *  archive; absent ⇒ bytes move through the BACKUP_BUCKET binding and the
     *  restore extracts. Neither path puts a credential in the container: the
     *  presigned URL is minted in the Durable Object. All four are required
     *  together — see the BACKUP_BUCKET note in wrangler.jsonc. */
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    BACKUP_BUCKET_NAME?: string;
    /** In-product feedback screenshots. The metadata row in ControlPlaneDO
     *  carries the object key; the bytes never enter a DO row or an analytics
     *  blob. Absent ⇒ note-only feedback still lands and a screenshot
     *  submission is refused with a reason. */
    FEEDBACK_BUCKET?: R2Bucket;
    /** Analytics Engine datasets — the fleet-level aggregate plane. All three
     *  OPTIONAL so a deployment without the bindings degrades to
     *  console-only diagnostics instead of throwing. Nothing user-authored is
     *  written to them: the workspace name and the admin email are digested
     *  before they become an index value. */
    readonly AGENT_METRICS?: AnalyticsEngineDataset;
    readonly FEEDBACK_MARKERS?: AnalyticsEngineDataset;
    readonly CONTROL_PLANE_OPS?: AnalyticsEngineDataset;
    /** Account the Analytics Engine SQL API is queried against, and the
     *  Account-Analytics-Read token that authorizes the query. A var and a
     *  Wrangler secret respectively. Either absent ⇒ the control plane's
     *  metrics view reports itself unconfigured; nothing else degrades. */
    CLOUDFLARE_ACCOUNT_ID?: string;
    ANALYTICS_SQL_API_TOKEN?: string;
    CLOUDFLARE_R2_ACCOUNT_ID?: string;
    AI_GATEWAY_URL: string;
    /** Zone isolated previews are served under, one capability hostname per
     *  exposed Workspace or Sandbox port. Empty disables previews. */
    PREVIEW_HOST_SUFFIX: string;
    /** Static asset binding — required for SPA fallback when the Worker
     *  runs first on every route (see `run_worker_first` in wrangler). */
    ASSETS: Fetcher;
    /** Google OAuth client settings. Client secret must be a Wrangler secret. */
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
    GOOGLE_OAUTH_SCOPES?: string;
    /** GitHub OAuth client settings. Client secret must be a Wrangler secret. */
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITHUB_OAUTH_CLIENT_SECRET?: string;
    GITHUB_OAUTH_SCOPES?: string;
    /** The Worker's root secret for the user plane. A Wrangler secret, never a
     *  var. It seals the credential store (`user_credentials.value`) and, under
     *  a separate label, derives the owner capability every privileged UserDO
     *  call presents — so WITHOUT IT THE WORKER CANNOT SERVE A SIGNED-IN USER
     *  AT ALL: no sign-in, no CLI, no credentials. Public routes still answer.
     *  Generate with `openssl rand -base64 32`. */
    CREDENTIAL_ENCRYPTION_KEY?: string;
    /** Retired credential encryption keys, comma-separated, used for reading
     *  only. Populate during a rotation and drop once every UserDO has been
     *  touched — see user/credential-envelope.ts. */
    CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
    /** Cloudflare account OAuth client settings. Client secret must be a Wrangler secret. */
    CLOUDFLARE_OAUTH_CLIENT_ID?: string;
    CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
    CLOUDFLARE_OAUTH_SCOPES?: string;
    CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
    /** AI Gateway id used with the user's Cloudflare OAuth token for Workers AI. */
    CLOUDFLARE_AI_GATEWAY_ID?: string;
    /** Local dev backdoor — synthesize an authenticated identity for this
     *  email without an OAuth browser session. Production must leave this unset. */
    DEV_USER_EMAIL?: string;
    /** Cloudflare Email Sending binding (`send_email` in wrangler.jsonc).
     *  OPTIONAL — without it, outbound email (thread replies, owner
     *  notifications) skips quietly. */
    EMAIL?: SendEmail;
    /** The mail domain agents live on (`<agent-name>@EMAIL_DOMAIN`). Must be
     *  onboarded to Email Sending + have an Email Routing catch-all rule
     *  pointing at this Worker — see docs/EMAIL-INGRESS.md. OPTIONAL: unset
     *  disables the Mission Inbox. */
    EMAIL_DOMAIN?: string;
    /** Public origin for unauthenticated CLI install/auth endpoints. Also the
     *  origin synthetic monitoring probes. */
    CLI_PUBLIC_ORIGIN?: string;
    /** Where synthetic-monitoring alerts go. Unset (as in staging) leaves the
     *  monitor observing and recording, but silent. */
    OPS_ALERT_EMAIL?: string;
    /** Browser approval origin for CLI auth. In production this should be the
     *  public app origin so approval uses the user's browser session. */
    CLI_APPROVAL_ORIGIN?: string;
    /** Verified session emails allowed to reach the admin control plane,
     *  comma-separated. A var, not a secret: an allowlist nobody can read is an
     *  allowlist nobody can audit, and these are addresses rather than
     *  credentials. Unset or empty ⇒ the control plane is unreachable, which is
     *  the correct default for a deployment that has not named its operators.
     *  A `provider: 'dev'` identity is refused whatever this contains. */
    CONTROL_PLANE_ADMINS?: string;
  }
}

export {};
