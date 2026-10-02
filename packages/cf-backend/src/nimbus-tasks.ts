/**
 * Nimbus's hosted-runtime tasks as Lifecycle jobs: each runs on an alarm, in an invocation of its own, and a pending
 * deadline holds no timer that keeps an idle object awake (a 10-minute log-janitor timer did, Nimbus 63af9605).
 */
import {
  LifecycleCapability, type DurableObjectCapability, type LifecycleJobContext, type LifecycleJobOutcome,
} from 'agents/lifecycle';
import type { HostedRuntimeTask } from '@nimbus-sh/worker/workspace-host';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

/** The record type fails the build when Nimbus adds a task. */
const TASKS: Readonly<Record<HostedRuntimeTask, true>> = {
  'resident-launch': true, 'resident-keepalive': true, 'log-flush': true, 'log-janitor': true,
};

function isTask(fn: string): fn is HostedRuntimeTask {
  return Object.hasOwn(TASKS, fn);
}

export class NimbusTasks extends LifecycleCapability {
  readonly #run: (task: HostedRuntimeTask) => Promise<void>;

  constructor(run: (task: HostedRuntimeTask) => Promise<void>) {
    super('nimbus-tasks');
    this.#run = run;
  }

  async schedule(task: HostedRuntimeTask, at: number): Promise<void> {
    await this.lifecycle.jobs.push({ id: task, fn: task, time: at });
  }

  async cancel(task: HostedRuntimeTask): Promise<void> {
    await this.lifecycle.jobs.cancel(task);
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (isTask(job.fn)) await this.#run(job.fn);

    return undefined;
  }

  /** Nimbus re-arms each task from the activity it watches, so a failed one ends. */
  readonly onJobError: NonNullable<DurableObjectCapability['onJobError']> = ({ job }, cause) => {
    diagnostics.failure('workspace.nimbus_task_failed', toKinuError({ doing: `running Nimbus's ${job.fn} task`, cause, otherwise: 'io' }), { task: job.fn });
  };
}
