// Generated from wrangler.jsonc bindings.
import type { OrchestratorAgent } from "./src/orchestrator";
import type { KinuSandbox } from "./src/kinu-sandbox";
import type { UserDO } from "./src/user/user-do";
import type { MonitorDO } from "./src/monitor/monitor-do";
import type { ControlPlaneDO } from "./src/control-plane/control-plane-do";
import type { DeployRunDO } from "./src/deploy/deploy-do";
import type { CodemodeEgress } from "./src/codemode-egress";
import type { SlateBinding } from "./src/slates/bindings";
import type { MossaicShardDO, MossaicUserDO } from "./src/server";
import type { VectorizeIndex as KinuVectorizeIndex } from "@kinu.run/core";

// Top-level imports make this a module, so `Env` is declared global explicitly.
declare global {
  interface Env {
    /** Workers AI (in-account, no token). Absent ⇒ `ai-gateway` and the memory embedder report unavailable. */
    AI?: Ai;
    /** Worker version recorded on builtin-loop turn claims; absent (old deploys, `wrangler dev`) ⇒ unknown. */
    CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
    /** Optional semantic-memory index. Without it, memory remains FTS-only. */
    MEMORY_VECTORS?: KinuVectorizeIndex;
    /** R2 store for hosted Nimbus runtimes (runtime-catalog.ts:117 calls `.get()`); absent ⇒ hosted
     *  `python3`/`ruby`/`clang` exit 127. */
    NIMBUS_RUNTIME_CACHE?: R2Bucket;
    LOADER: WorkerLoader;
    OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
    /** Per-user DO: profile + agent registry + credentials + defaults. */
    UserDO: DurableObjectNamespace<UserDO>;
    /** Singleton DO: synthetic monitoring incidents and alert outbox. */
    MonitorDO: DurableObjectNamespace<MonitorDO>;
    /** Singleton admin control-plane index and audit log; reachable only via a capability derived from
     *  CREDENTIAL_ENCRYPTION_KEY (control-plane/admin-caller.ts). */
    ControlPlaneDO: DurableObjectNamespace<ControlPlaneDO>;
    /** @cloudflare/sandbox container DO; the name is fixed because `proxyToSandbox` reads `env.Sandbox`. */
    Sandbox: DurableObjectNamespace<KinuSandbox>;
    /** One guided self-deployment per run (docs/SELF-DEPLOY.md § The Cloudflare door). */
    DeployRunDO: DurableObjectNamespace<DeployRunDO>;
    /** Mossaic Drive tenant objects (SDK-fixed names); optional, the `/shared` mount then states its absence. */
    MOSSAIC_USER?: DurableObjectNamespace<MossaicUserDO>;
    MOSSAIC_SHARD?: DurableObjectNamespace<MossaicShardDO>;
    /** Mossaic signs listing cursors with this inside its DO, so it is a Wrangler secret on this Worker;
     *  without it every Drive listing answers 500 (measured 2026-09-21, `tests/first-run/drive`). */
    JWT_SECRET?: string;
    /** Sessions, OAuth state, CLI approval state; all self-expiring, never a source of truth. */
    AUTH_KV: KVNamespace;
    /** R2 sandbox `/workspace` snapshots; bytes stream through the DO so no credential enters the container. */
    BACKUP_BUCKET?: R2Bucket;
    /** Feedback screenshots; absent ⇒ note-only feedback lands and screenshots are refused. */
    FEEDBACK_BUCKET?: R2Bucket;
    /** Worker release artifacts; absent ⇒ downloads answer 404 and self-deploy stops at the artifact. */
    RELEASES_BUCKET?: R2Bucket;
    /** Analytics Engine datasets, optional; user-authored names are digested before indexing. */
    readonly AGENT_METRICS?: AnalyticsEngineDataset;
    readonly FEEDBACK_MARKERS?: AnalyticsEngineDataset;
    readonly CONTROL_PLANE_OPS?: AnalyticsEngineDataset;
    /** Analytics SQL API account (var) and token (secret); either absent ⇒ metrics view unconfigured. */
    CLOUDFLARE_ACCOUNT_ID?: string;
    ANALYTICS_SQL_API_TOKEN?: string;
    AI_GATEWAY_URL: string;
    /** Zone for per-port preview hostnames; empty disables previews. */
    PREVIEW_HOST_SUFFIX: string;
    /** The zone's port when it is not 443; only `vite dev` sets it (vite-preview-zone.ts). */
    PREVIEW_HOST_PORT?: string;
    /** Static assets; needed for SPA fallback under `run_worker_first`. */
    ASSETS: Fetcher;
    /** Google OAuth client settings. Client secret must be a Wrangler secret. */
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
    GOOGLE_OAUTH_SCOPES?: string;
    /** GitHub OAuth client settings. Client secret must be a Wrangler secret. */
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITHUB_OAUTH_CLIENT_SECRET?: string;
    GITHUB_OAUTH_SCOPES?: string;
    /** OAuth apps for `oauth-app` MCP presets (secrets); absent ⇒ token fallback or not offered. */
    MCP_GITHUB_CLIENT_ID?: string;
    MCP_GITHUB_CLIENT_SECRET?: string;
    MCP_GOOGLE_CLIENT_ID?: string;
    MCP_GOOGLE_CLIENT_SECRET?: string;
    /** Root user-plane secret: seals credentials and derives the owner capability; without it no
     *  signed-in user can be served. Generate with `openssl rand -base64 32`. */
    CREDENTIAL_ENCRYPTION_KEY?: string;
    /** Retired keys for reading only during rotation (user/credential-envelope.ts). */
    CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
    /** Signs webhook delivery URLs (secret); without it creation answers 503 and URLs 404. Rotation
     *  revokes every URL (events/webhook-route.ts). */
    WEBHOOK_ROUTE_SECRET?: string;
    /** Cloudflare account OAuth client settings. Client secret must be a Wrangler secret. */
    CLOUDFLARE_OAUTH_CLIENT_ID?: string;
    CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
    CLOUDFLARE_OAUTH_SCOPES?: string;
    CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
    /** AI Gateway id used with the user's Cloudflare OAuth token for Workers AI. */
    CLOUDFLARE_AI_GATEWAY_ID?: string;
    /** Public PKCE client for the self-deploy door (a var: no secret); absent ⇒ /deploy is not configured. */
    CLOUDFLARE_DEPLOY_CLIENT_ID?: string;
    /** This deployment's self-deploy record (JSON); absent ⇒ `/updates` offers nothing. */
    KINU_DEPLOYMENT_RECORD?: string;
    /** This deployment's own Cloudflare refresh token, so updates are pulls; absent ⇒ install nothing. */
    KINU_SELF_DEPLOY_REFRESH_TOKEN?: string;
    /** The one identity usable without OAuth; off localhost it also needs `DEV_IDENTITY_SECRET`. */
    DEV_USER_EMAIL?: string;
    /** Presented in core's `DEV_IDENTITY_HEADER` to act as `DEV_USER_EMAIL` off localhost. */
    DEV_IDENTITY_SECRET?: string;
    /** Email Sending (`send_email`); optional, outbound email skips without it. */
    EMAIL?: SendEmail;
    /** Agent mail domain; needs Email Sending and a catch-all route (docs/EMAIL-INGRESS.md). */
    EMAIL_DOMAIN?: string;
    /** Origin for unauthenticated CLI install/auth endpoints and synthetic monitoring. */
    CLI_PUBLIC_ORIGIN?: string;
    OPS_ALERT_EMAIL?: string;
    /** CLI approval origin; in production the app origin, so the browser session is used. */
    CLI_APPROVAL_ORIGIN?: string;
    /** Admin email allowlist (a var, auditable); unset ⇒ control plane unreachable; `dev` identities are
     *  refused. Inner half of the gate with `CONTROL_PLANE_ACCESS_*`. */
    CONTROL_PLANE_ADMINS?: string;
    /** Cloudflare Access org for `/control*`: JWKS origin and pinned `iss`, else any org is a valid signer.
     *  Unset ⇒ 404 to everyone; `scripts/infra-verify.ts` requires it (control-plane/access-gate.ts). */
    CONTROL_PLANE_ACCESS_TEAM_DOMAIN?: string;
    /** Access application AUD, pinned as `aud`: same-org tokens for other apps share signing keys. Unset ⇒ 404. */
    CONTROL_PLANE_ACCESS_AUD?: string;
  }

  namespace Cloudflare {
    /** `enable_ctx_exports` loopback types; only read entrypoints, to avoid a recursive DO type. */
    interface GlobalProps {
      mainModule: {
        CodemodeEgress: typeof CodemodeEgress;
        SlateBinding: typeof SlateBinding;
      };
    }
  }
}

export {};
