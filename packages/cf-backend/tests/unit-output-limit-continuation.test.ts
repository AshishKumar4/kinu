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
 * These cases drive the REAL loop on a real actor and read what it recorded:
 * the terminal rows of the settled turn and the continuation turn on disk. Both
 * directions are here: the truncated turn owes exactly one continuation, and
 * every turn that is not one owes none.
 */
import { describe, expect, test } from 'bun:test';
import { OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, OUTPUT_LIMIT_REACHED } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

/** One row of the settled turn's terminal sequence, as the suite reads it. */
interface EffectRow {
  readonly effect_key: string;
  readonly status: string;
}

/** Drive one settled response, its model step ending the way `reason` says,
 *  and read the rows its terminal sequence claimed. The loop, the roster, the
 *  claim ledger and the effect bodies are production's. */
async function settle(
  harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string, messageId: string, reason: 'stop' | typeof OUTPUT_LIMIT_REACHED,
): Promise<readonly EffectRow[]> {
  await chatSessionTurns(harness.agent).settle({ turnId, messageId, text: 'the answer so far', finishReason: reason });
  const effects = harness.agent.harnessTerminalEffects(turnId, messageId);
  await harness.agent.harnessTerminalReported();
  await joinHarnessFibers();

  return effects;
}

const owesContinuation = (effects: readonly EffectRow[]): boolean =>
  effects.some((row) => row.effect_key.includes('output_continuation'));

describe('a cloud turn cut at the output limit is continued exactly once', () => {
  test('a truncated answer owes one continuation, keyed on the response it continues', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    const effects = await settle(harness, 'u-cut', 'a-cut', OUTPUT_LIMIT_REACHED);

    // Keyed on THIS response, so a replay of the owed row after an eviction
    // finds the same turn rather than queueing a second one.
    expect(harness.agent.harnessChatLoop.announcementOnDisk('output-continuation:a-cut')).toBe(true);
    expect((await harness.agent.listRuns()).items).toHaveLength(2);
    // Owed until a replay reads the continuation's own row on disk: the turn
    // ran behind the settle, after the row was attempted.
    expect(effects.find((row) => row.effect_key === 'v1:output_continuation:a-cut'))
      .toMatchObject({ status: 'pending' });
  });

  /**
   * THE FAILURE DIRECTION. A model that stopped because it was finished must not
   * be told to keep writing — a continuation there is a second answer to a
   * question already answered, and it costs a turn every time.
   */
  test('a turn that finished on its own owes no continuation', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    const effects = await settle(harness, 'u-done', 'a-done', 'stop');

    expect(owesContinuation(effects)).toBe(false);
    expect(harness.agent.harnessChatLoop.announcementOnDisk('output-continuation:a-done')).toBe(false);
  });

  /**
   * THE BOUND. The continuation turn is itself capable of ending at the output
   * limit, and answering that with another continuation is a loop that spends a
   * turn per lap. One is the whole allowance — the same rule `runChat` applies
   * inside its own turn, where a second `length` is honest partial completion.
   */
  test('a continuation cut at the same limit is partial completion, not a second continuation', async () => {
    const harness = orchestratorHarness();
    // The turn driven BY the continuation: the queued turn stamps its
    // `kinuEvent` on the message that drives it, which is how the settle
    // knows this turn has already spent the allowance.
    harness.agent.harnessDrivingUserMessage(OUTPUT_CONTINUATION_TEXT, {
      kinuEvent: OUTPUT_CONTINUATION_EVENT,
    });
    const effects = await settle(harness, 'u-second', 'a-second', OUTPUT_LIMIT_REACHED);

    expect(owesContinuation(effects)).toBe(false);
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
    await harness.agent.declareTurnInFlight(true);

    const routed = await harness.agent.observeOrch().inbox.send({
      kind: OUTPUT_CONTINUATION_EVENT, text: OUTPUT_CONTINUATION_TEXT,
    });

    expect(routed).toBe('mid-turn');
    await harness.agent.observeOrch().inbox.prepareStep({ stepNumber: 0, messages: [] });
    const effects = await settle(harness, 'u-spliced', 'a-spliced', OUTPUT_LIMIT_REACHED);

    expect(owesContinuation(effects)).toBe(false);
  });
});
