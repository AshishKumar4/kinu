import { describe, expect, test } from 'bun:test';
import * as config from '../src/config';
import * as evaluation from '../src/mcts/evaluation';
import * as scaffoldExecutor from '../src/scaffold/executor';
import * as autoJudge from '../src/scaffold/auto-judge';
import * as agentOrchestrator from '../src/orchestrator/agent-orchestrator';
import type { EvaluateBranchOptions } from '../src/mcts/evaluation';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import { DEFAULT_ATTEMPT_BUDGET } from '../src/bench/types';
import { UNBOUNDED_STEPS, DEFAULT_HEAD_BUDGET } from '../src/index';

describe('the shared turn has no elapsed deadline', () => {
  test('no LLM-call timeout or timeout-retry constant is exported', () => {
    expect('LLM_CALL_TIMEOUT_MS' in config).toBe(false);
    expect('LLM_CALL_MAX_RETRIES' in config).toBe(false);
  });

  test('the default stop condition never cuts a turn at a step count', () => {
    // The SDK's own default is stepCountIs(1); the loop MUST be given something.
    // UNBOUNDED_STEPS never fires, so a turn ends only by model choice, mission
    // budget, an explicit caller condition, cancellation, or a definitive error.
    const input = { steps: [] } satisfies Parameters<typeof UNBOUNDED_STEPS>[0];
    expect(UNBOUNDED_STEPS(input)).toBe(false);
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
