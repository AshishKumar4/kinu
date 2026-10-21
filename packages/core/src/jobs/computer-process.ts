/**
 * A computer's process run as a job (`computer.startProcess`), as its workspace's runners resume and cancel it.
 */
import { Effect } from 'effect';
import { attempt, KinuError, settle } from '../obs/index';
import { computerProcessJob, type ComputerProcessEnd, type SandboxHandle } from '../execution/sandbox';
import type { JsonValue } from '../utils/json';
import { JobNotResumable, type JobResumer } from './runner';

/**
 * A computer's process runs on in its box across its workspace object's restart: its job is resumed by waiting for the
 * end its box tells (`ended`), starting nothing.
 */
export function computerProcessResume(ended: (jobId: string) => Promise<ComputerProcessEnd>): JobResumer {
  return {
    resumes: (kind, input) => computerProcessJob(kind, input) !== null,
    redrive: (kind, input) => settle(Effect.gen(function* () {
      const process = computerProcessJob(kind, input);

      if (process === null) return yield* Effect.die(new JobNotResumable(kind));
      const end = yield* Effect.promise(() => ended(process.job));

      return { processId: process.processId, ...end };
    })),
  };
}

/**
 * A cancelled job that is a computer's process: its box stops it, or the cancel fails and the job keeps running. `job`
 * is its row as the workspace's one job table holds it, whichever actor's it is.
 */
export function stopComputerProcessJob(job: { readonly kind: string; readonly input: JsonValue } | null, box: SandboxHandle | null, jobId: string): Promise<void> {
  return settle(Effect.gen(function* () {
    const process = job === null ? null : computerProcessJob(job.kind, job.input);

    if (process === null || box === null) return;
    const { stopped } = yield* attempt({ doing: `stopping process ${process.processId} of background job ${jobId}`, otherwise: 'io' }, () => box.stopSupervisedProcess(process.processId));

    if (!stopped) return yield* new KinuError('unavailable', `the computer did not stop process ${process.processId} of background job ${jobId}`);
  }));
}

