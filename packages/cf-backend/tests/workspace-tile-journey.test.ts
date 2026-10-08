import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * One workspace's tile on its owner's home, followed from install to teardown: the real orchestrator folds its stores
 * and pushes the tile to the owner's object, which refuses, holds or takes each push. Defends: a tile that misses a
 * change, repeats one, reads a run that is not the person's, or a push that is lost when the owner's object is away.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  DeferredApprovalStore, DeviceConsentStore, TURN_AUTHOR_METADATA_KEY, createFactsStore, type WorkspaceOverview,
} from '@kinu.run/core';
import type { Database } from 'bun:sqlite';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';
import { bindAgentSql } from '../src/runtime';
import {
  armedWakes, chatSessionTurns, fireSoonestWake, nextTurn, orchestratorHarness, hostedSubordinateHarness, seedMission, until,
  workspaceMainActor, workspaceFiles, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

/** The instants the owed-work wake is armed for. */
function retryWakes(db: Database): number[] {
  return armedWakes(db).filter((wake) => wake.id === TERMINAL_RETRY_JOB).map((wake) => wake.time);
}

/** Enough ticks for a requested push to fold, send and settle. */
async function settled(): Promise<void> {
  for (let lap = 0; lap < 20; lap++) await nextTurn();
}

const UNAVAILABLE = () => new Error('the owner object is unavailable');

describe("a workspace's tile on its owner's home", () => {
  test('lands though the owner was away, follows work, decisions and children, and drops a child torn down', async () => {
    const overviews: WorkspaceOverview[] = [];
    const refusals: Error[] = [UNAVAILABLE()];
    const owner: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], overviews, refuseOverviews: refusals };
    const workspace = orchestratorHarness(owner);
    const { agent, db } = workspace;
    const last = () => overviews.at(-1);

    try {
      // ── Installed while the owner's object is away: the first tile is owed to a wake, not lost. ──
      await agent.installWorkspaceCapability('workspace-capability-token');
      await until(() => retryWakes(db).length > 0, 'the refused first push armed its retry');
      await agent.terminalRetryPass();
      await settled();
      // A tick before the retry is due waits.
      expect(overviews).toEqual([]);

      setSystemTime(new Date(Date.now() + 10 * 60_000));
      await agent.terminalRetryPass();
      await until(() => overviews.length === 1, 'the owed first tile lands');
      expect(last()).toMatchObject({ activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null });

      // ── A turn reads Working from its admission until it closes, never as unfinished. ──
      await agent.declareTurnInFlight(true);
      await until(() => last()?.activity === 'working', 'the admitted turn is pushed');
      expect(last()?.latestRun).toEqual({ status: null, task: 'a live turn' });
      await agent.declareTurnInFlight(false);
      await until(() => last()?.activity === 'idle', 'the closed turn is pushed');
      expect(last()?.latestRun).toEqual({ status: 'completed', task: 'a live turn' });
      expect(overviews.map((each) => each.activity)).not.toContain('unfinished');

      // ── Decisions: each change pushed once, a fold that changed nothing not pushed again. ──
      const before = overviews.length;
      const consent = agent.awaitDeviceConsent({ deviceId: 'dev-1', deviceLabel: 'device', method: 'shell', command: 'git push' });

      await until(() => last()?.decisionsWaiting === 1, 'the raised consent is pushed');
      const approvals = new DeferredApprovalStore(bindAgentSql(agent), workspaceMainActor(db));

      approvals.create({ id: 'deploy', command: 'bun run deploy', executor: 'workspace', reason: 'owner approval', requestedAt: Date.now() }, []);
      await agent.requestOverviewPush();
      await until(() => last()?.decisionsWaiting === 2, 'the parked command is pushed');
      // A wake folds again with nothing moved.
      await agent.terminalRetryPass();
      await settled();

      const [pending] = await agent.listPendingConsents();

      if (!pending) throw new Error('expected a pending device consent');
      await agent.resolveDeviceConsent(pending.consentId, 'deny');
      await expect(consent).resolves.toBe('deny');
      approvals.decide('deploy', 'denied', Date.now());
      await agent.requestOverviewPush();
      await until(() => last()?.decisionsWaiting === 0, 'both decisions are pushed');
      expect(overviews.slice(before, before + 2).map((each) => each.decisionsWaiting)).toEqual([1, 2]);

      // A consent an earlier activation raised expires on its own clock, with no local timer to fire.
      new DeviceConsentStore(bindAgentSql(agent)).insert({
        consentId: 'cold-consent', deviceId: 'device', deviceLabel: 'Laptop', method: 'shell', command: 'git push',
        createdAt: Date.now(), expiresAt: Date.now() + 1_000,
      });
      expect((await agent.foldOverview()).decisionsWaiting).toBe(1);
      setSystemTime(new Date(Date.now() + 1_001));
      expect((await agent.foldOverview()).decisionsWaiting).toBe(0);

      // ── Children: one working reads Working; one torn down takes its pending plan with it. ──
      const { actor: scout } = await hostedSubordinateHarness(workspace, { name: 'scout', displayName: 'Scout', nameOrigin: 'user', mission: 'map the failure surface' });
      const lease = scout.session.beginTurn({ runId: 'child-run', turnId: 'child-turn' }, 'build', Date.now());

      await agent.requestOverviewPush();
      await until(() => last()?.activity === 'working', "the child's turn is pushed");
      scout.session.finishTurn(lease);
      await agent.requestOverviewPush();
      await until(() => last()?.activity === 'idle', "the child's closed turn is pushed");

      const { actor: planner } = await hostedSubordinateHarness(workspace, { name: 'planner', displayName: 'Planner', nameOrigin: 'user', mission: 'prepare a plan' });

      expect(planner.stores.planReviews.submit('default', [{ start: 1, content: '# Repair the ledger' }]).ok).toBe(true);
      await agent.requestOverviewPush();
      await until(() => last()?.decisionsWaiting === 1, "the child's plan is pushed");
      await agent.actorDirectory({ action: 'retire', name: 'planner', reference: planner.reference });
      await agent.requestOverviewPush();
      await until(() => last()?.decisionsWaiting === 0, 'the retired child takes its plan from the tile');

      // ── An app the workspace authors shows by its own title, following its files. ──
      const files = workspaceFiles(agent);

      await files.mkdir('/slates/board', { recursive: true });
      await writeText(files, '/slates/board/package.json', JSON.stringify({ name: 'board', main: 'server.ts', slate: { title: 'First' } }));
      expect((await agent.foldOverview()).slates).toEqual([{ id: 'board', title: 'First', picture: null, visibility: null }]);
      await writeText(files, '/slates/board/package.json', JSON.stringify({ name: 'board', main: 'server.ts', slate: { title: 'Renamed' } }));
      expect((await agent.foldOverview()).slates).toEqual([{ id: 'board', title: 'Renamed', picture: null, visibility: null }]);

      // Every push so far carried a change: a fold that moved nothing was never sent again.
      expect(overviews.filter((each, at) => at > 0 && JSON.stringify(each) === JSON.stringify(overviews[at - 1]))).toEqual([]);

      // ── Revoked: the owner refuses the workspace's token. Nothing retries it; the next change still pushes. ──
      const pushed = overviews.length;
      // Owed work the journey left (a retired child's settling) may already hold a wake; the refusal adds none.
      const owed = retryWakes(db);

      refusals.push(Object.assign(new Error('Unrecognized workspace capability token.'), { name: 'CapabilityDeniedError', remote: true }));
      createFactsStore(bindAgentSql(agent), workspaceMainActor(db)).upsert('preferred_language', 'French');
      await agent.requestOverviewPush();
      await until(() => refusals.length === 0, 'the revoked push is refused');
      await settled();
      expect([overviews.length, retryWakes(db)]).toEqual([pushed, owed]);
      await agent.requestOverviewPush();
      await until(() => overviews.length === pushed + 1, 'the next change pushes');
    } finally {
      setSystemTime();
    }
  });

  test("a retry in flight owes the wake its failure would arm, and the tile lands when the owner's object answers", async () => {
    const overviews: WorkspaceOverview[] = [];

    const hold = Promise.withResolvers<void>();

    const owner: RecordedUserPlaneCalls = {
      warmConnections: [], failWarm: null, titles: [], overviews, refuseOverviews: [UNAVAILABLE()], holdOverviews: Promise.resolve(),
    };

    const { agent, db } = orchestratorHarness(owner);

    try {
      await agent.installWorkspaceCapability('workspace-capability-token');
      await until(() => retryWakes(db).length > 0, 'the refused push armed its retry');
      owner.holdOverviews = hold.promise;
      setSystemTime(new Date(Date.now() + 10 * 60_000));
      // The due retry starts its push, which the owner's object holds; the next tick does not start another.
      await agent.terminalRetryPass();
      await fireSoonestWake(agent, db);
      expect(retryWakes(db)[0] ?? 0).toBeGreaterThanOrEqual(Date.now() + 3_000);

      hold.resolve();
      await until(() => overviews.length === 1, 'the held push lands');
    } finally {
      setSystemTime();
    }
  });
});

describe("the tile's line is the person's own words", () => {
  test('never the first turn the harness takes, and the words the owner sends, however they arrive', async () => {
    const { agent, db } = orchestratorHarness();
    await seedMission({ agent, db }, 'Keep the ledger balanced and flag anything odd.');
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

    // A drain, a wake or a gate after it leaves the owner's words on the line.
    await turns.enqueue('Two background jobs finished.', { metadata: { kinuEvent: 'background_jobs' } });
    await turns.drainEnqueued();
    expect((await agent.foldOverview()).latestRun).toEqual({ status: 'completed', task: 'And flag anything over $500' });
  });
});
