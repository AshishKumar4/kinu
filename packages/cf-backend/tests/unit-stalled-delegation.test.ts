/**
 * A delegated turn that a reset ends again and again at the same step is not run forever. On kinu.run on
 * 2026-09-25, task-j7gjjr's run held its model wait past the workspace's memory and time limits, was reset, was
 * re-pended by the next recovery, and ran into the same reset: 15 memory resets in a day, every tab's socket
 * dropped with each. Recovery settles a run that got no further than the last as failed, dismisses its lease, and
 * tells a task child's hirer why. A run our own deploy ended is no such evidence, and runs again. Runs here are
 * production's: the delegation drain runs the task on its fiber, and the next activation over the same rows is the
 * one a reset or a deploy leaves.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import { DELEGATION_LANE_FIBER } from '../src/fiber-recovery';
import { abandonHarnessFibers } from './helpers/agents-sdk';
import {
  GATEWAY_CATALOG, eventsOver, gatewayWorkspace, nextTurn, reactivateOrchestratorHarness, rosterOver, wakeForDelegatedTask,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { chatCompletion, openingOf, stubAiBinding, type StubbedAiBinding } from './helpers/platform-gateway';

const TASK = 'Probe what the stalled run reaches.';

/** The build every activation runs unless a deploy ships another; recovery verifies a claim's program by it. */
const BUILD = 'build-stalled';

const ReportSchema = v.looseObject({ from_subordinate: v.string(), status: v.string(), content: v.string() });

type Workspace = ActorHarness<HarnessOrchestratorAgent>;

// Every case leaves a run parked for good, whose fiber no later suite may join.
afterEach(() => { abandonHarnessFibers(); });

/** The next activation over `db`, as a reset leaves it on `build`: the task's run of the one before never returns. */
async function afterReset(db: Workspace['db'], gateway: StubbedAiBinding, build = BUILD): Promise<Workspace> {
  abandonHarnessFibers();

  return await reactivateOrchestratorHarness(db, undefined, {
    world: { aiGateway: gateway, versionId: build },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

/**
 * One maintenance pass of `workspace` and the delegation drain it starts, then what comes first: that drain ending, or
 * the task's third run, which waits forever as each run does. Drains a reset left behind stay open, so this pass's
 * drain is any that was not open before it.
 */
async function drainEndsOrThirdRun(workspace: Workspace, runs: AwaitedList<number>): Promise<'ended' | 'ran again'> {
  const drains = () => workspace.agent.harnessOpenFiberRows().filter((row) => row.name === DELEGATION_LANE_FIBER).map((row) => row.id);
  const before = new Set(drains());

  const ended = (async () => {
    await workspace.agent.terminalRetryPass();

    for (let lap = 0; lap < 1000; lap++) {
      if (drains().every((id) => before.has(id))) return 'ended' as const;
      await nextTurn();
    }

    throw new Error('the pass\'s delegation drain never ended and ran nothing');
  })();

  return await Promise.race([ended, runs.until((seen) => seen.length > 2).then(() => 'ran again' as const)]);
}

/** A task child, hired as the `agents` tool hires, whose task's every model call waits forever; others answer. */
async function stalledChild(): Promise<{ first: Workspace; gateway: StubbedAiBinding; runs: AwaitedList<number>; actorId: string }> {
  const runs = new AwaitedList<number>();

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(TASK)) return chatCompletion(run, 'ok');
    runs.push(runs.items.length + 1);

    return new Promise<Response>(() => {});
  });

  const first = gatewayWorkspace(gateway, { versionId: BUILD });

  const child = await first.agent.actorDirectory({
    action: 'register', creationId: 'stalled-proof', name: 'stalled-child', kind: 'subordinate', lifetime: 'task',
  });

  rosterOver(first.db).create({
    name: 'stalled-child', actorReference: child.reference, birth: null, deleteRequested: false, createdBy: 'orchestrator',
    status: 'working', currentTask: TASK, createdAt: Date.now(), dismissedAt: null, lifetime: 'task', taskEventId: null,
  });

  return { first, gateway, runs, actorId: child.reference.actorId };
}

test('a delegated turn whose runs stall at the same step is not run a third time, and its hirer hears why', async () => {
  const { first, gateway, runs, actorId } = await stalledChild();

  // The runs a reset ends: each waits on its model for good, so none is joined.
  await wakeForDelegatedTask(first, actorId, TASK);
  await runs.until((seen) => seen.length === 1);

  const second = await afterReset(first.db, gateway);
  await second.agent.terminalRetryPass();
  await runs.until((seen) => seen.length === 2);

  const third = await afterReset(first.db, gateway);

  expect(await drainEndsOrThirdRun(third, runs)).toBe('ended');
  const reports = eventsOver(first.db).query({ variant: 'subordinate_report' }).map((event) => v.parse(ReportSchema, event.payload));
  expect(reports).toEqual([expect.objectContaining({ from_subordinate: 'stalled-child', status: 'blocked' })]);
  expect(reports[0]?.content).toMatch(/cut off twice at the same step by resets of the workspace.*other work in the workspace/su);

  // The drain re-pends a lease held past its stale age (10 minutes); a retired one stays retired.
  setSystemTime(new Date(Date.now() + 11 * 60_000));

  try {
    expect(await drainEndsOrThirdRun(third, runs)).toBe('ended');
  } finally {
    setSystemTime();
  }
});

test('a delegated turn our own deploys restarted twice runs again, and its hirer hears nothing yet', async () => {
  const { first, gateway, runs, actorId } = await stalledChild();

  await wakeForDelegatedTask(first, actorId, TASK);
  await runs.until((seen) => seen.length === 1);

  // Each next activation runs the build a deploy shipped, which is what restarted it.
  const second = await afterReset(first.db, gateway, 'build-deployed-once');
  await second.agent.terminalRetryPass();
  await runs.until((seen) => seen.length === 2);

  const third = await afterReset(first.db, gateway, 'build-deployed-twice');

  expect(await drainEndsOrThirdRun(third, runs)).toBe('ran again');
  expect(eventsOver(first.db).query({ variant: 'subordinate_report' })).toEqual([]);
});
