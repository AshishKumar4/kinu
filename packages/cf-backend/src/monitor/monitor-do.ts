/**
 * MonitorDO — the singleton that owns synthetic monitoring's durable state.
 *
 * Why a Durable Object for three HTTP probes: the anti-fatigue guarantee is
 * memory ("this check already has an alert out"), and the send discipline is
 * the mission inbox's `EmailOutbox`, which is a SQLite table. A cron handler
 * has neither. One named instance holds both, and the scheduled handler is a
 * thin caller.
 *
 * Not an `Agent` subclass: this object has no chat, no tools and no
 * websockets, so it inherits none of the SDK surface `rpc-surface.ts` exists to
 * seal — its reachable surface is exactly the one method declared here, and
 * only the Worker holds its stub.
 */

import { DurableObject } from 'cloudflare:workers';
import { EmailOutbox } from '../email/outbox.js';
import { ensureMonitorSchema, recordProbeRun, type MonitorRunResult } from './incidents.js';
import { runSyntheticProbes } from './probes.js';

/** One instance, by name — site health is not per-user or per-workspace. */
export const MONITOR_SINGLETON = 'site';

export class MonitorDO extends DurableObject<Env> {
  private readonly outbox: EmailOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No retry timer: the cron tick IS the sweep, and it reconciles the outbox
    // every run — an alarm would be a second scheduler for the same job.
    this.outbox = new EmailOutbox(ctx.storage.sql);
    this.outbox.ensureSchema();
    ensureMonitorSchema(ctx.storage.sql);
  }

  /** Run every probe against the public origin and alert on what changed. */
  async check(now: number = Date.now()): Promise<MonitorRunResult> {
    const origin = this.env.CLI_PUBLIC_ORIGIN;
    if (!origin) {
      throw new Error('CLI_PUBLIC_ORIGIN is not configured; there is no origin to probe.');
    }
    const outcomes = await runSyntheticProbes({ origin, fetch: (input, init) => fetch(input, init) });
    return recordProbeRun({
      sql: this.ctx.storage.sql,
      outbox: this.outbox,
      email: this.env.EMAIL,
      emailDomain: this.env.EMAIL_DOMAIN,
      alertEmail: this.env.OPS_ALERT_EMAIL ?? null,
      origin,
      now,
    }, outcomes);
  }
}
