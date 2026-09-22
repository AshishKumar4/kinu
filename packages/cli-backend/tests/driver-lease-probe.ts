/** The out-of-band "who is driving?" read production never makes; exclusion is observable only from outside the holder. */
import type { Database } from 'bun:sqlite';
import type { DriverKind, DriverLeaseHolder } from '../src/agent-host';
import { makeSql } from '../src/runtime';

/** Who the row says is driving, or null. Throws when the table is missing: that is a test asserting before it arranged. */
export function leaseHolder(db: Database): DriverLeaseHolder | null {
  const rows = makeSql(db)<{ pid: number; kind: DriverKind }>`
    SELECT pid, kind FROM driver_lease WHERE id = 'local'`;

  const row = rows[0];

  return row ? { pid: Number(row.pid), kind: row.kind } : null;
}
