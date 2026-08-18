import { ORCHESTRATOR_AGENT_SLUG, SUBORDINATE_AGENT_SLUG } from "@proteus/core";

/**
 * The `/agents/*` transport boundary — the single policy for which requests may
 * be routed to a Durable Object over the public agents transport.
 *
 * `routeAgentRequest` (partyserver) maps EVERY DO namespace binding by kebab-case
 * slug. Only the orchestrator namespace and its direct SubordinateAgent facet
 * are client-facing; UserDO, ProteusSandbox and the Nimbus namespaces are
 * worker-side-only (reached via `env.<NS>.get(id).method()` stubs, no HTTP
 * route). Without pinning, `/agents/user-d-o/<victimUserId>`
 * would map straight onto a victim's UserDO — the F1 account-takeover hole.
 * This module is the one place that decides what the transport will route.
 */

const ROOT_AGENT_PATH = `/agents/${ORCHESTRATOR_AGENT_SLUG}`;

// The public agent transport has exactly two shapes: the workspace
// orchestrator, and a SubordinateAgent facet beneath it. Every other facet or
// namespace remains worker-only. A non-facet path may follow the subordinate
// name, but another literal `sub` segment may not: the agents SDK treats that
// marker as recursive facet routing.
//
// The orchestrator's own name may ALSO be followed by one of the agents SDK's
// sibling endpoints. Omitting them is what broke the chat: the WebSocket at
// `/agents/orchestrator-agent/<name>` connected, while
// `/agents/orchestrator-agent/<name>/get-messages` — the SDK's history fetch —
// matched nothing, so `isForeignAgentNamespacePath` called it foreign and the
// worker answered 404. The pane then rendered only what arrived live after
// mount, which reads to the owner as "all my messages are gone" while the
// conversation sits intact in the DO.
//
// Enumerated rather than opened to `[^/]+`: a wildcard here would re-admit
// arbitrary segments to a namespace we deliberately pinned after the F1
// account-takeover hole, and the SDK's endpoint set is small and known.
const SDK_ENDPOINTS = ['get-messages'] as const;
const SDK_ENDPOINT_ALT = SDK_ENDPOINTS.join('|');

export const ORCHESTRATOR_AGENT_PATH_RE = new RegExp(
  `^${ROOT_AGENT_PATH}/([^/]+)(?:$|/(?:${SDK_ENDPOINT_ALT})/?$`
  + `|/sub/${SUBORDINATE_AGENT_SLUG}/[^/]+(?:/(?!sub(?:/|$))[^/]+)*/?$)`,
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
