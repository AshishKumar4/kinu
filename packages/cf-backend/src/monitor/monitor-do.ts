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
import { EmailOutbox } from '../email/outbox';
import { ensureMonitorSchema, listIncidents, recordProbeRun, type MonitorRunResult } from './incidents';
import { runSyntheticProbes } from './probes';
import { installAnalyticsDiagnostics } from '../analytics/install';
import { openAnalyticsWindow } from '../analytics/writer';

/** One instance, by name — site health is not per-user or per-workspace. */
export const MONITOR_SINGLETON = 'site';

/** One open incident, in the shape that crosses the RPC boundary. The ledger's
 *  own row is snake_case SQL; this is the camelCase projection an admin list
 *  renders, declared here because this class is its only producer. */
export interface MonitorIncident {
  probe: string;
  detail: string;
  openedAt: number;
  /** When the alert for this incident went out, or null when it is still owed. */
  alertedAt: number | null;
  failures: number;
}

export class MonitorDO extends DurableObject<Env> {
  private readonly outbox: EmailOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No retry timer: the cron tick IS the sweep, and it reconciles the outbox
    // every run — an alarm would be a second scheduler for the same job.
    this.outbox = new EmailOutbox(ctx.storage.sql);
    ensureMonitorSchema(ctx.storage.sql);
    // Its own isolate, so its own sink — see `ActorAgent`'s constructor. The
    // outbox failures this DO's own mail produces are counted through the
    // diagnostics seam, and without this they reach Workers Logs and no dataset.
    installAnalyticsDiagnostics(env);
  }

  /**
   * Run every probe against the public origin and alert on what changed.
   *
   * Opens the analytics write window, as does every other RPC on this class: the
   * platform's 250-point budget is per INVOCATION, and the constructor's install
   * opens one per ACTIVATION — so a hot monitor stopped counting its own outbox
   * failures and said nothing about it.
   */
  async check(now: number = Date.now()): Promise<MonitorRunResult> {
    openAnalyticsWindow(this.env);
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

  /**
   * The open incidents, for the admin control plane.
   *
   * The ledger has always existed and has never had a reader: an outage was
   * observable only as email, so an operator who missed the mail had no way to
   * ask what is currently red. This is that read and nothing more — it takes no
   * argument that could change state and it cannot open, close or alert.
   *
   * Ungated, exactly like `check()`: this object has no capability scheme, its
   * stub is held only by the Worker, and the authorization that matters is the
   * operator gate in `control-plane/routes.ts`. Adding a second capability
   * system here would be a parallel one.
   *
   * Bounded because the caller is a browser list. One row per probe means the
   * bound is never reached today, which is the right time to state it.
   */
  async listIncidents(limit = 100): Promise<MonitorIncident[]> {
    openAnalyticsWindow(this.env);
    return listIncidents(this.ctx.storage.sql)
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map((row) => ({
        probe: row.probe,
        detail: row.detail,
        openedAt: row.opened_at,
        alertedAt: row.alerted_at,
        failures: row.failures,
      }));
  }
}
