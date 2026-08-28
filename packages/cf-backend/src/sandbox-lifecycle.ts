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
 *
 * -- Every settlement is a row, including the good ones ----------
 * The seam used to produce no fleet signal at all, which made an incident the
 * agent acted on and an incident that reached nobody the same observable
 * result: nothing. Every exit below now hands ONE typed record to
 * `deps.recordRecovery`: the stage, how it settled, which delivery attempt it
 * was, how long since the incident was first reported, and the class of failure
 * where this side can classify one. Successful recovery and failed recovery go
 * through that one seam, so a query asks about the outcome dimension rather
 * than about whether a row exists.
 *
 * -- The envelope is versioned, and refuses to guess ----------
 * {@link SANDBOX_LIFECYCLE_ENVELOPE_VERSION} is stamped by the one producer
 * (`kinu-sandbox.ts`) and required by the schema. A caller that predates the
 * current shape is refused BY NAME rather than admitted with defaults invented
 * for the fields it did not send: a guessed attempt count would be a number in
 * the dataset that nothing measured.
 */

import * as v from 'valibot';
import type { IncidentStage } from '@kinu.run/devbox';
// The VALUE import rides the pure subpath: the barrel loads Devbox -> Sandbox ->
// `cloudflare:workers`, which only exists under workerd, and this module's
// tests run under bun.
import { INCIDENT_REASON_MAX_CHARS } from '@kinu.run/devbox/incidents';
import { toKinuError } from '@kinu.run/core/obs';
import type { ErrorCode } from '@kinu.run/core/obs';
import type { RecoveryRowInput, RowOutcome } from './analytics/record';
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
    + 'and sandbox tools are refused until an attach succeeds. '
    + 'The reported cause names the recovery the container chose for this failure, '
    + 'so read it before you decide whether to wait or to try again. '
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

/**
 * The shape this seam accepts, as a number the producer stamps.
 *
 * Version 1 was the unversioned envelope, which carried no attempt count. The
 * count cannot be derived here — the box counts its own deliveries, and a
 * Worker evicted between two of them cannot see how many there were — so it is
 * transported, and it is REQUIRED. An optional field with a default would put a
 * fabricated attempt number in the dataset every time an older caller appeared,
 * which is the one failure a dataset cannot recover from later.
 */
export const SANDBOX_LIFECYCLE_ENVELOPE_VERSION = 2;

export const SandboxLifecycleFailureSchema = v.strictObject({
  /** Which envelope shape this is. Refused by name when it does not match, so a
   *  caller that predates the current fields is told what it sent rather than
   *  told which field it left out. */
  version: v.literal(SANDBOX_LIFECYCLE_ENVELOPE_VERSION),
  /** The caller's stable name for this failure. The dedupe key, and the
   *  identity the queued turn's durable message id is derived from. */
  incidentId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** Which delivery attempt this is, as the PRODUCER counts them: its ledger is
   *  where deliveries are counted, and its first attempt is 1. Read-only here,
   *  never stored: this side mirrors no counter it does not own. */
  attempts: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stage: v.picklist(SANDBOX_LIFECYCLE_STAGES),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_CHARS)),
  /** The process this failure belongs to, where the stage has one. */
  processId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  /** The exposed port this failure belongs to, where the stage has one. */
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
});

export type SandboxLifecycleFailure = v.InferOutput<typeof SandboxLifecycleFailureSchema>;

/**
 * The answer the container's host acts on, and the ONLY delivery verdict on it.
 *
 * `status` speaks the producer's own `IncidentDisposition` vocabulary verbatim —
 * `queued`, `undelivered`, `rejected` — so the host returns it rather than
 * translating it, and the two sides cannot hold different opinions about whether
 * an announcement landed.
 *
 * THAT DISAGREEMENT WAS THE DEFECT. `status` used to be the constant `'queued'`
 * for every accepted envelope, meaning "the shape was fine", while a second
 * `signal` field held the delivery truth. The host read `status`, and the box
 * maps `queued` to `deliveredAt` — so an announcement that reached nobody made
 * the box write the incident off and stop retrying, while this side's own ledger
 * still held it as re-deliverable and was waiting to be asked again. Nobody was
 * ever told, and nothing was left to tell them. The parse verdict is no longer a
 * delivery answer, and there is no second field for it to contradict.
 */
export type SandboxLifecycleFailureResult =
  | {
    /** `queued` ONLY when the announcement landed. `undelivered` when this side
     *  took the incident and could not announce it: the ledger row stays
     *  unannounced, and the caller must offer it again. */
    readonly status: 'queued' | 'undelivered';
    readonly incidentId: string;
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
 *  branch on, so it throws here rather than reading as "not announced".
 *
 *  `firstSeenAt` is returned because it is the start of the one duration worth
 *  measuring here: how long the agent went without being told. The column was
 *  already selected and already written once and never moved, so the fact was
 *  on hand and only the reader was dropping it. */
function readDeliveryState(
  sql: SqlExecutor, incidentId: string,
): {
  readonly firstSeenAt: number;
  readonly announcedAt: number | null;
  readonly outcome: SignalOutcome | null;
} | null {
  const row = sql<IncidentRow>`SELECT incident_id, first_seen_at, announced_at, outcome
    FROM sandbox_lifecycle_incidents WHERE incident_id = ${incidentId}`[0];
  if (!row) return null;
  return {
    firstSeenAt: row.first_seen_at,
    announcedAt: row.announced_at,
    outcome: row.outcome === null ? null : v.parse(StoredOutcomeSchema, row.outcome),
  };
}

export interface SandboxLifecycleDeps {
  readonly sql: SqlExecutor;
  /** The one way anything asynchronous reaches the agent. */
  readonly signals: SignalDeliverer;
  /**
   * The fleet row for one settlement, successful or not.
   *
   * REQUIRED, unlike `logActivity`. An instrument that may be absent is one
   * whose absence looks exactly like a quiet fleet, which is the failure mode
   * `analytics/boundaries.ts` exists to prevent. `workspace` is the caller's own
   * identity and the one dimension this module cannot know, so the caller
   * supplies it and everything else on the row is decided here.
   */
  readonly recordRecovery: (row: Omit<RecoveryRowInput, 'workspace'>) => void;
  /** Best-effort tracing. Optional, and its failures are contained by whoever
   *  implements it: nothing on this path may be lost to a log line. */
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
    // Nothing about this envelope is claimed as a dimension: it named no stage
    // and no attempt, and a fabricated one is worse than an absent one. The
    // outcome is `refused` rather than `failed` because `bad_input` IS a
    // refusal (core's CODE_IS_REFUSAL) — a rate that pooled a caller's bad
    // envelope with a delivery that broke would answer neither question.
    deps.recordRecovery({
      stage: '', outcome: 'refused', code: 'bad_input', attempts: 0, durationMs: 0,
    });
    // NAMED, and through valibot's own path helper. A missing key already
    // carries its name in the message; a mismatched VALUE does not — "Expected 2
    // but received 1" is the version refusal, which is the one a caller most
    // needs to read and the one that said least. Prepending the path is what
    // makes this module's promise that "the reason names the field" true of
    // every issue rather than of most of them.
    const named = parsed.issues.map((issue) => {
      const path = v.getDotPath(issue);
      return path === null ? issue.message : `${path}: ${issue.message}`;
    });
    return {
      status: 'rejected',
      reason: `malformed sandbox lifecycle failure: ${named.join('; ')}`,
    };
  }
  const incident = parsed.output;

  // Read BEFORE writing: the answer this call gives depends on whether the
  // announcement had already landed, and the insert below would overwrite that.
  const before = readDeliveryState(deps.sql, incident.incidentId);
  // The clock starts at the FIRST report, not at this attempt: what is worth
  // measuring is how long the agent went without being told, and a re-delivery
  // that finally lands after four failures took the whole span, not the last
  // hop. Equal to `now` for an incident nobody has reported before, which is a
  // duration of zero rather than an unmeasured one.
  const firstSeenAt = before?.firstSeenAt ?? now;
  const recordSettlement = (outcome: RowOutcome, code: ErrorCode | ''): void => {
    deps.recordRecovery({
      stage: incident.stage,
      outcome,
      code,
      attempts: incident.attempts,
      durationMs: now - firstSeenAt,
    });
  };

  if (before !== null && before.announcedAt !== null && before.outcome !== null
    && before.outcome !== 'undelivered') {
    // `ok`, and deliberately: the agent HAS been told, which is what this seam
    // is for. A repeat is the container's retry loop being conservative about
    // an answer it may not have received, not a recovery that failed.
    recordSettlement('ok', '');
    deps.logActivity?.('sandbox_incident_duplicate', `${incident.stage} — ${incident.incidentId}`);
    // `queued` is the truth here and not a courtesy: this arm is reached only
    // when the row says the announcement HAS landed, so the caller may stop.
    return { status: 'queued', incidentId: incident.incidentId, duplicate: true };
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
  let outcome: SignalOutcome;
  try {
    outcome = await deps.signals.deliver(signal);
  } catch (cause) {
    // RECORDED AND RE-THROWN. The throw stands because the container's retry is
    // the documented recovery and answering it normally would tell the box its
    // incident had landed. But a delivery that broke is a failed recovery, and
    // it reaches the same seam a successful one does — with the class of
    // failure, which is the one arm on this path where a cause exists to
    // classify. The ledger row stays unannounced, so the retry is still safe.
    const error = toKinuError({
      doing: 'announcing a sandbox lifecycle failure to the agent',
      cause,
      otherwise: 'io',
    });
    recordSettlement('failed', error.code);
    throw error;
  }
  const landed = outcome !== 'undelivered';
  void deps.sql`UPDATE sandbox_lifecycle_incidents
    SET outcome = ${outcome}, announced_at = ${landed ? now : null}
    WHERE incident_id = ${incident.incidentId}`;
  // No code on either arm: the signal seam answers with an OUTCOME and holds no
  // cause, so `undelivered` is a fact about delivery and not a classified
  // failure. An invented code here would be the only unmeasured value on the row.
  recordSettlement(landed ? 'ok' : 'failed', '');
  deps.logActivity?.(
    landed ? 'sandbox_incident_announced' : 'sandbox_incident_undelivered',
    `${incident.stage} — ${incident.incidentId}`,
  );
  // The delivery outcome IS the answer. `announced_at` above and this status are
  // written from the same `landed`, so the ledger and the caller cannot diverge.
  return {
    status: landed ? 'queued' : 'undelivered',
    incidentId: incident.incidentId,
    duplicate: false,
  };
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
