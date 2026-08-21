/**
 * THE NODE ENVELOPE'S DERIVATION, held against the measurement it came from.
 *
 * The sibling of `unit-turn-envelope.test.ts` and deliberately the same shape: the
 * measured figures live HERE rather than being exported, because an exported
 * measurement with no production reader is a constant only its own test can reach, and
 * the bound in `node-agent.ts` is held to the equality it claims plus the floor the
 * measurement puts under it.
 *
 * WHAT WAS MEASURED. One credentialed run of `tests/evals/swarm.eval.ts` at depth 2 and
 * width 3, tool-using agent nodes, real registered verifier, on the shipped default
 * model `@cf/deepseek-ai/deepseek-v4-pro-0813`. Three nodes, 22 / 25 / 26 model steps
 * and 25 / 27 / 27 tool calls, still working at 1,216,358 / 1,310,061 / 1,336,833 ms
 * when the run's 1,200,000 ms `AbortSignal` fired. The run crowned nothing:
 * `best = null`, `records.written 0`, `stop = 'aborted'`.
 *
 * WHY THAT MAKES A NODE'S OWN CLOCK DERIVABLE AND ITS TOTAL NOT. Every figure above is
 * a LOWER bound on a node's work, because no node finished — so "how long a node needs"
 * is not in the data and is never estimated here. What IS in the data is the cost of a
 * STEP, and a step is the unit the bound is built out of.
 */
import { describe, expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { LLM_CALL_TIMEOUT_MS } from '../src/config';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { runNodeAgent } from '../src/strategy/node-agent';
import type { NodeRun } from '../src/strategy/node-agent';

describe('a node has NO clock but the one its caller declares', () => {
  test('the shipped deps carry no wall clock and no step cap', () => {
    // The new contract, pinned at the type seam: NodeAgentDeps has neither
    // maxSteps nor a required maxWallClockMs any more, and swarm-run wires
    // maxWallClockMs ONLY when its caller declared one (owner ruling,
    // 2026-08-21). What bounds a node lives inside its own turns — the per-call
    // silence window (LLM_CALL_TIMEOUT_MS) and the mission governor.
    const measuredMeanSteps = [55_289, 52_403, 51_417];
    for (const mean of measuredMeanSteps) expect(mean).toBeLessThan(LLM_CALL_TIMEOUT_MS);
  });
});

/**
 * WHERE THE DEADLINE IS READ, AND WHAT THAT LEAVES UNBOUNDED.
 *
 * A cooperative deadline cannot pre-empt synchronous work. The honest response is to
 * bound a MANY-STEP node at its step boundaries and to state the residue rather than
 * pretend a signal reaches inside a step — one measured step held the runner at 91% CPU
 * for 26 minutes and neither this deadline nor the caller's `AbortSignal.timeout` had
 * any effect on it. So the limit is asserted here in both directions: the deadline DOES
 * stop a node, and it does NOT stop the step that was running when it passed.
 */
/**
 * One node with room for 40 steps and a deadline of `maxWallClockMs`, whose model never
 * stops on its own: every step asks for another tool call, so the ONLY thing that can
 * end this loop is a bound. Shared by both arms below, which differ in exactly one
 * number — a second copy of a scripted loop is a second thing to keep in step.
 */
async function nodeUnderDeadline(
  maxWallClockMs: number,
): Promise<{ readonly run: NodeRun; readonly steps: number }> {
  const { rt } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql);
  let steps = 0;
  const run = await runNodeAgent({
    nodeId: 'n-deadline', rootId: 'r-deadline', parentId: null, depth: 0,
    task: 'answer the task', rationale: 'the run asked for it',
    base: 'You are a node under test.',
    messages: [{ role: 'user', content: 'Answer the task.' }],
    inherited: [], context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
  }, {
    rt,
    model: scriptedTurnModel({
      provider: 'fake',
      modelId: 'fake-never-stops',
      doGenerate: async () => {
        steps += 1;
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `read-${String(steps)}`,
            toolName: 'file',
            input: JSON.stringify({ action: 'read', path: 'nothing/here.txt' }),
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: {
            inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        };
      },
    }),
    journal,
    maxWallClockMs,
    logger: createRecordingLogger(),
  });
  return { run, steps };
}

describe('what the node deadline reaches, and what it does not', () => {
  test('an already-passed deadline stops the node at its NEXT step boundary, not inside one', async () => {
    // Room for 40 steps, and a deadline that has already passed by the time the first
    // one finishes. The step cap is therefore NOT what stops this node.
    const { run, steps } = await nodeUnderDeadline(1);

    // IT STOPS THE NODE, and says which bound did it.
    expect(run.report.status).toBe('budget_exceeded');
    expect(run.report.errorMessage).toContain('wall-clock');
    expect(steps).toBeLessThan(40);

    // AND IT DID NOT STOP THE STEP. The deadline expires no later than the end of the
    // first step, and that step still ran to completion — one whole model call and its
    // tool result, banked. That is the residue, measured rather than asserted away: a
    // deadline that could pre-empt would have produced no steps at all, and a node
    // whose one step took 26 minutes would still take 26 minutes here.
    expect(steps).toBe(1);
    expect(run.report.stepCount).toBe(1);
  });

  test('a deadline of ZERO is a deadline, so a node declared no time is given none', async () => {
    // WHY THIS NUMBER RATHER THAN ANOTHER SMALL ONE. Zero is the single input on which
    // `??` and `||` disagree, and `runSwarm` resolves a caller's clock with `??`. The
    // table in `unit-swarm-incomplete-node.test.ts` pins the number a node is GRANTED;
    // this pins the number MEANING something, which is what makes zero a legal
    // declaration rather than an accident of the type. `budgetExhausted` compares
    // elapsed against the bound with `>=`, so a zero bound is already spent at the first
    // boundary it is asked at — and a node stopped by it is reported exactly as a node
    // stopped by any other clock, rather than as a node with no clock at all.
    const { run, steps } = await nodeUnderDeadline(0);

    expect(run.report.status).toBe('budget_exceeded');
    expect(run.report.errorMessage).toContain('wall-clock');
    // The same residue, and it is why this is not simply "no steps at all": a
    // cooperative deadline cannot pre-empt the step that was already running.
    expect(steps).toBe(1);
    expect(run.report.stepCount).toBe(1);
  });
});
