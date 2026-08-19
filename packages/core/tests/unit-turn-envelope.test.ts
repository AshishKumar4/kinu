// The measured turn envelope, and the bounds that claim to derive from it.
//
// This suite exists because the failure it guards is arithmetic, not logical: six
// separate timeouts were 120_000 ms against turns measured at 151-509 s, so every
// MCTS rollout on the CLI backend hit its ceiling, scored 0, and the search
// correctly refused to crown a winner over a zero-signal tree. Nothing threw.
// Nothing logged. The only observable was "nothing scored".
//
// So the two things a reader cannot check by reading are checked here: that the
// envelope sits inside the window its own comment claims (above the longest turn
// measured, below the wall a resumed turn actually gets), and that every bound
// documented as deriving from it still equals it. Lowering any one of them back to
// a prudent-looking round number turns this suite red.

import { describe, expect, test } from 'bun:test';
import { TURN_WALL_CLOCK_ENVELOPE_MS } from '../src/config';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import { DEFAULT_JUDGE_CALL_TIMEOUT_MS } from '../src/mcts/evaluation';
import { DEFAULT_SETTLE_TIMEOUT_MS } from '../src/orchestrator/agent-orchestrator';
import { SCAFFOLD_TURN_TIMEOUT_MS } from '../src/scaffold/executor';
import { DEFAULT_ATTEMPT_BUDGET } from '../src/bench/types';

/**
 * The longest turn on record, from the eval-tier run `config.ts` cites: single
 * turns of 151 s and 294 s, a five-turn conversation of 509 s, eight algorithmic
 * challenges averaging 92 s each, one converged MCTS terminal node of 437 s.
 *
 * It lives here rather than beside the bound because a measurement with no
 * production reader is a constant only its own test can reach, and this IS the
 * only consumer: the floor exists so the bound can be held above it. Re-measuring
 * moves this and `config.ts`'s prose together.
 */
const LONGEST_MEASURED_TURN_MS = 509_000;

describe('the measured turn envelope', () => {
  test('clears the longest turn on record — the floor that 120_000 was under', () => {
    expect(TURN_WALL_CLOCK_ENVELOPE_MS).toBeGreaterThan(LONGEST_MEASURED_TURN_MS);
    // The number the audit replaced, stated so the regression is named rather than
    // implied: it is BELOW the floor, which is the whole defect.
    expect(120_000).toBeLessThan(LONGEST_MEASURED_TURN_MS);
  });

  test('stays under the wall a turn resumed from an alarm actually gets', () => {
    // At the ceiling the platform kills the invocation before the bound can report
    // itself, so a stuck branch would surface as a vanished turn rather than as a
    // named branch failure.
    const alarmCeilingMs = PLATFORM_CATALOG['do.alarm.wall_ms'].limit.value;
    expect(alarmCeilingMs).toBe(900_000);
    expect(TURN_WALL_CLOCK_ENVELOPE_MS).toBeLessThan(alarmCeilingMs);
  });
});

describe('every bound that claims to derive from the envelope', () => {
  test('is the envelope, not a number of its own', () => {
    expect({
      judgeCall: DEFAULT_JUDGE_CALL_TIMEOUT_MS,
      settleEvolution: DEFAULT_SETTLE_TIMEOUT_MS,
      scaffoldTurn: SCAFFOLD_TURN_TIMEOUT_MS,
      benchAttempt: DEFAULT_ATTEMPT_BUDGET.wallClockMs,
    }).toEqual({
      judgeCall: TURN_WALL_CLOCK_ENVELOPE_MS,
      settleEvolution: TURN_WALL_CLOCK_ENVELOPE_MS,
      scaffoldTurn: TURN_WALL_CLOCK_ENVELOPE_MS,
      benchAttempt: TURN_WALL_CLOCK_ENVELOPE_MS,
    });
  });

  test('leaves the bench token cap alone — it carries its own pilot measurement', () => {
    // The wall clock and the token cap of one attempt were measured separately and
    // only one of them had evidence. Pinning both to the envelope would erase the
    // one number in that pair that was earned.
    expect(DEFAULT_ATTEMPT_BUDGET.maxTokens).toBe(600_000);
  });
});
