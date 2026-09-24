/** Durable work the owner reads and steers: background jobs, timers, and the run log. */
import { expect } from 'bun:test';
import { BackgroundJobStore, RunEventRecorder } from '@kinu.run/core';
import type { SharedCase } from '../cases';

export const WORK_LEDGER_CASES: readonly SharedCase[] = [
  {
    title: 'a running job an earlier activation left can be cancelled once, by the operator',
    covers: ['listBackgroundJobs', 'jobResult', 'cancelBackgroundJob'],
    async run({ surface, sql, actor }) {
      // No live fiber holds it: the row is all this activation knows, as after an eviction.
      new BackgroundJobStore(sql, actor).create({ id: 'job-1', kind: 'shell', workMode: 'build', label: 'build it', now: 1 });

      expect((await surface.listBackgroundJobs(5)).map((job) => [job.id, job.status])).toEqual([['job-1', 'running']]);
      expect(await surface.jobResult('job-1')).toMatchObject({ id: 'job-1', status: 'running', label: 'build it' });

      expect(await surface.cancelBackgroundJob('job-1')).toEqual({ ok: true });
      expect(await surface.jobResult('job-1')).toMatchObject({
        status: 'cancelled', error: 'cancelled by operator', settledAt: expect.any(Number),
      });
      expect(await surface.cancelBackgroundJob('job-1')).toEqual({ ok: false });
      expect(await surface.jobResult('no-such-job')).toBeNull();
    },
  },
  {
    title: 'a timer the owner set is revoked by the owner alone, and only once',
    covers: ['createTimerTrigger', 'cancelTrigger'],
    async run({ surface }) {
      const newYear = Date.UTC(2100, 0, 1);
      const timer = await surface.createTimerTrigger({ atMs: newYear, label: 'new year', trust: 'owner' });
      expect(timer).toEqual({ id: expect.any(String), kind: 'timer_oneshot', nextFireAt: newYear });
      await expect(surface.createTimerTrigger({ cron: 'every full moon' }))
        .rejects.toThrow('Unsupported cron expression: every full moon');

      expect(await surface.cancelTrigger(timer.id, 'self')).toEqual({
        ok: false, changed: false, error: 'this trigger was created by the owner; only the owner can revoke it',
      });
      expect(await surface.cancelTrigger(timer.id, 'owner')).toEqual({ ok: true, changed: true });
      expect(await surface.cancelTrigger(timer.id, 'owner')).toEqual({ ok: true, changed: false });
    },
  },
  {
    title: 'the run log pages newest first and a run reads back its own events',
    covers: ['listRuns', 'getRunEvents'],
    async run({ surface, sql, actor }) {
      const recorder = new RunEventRecorder(sql, actor);

      for (const runId of ['run-a', 'run-b', 'run-c']) {
        recorder.emit(runId, { type: 'run_start', agentId: 'main', userMessage: `do ${runId}` });
        recorder.emit(runId, { type: 'run_end', reason: 'completed' });
      }

      const first = await surface.listRuns({ limit: 2 });
      expect(first.items.map((run) => [run.runId, run.eventCount])).toEqual([['run-c', 2], ['run-b', 2]]);
      expect(first).toMatchObject({ status: 'more', next: { after: 'run-b' } });

      if (first.status !== 'more') throw new Error('a two-run page over three runs has a next page');
      expect((await surface.listRuns({ limit: 2, cursor: first.next })).items[0]?.runId).toBe('run-a');

      // `since` is the first index wanted: a resume passes one past the last index it saw.
      expect(await surface.getRunEvents('run-b', { since: 1 })).toEqual([
        { runId: 'run-b', eventIndex: 1, timestamp: expect.any(String), type: 'run_end', reason: 'completed' },
      ]);
      expect((await surface.getRunEvents('run-b', { types: ['run_start'] })).map((event) => event.type)).toEqual(['run_start']);
    },
  },
];
