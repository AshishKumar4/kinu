/**
 * Sandbox lifecycle failures — the notification the container could not make.
 *
 * The container's persistence path (the filesystem attach on start, the
 * periodic checkpoint, the supervised processes and ports it restores) reported
 * its failures to `diagnostics` and nowhere else, which is a logging sink. An
 * agent that lost a workspace attach saw a generically-failing tool call; an
 * agent whose checkpoint had been failing for an hour saw nothing at all. That
 * is the gap this closes: the sandbox's Durable Object calls
 * {@link acceptSandboxLifecycleFailure} on the workspace root stub, and the
 * failure becomes a blocker the agent is woken for.
 *
 * ── Why a blocker, and why its own turn ──────────────────────────
 * Every stage below means work the agent is about to do — or has just done —
 * cannot be relied on. Spliced into a live step it would be read beside the
 * work it is telling the agent to stop, so it goes through the signal seam at
 * `severity: 'blocker'`, and the seam's own policy (`orchestrator/signals.ts`)
 * gives a blocker its own turn. Nothing here picks a delivery mechanism.
 *
 * ── Exactly-once, stated exactly ─────────────────────────────────
 * The ledger below is the dedupe, keyed by the caller's `incidentId`. A row is
 * written BEFORE delivery is attempted and carries the outcome, so:
 *   • an incident already ANNOUNCED is answered from the row and never
 *     re-delivered — one incident, one turn, however many times the container
 *     retries;
 *   • an incident whose delivery did NOT land is re-delivered on the next
 *     call, which is what makes the container's retry loop terminate.
 * The signal's `idempotencyKey` is the same identity, so even a re-delivery
 * lands on the durable message row the first one wrote rather than beside it.
 * The ledger exists because the submission ledger cannot answer "was this
 * incident already announced" — it is keyed by submission, and its accept flag
 * is not carried back through the signal seam.
 *
 * ── What must never cross this boundary ──────────────────────────
 * The envelope carries a bounded reason string and nothing else. It has no
 * field for an R2 key, a presigned URL, an archive path or a credential, and
 * `v.strictObject` REFUSES an envelope that invents one rather than stripping
 * it — a silently-dropped field would let a caller believe it had passed
 * something the agent would read. The reason itself is the caller's prose: it
 * is bounded, and it is not scrubbed, which is why the contract with the
 * sandbox is that it puts no secret material there.
 *
 * ── Nothing is deferred past the response ────────────────────────
 * `waitUntil` is a no-op in a Durable Object and a floating promise there is
 * cancelled on eviction with the cancellation swallowed. So the ledger write
 * and the delivery both run inside the invocation that answers the container,
 * and the container's retry is the recovery.
 */

import * as v from 'valibot';
import type { IncidentStage } from '@kinu.run/devbox';
// The VALUE import rides the pure subpath: the barrel loads Devbox -> Sandbox ->
// `cloudflare:workers`, which only exists under workerd, and this module's
// tests run under bun.
import { INCIDENT_REASON_MAX_CHARS } from '@kinu.run/devbox/incidents';
import type {
  AgentSignal, JsonObject, JsonValue, RawSqlExec, SignalDeliverer, SignalOutcome,
  SqlExecutor,
} from '@kinu.run/core';

/** Longest reason a caller may hand over. Past this it is not a reason, it is
 *  a payload wearing one — and the agent reads it in a turn, not a log. The
 *  ONE bound for incident reasons, imported from the package that mints them. */
const MAX_REASON_CHARS = INCIDENT_REASON_MAX_CHARS;

/** The `kinuEvent` name a lifecycle failure's turn is stamped with. */
export const SANDBOX_LIFECYCLE_SIGNAL_KIND = 'sandbox_lifecycle_failure';

/**
 * What each stage costs the agent, in the agent's own terms.
 *
 * Data rather than one generic sentence, because the sentences are not
 * interchangeable: a failed checkpoint means recent work is not durable, while
 * a failed attach means the workspace it is looking at may be missing content
 * that does exist. An agent told only "the sandbox failed" would check the
 * wrong thing.
 *
 * ONE VOCABULARY, AND IT IS THE PRODUCER'S. Keyed by `@kinu.run/devbox`'s own
 * `IncidentStage`, so the compiler refuses a table that is missing a stage the
 * container can emit and refuses one that invents a stage nothing produces.
 * Both halves are load-bearing: the two sides used to keep separate lists, the
 * container emitted `attach` and `checkpoint`, this schema admitted neither,
 * and every restore failure and snapshot failure — the two the seam exists for
 * — was answered `rejected` and frozen in the container's ledger, never
 * retried and never seen by the agent.
 */
const STAGE_CONSEQUENCE = {
  attach: 'The container came up without its workspace, or with an incomplete one. '
    + 'Files you expect to be there may be absent even though they were written earlier, '
    + 'and sandbox tools are refused until a scheduled retry succeeds. '
    + 'Verify the workspace contents before you trust or overwrite anything in it.',
  checkpoint: 'Work written inside the container since the last good checkpoint is NOT durable. '
    + 'If the container sleeps or is replaced, that work is gone. Copy anything that matters '
    + 'out of the container, or say plainly that it is at risk.',
  process: 'A process you started inside the container is gone and will not report a result. '
    + 'Do not wait for it. Re-run it if you still need it, and say what is missing.',
  port: 'An exposed port is no longer reachable, so any preview URL for it is dead. '
    + 'Re-expose it if you still need it, and do not hand out the old URL.',
} satisfies Record<IncidentStage, string>;

/**
 * Where the container's persistence path can fail. Closed, and closed on the
 * consequence table above: a stage nobody has decided a consequence for must
 * not be admitted with a generic one, and a stage the container can emit must
 * not be refused. Derived from the table so neither can happen.
 */
// SAFETY: STAGE_CONSEQUENCE is compiler-checked exhaustive over IncidentStage
// above, so its own keys are exactly the incident stages.
const STAGE_KEYS = Object.keys(STAGE_CONSEQUENCE) as readonly IncidentStage[];

export const SANDBOX_LIFECYCLE_STAGES = STAGE_KEYS;

export type SandboxLifecycleStage = IncidentStage;

export const SandboxLifecycleFailureSchema = v.strictObject({
  /** The caller's stable name for this failure. The dedupe key, and the
   *  identity the queued turn's durable message id is derived from. */
  incidentId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  stage: v.picklist(SANDBOX_LIFECYCLE_STAGES),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_CHARS)),
  /** The process this failure belongs to, where the stage has one. */
  processId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  /** The exposed port this failure belongs to, where the stage has one. */
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
});

export type SandboxLifecycleFailure = v.InferOutput<typeof SandboxLifecycleFailureSchema>;

export type SandboxLifecycleFailureResult =
  | {
    readonly status: 'queued';
    readonly incidentId: string;
    /** What the signal seam did with it — `queued` for the blocker's own
     *  turn, `undelivered` when the enqueue was pre-empted or threw. */
    readonly signal: SignalOutcome;
    /** This incident had already been announced before this call. */
    readonly duplicate: boolean;
  }
  | { readonly status: 'rejected'; readonly reason: string };

/** The signal's stable identity — one announcement per incident, whichever
 *  path delivers it. The queued turn's durable message id is derived from
 *  this, which is what makes a re-delivery land on the same row. */
export function sandboxLifecycleIncidentKey(incidentId: string): string {
  return `sandbox-lifecycle:${incidentId}`;
}

/**
 * The incident ledger — identity and delivery state, and deliberately nothing
 * else.
 *
 * The stage, the reason and the process or port are NOT stored here, because
 * the announcement itself is already durable: it becomes a Think submission
 * and then a chat row the agent reads and a human can read beside it. A copy
 * here would be a second source of truth for the same sentence, drifting the
 * moment the wording changed. What no other store can answer is the one
 * question the dedupe turns on — has this incident id already been announced,
 * and if not, did the last attempt land — so that is the whole table.
 *
 * Declared `sandbox_lifecycle_incidents` for `cf-orchestrator` in core's
 * conformance manifest.
 */
export function initSandboxLifecycleTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS sandbox_lifecycle_incidents (
    incident_id   TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    announced_at  INTEGER,
    outcome       TEXT
  )`);
}

interface IncidentRow {
  incident_id: string;
  first_seen_at: number;
  announced_at: number | null;
  outcome: string | null;
}

const StoredOutcomeSchema = v.picklist(['mid-turn', 'queued', 'undelivered'] as const);

/** The stored delivery state of one incident, or null when it is new. A stored
 *  outcome outside the seam's own vocabulary is a corrupt row, not a state to
 *  branch on, so it throws here rather than reading as "not announced". */
function readDeliveryState(
  sql: SqlExecutor, incidentId: string,
): { readonly announcedAt: number | null; readonly outcome: SignalOutcome | null } | null {
  const row = sql<IncidentRow>`SELECT incident_id, first_seen_at, announced_at, outcome
    FROM sandbox_lifecycle_incidents WHERE incident_id = ${incidentId}`[0];
  if (!row) return null;
  return {
    announcedAt: row.announced_at,
    outcome: row.outcome === null ? null : v.parse(StoredOutcomeSchema, row.outcome),
  };
}

export interface SandboxLifecycleDeps {
  readonly sql: SqlExecutor;
  /** The one way anything asynchronous reaches the agent. */
  readonly signals: SignalDeliverer;
  readonly logActivity?: (event: string, detail?: string) => void;
}

/**
 * Record and announce one sandbox lifecycle failure.
 *
 * `body` is arbitrary JSON because it crossed a Durable Object RPC boundary
 * from another object — this function IS the parse boundary, and
 * {@link SandboxLifecycleFailureSchema} is the parser. A `rejected` answer is
 * a caller bug, not a transient: retrying the same malformed envelope cannot
 * change the outcome, and the reason names the field.
 */
export async function acceptSandboxLifecycleFailure(
  deps: SandboxLifecycleDeps,
  body: JsonValue,
  now: number,
): Promise<SandboxLifecycleFailureResult> {
  const parsed = v.safeParse(SandboxLifecycleFailureSchema, body);
  if (!parsed.success) {
    return {
      status: 'rejected',
      reason: `malformed sandbox lifecycle failure: ${parsed.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const incident = parsed.output;

  // Read BEFORE writing: the answer this call gives depends on whether the
  // announcement had already landed, and the insert below would overwrite that.
  const before = readDeliveryState(deps.sql, incident.incidentId);
  if (before !== null && before.announcedAt !== null && before.outcome !== null
    && before.outcome !== 'undelivered') {
    deps.logActivity?.('sandbox_incident_duplicate', `${incident.stage} — ${incident.incidentId}`);
    return {
      status: 'queued',
      incidentId: incident.incidentId,
      signal: before.outcome,
      duplicate: true,
    };
  }

  // The row lands BEFORE delivery is attempted, so an incident whose delivery
  // is lost is still on record and is still re-deliverable by the caller's next
  // attempt. `first_seen_at` is written once and never moved: when the incident
  // was first reported is a fact, not a per-attempt one.
  void deps.sql`INSERT INTO sandbox_lifecycle_incidents
      (incident_id, first_seen_at, announced_at, outcome)
    VALUES (${incident.incidentId}, ${now}, NULL, NULL)
    ON CONFLICT(incident_id) DO NOTHING`;

  const metadata: JsonObject = {
    incidentId: incident.incidentId,
    stage: incident.stage,
  };
  if (incident.processId !== undefined) metadata.processId = incident.processId;
  if (incident.port !== undefined) metadata.port = incident.port;

  const signal: AgentSignal = {
    kind: SANDBOX_LIFECYCLE_SIGNAL_KIND,
    text: incidentText(incident),
    metadata,
    // NAMES ITS OWN FACT. Without this the signal has no identity, so
    // `signals.deliver` takes the non-idempotent path and a re-delivery of the
    // same incident lands as a second message instead of being recognised as
    // the one already announced. The header has promised this since the module
    // was written, and the key helper existed for it — exported, with a test
    // asserting the key reaches the wire, and nothing putting it there.
    idempotencyKey: sandboxLifecycleIncidentKey(incident.incidentId),
  };
  const outcome = await deps.signals.deliver(signal);
  const landed = outcome !== 'undelivered';
  void deps.sql`UPDATE sandbox_lifecycle_incidents
    SET outcome = ${outcome}, announced_at = ${landed ? now : null}
    WHERE incident_id = ${incident.incidentId}`;
  deps.logActivity?.(
    landed ? 'sandbox_incident_announced' : 'sandbox_incident_undelivered',
    `${incident.stage} — ${incident.incidentId}`,
  );
  return { status: 'queued', incidentId: incident.incidentId, signal: outcome, duplicate: false };
}

/** What the agent reads. The stage's consequence first, because that is what
 *  it has to act on; the caller's reason after it, because that is evidence. */
function incidentText(incident: SandboxLifecycleFailure): string {
  const where = incident.processId !== undefined
    ? ` (process ${incident.processId})`
    : incident.port !== undefined ? ` (port ${String(incident.port)})` : '';
  return `The workspace container failed at the ${incident.stage} stage${where}. `
    + `${STAGE_CONSEQUENCE[incident.stage]}\n\n`
    + `Reported cause: ${incident.reason}\n`
    + `Incident id: ${incident.incidentId}`;
}
