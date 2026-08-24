/**
 * The single-driver lease — which OS process is allowed to DRIVE one local
 * conversation.
 *
 * ## Why this exists
 *
 * A local workspace is one SQLite file, and more than one process can open it:
 * the resident scheduler daemon (`kinu daemon run`, a detached child), a
 * foreground `kinu daemon tick`, and every interactive `kinu chat` / TUI. They
 * all drive the same durable work — the trigger registry, the event log's
 * pending drain, the queued-turn pump.
 *
 * The orchestrator's drain is safe against a concurrent drain *inside one
 * process* and says so: `markConsumed` is synchronous, so a second drain on the
 * same event loop sees the events already bound. Across two processes that
 * argument does not hold. `EventLog.markConsumed` is a bare
 * `UPDATE agent_log SET turn_id=?, step_idx=?, consumed_at=? WHERE id=?` with no
 * `consumed_at IS NULL` guard, so two processes that both read `pending()` both
 * bind the same rows and both deliver them — one external event becomes two
 * turns, and the second one's reply channel points at a turn nobody is watching.
 *
 * So the mutual exclusion has to live one level up, at "who may drive", and it
 * has to be durable, because the participants do not share memory.
 *
 * ## Why there is no expiry
 *
 * A lease with a deadline answers "is the holder still working?" by guessing.
 * An agent turn legitimately runs for a very long time, so any deadline short
 * enough to recover from a crash is short enough to steal the lease from a
 * healthy turn mid-flight, which is the double-drive this module exists to
 * prevent. The row therefore carries NO timestamp at all — not even for
 * diagnostics, so that expiry cannot be added without changing the schema.
 *
 * Recovery uses the fact that actually distinguishes a crash from slow work:
 * the holder's process no longer exists. That is a same-machine question with
 * an exact answer, and it is asked through {@link LeaseProcess} so a test can
 * script two process-shaped participants without spawning either.
 *
 * ## Preemption is one-directional
 *
 * A person waiting at a prompt outranks background maintenance, so an
 * interactive process may take the lease from a LIVE daemon. The reverse is
 * never allowed: the daemon exists to run work while nobody is watching, and a
 * daemon that interrupted a live interactive owner would interleave its
 * programmatic turns with the user's own — the thing that must not happen.
 * A daemon meeting a live interactive holder waits for the next pass instead.
 */
import { KinuError, refusalOf, toKinuError, type Refusal } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '@kinu.run/core';

/**
 * What a failed `process.kill(pid, 0)` carries. Only `code` matters: it is the
 * sole fact that distinguishes "no such process" from "alive but not mine to
 * signal", and every other answer must fall through to a real failure rather
 * than be guessed at.
 */
const ProcessSignalFailureSchema = v.looseObject({ code: v.optional(v.string()) });

/** One row, one conversation: the lease is per workspace database. */
const LEASE_ROW_ID = 'local';

const DRIVER_LEASE_DDL = `
CREATE TABLE IF NOT EXISTS driver_lease (
  id    TEXT PRIMARY KEY,
  pid   INTEGER NOT NULL,
  token TEXT    NOT NULL,
  kind  TEXT    NOT NULL CHECK(kind IN ('interactive', 'daemon'))
)`;

/**
 * What a driver is. The two differ only in who may take the lease from whom —
 * see the preemption rule in this module's header.
 */
export type DriverKind = 'interactive' | 'daemon';

/** The lease as its holder sees it. `token` is the capability: every gated
 *  operation presents it, and only it can release the row. */
export interface DriverLease {
  readonly token: string;
  readonly kind: DriverKind;
  readonly pid: number;
}

/** Who holds the lease right now, for a refusal that names someone. */
export interface DriverLeaseHolder {
  readonly pid: number;
  readonly kind: DriverKind;
}

/**
 * This process's identity, and whether some other pid on this machine still
 * exists.
 *
 * Injected rather than called directly so the two-process behaviour is testable
 * without two processes: a test supplies distinct `pid`s and decides which of
 * them is alive, which is the only thing the real implementation can tell us.
 */
export interface LeaseProcess {
  readonly pid: number;
  isAlive(pid: number): boolean;
}

/**
 * The real seam. ESRCH is the only answer that means "gone": EPERM is a live
 * process this user may not signal, and reading that as dead would let a
 * daemon take the lease from a live owner it merely cannot see.
 */
export const OS_LEASE_PROCESS: LeaseProcess = {
  pid: process.pid,
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // The signal's own failure is the I/O boundary here, so the errno is
      // PARSED rather than narrowed by shape: `code` is the whole contract this
      // decision rests on, and an error that carries none must not read as a
      // dead process.
      const errno = v.safeParse(ProcessSignalFailureSchema, error);
      const code = errno.success ? errno.output.code : undefined;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw toKinuError({
        doing: `test whether process ${String(pid)} is still running`,
        cause: error,
        otherwise: 'unavailable',
      });
    }
  },
};

export type DriverLeaseResult =
  | { readonly held: DriverLease }
  | { readonly refused: Refusal; readonly holder: DriverLeaseHolder };

export interface DriverLeaseDeps {
  /** Tagged-template SQL over this workspace's own database. */
  readonly sql: SqlExecutor;
  /** DDL channel, so a database that never ran the workspace schema still
   *  gets the table on first use — a branch worker or a fixture. */
  readonly execRaw: RawSqlExec;
  readonly proc?: LeaseProcess;
}

interface LeaseRow {
  pid: number;
  token: string;
  kind: string;
}

export function initDriverLeaseTable(execRaw: RawSqlExec): void {
  execRaw(DRIVER_LEASE_DDL);
}

function readRow(sql: SqlExecutor): DriverLeaseHolderRow | null {
  const rows = sql<LeaseRow>`SELECT pid, token, kind FROM driver_lease WHERE id = ${LEASE_ROW_ID}`;
  const row = rows[0];
  if (!row) return null;
  // A row whose kind this build does not recognise is treated as a live claim
  // by an unknown driver rather than ignored: the safe reading of "someone
  // wrote something here" is that someone is driving.
  const kind: DriverKind = row.kind === 'interactive' ? 'interactive' : 'daemon';
  return { pid: Number(row.pid), token: row.token, kind };
}

interface DriverLeaseHolderRow extends DriverLeaseHolder {
  readonly token: string;
}

/**
 * Take the lease, or refuse and say who has it.
 *
 * The write is a compare-and-swap on the token we read, and the outcome is
 * decided by re-reading rather than by a row count — the SQL seams here return
 * no row count for a write, and a re-read is the honest question anyway: after
 * two processes race, exactly one of them finds its own token in the row.
 */
export function acquireDriverLease(
  deps: DriverLeaseDeps,
  kind: DriverKind,
): DriverLeaseResult {
  const proc = deps.proc ?? OS_LEASE_PROCESS;
  initDriverLeaseTable(deps.execRaw);
  const current = readRow(deps.sql);
  const token = crypto.randomUUID();

  if (current && current.pid !== proc.pid) {
    // The whole preemption rule, in one place: a live holder yields only to an
    // interactive process taking over from a daemon. A dead holder yields to
    // anyone, which is the only recovery path and the reason no deadline exists.
    const alive = proc.isAlive(current.pid);
    const mayTake = !alive || (kind === 'interactive' && current.kind === 'daemon');
    if (!mayTake) {
      return {
        // `unavailable`, not `denied`: nothing is forbidden here, the driver is
        // simply taken. The caller's next pass is the retry, and a refusal that
        // read as a permission failure would invite someone to add a bypass.
        refused: refusalOf(new KinuError(
          'unavailable',
          `the ${current.kind} driver in process ${String(current.pid)} is running this conversation; `
          + `a ${kind} driver does not interrupt it`,
        )),
        holder: { pid: current.pid, kind: current.kind },
      };
    }
  }

  // `void` because these are WRITES: the executor returns rows only for reads,
  // and the outcome is read back below rather than inferred from a return value.
  if (current) {
    void deps.sql`
      UPDATE driver_lease SET pid = ${proc.pid}, token = ${token}, kind = ${kind}
      WHERE id = ${LEASE_ROW_ID} AND token = ${current.token}`;
  } else {
    void deps.sql`
      INSERT INTO driver_lease (id, pid, token, kind)
      VALUES (${LEASE_ROW_ID}, ${proc.pid}, ${token}, ${kind})
      ON CONFLICT(id) DO NOTHING`;
  }

  const settled = readRow(deps.sql);
  if (settled?.token === token) {
    return { held: { token, kind, pid: proc.pid } };
  }
  // Someone else's write landed between our read and ours. Report THEM, not a
  // generic failure: the caller's next pass is the retry.
  const holder = settled ?? { pid: proc.pid, kind, token };
  return {
    refused: refusalOf(new KinuError(
      'unavailable',
      `another ${holder.kind} driver (process ${String(holder.pid)}) claimed this conversation first`,
    )),
    holder: { pid: holder.pid, kind: holder.kind },
  };
}

/**
 * Whether this token is still the live claim.
 *
 * Called before every gated operation rather than once at the start, because
 * the point of preemption is that a lease can be lost while its holder is
 * between operations. A holder that was preempted must stop driving at the
 * next boundary, not at the end of its pass.
 */
export function holdsDriverLease(deps: Pick<DriverLeaseDeps, 'sql'>, token: string): boolean {
  return readRow(deps.sql)?.token === token;
}

/** Who is driving, or null when nobody is. */
export function driverLeaseHolder(deps: Pick<DriverLeaseDeps, 'sql'>): DriverLeaseHolder | null {
  const row = readRow(deps.sql);
  return row ? { pid: row.pid, kind: row.kind } : null;
}

/**
 * Give up the lease.
 *
 * Guarded by the token, so a process that was preempted and then finished its
 * pass cannot delete its successor's claim — the release is for OUR lease, and
 * a stale token releases nothing. Returns whether the row was actually ours.
 */
export function releaseDriverLease(deps: Pick<DriverLeaseDeps, 'sql'>, token: string): boolean {
  const held = holdsDriverLease(deps, token);
  if (!held) return false;
  void deps.sql`DELETE FROM driver_lease WHERE id = ${LEASE_ROW_ID} AND token = ${token}`;
  return true;
}
