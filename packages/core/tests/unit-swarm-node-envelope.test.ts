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
import { DEFAULT_MAX_STEPS, TURN_WALL_CLOCK_ENVELOPE_MS } from '../src/config';
import { nodeWallClockEnvelopeMs } from '../src/strategy/node-agent';

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
