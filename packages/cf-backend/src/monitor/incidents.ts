/**
 * Incident ledger: a failing probe opens an incident (one alert), stays open silently, closes on pass (one recovery).
 * Delivery is `sendOwnerEmail` over `EmailOutbox`, which owns retries.
 */

import { argumentDigest, type SqlExec } from '@kinu.run/core';
import { sendOwnerEmail } from '../email/outbound';
import type { EmailOutbox } from '@kinu.run/core';
import type { ProbeOutcome } from '@kinu.run/core';
import * as v from 'valibot';

/** A dot is illegal in a workspace name, so this sender never collides with a mission inbox. */
const MONITOR_SENDER = 'ops.monitor';

const MONITOR_DISPLAY_NAME = 'Kinu Monitor';

const MONITOR_INCIDENTS_DDL = `
CREATE TABLE IF NOT EXISTS monitor_incidents (
  probe      TEXT    PRIMARY KEY,
  detail     TEXT    NOT NULL,
  opened_at  INTEGER NOT NULL,
  alerted_at INTEGER,
  failures   INTEGER NOT NULL DEFAULT 1,
  seen_at    INTEGER NOT NULL
)`;

interface IncidentRow {
  probe: string;
  detail: string;
  opened_at: number;
  alerted_at: number | null;
  failures: number;
}

const IncidentRowSchema = v.object({
  probe: v.string(),
  detail: v.string(),
  opened_at: v.number(),
  alerted_at: v.nullable(v.number()),
  failures: v.number(),
});

export interface MonitorRunResult {
  failing: string[];
  /** Newly opened incidents plus any whose earlier alert never got sent. */
  alerting: string[];
  recovered: string[];
  emails: number;
  skipped?: 'email not configured';
}

export interface MonitorDeps {
  sql: SqlExec;
  outbox: EmailOutbox;
  email: SendEmail | undefined;
  emailDomain: string | undefined;
  /** Unset leaves the monitor observing but silent. */
  alertEmail: string | null;
  origin: string;
  now: number;
}

export function ensureMonitorSchema(sql: SqlExec): void {
  sql.exec(MONITOR_INCIDENTS_DDL);
}

export async function recordProbeRun(deps: MonitorDeps, outcomes: ProbeOutcome[]): Promise<MonitorRunResult> {
  ensureMonitorSchema(deps.sql);
  const open = new Map(listIncidents(deps.sql).map((row) => [row.probe, row]));
  const failing = outcomes.filter((o) => !o.ok);
  const passing = outcomes.filter((o) => o.ok);

  for (const outcome of failing) {
    const existing = open.get(outcome.probe);

    if (existing) {
      // Still broken: record the latest state but never re-alert.
      deps.sql.exec(
        `UPDATE monitor_incidents SET detail = ?, failures = failures + 1, seen_at = ? WHERE probe = ?`,
        outcome.detail, deps.now, outcome.probe,
      );
    } else {
      deps.sql.exec(
        `INSERT INTO monitor_incidents (probe, detail, opened_at, alerted_at, failures, seen_at)
         VALUES (?, ?, ?, NULL, 1, ?)`,
        outcome.probe, outcome.detail, deps.now, deps.now,
      );
    }
  }

  const recovered = passing
    .map((outcome) => open.get(outcome.probe))
    .filter((row): row is IncidentRow => row !== undefined);

  const unalerted = listIncidents(deps.sql).filter((row) => row.alerted_at === null);

  const announced = recovered.filter((row) => row.alerted_at !== null);
  const canEmail = Boolean(deps.email && deps.emailDomain && deps.alertEmail);
  let emails = 0;

  if (canEmail) {
    if (unalerted.length > 0 && await send(deps, openedNotice(deps, unalerted))) {
      emails++;

      for (const row of unalerted) {
        deps.sql.exec(`UPDATE monitor_incidents SET alerted_at = ? WHERE probe = ?`, deps.now, row.probe);
      }
    }

    if (announced.length > 0 && await send(deps, recoveredNotice(deps, announced))) emails++;
  }

  for (const row of recovered) {
    deps.sql.exec(`DELETE FROM monitor_incidents WHERE probe = ?`, row.probe);
  }

  // Delivery retries belong to the outbox.
  if (deps.email) await deps.outbox.reconcile(deps.email, deps.now);

  const result: MonitorRunResult = {
    failing: failing.map((o) => o.probe),
    alerting: unalerted.map((row) => row.probe),
    recovered: recovered.map((row) => row.probe),
    emails,
  };

  if (!canEmail && (unalerted.length > 0 || announced.length > 0)) {
    result.skipped = 'email not configured';
  }

  return result;
}

export function listIncidents(sql: SqlExec): IncidentRow[] {
  ensureMonitorSchema(sql);

  return v.parse(v.array(IncidentRowSchema), sql.exec(
    `SELECT probe, detail, opened_at, alerted_at, failures FROM monitor_incidents ORDER BY opened_at`,
  ).toArray());
}

interface Notice { subject: string; text: string; key: string }

function openedNotice(deps: MonitorDeps, rows: IncidentRow[]): Notice {
  const [single] = rows;
  const what = rows.length === 1 && single !== undefined ? `${single.probe} is failing` : `${rows.length} checks are failing`;

  const body = [
    `${deps.origin} — synthetic monitoring found a problem.`,
    '',
    ...rows.map((row) => `• ${row.probe}: ${row.detail}`),
    '',
    'What this means for a user right now:',
    ...rows.map((row) => `• ${row.probe}: ${IMPACT.get(row.probe) ?? 'this check is part of the public surface.'}`),
    '',
    'Usual cause: a deploy that did not go through scripts/deploy.sh, which builds the',
    'CLI source archive into dist/client/downloads and re-runs these same checks before',
    'it will call a deploy good. Re-deploying through it is the first thing to try.',
    '',
    'This is the only email for these checks until they recover.',
  ].join('\n');

  return {
    subject: `Health: ${what}`,
    // Keyed on probe + opened_at so a retry of this alert is the same message.
    key: argumentDigest({ kind: 'opened', rows: rows.map((r) => [r.probe, r.opened_at]) }),
    text: body,
  };
}

function recoveredNotice(deps: MonitorDeps, rows: IncidentRow[]): Notice {
  const [single] = rows;
  const what = rows.length === 1 && single !== undefined ? `${single.probe} recovered` : `${rows.length} checks recovered`;

  return {
    subject: `Health: ${what}`,
    key: argumentDigest({ kind: 'recovered', rows: rows.map((r) => [r.probe, r.opened_at]) }),
    text: [
      `${deps.origin} — the checks below are passing again.`,
      '',
      ...rows.map((row) => `• ${row.probe}: was failing for ${duration(deps.now - row.opened_at)}`
        + ` across ${row.failures} check${row.failures === 1 ? '' : 's'}`),
    ].join('\n'),
  };
}

const IMPACT = new Map([
  ['health', 'the API is down, or the worker and its assets are from different deploys.'],
  ['downloads', 'a new install and every `kinu update` fail on the checksum.'],
  ['login', 'nobody can sign in to the web app.'],
]);

async function send(deps: MonitorDeps, notice: Notice): Promise<boolean> {
  return sendOwnerEmail({
    email: deps.email,
    emailDomain: deps.emailDomain,
    agentName: MONITOR_SENDER,
    agentDisplayName: MONITOR_DISPLAY_NAME,
    ownerEmail: deps.alertEmail,
    outbox: deps.outbox,
  }, notice);
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);

  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;

  return `${Math.round(hours / 24)} days`;
}
