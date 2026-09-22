/**
 * Single-driver lease: which OS process may drive one local conversation. Cross-process
 * exclusion is needed because `EventLog.markConsumed` has no `consumed_at IS NULL` guard.
 * No expiry by design (turns run long); recovery is by holder-pid liveness only.
 * Interactive may preempt a live daemon, never the reverse.
 */
import { KinuError, refusalOf, type Refusal } from "../obs/index";
import { type RawSqlExec, type SqlExecutor } from '../types/primitives';

const LEASE_ROW_ID = 'local';

const DRIVER_LEASE_DDL = `
CREATE TABLE IF NOT EXISTS driver_lease (
  id    TEXT PRIMARY KEY,
  pid   INTEGER NOT NULL,
  token TEXT    NOT NULL,
  kind  TEXT    NOT NULL CHECK(kind IN ('interactive', 'daemon'))
)`;

export type DriverKind = 'interactive' | 'daemon';

/** `token` is the capability: only it can release the row. */
interface DriverLease {
  readonly token: string;
  readonly kind: DriverKind;
  readonly pid: number;
}

export interface DriverLeaseHolder {
  readonly pid: number;
  readonly kind: DriverKind;
}

/** This process's pid and a liveness check for other pids; injected for tests. */
export interface LeaseProcess {
  readonly pid: number;
  isAlive(pid: number): boolean;
}

export interface DriverLeaseRefusal {
  readonly refused: Refusal;
  readonly holder: DriverLeaseHolder;
}

type DriverLeaseResult = { readonly held: DriverLease } | DriverLeaseRefusal;

export interface DriverLeaseDeps {
  readonly sql: SqlExecutor;
  /** DDL channel: creates the table on first use in databases without the workspace schema. */
  readonly execRaw: RawSqlExec;
  readonly proc: LeaseProcess;
}

interface LeaseRow {
  pid: number;
  token: string;
  kind: string;
}

function initDriverLeaseTable(execRaw: RawSqlExec): void {
  execRaw(DRIVER_LEASE_DDL);
}

function readRow(sql: SqlExecutor): DriverLeaseHolderRow | null {
  const rows = sql<LeaseRow>`SELECT pid, token, kind FROM driver_lease WHERE id = ${LEASE_ROW_ID}`;
  const row = rows[0];

  if (!row) return null;
  // An unrecognised kind is treated as a live claim, not ignored.
  const kind: DriverKind = row.kind === 'interactive' ? 'interactive' : 'daemon';

  return { pid: Number(row.pid), token: row.token, kind };
}

interface DriverLeaseHolderRow extends DriverLeaseHolder {
  readonly token: string;
}

/** Compare-and-swap on the read token, decided by re-reading: the SQL seam returns no row count. */
function acquireDriverLease(
  deps: DriverLeaseDeps,
  kind: DriverKind,
): DriverLeaseResult {
  const proc = deps.proc;
  initDriverLeaseTable(deps.execRaw);
  const current = readRow(deps.sql);
  const token = crypto.randomUUID();

  if (current && current.pid !== proc.pid) {
    // A live holder yields only to interactive-over-daemon; a dead holder yields to anyone.
    const alive = proc.isAlive(current.pid);
    const mayTake = !alive || (kind === 'interactive' && current.kind === 'daemon');

    if (!mayTake) {
      return {
        // `unavailable`, not `denied`: the driver is taken, not forbidden.
        refused: refusalOf(new KinuError(
          'unavailable',
          `the ${current.kind} driver in process ${String(current.pid)} is running this conversation; `
          + `a ${kind} driver does not interrupt it`,
        )),
        holder: { pid: current.pid, kind: current.kind },
      };
    }
  }

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

  const holder = settled ?? { pid: proc.pid, kind, token };

  return {
    refused: refusalOf(new KinuError(
      'unavailable',
      `another ${holder.kind} driver (process ${String(holder.pid)}) claimed this conversation first`,
    )),
    holder: { pid: holder.pid, kind: holder.kind },
  };
}

/** Check before every gated operation: a lease can be preempted between operations. */
function holdsDriverLease(deps: Pick<DriverLeaseDeps, 'sql'>, token: string): boolean {
  return readRow(deps.sql)?.token === token;
}

/** Token-guarded, so a preempted holder cannot delete its successor's claim. */
function releaseDriverLease(deps: Pick<DriverLeaseDeps, 'sql'>, token: string): boolean {
  const held = holdsDriverLease(deps, token);

  if (!held) return false;
  void deps.sql`DELETE FROM driver_lease WHERE id = ${LEASE_ROW_ID} AND token = ${token}`;

  return true;
}

/** One process's hold on a conversation's lease; `held()` answers from the row, not memory. */
export class DriverLeaseHold {
  private token: string | null = null;

  constructor(
    private readonly deps: DriverLeaseDeps,
    readonly kind: DriverKind,
  ) {}

  /** A token already held is re-checked, not trusted. */
  acquire(): DriverLeaseRefusal | null {
    if (this.token !== null && holdsDriverLease(this.deps, this.token)) return null;
    const outcome = acquireDriverLease(this.deps, this.kind);

    if ('held' in outcome) {
      this.token = outcome.held.token;

      return null;
    }

    this.token = null;

    return { refused: outcome.refused, holder: outcome.holder };
  }

  held(): boolean {
    return this.token !== null && holdsDriverLease(this.deps, this.token);
  }

  release(): void {
    if (this.token === null) return;
    releaseDriverLease(this.deps, this.token);
    this.token = null;
  }
}
