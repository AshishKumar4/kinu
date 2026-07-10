// Generated from wrangler.jsonc bindings.
//
// Note on AI binding: we prefer the Workers AI direct binding (env.AI) when
// available, and fall back to the AI Gateway (OpenAI-compatible HTTP) when
// not. The binding is OPTIONAL — to enable it, add this block to wrangler.jsonc:
//
//   "ai": { "binding": "AI" }
//
// and Wrangler will inject the Ai runtime object. Without the binding, code
// paths guard with `if (env.AI && typeof env.AI !== "string") { ... }` and
// transparently fall through to the gateway (AI_GATEWAY_URL + AI_GATEWAY_AUTH).
import type { OrchestratorAgent } from "./src/orchestrator.js";
import type { ExplorationAgent } from "./src/exploration.js";
import type { ProteusSandbox } from "./src/proteus-sandbox.js";
import type { UserDO } from "./src/user/user-do.js";
import type { NimbusSession } from "@nimbus-sh/sdk/worker";

// This file has top-level imports (for the DO class generics below), which
// makes it a module — so `interface Env` here would be module-scoped, not
// global. The Workers runtime + every DO/Worker references `Env` as a GLOBAL
// type, so we declare it in the global scope explicitly.
declare global {
  interface Env {
    /** Workers AI direct binding. OPTIONAL — fallback is the AI Gateway. */
    AI?: Ai;
    LOADER: WorkerLoader;
    OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
    ExplorationAgent: DurableObjectNamespace<ExplorationAgent>;
    /** Per-user DO: profile + agent registry + credentials + defaults. */
    UserDO: DurableObjectNamespace<UserDO>;
    /** Nimbus SDK session DO — built-in lightweight dev environment. */
    NIMBUS_SESSION: DurableObjectNamespace<NimbusSession>;
    /** Sandbox container DO — @cloudflare/sandbox. One per agent.
     *  Binding name is fixed to "Sandbox" because the SDK's proxyToSandbox
     *  looks up `env.Sandbox` directly. */
    Sandbox: DurableObjectNamespace<ProteusSandbox>;
    /** D1 browser OAuth/session store. Reads use D1 Sessions for replicas. */
    AUTH_DB: D1Database;
    /** R2 bucket for sandbox /workspace backups (SDK localBucket mode). */
    BACKUP_BUCKET?: R2Bucket;
    AI_GATEWAY_URL: string;
    AI_GATEWAY_AUTH: string;
    /** Hostname used by Proteus to build authenticated path-style preview URLs.
     *  No per-agent subdomain or wildcard TLS/DNS is required. */
    PREVIEW_HOSTNAME: string;
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
    /** Public origin for unauthenticated CLI install/auth endpoints. */
    CLI_PUBLIC_ORIGIN?: string;
    /** Browser approval origin for CLI auth. In production this should be the
     *  public app origin so approval uses the user's browser session. */
    CLI_APPROVAL_ORIGIN?: string;
  }
}

export {};
