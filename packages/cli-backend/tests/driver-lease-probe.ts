/**
 * The one observation of the driver lease that production never makes.
 *
 * `DriverLeaseHold` answers "am I still the driver?" from the row, which is the
 * question every driving boundary asks, and a refusal already names whoever
 * holds it. Nothing in production asks "who is driving?" out of band — so the
 * lease module does not export that read, and a suite that needs it takes it
 * from here instead of widening a production surface.
 *
 * A suite needs it because exclusion is only observable from OUTSIDE the holder:
 * a second connection reading the row is exactly what a rival process sees, and
 * an assertion made through the holder's own object could not tell a lease that
 * was kept from one that was taken back and re-taken.
 */
import type { Database } from 'bun:sqlite';
import type { DriverKind, DriverLeaseHolder } from '../src/agent-host';
import { makeSql } from '../src/runtime';

/**
 * Who the row says is driving, or null when nobody is.
 *
 * Throws when no driver has ever taken this lease, because the table is created
 * by the first acquisition: "the table is missing" is a test that asserted
 * before it arranged, not an answer, and reading it as "nobody is driving"
 * would let that mistake pass.
 */
export function leaseHolder(db: Database): DriverLeaseHolder | null {
  const rows = makeSql(db)<{ pid: number; kind: DriverKind }>`
    SELECT pid, kind FROM driver_lease WHERE id = 'local'`;
  const row = rows[0];
  return row ? { pid: Number(row.pid), kind: row.kind } : null;
}
