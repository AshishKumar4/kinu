import * as v from 'valibot';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import type { SlateUsage } from './capability-graph';

/** What each slate has called on its surface, as its owner ran it: what a share is cut from and a blueprint requires. */
export function initSlateUsageTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_usage (
    slate_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    member TEXT NOT NULL,
    PRIMARY KEY (slate_id, namespace, member)
  )`);
}

const UsageRow = v.object({ namespace: v.string(), member: v.string() });

export class SlateUsageStore {
  constructor(private readonly db: SqlExec) {}

  record(slate: string, usage: SlateUsage): void {
    this.db.exec('INSERT OR IGNORE INTO slate_usage (slate_id, namespace, member) VALUES (?, ?, ?)', slate, usage.namespace, usage.member);
  }

  list(slate: string): SlateUsage[] {
    return this.db.exec('SELECT namespace, member FROM slate_usage WHERE slate_id = ? ORDER BY namespace, member', slate).toArray()
      .map((row) => v.parse(UsageRow, row));
  }

  forget(slate: string): void {
    this.db.exec('DELETE FROM slate_usage WHERE slate_id = ?', slate);
  }
}
