/**
 * Main's queue, 2026-10-02: a running job's output reached no one until it settled, so a long build showed nothing in
 * the UI until it finished. The room's workspace shell streams a job's command into the job's feed, and the room sends
 * each window to its sockets before the job settles. The feed's windows and its listing tail are core's
 * (`unit-exec-detach-ceiling.test.ts`); this pins the room's half over the real hosted Nimbus runtime.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobOutputFrameSchema, type JobOutputFrame } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

const { jobsOver, orchestratorHarness } = await import('./helpers/actor-harness');

/** Each stream's text, in the order the frames carried it. */
function printed(frames: readonly JobOutputFrame[]) {
  const streams = { stdout: '', stderr: '' };

  for (const { chunks } of frames) for (const { stream, text } of chunks) streams[stream] += text;

  return streams;
}

test("a job's workspace command prints to the room's sockets, frame by frame, and leaves no tail once it settled", async () => {
  const { agent, db } = orchestratorHarness();
  const jobs = jobsOver(db);
  const command = "printf 'compiled 1\\n'; printf 'warn: chunk size\\n' >&2; printf 'built\\n'";
  jobs.create({ id: 'bgjob-build', kind: 'shell', workMode: 'build', now: Date.now(), label: 'workspace: build', input: JSON.stringify({ command, why: 'build' }) });
  jobs.fail('bgjob-build', 0, 'the first run was interrupted', Date.now());

  const sent: string[] = [];
  Reflect.set(agent, 'broadcast', (payload: string) => { sent.push(payload); });

  const retried = await agent.retryBackgroundJob('bgjob-build');
  expect(retried).toMatchObject({ ok: true });
  const jobId = retried.jobId ?? '';

  await agent.harnessJoinDetachedFibers();

  const frames = sent.flatMap((payload) => {
    const frame = v.safeParse(JobOutputFrameSchema, JSON.parse(payload));

    return frame.success ? [frame.output] : [];
  });

  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.jobId === jobId)).toBe(true);
  expect(frames.map(({ seq }) => seq)).toEqual(frames.map((_, index) => index + 1));
  expect(printed(frames)).toEqual({ stdout: 'compiled 1\nbuilt\n', stderr: 'warn: chunk size\n' });
  expect(jobs.get(jobId)?.status).toBe('completed');
  // Nothing of the job's output is left to read once it settled.
  expect((await agent.listBackgroundJobs()).find((job) => job.id === jobId)?.output).toBeUndefined();
});
