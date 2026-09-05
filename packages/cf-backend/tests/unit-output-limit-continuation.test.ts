/**
 * KINU-041, the half the cloud loop was missing.
 *
 * `runChat` continues a turn the provider cut at its output limit inside its own
 * call sequence (core chat.ts, `unit-output-limit-continuation.test.ts` there).
 * The Worker turn surface cannot: Think owns the agentic loop, and that loop
 * re-issues a request only while a step ended with tool calls whose outputs all
 * landed — a `length` finish ends it, and no hook can extend it. So a cloud turn
 * cut mid-answer published as `completed`, with whatever the model still had to
 * say — including the work after a completed tool result — simply gone.
 *
 * These cases drive the REAL `onChatResponse` on a real actor and read the one
 * external port replaced (the signal deliverer), so what they observe is the
 * turn surface's own behaviour rather than a fixture's. Both directions are
 * here: the truncated turn owes exactly one continuation, and every turn that is
 * not one owes none.
 */
import { describe, expect, test } from 'bun:test';
import {
  OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, OUTPUT_LIMIT_REACHED,
  type AgentSignal,
} from '@kinu.run/core';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

/** One settled assistant response, as Think reports it. */
function settledResponse(messageId: string, text = 'the answer so far'): Parameters<
  HarnessOrchestratorAgent['onChatResponse']
>[0] {
  return {
    message: { id: messageId, role: 'assistant', parts: [{ type: 'text', text }] },
    requestId: `req-${messageId}`, continuation: false, status: 'completed',
  };
}

/**
 * The turn's last step, recorded exactly as Think's `onStepFinish` records it:
 * the actor's hook maps the SDK step onto this call, and `lastFinishReason` is
 * what it leaves behind for the settle to read.
 */
function finishTurnWith(harness: ActorHarness<HarnessOrchestratorAgent>, reason: string): void {
  harness.agent.observeOrch().acc.recordStep({ text: 'the answer so far', finishReason: reason });
}

/** Drive one settled response and collect every signal its terminal sequence
 *  delivered. The deliverer is the one port replaced; the roster, the claim
 *  ledger and the effect bodies around it are production's. */
async function settle(
  harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string, messageId: string,
): Promise<AgentSignal[]> {
  const delivered: AgentSignal[] = [];
  harness.agent.harnessSetSignalDeliverer(async (signal) => {
    delivered.push(signal);
    return 'queued';
  });
  harness.agent.declareTurnCheckpoint(turnId);
  await harness.agent.onChatResponse(settledResponse(messageId));
  await harness.agent.harnessTerminalReported();
  await joinHarnessFibers();
  return delivered;
}

const continuations = (signals: readonly AgentSignal[]): AgentSignal[] =>
  signals.filter((signal) => signal.kind === OUTPUT_CONTINUATION_EVENT);

describe('a cloud turn cut at the output limit is continued exactly once', () => {
  test('a truncated answer owes one continuation, keyed on the response it continues', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    finishTurnWith(harness, OUTPUT_LIMIT_REACHED);

    const delivered = await settle(harness, 'u-cut', 'a-cut');

    const owed = continuations(delivered);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.text).toBe(OUTPUT_CONTINUATION_TEXT);
    // Keyed on THIS response, so a replay of the owed row after an eviction
    // enqueues the same turn rather than a second one.
    expect(owed[0]?.idempotencyKey).toBe('output-continuation:a-cut');
    // And the delivery DISCHARGED its row rather than staying owed — the other
    // half of the effect's contract, and what stops the same continuation from
    // being re-delivered by every later retry tick. Scoped to this row: the
    // harness UserDO cannot answer the titling effect beside it.
    expect(harness.agent.harnessTerminalEffects('u-cut', 'a-cut')
      .find((row) => row.effect_key === 'v1:output_continuation:a-cut'))
      .toMatchObject({ status: 'completed' });
  });

  /**
   * THE FAILURE DIRECTION. A model that stopped because it was finished must not
   * be told to keep writing — a continuation there is a second answer to a
   * question already answered, and it costs a turn every time.
   */
  test('a turn that finished on its own owes no continuation', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    finishTurnWith(harness, 'stop');

    const delivered = await settle(harness, 'u-done', 'a-done');

    expect(continuations(delivered)).toEqual([]);
    expect(harness.agent.harnessTerminalEffects('u-done', 'a-done')
      .some((row) => row.effect_key.includes('output_continuation'))).toBe(false);
  });

  /**
   * THE BOUND. The continuation turn is itself capable of ending at the output
   * limit, and answering that with another continuation is a loop that spends a
   * turn per lap. One is the whole allowance — the same rule `runChat` applies
   * inside its own turn, where a second `length` is honest partial completion.
   */
  test('a continuation cut at the same limit is partial completion, not a second continuation', async () => {
    const harness = orchestratorHarness();
    // The turn driven BY the continuation: the queued signal stamps its
    // `kinuEvent` on the message that drives the turn, which is how the settle
    // knows this turn has already spent the allowance.
    harness.agent.harnessDrivingUserMessage(OUTPUT_CONTINUATION_TEXT, {
      kinuEvent: OUTPUT_CONTINUATION_EVENT,
    });
    finishTurnWith(harness, OUTPUT_LIMIT_REACHED);

    const delivered = await settle(harness, 'u-second', 'a-second');

    expect(continuations(delivered)).toEqual([]);
  });

  /**
   * The same bound for the other route a continuation reaches the model. A
   * signal delivered while a turn is running is SPLICED into its next step
   * instead of queued, so the driving message carries no `kinuEvent` — reading
   * only that stamp would let a spliced continuation earn a second one.
   */
  test('a turn that absorbed the continuation mid-step owes no second one', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    // A turn is RUNNING, so the real delivery seam buffers the continuation for
    // its next step instead of queueing a turn — and the step boundary is where
    // the model actually takes it in.
    harness.agent.declareTurnInFlight(true);
    const routed = await harness.agent.observeOrch().signals.deliver({
      kind: OUTPUT_CONTINUATION_EVENT, text: OUTPUT_CONTINUATION_TEXT,
    });
    expect(routed).toBe('mid-turn');
    harness.agent.observeOrch().signals.prepareStep({ stepNumber: 0, messages: [] });
    finishTurnWith(harness, OUTPUT_LIMIT_REACHED);

    const delivered = await settle(harness, 'u-spliced', 'a-spliced');

    expect(continuations(delivered)).toEqual([]);
  });
});
