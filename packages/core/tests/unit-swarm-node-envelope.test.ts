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
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { DEFAULT_MAX_STEPS, TURN_WALL_CLOCK_ENVELOPE_MS } from '../src/config';
import { nodeWallClockEnvelopeMs, runNodeAgent } from '../src/strategy/node-agent';

/** The three nodes of that run, exactly as it reported them. */
const MEASURED_NODES = [
  { steps: 22, wallClockMs: 1_216_358 },
  { steps: 25, wallClockMs: 1_310_061 },
  { steps: 26, wallClockMs: 1_336_833 },
] as const;

/** The longest a node was observed still working. A FLOOR, not a duration: it was cut. */
const LONGEST_MEASURED_NODE_MS = 1_336_833;

/** The most steps a node was observed taking. Also a floor, for the same reason. */
const MOST_STEPS_MEASURED = 26;

/** The run envelope that measurement was taken under — `swarm.eval.ts:301`, a round
 *  20 minutes whose stated reason is "the budget is 6 nodes". Named so the shortfall is
 *  a failing assertion rather than a paragraph. */
const RUN_ENVELOPE_THAT_ABORTED_MS = 1_200_000;

describe('a node envelope is derived from a step, not chosen', () => {
  test('it is exactly the step cap times the measured turn envelope', () => {
    // THE DERIVATION, as an equality rather than a magnitude. Editing either side
    // without the other fails here.
    expect(nodeWallClockEnvelopeMs(1)).toBe(TURN_WALL_CLOCK_ENVELOPE_MS);
    expect(nodeWallClockEnvelopeMs(MOST_STEPS_MEASURED))
      .toBe(MOST_STEPS_MEASURED * TURN_WALL_CLOCK_ENVELOPE_MS);
    expect(nodeWallClockEnvelopeMs(DEFAULT_MAX_STEPS))
      .toBe(DEFAULT_MAX_STEPS * TURN_WALL_CLOCK_ENVELOPE_MS);
  });

  test('the per-step term is not contradicted by any measured node', () => {
    // The multiplicand has to be a bound on ONE step, so every measured node's mean
    // step must fit inside it. The largest is 1_216_358 / 22 = 55_289 ms, which is
    // under a ninth of the turn envelope — the same envelope this tree already gives
    // one model call inside a turn.
    const means = MEASURED_NODES.map((node) => Math.ceil(node.wallClockMs / node.steps));
    expect(means).toEqual([55_289, 52_403, 51_417]);
    for (const mean of means) expect(mean).toBeLessThan(TURN_WALL_CLOCK_ENVELOPE_MS);
  });

  test('a node total of ONE turn envelope is below a real node — which is why it scales', () => {
    // The error in the other direction, named rather than implied. A node is many turns:
    // pinning its whole clock at the turn envelope would have killed all three healthy
    // nodes above, which is the 120_000-shaped defect with the sign flipped.
    expect(TURN_WALL_CLOCK_ENVELOPE_MS).toBeLessThan(LONGEST_MEASURED_NODE_MS);
    expect(nodeWallClockEnvelopeMs(MOST_STEPS_MEASURED))
      .toBeGreaterThan(LONGEST_MEASURED_NODE_MS);
  });

  test('the envelope that aborted the run is below the one its own step cap implies', () => {
    // THE DEFECT, as arithmetic. 1_200_000 is under the envelope 26 measured steps
    // already imply, and far under the one the shipped step cap does — the two bounds
    // were in different units and had never been compared, so the clock was measuring
    // the step cap's shadow.
    expect(RUN_ENVELOPE_THAT_ABORTED_MS)
      .toBeLessThan(nodeWallClockEnvelopeMs(MOST_STEPS_MEASURED));
    expect(RUN_ENVELOPE_THAT_ABORTED_MS)
      .toBeLessThan(nodeWallClockEnvelopeMs(DEFAULT_MAX_STEPS));
    // And it is below the work of every individual node it was asked to bound, which is
    // the plainest statement of it: the bound was smaller than one node.
    for (const node of MEASURED_NODES) {
      expect(RUN_ENVELOPE_THAT_ABORTED_MS).toBeLessThan(node.wallClockMs);
    }
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
describe('what the node deadline reaches, and what it does not', () => {
  test('an already-passed deadline stops the node at its NEXT step boundary, not inside one', async () => {
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
      // A node that never stops on its own: every step asks for another tool call, so
      // the ONLY thing that can end this loop is a bound.
      model: new MockLanguageModelV3({
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
      // Room for 40 steps, and a deadline that has already passed by the time the first
      // one finishes. The step cap is therefore NOT what stops this node.
      maxSteps: 40,
      maxWallClockMs: 1,
      logger: createRecordingLogger(),
    });

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
});
