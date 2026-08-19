// `depth > 1` — the half of the swarm surface that was declared and not real.
//
// A `depth` cap that cannot produce a second level is an axis in the docstring and a
// no-op in the engine, which is the accepted-and-ignored defect §2.5 exists to refuse.
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
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, makeSql, makeExecRaw } from './helpers';
import { createRecordingLogger, type RecordingLogger } from '../src/obs/index';
import { initSearchTables } from '../src/mcts/schemas';
import { insertSearchNode } from '../src/mcts/record-node';
import { backpropagate } from '../src/mcts/backpropagation';
import { selectFrontierNode, type FrontierPolicy } from '../src/mcts/frontier';
import { runSwarm } from '../src/strategy/swarm-run';
import type { Refusal } from '../src/obs/error';
import {
  arbitrateBranch, resolveSwarm, swarmValidity,
  BRANCH_PROPOSAL_WIDTH, BRANCH_REFUSAL_POLICIES, SWARM_ADVANCES,
  type BranchProposal, type BranchRefusalPolicy, type ResolvedSwarm,
  type ResolvedSwarmCaps, type SwarmConfig, type SwarmResult,
} from '../src/strategy/swarm';
import type { Objective } from '../src/strategy/objective';
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

/** A legal proposal: the minimum width §8.2 states, and no context conflict. */
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

describe('§8.2 the arbiter: a node proposes, the engine decides', () => {
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
      // The fifth arm moved axis with §8.4: a search resolved `fresh` refuses a child
      // that asks to `fork`, which is "a node may narrow and never widen" over the axis
      // that actually owns inheritance.
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
    // Reachable only through `custom` with no `from`: §6.3 declares rows for the named
    // presets and nothing for a composition that named no base. A run whose depth
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
    // `every_proposal_gets_a_verdict`, over a grid that crosses every arm. Silence is
    // the failure mode §8.2 is written against: a node that cannot tell refusal from
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

function objective(): Objective {
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
    floor: {
      value: Math.ceil(N / 2),
      kind: 'certificate',
      bestKnownHonest: N - 1,
      proof: 'Every token must appear in at least one comparison and a comparison '
        + 'touches two, so covering n needs at least ceil(n/2) calls.',
    },
  };
}

/** A model that answers with the optimal solution, and — when asked to — appends a
 *  branch proposal of `proposeWidth` sub-questions. */
function answering(proposeWidth: number | null): MockLanguageModelV3 {
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
    doGenerate: async () => ({
      content: [{ type: 'text', text: `Here is my approach.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\`${branch}` }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 34, text: 34, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** A resolved `custom` composition, through the real resolver and the real validity
 *  predicate — a test that hand-built a `ResolvedSwarm` could assert a tree the tool
 *  surface cannot actually ask for. */
function resolved(depth: number, branches: number, over?: Partial<SwarmConfig>): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'depth-suite',
    task: `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls.`,
    objective: objective(),
    config: treeConfig(over),
    depth,
    branches,
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
}

async function run(input: {
  readonly depth: number;
  readonly branches: number;
  readonly proposeWidth: number | null;
  readonly config?: Partial<SwarmConfig>;
}): Promise<Run> {
  const { rt } = createTestRuntime();
  const logger = createRecordingLogger();
  const result = await runSwarm(
    { rt, model: answering(input.proposeWidth), mode: 'build', logger },
    resolved(input.depth, input.branches, input.config),
  );
  const nodes = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { logger, nodes, result };
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
    // Seven sub-questions against §8.2's band of 2-4. The refusal must reach the
    // diagnostics stream carrying its policy token and its prose, because a toolless
    // node has already finished its turn and this is the only channel that exists.
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
    // §8.2's rule, as a count: a node that cannot tell refusal from being ignored will
    // simply propose again. Every child here proposes, so every child must appear in
    // exactly one verdict — the ones selection reached, and the ones swept afterwards.
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
    // end. A depth-2 node in a depth-2 search is never INVITED to propose (§8.2's
    // build-time rule: a request that could only be refused is not offered), but this
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
});
