/** Which local process runs each job: a job a live process runs is not a starting process's orphan. */

import type { LeaseProcess } from '../execution/driver-lease';
import type { Storage } from '../types/primitives';
import type { JobHolder } from './runner';

const JOB_HOLDERS_DDL = `CREATE TABLE IF NOT EXISTS background_job_holders (
  job_id TEXT PRIMARY KEY,
  pid    INTEGER NOT NULL
)`;

/** Liveness by pid, as the driver lease's: a reused pid holds its job until that process ends. */
export function processJobHolder({ sql, execRaw, transactionSync }: Pick<Storage, 'sql' | 'execRaw' | 'transactionSync'>, proc: LeaseProcess): JobHolder {
  execRaw(JOB_HOLDERS_DDL);

  const hold = (jobId: string): void => {
    void sql`INSERT OR REPLACE INTO background_job_holders (job_id, pid) VALUES (${jobId}, ${proc.pid})`;
  };

  const heldElsewhere = (jobId: string): boolean => sql<{ pid: number }>`SELECT pid FROM background_job_holders WHERE job_id = ${jobId}`
    .some((row) => row.pid !== proc.pid && proc.isAlive(row.pid));

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
