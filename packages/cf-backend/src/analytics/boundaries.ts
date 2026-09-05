/**
 * The fleet event boundaries: every place a Cloudflare-side failure, turn, model
 * request, tool call, job settlement or release transition becomes a row.
 *
 * ## Why this list exists at all
 *
 * An instrument nobody asserts on is an instrument nobody notices has stopped.
 * Instrumentation is uniquely prone to that because its absence looks exactly
 * like quiet: a deleted emit line leaves a passing build, a passing suite, and a
 * dataset whose missing rows read as "nothing happened there". So the boundaries
 * are DECLARED, and the declaration is load-bearing in two directions.
 *
 * RUNTIME. `boundaryOf` is read by the diagnostics sink to stamp the `boundary`
 * slot, so a declared boundary's rows are queryable by boundary id and an
 * undeclared event's are not. The list is therefore exercised on every write
 * rather than being a fixture a gate reads and nothing else does — the failure
 * mode of every registry that drifts.
 *
 * GATE. `tests/unit-analytics-boundaries.test.ts` asserts set equality between
 * this list and the emit sites actually present in the named files, and that the
 * families covered are exactly the pinned five. Deleting an emit line reds it;
 * adding a boundary without instrumenting it reds it; instrumenting something
 * without declaring it reds it. The list is module-private, so the gate recovers
 * it from this file's own syntax with the parser it already walks the emit sites
 * with — the declaration is one side of a source-structure equality, and reading
 * it the same way as the other side is what keeps the two halves comparable.
 *
 * ## Why the mechanism is part of the declaration
 *
 * Two thirds of these sites cannot reach a binding. `rejectOutOfScopeRpc` is a
 * pure function over a frame, `createCloudflareAIFetch` closes over options and
 * not an environment, and the capability gate is a free function over SQL. Those
 * emit through core's `diagnostics` seam and the sink routes them; the sites that
 * DO hold an environment and a numeric payload — a turn, a model request, a tool
 * call, a job, a release — call a writer directly, because routing a turn's
 * eleven measured numbers through a log line's string fields would lose every one
 * of them. Recording which mechanism a boundary uses is what lets one gate check
 * both kinds without knowing them individually.
 */
import type { LogEventName } from '@kinu.run/core/obs';

/**
 * The five boundary families, pinned. A family is the QUESTION a query asks —
 * "what is failing", "how are turns going", "which provider is refusing", "are
 * jobs settling", "are releases moving" — which is why the set is closed: a
 * sixth family is a new question and should have to be argued for, not appear.
 */
const BOUNDARY_FAMILIES = ['error', 'turn', 'provider', 'job', 'release'] as const;

type BoundaryFamily = (typeof BOUNDARY_FAMILIES)[number];

/**
 * How a boundary reaches Analytics Engine.
 *
 * `diagnostics` — the site has no binding in reach; it emits through core's
 * global logger and `install.ts` routes it. Cheap, no plumbing, string fields.
 *
 * `writer` — the site holds an environment and a measured payload; it calls a
 * named adapter in `record.ts`. Typed, numeric, and isolate-agnostic, which is
 * what makes it correct inside a Durable Object where an installed sink from the
 * Worker's isolate would not be present.
 */
type BoundaryMechanism = 'diagnostics' | 'writer';

interface FleetBoundary {
  /** Stable id, written to the `boundary` blob. Never renamed: it is the join
   *  key between a dataset three months deep and this file. */
  readonly id: string;
  readonly family: BoundaryFamily;
  /** The dotted event name the row carries. For a `diagnostics` boundary this is
   *  literally the name passed to `diagnostics.event`/`failure`, which is what
   *  lets the sink find the boundary from the line alone. */
  readonly event: LogEventName;
  /** Repo-relative file the emit lives in. The gate's denominator. */
  readonly site: string;
  readonly mechanism: BoundaryMechanism;
  /** The identifier the gate looks for at the site: the adapter's name for a
   *  `writer` boundary, and the emitting method for a `diagnostics` one. */
  readonly emitter: string;
  /** What a row here means, in one sentence, for whoever reads the dataset
   *  later and does not have this file open. */
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
    site: 'packages/cf-backend/src/user/workspace-capability.ts',
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
    site: 'packages/cf-backend/src/email/outbox.ts',
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
    site: 'packages/cf-backend/src/providers/cloudflare-ai-fetch.ts',
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

/**
 * Boundary ids by event name, for the sink's `boundary` stamp. Built once: the
 * lookup is on a per-datapoint path, and the list is fixed at module load.
 */
const BOUNDARY_ID_BY_EVENT: Record<string, string> = Object.fromEntries(
  FLEET_BOUNDARIES.map((boundary) => [boundary.event, boundary.id] as const),
);

/**
 * The boundary id for an event name, or the empty string when the event is not a
 * declared boundary. Empty rather than the event's own name: a query filtering on
 * `boundary` is asking about the declared set, and quietly widening it to every
 * diagnostic in the codebase would make that filter meaningless.
 */
export function boundaryOf(event: string): string {
  return BOUNDARY_ID_BY_EVENT[event] ?? '';
}

/**
 * The family segment of a dotted event name — everything before the first dot,
 * and the whole name when there is none.
 *
 * Stored in its own slot rather than derived at query time. AE's SQL dialect is a
 * subset, so a reader cannot be assumed to have string splitting; and the
 * question it answers — which SUBSYSTEM is producing this — is the first one
 * anyone asks of a dataset holding hundreds of distinct event names, which makes
 * it a dimension rather than a derivation.
 */
export function eventFamily(event: string): string {
  const dot = event.indexOf('.');
  return dot < 0 ? event : event.slice(0, dot);
}
