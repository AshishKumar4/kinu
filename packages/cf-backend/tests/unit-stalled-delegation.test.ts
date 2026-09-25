/**
 * A delegated turn that a reset ends again and again at the same step is not run forever. On kinu.run on
 * 2026-09-25, task-j7gjjr's run held its model wait past the workspace's memory and time limits, was reset, was
 * re-pended by the next recovery, and ran into the same reset: 15 memory resets in a day, every tab's socket
 * dropped with each. Recovery settles a run that got no further than the last as failed, dismisses its lease, and
 * tells a task child's hirer why. Runs here are production's: the delegation drain runs the task, and the next
 * activation over the same rows is the one a reset leaves.
 */
import { expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import {
  GATEWAY_CATALOG, eventsOver, gatewayWorkspace, reactivateOrchestratorHarness, rosterOver, runDelegatedTask,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { chatCompletion, openingOf, stubAiBinding, type StubbedAiBinding } from './helpers/platform-gateway';

const TASK = 'Probe what the stalled run reaches.';

/** Every activation runs the same deployed build, so recovery can verify a claim's program. */
const BUILD = 'build-stalled';

const ReportSchema = v.looseObject({ from_subordinate: v.string(), status: v.string(), content: v.string() });

/** What comes first: `pass` ending, or the task's third run, which waits forever as each run does. */
async function passOrThirdRun(pass: Promise<void>, runs: AwaitedList<number>): Promise<'ended' | 'ran again'> {
  return await Promise.race([
    pass.then(() => 'ended' as const),
    runs.until((seen) => seen.length > 2).then(() => 'ran again' as const),
  ]);
}

/** The next activation over `db`, as a reset leaves it: the task's run of the one before never returns. */
async function afterReset(db: ActorHarness<HarnessOrchestratorAgent>['db'], gateway: StubbedAiBinding): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  return await reactivateOrchestratorHarness(db, undefined, {
    world: { aiGateway: gateway, versionId: BUILD },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

test('a delegated turn whose runs stall at the same step is not run a third time, and its hirer hears why', async () => {
  const runs = new AwaitedList<number>();

  // Every call of the task's run waits forever, as a run a reset ends does; other calls answer.
  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(TASK)) return chatCompletion(run, 'ok');
    runs.push(runs.items.length + 1);

    return new Promise<Response>(() => {});
  });

  const first = gatewayWorkspace(gateway, { versionId: BUILD });

  const child = await first.agent.actorDirectory({
    action: 'register', creationId: 'stalled-proof', name: 'stalled-child', kind: 'subordinate', lifetime: 'task',
  });

  // Hired as the `agents` tool hires: a roster row on the hirer, working on the task.
  rosterOver(first.db).create({
    name: 'stalled-child', actorReference: child.reference, birth: null, deleteRequested: false, createdBy: 'orchestrator',
    status: 'working', currentTask: TASK, createdAt: Date.now(), dismissedAt: null, lifetime: 'task', taskEventId: null,
  });

  // The runs a reset ends: each waits on its model for good.
  const reset = [runDelegatedTask(first, child.reference.actorId, TASK)];
  await runs.until((seen) => seen.length === 1);

  const second = await afterReset(first.db, gateway);
  reset.push(second.agent.terminalRetryPass());
  await runs.until((seen) => seen.length === 2);

  const third = await afterReset(first.db, gateway);

  expect(await passOrThirdRun(third.agent.terminalRetryPass(), runs)).toBe('ended');
  const reports = eventsOver(first.db).query({ variant: 'subordinate_report' }).map((event) => v.parse(ReportSchema, event.payload));
  expect(reports).toEqual([expect.objectContaining({ from_subordinate: 'stalled-child', status: 'blocked' })]);
  expect(reports[0]?.content).toContain('run 2 times');

  // The drain re-pends a lease held past its stale age (10 minutes); a retired one stays retired.
  setSystemTime(new Date(Date.now() + 11 * 60_000));

  try {
    expect(await passOrThirdRun(third.agent.terminalRetryPass(), runs)).toBe('ended');
  } finally {
    setSystemTime();
  }
});
