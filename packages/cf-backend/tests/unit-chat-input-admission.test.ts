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

async function settle(harness: Harness, id: string, text: string): Promise<void> {
  await chatSessionTurns(harness.agent).settle({ messageId: id, text, requestId: `response-${id}` });
}

async function opening(): Promise<Harness> {
  const harness = orchestratorHarness();
  await chatSessionTurns(harness.agent).prepare({ messages: [GENESIS] });

  return harness;
}

describe('request-owned chat inputs', () => {
  // Socket admission is proven end to end in tests/workerd/two-turn.test.ts and transport admission in
  // unit-chat-transport.test.ts; these cases exercise the alarm/conversion lifecycle directly.
  test('alarm recovery leaves the live Think root claim with its foreground owner', async () => {
    // The same pass classifies an idle unverified claim (the last case), so a pass that skips claims fails there.
    const harness = await opening();
    const turn = claims(harness).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    expect(await harness.agent.hasSandboxBackgroundWork()).toBe(true);

    await harness.agent.terminalRetryPass();
    expect(claims(harness).read(turn.turnId)?.status).toBe('admitted');
    await settle(harness, 'answer', 'complete answer');
  });

  test('the foreground owner stays live while its response is being converted for settlement', async () => {
    const harness = await opening();
    const ending = settle(harness, 'answer', 'complete answer');
    const claimed = claims(harness).latestTurn()?.status;
    const busy = harness.agent.hasSandboxBackgroundWork();
    await ending;

    expect(claimed).toBe('admitted');
    expect(await busy).toBe(true);
    expect(claims(harness).latestTurn()?.status).toBe('settled');
  });

  test('alarm recovery still classifies a genuinely idle unverified root claim', async () => {
    const warm = await opening();
    const turn = claims(warm).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    // Genuinely idle: the run closed and the reservation spent, as commit and loop would leave them, so only the
    // claim is left unverified (an open run would be re-opened, a reserved send rerun).
    warm.db.query('DELETE FROM pending_steers').run();
    new RunEventRecorder(makeSql(warm.db), workspaceMainActor(warm.db))
      .emit(turn.runId, { type: 'run_end', reason: 'error', error: 'the process died before the claim settled' });
    const cold = await reactivateOrchestratorHarness(warm.db);
    await cold.agent.terminalRetryPass();
    expect(claims(cold).read(turn.turnId)).toMatchObject({ status: 'settled', outcome: 'indeterminate' });
  });
});
