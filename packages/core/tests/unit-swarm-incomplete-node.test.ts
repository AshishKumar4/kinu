/**
 * An unfinished node's summary is a status line (`incompleteHeadSummary`), not a candidate:
 * it is neither measured nor blamed on the instrument. Specified by docs/EXPLORATION.md —
 * "A node is an agent" and "No self-grading".
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

/** Small: every accepted candidate spawns a real process. */
const N = 12;

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


/** Keyed off the prompt, not arrival order: both nodes share one model concurrently. */
function isBranch(prompt: LanguageModelV3Prompt, index: number): boolean {
  return JSON.stringify(prompt).includes(`Your angle: ${diversityAngle(index, 2)}`);
}

function ownTurns(prompt: LanguageModelV3Prompt): number {
  let lastUser = -1;

  for (const [index, message] of prompt.entries()) {
    if (message.role === 'user') lastUser = index;
  }

  return prompt.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;
}

const PROVIDER_DIED = 'the provider died mid-step';

interface Outcome {
  /** `aborted` is run-wide: the signal is the search's, so aborting one node aborts both. */
  readonly ends: 'completed' | 'errored' | 'aborted';
  readonly content: string;
}

/** A tool call forces another SDK step, so a non-`completed` end happens on the second turn. */
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

      // Both siblings script the cancel, so the outcome is the same whichever reaches it first.
      if (outcome.ends === 'aborted') cancel.abort();

      return {
        content: [{ type: 'text' as const, text: 'Reported.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage, warnings: [],
      };
    },
  });
}

async function run(input: {
  readonly branch0: Outcome;
  readonly branch1: Outcome;
  /** Absent is an absent key, and then the node has no clock. */
  readonly maxWallClockMs?: number;
  /** The host refuses one node's actor, so the search holds nothing for it. */
  readonly losesOne?: boolean;
}) {
  const { rt, db } = createTestRuntime();
  const logger = createRecordingLogger();
  const cancel = new AbortController();
  const seats = hostedSeatsOver({ rt, db });
  let seated = 0;

  const deps: SwarmRunDeps = {
    rt,
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

  // Assigned, not spread: "declared nothing" and "declared undefined" must stay distinct.
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

    const measuredNode = result.candidates.find((candidate) => candidate.measured !== null);

    if (!measuredNode) throw new Error('the completed node produced no measurement');
    expect(measuredNode.measured?.value).toBeGreaterThan(N - 1);
    expect(measuredNode.score).toBeTypeOf('number');
    expect(measuredNode.incomplete).toBeNull();
    expect(measuredNode.unmeasurable).toBeNull();

    // No instrument complaint; status word and reason are asserted exactly.
    const cutNode = result.candidates.find((candidate) => candidate.id !== measuredNode.id);

    if (!cutNode) throw new Error('the unfinished node produced no candidate row at all');
    expect(cutNode.measured).toBeNull();
    expect(cutNode.score).toBeNull();
    expect(cutNode.unmeasurable).toBeNull();
    expect(cutNode.incomplete).toMatch(/^errored after \d+ step\(s\) in \d+ ms: /);
    expect(cutNode.incomplete).toContain(PROVIDER_DIED);

    // An absent reward, not 0: a 0 would claim the node was measured and bad.
    const cutRow = rows.find((row) => row.id === cutNode.id);
    expect(cutRow?.status).toBe('failed');
    expect(cutRow?.visits).toBe(0);
    expect(cutRow?.value).toBe(0);
  });

  test('the node that did not finish cannot win, even carrying the better program', async () => {
    // The unfinished branch holds the optimal program: measured alike, it would win on the clock.
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
  });

  test('a run whose every node was cut crowns nothing and says which nodes were cut', async () => {
    // No node finished, so `best` is null for lack of signal.
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
  });

  test('a node that ran out of BUDGET is reported the same way, by its own status', async () => {
    // A zero clock exhausts the node before its first step, so this status is deterministic.
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
  });
});

describe('every node runs to the deadline its caller declared, and to none other', () => {
  test('nothing declared reaches the node as an ABSENT clock', async () => {
    // No derived envelope or step cap: an invented envelope would cut these nodes.
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(WASTEFUL) },
      branch1: { ends: 'completed', content: fenced(WASTEFUL) },
    });

    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.incomplete)).toEqual([null, null]);
  });

  test('a clock the caller declared reaches the node; zero is a declaration', async () => {
    // Zero catches `||` where `??` belongs. Per-node step behaviour is in
    // unit-swarm-node-envelope.test.ts; this pins what the run hands its nodes.
    const settled: Outcome = { ends: 'completed', content: fenced(WASTEFUL) };

    const cases = [
      // Large enough that the report gate's instrument run cannot expire it.
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

      expect({
        case: declaration.name,
        cut: result.candidates.map((candidate) => candidate.incomplete !== null),
      }).toEqual({ case: declaration.name, cut: [...declaration.cut] });
    }
  });
});

/** A node the host could not seat is counted as `lost`, which downgrades `settled` to `budget`. */
describe('a node the run LOST is counted, and the count denies the run a clean settle', () => {
  // `lost` is not on the report; the caller-visible consequence is `stop`.
  test('a dead host leaves the level one candidate short and denies the settle', async () => {
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(OPTIMAL) },
      branch1: { ends: 'completed', content: fenced(WASTEFUL) },
      losesOne: true,
    });

    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);

    expect(result.report.expansions).toBe(1);
    expect(result.report.stop).toBe('budget');
  });

  test('a node that did not finish is carried, so the level keeps both candidates', async () => {
    const { result } = await run({
      branch0: { ends: 'completed', content: fenced(OPTIMAL) },
      branch1: { ends: 'errored', content: fenced(WASTEFUL) },
    });

    if ('reason' in result) throw new Error(`the run refused: ${result.error}`);

    // Contrast: an unfinished node is still held, with its reason.
    expect(result.report.expansions).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.some((candidate) => candidate.incomplete !== null)).toBe(true);
  });

  test('deriveStop: only an untouched budget with a closed frontier earns `settled`', () => {
    const settled = {
      aborted: false, missionSpent: false, lost: 0, remainingBudget: 5, frontierOpen: false,
    };

    expect(deriveStop(settled)).toBe('settled');
    expect(deriveStop({ ...settled, lost: 1 })).toBe('budget');
    expect(deriveStop({ ...settled, missionSpent: true })).toBe('budget');
    expect(deriveStop({ ...settled, remainingBudget: 0, frontierOpen: true })).toBe('budget');
    expect(deriveStop({ ...settled, remainingBudget: 0, frontierOpen: false })).toBe('settled');
    expect(deriveStop({ ...settled, aborted: true, lost: 3 })).toBe('aborted');
  });
});
