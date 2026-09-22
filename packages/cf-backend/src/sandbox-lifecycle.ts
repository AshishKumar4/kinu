/**
 * Sandbox lifecycle failures, announced to the agent through the inbox. The ledger, keyed by
 * `incidentId` and written before delivery, makes it exactly-once: announced incidents are answered
 * from the row, undelivered ones re-delivered. The reason is not scrubbed; the sandbox must put no secrets there.
 * `waitUntil` is a no-op in a DO, so ledger write and delivery run inside the answering invocation.
 */

import * as v from 'valibot';
import type { IncidentStage } from '@kinu.run/devbox';
// Pure subpath: the barrel loads `cloudflare:workers`, which exists only under workerd.
import { INCIDENT_REASON_MAX_CHARS } from '@kinu.run/devbox/incidents';
import { toKinuError } from '@kinu.run/core/obs';
import type { ErrorCode } from '@kinu.run/core/obs';
import type { RecoveryRowInput, RowOutcome } from '@kinu.run/core/analytics';
import type {
  AgentSignal, JsonObject, JsonValue, RawSqlExec, AgentInbox, SendOutcome,
  SqlExecutor,
} from '@kinu.run/core';

const MAX_REASON_CHARS = INCIDENT_REASON_MAX_CHARS;

const SANDBOX_LIFECYCLE_SIGNAL_KIND = 'sandbox_lifecycle_failure';

/** Keyed by devbox's `IncidentStage` so the compiler rejects a missing or invented stage. */
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

function isIncidentStage(name: string): name is IncidentStage {
  return name in STAGE_CONSEQUENCE;
}

const STAGE_KEYS: readonly IncidentStage[] = Object.keys(STAGE_CONSEQUENCE).filter(isIncidentStage);

const SANDBOX_LIFECYCLE_STAGES = STAGE_KEYS;

export type SandboxLifecycleStage = IncidentStage;

/** Required `attempts` cannot be derived here, so older envelopes are refused, never defaulted. */
export const SANDBOX_LIFECYCLE_ENVELOPE_VERSION = 2;

const SandboxLifecycleFailureSchema = v.strictObject({
  version: v.literal(SANDBOX_LIFECYCLE_ENVELOPE_VERSION),
  incidentId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** The producer's delivery count (first is 1); never stored here. */
  attempts: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stage: v.picklist(SANDBOX_LIFECYCLE_STAGES),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REASON_CHARS)),
  processId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
});

export type SandboxLifecycleFailure = v.InferOutput<typeof SandboxLifecycleFailureSchema>;

/**
 * The only delivery verdict: `status` uses devbox's `IncidentDisposition` verbatim, so the box and
 * this ledger cannot disagree about whether an announcement landed.
 */
export type SandboxLifecycleFailureResult =
  | {
    /** `undelivered`: the row stays unannounced and the caller must offer it again. */
    readonly status: 'queued' | 'undelivered';
    readonly incidentId: string;
    readonly duplicate: boolean;
  }
  | { readonly status: 'rejected'; readonly reason: string };

function sandboxLifecycleIncidentKey(incidentId: string): string {
  return `sandbox-lifecycle:${incidentId}`;
}

/**
 * Identity and delivery state only; the announcement itself is already durable as a chat row.
 * Declared `sandbox_lifecycle_incidents` for `cf-orchestrator` in core's conformance manifest.
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

/** A stored outcome outside the vocabulary is a corrupt row and throws. */
function readDeliveryState(
  sql: SqlExecutor, incidentId: string,
): {
  readonly firstSeenAt: number;
  readonly announcedAt: number | null;
  readonly outcome: SendOutcome | null;
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
  readonly inbox: AgentInbox;
  /** Required: an absent instrument looks exactly like a quiet fleet. */
  readonly recordRecovery: (row: Omit<RecoveryRowInput, 'workspace'>) => void;
  readonly logActivity?: (event: string, detail?: string) => void;
}

/** `body` crossed a DO RPC boundary; this is its parse boundary. `rejected` is a caller bug, not transient. */
export async function acceptSandboxLifecycleFailure(
  deps: SandboxLifecycleDeps,
  body: JsonValue,
  now: number,
): Promise<SandboxLifecycleFailureResult> {
  const parsed = v.safeParse(SandboxLifecycleFailureSchema, body);

  if (!parsed.success) {
    // `refused`, not `failed`: `bad_input` is a refusal (core's CODE_IS_REFUSAL).
    deps.recordRecovery({
      stage: '', outcome: 'refused', code: 'bad_input', attempts: 0, durationMs: 0,
    });

    // Prefix the path: a value mismatch (e.g. the version) does not name its field.
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

  // Read before the insert, which would overwrite it.
  const before = readDeliveryState(deps.sql, incident.incidentId);
  // Duration spans from the first report: how long the agent went untold.
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
    // `ok`: the agent has been told; a repeat is the container's conservative retry.
    recordSettlement('ok', '');
    deps.logActivity?.('sandbox_incident_duplicate', `${incident.stage} — ${incident.incidentId}`);

    return { status: 'queued', incidentId: incident.incidentId, duplicate: true };
  }

  // Row lands before delivery so a lost delivery stays re-deliverable; `first_seen_at` is written once.
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
    // Without it `inbox.send` is non-idempotent and a re-delivery lands as a second message.
    idempotencyKey: sandboxLifecycleIncidentKey(incident.incidentId),
  };

  let outcome: SendOutcome;

  try {
    outcome = await deps.inbox.send(signal);
  } catch (cause) {
    // Re-thrown so the container retries; the row stays unannounced, so the retry is safe.
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
  // No code: the signal seam returns an outcome, not a classifiable cause.
  recordSettlement(landed ? 'ok' : 'failed', '');
  deps.logActivity?.(
    landed ? 'sandbox_incident_announced' : 'sandbox_incident_undelivered',
    `${incident.stage} — ${incident.incidentId}`,
  );

  return {
    status: landed ? 'queued' : 'undelivered',
    incidentId: incident.incidentId,
    duplicate: false,
  };
}

function incidentWhere(incident: SandboxLifecycleFailure): string {
  if (incident.processId !== undefined) return ` (process ${incident.processId})`;

  if (incident.port !== undefined) return ` (port ${String(incident.port)})`;

  return '';
}

function incidentText(incident: SandboxLifecycleFailure): string {
  const where = incidentWhere(incident);

  return `The workspace container failed at the ${incident.stage} stage${where}. `
    + `${STAGE_CONSEQUENCE[incident.stage]}\n\n`
    + `Reported cause: ${incident.reason}\n`
    + `Incident id: ${incident.incidentId}`;
}
