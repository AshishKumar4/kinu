/**
 * Production crafted-harbor-37f29697, 2026-10-16: the agent's `eval` program `return await agents ? undefined :
 * undefined;` detached into a job at 02:00:45 and never settled. Every program namespace was a thenable, so the await
 * called `agents.then` as a member and waited on callbacks nothing called; the job's fiber kept the object awake all
 * night, and the restart at 14:33:41 settled it 12.5 h later. Its card was titled with the program's code, and said
 * "Interrupted and re-driven once. The work was not lost." beside the error that it could not be re-driven.
 */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BACKGROUND_FIBER_PREFIX } from '@kinu.run/core';
import type { BackgroundJob } from '@kinu.run/core/protocol';
import { handClock, present } from '@kinu.run/test-utils';
import { JobCard } from '../src/components/surfaces/work-jobs';
import { harnessFibersRunning } from './helpers/agents-sdk';
import { catalogTurn, gatewayWorkspace, jobsOver, orchestratorHarness, seedOrphanFiber } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const PROGRAM = 'return await agents ? undefined : undefined;';

/** The job's Work card, as the owner's page renders it. */
function card(job: BackgroundJob): string {
  return renderToStaticMarkup(createElement(JobCard, { job, onRefresh: () => {}, rpc: async () => { throw new Error('a rendered card calls nothing'); } }));
}

/** The answers a model call read back from its tool calls. */
const toolAnswers = (run: RecordedGatewayRun): string[] => requestOf(run).messages
  .filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content));

test("an eval job found running at a restart ends at once as failed, named by its intent, with one account of what happened", async () => {
  const { agent, db } = orchestratorHarness();
  const jobs = jobsOver(db);
  const jobId = 'bgjob-y17syfzu9d3ivg7h0jkvr';

  // As the production row was written before this fix: labelled with its code.
  jobs.create({ id: jobId, kind: 'eval', workMode: 'build', input: JSON.stringify({ code: PROGRAM }), now: Date.now(), label: PROGRAM });
  seedOrphanFiber(db, `${BACKGROUND_FIBER_PREFIX}eval`, { phase: 'running', jobId, kind: 'eval' });

  await agent.activateActor();
  await agent.harnessJoinDetachedFibers();
  const job = present(jobs.get(jobId), 'the job');

  expect(job).toMatchObject({
    status: 'failed', epoch: 0,
    error: 'the workspace restarted before it finished: this kind of work cannot pick up where it left off, and it had produced nothing to keep',
  });
  expect(card(job)).not.toContain('re-driven');
  expect(card(job)).not.toContain('not lost');
});

/**
 * `code`, the program an agent's chat turn runs, outlasting its call's window into a job: the job as its workspace
 * lists it, and the workspace, whose `cancelBackgroundJob` stops it.
 */
async function detachedProgram(code: string) {
  const gateway = stubAiBinding((run) => (toolAnswers(run).length === 0 && JSON.stringify(requestOf(run).messages).includes('Run the program')
    ? toolCallCompletion(run, { tool: 'eval', args: { code } }, 'call_program')
    : chatCompletion(run, 'Noted.')));

  const clock = handClock(Date.now());
  const workspace = gatewayWorkspace(gateway, { jobClock: clock });
  const turn = catalogTurn(workspace.agent, 'Run the program.');

  // The call's window ends, and its program detaches into a job.
  await clock.whenArmed(1);
  clock.tick();
  await turn;
  const [listed] = await workspace.agent.listBackgroundJobs(20);

  return { workspace, job: present(listed, 'the detached job') };
}

test("a program's job is titled by the intent its first line declares, else as a tool program, never by its code", async () => {
  const titles: (string | null | undefined)[] = [];

  // Each outlasts its call's window: the first declares its intent, the second opens with code.
  for (const code of ['// rank the designs\nawait new Promise(() => {});', 'await agents;\nawait new Promise(() => {});']) {
    const { workspace, job } = await detachedProgram(code);

    titles.push(job.label);
    await workspace.agent.cancelBackgroundJob(job.id);
    await workspace.agent.harnessJoinDetachedFibers();
  }

  expect(titles).toEqual(['rank the designs', 'A tool program']);
});

test('a program waiting on what never settles shows the owner a Stop, and stopping it ends its hold on the object', async () => {
  const { workspace, job } = await detachedProgram('// wait on nothing\nawait new Promise(() => {});');

  expect(job.status).toBe('running');
  expect(card(job)).toContain('Cancel');
  expect(harnessFibersRunning(workspace.agent)).toBe(true);

  expect(await workspace.agent.cancelBackgroundJob(job.id)).toEqual({ ok: true });
  await workspace.agent.harnessJoinDetachedFibers();
  expect((await workspace.agent.listBackgroundJobs(20))[0]?.status).toBe('cancelled');
  expect(harnessFibersRunning(workspace.agent)).toBe(false);
});

test('a settled card speaks only through its recorded outcome; the re-driven note is for a job still running', () => {
  const base: BackgroundJob = {
    id: 'bgjob-redriven', kind: 'agents', label: 'search: rank the designs', workMode: 'build', status: 'running', result: null, error: null,
    createdAt: Date.now() - 60_000, settledAt: null, epoch: 1, retriedBy: null, attemptStartedAt: Date.now(), resumeAfter: null, serves: null,
    output: { seq: 0, chunks: [], omitted: 0 },
  };

  expect(card(base)).toContain('Interrupted and re-driven once.');
  expect(card({ ...base, status: 'failed', error: 'the branch budget was rejected', settledAt: Date.now() })).not.toContain('re-driven');
});
