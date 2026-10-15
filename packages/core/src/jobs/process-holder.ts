/** Which local process runs each job: a job a live process runs is not a starting process's orphan. */

import type { LeaseProcess } from '../execution/driver-lease';
import type { Storage } from '../types/primitives';
import type { JobHolder } from './runner';

const JOB_HOLDERS_DDL = `CREATE TABLE IF NOT EXISTS background_job_holders (
  job_id     TEXT    PRIMARY KEY,
  pid        INTEGER NOT NULL,
  generation TEXT    NOT NULL
)`;

/** Made with the local workspace's database, so its stamp covers it (identity/schema-stamp.ts). */
export function initJobHoldersTable(execRaw: (ddl: string) => void): void {
  execRaw(JOB_HOLDERS_DDL);
}

/** Liveness by process generation, as the driver lease's: a pid reused by a later process holds no job. */
export function processJobHolder({ sql, execRaw, transactionSync }: Pick<Storage, 'sql' | 'execRaw' | 'transactionSync'>, proc: LeaseProcess): JobHolder {
  execRaw(JOB_HOLDERS_DDL);

  const hold = (jobId: string): void => {
    void sql`INSERT OR REPLACE INTO background_job_holders (job_id, pid, generation) VALUES (${jobId}, ${proc.pid}, ${proc.generation})`;
  };

  const heldElsewhere = (jobId: string): boolean => sql<{ pid: number; generation: string }>`
    SELECT pid, generation FROM background_job_holders WHERE job_id = ${jobId}`
    .some((row) => row.pid !== proc.pid && proc.isAlive({ pid: Number(row.pid), generation: row.generation }));

  return {
    hold,
    heldElsewhere,
    // The check, the claim and the hold commit together, so a process that read the dead holder cannot also win.
    take: (jobId, claim) => transactionSync(() => {
      if (heldElsewhere(jobId)) return 'held';
      const won = claim();

      if (won !== null) hold(jobId);

      return won;
    }),
  };
}
