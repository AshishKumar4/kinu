/**
 * KINU-N018: what a reconnecting tab is told about queued steers and running
 * branches, driven through the mount round trip itself.
 *
 * `getWorkspaceSnapshot` is the ONE call a tab makes when it opens or
 * reconnects, and the client REPLACES its steer and branch chips from it
 * (`hooks/use-kinu.ts`, `loadAllData`) rather than merging. Replacing is only
 * correct if the payload comes from the durable authorities: a tab that was
 * disconnected must both LEARN the queue it never saw and DROP the chips for
 * work that settled while it was away, and no live broadcast repeats either fact
 * for a socket that was not there.
 *
 * WHAT MAKES EACH CASE BELOW LOAD-BEARING is which source could NOT have
 * answered it:
 *
 *   - the running branch is read on a WARM instance whose `_pendingBranches` is
 *     empty, and beside a branch declared in RAM alone. A payload built from
 *     those handles — the shape the field's own comment warns against — returns
 *     the wrong set both ways round.
 *   - the queued steer is read on a FRESH activation over the storage that
 *     survived, where the RAM drain is empty by construction. That is what an
 *     eviction, a deploy supersede and a corpse redial all leave behind, and a
 *     payload assembled from the drain answers nothing there.
 *
 * `unit-snapshot-contract.test.ts` holds the other half of this seam by
 * derivation: the client's declared field set against the server's returned
 * keys, and the gallery stub against both. It reads source, so it cannot say
 * where a value came from — which is what this file measures.
 */

import { describe, expect, test, vi } from 'bun:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrepareStepContext } from '@cloudflare/think';
import { BRANCH_RATIONALE } from '@kinu.run/core';
import {
  orchestratorHarness, reactivateOrchestratorHarness,
  type ActorHarness, type HarnessOrchestratorAgent, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';

const STEER = 'also check staging';
const BRANCH_ID = 'branch-n018';
/** The redirect a branch head answers. The RUN carries `BRANCH_RATIONALE` and
 *  the head carries this, which is why the chip's label below is the former. */
const BRANCH_TASK = 'try the coupon path';

/** The mount payload's two reconnect-only fields, in the shape the client reads
 *  them: `pendingSteers` becomes the steer chips and `branchRuns` the branch
 *  ones. Projected rather than compared whole, so a change to an unrelated
 *  plane — tools, executors, presence — does not rewrite this file. */
function chips(snapshot: {
  pendingSteers: readonly { text: string }[];
  branchRuns: readonly { branchId: string; task: string; status: string }[];
}) {
  return {
    steers: snapshot.pendingSteers.map((steer) => steer.text),
    branches: snapshot.branchRuns.map((run) => `${run.branchId}:${run.status}:${run.task}`),
  };
}

/** The one branch chip a running redirect produces. */
const RUNNING_BRANCH = `${BRANCH_ID}:running:${BRANCH_RATIONALE}`;

/**
 * A workspace with one acknowledged steer and one running branch, both written
 * through the production seams that own them.
 *
 * The steer goes through `steerTurn`, the RPC the composer calls, which refuses
 * unless a turn is genuinely in flight with a durable identity — so the row it
 * writes is bound to a real turn rather than inserted beside one. The branch
 * goes through `startBranchHead`, journalled under the DERIVED head id a branch
 * run really uses; a hand-written row would normalise exactly that away.
 * `spawnedAt` states WHEN the branch was spawned, for the one case that turns on
 * it: the activation's orphan sweep is fenced to heads spawned strictly before
 * the activation started, so a suite that seeds and reactivates inside one
 * millisecond would race that fence. The clock is stated rather than slept
 * through — an eviction always has the gap, and a sleep would hide which fact
 * the assertion needs.
 */
async function workspaceWithQueuedWork(
  spawnedAt?: number,
): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
  const seeded = orchestratorHarness(userPlane);
  // The broadcast channel needs a live socket set the harness has none of, and
  // the steer's own frames are asserted by `unit-mid-turn-steer`. What matters
  // here is the row the accept writes.
  Reflect.set(seeded.agent, 'broadcast', () => {});
  seeded.agent.harnessBeginTurn('turn-n018');
  seeded.agent.declareTurnInFlight(true);
  expect(await seeded.agent.steerTurn(STEER)).toEqual({ landed: 'mid-turn' });
  const clock = spawnedAt === undefined
    ? null
    : vi.spyOn(Date, 'now').mockImplementation(() => spawnedAt);
  try {
    await seeded.agent.harnessSpawnBranchHead(BRANCH_ID, BRANCH_TASK, null);
  } finally {
    clock?.mockRestore();
  }
  return seeded;
}

/** The step pipeline's own hook, which is what LANDS a queued steer: the drain
 *  writes the verbatim user row and drops the reservation. Called with the
 *  context `streamText` passes it, so the transition is production's. */
async function landQueuedSteers(agent: HarnessOrchestratorAgent): Promise<void> {
  const messages: ModelMessage[] = [{ role: 'user', content: 'deploy the api' }];
  const context: PrepareStepContext = {
    stepNumber: 1,
    messages,
    steps: [],
    model: new MockLanguageModelV3(),
    experimental_context: undefined,
  };
  // `addMessages` is Think's append-without-a-turn API and needs a live Session,
  // which the harness has none of. The drain's durable half — the DELETE — runs
  // either way, and that is the half a reconnect reads.
  Reflect.set(agent, 'addMessages', async () => { await Promise.resolve(); });
  const prepared = agent.beforeStep(context);
  if (prepared instanceof Promise) await prepared;
}

describe('the reconnect snapshot answers from durable rows, not from RAM', () => {
  test('a redial mid-turn is told the queued steer and the running branch', async () => {
    // The ordinary reconnect: the socket dropped and came back while the object
    // stayed alive, which is what the corpse detector's forced redial produces.
    const seeded = await workspaceWithQueuedWork();
    // A branch that exists in RAM ALONE — no journal row — which is what a
    // handle-derived payload would offer and what the durable read must not.
    seeded.agent.harnessDeclarePendingBranch('branch-ram-only', 'never journalled');

    expect(chips(await seeded.agent.getWorkspaceSnapshot()))
      .toEqual({ steers: [STEER], branches: [RUNNING_BRANCH] });
  });

  test('a fresh activation still reports the steer, with the RAM drain empty', async () => {
    // The eviction, the deploy supersede and the cold redial: a new actor
    // instance over the storage that survived. Nothing in memory can answer
    // this, so a queue the client would otherwise never see again comes back
    // from `pending_steers` alone.
    const seeded = await workspaceWithQueuedWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([STEER]);
  });

  test('a branch the activation sealed is dropped, not still drawn as running', async () => {
    // The other direction of staleness. A branch head cannot be resumed, so the
    // activation's own reconcile seals a reportless one instead of leaving it
    // claiming to execute — and the tab is told exactly that, rather than being
    // handed back a chip for work no isolate is doing.
    // Spawned before this activation starts, which is the fence the sweep reads.
    const seeded = await workspaceWithQueuedWork(Date.parse('2026-08-31T00:00:00.000Z'));

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(reconnected.agent.harnessBranchHeadStatus(BRANCH_ID)).toBe('errored');
    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).branches).toEqual([]);
  });

  test('a landed steer and a reported branch leave no chips behind', async () => {
    // Both settled through their own production path — the step drain for the
    // steer, the head's report for the branch — and both gone from the payload a
    // tab that was away receives.
    const seeded = await workspaceWithQueuedWork();
    await landQueuedSteers(seeded.agent);
    seeded.agent.harnessReportBranchHead(BRANCH_ID, 'the coupon path worked');

    expect(chips(await seeded.agent.getWorkspaceSnapshot()))
      .toEqual({ steers: [], branches: [] });
  });

  test('a steer dropped by Stop leaves no chip, across the reconnect', async () => {
    // Stop hands the operator's words back to the composer, so the queue is
    // empty and the chip goes with it. Asserted across the reactivation because
    // the RAM queue and the SQL rows are cleared by two different lines, and
    // only the durable one survives to answer a reconnect.
    const seeded = await workspaceWithQueuedWork();
    await seeded.agent.cancelCurrentWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([]);
  });
});
