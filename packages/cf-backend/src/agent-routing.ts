import { ORCHESTRATOR_AGENT_SLUG } from "@proteus/core";

/**
 * The `/agents/*` transport boundary — the single policy for which requests may
 * be routed to a Durable Object over the public agents transport.
 *
 * `routeAgentRequest` (partyserver) maps EVERY DO namespace binding by kebab-case
 * slug. Only the orchestrator agent is a client-facing DO; UserDO,
 * ExplorationAgent, ProteusSandbox and the Nimbus namespaces are worker-side-only
 * (reached via `env.<NS>.get(id).method()` stubs, no HTTP route, no @callable
 * surface). Without pinning, `/agents/user-d-o/<victimUserId>` would map straight
 * onto a victim's UserDO — the F1 account-takeover hole. This module is the one
 * place that decides what the transport will and will not route.
 */

// Anchored: a connect ticket is only valid for the agent's root websocket path.
// Sub-paths (e.g. facet routing under the agent) would expose a child agent's
// @callable surface to scoped sockets, so they never ticket-auth.
export const ORCHESTRATOR_AGENT_PATH_RE = new RegExp(`^/agents/${ORCHESTRATOR_AGENT_SLUG}/([^/]+)$`);

export function extractOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(ORCHESTRATOR_AGENT_PATH_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

// The only DO namespace reachable over the public `/agents/*` transport. The
// trailing slash prevents sibling-slug confusion (`orchestrator-agent-evil`).
export const ORCHESTRATOR_AGENT_PATH_PREFIX = `/agents/${ORCHESTRATOR_AGENT_SLUG}/`;

/** True for an `/agents/<slug>/…` request addressed to any namespace other than
 *  the orchestrator. These must be rejected before `routeAgentRequest` can map
 *  the slug onto a privileged worker-side DO. */
export function isForeignAgentNamespacePath(pathname: string): boolean {
  return pathname.startsWith("/agents/") && !pathname.startsWith(ORCHESTRATOR_AGENT_PATH_PREFIX);
}
