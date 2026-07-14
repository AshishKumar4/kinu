import { ORCHESTRATOR_AGENT_SLUG, SUBORDINATE_AGENT_SLUG } from "@proteus/core";

/**
 * The `/agents/*` transport boundary — the single policy for which requests may
 * be routed to a Durable Object over the public agents transport.
 *
 * `routeAgentRequest` (partyserver) maps EVERY DO namespace binding by kebab-case
 * slug. Only the orchestrator namespace and its direct SubordinateAgent facet
 * are client-facing; UserDO, ExplorationAgent, ProteusSandbox and the Nimbus
 * namespaces are worker-side-only (reached via `env.<NS>.get(id).method()`
 * stubs, no HTTP route). Without pinning, `/agents/user-d-o/<victimUserId>`
 * would map straight onto a victim's UserDO — the F1 account-takeover hole.
 * This module is the one place that decides what the transport will route.
 */

const ROOT_AGENT_PATH = `/agents/${ORCHESTRATOR_AGENT_SLUG}`;

// The public agent transport has exactly two shapes: the workspace
// orchestrator, and a SubordinateAgent facet beneath it. ExplorationAgent and
// every other facet/namespace remain worker-only. A non-facet path may follow
// the subordinate name, but another literal `sub` segment may not: the agents
// SDK treats that marker as recursive facet routing.
export const ORCHESTRATOR_AGENT_PATH_RE = new RegExp(
  `^${ROOT_AGENT_PATH}/([^/]+)(?:$|/sub/${SUBORDINATE_AGENT_SLUG}/[^/]+(?:/(?!sub(?:/|$))[^/]+)*/?$)`,
);

const ORCHESTRATOR_ROOT_AGENT_PATH_RE = new RegExp(`^${ROOT_AGENT_PATH}/([^/]+)$`);

export function extractOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(ORCHESTRATOR_AGENT_PATH_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Connect tickets are scoped to the root orchestrator socket. Facet sockets
 * authenticate through the browser session and parent ownership check. */
export function extractTicketOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(ORCHESTRATOR_ROOT_AGENT_PATH_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** True for any `/agents/*` path outside the closed public actor grammar.
 *  These must be rejected before `routeAgentRequest` can map a namespace or
 *  recursively resolve a worker-only facet. */
export function isForeignAgentNamespacePath(pathname: string): boolean {
  return pathname.startsWith('/agents/') && !ORCHESTRATOR_AGENT_PATH_RE.test(pathname);
}
