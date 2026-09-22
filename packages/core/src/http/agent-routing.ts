import { ORCHESTRATOR_AGENT_SLUG } from '../cloud-wire';

/**
 * `/agents/*` transport policy: only the orchestrator namespace and hosted actors beneath it (`/actor/<name>`) route.
 * Other DO namespaces and `/sub/` facet hops are refused before ownership lookup and `routeAgentRequest` (F1 takeover).
 */

const ROOT_AGENT_PATH = `/agents/${ORCHESTRATOR_AGENT_SLUG}`;

/** Transport-served endpoints beneath an actor path; `useAgentChat` fetches history via `get-messages`.
 *  Named, not wildcarded: a path routes only because it is named here. */
const TRANSPORT_ENDPOINTS = ['get-messages'] as const;

/** Marker segment for a hosted actor's chat; what follows is a logical actor name, not a DO key. */
const HOSTED_ACTOR_SEGMENT = 'actor';

const TRANSPORT_TAIL = `(?:/(?:${TRANSPORT_ENDPOINTS.join('|')}))?/?`;

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

export function extractTicketOrchestratorAgentName(pathname: string): string | null {
  const match = pathname.match(CLI_TICKET_AGENT_PATH_RE);

  return match ? decodeURIComponent(match[1]) : null;
}

/** True for any `/agents/*` path outside the closed public actor grammar; reject before `routeAgentRequest`. */
export function isForeignAgentNamespacePath(pathname: string): boolean {
  return pathname.startsWith('/agents/') && !ORCHESTRATOR_AGENT_PATH_RE.test(pathname);
}

const HOSTED_ACTOR_PATH = new RegExp(
  `^${ROOT_AGENT_PATH}/[^/]+/${HOSTED_ACTOR_SEGMENT}/([^/]+)(.*)$`,
);

/** The hosted actor a public path addresses (logical name + transport suffix), or null for the workspace itself. */
/** Client socket path tail for a hosted actor's chat; one definition shared with {@link hostedActorRoute}. */
export function hostedActorSocketPath(name: string): string {
  return `${HOSTED_ACTOR_SEGMENT}/${encodeURIComponent(name)}`;
}

export function hostedActorRoute(pathname: string): { name: string; suffix: string } | null {
  if (isForeignAgentNamespacePath(pathname)) return null;
  const match = pathname.match(HOSTED_ACTOR_PATH);

  if (!match || match[1] === undefined || match[2] === undefined) return null;

  return { name: decodeURIComponent(match[1]), suffix: match[2] };
}

/** Connection tag prefix recording which actor a socket addressed. */
const ACTOR_CONNECTION_TAG_PREFIX = 'actor:';

/** Connection tag for a socket on this path, or null for the root. Tags survive hibernation; in-memory maps do not. */
export function actorConnectionTag(pathname: string): string | null {
  const route = hostedActorRoute(pathname);

  return route === null ? null : `${ACTOR_CONNECTION_TAG_PREFIX}${route.name}`;
}

export function actorFromConnectionTags(tags: Iterable<string>): string | null {
  for (const tag of tags) {
    if (tag.startsWith(ACTOR_CONNECTION_TAG_PREFIX)) return tag.slice(ACTOR_CONNECTION_TAG_PREFIX.length);
  }

  return null;
}
