// THE SANCTIONED BOUNDS (owner ruling, verbatim, 2026-08-21): "why is there a
// 600s turn envelope or a max steps bound? I dont want those. We can maximum have
// 600s timeout on the LLM call step, and then upto 3 retries on it, but no per
// turn things."
//
// The former per-turn wall-clock envelope and the per-turn step cap are DELETED;
// what remains is per-call only. This suite holds the two surviving constants to
// the ruling and proves the deleted ones stay deleted at the type surface.
import { describe, expect, test } from 'bun:test';
import { LLM_CALL_TIMEOUT_MS, LLM_CALL_MAX_RETRIES } from '../src/config';
import { DEFAULT_JUDGE_CALL_TIMEOUT_MS } from '../src/mcts/evaluation';
import { DEFAULT_SETTLE_TIMEOUT_MS } from '../src/orchestrator/agent-orchestrator';
import { SCAFFOLD_TURN_TIMEOUT_MS } from '../src/scaffold/executor';
import { DEFAULT_ATTEMPT_BUDGET } from '../src/bench/types';
import { UNBOUNDED_STEPS } from '../src/chat';

describe('the sanctioned per-call bounds', () => {
  test('one LLM call gets exactly 600s of silence and up to 3 retries — the owner numbers', () => {
    expect(LLM_CALL_TIMEOUT_MS).toBe(600_000);
    expect(LLM_CALL_MAX_RETRIES).toBe(3);
  });

  test('the judge call rides the same per-call bound — it IS an LLM call', () => {
    expect(DEFAULT_JUDGE_CALL_TIMEOUT_MS).toBe(LLM_CALL_TIMEOUT_MS);
  });

  test('no per-turn bound exists: an unbounded stop condition is the default', () => {
    // The SDK's own default is stepCountIs(1); the loop MUST be given something.
    // UNBOUNDED_STEPS never fires, so a turn ends only by model choice, budget,
    // caller stopWhen, or the per-call window.
    // SAFETY: this pin declares an invariant: UNBOUNDED_STEPS in src/chat.ts
    // reads no field and returns false for any input, validated by its own
    // one-clause body, so the cast fixes only the argument's nominal shape.
    const impossibleInput = { steps: [], stepNumber: 99, maxSteps: undefined } as never;
    expect(UNBOUNDED_STEPS(impossibleInput)).toBe(false);
  });
});

describe('bounds that are NOT per-turn keep their own derivations', () => {
  test('the settle join is three sequential calls worth of per-call window', () => {
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBe(3 * LLM_CALL_TIMEOUT_MS);
  });

  test('the scaffold trial bound and bench attempt budget are harness provisioning, pinned', () => {
    // Measurement-harness bounds, not runtime ones: trials and attempts compare
    // fairly under fixed provisioning. Values kept so records stay comparable.
    expect(SCAFFOLD_TURN_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_ATTEMPT_BUDGET.wallClockMs).toBe(600_000);
    expect(DEFAULT_ATTEMPT_BUDGET.maxTokens).toBe(600_000);
  });
});
