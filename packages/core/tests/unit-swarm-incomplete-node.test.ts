/**
 * A NODE THAT NEVER FINISHED IS NOT A NODE THAT MEASURED BADLY, and the search says
 * which.
 *
 * THE DEFECT THIS PINS. An agent node always returns a report, and a report always
 * carries a summary — including when the node was aborted, ran out of steps or errored,
 * in which case the summary is a STATUS LINE (`incompleteHeadSummary`) rather than an
 * answer. Taking that string as the node's candidate and handing it to the instrument
 * like any other decides an unfinished node's fate by whatever the verifier happens to
 * say about a status line. On the one live swarm run that meant "unmeasurable — no
 * usable solution", which blames the instrument for three nodes the caller's 20-minute
 * deadline stopped mid-step, and leaves the report with nothing at all to say about
 * the deadline.
 *
 * And where an unfinished node's recorded findings carry a code fence — which is exactly
 * what a node that ran 26 steps and wrote code before being cut leaves behind — the
 * status line IS measurable, so the unfinished node gets SCORED. That is the ranking
 * measuring the clock, and the second test below is the proof: the aborted node here
 * carries the OPTIMAL program and would otherwise beat the sibling that actually
 * finished.
 *
 * WHY THE REAL LOOP AND NOT AN INJECTED OUTCOME. A node is a logical actor of the one
 * workspace and no backend supplies a node host, so the only host a suite could pass is
 * its own — handing the engine reports no loop produced and making each node's outcome
 * an input rather than a result. Every outcome below is therefore something a REAL node
 * did: it reported through the real report gate, and then its provider died, or the
 * caller's clock ran out, or the search was cancelled under it. The instrument is real,
 * and so is the report the engine reads.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent" and "No self-grading".
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { runSwarm } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import { diversityAngle } from '../src/mcts/diversity';
import { deriveStop } from '../src/strategy/settle';
import type { SwarmRunDeps } from '../src/strategy/swarm-run';
import type { Objective } from '../src/strategy/objective';
import type { ResolvedSwarm } from '../src/strategy/swarm';
import type { SearchNode } from '../src/types/mcts';

/** Small: every candidate the instrument accepts spawns a real process. */
const N = 12;

/** Correct and wasteful — a nested scan. Measurable, and worse than the target. */
const WASTEFUL = `export function solve(input, oracle) {
  const t = input.tokens;
  const n = t.length;
  for (let i = 0; i < n; i += 1) {
    let wins = 0;
    for (let j = 0; j < n; j += 1) {
      if (i !== j && oracle.greater(t[i], t[j])) wins += 1;
    }
    if (wins === n - 1) return t[i];
  }
  return t[0];
}
`;

/** One linear scan: n-1 comparisons, which is the target. */
const OPTIMAL = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
`;

function objective(): Objective {
  return {
    kind: 'scalar',
    metric: 'oracle_calls',
    unit: 'oracle calls',
    direction: 'minimise',
    scale: 'log',
    target: N - 1,
    verify: {
      kind: 'exec-ratio',
      spec: {
        params: { n: N, seed: 7 },
        reference: WASTEFUL,
        body: BODY,
        targetOps: N - 1,
        lowerBoundOps: Math.ceil(N / 2),
      },
    },
  };
}

function resolved(): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'incomplete-node',
    task: `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls.`,
    objective: objective(),
    config: {
      unit: { kind: 'answer' },
      context: 'fresh',
      expand: 'sample',
      score: { kind: 'verify' },
      advance: { kind: 'uct' },
      carry: { kind: 'none' },
    },
    depth: 1,
    branches: 2,
  });
  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);
  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);
  return call;
}


/**
 * The angle branch `i` was handed, which is how the script tells the two siblings apart.
 *
 * Keyed off the PROMPT rather than off arrival order: the two nodes run under one
 * `Promise.allSettled` over ONE model, so a shared counter would decide which node is
 * which by scheduling.
 */
function isBranch(prompt: LanguageModelV3Prompt, index: number): boolean {
  return JSON.stringify(prompt).includes(`Your angle: ${diversityAngle(index, 2)}`);
}

/**
 * How many turns of its OWN this node has already taken, read off the conversation it
 * was handed rather than off a counter, for `isBranch`'s reason: one model serves both
 * siblings concurrently, so the only per-node state is the prompt itself.
 */
function ownTurns(prompt: LanguageModelV3Prompt): number {
  let lastUser = -1;
  for (const [index, message] of prompt.entries()) {
    if (message.role === 'user') lastUser = index;
  }
  return prompt.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;
}

/** What the provider says died, so the detail the engine renders can be checked against
 *  the words the failure actually carried rather than against a shape. */
const PROVIDER_DIED = 'the provider died mid-step';

interface Outcome {
  /**
   * How this node's own run ENDS, after it has reported.
   *
   * `completed` is a node that finished. `errored` is one whose provider died on the
   * turn after it reported — the shape of the live incident's siblings, which errored in
   * about a second. `aborted` is one cancelled under the search, which is run-wide by
   * definition: the signal is the SEARCH's, so a case that aborts one node aborts both.
   */
  readonly ends: 'completed' | 'errored' | 'aborted';
  /** What the node reports through `report`, which is what the engine measures. */
  readonly content: string;
}

/**
 * The provider both nodes run on: it reports what the caller said, then ends the node
 * the way the caller said.
 *
 * A tool call makes the SDK take another step whatever the finish reason says, so the
 * node's second turn is where an end other than `completed` has to happen — and where a
 * node that simply finished says its last word as text.
 */
function scriptedNodes(
  outcomes: readonly [Outcome, Outcome],
  cancel: AbortController,
): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-two-branches',
    doGenerate: async ({ prompt }) => {
      const outcome = outcomes[isBranch(prompt, 0) ? 0 : 1];
      if (ownTurns(prompt) === 0) {
        return {
          content: [{
            type: 'tool-call', toolCallId: 'report-1', toolName: 'report',
            input: JSON.stringify({ status: 'completed', content: outcome.content }),
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage, warnings: [],
        };
      }
      if (outcome.ends === 'errored') throw new Error(PROVIDER_DIED);
      // THE SEARCH'S OWN CANCELLATION, arriving where a real one does: between this
      // node's turns, after it had already banked an answer. Both siblings script it,
      // so whichever reaches its second turn first cuts the wave and the other reads
      // the same signal at its own next boundary — the outcome is the same either way,
      // which is what makes it deterministic under `allSettled`.
      if (outcome.ends === 'aborted') cancel.abort();
      return {
        content: [{ type: 'text' as const, text: 'Reported.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage, warnings: [],
      };
    },
  });
}

/** Run a depth-1, width-2 swarm whose two nodes end however the caller says. */
async function run(input: {
  readonly branch0: Outcome;
  readonly branch1: Outcome;
  /** A clock the caller declares. There is no derived envelope: absent is an ABSENT
   *  key, and a node with no declared clock has no clock at all. */
  readonly maxWallClockMs?: number;
  /** Whether one node of the wave cannot be SEATED. A node whose actor the host
   *  refuses leaves the search nothing at all, which is a different outcome from a
   *  node that ran and reported an unfinished status — the distinction this file
   *  exists for. Which of the two it hits is deliberately not stated: the claim is
   *  about the count the level came back one short by. */
  readonly losesOne?: boolean;
}) {
  const { rt, db } = createTestRuntime();
  const logger = createRecordingLogger();
  const cancel = new AbortController();
  const seats = hostedSeatsOver({ rt, db });
  let seated = 0;
  const deps: SwarmRunDeps = {
    rt,
    // A REAL actor per node: the seat is what the expansion claims the node's turn
    // under, and the loop runs as it. One per node id, all over this runtime's
    // single database.
    hostNode: async (node) => {
      seated += 1;
      if (input.losesOne === true && seated === 2) {
        throw new Error(`node ${node.nodeId}: the actor host could not seat it`);
      }
      return await seats.hostNode(node);
    },
    model: scriptedNodes([input.branch0, input.branch1], cancel),
    mode: 'build',
    logger,
    signal: cancel.signal,
  };
  // Assigned rather than spread conditionally, so a bound the caller did not declare is
  // an ABSENT KEY: "declared nothing" and "declared undefined" must not arrive at the
  // resolution under test as one input.
  const declared: SwarmRunDeps = { ...deps };
  if (input.maxWallClockMs !== undefined) {
    Object.assign(declared, { maxWallClockMs: input.maxWallClockMs });
  }
  const result = await runSwarm(declared, resolved());
  const rows = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes WHERE actor_id = ${rt.actor.actorId}
    ORDER BY depth ASC, created_at ASC`;
  return { result, rows };
}

const fenced = (code: string) => `Here is the answer.\n\n\`\`\`javascript\n${code}\`\`\``;

describe('an unfinished node is distinguishable from a badly-measured one', () => {
  test('one field says the instrument had nothing to look at, the other says why', async () => {
    const { result, rows } = await run({
      branch0: { ends: 'completed', content: fenced(WASTEFUL) },
      branch1: { ends: 'errored', content: fenced(OPTIMAL) },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    expect(result.report.expansions).toBe(2);
    expect(result.candidates).toHaveLength(2);

    // THE NODE THAT FINISHED, badly. It has a measurement, a score, and nothing to
    // explain — a bad number is a bad number.
    const measuredNode = result.candidates.find((candidate) => candidate.measured !== null);
    if (!measuredNode) throw new Error('the completed node produced no measurement');
    expect(measuredNode.measured?.value).toBeGreaterThan(N - 1);
    expect(measuredNode.score).toBeTypeOf('number');
    expect(measuredNode.incomplete).toBeNull();
    expect(measuredNode.unmeasurable).toBeNull();

    // THE NODE THAT DID NOT. No measurement, no score, and — the assertion that was
    // false before this distinction existed — no complaint about the INSTRUMENT, which
    // was never asked. What it says instead is the status, the steps, the clock and the
    // reason. The step count and the elapsed time are the run's OWN now rather than a
    // fixture's arithmetic, so they are read as fields rather than as constants; the
    // status word and the reason are asserted exactly, because those are what a run
    // that flattened every unfinished node into "unmeasurable" would lose.
    const cutNode = result.candidates.find((candidate) => candidate.id !== measuredNode.id);
    if (!cutNode) throw new Error('the unfinished node produced no candidate row at all');
    expect(cutNode.measured).toBeNull();
    expect(cutNode.score).toBeNull();
    expect(cutNode.unmeasurable).toBeNull();
    expect(cutNode.incomplete).toMatch(/^errored after \d+ step\(s\) in \d+ ms: /);
    expect(cutNode.incomplete).toContain(PROVIDER_DIED);

    // OUT OF SELECTION WITHOUT PRETENDING IT SCORED: `failed`, and the DDL's absent
    // reward rather than a zero one. A 0 would claim the node was measured and bad.
    const cutRow = rows.find((row) => row.id === cutNode.id);
    expect(cutRow?.status).toBe('failed');
    expect(cutRow?.visits).toBe(0);
    expect(cutRow?.value).toBe(0);
  }, 60_000);

  test('the node that did not finish cannot win, even carrying the better program', async () => {
    // THE RANKING WAS MEASURING THE CLOCK. Branch 1 reports the OPTIMAL program and
    // then dies; branch 0 finished and reports the wasteful one. Measured alike, the
    // unfinished node wins on `oracle_calls` — so the search would crown work that
    // never got to the end of itself and publish it as the answer. And it really is
    // measurable: the report gate ran the instrument over that exact fence before the
    // node's own provider died, which is what makes this the live incident's shape
    // rather than a node with nothing to score.
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(WASTEFUL) },
      branch1: { ends: 'errored', content: fenced(OPTIMAL) },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    const best = result.best;
    if (!best) throw new Error('the completed node was measurable, so something must be crowned');
    expect(best.incomplete).toBeNull();
    expect(best.artifact).toContain('let wins = 0');
    expect(best.artifact).not.toContain('let best = t[0]');
  }, 60_000);

  test('a run whose every node was cut crowns nothing and says which nodes were cut', async () => {
    // The live run's own shape: the cancellation landed mid-wave, so no node finished —
    // and both had already banked the OPTIMAL program, so `best` is null because there
    // is no signal rather than because the candidates had nothing to score. Every
    // candidate names its own stop, in the words the search itself gave the cut.
    const { result } = await run({
      branch0: { ends: 'aborted', content: fenced(OPTIMAL) },
      branch1: { ends: 'aborted', content: fenced(OPTIMAL) },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    expect(result.best).toBeNull();
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.incomplete).toMatch(/^aborted after \d+ step\(s\) in \d+ ms: the search was aborted$/);
      expect(candidate.score).toBeNull();
      expect(candidate.measured).toBeNull();
    }
  }, 60_000);

  test('a node that ran out of BUDGET is reported the same way, by its own status', async () => {
    // Not only the cancel: every non-`completed` status is a node with no answer, and
    // the report names which one it was rather than flattening all three into
    // "unmeasurable". A clock of zero is the deterministic way to reach the third
    // status — the node is exhausted before its first step, so nothing about the
    // scripted provider decides this one.
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(WASTEFUL) },
      branch1: { ends: 'completed', content: fenced(WASTEFUL) },
      maxWallClockMs: 0,
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    const cut = result.candidates.find((candidate) => candidate.incomplete !== null);
    expect(cut?.incomplete).toStartWith('budget_exceeded after ');
    expect(cut?.incomplete).toContain('wall-clock budget exhausted');
    expect(cut?.score).toBeNull();
  }, 60_000);
});

describe('every node runs to the deadline its caller declared, and to none other', () => {
  test('nothing declared reaches the node as an ABSENT clock', async () => {
    // The new contract: there is no derived envelope and no step cap (owner ruling,
    // 2026-08-21 — no per-turn bounds). An absent key is the default, and what bounds a
    // node lives inside its own turns: the per-call silence window and the mission
    // governor. A runner that invented an envelope would cut these two nodes instead of
    // measuring them, which is the only thing an absent clock can be caught by now that
    // no seam carries the granted number out of the run.
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(WASTEFUL) },
      branch1: { ends: 'completed', content: fenced(WASTEFUL) },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.incomplete)).toEqual([null, null]);
  }, 60_000);

  test('a clock the caller declared reaches the node; zero is a declaration', async () => {
    // ZERO IS THE ONE INPUT THAT CATCHES THIS. `runSwarm` resolves a caller's clock with
    // `??`, and `||` would read a declared 0 as nothing declared — so a caller who asked
    // for no time at all would get a node that ran to completion. That is the row below
    // that must differ from the other two, and it is the whole reason the table has
    // three rows rather than one. `unit-swarm-node-envelope.test.ts` pins what a zero
    // clock does to one node's own steps; this pins that the RUN hands its nodes the
    // number the caller gave.
    const settled: Outcome = { ends: 'completed', content: fenced(WASTEFUL) };
    const cases = [
      // Big enough that the report gate's own instrument run cannot expire it: what is
      // under test is a clock that was DECLARED and did not fire, not a fast node.
      { name: 'nothing declared', declare: {}, cut: [false, false] },
      { name: 'a clock declared', declare: { maxWallClockMs: 600_000 }, cut: [false, false] },
      { name: 'a clock of zero', declare: { maxWallClockMs: 0 }, cut: [true, true] },
    ] as const;

    for (const declaration of cases) {
      const { result } = await run({
        branch0: settled, branch1: settled, ...declaration.declare,
      });
      if ('reason' in result) {
        throw new Error(`the run refused with ${declaration.name}: ${result.error}`);
      }
      // BOTH nodes, so a resolution that happened to be right for one node is not
      // mistaken for a run-wide one.
      expect({
        case: declaration.name,
        cut: result.candidates.map((candidate) => candidate.incomplete !== null),
      }).toEqual({ case: declaration.name, cut: [...declaration.cut] });
    }
  }, 120_000);
});

/**
 * WHAT THE RUN OWES A CALLER ABOUT A NODE IT LOST, which is a different debt from the
 * one above. A node that ran and reported an unfinished status is CARRIED: the run
 * holds its candidate and says on that candidate what happened to it. A node the host
 * could not even seat leaves the run holding nothing, so it is COUNTED instead — and
 * the count is what stops the run claiming it settled.
 *
 * The two halves were wired and neither was asserted: `lost` is computed in
 * `swarm-run.ts` and handed to `deriveStop`, whose `lost > 0` arm downgrades `settled`
 * to `budget`. A run that lost a node and still reported `settled` would tell its
 * caller a narrower search was a complete one, and nothing here would have noticed.
 */
describe('a node the run LOST is counted, and the count denies the run a clean settle', () => {
  // `lost` itself is deliberately NOT on the report — `swarm-run.ts:830-833` states
  // that the caller-visible consequence is `stop`. So these two cases assert what a
  // caller can actually see, and the unit case below pins the rule at the one seam
  // where the count is visible.
  test('a dead host leaves the level one candidate short and denies the settle', async () => {
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(OPTIMAL) },
      branch1: { ends: 'completed', content: fenced(WASTEFUL) },
      losesOne: true,
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);

    // Counted, not carried: the width was two and the run holds one.
    expect(result.report.expansions).toBe(1);
    // A lost node denies the clean settle. Without this the caller reads `settled`
    // and treats a half-width wave as the search it asked for.
    expect(result.report.stop).toBe('budget');
  }, 60_000);

  test('a node that did not finish is carried, so the level keeps both candidates', async () => {
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(OPTIMAL) },
      branch1: { ends: 'errored', content: fenced(WASTEFUL) },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);

    // The contrast that makes the previous case mean something: this node also
    // failed to finish, and the run still holds it with its reason attached.
    expect(result.report.expansions).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.some((candidate) => candidate.incomplete !== null)).toBe(true);
  }, 60_000);

  test('deriveStop: only an untouched budget with a closed frontier earns `settled`', () => {
    const settled = {
      aborted: false, missionSpent: false, lost: 0, remainingBudget: 5, frontierOpen: false,
    };
    expect(deriveStop(settled)).toBe('settled');
    // One lost node is enough, at any remaining budget.
    expect(deriveStop({ ...settled, lost: 1 })).toBe('budget');
    expect(deriveStop({ ...settled, missionSpent: true })).toBe('budget');
    // Exhaustion counts only while the frontier still had somewhere to go.
    expect(deriveStop({ ...settled, remainingBudget: 0, frontierOpen: true })).toBe('budget');
    expect(deriveStop({ ...settled, remainingBudget: 0, frontierOpen: false })).toBe('settled');
    // An abort outranks every other reason, including a lost node.
    expect(deriveStop({ ...settled, aborted: true, lost: 3 })).toBe('aborted');
  });
});
