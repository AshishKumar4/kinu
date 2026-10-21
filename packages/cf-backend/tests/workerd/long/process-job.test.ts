/**
 * A process the workspace's agent starts from a program, `workspace.startProcess`, in workerd through the shipped
 * workspace: a job of the agent's from its start. It runs on after the agent's turn with nobody connected, held by its
 * job's lane, its end completes the job and wakes the agent, and a restart that lost it fails the job and wakes the
 * agent. Idle eviction is staging's to show: workerd here kept the object without a job too (a scratch probe on next-rc,
 * armada 2026-10-20: 30 of 30 lines on one object).
 *
 * Staging rc28 e1bc49749, 2026-10-20 (eval-killn-canary-05rge6): such a process was no job. Nothing held the workspace
 * awake for it, so it stopped with the idle workspace about three minutes after the last turn, after 4 of 180 lines,
 * and with no row nothing told the agent.
 */

import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROCESS_TICKS } from '../hire-shapes';

/** Re-acquired per use: the id survives an eviction, a stub does not. */
const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

/** The owner asks; the agent's program starts the process, and its turn ends. Returns the job the process runs as, and
 *  the object's incarnation then. */
async function started(workspace: string) {
  await probe(workspace).setup(workspace, 'hire-root', 'process');
  await probe(workspace).openHire(workspace, 'Start the tick counter.');
  // Its turn is queued: once the model has read what its program answered, the turn runs and is waited out.
  await probe(workspace).callerObserved();
  await probe(workspace).settled(workspace);
  const watch = await probe(workspace).jobWatchState(workspace);

  expect(watch).toMatchObject({ fibers: 1, jobs: [expect.objectContaining({ status: 'running' })] });
  const [job] = watch.jobs;

  if (job === undefined) throw new Error('the process is no job');

  return { job, incarnation: watch.incarnation };
}

describe('a process the agent starts', () => {
  it('runs on after its turn with nobody connected, held by its job, and its end wakes the agent', async () => {
    const workspace = 'process-job-ends';
    const { job, incarnation } = await started(workspace);

    // Nothing addresses the workspace from here: a passive witness outside it waits for the wake its job's end sends.
    await probe(workspace).modelSaw(workspace, [`Background startProcess job ${job.id}`]);

    const after = await probe(workspace).jobWatchState(workspace);

    // The same object throughout, never restarted.
    expect({ incarnation: after.incarnation, job: after.jobs.find((row) => row.id === job.id)?.status })
      .toEqual({ incarnation, job: 'completed' });
    expect(await probe(workspace).processTicks(workspace)).toEqual(Array.from({ length: PROCESS_TICKS }, (_, n) => String(n + 1)));
  });

  it('lost to a restart, fails its job, and the agent is woken without a client', async () => {
    const workspace = 'process-job-restart';
    const { job } = await started(workspace);

    await abortAllDurableObjects();

    // A passive witness outside the workspace reads what the restart did; it does not address the workspace.
    await probe(workspace).modelSaw(workspace, [`Background startProcess job ${job.id} failed`, 'the workspace restarted before it finished']);

    expect((await probe(workspace).jobRows(workspace)).find((row) => row.id === job.id)?.status).toBe('failed');
  });
});
