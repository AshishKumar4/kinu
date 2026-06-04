/**
 * TriggerRegistry — owns the durable subscriptions that produce events:
 *
 *   webhook_durable   — operator-created, stable URL, durable beyond agent restart
 *   webhook_ephemeral — LLM-created, TTL-bounded
 *   timer_oneshot     — single alarm
 *   timer_cron        — recurring (UTC cron expression)
 *   process_watch     — sandbox process lifecycle
 *   file_watch        — sandbox FS change
 *   peer_inbox        — accepting peer-agent messages
 *   mcp_route         — agent's MCP server route
 *
 * Lifecycle (per §9 of the spec):
 *
 *   creation  — `register()`; writes a `triggers` row, schedules alarm if applicable
 *   fork      — defaults per-kind; overridable per-trigger via `fork_policy`
 *   archive   — `pauseAll()`; rows transition `state='paused'`; alarms become no-ops
 *   delete    — `revokeAll()`; rows transition `state='revoked'`; alarms cleared
 *
 * Fork policies (per-kind default):
 *
 *   webhook_durable   sever  (URL stays with parent; child has none)
 *   webhook_ephemeral sever
 *   timer_oneshot     sever
 *   timer_cron        copy   (both fire independently)
 *   process_watch     share  (both observe the same sandbox)
 *   file_watch        share
 *   peer_inbox        copy   (each agent has its own inbox)
 *   mcp_route         sever  (child has no MCP exposure)
 */

import {
  type TriggerId, type TriggerKind, type TriggerRow, type TrustLevel,
} from './types.js';
import { ulid } from './ulid.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

export type ForkPolicy = 'copy' | 'sever' | 'share';

export const DEFAULT_FORK_POLICY: Record<TriggerKind, ForkPolicy> = {
  webhook_durable:   'sever',
  webhook_ephemeral: 'sever',
  timer_oneshot:     'sever',
  timer_cron:        'copy',
  process_watch:     'share',
  file_watch:        'share',
  peer_inbox:        'copy',
  mcp_route:         'sever',
};

export interface RegisterSpec {
  kind: TriggerKind;
  spec: Record<string, unknown>;
  creator_trust: TrustLevel;
  fork_policy?: ForkPolicy;
  rate_limit_per_min?: number;
  next_fire_at?: number;
}

export interface AlarmScheduler {
  /** Ask the DO to wake at this time (or earlier). Idempotent — multiple
   *  calls converge on the soonest pending time. */
  scheduleAt(ts: number): void;
  /** Current scheduled alarm time, or null if none. */
  currentAlarm(): number | null;
}

export class TriggerRegistry {
  constructor(
    private readonly sql: SqlExec,
    private readonly alarm: AlarmScheduler,
  ) {}

  /** Create a new trigger. Returns the trigger id. */
  register(spec: RegisterSpec, now: number): TriggerId {
    const id = ulid();
    const fp = spec.fork_policy ?? null;
    this.sql.exec(
      `INSERT INTO triggers
         (id, kind, spec, creator_trust, fork_policy, state, rate_limit_per_min,
          created_at, paused_at, revoked_at, next_fire_at, last_fire_at, fire_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, NULL, 0)`,
      id, spec.kind, JSON.stringify(spec.spec), spec.creator_trust, fp,
      spec.rate_limit_per_min ?? 60, now, spec.next_fire_at ?? null,
    );
    if (spec.next_fire_at) this.alarm.scheduleAt(spec.next_fire_at);
    return id;
  }

  get(id: TriggerId): TriggerRow | null {
    const rows = this.sql.exec(
      `SELECT id, kind, spec, creator_trust, fork_policy, state, rate_limit_per_min,
              created_at, paused_at, revoked_at, next_fire_at, last_fire_at, fire_count
       FROM triggers WHERE id = ?`, id,
    ).toArray() as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return rowToTrigger(rows[0]);
  }

  list(filter?: { kind?: TriggerKind; state?: 'active' | 'paused' | 'revoked' }): TriggerRow[] {
    let sql = `SELECT id, kind, spec, creator_trust, fork_policy, state,
                      rate_limit_per_min, created_at, paused_at, revoked_at,
                      next_fire_at, last_fire_at, fire_count
               FROM triggers WHERE 1=1`;
    const bindings: unknown[] = [];
    if (filter?.kind) { sql += ` AND kind = ?`; bindings.push(filter.kind); }
    if (filter?.state) { sql += ` AND state = ?`; bindings.push(filter.state); }
    sql += ` ORDER BY created_at DESC`;
    const rows = this.sql.exec(sql, ...bindings).toArray() as Array<Record<string, unknown>>;
    return rows.map(rowToTrigger);
  }

  /** Mark a trigger paused (e.g. agent archived). Alarm firings check
   *  `state` in the same transaction as alarm processing and silently
   *  drop if paused. Returns true if state changed. */
  pause(id: TriggerId, now: number): boolean {
    const before = this.get(id);
    if (!before || before.state !== 'active') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'paused', paused_at = ? WHERE id = ?`,
      now, id,
    );
    return true;
  }

  /** Resume a paused trigger. Does NOT backfill missed alarm firings —
   *  `paused_at` defines the "missed window" that's gone. */
  resume(id: TriggerId, now: number): boolean {
    const before = this.get(id);
    if (!before || before.state !== 'paused') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'active', paused_at = NULL WHERE id = ?`, id,
    );
    // Re-schedule the trigger if it has a next_fire_at in the future.
    const fire = this.sql.exec(
      `SELECT next_fire_at FROM triggers WHERE id = ?`, id,
    ).toArray() as Array<{ next_fire_at: number | null }>;
    if (fire[0]?.next_fire_at && fire[0].next_fire_at > now) {
      this.alarm.scheduleAt(fire[0].next_fire_at);
    }
    return true;
  }

  /** Pause every active trigger (agent archive). */
  pauseAll(now: number): number {
    const before = this.list({ state: 'active' }).length;
    this.sql.exec(
      `UPDATE triggers SET state = 'paused', paused_at = ? WHERE state = 'active'`, now,
    );
    return before;
  }

  /** Resume every paused trigger (agent unarchive). */
  resumeAll(now: number): number {
    const candidates = this.list({ state: 'paused' });
    this.sql.exec(
      `UPDATE triggers SET state = 'active', paused_at = NULL WHERE state = 'paused'`,
    );
    // Re-arm alarms for triggers whose next_fire_at is in the future.
    const fireRows = this.sql.exec(
      `SELECT next_fire_at FROM triggers WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at > ?`,
      now,
    ).toArray() as Array<{ next_fire_at: number }>;
    if (fireRows.length > 0) {
      const soonest = Math.min(...fireRows.map(r => r.next_fire_at));
      this.alarm.scheduleAt(soonest);
    }
    return candidates.length;
  }

  /** Permanently revoke a trigger. Used on agent delete + LLM-requested
   *  cancel + ephemeral webhook TTL expiry. */
  revoke(id: TriggerId, now: number): boolean {
    const before = this.get(id);
    if (!before || before.state === 'revoked') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'revoked', revoked_at = ?, next_fire_at = NULL WHERE id = ?`,
      now, id,
    );
    return true;
  }

  /** Revoke every trigger (agent delete). Idempotent. */
  revokeAll(now: number): number {
    const before = this.list().filter(t => t.state !== 'revoked').length;
    this.sql.exec(
      `UPDATE triggers SET state = 'revoked', revoked_at = ?, next_fire_at = NULL
       WHERE state != 'revoked'`, now,
    );
    return before;
  }

  // ── alarm wakeup path ──────────────────────────────────────────

  /** Triggers whose `next_fire_at` is due. Caller uses these to produce
   *  Timer events (or whatever the trigger kind dictates). After producing,
   *  the caller must call `markFired()`. */
  due(now: number): TriggerRow[] {
    const rows = this.sql.exec(
      `SELECT id, kind, spec, creator_trust, fork_policy, state,
              rate_limit_per_min, created_at, paused_at, revoked_at,
              next_fire_at, last_fire_at, fire_count
       FROM triggers
       WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?`,
      now,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(rowToTrigger);
  }

  /** Record that a trigger fired. Recomputes `next_fire_at` for cron;
   *  clears it for one-shot. */
  markFired(id: TriggerId, now: number, nextFireAt: number | null): void {
    this.sql.exec(
      `UPDATE triggers
         SET fire_count = fire_count + 1,
             last_fire_at = ?,
             next_fire_at = ?
       WHERE id = ?`,
      now, nextFireAt, id,
    );
    if (nextFireAt) this.alarm.scheduleAt(nextFireAt);
  }

  // ── fork ───────────────────────────────────────────────────────

  /** Returns the trigger rows that the FORK child should inherit, with new
   *  ids assigned. Caller copies them into the child DO. Severed kinds are
   *  not included; shared kinds reference the original ids (the spec column
   *  contains the share linkage). */
  forkPlan(): { copy: TriggerRow[]; share: TriggerRow[] } {
    const all = this.list({ state: 'active' });
    const copy: TriggerRow[] = [];
    const share: TriggerRow[] = [];
    for (const t of all) {
      const policy = (t.fork_policy ?? DEFAULT_FORK_POLICY[t.kind]) as ForkPolicy;
      if (policy === 'copy')  copy.push(t);
      if (policy === 'share') share.push(t);
      // 'sever' → not included
    }
    return { copy, share };
  }
}

function rowToTrigger(r: Record<string, unknown>): TriggerRow {
  return {
    id: r.id as string,
    kind: r.kind as TriggerKind,
    spec: JSON.parse((r.spec as string) ?? '{}'),
    creator_trust: r.creator_trust as TrustLevel,
    fork_policy: r.fork_policy as 'copy' | 'sever' | 'share' | null,
    state: r.state as TriggerRow['state'],
    created_at: r.created_at as number,
    paused_at: r.paused_at as number | null,
    revoked_at: r.revoked_at as number | null,
    rate_limit_per_min: r.rate_limit_per_min as number,
    next_fire_at: r.next_fire_at as number | null,
    last_fire_at: r.last_fire_at as number | null,
    fire_count: r.fire_count as number,
  };
}
