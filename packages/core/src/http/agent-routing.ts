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

/** Client socket path tail for a hosted actor's chat; `target` is a name or a `/`-joined path, one encoded segment. */
export function hostedActorSocketPath(target: string): string {
  return `${HOSTED_ACTOR_SEGMENT}/${encodeURIComponent(target)}`;
}

/** The hosted actor a public path addresses (name or path, and transport suffix), or null for the workspace itself. */
export function hostedActorRoute(pathname: string): { name: string; suffix: string } | null {
  if (isForeignAgentNamespacePath(pathname)) return null;
  const match = pathname.match(HOSTED_ACTOR_PATH);

  if (!match || match[1] === undefined || match[2] === undefined) return null;

  return { name: decodeURIComponent(match[1]), suffix: match[2] };
}

/** Set only by the edge, to the actor id it resolved; a client's own value is dropped. */
export const HOSTED_ACTOR_ID_HEADER = 'x-kinu-hosted-actor';

const ACTOR_CONNECTION_TAG_PREFIX = 'actor:';

export function actorConnectionTag(actorId: string): string {
  return `${ACTOR_CONNECTION_TAG_PREFIX}${actorId}`;
}

export function actorFromConnectionTags(tags: Iterable<string>): string | null {
  for (const tag of tags) {
    if (tag.startsWith(ACTOR_CONNECTION_TAG_PREFIX)) return tag.slice(ACTOR_CONNECTION_TAG_PREFIX.length);
  }

  return null;
}
