/**
 * The incident ledger: a lifecycle failure is written down BEFORE anyone is
 * told, and delivery retries until the host accepts it.
 *
 * Its own module because it is its own subject. The class it came from is about
 * a container's lifecycle; this is a durable outbox with a retry policy and
 * three terminal states, and none of that needs a container. Here it is also
 * reachable from a test, which it was not while it lived on a Durable Object.
 *
 * THE THREE STATES, and why a rejection is not a retry:
 *
 *   Accepted (`queued`) — marked delivered, kept readable.
 *   Refused (`rejected`) — the host says the SHAPE is wrong. That is a defect in
 *   the producer, and no number of retries fixes a defect, so the row is frozen.
 *   Thrown — the host could not be reached, or failed while trying. That is
 *   transient, so the row keeps its place and the next pass is armed with the
 *   next backoff step.
 *
 * The rejection arm is only safe while the two sides share ONE stage
 * vocabulary. They did not, once: the container emitted `attach` and
 * `checkpoint`, the host's schema admitted neither, and every restore failure
 * and checkpoint failure was frozen here as a caller defect and never seen.
 * `INCIDENT_STAGES` is that one vocabulary.
 */

import {
  describeThrown as describe,
  incidentRetryDelayMs,
  type DevboxIncident,
  type IncidentDisposition,
  type IncidentStage,
} from './lifecycle';

/** One namespace, so a host's own keys cannot collide with these and a reader
 *  can tell at a glance which rows belong to the box machinery. */
export const INCIDENT_PREFIX = 'devbox:incident:';

/** Longest reason a row may carry. Past this it is not a reason, it is a
 *  payload wearing one. Exported: the cf host truncates to the same bound
 *  before its schema, so producer and validator cannot drift. */
export const INCIDENT_REASON_MAX_CHARS = 2_000;

/** An incident as stored: the incident plus its delivery state. */
export interface IncidentRow extends DevboxIncident {
  readonly attempts: number;
  readonly deliveredAt?: number;
  readonly rejectedAt?: number;
}

/** The durable rows this module reads and writes. Narrowed to the four
 *  operations it uses, so a caller can see the whole reach at a glance. */
export type IncidentStore = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;

/** Durable BEFORE anyone is told. An eviction between recording and delivering
 *  loses nothing, because delivery is itself a schedule row. */
export async function recordIncident(
  store: IncidentStore,
  stage: IncidentStage,
  reason: string,
  extra?: { readonly processId?: string; readonly port?: number },
): Promise<void> {
  const incidentId = crypto.randomUUID();
  await store.put(`${INCIDENT_PREFIX}${incidentId}`, {
    incidentId,
    stage,
    reason: reason.slice(0, INCIDENT_REASON_MAX_CHARS),
    processId: extra?.processId,
    port: extra?.port,
    at: Date.now(),
    attempts: 0,
  } satisfies IncidentRow);
}

/**
 * One delivery pass over the ledger.
 *
 * Answers the seconds until the next pass, or `null` when nothing is left
 * undelivered — there is then nothing to wake for, and the next `recordIncident`
 * is what starts a chain again.
 */
export async function deliverIncidents(
  store: IncidentStore,
  deliver: (incident: DevboxIncident) => Promise<IncidentDisposition>,
): Promise<number | null> {
  const rows = await store.list<IncidentRow>({ prefix: INCIDENT_PREFIX });
  let nextDelayMs: number | undefined;
  for (const [key, row] of rows) {
    if (row.deliveredAt !== undefined || row.rejectedAt !== undefined) continue;
    let disposition: IncidentDisposition;
    try {
      disposition = await deliver({
        incidentId: row.incidentId,
        stage: row.stage,
        reason: row.reason,
        processId: row.processId,
        port: row.port,
        at: row.at,
      });
    } catch (error) {
      // The reason is recorded here because nothing downstream will see it.
      console.error(
        `[devbox] incident ${row.incidentId} was not delivered, retrying: `
        + describe({ cause: error }),
      );
      nextDelayMs = incidentRetryDelayMs(row.attempts + 1);
      await store.put(key, { ...row, attempts: row.attempts + 1 });
      continue;
    }
    await store.put(key, {
      ...row,
      attempts: row.attempts + 1,
      ...(disposition === 'queued' ? { deliveredAt: Date.now() } : { rejectedAt: Date.now() }),
    });
  }
  return nextDelayMs === undefined ? null : Math.max(1, Math.ceil(nextDelayMs / 1000));
}

/** What the ledger holds, for a box's own report. `undelivered` is the number
 *  that matters: a box whose incidents are piling up is a box whose host is not
 *  listening. */
export interface IncidentTotals {
  total: number;
  undelivered: number;
}

export function incidentTotals(rows: Iterable<IncidentRow>): IncidentTotals {
  let total = 0;
  let undelivered = 0;
  for (const row of rows) {
    total += 1;
    if (row.deliveredAt === undefined && row.rejectedAt === undefined) undelivered += 1;
  }
  return { total, undelivered } satisfies IncidentTotals;
}
