import { describe, expect, test } from 'bun:test';
import * as config from '../src/config';
import * as evaluation from '../src/mcts/evaluation';
import * as scaffoldExecutor from '../src/scaffold/executor';
import * as autoJudge from '../src/scaffold/auto-judge';
import * as agentOrchestrator from '../src/orchestrator/agent-orchestrator';
import type { EvaluateBranchOptions } from '../src/mcts/evaluation';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import { DEFAULT_ATTEMPT_BUDGET } from '../src/bench/types';
import { jsonSchema, tool } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import { runChat, UNBOUNDED_STEPS } from '../src/index';

test('the shared chat driver completes work beyond ten tool steps', async () => {
  let calls = 0;
  let executed = 0;

  const model = scriptedTurnModel({
    doGenerate: () => {
      const working = calls++ < 14;

      return {
        content: working
          ? [{ type: 'tool-call', toolCallId: String(calls), toolName: 'advance', input: '{}' }]
          : [{ type: 'text', text: 'work complete' }],
        finishReason: { unified: working ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  let answer = '';

  for await (const event of runChat({
    model, system: 'Complete the work.', history: [{ role: 'user', content: 'go' }],
    tools: { advance: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: async () => ++executed }) },
    stopWhen: UNBOUNDED_STEPS,
  })) {
    if (event.type === 'text-delta') answer += event.delta;
  }

  expect(executed).toBe(14);
  expect(answer).toBe('work complete');
});

describe('the shared turn has no elapsed deadline', () => {
  test('no LLM-call timeout or timeout-retry constant is exported', () => {
    expect('LLM_CALL_TIMEOUT_MS' in config).toBe(false);
    expect('LLM_CALL_MAX_RETRIES' in config).toBe(false);
  });
});


describe('owned work carries no default elapsed deadline', () => {
  test('MCTS judges expose no per-call wall clock', () => {
    // A judge call is awaited to settlement; the ensemble degrades only on unparseable samples, never slow ones.
    expect('DEFAULT_JUDGE_CALL_TIMEOUT_MS' in evaluation).toBe(false);
  });

  test('the evaluator options expose no judgeCallTimeoutMs field', () => {
    type HasJudgeTimeout = 'judgeCallTimeoutMs' extends keyof EvaluateBranchOptions ? true : false;

    const hasJudgeTimeout: HasJudgeTimeout = false;
    expect(hasJudgeTimeout).toBe(false);
  });

  test('scaffold runs expose no turn timeout constant or option field', () => {
    // No elapsed deadline on scaffold loops: cost is bounded by how many trials are queued.
    expect('SCAFFOLD_TURN_TIMEOUT_MS' in scaffoldExecutor).toBe(false);

    type ScaffoldOptions = Parameters<typeof scaffoldExecutor.runScaffold>[0];

    type HasScaffoldTimeout = 'timeoutMs' extends keyof ScaffoldOptions ? true : false;

    const hasScaffoldTimeout: HasScaffoldTimeout = false;
    expect(hasScaffoldTimeout).toBe(false);
    expect('scaffoldTimeoutMs' in autoJudge.DEFAULT_AUTO_JUDGE_CONFIG).toBe(false);
  });

  test('evolution settle exposes no join bound constant or dep field', () => {
    // Background evolution work is never abandoned by the clock.
    expect('DEFAULT_SETTLE_TIMEOUT_MS' in agentOrchestrator).toBe(false);

    type HasSettleTimeout = 'settleTimeoutMs' extends keyof AgentOrchestratorDeps ? true : false;

    const hasSettleTimeout: HasSettleTimeout = false;
    expect(hasSettleTimeout).toBe(false);
  });

});

describe('independent non-chat policies keep their existing values', () => {
  test('the bench attempt keeps harness provisioning (another ticket owns it)', () => {
    expect(DEFAULT_ATTEMPT_BUDGET.wallClockMs).toBe(600_000);
    expect(DEFAULT_ATTEMPT_BUDGET.maxTokens).toBe(600_000);
  });
});
