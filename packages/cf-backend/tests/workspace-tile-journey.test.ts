import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * One workspace's tile on its owner's home, followed from install to teardown: the real orchestrator folds its stores
 * and pushes the tile to the owner's object, which refuses, holds or takes each push. Every change reaches it as
 * production makes it: the owner's calls over a tab's socket, an approval ladder parking a command, a child's own
 * turn. Defends: a tile that misses a change, repeats one, reads a run that is not the person's, or a push that is
 * lost when the owner's object is away.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import {
  actorConnectionTag, DeviceConsentStore, JsonValueSchema, PlanReviewStore, TURN_AUTHOR_METADATA_KEY, type JsonValue, type WorkspaceOverview,
} from '@kinu.run/core';
import { AwaitedList } from '@kinu.run/test-utils';
import type { Database } from 'bun:sqlite';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';
import { bindAgentSql } from '../src/runtime';
import {
  actorOver, armedWakes, chatSessionTurns, fireSoonestWake, GATEWAY_CATALOG, nextTurn, orchestratorHarness, hostedSubordinateHarness, seedMission,
  until, wakeForDelegatedTask, workspaceFiles, type HarnessOrchestratorAgent, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, stubAiBinding } from './helpers/platform-gateway';

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

const RpcReplySchema = v.looseObject({ id: v.string(), success: v.boolean(), result: v.optional(JsonValueSchema), error: v.optional(JsonValueSchema) });

/** An owner's tab on the workspace, or on one agent's window when `tags` name it: each call is a frame on its socket,
 *  through the workspace's frame gate, answered on it as the SDK answers. */
function ownerTab(agent: HarnessOrchestratorAgent, tags: readonly string[] = []) {
  const replies = new Map<string, v.InferOutput<typeof RpcReplySchema>>();
  const gate = agent.harnessChatGate();
  let calls = 0;

  const wire = socketConnection({
    id: `owner-tab-${crypto.randomUUID()}`, tags: [...tags],
    send: (data: string) => {
      const reply = v.parse(RpcReplySchema, JSON.parse(data));

      replies.set(reply.id, reply);
    },
  });

  return async (method: string, ...args: JsonValue[]): Promise<JsonValue> => {
    const id = `owner-rpc-${String(calls++)}`;

    await gate(wire, JSON.stringify({ type: 'rpc', id, method, args }));
    const reply = replies.get(id);

    if (reply?.success !== true) throw new Error(`${method} was not answered: ${JSON.stringify(reply?.error)}`);

    return reply.result ?? null;
  };
}

const AddedAgentSchema = v.looseObject({ name: v.string(), subordinate: v.looseObject({ actorId: v.string() }) });

const MAPPING = 'Map the failure surface.';

const NOTING = 'Note what the ledger is missing.';

describe("a workspace's tile on its owner's home", () => {
  test('lands though the owner was away, follows work, decisions and children, and drops a child torn down', async () => {
    const tiles = new AwaitedList<WorkspaceOverview>();
    const overviews = tiles.items;
    const refusals: Error[] = [UNAVAILABLE()];
    const owner: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], overviews: tiles, refuseOverviews: refusals };
    // The children's model: each one's turn holds until the suite answers it.
    const scoutAsked = Promise.withResolvers<void>();
    const scoutAnswer = Promise.withResolvers<void>();
    const addedAsked = Promise.withResolvers<void>();
    const addedAnswer = Promise.withResolvers<void>();

    const gateway = stubAiBinding(async (run) => {
      const opening = openingOf(run);

      if (opening.includes(MAPPING)) {
        scoutAsked.resolve();
        await scoutAnswer.promise;
      }

      if (opening.includes(NOTING)) {
        addedAsked.resolve();
        await addedAnswer.promise;
      }

      return chatCompletion(run, 'Noted.');
    });

    const workspace = orchestratorHarness(owner, { aiGateway: gateway });
    const { agent, db } = workspace;
    const tab = ownerTab(agent);
    const last = () => overviews.at(-1);

    agent.harnessInstallCatalog(GATEWAY_CATALOG);

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
      // The approval ladder parks a gated command nobody is there to answer.
      expect(await tab('executeInExecutor', 'workspace', 'npm publish --dry-run')).toMatchObject({ refusal: { reason: 'unavailable' } });
      await until(() => last()?.decisionsWaiting === 2, 'the parked command is pushed');
      // A wake folds again with nothing moved.
      await agent.terminalRetryPass();
      await settled();

      const [pending] = await agent.listPendingConsents();

      if (!pending) throw new Error('expected a pending device consent');
      await tab('resolveDeviceConsent', pending.consentId, 'deny');
      await expect(consent).resolves.toBe('deny');
      const parked = await agent.listDeferredApprovals();

      await tab('decideDeferredApprovals', parked.map((action) => action.id), 'denied');
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

      // Admitted as its hirer's agents tool admits a task; the wake's drain hands it to the child's own chat.
      await wakeForDelegatedTask(workspace, scout.handle.actorId, MAPPING);
      await scoutAsked.promise;
      // The hand-off holds a fiber of this object's open until the child answers, so the tile is waited on as it lands.
      await tiles.until((landed) => landed.at(-1)?.activity === 'working');
      scoutAnswer.resolve();
      await until(() => last()?.activity === 'idle', "the child's closed turn is pushed");

      // The owner adds an agent and asks it something in its own window: its turn reads Working until it answers.
      await tab('setSoul', '# Purpose\n\nKeep the ledger balanced.');
      const added = v.parse(AddedAgentSchema, await tab('createSubordinateAgent'));
      const addedWindow = ownerTab(agent, [actorConnectionTag(added.subordinate.actorId)]);

      await addedWindow('send', NOTING, crypto.randomUUID());
      await addedAsked.promise;
      await until(() => last()?.activity === 'working', "the added agent's turn is pushed");
      addedAnswer.resolve();
      await until(() => last()?.activity === 'idle', "the added agent's answered turn is pushed");

      // No hosted turn submits a plan in this build, so the one the agent holds is the row an earlier build left; the
      // next tick of the wake carries it.
      expect(new PlanReviewStore(bindAgentSql(agent), actorOver(db, added.subordinate.actorId)).submit('default', [{ start: 1, content: '# Repair the ledger' }]).ok).toBe(true);
      await agent.terminalRetryPass();
      await until(() => last()?.decisionsWaiting === 1, "the child's plan is pushed");
      await tab('dismissSubordinate', added.name, false);
      await until(() => last()?.decisionsWaiting === 0, 'the retired child takes its plan from the tile');

      // ── An app the workspace authors shows by its own title and bindings, following its files. ──
      const files = workspaceFiles(agent);

      await files.mkdir('/slates/board', { recursive: true });
      await writeText(files, '/slates/board/package.json', JSON.stringify({ name: 'board', main: 'server.ts', slate: { title: 'First' } }));
      expect((await agent.foldOverview()).slates).toEqual([{ id: 'board', title: 'First', picture: null, bindings: 0, visibility: null }]);
      await writeText(files, '/slates/board/package.json', JSON.stringify({
        name: 'board', main: 'server.ts', slate: { title: 'Renamed', bindings: { NOTES: { kind: 'memory' } } },
      }));
      expect((await agent.foldOverview()).slates).toEqual([{ id: 'board', title: 'Renamed', picture: null, bindings: 1, visibility: null }]);
      await until(() => last()?.slates.at(0)?.title === 'Renamed', 'the renamed app is pushed');

      // Every push so far carried a change: a fold that moved nothing was never sent again.
      expect(overviews.filter((each, at) => at > 0 && JSON.stringify(each) === JSON.stringify(overviews[at - 1]))).toEqual([]);

      // ── Revoked: the owner refuses the workspace's token. Nothing retries it; the next change still pushes. ──
      const pushed = overviews.length;
      // Owed work the journey left (a retired child's settling) may already hold a wake; the refusal adds none.
      const owed = retryWakes(db);

      refusals.push(Object.assign(new Error('Unrecognized workspace capability token.'), { name: 'CapabilityDeniedError', remote: true }));
      await writeText(files, '/slates/board/package.json', JSON.stringify({ name: 'board', main: 'server.ts', slate: { title: 'Ledger' } }));
      await until(() => refusals.length === 0, 'the revoked push is refused');
      await settled();
      expect([overviews.length, retryWakes(db)]).toEqual([pushed, owed]);
      await writeText(files, '/slates/board/package.json', JSON.stringify({ name: 'board', main: 'server.ts', slate: { title: 'Ledger board' } }));
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
