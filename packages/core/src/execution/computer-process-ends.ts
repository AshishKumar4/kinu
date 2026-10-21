/**
 * Where a computer's process run as a job ends, as its box tells it (`process-ended`): the job's own promise waits here.
 * Told while the job's promise waits, it settles it at once; told while none does (the workspace restarted and its job is
 * not yet resumed), it is kept until the job's resume asks; told of a job that no longer runs, nothing is kept.
 */
import * as v from 'valibot';
import type { ComputerProcessEnd } from './sandbox';

const EndRow = v.object({ exit_code: v.nullable(v.number()), tail: v.string() });

/** The workspace object's SQL, as its own `ctx.storage.sql`: rows as stored values, read through `EndRow`. */
interface EndsSql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, string | number | null | ArrayBuffer>[] };
}

/** A job's promise waiting for its process's end. */
interface Waiting {
  readonly promise: Promise<ComputerProcessEnd>;
  resolve(end: ComputerProcessEnd): void;
}

/** Made with the workspace's tables (`initWorkspaceTables`), as its jobs' are. */
export function initComputerProcessEndsTable(execRaw: (sql: string) => void): void {
  execRaw(`CREATE TABLE IF NOT EXISTS computer_process_ends (
    job TEXT PRIMARY KEY,
    exit_code INTEGER,
    tail TEXT NOT NULL
  )`);
}

export class ComputerProcessEnds {
  private readonly waiting = new Map<string, Waiting>();

  /** Over a workspace's schema, which has the table (`initComputerProcessEndsTable`). */
  constructor(private readonly sql: EndsSql, private readonly running: (jobId: string) => boolean) {}

  /** The job's process's end: at once if the box told it already, else when it does. */
  ended(jobId: string): Promise<ComputerProcessEnd> {
    const [row] = this.sql.exec('SELECT exit_code, tail FROM computer_process_ends WHERE job = ?', jobId).toArray();

    if (row !== undefined) {
      this.sql.exec('DELETE FROM computer_process_ends WHERE job = ?', jobId);
      const { exit_code: exitCode, tail } = v.parse(EndRow, row);

      return Promise.resolve(exitCode === null ? { tail } : { exitCode, tail });
    }

    const waiting: Waiting = this.waiting.get(jobId) ?? Promise.withResolvers<ComputerProcessEnd>();
    this.waiting.set(jobId, waiting);

    return waiting.promise;
  }

  /** What the box told of `jobId`'s process's end. */
  record(jobId: string, end: ComputerProcessEnd): void {
    const waiting = this.waiting.get(jobId);

    if (waiting !== undefined) {
      this.waiting.delete(jobId);
      waiting.resolve(end);

      return;
    }

    if (!this.running(jobId)) return;
    this.sql.exec('INSERT OR REPLACE INTO computer_process_ends (job, exit_code, tail) VALUES (?, ?, ?)', jobId, end.exitCode ?? null, end.tail);
  }
}
