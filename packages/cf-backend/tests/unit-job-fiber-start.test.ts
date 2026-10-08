// The fiber host refusing a background job's lane row before its body runs: the job settles failed
// through jobs.fiber_start_failed, and no rejection is left unhandled.
import { BackgroundJobRunner } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { describe, test, expect } from 'bun:test';

import { orchestratorHarness } from './helpers/actor-harness';

type HarnessAgent = ReturnType<typeof orchestratorHarness>['agent'];

function jobRunnerOf(agent: HarnessAgent): BackgroundJobRunner {
  for (let prototype = Object.getPrototypeOf(agent); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const runner: unknown = Object.getOwnPropertyDescriptor(prototype, 'jobRunner')?.get?.call(agent);

    if (runner instanceof BackgroundJobRunner) return runner;
  }

  throw new Error('Agent jobRunner getter is missing');
}

describe('the fiber host', () => {
  test('a refused fiber start fails the job with jobs.fiber_start_failed and leaves no rejection unhandled', async () => {
    const recording = createRecordingLogger();
    const unhandled: unknown[] = [];

    const onUnhandled = (...rejected: [unknown]): void => { unhandled.push(rejected[0]); };

    process.on('unhandledRejection', onUnhandled);
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    // Installed after activation, which installs the actor's own sink.
    const restore = setDiagnosticsSink(recording);

    try {
      const runner = jobRunnerOf(agent);
      const id = runner.create('think', { q: 1 }, 'build', new AbortController());
      // The lane's row cannot be written, so the body never runs.
      db.run(`CREATE TRIGGER refuse_job_lanes BEFORE INSERT ON fibers WHEN NEW.name LIKE 'bg:%'
        BEGIN SELECT RAISE(ABORT, 'fibers refused the lane row'); END`);

      expect(() => runner.detach(id, 'think', Promise.resolve('never read'))).not.toThrow();
      await recording.until((lines) => lines.some((line) => line.event === 'jobs.fiber_start_failed'));

      for (let job = await agent.jobResult(id); job?.status === 'running'; job = await agent.jobResult(id)) {
        await new Promise((resolve) => { setImmediate(resolve); });
      }

      const job = await agent.jobResult(id);
      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('fibers refused the lane row');
      expect(recording.emitted.find((line) => line.event === 'jobs.fiber_start_failed')?.cause).toContain('fibers refused the lane row');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      restore();
    }
  });
});
