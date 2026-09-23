/**
 * KINU-N018: a reconnecting tab replaces its steer and branch chips from `getWorkspaceSnapshot`, so the
 * payload must come from durable rows, never RAM (`_pendingBranches`, the steer drain).
 * The steer is a message sent while a turn runs, the branch a redirect through `branchTurn`, both public;
 * the branch head is the world's.
 */

import { describe, expect, test, vi } from 'bun:test';
import { BRANCH_RATIONALE, branchHeadId } from '@kinu.run/core';
import {
  chatSessionTurns, orchestratorHarness, reactivateOrchestratorHarness, until,
  type ActorHarness, type HarnessOrchestratorAgent, type ScriptedHeadReport,
} from './helpers/actor-harness';

const STEER = 'also check staging';

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

/** The journalled status of a steer branch's one head, as the journal stores it. */
function headStatus(harness: ActorHarness<HarnessOrchestratorAgent>, branchId: string): string | undefined {
  return harness.db.query<{ status: string }, [string]>('SELECT status FROM head_journal WHERE id = ?')
    .get(branchHeadId(branchId))?.status;
}

interface QueuedWork {
  readonly seeded: ActorHarness<HarnessOrchestratorAgent>;
  readonly branchId: string;
  /** Lands the branch head's report; until then it runs. */
  readonly report: (report: ScriptedHeadReport) => void;
}

/**
 * A turn in flight with one steer queued behind it and one steer branch running. `spawnedAt` is stated:
 * the orphan sweep is fenced to heads spawned strictly before the activation, and a same-millisecond
 * seed would race that fence.
 */
async function workspaceWithQueuedWork(spawnedAt?: number): Promise<QueuedWork> {
  const reported = Promise.withResolvers<ScriptedHeadReport>();
  const seeded = orchestratorHarness(undefined, { heads: () => reported.promise });

  await chatSessionTurns(seeded.agent).openInFlight('u-deploy', 'a-deploy');
  await seeded.agent.send(STEER, 'steer-reconnect');

  const clock = spawnedAt === undefined
    ? null
    : vi.spyOn(Date, 'now').mockImplementation(() => spawnedAt);

  try {
    const branch = await seeded.agent.branchTurn(BRANCH_TASK);

    if (!branch.accepted || branch.branchId === undefined) throw new Error(`the branch was refused: ${branch.reason ?? 'no reason'}`);

    return { seeded, branchId: branch.branchId, report: (report) => { reported.resolve(report); } };
  } finally {
    clock?.mockRestore();
  }
}

describe('the reconnect snapshot answers from durable rows, not from RAM', () => {
  test('a redial mid-turn is told the queued steer and the running branch', async () => {
    const { seeded, branchId } = await workspaceWithQueuedWork();

    expect(chips(await seeded.agent.getWorkspaceSnapshot()))
      .toEqual({ steers: [STEER], branches: [`${branchId}:running:${BRANCH_RATIONALE}`] });
  });

  test('a fresh activation still reports the steer, with the RAM drain empty', async () => {
    // A new instance over surviving storage: only `pending_steers` can answer.
    const { seeded } = await workspaceWithQueuedWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([STEER]);
  });

  test('a branch the activation sealed is dropped, not still drawn as running', async () => {
    // A branch head cannot be resumed, so the reconcile seals a reportless one. Spawned before the activation
    // starts: the fence the sweep reads.
    const { seeded, branchId } = await workspaceWithQueuedWork(Date.parse('2026-08-31T00:00:00.000Z'));

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect((await reconnected.agent.getHeadRun(branchId))?.heads.map((head) => head.status)).toEqual(['errored']);
    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).branches).toEqual([]);
  });

  test('a reported branch is no longer drawn, though the turn that launched it still runs', async () => {
    // Until that turn settles the branch is still in the RAM list, so a snapshot read from RAM would draw it.
    const { seeded, branchId, report } = await workspaceWithQueuedWork();

    report({ status: 'completed', summary: 'the coupon path worked' });
    await until(() => headStatus(seeded, branchId) === 'completed', 'the branch head reported');

    expect(chips(await seeded.agent.getWorkspaceSnapshot()).branches).toEqual([]);
  });

  test('a landed steer leaves no chip behind', async () => {
    const { seeded, branchId, report } = await workspaceWithQueuedWork();
    const turns = chatSessionTurns(seeded.agent);
    // The turn's close settles its branches, so the branch reports first.
    report({ status: 'completed', summary: 'the coupon path worked' });
    await until(() => headStatus(seeded, branchId) === 'completed', 'the branch head reported');

    await turns.settle({ messageId: 'a-deploy', text: 'deployed' });
    await turns.runQueuedMessage();

    expect(chips(await seeded.agent.getWorkspaceSnapshot()).steers).toEqual([]);
  });

  test('a steer Stop kept stays queued, across the reconnect', async () => {
    // Stop leaves the operator's words queued, so the chip survives; asserted across reactivation.
    const { seeded } = await workspaceWithQueuedWork();
    await seeded.agent.cancelCurrentWork();

    const reconnected = await reactivateOrchestratorHarness(seeded.db);

    expect(chips(await reconnected.agent.getWorkspaceSnapshot()).steers).toEqual([STEER]);
  });
});
