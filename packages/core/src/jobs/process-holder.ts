/** Which local process runs each job: a job a live process runs is not a starting process's orphan. */

import type { LeaseProcess } from '../execution/driver-lease';
import type { Storage } from '../types/primitives';
import type { JobHolder } from './runner';

const JOB_HOLDERS_DDL = `CREATE TABLE IF NOT EXISTS background_job_holders (
  job_id TEXT PRIMARY KEY,
  pid    INTEGER NOT NULL
)`;

/** Liveness by pid, as the driver lease's: a reused pid holds its job until that process ends. */
export function processJobHolder({ sql, execRaw }: Pick<Storage, 'sql' | 'execRaw'>, proc: LeaseProcess): JobHolder {
  execRaw(JOB_HOLDERS_DDL);

  return {
    hold: (jobId) => {
      void sql`INSERT OR REPLACE INTO background_job_holders (job_id, pid) VALUES (${jobId}, ${proc.pid})`;
    },
    heldElsewhere: (jobId) => sql<{ pid: number }>`SELECT pid FROM background_job_holders WHERE job_id = ${jobId}`
      .some((row) => row.pid !== proc.pid && proc.isAlive(row.pid)),
  };
}
