/** Durable event-producing subscriptions, scoped to one actor. Per-kind fork defaults in
 *  {@link DEFAULT_FORK_POLICY}; pause makes alarms no-ops, revoke clears them. */

import * as v from 'valibot';
import {
  type TriggerId, type TriggerKind, type TriggerRow, type TrustLevel,
} from './types';
import { ulid } from './ulid';
import type { SqlExec, SqlExecRow, SqlValue } from '../../types/primitives';
import type { ActorHandle } from '../../identity/actor-handle';
import { parseJsonObject, type JsonObject } from '../../utils/json';
// Default only: 0 means "block" here, which `normalizeWebhookRateLimitPerMin` rejects.
import { DEFAULT_RATE_LIMIT_PER_MIN } from '../ingress/rate-limit';

export type ForkPolicy = 'copy' | 'sever' | 'share';

export const DEFAULT_FORK_POLICY = {
  webhook_durable:   'sever',
  webhook_ephemeral: 'sever',
  timer_oneshot:     'sever',
  timer_cron:        'copy',
  process_watch:     'share',
  file_watch:        'share',
  peer_inbox:        'copy',
  mcp_route:         'sever',
  email_route:       'sever',  // a fork has its own address; re-grant deliberately
} satisfies Record<TriggerKind, ForkPolicy>;

export interface RegisterSpec {
  kind: TriggerKind;
  spec: JsonObject;
  creator_trust: TrustLevel;
  fork_policy?: ForkPolicy;
  rate_limit_per_min?: number;
  next_fire_at?: number;
}

const TriggerRowSchema = v.object({
  id: v.string(),
  kind: v.picklist([
    'webhook_durable', 'webhook_ephemeral', 'timer_oneshot', 'timer_cron',
    'process_watch', 'file_watch', 'peer_inbox', 'mcp_route', 'email_route',
  ]),
  spec: v.string(),
  creator_trust: v.picklist(['external', 'authenticated', 'owner', 'self']),
  fork_policy: v.nullable(v.picklist(['copy', 'sever', 'share'])),
  state: v.picklist(['active', 'paused', 'revoked']),
  created_at: v.number(),
  paused_at: v.nullable(v.number()),
  revoked_at: v.nullable(v.number()),
  rate_limit_per_min: v.number(),
  next_fire_at: v.nullable(v.number()),
  last_fire_at: v.nullable(v.number()),
  fire_count: v.number(),
});

const OptionalNextFireRowSchema = v.object({ next_fire_at: v.nullable(v.number()) });

const NextFireRowSchema = v.object({ next_fire_at: v.number() });

export interface AlarmScheduler {
  /** Awaited: on a Durable Object arming is a storage write that `ctx.waitUntil` cannot hold
   *  (`do.wait_until.no_op`, `do.background_task.cancelled_on_reset`). */
  scheduleAt(ts: number): Promise<void>;
}

export class TriggerRegistry {
  private readonly actorId: string;

  constructor(
    private readonly sql: SqlExec,
    private readonly actor: ActorHandle,
    private readonly alarm: AlarmScheduler,
  ) {
    this.actorId = actor.actorId;
  }

  async register(spec: RegisterSpec, now: number): Promise<TriggerId> {
    this.actor.assertCurrent();
    const id = ulid();
    const fp = spec.fork_policy ?? null;
    this.sql.exec(
      `INSERT INTO triggers
         (actor_id, id, kind, spec, creator_trust, fork_policy, state, rate_limit_per_min,
          created_at, paused_at, revoked_at, next_fire_at, last_fire_at, fire_count)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, NULL, 0)`,
      this.actorId, id, spec.kind, JSON.stringify(spec.spec), spec.creator_trust, fp,
      spec.rate_limit_per_min ?? DEFAULT_RATE_LIMIT_PER_MIN, now, spec.next_fire_at ?? null,
    );

    if (spec.next_fire_at) await this.alarm.scheduleAt(spec.next_fire_at);

    return id;
  }

  get(id: TriggerId): TriggerRow | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, kind, spec, creator_trust, fork_policy, state, rate_limit_per_min,
              created_at, paused_at, revoked_at, next_fire_at, last_fire_at, fire_count
       FROM triggers WHERE actor_id = ? AND id = ?`, this.actorId, id,
    ).toArray();

    if (rows.length === 0) return null;

    return rowToTrigger(rows[0]);
  }

  list(filter?: { kind?: TriggerKind; state?: 'active' | 'paused' | 'revoked' }): TriggerRow[] {
    this.actor.assertCurrent();

    let sql = `SELECT id, kind, spec, creator_trust, fork_policy, state,
                      rate_limit_per_min, created_at, paused_at, revoked_at,
                      next_fire_at, last_fire_at, fire_count
               FROM triggers WHERE actor_id = ?`;

    const bindings: SqlValue[] = [this.actorId];

    if (filter?.kind) { sql += ` AND kind = ?`; bindings.push(filter.kind); }

    if (filter?.state) { sql += ` AND state = ?`; bindings.push(filter.state); }

    sql += ` ORDER BY created_at DESC`;
    const rows = this.sql.exec(sql, ...bindings).toArray();

    return rows.map(rowToTrigger);
  }

  /** Paused triggers' alarm firings are dropped silently. */
  pause(id: TriggerId, now: number): boolean {
    const before = this.get(id);

    if (!before || before.state !== 'active') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'paused', paused_at = ? WHERE actor_id = ? AND id = ?`,
      now, this.actorId, id,
    );

    return true;
  }

  /** Missed firings during the pause are not backfilled. */
  async resume(id: TriggerId, now: number): Promise<boolean> {
    const before = this.get(id);

    if (!before || before.state !== 'paused') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'active', paused_at = NULL WHERE actor_id = ? AND id = ?`,
      this.actorId, id,
    );

    const fire = this.sql.exec(
      `SELECT next_fire_at FROM triggers WHERE actor_id = ? AND id = ?`, this.actorId, id,
    ).toArray().map((row) => v.parse(OptionalNextFireRowSchema, row));

    if (fire[0]?.next_fire_at && fire[0].next_fire_at > now) {
      await this.alarm.scheduleAt(fire[0].next_fire_at);
    }

    return true;
  }

  pauseAll(now: number): number {
    const before = this.list({ state: 'active' }).length;
    this.sql.exec(
      `UPDATE triggers SET state = 'paused', paused_at = ?
       WHERE actor_id = ? AND state = 'active'`, now, this.actorId,
    );

    return before;
  }

  async resumeAll(now: number): Promise<number> {
    const candidates = this.list({ state: 'paused' });
    this.sql.exec(
      `UPDATE triggers SET state = 'active', paused_at = NULL
       WHERE actor_id = ? AND state = 'paused'`, this.actorId,
    );

    const fireRows = this.sql.exec(
      `SELECT next_fire_at FROM triggers
       WHERE actor_id = ? AND state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at > ?`,
      this.actorId, now,
    ).toArray().map((row) => v.parse(NextFireRowSchema, row));

    if (fireRows.length > 0) {
      const soonest = Math.min(...fireRows.map(r => r.next_fire_at));
      await this.alarm.scheduleAt(soonest);
    }

    return candidates.length;
  }

  revoke(id: TriggerId, now: number): boolean {
    const before = this.get(id);

    if (!before || before.state === 'revoked') return false;
    this.sql.exec(
      `UPDATE triggers SET state = 'revoked', revoked_at = ?, next_fire_at = NULL
       WHERE actor_id = ? AND id = ?`,
      now, this.actorId, id,
    );

    return true;
  }

  revokeAll(now: number): number {
    const before = this.list().filter(t => t.state !== 'revoked').length;
    this.sql.exec(
      `UPDATE triggers SET state = 'revoked', revoked_at = ?, next_fire_at = NULL
       WHERE actor_id = ? AND state != 'revoked'`, now, this.actorId,
    );

    return before;
  }

  /** The caller must call `markFired()` after producing events. */
  due(now: number): TriggerRow[] {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, kind, spec, creator_trust, fork_policy, state,
              rate_limit_per_min, created_at, paused_at, revoked_at,
              next_fire_at, last_fire_at, fire_count
       FROM triggers
       WHERE actor_id = ? AND state = 'active'
         AND next_fire_at IS NOT NULL AND next_fire_at <= ?`,
      this.actorId, now,
    ).toArray();

    return rows.map(rowToTrigger);
  }

  async markFired(id: TriggerId, now: number, nextFireAt: number | null): Promise<void> {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE triggers
         SET fire_count = fire_count + 1,
             last_fire_at = ?,
             next_fire_at = ?
       WHERE actor_id = ? AND id = ?`,
      now, nextFireAt, this.actorId, id,
    );

    if (nextFireAt) await this.alarm.scheduleAt(nextFireAt);
  }

  /** Severed kinds are omitted; shared kinds keep the original ids. */
  forkPlan() {
    const all = this.list({ state: 'active' });
    const copy: TriggerRow[] = [];
    const share: TriggerRow[] = [];

    for (const t of all) {
      const policy = t.fork_policy ?? DEFAULT_FORK_POLICY[t.kind];

      if (policy === 'copy')  copy.push(t);

      if (policy === 'share') share.push(t);
    }

    return { copy, share };
  }
}

function rowToTrigger(row: SqlExecRow): TriggerRow {
  const r = v.parse(TriggerRowSchema, row);

  return {
    id: r.id,
    kind: r.kind,
    spec: parseJsonObject(r.spec),
    creator_trust: r.creator_trust,
    fork_policy: r.fork_policy,
    state: r.state,
    created_at: r.created_at,
    paused_at: r.paused_at,
    revoked_at: r.revoked_at,
    rate_limit_per_min: r.rate_limit_per_min,
    next_fire_at: r.next_fire_at,
    last_fire_at: r.last_fire_at,
    fire_count: r.fire_count,
  };
}
