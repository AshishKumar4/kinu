import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { ActorClaimStore, SessionHistory } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import { orchestratorHarness, chatSessionTurns, reactivateOrchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const GENESIS = { role: 'user', content: 'Read your standing brief and ask what to do first.' } satisfies ModelMessage;

type Harness = ActorHarness<HarnessOrchestratorAgent>;

function claims(harness: Harness): ActorClaimStore {
  const runtime = harness.agent.observeRuntime();
  const sql = makeSql(harness.db);
  const transactionSync = <T>(write: () => T): T => write();

  const history = new SessionHistory({ sql, actor: runtime.actor, transactionSync,
    files: async () => ({ vfs: runtime.storage.vfs, artifactDirectory: '/actor/.kinu/context' }) });

  return new ActorClaimStore(sql, runtime.actor, transactionSync, history);
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
  // The socket-admission properties the harness once simulated are now proven
  // end to end over a real socket and the installed Think queue in
  // tests/workerd/two-turn.test.ts: 'admits two websocket asks after held
  // genesis through the installed Think queue' (queued ordering + per-request
  // binding), 'a durable programmatic submission excludes a later pending chat
  // from its provider prefix' (a programmatic turn cannot consume pending B),
  // and 'keeps a queued chat on its durable token through a cold reset and
  // replay' (durable token identity, continuation never consumes pending, and a
  // settled token is not replayed). What the chat transport admits — a
  // client's message under its own id, before the loop is asked, and nothing
  // a replay carries — is unit-chat-transport.test.ts. The cases kept here
  // exercise the alarm/conversion lifecycle directly.
  test('alarm recovery leaves the live Think root claim with its foreground owner', async () => {
    const harness = await opening();
    const turn = claims(harness).latestTurn();

    if (turn === null) throw new Error('no root turn was admitted');
    expect(await harness.agent.hasSandboxBackgroundWork()).toBe(true);
    const host = harness.agent.observeActorHost();
    const acquire = host.acquire.bind(host);
    let acquired = 0;
    host.acquire = async (reference) => {
      acquired += 1;

      return acquire(reference);
    };

    await harness.agent._kinuTerminalRetryTick();
    expect(acquired).toBeGreaterThan(0);
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
    // GENUINELY idle: the process died after the turn committed and its run
    // closed, before the claim settled. A run the ledger still held open would
    // not be idle — the next activation's loop re-opens it and continues the
    // turn under its claim — and a send still reserved would rerun; so the
    // reservation is spent and the run closed here, the way the commit spends
    // and the loop closes them, and only the claim is left unverified.
    warm.db.query('DELETE FROM pending_steers').run();
    warm.agent.harnessEventRecorder.emit(turn.runId, { type: 'run_end', reason: 'error', error: 'the process died before the claim settled' });
    const cold = await reactivateOrchestratorHarness(warm.db);
    await cold.agent._kinuTerminalRetryTick();
    expect(claims(cold).read(turn.turnId)).toMatchObject({ status: 'settled', outcome: 'indeterminate' });
  });
});
