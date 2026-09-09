import { ORCHESTRATOR_AGENT_SLUG } from "@kinu.run/core";

/**
 * The `/agents/*` transport boundary — the single policy for which requests may
 * be routed to a Durable Object over the public agents transport.
 *
 * `routeAgentRequest` (partyserver) maps EVERY DO namespace binding by kebab-case
 * slug. Only the orchestrator namespace is client-facing; UserDO, KinuSandbox and
 * the Nimbus namespaces are worker-side-only (reached via
 * `env.<NS>.get(id).method()` stubs, no HTTP route). Without pinning,
 * `/agents/user-d-o/<victimUserId>` would map straight onto a victim's UserDO —
 * the F1 account-takeover hole. This module is the one place that decides what
 * the transport will route.
 *
 * ── `/sub/` IS FOREIGN, AND THAT IS THE POINT ────────────────────────────
 *
 * There is no facet class: every actor in a workspace — a hired subordinate, an
 * ask-by-role temporary, a head, a node, a rollout branch — is a LOGICAL actor
 * hosted by the one root object. So a `/sub/<class-slug>/<key>` hop names
 * nothing reachable, and admitting it would leave the SDK's recursive facet
 * resolution addressable from the public transport with nothing legitimate
 * behind it. It is refused here, with every other namespace, BEFORE ownership
 * lookup and before `routeAgentRequest`.
 *
 * A hosted actor's chat is addressed by its LOGICAL NAME under the
 * workspace that owns it — `/actor/<name>` — and the root serves it. No path is
 * rewritten on the way in: there is no second object to rewrite it towards.
 */

const ROOT_AGENT_PATH = `/agents/${ORCHESTRATOR_AGENT_SLUG}`;

/**
 * HTTP endpoints the transport itself serves beneath an actor path.
 *
 * The agents SDK does NOT put chat history on the socket: `useAgentChat` fetches
 * it by appending this segment to the agent URL
 * (`agents/chat/react.js` → `defaultGetInitialMessagesFetch`), and the DO answers
 * it in `onRequest` (`@cloudflare/ai-chat` → `pathname.split('/').pop() === 'get-messages'`).
 * Closing the grammar against it costs the history pane: the socket at
 * `/agents/orchestrator-agent/<name>` connects while every mount of it also
 * logs `GET /agents/orchestrator-agent/<name>/get-messages 404`, because
 * `isForeignAgentNamespacePath` calls the SDK's own history fetch foreign and
 * the hook swallows the 404 into an empty history. The pane then renders only
 * what arrived live after mount, which reads to the owner as "all my messages
 * are gone" while the conversation sits intact in the DO.
 *
 * Named rather than opened to `[^/]+`, for three reasons that agree: a wildcard
 * would re-admit arbitrary segments to a namespace deliberately pinned after the
 * F1 account-takeover hole; this module's whole premise is that a path routes
 * because it was named here; and `server.ts` runs the run-events, hub and files
 * handlers over every admitted actor path, each parsing the tail itself. The
 * SDK's endpoint set is small and known, so enumerating it costs nothing.
 */
const TRANSPORT_ENDPOINTS = ['get-messages'] as const;

/** The marker segment that identifies a hosted actor's own chat beneath its
 *  workspace. A literal rather than a class slug: what follows it is a logical
 *  actor NAME the root resolves through its directory, not a Durable Object key
 *  the SDK resolves through a binding. */
const HOSTED_ACTOR_SEGMENT = 'actor';

const TRANSPORT_TAIL = `(?:/(?:${TRANSPORT_ENDPOINTS.join('|')}))?/?`;

// The public agent transport has exactly two shapes: the workspace itself, and
// one hosted actor beneath it addressed by its logical name. Every other
// namespace — and every `/sub/` facet hop, which names nothing — stays
// unroutable.
const ORCHESTRATOR_AGENT_PATH_RE = new RegExp(
  `^${ROOT_AGENT_PATH}/([^/]+)(?:${TRANSPORT_TAIL}`
  + `|/${HOSTED_ACTOR_SEGMENT}/[^/]+${TRANSPORT_TAIL})$`,
);

const CLI_TICKET_AGENT_PATH_RE = new RegExp(
  `^${ROOT_AGENT_PATH}/([^/]+)(?:/?$|/${HOSTED_ACTOR_SEGMENT}/[^/]+/?$)`,
);

export function extractOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(ORCHESTRATOR_AGENT_PATH_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Connect tickets stay scoped to the root workspace identity. The same ticket
 * can enter one hosted actor beneath that root; the closed grammar still
 * refuses every other namespace. */
export function extractTicketOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(CLI_TICKET_AGENT_PATH_RE);
  return match ? decodeURIComponent(match[1]) : null;
}

/** True for any `/agents/*` path outside the closed public actor grammar.
 *  These must be rejected before `routeAgentRequest` can map a namespace or
 *  recursively resolve a worker-only facet class. */
export function isForeignAgentNamespacePath(pathname: string): boolean {
  return pathname.startsWith('/agents/') && !ORCHESTRATOR_AGENT_PATH_RE.test(pathname);
}

const HOSTED_ACTOR_PATH = new RegExp(
  `^${ROOT_AGENT_PATH}/[^/]+/${HOSTED_ACTOR_SEGMENT}/([^/]+)(.*)$`,
);

/**
 * The hosted actor a public path addresses, or null for the workspace itself.
 *
 * Returns the LOGICAL name and the tail, and deliberately no prefix to rewrite:
 * there is no second object and no physical key in the URL — the root receives
 * this path as-is and resolves the name through its own directory. Handing
 * `server.ts` a `prefix` would mean substituting a facet's physical storage key
 * into the SDK's `/sub/<class>/<key>` hop, which is both a rewrite nothing needs
 * and a storage key in a client-visible address.
 */
export function hostedActorRoute(pathname: string): { name: string; suffix: string } | null {
  if (isForeignAgentNamespacePath(pathname)) return null;
  const match = pathname.match(HOSTED_ACTOR_PATH);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { name: decodeURIComponent(match[1]), suffix: match[2] };
}
