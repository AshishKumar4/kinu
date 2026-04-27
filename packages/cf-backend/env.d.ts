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

interface Env {
  /** Workers AI direct binding. OPTIONAL — fallback is the AI Gateway. */
  AI?: Ai;
  LOADER: WorkerLoader;
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  ExplorationAgent: DurableObjectNamespace<ExplorationAgent>;
  /** Sandbox container DO — @cloudflare/sandbox. One per agent.
   *  Binding name is fixed to "Sandbox" because the SDK's proxyToSandbox
   *  looks up `env.Sandbox` directly. */
  Sandbox: DurableObjectNamespace<ProteusSandbox>;
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
}
