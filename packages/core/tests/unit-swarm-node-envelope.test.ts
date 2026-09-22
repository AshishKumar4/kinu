/**
 * The node envelope's derivation, held against the measurement it came from (sibling of
 * `unit-turn-envelope.test.ts`). No measured node finished, so only the cost of a step is derivable.
 */
import { describe, expect, test, spyOn } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { runNodeAgent } from '../src/strategy/node-agent';
import type { NodeRun } from '../src/strategy/node-agent';

test('a node with no caller clock can finish after a long elapsed step', async () => {
  const { run, steps } = await nodeUnderDeadline();
  expect(run.report.status).toBe('completed');
  expect(steps).toBe(1);
});

/**
 * A cooperative deadline is read at step boundaries and cannot pre-empt a running step;
 * both directions are asserted.
 */
/** One node with room for 40 steps whose model never stops on its own, so only a bound ends the loop. */
async function nodeUnderDeadline(
  maxWallClockMs?: number,
): Promise<{ readonly run: NodeRun; readonly steps: number }> {
  const { rt, db } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql, rt.actor);
  // One hosted actor per node id; the deadline is observed between steps of its claimed turn.
  const seats = hostedSeatsOver({ rt, db });
  let steps = 0;
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);

  try {
    const run = await runNodeAgent({
      nodeId: 'n-deadline', rootId: 'r-deadline', parentId: null, depth: 0,
      task: 'answer the task', rationale: 'the run asked for it',
      base: 'You are a node under test.',
      messages: [{ role: 'user', content: 'Answer the task.' }],
      inherited: [], context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
    }, {
      hostNode: seats.hostNode,
      model: scriptedTurnModel({
        provider: 'fake', modelId: 'fake-never-stops',
        doGenerate: async () => {
          steps++;
          now += maxWallClockMs === undefined ? 26 * 60_000 : maxWallClockMs + 1;

          return {
            content: maxWallClockMs === undefined
              ? [{ type: 'text', text: 'finished the long step' }]
              : [{ type: 'tool-call', toolCallId: 'read-' + steps, toolName: 'file',
                  input: JSON.stringify({ action: 'read', path: 'nothing/here.txt' }) }],
            finishReason: { unified: maxWallClockMs === undefined ? 'stop' : 'tool-calls', raw: undefined },
            usage: {
              inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            }, warnings: [],
          };
        },
      }),
      journal, maxWallClockMs, logger: createRecordingLogger(),
    });

    return { run, steps };
  } finally {
    clock.mockRestore();
  }
}

describe('what the node deadline reaches, and what it does not', () => {
  test('a deadline expiring during a step stops the next request, not completed work', async () => {
    // The deadline has passed by the first step's end, so the step cap is not what stops this node.
    const { run, steps } = await nodeUnderDeadline(1);

    expect(run.report.status).toBe('budget_exceeded');
    expect(run.report.errorMessage).toContain('wall-clock');
    expect(steps).toBeLessThan(40);

    // The step that was running when the deadline passed still completes: the residue.
    expect(steps).toBe(1);
    expect(run.report.stepCount).toBe(1);
  });

  test('a deadline of ZERO is a deadline, so a node declared no time is given none', async () => {
    // Zero is where `??` and `||` disagree; `runSwarm` uses `??`, and `budgetExhausted` compares with `>=`,
    // so a zero bound is spent at the first boundary and reported like any other clock.
    const { run, steps } = await nodeUnderDeadline(0);

    expect(run.report.status).toBe('budget_exceeded');
    expect(run.report.errorMessage).toContain('wall-clock');
    expect(steps).toBe(0);
    expect(run.report.stepCount).toBe(0);
  });
});
