/**
 * An account's limits as its own object keeps them (UserDO): who it is, what of its counted use it has spent, and
 * the sizes its stores last measured. Use is counted where it is spent (a computer's running time per heartbeat, a
 * platform model's tokens per step); stored bytes are not counted, but read where they live and sampled here.
 */
import type { SqlExec } from '../types/primitives';

export function initAccountLimitTables(sql: SqlExec): void {
  // No row: a free account. Operator and eval are read from the email, never stored here.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_standing (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      class            TEXT NOT NULL CHECK (class IN ('free', 'invited')),
      invited_by       TEXT,
      invited_at       INTEGER,
      suspended_at     INTEGER,
      suspended_reason TEXT,
      suspended_by     TEXT,
      updated_at       INTEGER NOT NULL
    )
  `);

  // One row while that workspace's computer runs: a free account may run one at a time.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_computer_running (
      workspace    TEXT PRIMARY KEY,
      size         TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      last_tick_at INTEGER NOT NULL
    )
  `);

  // Running time per UTC month, accrued per heartbeat: a stop the platform makes unseen costs at most one tick.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_computer_usage (
      month     TEXT NOT NULL,
      workspace TEXT NOT NULL,
      seconds   REAL NOT NULL,
      PRIMARY KEY (month, workspace)
    )
  `);

  // Each store's own size as last read where it lives ('drive', 'mail', 'workspace:<name>'): a sample, never a sum of writes.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_storage (
      source      TEXT PRIMARY KEY,
      bytes       INTEGER NOT NULL,
      measured_at INTEGER NOT NULL
    )
  `);

  // Platform-model tokens (input and output) per UTC day, from the binding's own usage.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_model_usage (
      day    TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL,
      steps  INTEGER NOT NULL
    )
  `);

  // A limit the assistant has mentioned near its end, once a period.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_limit_notices (
      limit_id   TEXT NOT NULL,
      period     TEXT NOT NULL,
      noticed_at INTEGER NOT NULL,
      PRIMARY KEY (limit_id, period)
    )
  `);
}
