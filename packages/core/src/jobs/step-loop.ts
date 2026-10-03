import * as v from 'valibot';
import type { HostedActor } from '../state/actor-host';
import type { AgentInbox } from '../types/signals';
import type { Schedule } from '../types/primitives';
import type { JobAuthority } from './authorities';
import { BackgroundJobRunner, wakeText, type BackgroundJobRunnerDeps, type WorkspaceJobPorts } from './runner';
import { initBackgroundJobsTable, type BackgroundJobStore } from './store';
import type { BackgroundPolicy } from './threshold';
import { AgentWakeQueue } from './wake-queue';

const WakeJobSchema = v.object({ jobId: v.string() });

export interface StepLoopJobSeat {
  readonly ports: WorkspaceJobPorts;
  readonly attach: (authority: JobAuthority) => () => void;
}

export function inlineResultInbox(store: BackgroundJobStore, inbox: AgentInbox): AgentInbox {
  return {
    send: (signal) => {
      const named = v.safeParse(WakeJobSchema, signal.metadata);
      const job = named.success ? store.get(named.output.jobId) : null;

      return inbox.send(job === null ? signal : { ...signal, text: wakeText(job, 'inline') });
    },
  };
}

/** A node's or seated head's own jobs, woken in process; `next` is its loop's resume. */
export function stepLoopJobs(input: {
  readonly actor: HostedActor;
  readonly seat: StepLoopJobSeat;
  readonly policy?: (() => BackgroundPolicy) | undefined;
  readonly logActivity?: ((event: string, detail?: string) => void) | undefined;
}) {
  const wakes = new AgentWakeQueue();
  const store = input.actor.stores.jobs;
  // Nothing guarantees this actor's jobs table was opened before.
  initBackgroundJobsTable(input.actor.runtime.storage.execRaw);

  const deps: BackgroundJobRunnerDeps = {
    ...input.seat.ports,
    store,
    fiber: input.actor.runtime.schedule.fiber.bind(input.actor.runtime.schedule),
    inbox: inlineResultInbox(store, wakes),
    // No `eventLog`/`scheduleDrain`/`resume`: no later activation delivers.
  };

  // Absent keys stay absent.
  if (input.policy !== undefined) deps.policy = input.policy;

  if (input.logActivity !== undefined) deps.logActivity = input.logActivity;
  const runner = new BackgroundJobRunner(deps);
  const detach = input.seat.attach({ kind: 'step-loop', actorId: input.actor.record.actorId, store, runner });

  return { runner, next: () => wakes.next(() => runner.inFlight > 0), detach };
}

export function endedStepLoopJobs(input: {
  readonly actorId: string;
  readonly store: BackgroundJobStore;
  readonly ports: WorkspaceJobPorts;
  readonly fiber: Schedule['fiber'];
}): JobAuthority {
  const runner = new BackgroundJobRunner({
    ...input.ports,
    store: input.store,
    fiber: input.fiber,
    inbox: { send: () => Promise.resolve('undelivered') },
  });

  return { kind: 'step-loop', actorId: input.actorId, store: input.store, runner };
}
