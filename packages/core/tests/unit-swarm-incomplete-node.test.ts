/**
 * A NODE THAT NEVER FINISHED IS NOT A NODE THAT MEASURED BADLY, and the search says
 * which.
 *
 * THE DEFECT THIS PINS. An agent node always returns a report, and a report always
 * carries a summary — including when the node was aborted, ran out of steps or errored,
 * in which case the summary is a STATUS LINE (`incompleteHeadSummary`) rather than an
 * answer. The engine took that string as the node's candidate and handed it to the
 * instrument like any other, so an unfinished node's fate was decided by whatever the
 * verifier happened to say about a status line. On the one live swarm run that meant
 * "unmeasurable — no usable solution", which blames the instrument for three nodes the
 * caller's 20-minute deadline stopped mid-step, and left the report with nothing at all
 * to say about the deadline.
 *
 * And where an unfinished node's recorded findings carry a code fence — which is exactly
 * what a node that ran 26 steps and wrote code before being cut leaves behind — the
 * status line IS measurable, so the unfinished node was SCORED. That is the ranking
 * measuring the clock, and the second test below is the proof: the aborted node here
 * carries the OPTIMAL program and would otherwise beat the sibling that actually
 * finished.
 *
 * WHY THE HOST SEAM AND NOT A SCRIPTED MODEL. `NodeLoopHost` is the production seam a
 * Cloudflare `ExplorationAgent` facet runs a node through, so a host that returns the
 * reports this suite needs exercises the engine's real consumption path while making the
 * node's outcome an input rather than something coaxed out of a mock's step budget. The
 * instrument is real and the model is asserted never to be called at all.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent" and "No self-grading".
 */
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { runSwarm } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import { nodeWallClockEnvelopeMs } from '../src/strategy/node-agent';
import { DEFAULT_MAX_STEPS } from '../src/config';
import { diversityAngle } from '../src/mcts/diversity';
import type { SwarmRunDeps } from '../src/strategy/swarm-run';
import type { NodeLoopResult, NodeRunSpec } from '../src/strategy/node-host';
import type { HeadReport } from '../src/heads/types';
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

/** A report in whatever state the host wants it, with the fields a real one carries. */
function headReport(input: {
  readonly id: string;
  readonly status: HeadReport['status'];
  readonly summary: string;
  readonly stepCount: number;
  readonly wallClockMs: number;
  /** Null for a node that completed, which is the one status that carries none. */
  readonly errorMessage: string | null;
}): HeadReport {
  const report: HeadReport = {
    id: input.id,
    status: input.status,
    summary: input.summary,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [],
    stepCount: input.stepCount,
    usage: {},
    wallClockMs: input.wallClockMs,
  };
  if (input.errorMessage === null) return report;
  return { ...report, errorMessage: input.errorMessage };
}

/**
 * The angle branch `i` was handed, which is how the host tells the two siblings apart.
 *
 * Keyed off the PROMPT rather than off arrival order: the two nodes run under one
 * `Promise.allSettled`, so a counter would decide which node is which by scheduling.
 */
function isBranch(spec: NodeRunSpec, index: number): boolean {
  return JSON.stringify(spec.messages).includes(`Your angle: ${diversityAngle(index, 2)}`);
}

interface Outcome {
  readonly status: HeadReport['status'];
  /** What the node reported through `report`, which is what the engine measures. */
  readonly content: string;
  readonly stepCount: number;
}

/** Run a depth-1, width-2 swarm whose two nodes end however the caller says. */
async function run(input: {
  readonly branch0: Outcome;
  readonly branch1: Outcome;
  readonly maxSteps?: number;
  /** A clock the caller declares instead of taking the derived envelope. */
  readonly maxWallClockMs?: number;
}) {
  const { rt } = createTestRuntime();
  const logger = createRecordingLogger();
  const budgets: (number | undefined)[] = [];
  /** The step cap each node was GRANTED, read off the spec a host receives — the same
   *  field an `ExplorationAgent` facet reads across an RPC. */
  const steps: number[] = [];
  const deps: SwarmRunDeps = {
    rt,
    // NEVER CALLED. Every node runs through the host below, and a swarm that reached
    // the model would be a swarm running a node twice.
    model: new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'fake-never-called',
      doGenerate: async () => {
        throw new Error('the model was called: an agent node ran outside its host');
      },
    }),
    mode: 'build',
    logger,
    host: async (spec): Promise<NodeLoopResult> => {
      budgets.push(spec.headInput.budget.maxWallClockMs);
      steps.push(spec.maxSteps);
      const outcome = isBranch(spec, 0) ? input.branch0 : input.branch1;
      return {
        report: headReport({
          id: spec.headInput.id,
          status: outcome.status,
          summary: outcome.content,
          stepCount: outcome.stepCount,
          wallClockMs: 1_000 * outcome.stepCount,
          errorMessage: outcome.status === 'completed' ? null : 'the search was aborted',
        }),
        reported: { status: outcome.status, content: outcome.content },
        granted: null,
        produced: [],
      };
    },
  };
  // Assigned rather than spread conditionally, so a bound the caller did not declare is
  // an ABSENT KEY: "declared nothing" and "declared undefined" must not arrive at the
  // resolution under test as one input.
  const declared: SwarmRunDeps = { ...deps };
  if (input.maxSteps !== undefined) Object.assign(declared, { maxSteps: input.maxSteps });
  if (input.maxWallClockMs !== undefined) {
    Object.assign(declared, { maxWallClockMs: input.maxWallClockMs });
  }
  const result = await runSwarm(declared, resolved());
  const rows = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { result, rows, budgets, steps };
}

const fenced = (code: string) => `Here is the answer.\n\n\`\`\`javascript\n${code}\`\`\``;

describe('an aborted node is distinguishable from a badly-measured one', () => {
  test('one field says the instrument had nothing to look at, the other says why', async () => {
    const { result, rows } = await run({
      branch0: { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 },
      branch1: { status: 'aborted', content: fenced(OPTIMAL), stepCount: 26 },
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
    // was never asked. What it says instead is the status, the steps and the clock.
    const cutNode = result.candidates.find((candidate) => candidate.id !== measuredNode.id);
    if (!cutNode) throw new Error('the aborted node produced no candidate row at all');
    expect(cutNode.measured).toBeNull();
    expect(cutNode.score).toBeNull();
    expect(cutNode.unmeasurable).toBeNull();
    expect(cutNode.incomplete).toBe('aborted after 26 step(s) in 26000 ms: the search was aborted');

    // OUT OF SELECTION WITHOUT PRETENDING IT SCORED: `failed`, and the DDL's absent
    // reward rather than a zero one. A 0 would claim the node was measured and bad.
    const cutRow = rows.find((row) => row.id === cutNode.id);
    expect(cutRow?.status).toBe('failed');
    expect(cutRow?.visits).toBe(0);
    expect(cutRow?.value).toBe(0);
  }, 60_000);

  test('the node the clock stopped cannot win, even carrying the better program', async () => {
    // THE RANKING WAS MEASURING THE CLOCK. Branch 1 is aborted and reports the OPTIMAL
    // program; branch 0 finished and reports the wasteful one. Measured alike, the
    // aborted node wins on `oracle_calls` — so the search would crown work it stopped
    // mid-step and publish it as the answer.
    const { result } = await run({
      branch0: { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 },
      branch1: { status: 'aborted', content: fenced(OPTIMAL), stepCount: 26 },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    const best = result.best;
    if (!best) throw new Error('the completed node was measurable, so something must be crowned');
    expect(best.incomplete).toBeNull();
    expect(best.artifact).toContain('let wins = 0');
    expect(best.artifact).not.toContain('let best = t[0]');
  }, 60_000);

  test('a run whose every node was cut crowns nothing and says which nodes were cut', async () => {
    // The live run's own shape: the caller's deadline fired mid-wave, so no node
    // finished. `best` is null because there is no signal — not because the candidates
    // scored badly — and every candidate names its own stop.
    const { result } = await run({
      branch0: { status: 'aborted', content: fenced(OPTIMAL), stepCount: 22 },
      branch1: { status: 'aborted', content: fenced(OPTIMAL), stepCount: 26 },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    expect(result.best).toBeNull();
    expect(result.candidates.map((candidate) => candidate.incomplete)).toEqual([
      'aborted after 22 step(s) in 22000 ms: the search was aborted',
      'aborted after 26 step(s) in 26000 ms: the search was aborted',
    ]);
  }, 60_000);

  test('a node that ran out of STEPS is reported the same way, by its own status', async () => {
    // Not only the abort: every non-`completed` status is a node with no answer, and the
    // report names which one it was rather than flattening all three into "unmeasurable".
    const { result } = await run({
      branch0: { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 },
      branch1: { status: 'budget_exceeded', content: 'still working on it', stepCount: 6 },
    });
    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    const cut = result.candidates.find((candidate) => candidate.incomplete !== null);
    expect(cut?.incomplete).toStartWith('budget_exceeded after 6 step(s)');
  }, 60_000);
});

describe('every node runs to a deadline it can observe', () => {
  test('the deadline reaching a node is the derived envelope of its own step cap', async () => {
    // The wiring, at the seam a host actually reads. It used to be an ABSENT key when no
    // caller declared one, and then the only clock a node had was the search's abort
    // signal — a run-level bound that cuts a whole wave mid-step, which is how three
    // nodes inside their step budgets were all stopped at once.
    const { budgets } = await run({
      branch0: { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 },
      branch1: { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 },
      maxSteps: 9,
    });
    expect(budgets).toEqual([nodeWallClockEnvelopeMs(9), nodeWallClockEnvelopeMs(9)]);
  }, 60_000);

  test('a bound the caller DECLARED is honoured exactly; only an absent one is derived', async () => {
    // THE WHOLE OF `runSwarm`'s budget resolution, at the seam a host reads it. Two `??`
    // decide it and neither was fully asserted: the test above declares a step cap and
    // reads back the DERIVED clock, so nothing pinned what reaches a node when a caller
    // declares the clock itself, and nothing pinned the one input on which the two
    // readings of `??` disagree.
    //
    // ZERO IS A DECLARATION, NOT AN ABSENCE, and this tree already says so in the same
    // vocabulary: `budgetExhausted` treats `maxDepth: 0` as exhausted, and `node-agent.ts`
    // records that as a deliberate meaning rather than an accident.
    // `unit-swarm-node-envelope.test.ts` holds the behaviour a zero clock produces. Read
    // the other way, a caller asking for the NARROWEST bound in the file silently
    // receives the WIDEST one — a bound that reports as working while governing nothing.
    const settled: Outcome = { status: 'completed', content: fenced(WASTEFUL), stepCount: 4 };
    const cases = [
      {
        name: 'nothing declared',
        declare: {},
        steps: DEFAULT_MAX_STEPS,
        clock: nodeWallClockEnvelopeMs(DEFAULT_MAX_STEPS),
      },
      {
        name: 'both declared',
        declare: { maxSteps: 9, maxWallClockMs: 250 },
        steps: 9,
        clock: 250,
      },
      {
        name: 'a step cap of zero',
        declare: { maxSteps: 0, maxWallClockMs: 250 },
        steps: 0,
        clock: 250,
      },
      {
        name: 'a clock of zero',
        declare: { maxWallClockMs: 0 },
        steps: DEFAULT_MAX_STEPS,
        clock: 0,
      },
    ] as const;

    for (const declaration of cases) {
      const { result, steps, budgets } = await run({
        branch0: settled, branch1: settled, ...declaration.declare,
      });
      if ('reason' in result) {
        throw new Error(`the run refused with ${declaration.name}: ${result.error}`);
      }
      // BOTH nodes, so a resolution that happened to be right for one node is not
      // mistaken for a run-wide one.
      expect({ case: declaration.name, steps, budgets }).toEqual({
        case: declaration.name,
        steps: [declaration.steps, declaration.steps],
        budgets: [declaration.clock, declaration.clock],
      });
    }
  }, 60_000);
});
