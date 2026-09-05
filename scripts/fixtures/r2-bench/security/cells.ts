/**
 * Driver side of the live G4 security fault cells.
 *
 * The cells themselves run inside the benchmark fixture
 * (`packages/devbox/bench/security-cells.ts` via `POST /security`): real
 * product controls, real bucket and Durable Object storage, strictly inside
 * an isolated per-call namespace. This module is the driver's half — fetch
 * one arm's observation, and fold per-arm observations into the run-level
 * {@link SecurityEvidence} the shared G4 gate judges.
 *
 * Only the fixture secret (BENCH_TOKEN) ever travels here, as the Bearer
 * credential this run created for its own fixture. Account credentials are
 * never read, never sent, never copied: there is no code path in this module
 * that touches one.
 */

import * as v from 'valibot';

import {
  findCredentialLeaks,
  type SecurityEvidence,
} from '../../storage-matrix/admission';

/** The arms the security cells cover. Anything else reports unable. */
export const SECURITY_STRATEGIES = ['snapshot-chain', 'bounded-layers', 'merkle-pack'] as const;
export type SecurityStrategy = (typeof SECURITY_STRATEGIES)[number];

export type SecurityCellId = 'F7' | 'F10' | 'F11' | 'F12';
export type SecurityCellStatus = 'refused' | 'accepted' | 'unable';

export interface SecurityCellResult {
  readonly id: SecurityCellId;
  readonly status: SecurityCellStatus;
  readonly detail: string;
}

export interface SecurityCellsObservation {
  readonly strategy: string;
  readonly completed: boolean;
  readonly cells: readonly SecurityCellResult[];
  readonly staleWriterAccepted: boolean;
  readonly hostileMetadataAccepted: boolean;
  readonly prefixEscapes: number;
  readonly capabilityEscapesOrReplays: number;
  /** Descriptions only — the fixture never sends a secret value. */
  readonly credentialLeaks: readonly string[];
  /** Isolated-namespace cleanup the fixture recorded; G8 owns it. */
  readonly cleanupErrors: readonly string[];
}
const SecurityCellSchema = v.looseObject({
  id: v.picklist(['F7', 'F10', 'F11', 'F12']),
  status: v.picklist(['refused', 'accepted', 'unable']),
  detail: v.string(),
});

const SecurityCellsObservationSchema = v.looseObject({
  strategy: v.string(),
  completed: v.boolean(),
  cells: v.array(SecurityCellSchema),
  staleWriterAccepted: v.boolean(),
  hostileMetadataAccepted: v.boolean(),
  prefixEscapes: v.number(),
  capabilityEscapesOrReplays: v.number(),
  credentialLeaks: v.array(v.string()),
  cleanupErrors: v.array(v.string()),
});

/** The fixture's `POST /security` answer. Loose: new fields ride along. */
export const SecurityCellsReplySchema = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
  strategy: v.optional(v.string()),
  box: v.optional(v.string()),
  security: v.optional(SecurityCellsObservationSchema),
  ms: v.optional(v.number()),
});
export type SecurityCellsReply = v.InferOutput<typeof SecurityCellsReplySchema>;

export interface SecurityFixture {
  readonly origin: string;
  readonly token: string;
}

/**
 * Arms the security cells never run, and the reason for each. Read by
 * {@link summarizeSecurity}: an exclusion without prose, or an arm silently
 * added to it, fails the decision suite the same way the fault-cut table
 * does. r2fs syncs per-close uploads with no epoch, envelope, or grant to
 * attack; overlay-cas folds a journal with no candidate control identity.
 * Cutting either would fail an honest arm for lacking a property its
 * strategy refuses to offer — so they report unable and the gate refuses.
 */
const SECURITY_EXCLUDED = {
  r2fs: 'r2fs publishes no writer epoch, envelope, or capability grant. Its checkpoint is a sync over per-close s3fs uploads, so a stale-writer fence, a hostile-metadata digest binding, and a grant escape/replay surface do not exist to attack. Probing them would fail an honest arm for lacking properties its strategy refuses to offer.',
  'overlay-cas': 'overlay-cas publishes no candidate epoch, envelope, or grant. Its checkpoint stages blobs and appends journal batches under a folded cursor, so the candidate stale-writer fence and the envelope/grant bindings do not exist to attack. Probing them would fail an honest arm for lacking properties its strategy refuses to offer.',
} satisfies Partial<Record<string, string>>;

export function securityExclusion(strategy: string): string | undefined {
  switch (strategy) {
    case 'r2fs':
      return SECURITY_EXCLUDED.r2fs;
    case 'overlay-cas':
      return SECURITY_EXCLUDED['overlay-cas'];
    default:
      return undefined;
  }
}

/** A nonce that doubles as the fixture's isolated namespace id. */
export function securityNonce(): string {
  return `sec-${crypto.randomUUID()}`;
}

function issueText(issues: readonly v.GenericIssue[]): string {
  return issues.map((issue) => issue.message).join('; ').slice(0, 300);
}

/**
 * Fetch one arm's live observation. One attempt with an explicit deadline:
 * the caller wraps this in its own transient retry, the same way every other
 * fixture probe is wrapped. Throws carrying the wire's own words when the
 * reply disagrees with its contract — a benchmark that defaults a missing
 * security number goes on to publish it.
 */
export async function runSecurityFaultCells(
  fixture: SecurityFixture,
  box: string,
  strategy: string,
  nonce: string,
  timeoutMs = 120_000,
): Promise<{ observation: SecurityCellsObservation; notes: string[] }> {
  const path = `/security?box=${encodeURIComponent(box)}`;
  const response = await fetch(`${fixture.origin}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ strategy, op: nonce }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`POST ${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`, { cause: error });
  }
  const parsed = v.safeParse(SecurityCellsReplySchema, decoded);
  if (!parsed.success) {
    throw new Error(
      `POST ${path} (${response.status}) does not match its reply contract: `
      + `${issueText(parsed.issues)}\n${text.slice(0, 300)}`,
    );
  }
  const reply = parsed.output;
  if (reply.ok !== true || reply.security === undefined) {
    throw new Error(`POST ${path} refused the security cells (${response.status}): ${(reply.error ?? text).slice(0, 240)}`);
  }
  const observation = reply.security;
  const notes = observation.cells.map((cell) => `security ${cell.id}: ${cell.status} — ${cell.detail.slice(0, 160)}`);
  return { observation, notes };
}

/**
 * Fold one observation per arm into the run-level security block. Strict in
 * the only direction that keeps G4 honest:
 *
 * - `securityCellsComplete` holds only when every non-excluded arm produced
 *   an observation whose every cell REFUSED its attack. An `unable` cell is
 *   not a refusal: it leaves the block incomplete so the gate refuses rather
 *   than admitting on untested zeros.
 * - Escape/accept flags are sticky: one accepted stale writer, hostile
 *   metadata, prefix escape, capability escape/replay, or credential leak
 *   anywhere in the cuttable set fails the run.
 * - `credentialLeaks` carries descriptions only. The worker's F12 rows plus
 *   the driver-side scan over the run's own serialized output both land
 *   here; neither ever carries a secret value.
 * - `cleanupErrors` rides the wire for the report but stays out of the
 *   verdict: isolated-namespace cleanup is G8's, and a purge failure must
 *   not read as a security finding.
 */
export function summarizeSecurity(input: {
  readonly rows: ReadonlyArray<{ readonly strategy: string; readonly observation: SecurityCellsObservation | null }>;
  readonly token: string;
  readonly driverText: string;
}): SecurityEvidence {
  const cuttable = input.rows.filter((row) => securityExclusion(row.strategy) === undefined);
  const observations = cuttable.map((row) => row.observation);
  const completed = cuttable.length > 0
    && observations.every((observation) => observation !== null && observation.completed);
  let prefixEscapes = 0;
  let capabilityEscapesOrReplays = 0;
  let staleWriterAccepted = false;
  let hostileMetadataAccepted = false;
  const credentialLeaks: string[] = [];
  for (const observation of observations) {
    if (observation === null) continue;
    prefixEscapes += observation.prefixEscapes;
    capabilityEscapesOrReplays += observation.capabilityEscapesOrReplays;
    staleWriterAccepted = staleWriterAccepted || observation.staleWriterAccepted;
    hostileMetadataAccepted = hostileMetadataAccepted || observation.hostileMetadataAccepted;
    credentialLeaks.push(...observation.credentialLeaks);
  }
  credentialLeaks.push(...findCredentialLeaks(input.driverText, [input.token]));
  return {
    credentialLeaks,
    securityCellsComplete: completed,
    prefixEscapes,
    capabilityEscapesOrReplays,
    staleWriterAccepted,
    hostileMetadataAccepted,
  };
}
