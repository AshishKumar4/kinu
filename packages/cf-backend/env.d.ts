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
    /** Sandbox container DO — @cloudflare/sandbox. One per agent.
     *  Binding name is fixed to "Sandbox" because the SDK's proxyToSandbox
     *  looks up `env.Sandbox` directly. */
    Sandbox: DurableObjectNamespace<ProteusSandbox>;
    /** R2 bucket for sandbox /workspace backups (SDK localBucket mode). */
    BACKUP_BUCKET?: R2Bucket;
    AI_GATEWAY_URL: string;
    AI_GATEWAY_AUTH: string;
    /** Hostname used by @cloudflare/sandbox to build preview URLs.
     *  Must match a host for which Cloudflare wildcard DNS resolves.
     *  The account's workers.dev subdomain is the simplest choice because
     *  *.<worker>.<sub>.workers.dev resolves automatically. */
    PREVIEW_HOSTNAME: string;
    /** Static asset binding — required for SPA fallback when the Worker
     *  runs first on every route (see `run_worker_first` in wrangler). */
    ASSETS: Fetcher;
    /** Optional shared-secret for the MCP server endpoint. When set,
     *  `/mcp/v1/*` requests must include `Authorization: Bearer <token>`.
     *  When unset, the MCP endpoint is open (dev / personal-account mode).
     *  Set in prod: `echo "<long-random>" | npx wrangler secret put MCP_AUTH_TOKEN` */
    MCP_AUTH_TOKEN?: string;
    /** Cloudflare Access — team domain, e.g. `myteam.cloudflareaccess.com`.
     *  Required in production; without it, all auth-protected routes 500. */
    CF_ACCESS_TEAM_DOMAIN?: string;
    /** CF Access application AUD claim (set in Zero Trust dashboard when you
     *  create the Access application). The Worker verifies the JWT's `aud`
     *  against this exact value. */
    CF_ACCESS_AUD?: string;
    /** Local dev backdoor — synthesize an authenticated identity for this
     *  email without verifying CF Access. Production must leave this unset. */
    DEV_USER_EMAIL?: string;
    /** Nimbus default-sandbox endpoint, e.g. https://nimbus.<acct>.workers.dev.
     *  When set, the `nimbus` runtime is registered for every agent at runtime
     *  construction. Unset → only `workspace` (+ `sandbox` stub) is available
     *  by default. See packages/core/src/execution/nimbus.ts. */
    NIMBUS_ENDPOINT?: string;
    /** HS256 JWT for Nimbus's `?nimbus_token=` query param. Required only when
     *  the Nimbus deployment runs in 'enforce' mode. Store as wrangler secret. */
    NIMBUS_TOKEN?: string;
  }
}

export {};
