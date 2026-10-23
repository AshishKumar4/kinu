/**
 * An account's limit tables (limits/schema.ts) as its object reads and writes them. Every write is one statement, so a
 * Durable Object's single-threaded turn makes each read-then-write whole.
 */
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';
import { STORED_CLASSES, type StoredClass } from './policy';

const rows = <T extends v.GenericSchema>(schema: T, found: { toArray(): unknown[] }): v.InferOutput<T>[] => found.toArray().map((row) => v.parse(schema, row));

/** The computer's heartbeat (devbox `DEFAULT_DEVBOX_POLICY.heartbeatSeconds`). */
const HEARTBEAT_MS = 60_000;

/**
 * The most one tick accrues: two heartbeats. A gap past it is time the box was not seen running (evicted, stopped by
 * the platform), never charged.
 */
const TICK_CAP_MS = 2 * HEARTBEAT_MS;

/** A running row with no tick for this long is a computer the platform stopped unseen: it holds no place. */
const RUNNING_STALE_MS = 5 * HEARTBEAT_MS;

/** A UTC calendar month, `YYYY-MM`: the computer-hours period. */
export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** A UTC day, `YYYY-MM-DD`: the platform-model period. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** When the period `at` falls in ends: the next UTC month's or day's first instant. */
export function periodEnd(period: 'month' | 'day', at: number): number {
  const date = new Date(at);

  return period === 'month'
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

const StandingRow = v.object({
  class: v.picklist(STORED_CLASSES),
  invited_by: v.nullable(v.string()),
  invited_at: v.nullable(v.number()),
  suspended_at: v.nullable(v.number()),
  suspended_reason: v.nullable(v.string()),
  suspended_by: v.nullable(v.string()),
});

/** What an operator has set on the account: its class, and a suspension. */
export interface Standing {
  readonly class: StoredClass;
  readonly invitedBy: string | null;
  readonly invitedAt: number | null;
  readonly suspended: { readonly at: number; readonly reason: string; readonly by: string } | null;
}

const RunningRow = v.object({ workspace: v.string(), size: v.string(), started_at: v.number(), last_tick_at: v.number() });

export type RunningComputer = v.InferOutput<typeof RunningRow>;

const CountRow = v.object({ n: v.nullable(v.number()) });

export class AccountLimitsStore {
  constructor(private readonly sql: SqlExec) {}

  standing(): Standing {
    const [row] = rows(StandingRow, this.sql.exec(
      'SELECT class, invited_by, invited_at, suspended_at, suspended_reason, suspended_by FROM account_standing WHERE id = 1',
    ));

    if (row === undefined) return { class: 'free', invitedBy: null, invitedAt: null, suspended: null };
    const suspended = row.suspended_at === null ? null : { at: row.suspended_at, reason: row.suspended_reason ?? '', by: row.suspended_by ?? '' };

    return { class: row.class, invitedBy: row.invited_by, invitedAt: row.invited_at, suspended };
  }

  /** The account's class as an operator sets it; an invitation names who gave it. */
  setClass(klass: StoredClass, by: string, now: number): void {
    this.sql.exec(
      `INSERT INTO account_standing (id, class, invited_by, invited_at, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET class = excluded.class, invited_by = excluded.invited_by, invited_at = excluded.invited_at, updated_at = excluded.updated_at`,
      klass, klass === 'invited' ? by : null, klass === 'invited' ? now : null, now,
    );
  }

  suspend(reason: string, by: string, now: number): void {
    this.sql.exec(
      `INSERT INTO account_standing (id, class, suspended_at, suspended_reason, suspended_by, updated_at) VALUES (1, 'free', ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET suspended_at = excluded.suspended_at, suspended_reason = excluded.suspended_reason,
         suspended_by = excluded.suspended_by, updated_at = excluded.updated_at`,
      now, reason, by, now,
    );
  }

  unsuspend(now: number): void {
    this.sql.exec('UPDATE account_standing SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL, updated_at = ? WHERE id = 1', now);
  }

  /** The account's computers running now; a row whose ticks stopped long ago is forgotten first. */
  running(now: number): readonly RunningComputer[] {
    this.sql.exec('DELETE FROM account_computer_running WHERE last_tick_at < ?', now - RUNNING_STALE_MS);

    return rows(RunningRow, this.sql.exec('SELECT workspace, size, started_at, last_tick_at FROM account_computer_running'));
  }

  /** `workspace`'s computer started at `size`: it holds a place until it stops. */
  started(workspace: string, size: string, now: number): void {
    this.sql.exec(
      `INSERT INTO account_computer_running (workspace, size, started_at, last_tick_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace) DO UPDATE SET size = excluded.size, started_at = excluded.started_at, last_tick_at = excluded.last_tick_at`,
      workspace, size, now, now,
    );
  }

  /**
   * `workspace`'s computer seen running at `now`: the time since its last tick accrues to this month, up to
   * {@link TICK_CAP_MS}. A tick for a computer with no row (started before this ledger, or a stop the platform made
   * unseen) starts its row and accrues nothing.
   */
  tick(workspace: string, size: string, now: number): void {
    const [row] = rows(RunningRow, this.sql.exec('SELECT workspace, size, started_at, last_tick_at FROM account_computer_running WHERE workspace = ?', workspace));

    if (row === undefined) {
      this.started(workspace, size, now);

      return;
    }

    this.accrue(workspace, Math.min(Math.max(0, now - row.last_tick_at), TICK_CAP_MS), now);
    this.sql.exec('UPDATE account_computer_running SET last_tick_at = ?, size = ? WHERE workspace = ?', now, size, workspace);
  }

  /** `workspace`'s computer stopped: its last part accrues, and its place is free. */
  stopped(workspace: string, now: number): void {
    const [row] = rows(RunningRow, this.sql.exec('SELECT workspace, size, started_at, last_tick_at FROM account_computer_running WHERE workspace = ?', workspace));

    if (row !== undefined) this.accrue(workspace, Math.min(Math.max(0, now - row.last_tick_at), TICK_CAP_MS), now);
    this.sql.exec('DELETE FROM account_computer_running WHERE workspace = ?', workspace);
  }

  private accrue(workspace: string, ms: number, now: number): void {
    if (ms <= 0) return;
    this.sql.exec(
      `INSERT INTO account_computer_usage (month, workspace, seconds) VALUES (?, ?, ?)
       ON CONFLICT (month, workspace) DO UPDATE SET seconds = seconds + excluded.seconds`,
      monthOf(now), workspace, ms / 1000,
    );
  }

  /** Seconds the account's computers ran in the month `now` falls in. */
  computerSeconds(now: number): number {
    return rows(CountRow, this.sql.exec('SELECT SUM(seconds) AS n FROM account_computer_usage WHERE month = ?', monthOf(now)))[0]?.n ?? 0;
  }

  /** A store's size as read where it lives; it replaces the last reading of that store. */
  sampled(source: string, bytes: number, now: number): void {
    this.sql.exec(
      `INSERT INTO account_storage (source, bytes, measured_at) VALUES (?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET bytes = excluded.bytes, measured_at = excluded.measured_at`,
      source, Math.max(0, Math.round(bytes)), now,
    );
  }

  /** When `source` was last read; null if never. */
  measuredAt(source: string): number | null {
    return rows(CountRow, this.sql.exec('SELECT measured_at AS n FROM account_storage WHERE source = ?', source))[0]?.n ?? null;
  }

  /** `source` changed since it was read: its next reading is taken at once, its last counting until then. */
  stale(source: string): void {
    this.sql.exec('UPDATE account_storage SET measured_at = 0 WHERE source = ?', source);
  }

  /** A store the account no longer has (a removed workspace): its size counts no more. */
  forgetStore(source: string): void {
    this.sql.exec('DELETE FROM account_storage WHERE source = ?', source);
  }

  /** The sum of every store's last reading. */
  storedBytes(): number {
    return rows(CountRow, this.sql.exec('SELECT SUM(bytes) AS n FROM account_storage'))[0]?.n ?? 0;
  }

  /** Tokens a platform-model step spent, debited to the day `now` falls in. */
  spentTokens(tokens: number, now: number): void {
    this.sql.exec(
      `INSERT INTO account_model_usage (day, tokens, steps) VALUES (?, ?, 1)
       ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens, steps = steps + 1`,
      dayOf(now), Math.max(0, Math.round(tokens)),
    );
  }

  /** Platform-model tokens spent on the day `now` falls in. */
  tokensToday(now: number): number {
    return rows(CountRow, this.sql.exec('SELECT tokens AS n FROM account_model_usage WHERE day = ?', dayOf(now)))[0]?.n ?? 0;
  }

  /** Records the assistant's mention of `limit` near its end in `period`; whether this was the first. */
  noticeOnce(limit: string, period: string, now: number): boolean {
    const before = rows(CountRow, this.sql.exec('SELECT COUNT(*) AS n FROM account_limit_notices WHERE limit_id = ? AND period = ?', limit, period))[0]?.n ?? 0;

    if (before > 0) return false;
    this.sql.exec('INSERT INTO account_limit_notices (limit_id, period, noticed_at) VALUES (?, ?, ?)', limit, period, now);

    return true;
  }
}
