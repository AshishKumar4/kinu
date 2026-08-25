import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stepCountIs, type StopCondition, type StepResult, type ToolSet } from 'ai';
import * as config from '../src/config';
import * as evaluation from '../src/mcts/evaluation';
import * as scaffoldExecutor from '../src/scaffold/executor';
import * as autoJudge from '../src/scaffold/auto-judge';
import * as agentOrchestrator from '../src/orchestrator/agent-orchestrator';
import type { EvaluateBranchOptions } from '../src/mcts/evaluation';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import { DEFAULT_ATTEMPT_BUDGET } from '../src/bench/types';
import { UNBOUNDED_STEPS, UNBOUNDED_MAX_STEPS, DEFAULT_HEAD_BUDGET } from '../src/index';


/**
 * The SDK's own combination rule, applied to a composed array.
 *
 * `isStopConditionMet` is internal to `ai`, so the rule is re-stated here AND
 * pinned against the installed bundle by the test below — a release that stops
 * OR-ing fails there rather than silently making this helper a lie.
 */
async function composedFires(
  conditions: readonly StopCondition<any>[], steps: number,
): Promise<boolean> {
  // Enough of a step for a stop condition. `StepResult`'s fields are never
  // read here. SAFETY: verified against the installed SDK bundle — a stop
  // condition only ever reads the steps array's LENGTH and never dereferences
  // an element; the pin below fails if that ever changes.
  const stepList = Array.from({ length: steps }, () => ({} as StepResult<ToolSet>));
  const results = await Promise.all(conditions.map((condition) => condition({ steps: stepList })));
  return results.some((result) => result);
}

describe('the shared turn has no elapsed deadline', () => {
  test('no LLM-call timeout or timeout-retry constant is exported', () => {
    expect('LLM_CALL_TIMEOUT_MS' in config).toBe(false);
    expect('LLM_CALL_MAX_RETRIES' in config).toBe(false);
  });
});

/**
 * NO PER-TURN BOUND — asserted over the COMPOSED condition, not over one clause.
 *
 * This block used to assert `UNBOUNDED_STEPS({steps: []}) === false` and nothing
 * else. That is true of a capped system too: hosts compose stop conditions by
 * OR-ing an array, so a clause returning false is exactly what a clause sitting
 * next to `stepCountIs(10)` also returns. The assertion held while production
 * ran hard-capped at ten steps — the set the gate measured was one lambda, the
 * set it governed was the array that lambda ends up in.
 *
 * So these evaluate the array, at step counts past every bound anyone shipped.
 */
describe('no per-turn bound exists: the COMPOSED stop condition never fires on step count', () => {
  test('the SDK combines stop conditions by OR — the reason one clause cannot widen a cap', () => {
    // Pinned against the INSTALLED `ai`, so a release that changes the rule
    // fails here instead of quietly invalidating every test below.
    const bundle = readFileSync(Bun.resolveSync('ai', import.meta.dir), 'utf8');
    const combine = /stopConditions\.map\(\(condition\) => condition\(\{ steps \}\)\)\)\)\.some\(/;
    expect(combine.test(bundle)).toBe(true);
  });

  test('the caller condition alone never fires, at any step count', async () => {
    expect(await composedFires([UNBOUNDED_STEPS], 0)).toBe(false);
    expect(await composedFires([UNBOUNDED_STEPS], 1_000)).toBe(false);
  });

  // THE ARM THAT WAS MISSING. A host that keeps its own `stepCountIs` bound and
  // appends the caller's condition is the shape `@cloudflare/think` ships, and
  // it is what production runs. The composed array must still never fire, which
  // is only true because the bound itself is unreachable.
  test('the bound composed with the caller condition never fires past ten steps', async () => {
    const composed: readonly StopCondition<ToolSet>[] = [
      stepCountIs(UNBOUNDED_MAX_STEPS),
      UNBOUNDED_STEPS,
    ];
    expect(await composedFires(composed, 10)).toBe(false);
    expect(await composedFires(composed, 11)).toBe(false);
    expect(await composedFires(composed, 500)).toBe(false);
  });

  // The control: the same composition with a REACHABLE bound does fire, so the
  // test above is measuring the bound rather than a broken harness.
  test('the control — a reachable bound in the same composition does fire', async () => {
    const capped: readonly StopCondition<ToolSet>[] = [stepCountIs(10), UNBOUNDED_STEPS];
    expect(await composedFires(capped, 9)).toBe(false);
    expect(await composedFires(capped, 10)).toBe(true);
  });

  test('the bound is past any turn length a step counter can reach', () => {
    // `stepCountIs` compares with `===`, so an unreachable integer is the only
    // way to disarm a bound the host will not let a caller remove.
    expect(UNBOUNDED_MAX_STEPS).toBe(Number.MAX_SAFE_INTEGER);
    expect(UNBOUNDED_MAX_STEPS).toBeGreaterThan(100_000);
  });
});

describe('owned work carries no default elapsed deadline', () => {
  test('MCTS judges expose no per-call wall clock', () => {
    // A judge call is an LLM call: awaited to settlement, however long the
    // provider takes. The ensemble degrades only on samples that fail to
    // parse, never on samples that are merely slow.
    expect('DEFAULT_JUDGE_CALL_TIMEOUT_MS' in evaluation).toBe(false);
  });

  test('the evaluator options expose no judgeCallTimeoutMs field', () => {
    type HasJudgeTimeout = 'judgeCallTimeoutMs' extends keyof EvaluateBranchOptions ? true : false;
    const hasJudgeTimeout: HasJudgeTimeout = false;
    expect(hasJudgeTimeout).toBe(false);
  });

  test('scaffold runs expose no turn timeout constant or option field', () => {
    // Scaffold loops have no elapsed deadline; the run joins the executor to
    // settlement. The shadow trial's AutoJudgeConfig carries no knob either —
    // cost is bounded by how many trials are QUEUED, never by starving a run.
    expect('SCAFFOLD_TURN_TIMEOUT_MS' in scaffoldExecutor).toBe(false);
    type ScaffoldOptions = Parameters<typeof scaffoldExecutor.runScaffold>[0];
    type HasScaffoldTimeout = 'timeoutMs' extends keyof ScaffoldOptions ? true : false;
    const hasScaffoldTimeout: HasScaffoldTimeout = false;
    expect(hasScaffoldTimeout).toBe(false);
    expect('scaffoldTimeoutMs' in autoJudge.DEFAULT_AUTO_JUDGE_CONFIG).toBe(false);
  });

  test('evolution settle exposes no join bound constant or dep field', () => {
    // settleEvolution JOINS the turn lane with no elapsed bound: background
    // evolution work is never abandoned by the clock.
    expect('DEFAULT_SETTLE_TIMEOUT_MS' in agentOrchestrator).toBe(false);
    type HasSettleTimeout = 'settleTimeoutMs' extends keyof AgentOrchestratorDeps ? true : false;
    const hasSettleTimeout: HasSettleTimeout = false;
    expect(hasSettleTimeout).toBe(false);
  });

  test('heads carry no default wall clock', () => {
    // maxWallClockMs exists only when a caller explicitly authors one; absent
    // means a head runs to completion.
    expect('maxWallClockMs' in DEFAULT_HEAD_BUDGET).toBe(false);
  });
});

describe('independent non-chat policies keep their existing values', () => {
  test('the bench attempt keeps harness provisioning (another ticket owns it)', () => {
    expect(DEFAULT_ATTEMPT_BUDGET.wallClockMs).toBe(600_000);
    expect(DEFAULT_ATTEMPT_BUDGET.maxTokens).toBe(600_000);
  });
});
