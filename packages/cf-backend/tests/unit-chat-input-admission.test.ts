import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { ActorClaimStore, RunEventRecorder } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import {
  orchestratorHarness, chatSessionTurns, historyOver, reactivateOrchestratorHarness, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

const GENESIS = { role: 'user', content: 'Read your standing brief and ask what to do first.' } satisfies ModelMessage;

type Harness = ActorHarness<HarnessOrchestratorAgent>;

/** The root's turn claims as stored, read through core's claim store. */
function claims(harness: Harness): ActorClaimStore {
  const transactionSync = <T>(write: () => T): T => write();

  return new ActorClaimStore(makeSql(harness.db), workspaceMainActor(harness.db), transactionSync, historyOver(harness));
}

/** An opening turn admitted on a host that stamps no build. */
async function opening(): Promise<Harness> {
  const harness = orchestratorHarness(undefined, { versionId: null });
  await chatSessionTurns(harness.agent).prepare({ messages: [GENESIS] });

  return harness;
}

describe('request-owned chat inputs', () => {

  test('alarm recovery still classifies a genuinely idle unverified root claim', async () => {
    const warm = await opening();
    const turn = claims(warm).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    // Genuinely idle: the run closed and the reservation spent, as commit and loop would leave them, so only the
    // claim is left (an open run would be re-opened, a reserved send rerun).
    warm.db.query('DELETE FROM pending_steers').run();
    new RunEventRecorder(makeSql(warm.db), workspaceMainActor(warm.db))
      .emit(turn.runId, { type: 'run_end', reason: 'error', error: 'the process died before the claim settled' });
    // Unverified: admitted by a host that stamped no build, recovered by one that does, so nothing names its program.
    const cold = await reactivateOrchestratorHarness(warm.db, undefined, { world: { versionId: 'build-after-admission' } });
    await cold.agent.terminalRetryPass();
    expect(claims(cold).read(turn.turnId)).toMatchObject({ status: 'settled', outcome: 'indeterminate' });
  });
});
