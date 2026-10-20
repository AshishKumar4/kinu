/**
 * Singleton owning synthetic monitoring's durable state: the incident memory and the SQLite `EmailOutbox`.
 * Not an `Agent` subclass: its reachable surface is exactly the methods declared here, and only the Worker holds its stub.
 */

import { Effect } from 'effect';
import { DurableObject } from 'cloudflare:workers';
import { EmailOutbox } from '@kinu.run/core';
import { initSignalStreaksTable, sampleFleet, settleFleet, type MonitorIncident } from '@kinu.run/core/control-plane';
import {
  declaredSignInProviders, durableStamps, ensureMonitorSchema, listIncidents, plainFetch, readStamp, recordProbeRun, repairSchema, runSyntheticProbes,
  SCHEMA_TABLES, writeStamp, type MonitorRunResult,
} from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { openAnalyticsWindow } from '@kinu.run/core/analytics';
import { KinuError, settle } from '@kinu.run/core/obs';
import { listConfiguredOAuthProviders } from '../auth/providers';

export const MONITOR_SINGLETON = 'site';


export class MonitorDO extends DurableObject<Env> {
  private readonly outbox: EmailOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const stamps = durableStamps(ctx.storage.kv);
    const unmade = readStamp(stamps, ctx.storage.sql, 'monitor') === 'unmade';
    const init = (): void => { ensureMonitorSchema(ctx.storage.sql); initSignalStreaksTable(ctx.storage.sql); };

    // Its tables, reset where a release changed them (core state/schema-repair.ts). With no foreign keys among them, a
    // reset refuses only where its init cannot run, and then the init below refuses every call in SQLite's words.
    repairSchema(ctx.storage.sql, {
      schema: 'monitor', tables: SCHEMA_TABLES.monitor, stamps, transactionSync: (write) => ctx.storage.transactionSync(write), init,
    }, 'monitor');
    init();

    if (unmade) writeStamp(stamps, 'monitor');
    // No retry timer: the cron tick is the sweep and reconciles the outbox every run.
    this.outbox = new EmailOutbox(ctx.storage.sql);
    // Own isolate, own sink (see `ActorAgent`'s constructor); without it outbox failures reach no dataset.
    installAnalyticsDiagnostics(env);
  }

  /**
   * Run every probe against the public origin and alert on what changed.
   * Opens the analytics write window: the budget is per invocation, the constructor's install is per activation.
   */
  check(): Promise<MonitorRunResult> {
    return settle(Effect.gen({ self: this }, function* () {
      openAnalyticsWindow(this.env);
      const now = Date.now();
      const origin = this.env.CLI_PUBLIC_ORIGIN;

      if (!origin) {
        return yield* new KinuError('unavailable', 'CLI_PUBLIC_ORIGIN is not configured; there is no origin to probe.');
      }

      const probes = yield* Effect.promise(async () => runSyntheticProbes({
        origin,
        fetch: plainFetch(fetch),
        signIn: {
          declared: declaredSignInProviders(this.env.SIGN_IN_PROVIDERS),
          configured: listConfiguredOAuthProviders(this.env).map((provider) => provider.id),
        },
      }));

      const fleet = yield* Effect.promise(async () => sampleFleet(this.env, now, (input, init) => fetch(input, init)));
      const open = new Map(listIncidents(this.ctx.storage.sql).map((row) => [row.probe, row.detail]));
      const outcomes = [...probes, ...settleFleet(this.ctx.storage.sql, fleet, open)];

      return yield* Effect.promise(async () => recordProbeRun({
        sql: this.ctx.storage.sql,
        outbox: this.outbox,
        email: this.env.EMAIL,
        emailDomain: this.env.EMAIL_DOMAIN,
        alertEmail: this.env.OPS_ALERT_EMAIL ?? null,
        origin,
        now,
      }, outcomes));
    }));
  }

  /**
   * Open incidents for the admin control plane; read-only. Ungated like `check()`: the operator gate lives in
   * `control-plane/routes.ts`. Bounded because the caller is a browser list.
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
