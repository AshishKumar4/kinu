/**
 * KINU-041 on the Worker surface: Think's loop ends on a `length` finish, so a cloud turn cut at
 * the output limit must owe exactly one continuation turn, and no other turn owes one.
 */
import { describe, expect, test } from 'bun:test';
import { OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT, OUTPUT_LIMIT_REACHED } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

interface EffectRow {
  readonly effect_key: string;
  readonly status: string;
}

/** Settle one response with finish `reason` through production's loop and ledger; return its claimed rows. */
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

    // Keyed on this response so a post-eviction replay finds the same turn.
    expect(harness.agent.harnessChatLoop.announcementOnDisk('output-continuation:a-cut')).toBe(true);
    expect((await harness.agent.listRuns()).items).toHaveLength(2);
    // Still owed: the continuation turn ran after the row was attempted.
    expect(effects.find((row) => row.effect_key === 'v1:output_continuation:a-cut'))
      .toMatchObject({ status: 'pending' });
  });

  /** A continuation after a natural stop is a second answer and costs a turn. */
  test('a turn that finished on its own owes no continuation', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
    const effects = await settle(harness, 'u-done', 'a-done', 'stop');

    expect(owesContinuation(effects)).toBe(false);
    expect(harness.agent.harnessChatLoop.announcementOnDisk('output-continuation:a-done')).toBe(false);
  });

  /** One continuation is the whole allowance, matching `runChat`; a second `length` is partial completion. */
  test('a continuation cut at the same limit is partial completion, not a second continuation', async () => {
    const harness = orchestratorHarness();
    // The queued continuation turn stamps `kinuEvent` on its driving message.
    harness.agent.harnessDrivingUserMessage(OUTPUT_CONTINUATION_TEXT, {
      kinuEvent: OUTPUT_CONTINUATION_EVENT,
    });
    const effects = await settle(harness, 'u-second', 'a-second', OUTPUT_LIMIT_REACHED);

    expect(owesContinuation(effects)).toBe(false);
  });

  /** A continuation spliced mid-turn carries no `kinuEvent`, and must still not earn a second one. */
  test('a turn that absorbed the continuation mid-step owes no second one', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDrivingUserMessage('write the whole report');
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
