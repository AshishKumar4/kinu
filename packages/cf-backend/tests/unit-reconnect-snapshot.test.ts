/**
 * KINU-N018: a reconnecting tab replaces its steer and branch chips from `getWorkspaceSnapshot`, so the
 * payload must come from durable rows, never RAM (`_pendingBranches`, the steer drain).
 */

import { describe, expect, test, vi } from 'bun:test';
import type { ModelMessage } from 'ai';
import { BRANCH_RATIONALE } from '@kinu.run/core';
import {
  orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns,
  type ActorHarness, type HarnessOrchestratorAgent, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';

const STEER = 'also check staging';

const BRANCH_ID = 'branch-n018';

/** The run carries `BRANCH_RATIONALE`; the chip label is the former. */
const BRANCH_TASK = 'try the coupon path';

/** Projected, not compared whole, so unrelated planes do not rewrite this file. */
function chips(snapshot: {
  pendingSteers: readonly { text: string }[];
  branchRuns: readonly { branchId: string; task: string; status: string }[];
}) {
  return {
    steers: snapshot.pendingSteers.map((steer) => steer.text),
    branches: snapshot.branchRuns.map((run) => `${run.branchId}:${run.status}:${run.task}`),
  };
}

const RUNNING_BRANCH = `${BRANCH_ID}:running:${BRANCH_RATIONALE}`;

/**
 * Seeded through the production seams. `spawnedAt` is stated: the orphan sweep is fenced to heads spawned
 * strictly before the activation, and a same-millisecond seed would race that fence.
 */
async function workspaceWithQueuedWork(
  spawnedAt?: number,
): Promise<ActorHarness<HarnessOrchestratorAgent>> {
  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
  const seeded = orchestratorHarness(userPlane);
  // No live sockets in the harness; the steer's frames are asserted by `unit-mid-turn-steer`.
  Reflect.set(seeded.agent, 'broadcast', () => {});
  // beforeStep refuses without the prepared snapshot beforeTurn writes.
  await chatSessionTurns(seeded.agent).prepare({
    messages: [{ role: 'user', content: 'deploy the api' }, { role: 'assistant', content: 'starting' }],
  });

  await seeded.agent.send(STEER, 'steer-reconnect');

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

async function landQueuedSteers(agent: HarnessOrchestratorAgent): Promise<void> {
  const messages: ModelMessage[] = [{ role: 'user', content: 'deploy the api' }];

  // `addMessages` needs a live Session the harness lacks; the drain's durable DELETE runs either way.
  Reflect.set(agent, 'addMessages', async () => { await Promise.resolve(); });
  await chatSessionTurns(agent).prepare({ messages });
  await chatSessionTurns(agent).step(1, messages);
}

describe('the reconnect snapshot answers from durable rows, not from RAM', () => {
  test('a redial mid-turn is told the queued steer and the running branch', async () => {
    const seeded = await workspaceWithQueuedWork();
    // RAM-only branch with no journal row: the durable read must not offer it.
    seeded.agent.harnessDeclarePendingBranch('branch-ram-only', 'never journalled');

    expect(chips(await seeded.agent.getWorkspaceSnapshot()))
      .toEqual({ steers: [STEER], branches: [RUNNING_BRANCH] });
  });

  test('a fresh activation still reports the steer, with the RAM drain empty', async () => {
    // A new instance over surviving storage: only `pending_steers` can answer.
    const seeded = await workspaceWithQueuedWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([STEER]);
  });

  test('a branch the activation sealed is dropped, not still drawn as running', async () => {
    // A branch head cannot be resumed, so the reconcile seals a reportless one. Spawned before the activation
    // starts: the fence the sweep reads.
    const seeded = await workspaceWithQueuedWork(Date.parse('2026-08-31T00:00:00.000Z'));

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(reconnected.agent.harnessBranchHeadStatus(BRANCH_ID)).toBe('errored');
    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).branches).toEqual([]);
  });

  test('a landed steer and a reported branch leave no chips behind', async () => {
    const seeded = await workspaceWithQueuedWork();
    await landQueuedSteers(seeded.agent);
    seeded.agent.harnessReportBranchHead(BRANCH_ID, 'the coupon path worked');

    expect(chips(await seeded.agent.getWorkspaceSnapshot()))
      .toEqual({ steers: [], branches: [] });
  });

  test('a steer Stop kept stays queued, across the reconnect', async () => {
    // Stop leaves the operator's words queued, so the chip survives; asserted across reactivation.
    const seeded = await workspaceWithQueuedWork();
    await seeded.agent.cancelCurrentWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([STEER]);
  });
});
