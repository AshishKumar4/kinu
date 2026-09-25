/**
 * The roster tile a workspace folds over its real stores, and when it pushes it: a change is pushed once,
 * a fold that changed nothing is not pushed at all.
 */
import { sqlOver } from '@kinu.run/test-utils';
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  RunEventRecorder, TURN_AUTHOR_METADATA_KEY, WORKSPACE_RUN_ID, DeferredApprovalStore, formatApproval, type WorkspaceOverview,
} from '@kinu.run/core';
import {
  chatSessionTurns, nextTurn, orchestratorHarness, hostedSubordinateHarness, seedMission, until, workspaceMainActor,
  type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

describe('the folded tile', () => {
  test('a quiet workspace reads as no decisions, idle, no run', async () => {
    const { agent } = orchestratorHarness();

    const overview = await agent.foldOverview();

    expect(overview.decisionsWaiting).toBe(0);
    expect(overview.hasUpdates).toBe(false);
    expect(overview.activity).toBe('idle');
    expect(overview.latestRun).toBeNull();
  });

  test('a pending consent and a parked command both wait on the owner', async () => {
    const { agent, db } = orchestratorHarness();

    const consent = agent.awaitDeviceConsent({
      deviceId: 'dev-1', deviceLabel: 'device', method: 'shell', command: 'git push',
    });

    const parked = new DeferredApprovalStore(sqlOver(db), workspaceMainActor(db)).create({
      id: `defer-${crypto.randomUUID()}`,
      command: 'bun run deploy',
      executor: 'workspace',
      reason: formatApproval({ decision: 'gate', hits: [] }),
      requestedAt: Date.now(),
    });

    expect(parked.status).toBe('queued');
    const overview = await agent.foldOverview();

    expect(overview.decisionsWaiting).toBe(2);
    expect(overview.hasUpdates).toBe(false);

    const [pending] = await agent.listPendingConsents();

    if (!pending) throw new Error('expected a pending device consent');
    await agent.resolveDeviceConsent(pending.consentId, 'deny');
    await expect(consent).resolves.toBe('deny');
  });

  test('a live turn on a hosted child reads working', async () => {
    const workspace = orchestratorHarness();
    const { agent } = workspace;

    const { actor } = await hostedSubordinateHarness(workspace, {
      name: 'scout', displayName: 'Scout', nameOrigin: 'user', mission: 'map the failure surface',
    });

    const lease = actor.session.beginTurn({ runId: 'child-run', turnId: 'child-turn' }, 'build', Date.now());

    try {
      expect((await agent.foldOverview()).activity).toBe('working');
    } finally {
      actor.session.finishTurn(lease);
    }

    expect((await agent.foldOverview()).activity).toBe('idle');
  });

  test('the newest run\'s end and the person\'s newest words are the card line; the reserved aggregate is skipped', async () => {
    const { agent, db } = orchestratorHarness();
    const recorder = new RunEventRecorder(sqlOver(db), workspaceMainActor(db));

    const asked = (text: string) => ({
      type: 'run_start' as const, agentId: 'main', userMessage: text,
      turn: { turnId: `turn-${text}`, messageId: `msg-${text}`, kind: 'user' as const, text },
    });

    recorder.emit('run-older', asked('first task'));
    recorder.emit('run-older', { type: 'run_end', reason: 'completed' });
    recorder.emit('run-newer', asked('latest task'));
    recorder.emit('run-newer', { type: 'run_end', reason: 'error' });
    // The reserved between-run aggregate is not a run and must never lead the card.
    recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'agent' });

    const overview = await agent.foldOverview();

    expect(overview.latestRun).toEqual({ status: 'error', task: 'latest task' });
  });

  test('a live turn beside a completed last run reads working, and the run line is the live run', async () => {
    const { agent, db } = orchestratorHarness();
    const recorder = new RunEventRecorder(sqlOver(db), workspaceMainActor(db));

    recorder.emit('run-1', { type: 'run_start', agentId: 'main', userMessage: 'done' });
    recorder.emit('run-1', { type: 'run_end', reason: 'completed' });
    // A live turn is an open, unsealed run in the ledger: no status yet.
    await agent.declareTurnInFlight(true);

    const overview = await agent.foldOverview();

    expect(overview.activity).toBe('working');
    expect(overview.latestRun).toEqual({ status: null, task: 'a live turn' });

    await agent.declareTurnInFlight(false);
    expect((await agent.foldOverview()).latestRun).toEqual({ status: 'completed', task: 'a live turn' });
  });
});

describe("the card line is the person's own words", () => {
  const MISSION = 'Keep the ledger balanced and flag anything odd.';

  test('never the first turn the harness takes, and the words the owner sends, however they arrive', async () => {
    const { agent, db } = orchestratorHarness();
    seedMission(db, MISSION);
    const turns = chatSessionTurns(agent);
    const genesis = turns.park();

    expect(await agent.beginGenesisTurn()).toEqual({ started: true });
    await genesis;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    expect((await agent.foldOverview()).latestRun).toEqual({ status: 'completed', task: null });

    await turns.run("Sort this week's receipts into the ledger");
    expect((await agent.foldOverview()).latestRun?.task).toBe("Sort this week's receipts into the ledger");

    // What the owner types while a turn runs is queued as a programmatic turn, stamped theirs.
    await turns.enqueue('And flag anything over $500', { metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator' } });
    await turns.drainEnqueued();
    expect((await agent.foldOverview()).latestRun?.task).toBe('And flag anything over $500');

    // A drain, a wake or a gate after it leaves the owner's words on the card.
    await turns.enqueue('Two background jobs finished.', { metadata: { kinuEvent: 'background_jobs' } });
    await turns.drainEnqueued();
    expect((await agent.foldOverview()).latestRun).toEqual({ status: 'completed', task: 'And flag anything over $500' });
  });
});

/** The owed-work wake rows armed now. */
async function retryWakes(agent: ReturnType<typeof orchestratorHarness>['agent']) {
  return (await agent.listSchedules()).filter((row) => row.callback === '_kinuTerminalRetryTick');
}

describe('the pushed tile', () => {
  /** A recording owner object; only the tiles this workspace pushes are read. */
  function recordingOwner() {
    const overviews: WorkspaceOverview[] = [];
    const plane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], overviews };

    return { plane, overviews };
  }

  test('a change is pushed once, and a fold that changed nothing is not pushed again', async () => {
    const { plane, overviews } = recordingOwner();
    const { agent } = orchestratorHarness(plane);

    const consent = agent.awaitDeviceConsent({
      deviceId: 'dev-1', deviceLabel: 'device', method: 'shell', command: 'git push',
    });

    await until(() => overviews.length === 1, 'the raised consent is pushed');
    // A wake folds again with nothing moved, so the next push is the next change.
    await agent.terminalRetryPass();
    const [pending] = await agent.listPendingConsents();

    if (!pending) throw new Error('expected a pending device consent');
    await agent.resolveDeviceConsent(pending.consentId, 'deny');
    await consent;
    await until(() => overviews.at(-1)?.decisionsWaiting === 0, 'the resolved consent is pushed');
    expect(overviews.map((each) => each.decisionsWaiting)).toEqual([1, 0]);
  });

  test('a new workspace reports its first tile once its capability is installed, with nothing else happening', async () => {
    const { plane, overviews } = recordingOwner();
    const { agent } = orchestratorHarness(plane);

    await agent.installWorkspaceCapability('workspace-capability-token');
    await until(() => overviews.length === 1, 'the first tile is pushed');
    expect(overviews[0]).toMatchObject({ activity: 'idle', decisionsWaiting: 0 });
  });

  test('a refused push is owed: a wake carries its retry, a tick before it is due waits, and the tick once due lands it', async () => {
    const { plane, overviews } = recordingOwner();
    const { agent } = orchestratorHarness({ ...plane, refuseOverviews: [new Error('the owner object is unavailable')] });
    const retryArmed = async (): Promise<boolean> => (await retryWakes(agent)).length > 0;

    try {
      expect(await retryArmed()).toBe(false);
      await agent.installWorkspaceCapability('workspace-capability-token');

      for (let lap = 0; lap < 100 && !await retryArmed(); lap++) await nextTurn();
      expect(await retryArmed()).toBe(true);

      await agent.terminalRetryPass();

      for (let lap = 0; lap < 20; lap++) await nextTurn();
      expect(overviews).toEqual([]);
      expect(await retryArmed()).toBe(true);

      setSystemTime(new Date(Date.now() + 10 * 60_000));
      await agent.terminalRetryPass();
      await until(() => overviews.length === 1, 'the owed tile lands');
      // The owed push is not the workspace's own work.
      expect(overviews[0]?.activity).toBe('idle');
    } finally {
      setSystemTime();
    }
  });

  test('a retry in flight owes the wake its failure would arm, not one at once', async () => {
    const { plane, overviews } = recordingOwner();
    const hold = Promise.withResolvers<void>();
    const owner = { ...plane, refuseOverviews: [new Error('the owner object is unavailable')], holdOverviews: Promise.resolve() };
    const { agent } = orchestratorHarness(owner);

    try {
      await agent.installWorkspaceCapability('workspace-capability-token');

      for (let lap = 0; lap < 100 && (await retryWakes(agent)).length === 0; lap++) await nextTurn();
      owner.holdOverviews = hold.promise;
      setSystemTime(new Date(Date.now() + 10 * 60_000));
      // The due retry starts its push, which the owner's object holds.
      await agent.terminalRetryPass();

      // The next tick, as the runtime runs it: the row that fired is gone.
      for (const row of await retryWakes(agent)) await agent.cancelSchedule(row.id);
      await agent.terminalRetryPass();
      const [next] = await retryWakes(agent);
      expect((next?.time ?? 0) * 1000).toBeGreaterThanOrEqual(Date.now() + 3_000);

      hold.resolve();
      await until(() => overviews.length === 1, 'the held push lands');
    } finally {
      setSystemTime();
    }
  });

  test('a push the owner refuses arms no wake, and the next change pushes the tile', async () => {
    const { plane, overviews } = recordingOwner();
    // A revoked token, as the owner's object's refusal arrives across its RPC.
    const denied = Object.assign(new Error('CapabilityDeniedError: Unrecognized workspace capability token.'), { remote: true });
    const refusals = [denied];
    const { agent } = orchestratorHarness({ ...plane, refuseOverviews: refusals });

    await agent.installWorkspaceCapability('workspace-capability-token');
    await until(() => refusals.length === 0, 'the push is refused');

    for (let lap = 0; lap < 20; lap++) await nextTurn();
    expect(await retryWakes(agent)).toEqual([]);
    expect(overviews).toEqual([]);

    await agent.requestOverviewPush();
    await until(() => overviews.length === 1, 'the next change pushes');
  });

  test('a turn reads Working from its admission until its leftovers close, then the tile it leaves', async () => {
    const { plane, overviews } = recordingOwner();
    const { agent } = orchestratorHarness(plane);

    await agent.declareTurnInFlight(true);
    await until(() => overviews.at(-1)?.activity === 'working', 'the admitted turn is pushed');

    await agent.declareTurnInFlight(false);
    await until(() => overviews.at(-1)?.activity === 'idle', 'the quiet workspace is pushed');
    expect(overviews.at(-1)?.latestRun).toEqual({ status: 'completed', task: 'a live turn' });
    // The auto title closing after the answer is the turn's own work, never a durable leftover.
    expect(overviews.map((each) => each.activity)).not.toContain('unfinished');
  });
});
