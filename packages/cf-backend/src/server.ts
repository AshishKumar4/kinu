/**
 * Worker entry point — exports all DO classes and routes agent requests.
 *
 * Routing order (Worker runs first for every non-hashed-asset path):
 *   1. proxyToSandbox — if the host is a preview URL (PORT-SANDBOX-TOKEN.host),
 *      forward to the sandbox container.
 *   2. /pc/* — PC agent WebSocket tunnel + install endpoint.
 *   3. routeAgentRequest — /agents/* routes to Think DOs.
 *   4. env.ASSETS fallback — serve the SPA for everything else.
 */

import { routeAgentRequest } from "agents";
import { handlePcRequest } from "./pc-handler.js";
import { proxyPreviewRequest } from "./preview-proxy.js";

export { OrchestratorAgent } from "./orchestrator.js";
export { ExplorationAgent } from "./exploration.js";
export { ProteusSandbox } from "./proteus-sandbox.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Preview URLs use a path prefix on the main domain — we proxy them
    // straight to the sandbox container. Falls through (null) for
    // non-preview traffic. The SDK's built-in proxyToSandbox requires a
    // wildcard DNS record we don't control; see preview-proxy.ts.
    const previewResp = await proxyPreviewRequest(request, env);
    if (previewResp) return previewResp;

    if (url.pathname.startsWith("/pc/")) {
      return handlePcRequest(request, env);
    }

    const agentResp = await routeAgentRequest(request, env);
    if (agentResp) return agentResp;

    // SPA fallback — `run_worker_first: ["/*", "!/assets/*"]` means the
    // Worker sees every request, so we must explicitly forward misses to
    // the static-asset handler (which knows how to serve index.html via
    // not_found_handling: single-page-application).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
