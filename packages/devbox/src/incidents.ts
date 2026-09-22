/** Incident ledger: a failure is stored before delivery. A thrown delivery retries with backoff;
 *  a `rejected` one is frozen, which is safe only while both sides share `INCIDENT_STAGES`. */

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

/** Exported because the cf host truncates to this bound before its schema,
 *  so producer and validator cannot drift. */
export const INCIDENT_REASON_MAX_CHARS = 2_000;

export interface IncidentRow extends DevboxIncident {
  readonly attempts: number;
  readonly deliveredAt?: number;
  readonly rejectedAt?: number;
}

/** Caps the ledger: a failing box records an incident per retry and every pass reads all rows.
 *  Only settled rows are reaped, oldest first; pending rows are never dropped. */
export const INCIDENT_LEDGER_MAX_ROWS = 100;

export interface IncidentStore {
  get(key: string): Promise<IncidentRow | undefined>;
  put(key: string, value: IncidentRow): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: { prefix: string }): Promise<Map<string, IncidentRow>>;
}

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

/** Returns the delay until the next pass, or `null` when nothing is undelivered;
 *  then nothing wakes, and the next `recordIncident` starts a chain again. */
export async function deliverIncidents(
  store: IncidentStore,
  deliver: (incident: DevboxIncident, attempt: number) => Promise<IncidentDisposition>,
): Promise<number | null> {
  const rows = await store.list({ prefix: INCIDENT_PREFIX });
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
      // `row.attempts` is only incremented after the handler returns, so this delivery's ordinal is
      // `+ 1`: the host needs the ordinal of the announcement it is making.
      }, row.attempts + 1);
    } catch (error) {
      // A thrown handler is `undelivered` per the disposition contract, so it takes the same path.
      // The error is logged here because nothing downstream sees it.
      console.error(
        `[devbox] incident ${row.incidentId} was not delivered, retrying: `
        + describe({ cause: error }),
      );
      disposition = 'undelivered';
    }

    if (disposition === 'undelivered') {
      // An `undelivered` row must not get `deliveredAt`: the host still holds it re-deliverable,
      // so the row stays pending, the attempt is counted, and the schedule retries.
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

  await reapDeliveredIncidents(store);

  return nextDelayMs === undefined ? null : Math.max(1, Math.ceil(nextDelayMs / 1000));
}

/** Reaps settled rows oldest-settled first; a pending row is never reaped, so a host
 *  slow to accept loses nothing it has not seen. */
export async function reapDeliveredIncidents(store: IncidentStore): Promise<number> {
  const rows = await store.list({ prefix: INCIDENT_PREFIX });

  const settled = [...rows.entries()]
    .filter(([, row]) => row.deliveredAt !== undefined || row.rejectedAt !== undefined)
    .sort(([, a], [, b]) => (a.deliveredAt ?? a.rejectedAt ?? a.at)
      - (b.deliveredAt ?? b.rejectedAt ?? b.at));

  const excess = rows.size - Math.max(0, INCIDENT_LEDGER_MAX_ROWS);

  if (excess <= 0) return 0;

  for (const [key] of settled.slice(0, excess)) await store.delete(key);

  return excess;
}

/** Ledger totals for a box's own report. A growing `undelivered` count means the host
 *  is not listening. */
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
