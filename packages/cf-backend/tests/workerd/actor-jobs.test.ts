/**
 * Every actor's long command in workerd, through the shipped workspace: a brief starts a command that outruns its window
 * (on a clock the workspace is handed and the test moves) into a job of that actor's own, and from then on every
 * operation on the job reaches the actor's runner. For a hired auditor: its wake carries the result, a restart's
 * re-delivery of that wake wakes it once, its pane cancels and dismisses it, dismissing it stops the job, and a restart
 * that lost the job's fiber still settles it. For a swarm node: the workspace's cancel ends it inside the node's loop.
 * Review of 4028013fc, 2026-10-03 (GrievingGerbil): each of these held only for the root's jobs.
 */

import { abortAllDurableObjects, env } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HOSTED_ACTOR_ID_HEADER, hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG } from '@kinu.run/core';
import { JOB_NOTED, JOB_OUTPUT, type ActorRow } from './hire-shapes';
import { actorWindow } from '../helpers/actor-window';

/** Re-acquired per use: the id survives an eviction, a stub does not. */
const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

const ListedJobsSchema = v.array(v.looseObject({ id: v.string(), status: v.string() }));

const DismissalSchema = v.looseObject({ ok: v.literal(true), name: v.string(), stoppedJobs: v.optional(v.array(v.string())) });

/** A hire's pane: a socket on its workspace, addressed to it as the public route addresses it. */
async function hirePane(workspace: string, hire: ActorRow) {
  const stub = await getAgentByName(env.HIRE_WORKSPACE, workspace);

  return await actorWindow(await stub.fetch(new Request(
    `http://localhost/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(workspace)}/${hostedActorSocketPath(hire.name)}`,
    { headers: { Upgrade: 'websocket', [HOSTED_ACTOR_ID_HEADER]: hire.actorId } },
  )));
}

/** The pane's own listing: what the auditor's view shows of its jobs. */
async function listed(pane: Awaited<ReturnType<typeof hirePane>>, hire: ActorRow) {
  const reply = await pane.call('listBackgroundJobs', [20, hire.name]);

  if (!reply.success) throw new Error(`the auditor's pane could not list its jobs: ${reply.error}`);

  return v.parse(ListedJobsSchema, reply.result);
}

/**
 * The owner asks for an auditor to run the job; the auditor's brief starts the command, and the test lets its window
 * pass. Returns once the auditor's brief turn ended on the job's handle, with the auditor's pane open on it.
 */
async function hiredJob(workspace: string) {
  await probe(workspace).setup(workspace, 'hire-root', 'job');
  await probe(workspace).openHire(workspace, 'Hire an auditor to run the job.');
  // The auditor's call is in its window: the first wait its workspace's job clock was handed.
  await probe(workspace).jobWindowArmed(workspace, 1);
  const hire = (await probe(workspace).observe(workspace)).actors.find((actor) => actor.hired);

  if (hire === undefined) throw new Error('the auditor was not hired');
  const pane = await hirePane(workspace, hire);

  // The brief's turn, opened before the pane was, ends on the job's handle once the window passed.
  await probe(workspace).outrunJobWindow(workspace);
  await pane.turnEnded(1);
  const jobs = await listed(pane, hire);

  expect(jobs).toEqual([expect.objectContaining({ status: 'running' })]);
  const [job] = jobs;

  if (job === undefined) throw new Error('the auditor has no job');

  return { hire, pane, job };
}

/** The auditor's chat as its pane reads it. */
async function chat(workspace: string): Promise<readonly string[]> {
  return (await probe(workspace).observe(workspace)).transcript;
}

describe("a hired agent's job", () => {
  it('wakes the auditor with its result when it ends, and once however often a restart re-delivers the wake', async () => {
    const workspace = 'hire-job-result';
    const { hire, pane, job } = await hiredJob(workspace);

    try {
      await probe(workspace).openJobGate(workspace);
      await pane.turnEnded(2);

      // An auditor has no `agent.jobResult`: the message that woke it is where it reads what its job printed.
      const wake = (await chat(workspace)).filter((line) => line.startsWith('user:') && line.includes(job.id));

      expect(wake).toEqual([expect.stringContaining(JOB_OUTPUT)]);
      expect((await chat(workspace)).at(-1)).toContain(JOB_NOTED);

      // A restart's fiber recovery that finds the job settled re-delivers its wake; the auditor is woken once all the same.
      await probe(workspace).redeliverJobWake(workspace, job.id);

      const admitted = (await probe(workspace).observe(workspace)).log
        .filter((row) => row.actorId === hire.actorId && row.variant === 'subordinate_task' && row.body.includes(job.id));

      expect(admitted).toHaveLength(1);
    } finally {
      pane.close();
    }
  });

  it("is cancelled and dismissed from the auditor's own pane, which acts on no other agent's", async () => {
    const workspace = 'hire-job-pane';
    const { hire, pane, job } = await hiredJob(workspace);

    try {
      // The pane names whose job it acts on, as its listing does; another agent's name is refused at the window.
      expect(await pane.call('cancelBackgroundJob', [job.id, 'another-agent'])).toMatchObject({ success: false });

      expect(await pane.call('cancelBackgroundJob', [job.id, hire.name])).toEqual({ success: true, result: { ok: true } });
      await pane.turnEnded(2);
      expect(await listed(pane, hire)).toEqual([expect.objectContaining({ id: job.id, status: 'cancelled' })]);
      expect((await chat(workspace)).filter((line) => line.startsWith('user:') && line.includes(job.id)))
        .toEqual([expect.stringContaining('CANCELLED')]);

      expect(await pane.call('dismissBackgroundJob', [job.id, hire.name])).toEqual({ success: true, result: { ok: true } });
      expect(await listed(pane, hire)).toEqual([]);
    } finally {
      pane.close();
    }
  });

  it('is stopped before its auditor is dismissed, and the dismissal says so', async () => {
    const workspace = 'hire-job-dismissed';
    const { hire, pane, job } = await hiredJob(workspace);

    pane.close();
    const answer = v.parse(DismissalSchema, JSON.parse(await probe(workspace).dismissAnswer(workspace, hire.name)));

    expect(answer.stoppedJobs).toEqual([job.id]);
    // Its row no longer holds a slot of the workspace's detach cap, and nothing is left to settle it.
    expect((await probe(workspace).jobRows(workspace)).find((row) => row.id === job.id)?.status).toBe('cancelled');
  });

  it("is settled, and its auditor woken, after a restart that lost the job's fiber", async () => {
    const workspace = 'hire-job-restart';
    const { hire, pane, job } = await hiredJob(workspace);

    pane.close();
    // The restart lands where the job's row was written but its fiber row was not.
    expect(await probe(workspace).loseJobFiber(workspace, job.id)).toBe(1);
    await abortAllDurableObjects();
    const reopened = await hirePane(workspace, hire);

    try {
      // The restarted workspace's own maintenance settles it; the turn that wakes the auditor ends on its pane.
      await probe(workspace).reenter(workspace);
      expect((await probe(workspace).jobRows(workspace)).find((row) => row.id === job.id)?.status).toBe('failed');
      await reopened.turnEnded(1);

      expect((await chat(workspace)).filter((line) => line.startsWith('user:') && line.includes(job.id)))
        .toEqual([expect.stringContaining('failed')]);
    } finally {
      reopened.close();
    }
  });
});

const NodeJobSchema = v.object({ actorId: v.string(), status: v.string(), summary: v.string() });

// Every job not the root's was taken for a hire's, so a node's cancel reached a runner that held none of its calls; the
// command lived on, and the node waited on it for good.
it("the workspace's cancel of a swarm node's job ends the node's command, and the node is told", async () => {
  const workspace = 'swarm-job-cancel-workspace';
  const facets = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('swarm-job-cancel'));
  const ran = await facets.swarmJobNode(workspace);

  // The node's call is in its window, the first wait its workspace's job clock was handed; then it outruns it.
  await facets.jobWindowArmed(workspace, 1);
  await facets.outrunJobWindow(workspace);
  const [job] = (await facets.jobRows(workspace)).filter((row) => row.status === 'running');

  if (job === undefined) throw new Error('the node has no running job');
  expect(await facets.cancelJob(workspace, job.id)).toEqual({ ok: true });
  // Told inside its own loop: nothing queued a hired agent's turn for it.
  expect(await facets.taskEvents(workspace, job.actorId)).toBe(0);

  // Woken by the cancel, the node notes it and, holding nothing more, its run ends.
  const seen = v.parse(NodeJobSchema, await new Response(ran).json());

  expect(seen.actorId).toBe(job.actorId);
  expect(seen.summary).toContain(JOB_NOTED);
  expect((await facets.jobRows(workspace)).find((row) => row.id === job.id)?.status).toBe('cancelled');
});
