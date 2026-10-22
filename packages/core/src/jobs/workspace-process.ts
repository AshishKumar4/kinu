/**
 * A workspace's process run as a job (`workspace.startProcess`), as its runners find and cancel it after the workspace
 * object restarted: by the exec id it was started under, which a process Nimbus starts again keeps.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { attempt, KinuError, settle } from '../obs/index';
import { workspaceJobPids, type NimbusSandboxHandle } from '../execution/nimbus';
import type { JsonValue } from '../utils/json';

const WorkspaceProcessJobInput = v.object({ processId: v.string(), machine: v.literal('workspace') });

/** Whether a job is a workspace's process (`startProcessMember` writes its input). */
export function isWorkspaceProcessJob(job: { readonly kind: string; readonly input: JsonValue } | null): boolean {
  return job !== null && job.kind === 'startProcess' && v.is(WorkspaceProcessJobInput, job.input);
}

/** Whether a workspace process job still runs: a process carrying its exec id is running there. */
export async function workspaceProcessJobRuns(box: NimbusSandboxHandle, jobId: string): Promise<boolean> {
  return (await workspaceJobPids(box, jobId)).length > 0;
}

/**
 * A cancelled job that is a workspace's process: each process carrying its exec id is stopped. Its own fiber stops the
 * process it started; this reaches the one a restart started again, which no fiber holds.
 */
export function stopWorkspaceProcessJob(job: { readonly kind: string; readonly input: JsonValue } | null, box: NimbusSandboxHandle, jobId: string): Promise<void> {
  return settle(Effect.gen(function* () {
    if (!isWorkspaceProcessJob(job)) return;
    const kill = box.processes?.kill?.bind(box.processes);

    if (kill === undefined) return yield* new KinuError('unavailable', `the workspace cannot stop the processes of background job ${jobId}`);
    const pids = yield* attempt({ doing: `listing the processes of background job ${jobId}`, otherwise: 'io' }, () => workspaceJobPids(box, jobId));

    for (const pid of pids) yield* attempt({ doing: `stopping process ${String(pid)} of background job ${jobId}`, otherwise: 'io' }, () => kill(pid));
  }));
}
