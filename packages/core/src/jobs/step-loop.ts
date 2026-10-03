import * as v from 'valibot';
import type { HostedActor } from '../state/actor-host';
import { BackgroundJobRunner, wakeText, type BackgroundJobRunnerDeps, type WorkspaceJobPorts } from './runner';
import { initBackgroundJobsTable } from './store';
import type { BackgroundPolicy } from './threshold';
import { AgentWakeQueue } from './wake-queue';

const WakeJobSchema = v.object({ jobId: v.string() });

/** A node's or seated head's own jobs, woken in process; `next` is its loop's resume. */
export function stepLoopJobs(input: {
  readonly actor: HostedActor;
  readonly ports: WorkspaceJobPorts;
  readonly policy?: (() => BackgroundPolicy) | undefined;
  readonly logActivity?: ((event: string, detail?: string) => void) | undefined;
}) {
  const wakes = new AgentWakeQueue();
  const store = input.actor.stores.jobs;
  // Nothing guarantees this actor's jobs table was opened before.
  initBackgroundJobsTable(input.actor.runtime.storage.execRaw);

  const deps: BackgroundJobRunnerDeps = {
    ...input.ports,
    store,
    fiber: input.actor.runtime.schedule.fiber.bind(input.actor.runtime.schedule),
    // No `agent.*` here: a settled wake carries the result.
    inbox: {
      send: (signal) => {
        const named = v.safeParse(WakeJobSchema, signal.metadata);
        const job = named.success ? store.get(named.output.jobId) : null;

        return wakes.send(job === null ? signal : { ...signal, text: wakeText(job, 'inline') });
      },
    },
    // No `eventLog`/`scheduleDrain`/`resume`: no later activation delivers.
  };

  // Absent keys stay absent.
  if (input.policy !== undefined) deps.policy = input.policy;

  if (input.logActivity !== undefined) deps.logActivity = input.logActivity;
  const runner = new BackgroundJobRunner(deps);

  return { runner, next: () => wakes.next(() => runner.inFlight > 0) };
}
