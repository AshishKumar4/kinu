// `depth > 1` — the half of the swarm surface that was declared and not real.
//
// A `depth` cap that cannot produce a second level is an axis in the docstring and a
// no-op in the engine, which is the defect *Accepted and ignored* exists to refuse.
// So these tests are about the three things that make the cap real, and each is
// asserted at the level where it can actually fail:
//
//   1. THE ARBITER, as a pure function, against `Exploration/Arbitration.lean`. The
//      Lean file proves five theorems about `arbitrate`; every one of them is
//      universally quantified over the proposal, because a proposal is UNTRUSTED
//      input — a node's request. The suite below is those theorems on the shipped
//      arbiter, so the proven one and the executable one cannot drift apart.
//   2. THE SCHEDULER, over real SQLite rows, because the depth cap is a WHERE-clause
//      exclusion and a WHERE clause is not something a unit test can fake past.
//   3. THE WHOLE RUN, end to end, with a real model call and a REAL MEASUREMENT — the
//      metered-oracle harness spawning node inside the workspace shell. Nothing here
//      stubs the verifier: the point of this work was that the tree climbs the
//      caller's own objective, and a stubbed instrument would assert the plumbing
//      while leaving that claim untested.
//
// CAP EVASION IS TESTED BY ROUTE, not by assertion count. There are exactly three ways
// a node could reach depth `maxDepth + 1` — selection returning a node at the cap, an
// accepted proposal granting children past it, or a child's depth being taken from
// something other than its parent's row — and each has its own test below.
//
// Specified by docs/EXPLORATION.md — "Accepted and ignored", "Arbitration", "Presets",
// "Inherited context", "The publication seal" and "Merge-back".
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { MAX_TX_BLOB_BYTES } from '@nimbus-sh/core/constants.js';
import { Database } from 'bun:sqlite';
import { createTestRuntime, makeSql, makeExecRaw } from './helpers';
import { createRecordingLogger, type LogFields, type RecordingLogger } from '../src/obs/index';
import { initSearchTables } from '../src/mcts/schemas';
import { insertSearchNode } from '../src/mcts/record-node';
import { backpropagate } from '../src/mcts/backpropagation';
import { selectFrontierNode, type FrontierPolicy } from '../src/mcts/frontier';
import { runSwarm } from '../src/strategy/swarm-run';
import { SOLUTION_FILE } from '../src/strategy/exec-ratio';
import { readExplorationCanvas } from '../src/read-models/exploration-canvas';
import type { Refusal } from '../src/obs/error';
import {
  arbitrateBranch, resolveSwarm, swarmValidity,
  BRANCH_PROPOSAL_WIDTH, BRANCH_REFUSAL_POLICIES, SWARM_ADVANCES,
  type BranchProposal, type BranchRefusalPolicy, type ResolvedSwarm,
  type ResolvedSwarmCaps, type SwarmConfig, type SwarmResult,
} from '../src/strategy/swarm';
import { bestInCell, recordsFor, verifierDigestOf } from '../src/strategy/records';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import type { Floor, Objective, ObjectiveIdentity } from '../src/strategy/objective';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { SearchNode } from '../src/types/mcts';
import type { SqlExecutor } from '../src/types/primitives';

/* ── The arbiter, against the theorems ────────────────────────────────────── */

function treeConfig(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'thought' }, context: 'fork',
    expand: 'sample',
    score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
    ...over,
  };
}

function caps(depth: number | null, branches: number): ResolvedSwarmCaps {
  return {
    depth: depth === null ? null : { value: depth, origin: 'call' },
    branches: { value: branches, origin: 'call' },
  };
}

/** A legal proposal: the minimum width `BRANCH_PROPOSAL_WIDTH` states, and no context
 *  conflict. */
function proposal(over?: Partial<BranchProposal>): BranchProposal {
  return {
    rationale: 'this thread splits into two independent sub-questions',
    branches: [
      { task: 'narrow the first way', rationale: 'a', context: 'fresh' },
      { task: 'narrow the second way', rationale: 'b', context: 'fresh' },
    ],
    ...over,
  };
}

/** A proposal whose branches all ask to FORK — the shape the fifth arm refuses under a
 *  `fresh` search and accepts under a forking one. */
function forking(width = 2): BranchProposal {
  return proposal({
    branches: Array.from({ length: width }, (_unused, i) => ({
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'fork' as const,
    })),
  });
}

/** A proposal of exactly `width` branches, for the band checks. */
function widthOf(width: number): BranchProposal {
  return proposal({
    branches: Array.from({ length: width }, (_unused, i) => ({
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'fresh' as const,
    })),
  });
}

describe('*Arbitration* — a node proposes, the engine decides', () => {
  test('a legal proposal is accepted at its own width — the arbiter is not vacuous', () => {
    // Sharpness, and it is load-bearing: every theorem below is an implication OUT of
    // `accepted`, so without this one they would all hold of an arbiter that refuses
    // everything, which would be useless rather than safe. Lean states the same
    // witness for the same reason (`a_legal_proposal_is_accepted`).
    const verdict = arbitrateBranch({
      config: treeConfig(), caps: caps(5, 3), atDepth: 1,
      remainingChildren: 10, proposal: forking(),
    });
    expect(verdict).toEqual({ kind: 'accepted', width: 2 });
  });

  test('all five refusals are reachable, and each NAMES its policy and its state', () => {
    // `every_refusal_is_reachable`. A reason the arbiter can never give is a reason
    // that does not exist, and a refusal that does not say what refused it leaves the
    // node unable to tell refusal from being ignored — so both halves are asserted:
    // the policy token (queryable) and the prose naming the state (actionable).
    const reached: { policy: BranchRefusalPolicy; error: string }[] = [];
    const refusals = [
      // `advance:'none'` has no selection step, so there is no second level for a
      // branch to land on. This is the flat run's honest answer to a proposal.
      arbitrateBranch({
        config: treeConfig({ advance: { kind: 'none' } }), caps: caps(1, 3), atDepth: 0,
        remainingChildren: 10, proposal: proposal(),
      }),
      arbitrateBranch({
        config: treeConfig(), caps: caps(5, 3), atDepth: 1,
        remainingChildren: 10, proposal: widthOf(BRANCH_PROPOSAL_WIDTH.max + 1),
      }),
      // At the cap: the node's children would be depth 2 against a cap of 1.
      arbitrateBranch({
        config: treeConfig(), caps: caps(1, 3), atDepth: 1,
        remainingChildren: 10, proposal: proposal(),
      }),
      arbitrateBranch({
        config: treeConfig(), caps: caps(5, 3), atDepth: 3,
        remainingChildren: 1, proposal: proposal(),
      }),
      // The fifth arm moved onto the axis *Inherited context* governs: a search resolved
      // `fresh` refuses a child that asks to `fork`, which is "a node may narrow and
      // never widen" over the axis that actually owns inheritance.
      arbitrateBranch({
        config: treeConfig({ context: 'fresh' }), caps: caps(5, 3), atDepth: 1,
        remainingChildren: 10, proposal: forking(),
      }),
    ];
    for (const verdict of refusals) {
      expect(verdict.kind).toBe('refused');
      if (verdict.kind !== 'refused') continue;
      reached.push({ policy: verdict.policy, error: verdict.error });
    }
    // Every one of the five, exactly once, in the table's own order.
    expect(reached.map((r) => r.policy)).toEqual([...BRANCH_REFUSAL_POLICIES]);
    // And each names the state that produced it, not merely the rule it broke.
    expect(reached[0]?.error).toContain('advance:"none"');
    expect(reached[1]?.error).toContain('names 5');
    expect(reached[2]?.error).toContain('depth exhausted at depth 1');
    expect(reached[3]?.error).toContain('budget exhausted at depth 3');
    expect(reached[4]?.error).toContain('context:"fresh"');
  });

  test('an absent depth cap refuses as ABSENT, which is not the same as exhausted', () => {
    // Reachable only through `custom` with no `from`: a row exists for every named preset
    // (*Presets*) and none for a composition that named no base. A run whose depth
    // nothing states cannot grant depth, and saying "exhausted" would claim a number
    // was consumed when none was ever declared.
    const verdict = arbitrateBranch({
      config: treeConfig(), caps: caps(null, 3), atDepth: 0,
      remainingChildren: 10, proposal: proposal(),
    });
    expect(verdict).toMatchObject({ kind: 'refused', policy: 'depth-exhausted' });
    if (verdict.kind !== 'refused') return;
    expect(verdict.error).toContain('absent depth rather than an exhausted one');
  });

  test('CAP EVASION, route 1: no proposal is granted children past the cap', () => {
    // S3 where it has CONTENT rather than where it is definitional — the depth comes
    // from the row the engine wrote, and the proposal is a request over it. Quantified
    // over the whole grid rather than sampled, and the assertion is the theorem:
    // accepted ⟹ atDepth + 1 ≤ maxDepth.
    for (const maxDepth of [1, 2, 3, 5]) {
      for (let atDepth = 0; atDepth <= 7; atDepth += 1) {
        const verdict = arbitrateBranch({
          config: treeConfig(), caps: caps(maxDepth, 3), atDepth,
          remainingChildren: 99, proposal: proposal(),
        });
        if (verdict.kind === 'accepted') expect(atDepth + 1).toBeLessThanOrEqual(maxDepth);
        else expect(atDepth + 1).toBeGreaterThan(maxDepth);
      }
    }
  });

  test('the adversarial proposal — 400 children at depth 99 — gets a reason, not children', () => {
    const verdict = arbitrateBranch({
      config: treeConfig(), caps: caps(5, 3), atDepth: 99,
      remainingChildren: 10, proposal: widthOf(400),
    });
    expect(verdict).toMatchObject({ kind: 'refused', policy: 'width-out-of-range' });
  });

  test('a proposal cannot mint children the search cannot pay for', () => {
    // `accepted_within_budget` — the other half of S8. The budget is the SEARCH's,
    // shared by every node, so a proposal is an input to `advance` and not a bypass.
    for (let remaining = 0; remaining <= 5; remaining += 1) {
      const verdict = arbitrateBranch({
        config: treeConfig(), caps: caps(5, 3), atDepth: 1,
        remainingChildren: remaining, proposal: widthOf(3),
      });
      if (verdict.kind === 'accepted') expect(verdict.width).toBeLessThanOrEqual(remaining);
      else expect(remaining).toBeLessThan(3);
    }
  });

  test('every proposal gets a verdict — there is no third outcome meaning "ignored"', () => {
    // `every_proposal_gets_a_verdict`, over a grid that crosses every arm. Silence is the
    // failure mode *Arbitration* is written against: a node that cannot tell refusal from
    // being ignored will simply propose again.
    for (const advance of SWARM_ADVANCES) {
      for (const context of ['fork', 'fresh'] as const) {
        for (const width of [0, 1, 2, 4, 5]) {
          for (const asked of ['fork', 'fresh'] as const) {
            const verdict = arbitrateBranch({
              config: treeConfig({
                advance: advance === 'archive' ? { kind: advance, novelty: 0.6 } : { kind: advance },
                context,
              }),
              caps: caps(3, 2), atDepth: 1,
              remainingChildren: 4,
              proposal: asked === 'fork' ? forking(width) : widthOf(width),
            });
            expect(['accepted', 'refused']).toContain(verdict.kind);
            if (verdict.kind === 'refused') expect(verdict.error.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

/* ── The scheduler, over real rows ────────────────────────────────────────── */

interface Tree {
  readonly sql: SqlExecutor;
  readonly rootId: string;
  /** Record a child of `parentId`, at the depth the ENGINE derives, and give it its
   *  own reward. Returns the child's id. */
  child(parentId: string, reward: number | null): string;
  depthOf(nodeId: string): number;
  select(policy: FrontierPolicy, maxDepth: number): SearchNode | null;
}

/** A tree over an in-memory database, built the way the runner builds one: the depth
 *  is always the parent's row plus one, never a number the caller chose. */
function tree(): Tree {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initSearchTables(makeExecRaw(db), sql);
  const rootId = 'root';
  let minted = 0;
  insertSearchNode(sql, {
    nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
    task: 't', action: '', observation: 'as found', codeUsed: null, depth: 0, msgId: null,
  });
  const depthOf = (nodeId: string): number =>
    sql<{ depth: number }>`SELECT depth FROM search_nodes WHERE id = ${nodeId}`[0]?.depth ?? -1;
  return {
    sql,
    rootId,
    depthOf,
    child(parentId, reward) {
      minted += 1;
      const id = `n${String(minted)}`;
      insertSearchNode(sql, {
        nodeId: id, parentNodeId: parentId, parentMsgId: null, rootId,
        task: 't', action: '', observation: `answer ${id}`, codeUsed: null,
        depth: depthOf(parentId) + 1, msgId: null,
      });
      if (reward !== null) backpropagate(sql, id, reward);
      return id;
    },
    select(policy, maxDepth) {
      return selectFrontierNode(sql, { rootId, policy, maxDepth, explorationWeight: 1.4 });
    },
  };
}

describe('the scheduler: one policy per `advance`, and the cap is a WHERE clause', () => {
  test('a scored frontier DESCENDS, so a second level is reachable at all', () => {
    // The property `depth > 1` needs and did not have: after the root's children are
    // scored, selection must be able to return one of THEM, because that is the only
    // way a depth-2 node can come to exist.
    const t = tree();
    const good = t.child(t.rootId, 0.9);
    t.child(t.rootId, 0.1);
    for (const policy of ['uct', 'best-first'] as const) {
      const next = t.select(policy, 3);
      expect(next).not.toBeNull();
      expect(next?.depth).toBe(1);
      // And it picks the child that MEASURED better, which is the objective reaching
      // selection rather than row order deciding.
      expect(next?.id).toBe(good);
    }
  });

  test('CAP EVASION, route 2: a node at the cap is never SELECTED, at any width', () => {
    // WP-A4: the cap excludes, it does not abort. The invariant is not "nothing is
    // selectable at the cap" — under `uct` the ROOT stays selectable, because
    // re-selecting an expanded node is re-widening and a wider level is not a deeper
    // one. The invariant is that no node at depth >= maxDepth is ever returned, which
    // is what makes a child at maxDepth + 1 unreachable: a child comes from a selected
    // parent, and no parent past the cap is ever selected.
    const t = tree();
    t.child(t.rootId, 0.9);
    t.child(t.rootId, 0.4);
    for (const policy of ['uct', 'best-first', 'none'] as const) {
      for (const maxDepth of [1, 2, 3]) {
        const selected = t.select(policy, maxDepth);
        if (selected) expect(selected.depth).toBeLessThan(maxDepth);
      }
    }
    // The two frontier policies have nothing left at depth 1 that they may expand,
    // and say so rather than returning a capped node.
    for (const policy of ['best-first', 'none'] as const) {
      expect(t.select(policy, 1)).toBeNull();
    }
    // Raising the cap makes the same depth-1 rows selectable, so the nulls above are
    // the cap talking and not an empty frontier.
    expect(t.select('best-first', 2)?.depth).toBe(1);
  });

  test('CAP EVASION, route 3: a child never states its own depth', () => {
    // `subordinates/depth.ts`'s discipline, one level over: the number is derived from
    // the parent's row, so a chain of five is exactly 1..5 and nothing in the child's
    // own content can move it.
    const t = tree();
    let parent = t.rootId;
    for (let expected = 1; expected <= 5; expected += 1) {
      parent = t.child(parent, 0.5);
      expect(t.depthOf(parent)).toBe(expected);
    }
  });

  test('advance:\'none\' expands the root once and then stops — the flat run, as a selection', () => {
    const t = tree();
    expect(t.select('none', 1)?.id).toBe(t.rootId);
    t.child(t.rootId, 0.5);
    // Expanded: there is no second level to reach, which is exactly what the
    // `depth > 1` refusal for this axis value says in prose.
    expect(t.select('none', 1)).toBeNull();
    expect(t.select('none', 9)).toBeNull();
  });

  test('best-first takes the best UNEXPANDED node, so it cannot stall on a parent', () => {
    // Why this is not `uct` with a zero weight: a parent's backpropagated mean can tie
    // its best child, and a greedy argmax over all open nodes would then re-pick the
    // node it just expanded, forever. The frontier is read off the tree.
    const t = tree();
    const first = t.child(t.rootId, 1);
    expect(t.select('best-first', 3)?.id).toBe(first);
    const under = t.child(first, 1);
    // `first` now has a child, so best-first moves on rather than re-picking it.
    expect(t.select('best-first', 3)?.id).toBe(under);
  });

  test('the level-synchronised schedule went with `beam`, and best-first does not replace it', () => {
    // The honest record of what the cut cost. `beam` selected exactly what
    // best-first selects — highest value, unexpanded — and differed only in ORDER:
    // `depth ASC` finished a whole level before entering the next. Nothing left in
    // the scheduler reproduces that, and this asserts the difference rather than
    // claiming an equivalence.
    const t = tree();
    const best = t.child(t.rootId, 0.9);
    const second = t.child(t.rootId, 0.8);
    t.child(t.rootId, 0.2);

    expect(t.select('best-first', 4)?.id).toBe(best);
    // A deeper child of the best node now outranks every remaining depth-1 sibling,
    // and best-first DESCENDS to it immediately. A beam would have expanded
    // `second` first, because it was still on the level being swept.
    const deeper = t.child(best, 0.95);
    const next = t.select('best-first', 4);
    expect(next?.id).toBe(deeper);
    expect(next?.depth).toBe(2);
    expect(next?.id).not.toBe(second);
  });
});

/* ── The whole run, with a real measurement ───────────────────────────────── */

/**
 * A measurable optimisation task, in full, as `exec-ratio` takes it.
 *
 * Deliberately NOT a corpus entry: this suite is about the tree, so its instrument is
 * the smallest thing that genuinely measures — find the largest of `n` opaque tokens
 * through a counted `greater` oracle. The reference is correct and wasteful (it
 * verifies every token against every other), the optimum is one linear scan, and the
 * gap between them is the gradient the tree climbs.
 *
 * `n` is small because every measurement spawns a real node process inside the
 * workspace shell, and this suite makes several.
 */
const N = 24;

const REFERENCE = `export function solve(input, oracle) {
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

/** The harness body: build one instance, meter the oracle, compare both answers
 *  through the same decoder. `P`, `shuffle`, `tok`, `valueOf`, `meter`, `trial` and
 *  `emitTrials` all come from the shared prologue. */
const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
`;

/** The optimum: one pass, n-1 calls. What a model would have to find. */
const OPTIMAL = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

/**
 * The suite's objective.
 *
 * `floor` is an override rather than a constant because one thing this file has to reach
 * is a REFUTED bound. The shipped floor of ceil(n/2) is sound, and no honest candidate
 * can cross it, so a seal is unreachable through it — which is correct and also means
 * the seal's own wiring would go untested. A caller passing a floor ABOVE the optimum
 * gets a bound the run's first correct candidate refutes, which is hypothesis H1 exactly:
 * the floor is wrong.
 */
function objective(floor?: Floor): Objective {
  return {
    kind: 'scalar',
    metric: 'oracle_calls',
    unit: 'oracle calls',
    direction: 'minimise',
    scale: 'log',
    // The measured cost of the best algorithm there is for this task.
    target: N - 1,
    verify: {
      kind: 'exec-ratio',
      spec: {
        params: { n: N, seed: 7 },
        reference: REFERENCE,
        body: BODY,
        targetOps: N - 1,
        lowerBoundOps: Math.ceil(N / 2),
      },
    },
    floor: floor ?? {
      value: Math.ceil(N / 2),
      kind: 'certificate',
      bestKnownHonest: N - 1,
      proof: 'Every token must appear in at least one comparison and a comparison '
        + 'touches two, so covering n needs at least ceil(n/2) calls.',
    },
  };
}

/**
 * A model that answers with the optimal solution, and — when asked to — appends a branch
 * proposal of `proposeWidth` sub-questions.
 *
 * `answers` is a parameter so a test can vary the ANSWER without a second copy of this
 * model, and it is a LIST cycled one per call: an archive needs a wave whose members
 * differ, either in the cell their measurement puts them in or in how far apart their text
 * is, and one fixed answer produces neither. `seen` collects the prompts it was sent, for
 * the tests that have to assert what a child was TOLD.
 */
function answering(
  proposeWidth: number | null,
  answers: readonly [string, ...string[]] = [OPTIMAL],
  seen?: string[],
): MockLanguageModelV3 {
  let answered = 0;
  const branch = proposeWidth === null ? '' : `\n\nPROPOSE-BRANCH\n${JSON.stringify({
    rationale: 'the tail of this task deserves its own thread',
    branches: Array.from({ length: proposeWidth }, (_unused, i) => ({
      task: `narrow the search, angle ${String(i)}`,
      rationale: 'worth its own budget',
      context: 'fresh',
    })),
  })}\n`;
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-swarm',
    doGenerate: async (options) => {
      seen?.push(JSON.stringify(options.prompt));
      return {
        content: [{
          type: 'text' as const,
          text: `Here is my approach.\n\n\`\`\`javascript\n${
            answers[answered++ % answers.length] ?? OPTIMAL}\`\`\`${branch}`,
        }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 34, text: 34, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/** A resolved `custom` composition, through the real resolver and the real validity
 *  predicate — a test that hand-built a `ResolvedSwarm` could assert a tree the tool
 *  surface cannot actually ask for. */
function resolved(
  depth: number, branches: number, over?: Partial<SwarmConfig>, floor?: Floor, key?: string,
): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'depth-suite',
    task: `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls.`,
    objective: objective(floor),
    config: treeConfig(over),
    depth,
    branches,
    key,
  });
  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);
  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);
  return call;
}

interface Run {
  readonly logger: RecordingLogger;
  readonly nodes: readonly SearchNode[];
  readonly result: SwarmResult | Refusal;
  /** Every prompt the model was actually sent, serialized. The only way to assert what a
   *  child was TOLD rather than what the engine computed. */
  readonly prompts: readonly string[];
}

async function run(input: {
  readonly depth: number;
  readonly branches: number;
  readonly proposeWidth: number | null;
  readonly config?: Partial<SwarmConfig>;
  /** A bound the run will refute, for the seal's own wiring. */
  readonly floor?: Floor;
  /** The coverage descriptor `advance:'archive'` bins by, and which every other advance
   *  is refused for supplying. */
  readonly key?: string;
  /** The answers the wave produces, cycled one per model call. One fixed answer where a
   *  test does not care, several where the cells or the distances between candidates are
   *  what it is about. */
  readonly answers?: readonly [string, ...string[]];
  /** The workspace to run IN. Supplied where a test needs two runs to share one store,
   *  which is the only way "a record survives a run" can be asserted at all. */
  readonly rt?: AgentRuntime;
}): Promise<Run> {
  const rt = input.rt ?? createTestRuntime().rt;
  const logger = createRecordingLogger();
  const prompts: string[] = [];
  const result = await runSwarm(
    { rt, model: answering(input.proposeWidth, input.answers ?? [OPTIMAL], prompts), mode: 'build', logger },
    resolved(input.depth, input.branches, input.config, input.floor, input.key),
  );
  const nodes = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { logger, nodes, result, prompts };
}

describe('a swarm at depth 2 expands, and its tree is measured', () => {
  test('depth 2 is REACHED, every node is derived from its parent, and the cap holds', async () => {
    const { nodes, result, logger } = await run({ depth: 2, branches: 2, proposeWidth: null });
    // Not a refusal any more. This is the whole ticket: the same call was
    // `unsupported` because no engine here scored nodes against the caller's metric.
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    // THE CLAIM: a second level exists.
    const depths = nodes.map((node) => node.depth);
    expect(Math.max(...depths)).toBe(2);
    expect(depths.filter((depth) => depth === 2).length).toBeGreaterThan(0);
    // The root is the workspace as found, and it is the only node at depth 0.
    expect(depths.filter((depth) => depth === 0)).toEqual([0]);
    // Every non-root node's depth is exactly its parent's plus one — derived, never
    // stated. Asserted over the rows rather than trusted from the code that wrote them.
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (node.parent_id === null) continue;
      expect(node.depth).toBe((byId.get(node.parent_id)?.depth ?? -99) + 1);
    }
    // The budget is depth × branches, and the tree spent it on real children.
    expect(result.report.expansions).toBe(4);
    expect(result.candidates.length).toBe(4);

    // AND THE OBJECTIVE IS WHAT WAS MEASURED — the reason this needed its own engine.
    // The candidate is the optimal algorithm, so it measures the target and scores 1.
    expect(result.best).not.toBeNull();
    expect(result.best?.measured?.kind).toBe('measured');
    expect(result.best?.measured?.value).toBe(N - 1);
    expect(result.best?.score).toBe(1);
    expect(result.report.baseline).toBeGreaterThan(N - 1);
    // A measured run, not a judged one: the baseline came off the instrument.
    expect(logger.emitted.map((line) => line.event)).toContain('swarm.baseline_measured');
    // The floor was computed and surfaced at declaration, never thresholded, and
    // nothing breached it, so the answer is publishable.
    expect(result.report.floorMargin).toBeGreaterThan(0);
    expect(result.publication.state.kind).toBe('open');
    expect(result.publication.caveat).toBeNull();
  }, 120_000);

  test('depth 1 is UNCHANGED: one wave, one level, and the flat report it always gave', async () => {
    // The regression that matters most. Enabling the tree must not move the depth that
    // already ran, and `advance:'none'` is the axis value that fixes depth at 1.
    const { nodes, result } = await run({
      depth: 1, branches: 3, proposeWidth: null,
      config: { advance: { kind: 'none' }, score: { kind: 'verify' } },
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;
    expect(Math.max(...nodes.map((node) => node.depth))).toBe(1);
    expect(result.candidates.length).toBe(3);
    expect(result.report.expansions).toBe(3);
    // A full width came back with nothing left to select: settled, not truncated.
    expect(result.report.stop).toBe('settled');
  }, 120_000);

  test('a REFUSED proposal names its reason, and the node still gets expanded', async () => {
    // Seven sub-questions against the arbiter's declared band of 2-4
    // (`BRANCH_PROPOSAL_WIDTH`). The refusal must reach the diagnostics stream carrying
    // its policy token and its prose, because a toolless node has already finished its
    // turn and this is the only channel that exists.
    const { logger, result, nodes } = await run({ depth: 2, branches: 2, proposeWidth: 7 });
    expect('reason' in result).toBe(false);

    const refusals = logger.emitted.filter((line) => line.event === 'swarm.branch_refused');
    expect(refusals.length).toBeGreaterThan(0);
    const fields = refusals[0]?.fields;
    expect(fields).toMatchObject({ policy: 'width-out-of-range' });
    expect(String(fields?.error)).toContain('names 7');
    // Every refusal names WHERE it happened, and it names it from the ROW: the id
    // belongs to a node of this tree, and the depth the verdict discloses is that
    // row's own derived depth rather than anything the node said about itself.
    for (const refusal of refusals) {
      const row = nodes.find((node) => node.id === String(refusal.fields.node));
      expect(row).toBeDefined();
      expect(refusal.fields.depth).toBe(row?.depth ?? -1);
    }
    // Refused the BRANCH, not the node: the engine still expanded it under its own
    // policy, so a bad proposal costs the node its request and not its turn.
    expect(Math.max(...nodes.map((node) => node.depth))).toBe(2);
  }, 120_000);

  test('an ACCEPTED proposal expands at the node, and its children stay inside the cap', async () => {
    const { logger, nodes, result } = await run({ depth: 3, branches: 2, proposeWidth: 3 });
    expect('reason' in result).toBe(false);

    const accepted = logger.emitted.filter((line) => line.event === 'swarm.branch_accepted');
    expect(accepted.length).toBeGreaterThan(0);
    // Accepted at the proposal's own width — three, where the search's own width is
    // two — which is how the node's information reaches the search at all.
    expect(accepted[0]?.fields).toMatchObject({ children: 3 });
    // CAP EVASION, end to end: every node proposed on every call and nothing reached
    // depth 4.
    //
    // WORTH BEING PRECISE ABOUT WHAT THIS DOES AND DOES NOT PROVE, so nobody later
    // mistakes it for the cap's own test. Under the derived budget (depth × branches)
    // the budget bounds reachable depth at `depth` on its own, and the schedulers'
    // exploration term prefers a shallower unexpanded node to a deeper one — so an
    // end-to-end run cannot be made to WANT a node past the cap, and removing the cap
    // does not change this assertion. The cap is therefore proven where it acts: in
    // selection (`CAP EVASION, route 2`, which a mutation of the WHERE clause turns
    // red) and in arbitration (`route 1`). What this line proves is the composition of
    // the three: with proposals granted at a width the search did not choose, the tree
    // still lands inside the cap.
    expect(Math.max(...nodes.map((node) => node.depth))).toBeLessThanOrEqual(3);
  }, 120_000);

  test('nothing a node asks for is dropped in silence — every proposal is answered', async () => {
    // The rule *Arbitration* states, as a count: a node that cannot tell refusal from
    // being ignored will simply propose again. Every child here proposes, so every child
    // must appear in exactly one verdict — the ones selection reached, and the ones swept
    // afterwards.
    const { logger, nodes } = await run({ depth: 2, branches: 2, proposeWidth: 2 });
    const answered = logger.emitted
      .filter((line) => line.event === 'swarm.branch_refused')
      .map((line) => String(line.fields.node));
    const accepted = logger.emitted
      .filter((line) => line.event === 'swarm.branch_accepted')
      .map((line) => String(line.fields.node));
    // Every node that is not the root proposed, since the mock always appends a block.
    const proposers = nodes.filter((node) => node.parent_id !== null).map((node) => node.id);
    expect(proposers.length).toBeGreaterThan(0);
    for (const id of proposers) {
      expect([...answered, ...accepted]).toContain(id);
    }
    // And the ones the budget outlived are refused for the BUDGET, at their own depth,
    // which is the reason that only the post-loop sweep can reach.
    const budget = logger.emitted.filter((line) =>
      line.event === 'swarm.branch_refused' && line.fields.policy === 'budget-exhausted');
    expect(budget.length).toBeGreaterThan(0);
    expect(String(budget[0]?.fields.error)).toContain('budget exhausted at depth');
    // AND A NODE AT THE CAP THAT PROPOSES ANYWAY IS TOLD SO — route 1, reached end to
    // end. A depth-2 node in a depth-2 search is never INVITED to propose (*Build-time
    // exclusion*: a request that could only be refused is not offered), but this
    // model appends a block regardless, which is exactly what an untrusted node does.
    // The sweep answers it by name instead of dropping it.
    const capped = logger.emitted.filter((line) =>
      line.event === 'swarm.branch_refused' && line.fields.policy === 'depth-exhausted');
    expect(capped.length).toBeGreaterThan(0);
    expect(capped[0]?.fields.depth).toBe(2);
    expect(String(capped[0]?.fields.error)).toContain('depth exhausted at depth 2');
    // And no node that asked from the cap was given children.
    const cappedIds = new Set(capped.map((line) => String(line.fields.node)));
    for (const node of nodes) {
      if (node.parent_id !== null && cappedIds.has(node.parent_id)) {
        throw new Error(`node ${node.parent_id} was refused at the cap and still got a child`);
      }
    }
  }, 120_000);

  test('the deepest level a branch could still be granted from is invited to propose', async () => {
    // THE BOUNDARY BELONGS TO `arbitrateBranch` ALONE, which refuses
    // `caps.depth.value <= atDepth`. So in a depth-2 search a proposal from depth 1 is
    // granted and one from depth 2 is refused, and the prompt must invite depth 1 and
    // not depth 2. The agent-node tool gate and the fan-in skip already spell that
    // boundary; the thought node's invitation read one level tighter and suppressed
    // itself on the only level that could have been granted, so no node in a depth-2
    // thought search was ever asked.
    //
    // ASSERTED THROUGH WHAT THE MODEL WAS SENT, because the invitation is prompt text
    // and nothing else observes it. `proposeWidth: null` matters: this suite's model
    // appends a proposal block whether or not it was invited, which is exactly how the
    // suite stayed green while the invitation was missing — the tree still expanded, so
    // every count and every event looked right.
    const { nodes, prompts } = await run({ depth: 2, branches: 2, proposeWidth: null });
    const invited = prompts.filter((sent) => sent.includes('You are proposing, not spawning'));
    const oneBelowTheCap = nodes.filter((node) => node.depth === 1).length;
    expect(oneBelowTheCap).toBeGreaterThan(0);
    expect(invited).toHaveLength(oneBelowTheCap);
    // And the level AT the cap is not asked, so the count above is not "all of them".
    expect(invited.length).toBeLessThan(prompts.length);
  }, 120_000);
});

/* ── `carry` admission is consulted at the settle barrier ─────────────────── */

// LIVES HERE BECAUSE THE REAL RUN LIVES HERE. `unit-merge-back.test.ts` covers what
// `admitCarry` decides; this covers whether the decision is REACHED — and the only
// harness in the suite that drives a genuine settle, with real candidates carrying real
// normalised scores, is the one above. A second copy of this objective, model and
// resolver would be eighty duplicated lines defending a one-line call site.
//
// The defect being closed: `carry:'artifacts'` declares an admission `threshold` on its
// own arm and NOTHING read it, so a tagged parameter changed nothing.
describe('carry admission at the settle barrier', () => {
  test('the artifacts threshold is read, and a candidate under it is not carried', async () => {
    // Above any normalised score, so every candidate must fall under it. A wiring that
    // ignored the threshold would admit them instead, which is the failure this asserts
    // against rather than around.
    const { logger, result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 2 } },
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const refused = logger.emitted.filter((line) => line.event === 'swarm.carry_refused');
    // NOT VACUOUS: a run that produced no candidates would emit no per-candidate events
    // and every assertion below would hold trivially.
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]?.fields).toMatchObject({
      carry: 'artifacts', threshold: 2, cause: 'below-threshold',
    });
    expect(logger.emitted.filter((line) => line.event === 'swarm.carry_admitted')).toHaveLength(0);

    // And the aggregate, so "how many survived this run" is one line rather than a count
    // over N of them.
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.carry_settled');
    expect(settled?.fields).toMatchObject({ carry: 'artifacts', admitted: 0 });
    expect(settled?.fields.refused).toBe(refused.length);
  }, 120_000);

  test('a reachable threshold carries the candidates that clear it', async () => {
    const { logger, result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 0 } },
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const admitted = logger.emitted.filter((line) => line.event === 'swarm.carry_admitted');
    expect(admitted.length).toBeGreaterThan(0);
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.carry_settled');
    expect(settled?.fields.admitted).toBe(admitted.length);
  }, 120_000);
});

/* ── The records store: what one run reached, the next one starts from ────── */

// LIVES HERE FOR THE REASON THE BLOCK ABOVE DOES: the only harness in this repository
// that drives a genuine settle with real candidates carrying real measured values is
// this one. `unit-exploration-records.test.ts` proves what the store DECIDES — the seal,
// the monotone rule, the floor-carrying key, the displacement counter — over rows it
// writes directly. These prove the decisions are REACHED, and that the read half exists:
// a writer nothing reads back persists rows no run ever starts from, which is the same
// per-invocation search with a table beside it.

/**
 * The identity a run of this suite's objective resolves to.
 *
 * DERIVED the way the run derives it — the spec the objective names, and the code that
 * name resolved to through the registry — rather than restated beside it. A restated
 * digest would go green while the run wrote a different key, which is the one failure a
 * test that reads the store back has to be unable to have.
 *
 * A function and not a module constant: it hashes, and this repository has already had
 * a module-scope digest reach `node:crypto` on an import path where the bundler shims it
 * to a throwing stub. The rule is cheap to keep everywhere rather than remembered where
 * it bites.
 */
function identityOf(): ObjectiveIdentity {
  const scalar = objective();
  if (scalar.kind !== 'scalar' || !('kind' in scalar.verify)) {
    throw new Error("the suite's objective is a scalar naming a registered verifier kind");
  }
  const instrument = resolveVerifier(scalar.verify);
  if ('reason' in instrument) {
    throw new Error(`the suite's own verifier does not resolve: ${instrument.error}`);
  }
  return {
    metric: scalar.metric,
    unit: scalar.unit,
    direction: scalar.direction,
    scale: scalar.scale,
    verifierDigest: verifierDigestOf(scalar.verify, instrument.implementation),
  };
}

const SUITE_FLOOR: Floor = {
  value: Math.ceil(N / 2),
  kind: 'certificate',
  bestKnownHonest: N - 1,
  proof: 'Every token must appear in at least one comparison and a comparison '
    + 'touches two, so covering n needs at least ceil(n/2) calls.',
};

/** A bound the optimum itself refutes: the optimum spends n-1 calls, so a floor above
 *  that is crossed by the first correct candidate. H1, in a fixture. */
const REFUTED_FLOOR: Floor = {
  value: N + 6,
  kind: 'certificate',
  bestKnownHonest: N + 16,
  proof: 'A deliberately wrong bound, so the run has a breach to be sealed by.',
};

describe('the records store: what one run reached, the next one starts from', () => {
  test("A RECORD SURVIVES ONE RUN AND THE NEXT RUN READS IT", async () => {
    // THE WHOLE TICKET, end to end. Two runs, one workspace. The first writes what it
    // reached; the second reads it before it expands anything and says so on its own
    // report. Without the read half this passes on a store nothing consults.
    const { rt } = createTestRuntime();

    const first = await run({
      depth: 1, branches: 2, proposeWidth: null, rt,
      config: { carry: { kind: 'elites' } },
    });
    expect('reason' in first.result).toBe(false);
    if ('reason' in first.result) return;
    // Nothing to carry in — this is the first run of this objective in this workspace.
    expect(first.result.report.records).toMatchObject({ carriedIn: 0, carriedInBest: null });
    expect(first.result.report.records?.written).toBeGreaterThan(0);

    // The row is REALLY there, read back the way a consumer reads it: scoped by the
    // identity and the floor, never by the objective id alone.
    const persisted = recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]?.value).toBe(first.result.best?.measured?.value ?? -1);
    expect(persisted[0]?.rootId).toBe(first.nodes[0]?.id ?? '');

    const second = await run({
      depth: 1, branches: 2, proposeWidth: null, rt,
      config: { carry: { kind: 'elites' } },
    });
    expect('reason' in second.result).toBe(false);
    if ('reason' in second.result) return;

    // READ. The number the first run reached is the number the second one started from.
    expect(second.result.report.records?.carriedIn).toBe(persisted.length);
    expect(second.result.report.records?.carriedInBest).toBe(persisted[0]?.value ?? -1);
    const carried = second.logger.emitted.filter((line) => line.event === 'swarm.records_carried_in');
    expect(carried).toHaveLength(1);
    expect(carried[0]?.fields).toMatchObject({ carry: 'elites', best: persisted[0]?.value ?? -1 });

    // AND THE SEARCH WAS TOLD. Without this the read is a number on a report and the
    // store is still something no run starts FROM: `carriedIn` would hold while the
    // prompt-side wiring was dead code. Asserted over what the model was actually sent.
    const told = second.prompts.filter((sent) => sent.includes('An earlier run of this same objective'));
    expect(told).toHaveLength(second.prompts.length);
    // The number to beat AND the program that reached it — the number alone is a bar with
    // no way to clear it, and the program alone is code with no reason to trust it.
    expect(told[0]).toContain(String(persisted[0]?.value ?? -1));
    expect(told[0]).toContain('function solve');
    // The FIRST run had nothing to inherit, so this is not passing on a string the
    // prompt always carries.
    expect(first.prompts.some((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(false);
  }, 120_000);

  test('re-running the same search does not lower what the store holds', async () => {
    // The monotone rule through the real path. The model answers with the same optimum
    // both times, so the second run re-records one artifact at the same number — a tie,
    // which does not displace — and the store says so instead of silently rewriting.
    const { rt } = createTestRuntime();
    const first = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'elites' } },
    });
    expect('reason' in first.result).toBe(false);
    const before = recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR });

    const second = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'elites' } },
    });
    expect('reason' in second.result).toBe(false);
    if ('reason' in second.result) return;
    expect(second.result.report.records?.notBetter).toBeGreaterThan(0);
    expect(second.result.report.records?.written).toBe(0);

    const after = recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(after).toHaveLength(before.length);
    expect(after[0]?.value).toBe(before[0]?.value ?? -1);
  }, 120_000);

  test("`carry:'artifacts'` admissions reach persistence, and a refused one writes nothing", async () => {
    // Both publishing carries land in this store — `SWARM_CARRIES` says the store IS
    // where the axis lands — so the threshold that gates admission gates the write too.
    const clears = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 0 } },
    });
    expect('reason' in clears.result).toBe(false);
    if ('reason' in clears.result) return;
    const records = clears.result.report.records;
    expect(records?.written).toBeGreaterThan(0);
    // One event per row, so the aggregate on the report and the per-row trail cannot
    // disagree about how many survived.
    expect(clears.logger.emitted.filter((line) => line.event === 'swarm.record_written').length)
      .toBe(records?.written ?? -1);

    const misses = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 2 } },
    });
    expect('reason' in misses.result).toBe(false);
    if ('reason' in misses.result) return;
    // Refused at the barrier, so the writer is never reached and nothing lands.
    expect(misses.result.report.records).toMatchObject({ written: 0, notBetter: 0 });
  }, 120_000);

  test("a run whose `carry` writes nothing a later run reads neither writes nor reads", async () => {
    const { rt } = createTestRuntime();
    const seeded = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'elites' } },
    });
    expect('reason' in seeded.result).toBe(false);

    const isolated = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'none' } },
    });
    expect('reason' in isolated.result).toBe(false);
    if ('reason' in isolated.result) return;
    // The store HAS a row, and this run neither read it nor attempted a write: the
    // barrier ADMITS every candidate under `carry:'none'` — the seal is not that value's
    // business — so the whole shape is asserted rather than the two fields that would
    // still hold if the writer read that verdict and only the monotone rule stopped it.
    expect(recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR }).length)
      .toBeGreaterThan(0);
    expect(isolated.logger.emitted.filter((line) => line.event === 'swarm.carry_admitted').length)
      .toBeGreaterThan(0);
    expect(isolated.result.report.records).toEqual({
      carriedIn: 0, carriedInBest: null, carriedInCells: 0, written: 0, notBetter: 0, tooClose: 0,
    });
  }, 120_000);

  test('A BREACHED RUN WRITES NOTHING — the seal reaches the store', async () => {
    // *The publication seal* at this surface, through the real engine: the run measures a
    // candidate past a bound the candidate itself refutes, the floor is suspended, and the
    // leaderboard stays empty. The run does NOT halt — the verifier still works and the
    // calling turn is the primary consumer — which is what makes "wrote nothing" the
    // assertion rather than "refused".
    const { rt } = createTestRuntime();
    const breached = await run({
      depth: 1, branches: 2, proposeWidth: null, rt,
      floor: REFUTED_FLOOR,
      config: { carry: { kind: 'elites' } },
    });
    expect('reason' in breached.result).toBe(false);
    if ('reason' in breached.result) return;

    expect(breached.result.publication.state.kind).toBe('sealed');
    expect(breached.result.report.records).toMatchObject({ written: 0 });
    expect(recordsFor(rt.storage.sql, { identity: identityOf(), floor: REFUTED_FLOOR })).toHaveLength(0);
    // And the run says the carry was voided, with the cell count that tells the next run
    // what the seal cost it.
    expect(breached.result.report.carrySuppressed?.carry).toBe('elites');
    expect(breached.result.report.carrySuppressed?.refused).toContain('records');
  }, 120_000);
});

/* ── `score:'judge'` runs from the swarm path ─────────────────────────────── */

// The refusal said judge "needs the marginalised ensemble the shipped tree owns", and the
// tree owns one: `mcts/evaluation.ts` samples a judge `k` times over one prompt and takes
// the median. These prove the swarm path REACHES it, and that the clamp between what a
// caller asks for and what the call budget funds stays visible.
describe("score:'judge' reaches the ensemble the tree already owns", () => {
  test('A JUDGED TREE RUNS, and the run record states 3 realised against 20 requested', async () => {
    // The two numbers the measurement fixed. 20 is the marginalisation floor a judged
    // tree must ask for; 3 is what the shipped per-evaluation call budget funds on a
    // code-bearing candidate, `min(20, 4 - 1)`. A wiring that let the clamp bind in
    // silence would report 20 here, or nothing.
    const { result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } },
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    expect(result.report.judgeEnsemble).toEqual({ requested: 20, realised: 3 });
    // It genuinely SCORED: a judged candidate carries the ensemble's number and no
    // measurement, because the median is not a value in any objective's unit.
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.best).not.toBeNull();
    expect(result.best?.score).toBeGreaterThan(0);
    expect(result.best?.measured).toBeNull();
    // And no record is keyed by a judged run: it measured no objective, so it has no
    // identity, which is a different claim from writing zero rows.
    expect(result.report.records).toBeNull();
  }, 120_000);

  test('the clamp is PERSISTED, so a reader can state it once the call has returned', async () => {
    // The clamp was computed, disclosed in the settle report, and written nowhere — so no
    // surface could show it however well rendered, which is the accepted-and-ignored shape
    // *Accepted and ignored* refuses: a measurement taken and dropped. It is now folded
    // onto the run's own ledger row as the smallest ensemble any candidate reached.
    const { rt } = createTestRuntime();
    const { result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } }, rt,
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;
    expect(result.report.judgeEnsemble).toEqual({ requested: 20, realised: 3 });

    const page = readExplorationCanvas(rt.storage.sql);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0]!;
    // The knobs this run ran under, from a ledger row the swarm path used to write not at
    // all: `readForkRunParams` answered a swarm with the transcript half alone.
    expect(entry.params?.search).toMatchObject({
      budget: 2, branches: 2, maxDepth: 1, mode: 'build',
      judgeSamplesRequested: 20, judgeSamplesRealised: 3,
    });
    // The persisted number and the disclosed one are the same number, which is the
    // property that makes one of them a projection of the other rather than a second
    // opinion.
    expect(entry.params?.search?.judgeSamplesRealised)
      .toBe(result.report.judgeEnsemble?.realised ?? null);
    // A `thought` run holds no tools and journals nothing, so it has the tree half and
    // only the tree half — the honest tree-only shape, told apart from a swarm of agents
    // by the run's own two facts rather than by a settlement tag.
    expect(entry.run.hasSearchTree).toBe(true);
    expect(entry.tree.length).toBeGreaterThan(0);
    expect(entry.run.hasNodeTranscripts).toBe(false);
    expect(entry.head).toBeNull();
  }, 120_000);

  test('the clamp is DISCLOSED once per realised size, not left to be inferred', async () => {
    const { logger, result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } },
    });
    expect('reason' in result).toBe(false);
    const clamped = logger.emitted.filter((line) => line.event === 'swarm.judge_ensemble_clamped');
    expect(clamped).toHaveLength(1);
    expect(clamped[0]?.fields).toMatchObject({
      judge_samples_requested: 20, judge_samples_realised: 3, max_eval_llm_calls: 4,
    });
  }, 120_000);

  test('a judged tree BELOW the marginalisation floor is refused, by the in-process entry point too', async () => {
    // `swarmValidity` already refused this and `runSwarm` did not route through it, so an
    // in-process caller could run a scorer the measurement says is not worth building —
    // 28.5% unmarginalised against 30.0% marginalised at fixed node expansions. The
    // composition is built through the real resolver and past validity deliberately,
    // because what is under test is the runner's own gate.
    const call = resolveSwarm({
      preset: 'custom',
      label: 'depth-suite',
      task: 'x',
      objective: objective(),
      config: treeConfig({ score: { kind: 'judge', samples: 3 } }),
      depth: 1,
      branches: 2,
    });
    expect('reason' in call).toBe(false);
    if ('reason' in call) return;
    // Both gates agree, and they agree because there is one of them.
    expect(swarmValidity(call)?.error).toContain('samples ≥ 20');

    const { rt } = createTestRuntime();
    const refusal = await runSwarm({ rt, model: answering(null), mode: 'build' }, call);
    expect('reason' in refusal).toBe(true);
    if (!('reason' in refusal)) return;
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('samples ≥ 20');
    // The refusal names the binding cap, because raising `samples` alone does nothing.
    expect(refusal.error).toContain('maxEvalLLMCalls');
  }, 120_000);

  test('a FLAT judged run has no floor to clear — the bound is about trees', async () => {
    // `advance:'none'` has no selection step, so there is no scorer noise for a tree to
    // amplify and the marginalisation floor does not apply. Asserted so that raising the
    // bound over the whole axis, rather than over trees, goes red.
    const call = resolveSwarm({
      preset: 'custom',
      label: 'depth-suite',
      task: `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls.`,
      config: treeConfig({ score: { kind: 'judge', samples: 1 }, advance: { kind: 'none' } }),
      depth: 1,
      branches: 2,
    });
    expect('reason' in call).toBe(false);
    if ('reason' in call) return;
    expect(swarmValidity(call)).toBeNull();

    const { rt } = createTestRuntime();
    const result = await runSwarm({ rt, model: answering(null), mode: 'build' }, call);
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;
    expect(result.report.judgeEnsemble).toEqual({ requested: 1, realised: 1 });
  }, 120_000);
});

/* ── Merge-back is how the answer reaches the origin ──────────────────────── */

// THE MODULE'S EXPORTS EXIST BECAUSE THIS CALLS THEM. Merge-back's own suite proves what
// each policy decides; these prove a real settle goes THROUGH it, because a merge-back
// nobody calls leaves a settled swarm's work exactly as stranded as no merge-back at all.
//
// Driven through `runSwarm` directly rather than the shared `run` helper, because these
// assert the WORKSPACE and need the runtime the helper keeps to itself.
describe('merge-back at the settle barrier', () => {
  test("the winner's answer reaches the origin through apply-winner", async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      { rt, model: answering(null), mode: 'build', logger },
      resolved(1, 2),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    // The policy is DERIVED: a scored run settles on one incumbent.
    const winner = result.best;
    expect(winner).not.toBeNull();
    if (!winner) return;

    const [applied] = logger.emitted.filter((line) => line.event === 'swarm.merge_applied');
    expect(applied?.fields).toMatchObject({ policy: 'apply-winner', files: 1 });
    expect(applied?.fields.node).toBe(winner.id);

    // And it is the reported winner that is on disk, not whichever candidate happened to
    // be measured last.
    const landed = await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' });
    expect(landed).toBe(winner.artifact);

    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({
      policy: 'apply-winner', applied: 1, refused: 0, merge_nodes: 0, stopped_at: '',
    });
  }, 120_000);

  // THE SIZE BOUND, LIVE. The padding is a comment, so the candidate still verifies and
  // still measures the optimal operation count — the only thing that changes is that it no
  // longer fits one host transaction. Before this wiring the settle write was handed
  // straight to the substrate at any size.
  test('an oversized winner is refused at settle with the bound named', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const padded = `${OPTIMAL}\n// ${'x'.repeat(MAX_TX_BLOB_BYTES + 1)}\n`;

    const result = await runSwarm(
      { rt, model: answering(null, [padded]), mode: 'build', logger },
      resolved(1, 1),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    // It still won — the refusal is about the APPLY, not about the measurement.
    expect(result.best).not.toBeNull();

    const [oversized] = logger.emitted.filter((line) => line.event === 'swarm.merge_oversized');
    expect(oversized?.fields).toMatchObject({
      policy: 'apply-winner', bound: 'blobBytes', maximum: MAX_TX_BLOB_BYTES,
    });
    expect(String(oversized?.fields.error)).toContain('committed prefix');
    // Refused rather than applied, and the run still settles rather than throwing.
    expect(logger.emitted.filter((line) => line.event === 'swarm.merge_applied')).toHaveLength(0);
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({ applied: 0, refused: 1 });
  }, 120_000);
});

/* ── The DAG: `expand:'aggregate'` fans a level in ────────────────────────── */

/**
 * A model that answers from a script, cycling.
 *
 * The script is the fixture: a fan-in's behaviour is decided by whether its parents
 * AGREE, so the suite needs answers that measure identically and differ in bytes, and
 * answers that do neither. Every entry is a whole solution, so each candidate is still
 * measured by the real instrument.
 */
function scripted(answers: readonly string[]): MockLanguageModelV3 {
  let call = -1;
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-swarm',
    doGenerate: async () => {
      call += 1;
      return {
        content: [{
          type: 'text' as const,
          text: `Here is my approach.\n\n\`\`\`javascript\n${answers[call % answers.length] ?? ''}\`\`\``,
        }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 34, text: 34, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/** The optimal algorithm, with a comment that changes its bytes and not its cost. Two of
 *  these AGREE with each other and DISAGREE with a third, which is the whole fixture: a
 *  fan-in reconciles what its parents disagree about and accumulates what they do not. */
function variant(mark: string): string {
  return `${OPTIMAL}// ${mark}\n`;
}

/** The fields of every line under one event name — the shape a fan-in assertion reads,
 *  in the logger's own field type rather than a dictionary of `unknown`. */
function fanInEvents(logger: RecordingLogger, event: string): readonly LogFields[] {
  return logger.emitted.filter((line) => line.event === event).map((line) => line.fields);
}

// A FAN-IN'S CLAIM IS AN ORDER, so these assert the order and the graph, not that
// something merged. `unit-merge-back.test.ts` proves what the ordering decides and
// `mutation-merge-back.test.ts` proves it is load-bearing; what only a real run can show
// is that the DAG the engine builds actually produces the edges that ordering needs, that
// a conflict at a fan-in becomes a graded node through the ONE conflict policy, and that
// `expand:'sample'` is untouched by all of it.
describe("`expand:'aggregate'`: a level is fanned in, in dependency order", () => {
  test('a real DAG runs: agreement accumulates, a disagreement becomes a graded vertex', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const result = await runSwarm(
      { rt, model: scripted([variant('same'), variant('same'), variant('odd')]), mode: 'build', logger },
      resolved(3, 3, { expand: 'aggregate' }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const fanIn = result.report.fanIn;
    expect(fanIn).not.toBeNull();
    if (!fanIn) return;
    expect(fanIn.levels).toBeGreaterThan(0);

    // THE FIRST BARRIER, in full. Three parents: two agree and accumulate, and the third
    // disagrees — so exactly one node is spawned, and it is spawned through the conflict
    // policy *Merge-back* names rather than through anything this engine added beside it.
    const [first] = fanInEvents(logger, 'swarm.aggregate_fan_in');
    expect(first).toMatchObject({ depth: 1, parents: 3, members: 3, merged: 2 });
    const [spawned] = fanInEvents(logger, 'swarm.merge_node_spawned');
    expect(spawned).toMatchObject({
      policy: 'conflict-spawns-a-merge-node', derived_from: 'sequential-rebase',
    });
    expect(spawned?.spawned).toBe(String(first?.vertex));

    // THE SECOND MEMBER'S BASE MOVED under the first, so it was re-verified through the
    // instrument before it landed — the rebase is licensed by a fresh measurement rather
    // than by ignoring the staleness.
    const reverified = fanInEvents(logger, 'swarm.merge_reverified');
    expect(reverified.length).toBeGreaterThan(0);
    expect(reverified[0]).toMatchObject({ outcome: 'scored' });

    // AND THE VERTEX IS A CANDIDATE LIKE ANY OTHER: a real row at the level below its
    // parents, hanging off the member already applied, measured by the same instrument.
    const rows = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    const [vertex] = fanInEvents(logger, 'swarm.aggregate_vertex');
    const vertexRow = rows.find((row) => row.id === String(vertex?.node));
    expect(vertexRow?.depth).toBe(2);
    expect(vertexRow?.parent_id).toBe(String(vertex?.selection_parent));
    const graded = result.candidates.find((candidate) => candidate.id === vertexRow?.id);
    expect(graded?.measured?.kind).toBe('measured');
    // The k edges are in the record even though the row holds one: the selection parent is
    // one of the parents it consumed, and the rest are the DAG's.
    const edges = String(vertex?.aggregated).split(',');
    expect(edges.length).toBe(3);
    expect(edges).toContain(String(vertex?.selection_parent));
  }, 120_000);

  test('a merge order is a topological order: a vertex is held behind the parent it consumed', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const result = await runSwarm(
      { rt, model: scripted([variant('same'), variant('same'), variant('odd')]), mode: 'build', logger },
      resolved(3, 3, { expand: 'aggregate' }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const [vertex] = fanInEvents(logger, 'swarm.aggregate_vertex');
    const node = String(vertex?.node);
    const edges = String(vertex?.aggregated).split(',');

    // The barrier that offered the vertex TOGETHER WITH a parent whose work had not
    // landed. That is where an order can invert: the vertex was created before the wave
    // beside it, so the level hands it over FIRST, and its parent is a level shallower.
    const together = fanInEvents(logger, 'swarm.aggregate_fan_in')
      .map((fields) => String(fields.order).split(','))
      .find((order) => order.includes(node) && edges.some((edge) => order.includes(edge)));
    expect(together).toBeDefined();
    if (!together) return;

    for (const edge of edges) {
      if (!together.includes(edge)) continue;
      expect(together.indexOf(edge)).toBeLessThan(together.indexOf(node));
    }
    // NOT VACUOUS: the offered order really did put the dependent first, so this is a
    // reordering and not a list that happened to be right.
    expect(together[0]).not.toBe(node);
  }, 120_000);

  test('parents that AGREE accumulate, and no node is burned deciding nothing', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const result = await runSwarm(
      // One answer, so every candidate is byte-identical: two members that wrote the same
      // bytes have not conflicted, and spawning a graded node to reconcile them with
      // themselves would spend a model call to decide nothing.
      { rt, model: answering(null), mode: 'build', logger },
      resolved(2, 2, { expand: 'aggregate' }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const [first] = fanInEvents(logger, 'swarm.aggregate_fan_in');
    expect(first).toMatchObject({ depth: 1, parents: 2, members: 2, merged: 2, vertex: '' });
    expect(fanInEvents(logger, 'swarm.merge_node_spawned')).toHaveLength(0);
    expect(result.report.fanIn?.vertices).toEqual([]);
    expect(result.report.fanIn?.merged).toBe(2);
    // And the accumulation is what the workspace holds.
    const winner = result.best;
    expect(winner).not.toBeNull();
    if (!winner) return;
    expect(await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' })).toBe(winner.artifact);
  }, 120_000);

  test('a parent the tree retired is consumed anyway, and the report says how many', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const result = await runSwarm(
      // The reference algorithm measures the baseline, so it scores 0 and the tree retires
      // it — a parent with a last good state, which is the case the decision is about.
      {
        rt,
        model: scripted([variant('same'), variant('same'), variant('odd'), REFERENCE]),
        mode: 'build',
        logger,
      },
      resolved(3, 3, { expand: 'aggregate', pruneThreshold: 0.5, minVisitsForPrune: 1 }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    const rows = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    const retired = rows.filter((row) => row.status === 'pruned').map((row) => row.id);
    // NOT VACUOUS: pruning has to have fired for the decision to be under test at all.
    expect(retired.length).toBeGreaterThan(0);

    // THE DECISION: pruning says where the next unit of budget goes, not whether measured
    // work reaches the origin, so a retired parent keeps its edge and is still merged.
    expect(result.report.fanIn?.prunedParents).toBeGreaterThan(0);
    const consumed = fanInEvents(logger, 'swarm.aggregate_fan_in')
      .flatMap((fields) => String(fields.order).split(','));
    expect(retired.some((id) => consumed.includes(id))).toBe(true);
  }, 120_000);

  test('a parent the search could not score is not consumed, and the count says so', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const result = await runSwarm(
      // One candidate the instrument cannot measure. It has no answer to aggregate, so it
      // gets no edge — and a level with one consumable parent left is not a fan-in.
      { rt, model: scripted(['export function solve() { throw new Error("no"); }\n', OPTIMAL]), mode: 'build', logger },
      resolved(2, 2, { expand: 'aggregate' }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    expect(result.report.fanIn?.unusableParents).toBeGreaterThan(0);
    const [skipped] = fanInEvents(logger, 'swarm.aggregate_skipped');
    expect(skipped).toMatchObject({ reason: 'no-level', parents: 1 });
    expect(result.report.fanIn?.vertices).toEqual([]);
  }, 120_000);

  test('the transaction bound is checked per member, before the fan-in applies one', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const padded = `${OPTIMAL}\n// ${'x'.repeat(MAX_TX_BLOB_BYTES + 1)}\n`;
    const result = await runSwarm(
      { rt, model: answering(null, [padded]), mode: 'build', logger },
      resolved(2, 2, { expand: 'aggregate' }),
    );
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    // The candidates still measure — the refusal is about the APPLY — and the fan-in
    // refuses its first member with the bound named rather than handing it to the
    // substrate to split across the members behind it.
    const [oversized] = fanInEvents(logger, 'swarm.merge_oversized');
    expect(oversized).toMatchObject({
      policy: 'sequential-rebase', bound: 'blobBytes', maximum: MAX_TX_BLOB_BYTES,
    });
    expect(result.report.fanIn?.merged).toBe(0);
  }, 120_000);

  test("`expand:'sample'` fans in nothing, and says so rather than reporting a fan-in of zero", async () => {
    const { logger, result } = await run({ depth: 2, branches: 2, proposeWidth: null });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    expect(result.report.fanIn).toBeNull();
    expect(logger.emitted.filter((line) => line.event.startsWith('swarm.aggregate'))).toHaveLength(0);
    // And its settle is the one it always was: one winner, one policy.
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({ policy: 'apply-winner', members: 1 });
  }, 120_000);

  test('a composition where a fan-in could never happen is refused, naming what makes it impossible', async () => {
    const { rt } = createTestRuntime();
    const refusal = await runSwarm(
      { rt, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      resolved(1, 3, { expand: 'aggregate' }),
    );
    // Depth 1 runs one wave off the root, whose level is the root alone. The old refusal
    // said `aggregate` was unsupported, which is no longer true of anything; this one says
    // what THIS composition lacks and names the one move that fixes it.
    expect('reason' in refusal).toBe(true);
    if (!('reason' in refusal)) return;
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('needs a level to consume');
    expect(refusal.error).toContain('Raise `depth`');
    expect(refusal.error).not.toContain('nothing here orders merges');
  }, 120_000);
});

/* ── `advance:'archive'` runs: cells, admission, and what survives a run ───── */

// LIVES HERE FOR THE REASON THE BLOCKS ABOVE DO, and one more of its own: an archive's
// cell is WITNESSED by the instrument, so a suite that stood up its own fake measurement
// would prove the wiring against a descriptor no registered verifier reports. This harness
// runs the real `exec-ratio` instrument, which reports `refOps`/`candOps`/`refMs`/`candMs`
// — and `candOps` is a genuine behaviour descriptor for this task: how many oracle calls
// the answer spends. Two answers with different op counts land in different cells; two
// answers with the same op count land in one, which is where the admission test bites.
//
// `unit-exploration-records.test.ts` proves what the archive DECIDES over rows it writes
// directly. These prove the decisions are REACHED: that a run bins, that a second run
// starts from the occupants, and that the seal reaches this surface too.

/** Correct and wasteful: the optimal scan followed by one redundant confirming pass, so
 *  n-1 + n oracle calls. A different cell from the optimum under `key:'candOps'`, which is
 *  what makes a single wave fill more than one. */
const THOROUGH = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  for (let i = 0; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

/** The optimum, restated with a comment: the SAME oracle calls, so the same cell, and a
 *  handful of tokens of difference. The near-copy an archive exists to refuse — ten
 *  variants of one answer are one finding. */
const RESTATED = `${OPTIMAL}// the same single scan, said again\n`;

/** The cells the two answers above are witnessed into, spelled out: n-1 calls for the
 *  optimum and (n-1) + n for the wasteful pass. Written rather than computed, so a change
 *  to how a coordinate is built fails here instead of quietly re-binning every cell. */
const OPTIMAL_CELL = `candOps=${String(N - 1)}`;
const THOROUGH_CELL = `candOps=${String(N - 1 + N)}`;

/** The archive axes: the grid, a rejection test strict enough that a restated answer
 *  cannot clear it and loose enough that a different algorithm can, and the carry that
 *  makes the occupants the next run's starting population. */
const ARCHIVE: Partial<SwarmConfig> = {
  advance: { kind: 'archive', novelty: 0.4 },
  carry: { kind: 'elites' },
};

describe("advance:'archive' bins a wave into cells, and the next run starts from them", () => {
  test('A REAL RUN FILLS THE CELLS ITS INSTRUMENT WITNESSED, one elite each', async () => {
    // THE WHOLE TICKET. This composition was `unsupported` — "reports a front or an
    // archive, and both need a store this run has no writer for" — and the store it named
    // is the one it now writes: a row per cell, keyed by the descriptor the MEASUREMENT
    // carried rather than by anything a node said about itself.
    const { rt } = createTestRuntime();
    const { result, logger } = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE,
    });
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    // Derived, never chosen: `settleOf` maps this advance onto the archive settle.
    expect(result.report.settle).toBe('archive');
    expect(result.report.records?.written).toBe(2);
    expect(result.report.records?.tooClose).toBe(0);

    // TWO CELLS, and each holds the answer whose measurement put it there.
    const rows = recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(rows.map((row) => row.descriptor).sort()).toEqual([OPTIMAL_CELL, THOROUGH_CELL]);
    expect(bestInCell(rt.storage.sql, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    })?.value).toBe(N - 1);
    expect(bestInCell(rt.storage.sql, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: THOROUGH_CELL,
    })?.value).toBe(N - 1 + N);

    // And the trail says which cell each row landed in, so the coverage on the report and
    // the descriptors in the store cannot disagree.
    const written = logger.emitted.filter((line) => line.event === 'swarm.record_written');
    expect(written.map((line) => line.fields.cell).sort()).toEqual([OPTIMAL_CELL, THOROUGH_CELL]);
  }, 120_000);

  test('A SECOND RUN READS THE OCCUPANTS, and reports the COVERAGE it started from', async () => {
    // `carry:'elites'` made concrete: elites ARE the archive's occupants, and the point of
    // the whole records/carry chain is that the next run starts from them. `carriedIn`
    // counts rows; `carriedInCells` is the coverage, which is the number an archive that
    // collapsed onto one cell would otherwise still report as full.
    const { rt } = createTestRuntime();
    const first = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE,
    });
    expect('reason' in first.result).toBe(false);
    if ('reason' in first.result) return;
    expect(first.result.report.records).toMatchObject({ carriedIn: 0, carriedInCells: 0 });

    const second = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE,
    });
    expect('reason' in second.result).toBe(false);
    if ('reason' in second.result) return;
    expect(second.result.report.records).toMatchObject({
      carriedIn: 2, carriedInCells: 2, carriedInBest: N - 1,
    });
    // AND THE SEARCH WAS TOLD, over what the model was actually sent — otherwise the read
    // is a number on a report and the archive is still something no run starts FROM.
    expect(second.prompts.every((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(true);
    expect(first.prompts.some((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(false);
  }, 180_000);

  test('A NEAR-COPY OF AN OCCUPANT IS REFUSED, and the refusal NAMES the occupant', async () => {
    // The admission test through the real engine, across two runs — which is where it
    // matters, because the cell it collides with was filled by a run that has already
    // ended. Both answers spend the same oracle calls, so the instrument witnesses the same
    // cell for both, and the second is the first said again.
    const { rt } = createTestRuntime();
    const first = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL], config: ARCHIVE,
    });
    expect('reason' in first.result).toBe(false);
    const occupant = bestInCell(rt.storage.sql, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    });
    // As PLACED, which is the answer read back out of the fence rather than the string the
    // model was scripted with: the engine records the artifact it measured.
    expect(occupant?.artifact).toBe(OPTIMAL.trimEnd());

    const second = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, key: 'candOps',
      answers: [RESTATED], config: ARCHIVE,
    });
    expect('reason' in second.result).toBe(false);
    if ('reason' in second.result) return;
    expect(second.result.report.records).toMatchObject({ written: 0, tooClose: 1, notBetter: 0 });

    const [refused] = second.logger.emitted.filter((line) => line.event === 'swarm.record_refused');
    expect(refused?.fields).toMatchObject({
      cause: 'too-close', occupant: occupant?.artifactDigest ?? '',
    });
    // The comparison, not just its outcome: a rejection whose distance nobody can see is
    // indistinguishable from a threshold set wrong.
    expect(Number(refused?.fields.distance)).toBeLessThan(0.4);
    expect(Number(refused?.fields.distance)).toBeGreaterThan(0);
    // The cell still holds ONE answer, and it is the one that got there first.
    expect(recordsFor(rt.storage.sql, { identity: identityOf(), floor: SUITE_FLOOR }))
      .toHaveLength(1);
  }, 180_000);

  test('THE MONOTONE RULE HOLDS ACROSS RUNS, inside the cell', async () => {
    // A cell's best never falls, through the archive's own writer: the second run
    // re-measures the same artifact into the same cell at the same number — a tie, which
    // does not displace — and the store says so instead of silently rewriting the row. The
    // archive is a policy over that rule and not a way around it.
    const { rt } = createTestRuntime();
    const first = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL], config: ARCHIVE,
    });
    expect('reason' in first.result).toBe(false);

    const second = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL], config: ARCHIVE,
    });
    expect('reason' in second.result).toBe(false);
    if ('reason' in second.result) return;
    // NOT `too-close`: an identical artifact is the row that already exists, so it is the
    // monotone rule that answers and never the admission test.
    expect(second.result.report.records).toMatchObject({ written: 0, notBetter: 1, tooClose: 0 });

    const cell = bestInCell(rt.storage.sql, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    });
    expect(cell?.value).toBe(N - 1);
    expect(cell?.displacements).toBe(0);
  }, 180_000);

  test('A BREACHED RUN WRITES NOTHING TO THE ARCHIVE, and says how many cells that cost', async () => {
    // *The publication seal* at this surface. The seal is checked at the barrier AND inside
    // the archive's own writer, and this is the barrier half through the real engine: the
    // run measures a candidate past a bound that candidate itself refutes, and the grid
    // stays empty.
    //
    // The cell COUNT is the archive-shaped half of the disclosure. It was pinned at one
    // because a flat run has exactly one partition; here two candidates were witnessed into
    // two cells, and reporting one would understate what the seal cost the next run by
    // exactly the coverage it lost.
    const { rt } = createTestRuntime();
    const breached = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE, floor: REFUTED_FLOOR,
    });
    expect('reason' in breached.result).toBe(false);
    if ('reason' in breached.result) return;

    expect(breached.result.publication.state.kind).toBe('sealed');
    expect(breached.result.report.records).toMatchObject({ written: 0, tooClose: 0 });
    expect(recordsFor(rt.storage.sql, { identity: identityOf(), floor: REFUTED_FLOOR }))
      .toHaveLength(0);
    expect(breached.result.report.carrySuppressed).toMatchObject({
      carry: 'elites', suppressedCells: 2,
    });
    const refused = breached.logger.emitted.filter((line) => line.event === 'swarm.carry_refused');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((line) => line.fields.cause === 'sealed')).toBe(true);
  }, 120_000);
});

describe("the archive's own region, and the refusal `pareto` now carries alone", () => {
  /** A composition expected to be illegal, through the real resolver and the real
   *  predicate. Returns the refusal's text, or '' when it was legal — which fails an
   *  assertion rather than passing on a string that happens to contain nothing. */
  function archiveRefusal(input: {
    readonly depth: number;
    readonly config?: Partial<SwarmConfig>;
    readonly key?: string;
  }): string {
    const call = resolveSwarm({
      preset: 'custom',
      label: 'archive-suite',
      task: 'cover the ways this can be answered',
      objective: objective(),
      config: treeConfig({ ...ARCHIVE, ...input.config }),
      depth: input.depth,
      branches: 2,
      key: input.key,
    });
    if ('reason' in call) return call.error;
    return swarmValidity(call)?.error ?? '';
  }

  test('the archive at depth 1 is LEGAL, so the refusals below are about their own arms', () => {
    expect(archiveRefusal({ depth: 1, key: 'candOps' })).toBe('');
  });

  test('past depth 1 it is refused, naming where an archive would have selected from', () => {
    // The honest boundary. An archive selects by cell and its cells are written at the
    // settle barrier, so within one run there is nothing to select a second level from —
    // refused rather than silently flattened, exactly as advance:"none" past depth 1 is.
    const error = archiveRefusal({ depth: 3, key: 'candOps' });
    expect(error).toContain('depth 3 cannot be run');
    expect(error).toContain('settle barrier');
    expect(error).toContain('carry:"elites"');
  });

  test('an archive with no measured objective cannot key a cell, and says so', () => {
    // A cell is keyed by the objective's identity and ordered by its direction. A judged
    // run measures neither, so its coverage would be over a store it never wrote.
    const error = archiveRefusal({
      depth: 1, key: 'candOps', config: { score: { kind: 'judge', samples: 20 } },
    });
    expect(error).toContain('keys every cell by the objective\'s identity');
    expect(error).toContain('score:"verify"');
  });

  test('a novelty threshold no distance can satisfy is refused, with the unit STATED', () => {
    // The hazard is invisible otherwise: this parameter is a distance FLOOR while every
    // published filter the axis was argued from is a similarity CEILING, so an
    // unconverted transcription is a stricter archive than the evidence describes and a
    // transcribed similarity above 1 is an archive no candidate can enter.
    const error = archiveRefusal({
      depth: 1, key: 'candOps', config: { advance: { kind: 'archive', novelty: 1.4 } },
    });
    expect(error).toContain('[0,1]');
    expect(error).toContain('one MINUS that number');
  });

  test('a key the instrument does not witness is refused BEFORE a candidate is expanded', async () => {
    // The descriptor is measured, never asserted — so a key naming something this
    // instrument cannot report is refused as soon as the baseline says what it reports,
    // rather than one candidate at a time at the barrier, where every write would be
    // refused for want of a cell and the run would report coverage over an archive it could
    // never have written.
    const { result } = await run({
      depth: 1, branches: 1, proposeWidth: null, key: 'tactic', config: ARCHIVE,
    });
    expect('reason' in result).toBe(true);
    if (!('reason' in result)) return;
    expect(result.reason).toBe('bad_input');
    expect(result.error).toContain('"tactic" is not among the quantities');
    // Naming what it DOES report, because the caller's next move is to pick one.
    expect(result.error).toContain('candOps');
    expect(result.error).toContain('refOps');
  }, 120_000);

  test("advance:'pareto' refuses for its OWN cause, and it is not the archive's", async () => {
    // One refusal per cause. The shared text — "reports a front or an archive, and both
    // need a store this run has no writer for" — was true of neither by the end: the store
    // landed, and `pareto` was never waiting on one. What it waits on is a MEASUREMENT with
    // more than one axis, which this runner does not have.
    const scalar = objective();
    if (scalar.kind !== 'scalar') throw new Error("the suite's objective is a scalar");
    const front: Objective = {
      kind: 'instanced',
      metric: scalar.metric,
      unit: scalar.unit,
      direction: scalar.direction,
      scale: scalar.scale,
      target: scalar.target,
      verify: scalar.verify,
      instances: ['seed-7', 'seed-11'],
    };
    const call = resolveSwarm({
      preset: 'custom',
      label: 'pareto-suite',
      task: 'reach the front',
      objective: front,
      config: treeConfig({ advance: { kind: 'pareto' }, carry: { kind: 'elites' } }),
      depth: 1,
      branches: 2,
    });
    if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
    // LEGAL, and that is the point: the front's own axes are declared, so what refuses
    // below is the runner and not the composition.
    expect(swarmValidity(call)).toBeNull();

    const { rt } = createTestRuntime();
    const refusal = await runSwarm(
      { rt, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      call,
    );
    expect('reason' in refusal).toBe(true);
    if (!('reason' in refusal)) return;
    expect(refusal.reason).toBe('unsupported');
    expect(refusal.error).toContain('NON-DOMINATED');
    expect(refusal.error).toContain('per-instance measurement path');
    // The cause it no longer shares with the archive, and the archive it no longer names.
    expect(refusal.error).not.toContain('front or an archive');
    expect(refusal.error).not.toContain('no writer for');
  }, 60_000);
});
