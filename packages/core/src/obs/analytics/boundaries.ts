/**
 * Declared fleet event boundaries. `boundaryOf` stamps the `boundary` slot on every write, and
 * `scripts/analytics-datasets.test.ts` holds the set equal to the emit sites in `site`.
 */
import type { LogEventName } from '../log';

/** Closed set: a family is the question a query asks; a sixth must be argued for. */
const BOUNDARY_FAMILIES = ['error', 'turn', 'provider', 'job', 'release'] as const;

type BoundaryFamily = (typeof BOUNDARY_FAMILIES)[number];

/**
 * `diagnostics`: no binding in reach; emits via core's logger and `install.ts` routes it.
 * `writer`: holds an env and calls a `record.ts` adapter; works in a DO, where no sink is
 * installed.
 */
type BoundaryMechanism = 'diagnostics' | 'writer';

interface FleetBoundary {
  /** Written to the `boundary` blob; never renamed, it joins stored rows to this file. */
  readonly id: string;
  readonly family: BoundaryFamily;
  readonly event: LogEventName;
  readonly site: string;
  readonly mechanism: BoundaryMechanism;
  /** Identifier the gate looks for at the site: adapter name or emitting method. */
  readonly emitter: string;
  readonly means: string;
}

const FLEET_BOUNDARIES: readonly FleetBoundary[] = [
  {
    id: 'http.run_events',
    family: 'error',
    event: 'http.run_events_failed',
    site: 'packages/cf-backend/src/run-events-routes.ts',
    mechanism: 'diagnostics',
    emitter: 'failure',
    means: 'A run-event list or page answered 500. The route answers with a '
      + 'rendered cause and records the failure, so a workspace whose history '
      + 'is unreachable still produces a fleet signal.',
  },
  {
    id: 'capability.denied',
    family: 'error',
    event: 'capability.denied',
    site: 'packages/core/src/safety/workspace-capability.ts',
    mechanism: 'diagnostics',
    emitter: 'denyCapability',
    means: 'A privileged user-level call was refused: no caller identity, an '
      + 'unrecognized token, an unregistered tier, or a tier too low for the '
      + 'capability. The denial reason is a closed word, never the token.',
  },
  {
    id: 'rpc_gate.denied',
    family: 'error',
    event: 'rpc_gate.denied',
    site: 'packages/cf-backend/src/cli/rpc-gate.ts',
    mechanism: 'diagnostics',
    emitter: 'event',
    means: 'A scoped CLI access token asked for an RPC its scope does not carry. '
      + 'The method name and the scope it needed; never the token.',
  },
  {
    id: 'email.outbox',
    family: 'error',
    event: 'email.outbox_send_failed',
    site: 'packages/core/src/events/email-outbox.ts',
    mechanism: 'diagnostics',
    emitter: 'failure',
    means: 'One send attempt on a queued outbound message failed and was backed '
      + 'off. Carries no address, no subject and no body — the retry LOOP was '
      + 'the silent part, and a count is the whole signal.',
  },
  {
    id: 'monitor.check',
    family: 'error',
    event: 'monitor.check_failed',
    site: 'packages/cf-backend/src/server.ts',
    mechanism: 'diagnostics',
    emitter: 'failure',
    means: 'The synthetic monitoring tick did not complete. Declared rather than '
      + 'added: the emit predates this registry, and declaring it is what makes '
      + 'its deletion visible.',
  },
  {
    id: 'sandbox.recovery',
    family: 'error',
    event: 'sandbox.recovery_settled',
    site: 'packages/cf-backend/src/orchestrator.ts',
    mechanism: 'writer',
    emitter: 'recordSandboxRecovery',
    means: 'One delivery of a container lifecycle failure to the agent settled: '
      + 'which stage failed, whether the announcement reached the agent, which '
      + 'attempt it was, and how long since the incident was first reported. A '
      + 'SUCCESSFUL recovery is a row here too, which is the point: without it '
      + 'an incident nobody was told about and one the agent acted on would '
      + 'both read as silence.',
  },
  {
    id: 'turn.settled',
    family: 'turn',
    event: 'turn.settled',
    site: 'packages/cf-backend/src/actor-agent.ts',
    mechanism: 'writer',
    emitter: 'recordTurnRow',
    means: 'A turn ended, completed or not: its duration, steps, tool calls, the '
      + "provider's own token report, and what it was priced at.",
  },
  {
    id: 'turn.first_token',
    family: 'turn',
    event: 'turn.first_token',
    site: 'packages/cf-backend/src/actor-agent.ts',
    mechanism: 'writer',
    emitter: 'recordTtftRow',
    means: 'Time to first token, measured from the turn\'s own start to the first '
      + 'streamed chunk. Per turn and provider-independent, which a transport '
      + 'first-byte measurement is not.',
  },
  {
    id: 'tool.settled',
    family: 'turn',
    event: 'tool.settled',
    site: 'packages/cf-backend/src/actor-agent.ts',
    mechanism: 'writer',
    emitter: 'recordToolRow',
    means: 'One tool call finished. Name, whether it failed, and how long it took '
      + '— never its arguments or its result.',
  },
  {
    id: 'model.call',
    family: 'turn',
    event: 'model.call',
    site: 'packages/cf-backend/src/actor-agent.ts',
    mechanism: 'writer',
    emitter: 'recordModelRow',
    means: 'One model request outside the turn loop as well as inside it — a '
      + 'judge, the fast tier, an evolution pass, a compaction fold. Who served '
      + 'it and what it reported.',
  },
  {
    id: 'provider.error',
    family: 'provider',
    event: 'provider.error',
    site: 'packages/core/src/providers/cloudflare-ai-fetch.ts',
    mechanism: 'diagnostics',
    emitter: 'failure',
    means: 'The upstream AI endpoint answered non-ok after the forced-refresh '
      + 'retry. Status and credential KEY NAME; never the credential.',
  },
  {
    id: 'job.settled',
    family: 'job',
    event: 'job.settled',
    site: 'packages/cf-backend/src/orchestrator.ts',
    mechanism: 'writer',
    emitter: 'recordJobSettled',
    means: 'A background job was cancelled, retried, dismissed or cleared, and '
      + 'whether the operation took effect.',
  },
  {
    id: 'release.transitioned',
    family: 'release',
    event: 'release.transitioned',
    site: 'packages/cf-backend/src/user/user-do.ts',
    mechanism: 'writer',
    emitter: 'recordReleaseTransition',
    means: 'A release change moved status, or a deployment was recorded against '
      + 'one. The status and the environment; the change id only as a digest.',
  },
];

const BOUNDARY_ID_BY_EVENT: Record<string, string> = Object.fromEntries(
  FLEET_BOUNDARIES.map((boundary) => [boundary.event, boundary.id] as const),
);

/** `''` for an undeclared event, so a `boundary` filter stays scoped to the declared set. */
export function boundaryOf(event: string): string {
  return BOUNDARY_ID_BY_EVENT[event] ?? '';
}

/** Segment before the first dot. Stored in its own slot: AE's SQL subset lacks string splitting. */
export function eventFamily(event: string): string {
  const dot = event.indexOf('.');

  return dot < 0 ? event : event.slice(0, dot);
}
