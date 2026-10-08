/**
 * A delegated turn that a reset ends again and again at the same step is not run forever. On kinu.run on
 * 2026-09-25, task-j7gjjr's run held its model wait past the workspace's memory and time limits, was reset, was
 * re-pended by the next recovery, and ran into the same reset: 15 memory resets in a day, every tab's socket
 * dropped with each. A cut in a model wait is not the step's fault, so it takes many (`STALLED_PROVIDER_CUTS`) on one
 * build with no step finishing; then recovery settles the run as failed, dismisses its lease, and tells a task child's
 * hirer why. A run our own deploy ended is no such evidence, and runs again. Runs here are
 * production's: the delegation drain runs the task on its fiber, and the next activation over the same rows is the
 * one a reset or a deploy leaves.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import { STALLED_PROVIDER_CUTS } from '@kinu.run/core';
import { abandonHarnessFibers, joinHarnessFibers } from './helpers/agents-sdk';
import {
  GATEWAY_CATALOG, eventsOver, gatewayWorkspace, reactivateOrchestratorHarness, rosterOver, wakeForDelegatedTask,
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
 * the task's run after the `ran`th, which waits forever as each run does. Each activation drains on its own lane, so a
 * drain a reset left behind is not this one.
 */
async function drainEndsOrRunsAgain(workspace: Workspace, runs: AwaitedList<number>, ran: number): Promise<'ended' | 'ran again'> {
  const ended = (async () => {
    await workspace.agent.terminalRetryPass();
    // The drain runs as a lane, which the fibers join holds.
    await joinHarnessFibers();

    return 'ended' as const;
  })();

  return await Promise.race([ended, runs.until((seen) => seen.length > ran).then(() => 'ran again' as const)]);
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
    action: 'register', creationId: 'stalled-proof', name: 'stalled-child', origin: 'agent', lifetime: 'task',
  });

  rosterOver(first.db).create({
    name: 'stalled-child', actorReference: child.reference, birth: null, deleteRequested: false,
    status: 'working', currentTask: TASK, createdAt: Date.now(), dismissedAt: null, taskEventId: null,
  });

  return { first, gateway, runs, actorId: child.reference.actorId };
}

test('a delegated turn whose model wait a reset ends at one step is settled at the bound, and its hirer hears why', async () => {
  const { first, gateway, runs, actorId } = await stalledChild();
  let at = Date.now();

  // The runs a reset ends: each waits on its model for good, so none is joined.
  await wakeForDelegatedTask(first, actorId, TASK);
  await runs.until((seen) => seen.length === 1);

  try {
    // Each next activation comes past the backoff a repeated cut earns, so it asks again at once.
    for (let run = 2; run <= STALLED_PROVIDER_CUTS; run += 1) {
      at += 120_000;
      setSystemTime(new Date(at));
      const next = await afterReset(first.db, gateway);
      await next.agent.terminalRetryPass();
      await runs.until((seen) => seen.length === run);
    }

    at += 120_000;
    setSystemTime(new Date(at));
    const last = await afterReset(first.db, gateway);

    expect(await drainEndsOrRunsAgain(last, runs, STALLED_PROVIDER_CUTS)).toBe('ended');
    const reports = eventsOver(first.db).query({ variant: 'subordinate_report' }).map((event) => v.parse(ReportSchema, event.payload));
    expect(reports).toEqual([expect.objectContaining({ from_subordinate: 'stalled-child', status: 'blocked' })]);

    // The drain re-pends a lease held past its stale age (10 minutes); a retired one stays retired.
    setSystemTime(new Date(at + 11 * 60_000));
    expect(await drainEndsOrRunsAgain(last, runs, STALLED_PROVIDER_CUTS)).toBe('ended');
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

  // The agent's own chat takes the turn up again on its activation, as a CLI hire's does after a restart.
  await third.agent.terminalRetryPass();
  await runs.until((seen) => seen.length === 3);
  expect(eventsOver(first.db).query({ variant: 'subordinate_report' })).toEqual([]);
});
