/**
 * Staging 2620e7c05, 2026-10-19, eval-coding-1: a preview server the agent ran on the computer outran its call's window
 * into a background shell job, a secret change redeployed the Worker at 18:24:52, and the new activation failed the
 * job ("the workspace restarted before it finished") while the server, in the box's container, went on serving the next
 * calls. A job whose processes the box kept is the workspace's still: it runs until they end, and only then wakes its
 * agent.
 */
import { expect, test } from 'bun:test';
import { BACKGROUND_FIBER_PREFIX, silenceBoundMs } from '@kinu.run/core';
import { handClock, present } from '@kinu.run/test-utils';
import {
  catalogTurn, GATEWAY_CATALOG, gatewayWorkspace, jobsOver, reactivateOrchestratorHarness, seedOrphanFiber, type HarnessActorWorld,
} from './helpers/actor-harness';
import { abandonHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { SERVES_MS, serverBox } from './helpers/server-box';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const WOKEN = /Background shell job (bgjob-[a-z0-9]+) (completed|failed)/;

/** How often a job's runner asks after its work: its context, and the processes of a job it picked up again. */
const JOB_PROBE_MS = silenceBoundMs('job.context_silence_ms') / 4;


test('a computer shell job whose server outlived a restart of the workspace runs on until the server exits', async () => {
  const clock = handClock(Date.now());
  const box = serverBox(clock);
  const wakes: string[] = [];

  // Main starts the server on the computer; woken by its job, it notes what the wake said.
  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const asked = JSON.stringify([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');

    if (WOKEN.test(asked)) {
      wakes.push(asked);

      return chatCompletion(run, 'Noted.');
    }

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'The server is running in the background.')
      : toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'computer' } }, 'call_server');
  });

  const world: HarnessActorWorld = { container: true, box: () => box, jobClock: clock, previewHostSuffix: 'preview.test' };
  const workspace = gatewayWorkspace(gateway, world);

  // The owner's egress vault is read before a sandbox command runs.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  const turn = catalogTurn(workspace.agent, 'Start the preview server on the computer.');

  // The call's window lapses while the server runs: the call is a job now, and the turn ends.
  await box.served(1);
  clock.tick();
  await turn;
  const jobs = jobsOver(workspace.db);
  const job = present(jobs.runningIds()[0], 'the server job');

  // The Worker is redeployed: the isolate and the job's attempt in it are gone, and a new activation of the same object
  // starts, its box and the server in it still running. The job's fiber is what the platform hands it to recover. Its
  // runner keeps time on a clock of its own, so the waits it arms are counted from none.
  abandonHarnessFibers();
  seedOrphanFiber(workspace.db, `${BACKGROUND_FIBER_PREFIX}shell`, { phase: 'running', jobId: job, kind: 'shell' });
  const jobClock = handClock(clock.now());

  const reopened = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { ...world, jobClock, aiGateway: gateway },
    beforeStart: (agent) => {
      agent.harnessInstallCatalog(GATEWAY_CATALOG);
      agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    },
  });

  // Taken over under a new epoch, the job runs; its attempt watches its context and asks the box after its processes.
  expect({ status: jobs.get(job)?.status, epoch: jobs.get(job)?.epoch, wakes }).toEqual({ status: 'running', epoch: 1, wakes: [] });
  await jobClock.whenArmed(2);

  // The server exits; the next probe finds nothing of the job's running, and the job ends, waking main once.
  clock.advance(SERVES_MS);
  jobClock.advance(JOB_PROBE_MS);
  await reopened.agent.harnessJoinDetachedFibers();
  await reopened.agent.harnessAgentsIdle();

  expect({ status: jobs.get(job)?.status, wakes: wakes.map((wake) => WOKEN.exec(wake)?.slice(1)) })
    .toEqual({ status: 'completed', wakes: [[job, 'completed']] });
});
