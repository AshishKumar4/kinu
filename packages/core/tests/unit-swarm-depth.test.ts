// `depth > 1` swarm: the arbiter against `Exploration/Arbitration.lean`, the depth cap over real rows,
// and whole runs with a real `exec-ratio` measurement. Each cap-evasion route has its own test.
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
import { diversityAngle } from '../src/mcts/diversity';
import { runSwarm } from '../src/strategy/swarm-run';
import { SOLUTION_FILE } from '../src/strategy/exec-ratio';
import { readExplorationCanvas } from '../src/read-models/exploration-canvas';
import { explorationForkTree } from '../src/read-models/fork-tree-rows';
import { readSearchTree } from '../src/read-models/search-tree';
import { findForkNode } from '../src/read-models/swarm-tree-model';
import type { Refusal } from '../src/obs/error';
import {
  arbitrateBranch, resolveSwarm, swarmValidity, JUDGE_MARGINALISATION_MIN,
  BRANCH_PROPOSAL_WIDTH, BRANCH_REFUSAL_POLICIES, SWARM_ADVANCES,
  type BranchProposal, type BranchRefusalPolicy, type ResolvedSwarm,
  type ResolvedSwarmCaps, type SwarmAdvance, type SwarmConfig, type SwarmResult,
} from '../src/strategy/swarm';
import { bestInCell, recordsFor, verifierDigestOf } from '../src/strategy/records';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import type { Floor, Objective, ObjectiveIdentity, VectorObjective } from '../src/strategy/objective';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { SearchNode } from '../src/types/mcts';
import type { LLM, SqlExecutor } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';
import { createTestActors, present } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { refuseHostNode } from './helpers-actor-host';

/** Refuses: thought nodes never ask for a seat, so an agent node here fails naming the fixture. */
const NO_NODE = refuseHostNode('the depth suite runs thought nodes only');

function treeConfig(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'thought' }, context: 'inherit',
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

/** Every branch asks to fork: refused under a `fresh` search, accepted under an inheriting one. */
function inheriting(width = 2): BranchProposal {
  return branchesOf(width, 'inherit');
}

function widthOf(width: number): BranchProposal {
  return branchesOf(width, 'fresh');
}

function branchesOf(width: number, context: 'inherit' | 'fresh'): BranchProposal {
  return proposal({
    branches: Array.from({ length: width }, (_unused, i) => ({
      task: `sub-question ${String(i)}`, rationale: 'r', context,
    })),
  });
}

describe('*Arbitration* — a node proposes, the engine decides', () => {
  test('a legal proposal is accepted at its own width — the arbiter is not vacuous', () => {
    // `a_legal_proposal_is_accepted`: without it an always-refusing arbiter satisfies every theorem below.
    const verdict = arbitrateBranch({
      config: treeConfig(), caps: caps(5, 3), atDepth: 1,
      remainingChildren: 10, proposal: inheriting(),
    });

    expect(verdict).toEqual({ kind: 'accepted', width: 2 });
  });

  test('all five refusals are reachable, and each NAMES its policy and its state', () => {
    // `every_refusal_is_reachable`: both the policy token and the prose naming the state.
    const reached: { policy: BranchRefusalPolicy; error: string }[] = [];

    const refusals = [
      // `advance:'none'` has no selection step, so no second level exists.
      arbitrateBranch({
        config: treeConfig({ advance: { kind: 'none' } }), caps: caps(1, 3), atDepth: 0,
        remainingChildren: 10, proposal: proposal(),
      }),
      arbitrateBranch({
        config: treeConfig(), caps: caps(5, 3), atDepth: 1,
        remainingChildren: 10, proposal: widthOf(BRANCH_PROPOSAL_WIDTH.max + 1),
      }),
      arbitrateBranch({
        config: treeConfig(), caps: caps(1, 3), atDepth: 1,
        remainingChildren: 10, proposal: proposal(),
      }),
      arbitrateBranch({
        config: treeConfig(), caps: caps(5, 3), atDepth: 3,
        remainingChildren: 1, proposal: proposal(),
      }),
      // Fifth arm: a `fresh` search refuses a child that asks to `fork` (narrow, never widen).
      arbitrateBranch({
        config: treeConfig({ context: 'fresh' }), caps: caps(5, 3), atDepth: 1,
        remainingChildren: 10, proposal: inheriting(),
      }),
    ];

    for (const verdict of refusals) {
      expect(verdict.kind).toBe('refused');

      if (verdict.kind !== 'refused') continue;
      reached.push({ policy: verdict.policy, error: verdict.error });
    }

    expect(reached.map((r) => r.policy)).toEqual([...BRANCH_REFUSAL_POLICIES]);
    expect(reached[0]?.error).toContain('advance:"none"');
    expect(reached[1]?.error).toContain('names 5');
    expect(reached[2]?.error).toContain('depth exhausted at depth 1');
    expect(reached[3]?.error).toContain('budget exhausted at depth 3');
    expect(reached[4]?.error).toContain('context:"fresh"');
  });

  test('an absent depth cap refuses as ABSENT, which is not the same as exhausted', () => {
    // Only reachable via `custom` with no `from`: undeclared depth cannot be granted.
    const verdict = arbitrateBranch({
      config: treeConfig(), caps: caps(null, 3), atDepth: 0,
      remainingChildren: 10, proposal: proposal(),
    });

    expect(verdict).toMatchObject({ kind: 'refused', policy: 'depth-exhausted' });

    if (verdict.kind !== 'refused') return;
    expect(verdict.error).toContain('absent depth rather than an exhausted one');
  });

  test('CAP EVASION, route 1: no proposal is granted children past the cap', () => {
    // S3 over the whole grid: accepted ⟹ atDepth + 1 ≤ maxDepth.
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
    // `accepted_within_budget` (S8): the budget is the search's, shared by every node.
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
    // `every_proposal_gets_a_verdict`, over a grid crossing every arm.
    const verdictIsStated = (advance: SwarmAdvance, context: 'inherit' | 'fresh', width: number): void => {
      for (const asked of ['inherit', 'fresh'] as const) {
        const verdict = arbitrateBranch({
          config: treeConfig({
            advance: advance === 'archive' ? { kind: advance, novelty: 0.6 } : { kind: advance },
            context,
          }),
          caps: caps(3, 2), atDepth: 1,
          remainingChildren: 4,
          proposal: branchesOf(width, asked),
        });

        expect(['accepted', 'refused']).toContain(verdict.kind);

        if (verdict.kind === 'refused') expect(verdict.error.length).toBeGreaterThan(0);
      }
    };

    for (const advance of SWARM_ADVANCES) {
      for (const context of ['inherit', 'fresh'] as const) {
        for (const width of [0, 1, 2, 4, 5]) verdictIsStated(advance, context, width);
      }
    }
  });
});

interface Tree {
  readonly sql: SqlExecutor;
  /** The run's actor; `search_nodes` is keyed `(actor_id, id)`, so mismatched handles read as an empty tree. */
  readonly actor: ActorHandle;
  readonly rootId: string;
  child(parentId: string, reward: number | null): string;
  depthOf(nodeId: string): number;
  select(policy: FrontierPolicy, maxDepth: number): SearchNode | null;
}

function tree(): Tree {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  const actor = createTestActors(sql, execRaw).main;
  const rootId = 'root';
  let minted = 0;
  insertSearchNode(sql, actor, {
    nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
    task: 't', action: '', observation: 'as found', codeUsed: null, depth: 0, msgId: null,
  });

  const depthOf = (nodeId: string): number =>
    sql<{ depth: number }>`SELECT depth FROM search_nodes
                             WHERE actor_id = ${actor.actorId} AND id = ${nodeId}`[0]?.depth ?? -1;

  return {
    sql,
    actor,
    rootId,
    depthOf,
    child(parentId, reward) {
      minted += 1;
      const id = `n${String(minted)}`;
      insertSearchNode(sql, actor, {
        nodeId: id, parentNodeId: parentId, parentMsgId: null, rootId,
        task: 't', action: '', observation: `answer ${id}`, codeUsed: null,
        depth: depthOf(parentId) + 1, msgId: null,
      });

      if (reward !== null) backpropagate(sql, actor, id, reward);

      return id;
    },
    select(policy, maxDepth) {
      return selectFrontierNode(sql, actor, { rootId, policy, maxDepth, explorationWeight: 1.4 });
    },
  };
}

describe('the scheduler: one policy per `advance`, and the cap is a WHERE clause', () => {
  test('a scored frontier DESCENDS, so a second level is reachable at all', () => {
    // Selection must be able to return a scored child, or no depth-2 node can exist.
    const t = tree();
    const good = t.child(t.rootId, 0.9);
    t.child(t.rootId, 0.1);

    for (const policy of ['uct', 'best-first'] as const) {
      const next = t.select(policy, 3);
      expect(next).not.toBeNull();
      expect(next?.depth).toBe(1);
      expect(next?.id).toBe(good);
    }
  });

  test('CAP EVASION, route 2: a node at the cap is never SELECTED, at any width', () => {
    // WP-A4: the cap excludes rather than aborts. Under `uct` the root stays selectable (re-widening);
    // no node at depth >= maxDepth is ever returned.
    const t = tree();
    t.child(t.rootId, 0.9);
    t.child(t.rootId, 0.4);

    for (const policy of ['uct', 'best-first', 'none'] as const) {
      for (const maxDepth of [1, 2, 3]) {
        const selected = t.select(policy, maxDepth);

        if (selected) expect(selected.depth).toBeLessThan(maxDepth);
      }
    }

    for (const policy of ['best-first', 'none'] as const) {
      expect(t.select(policy, 1)).toBeNull();
    }

    // Raising the cap makes the same rows selectable, so the nulls above come from the cap.
    expect(t.select('best-first', 2)?.depth).toBe(1);
  });

  test('CAP EVASION, route 3: a child never states its own depth', () => {
    // Depth derives from the parent's row, so a chain of five is exactly 1..5.
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
    expect(t.select('none', 1)).toBeNull();
    expect(t.select('none', 9)).toBeNull();
  });

  test('best-first takes the best UNEXPANDED node, so it cannot stall on a parent', () => {
    // Not `uct` with zero weight: a parent's mean can tie its best child and an argmax would re-pick it forever.
    const t = tree();
    const first = t.child(t.rootId, 1);
    expect(t.select('best-first', 3)?.id).toBe(first);
    const under = t.child(first, 1);
    expect(t.select('best-first', 3)?.id).toBe(under);
  });

  test('the level-synchronised schedule went with `beam`, and best-first does not replace it', () => {
    // `beam` differed from best-first only in order (`depth ASC`); this asserts that difference.
    const t = tree();
    const best = t.child(t.rootId, 0.9);
    const second = t.child(t.rootId, 0.8);
    t.child(t.rootId, 0.2);

    expect(t.select('best-first', 4)?.id).toBe(best);
    // Best-first descends to the deeper child at once; a beam would have expanded `second` first.
    const deeper = t.child(best, 0.95);
    const next = t.select('best-first', 4);
    expect(next?.id).toBe(deeper);
    expect(next?.depth).toBe(2);
    expect(next?.id).not.toBe(second);
  });
});

/**
 * Measurable task for `exec-ratio`: largest of `n` tokens through a counted `greater` oracle.
 * `n` stays small because every measurement spawns a real process in the workspace shell.
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

/** `P`, `shuffle`, `tok`, `valueOf`, `meter`, `trial` and `emitTrials` come from the shared prologue. */
const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
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

/**
 * `floor` is overridable so a test can pass a bound above the optimum, which the first
 * correct candidate refutes (H1): the only way to reach the seal's wiring.
 */
function objective(floor?: Floor): Objective {
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
 * Answers the optimal solution (cycling `answers`, one per call) and, when asked, appends a
 * proposal of `proposeWidth` sub-questions. `seen` collects the prompts sent.
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

/** Resolved through the real resolver and validity predicate, so the tree is one the tool surface can ask for. */
interface ResolveRequest {
  depth: number;
  branches: number;
  over?: Partial<SwarmConfig>;
  floor?: Floor;
  key?: string;
}

function resolved({ depth, branches, over, floor, key }: ResolveRequest): ResolvedSwarm {
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
  /** Every prompt sent, serialized: the only way to assert what a child was told. */
  readonly prompts: readonly string[];
}

async function run(input: {
  readonly depth: number;
  readonly branches: number;
  readonly proposeWidth: number | null;
  readonly config?: Partial<SwarmConfig>;
  readonly floor?: Floor;
  /** The coverage descriptor `advance:'archive'` bins by; refused for every other advance. */
  readonly key?: string;
  readonly answers?: readonly [string, ...string[]];
  readonly rt?: AgentRuntime;
}): Promise<Run> {
  const rt = input.rt ?? createTestRuntime().rt;
  const logger = createRecordingLogger();
  const prompts: string[] = [];

  const result = await runSwarm(
    { rt, hostNode: NO_NODE, model: answering(input.proposeWidth, input.answers ?? [OPTIMAL], prompts), mode: 'build', logger },
    resolved({ depth: input.depth, branches: input.branches, over: input.config, floor: input.floor, key: input.key }),
  );

  const nodes = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes WHERE actor_id = ${rt.actor.actorId}
    ORDER BY depth ASC, created_at ASC`;

  return { logger, nodes, result, prompts };
}

describe('a swarm at depth 2 expands, and its tree is measured', () => {
  test('depth 2 is REACHED, every node is derived from its parent, and the cap holds', async () => {
    const { nodes, result, logger } = await run({ depth: 2, branches: 2, proposeWidth: null });
    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const depths = nodes.map((node) => node.depth);
    expect(Math.max(...depths)).toBe(2);
    expect(depths.filter((depth) => depth === 2).length).toBeGreaterThan(0);
    expect(depths.filter((depth) => depth === 0)).toEqual([0]);
    // Every non-root depth is its parent's plus one, asserted over the rows.
    const byId = new Map(nodes.map((node) => [node.id, node]));

    for (const node of nodes) {
      if (node.parent_id === null) continue;
      expect(node.depth).toBe((byId.get(node.parent_id)?.depth ?? -99) + 1);
    }

    expect(result.report.expansions).toBe(4);
    expect(result.candidates.length).toBe(4);

    expect(result.best).not.toBeNull();
    expect(result.best?.measured?.kind).toBe('measured');
    expect(result.best?.measured?.value).toBe(N - 1);
    expect(result.best?.score).toBe(1);
    expect(result.report.baseline).toBeGreaterThan(N - 1);
    expect(logger.emitted.map((line) => line.event)).toContain('swarm.baseline_measured');
    expect(result.report.floorMargin).toBeGreaterThan(0);
    expect(result.publication.state.kind).toBe('open');
    expect(result.publication.caveat).toBeNull();
  });

  test('depth 1 is UNCHANGED: one wave, one level, and the flat report it always gave', async () => {
    // Enabling the tree must not move depth 1 under `advance:'none'`.
    const { nodes, result } = await run({
      depth: 1, branches: 3, proposeWidth: null,
      config: { advance: { kind: 'none' }, score: { kind: 'verify' } },
    });

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    expect(Math.max(...nodes.map((node) => node.depth))).toBe(1);
    expect(result.candidates.length).toBe(3);
    expect(result.report.expansions).toBe(3);
    expect(result.report.stop).toBe('settled');
  });

  test('a REFUSED proposal names its reason, and the node still gets expanded', async () => {
    // Seven against the band 2-4 (`BRANCH_PROPOSAL_WIDTH`): diagnostics is a toolless node's only channel.
    const { logger, result, nodes } = await run({ depth: 2, branches: 2, proposeWidth: 7 });
    expect('reason' in result).toBe(false);

    const refusals = logger.emitted.filter((line) => line.event === 'swarm.branch_refused');
    expect(refusals.length).toBeGreaterThan(0);
    const fields = refusals[0]?.fields;
    expect(fields).toMatchObject({ policy: 'width-out-of-range' });
    expect(String(fields?.error)).toContain('names 7');

    // The refusal's id and depth come from the tree row, not from the node's own claim.
    for (const refusal of refusals) {
      const row = nodes.find((node) => node.id === String(refusal.fields.node));
      expect(row).toBeDefined();
      expect(refusal.fields.depth).toBe(row?.depth ?? -1);
    }

    // Refused the branch, not the node: a bad proposal costs the request, not the turn.
    expect(Math.max(...nodes.map((node) => node.depth))).toBe(2);
  });

  test('an ACCEPTED proposal expands at the node, and its children stay inside the cap', async () => {
    const { logger, nodes, result } = await run({ depth: 3, branches: 2, proposeWidth: 3 });
    expect('reason' in result).toBe(false);

    const accepted = logger.emitted.filter((line) => line.event === 'swarm.branch_accepted');
    expect(accepted.length).toBeGreaterThan(0);
    // Accepted at the proposal's width (three) where the search's own width is two.
    expect(accepted[0]?.fields).toMatchObject({ children: 3 });
    // Composition check only: the budget already bounds depth here, so removing the cap does not change
    // this assertion. The cap itself is proven in selection (route 2) and arbitration (route 1).
    expect(Math.max(...nodes.map((node) => node.depth))).toBeLessThanOrEqual(3);
  });

  test('nothing a node asks for is dropped in silence — every proposal is answered', async () => {
    // Every proposing child appears in exactly one verdict (*Arbitration*).
    const { logger, nodes } = await run({ depth: 2, branches: 2, proposeWidth: 2 });

    const answered = logger.emitted
      .filter((line) => line.event === 'swarm.branch_refused')
      .map((line) => String(line.fields.node));

    const accepted = logger.emitted
      .filter((line) => line.event === 'swarm.branch_accepted')
      .map((line) => String(line.fields.node));

    const proposers = nodes.filter((node) => node.parent_id !== null).map((node) => node.id);
    expect(proposers.length).toBeGreaterThan(0);

    for (const id of proposers) {
      expect([...answered, ...accepted]).toContain(id);
    }

    // Proposals the budget outlived are refused for the budget at their own depth (post-loop sweep).
    const budget = logger.emitted.filter((line) =>
      line.event === 'swarm.branch_refused' && line.fields.policy === 'budget-exhausted');

    expect(budget.length).toBeGreaterThan(0);
    expect(String(budget[0]?.fields.error)).toContain('budget exhausted at depth');

    // Route 1 end to end: a node at the cap proposing uninvited is refused by name.
    const capped = logger.emitted.filter((line) =>
      line.event === 'swarm.branch_refused' && line.fields.policy === 'depth-exhausted');

    expect(capped.length).toBeGreaterThan(0);
    expect(capped[0]?.fields.depth).toBe(2);
    expect(String(capped[0]?.fields.error)).toContain('depth exhausted at depth 2');
    const cappedIds = new Set(capped.map((line) => String(line.fields.node)));

    for (const node of nodes) {
      if (node.parent_id !== null && cappedIds.has(node.parent_id)) {
        throw new Error(`node ${node.parent_id} was refused at the cap and still got a child`);
      }
    }
  });

  test('the deepest level a branch could still be granted from is invited to propose', async () => {
    // Only `arbitrateBranch` owns the boundary (`caps.depth.value <= atDepth`): in a depth-2 search depth 1 is
    // invited and depth 2 is not. Asserted via prompts because the mock proposes even when uninvited.
    const { nodes, prompts } = await run({ depth: 2, branches: 2, proposeWidth: null });
    const invited = prompts.filter((sent) => sent.includes('You are proposing, not spawning'));
    const oneBelowTheCap = nodes.filter((node) => node.depth === 1).length;
    expect(oneBelowTheCap).toBeGreaterThan(0);
    expect(invited).toHaveLength(oneBelowTheCap);
    expect(invited.length).toBeLessThan(prompts.length);
  });
});

// `carry:'artifacts'` admission `threshold` is consulted at settle.
describe('carry admission at the settle barrier', () => {
  test('the artifacts threshold is read, and a candidate under it is not carried', async () => {
    // Above any normalised score, so every candidate must be refused.
    const { logger, result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 2 } },
    });

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const refused = logger.emitted.filter((line) => line.event === 'swarm.carry_refused');
    // Non-vacuity: no candidates would make every assertion below hold trivially.
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]?.fields).toMatchObject({
      carry: 'artifacts', threshold: 2, cause: 'below-threshold',
    });
    expect(logger.emitted.filter((line) => line.event === 'swarm.carry_admitted')).toHaveLength(0);

    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.carry_settled');
    expect(settled?.fields).toMatchObject({ carry: 'artifacts', admitted: 0 });
    expect(settled?.fields.refused).toBe(refused.length);
  });

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
  });
});

// The records store's decisions are reached and read back (decisions: `unit-exploration-records.test.ts`).

/**
 * The identity a run of this objective resolves to, derived the way the run derives it.
 * A function, not a module constant: hashing at module scope can hit a throwing `node:crypto` shim.
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

/** A floor above the optimum's n-1 calls, refuted by the first correct candidate (H1). */
const REFUTED_FLOOR: Floor = {
  value: N + 6,
  kind: 'certificate',
  bestKnownHonest: N + 16,
  proof: 'A deliberately wrong bound, so the run has a breach to be sealed by.',
};

describe('the records store: what one run reached, the next one starts from', () => {
  test("A RECORD SURVIVES ONE RUN AND THE NEXT RUN READS IT", async () => {
    // Two runs, one workspace: the second reads what the first wrote before expanding.
    const { rt } = createTestRuntime();

    const first = await run({
      depth: 1, branches: 2, proposeWidth: null, rt,
      config: { carry: { kind: 'elites' } },
    });

    expect('reason' in first.result).toBe(false);

    if ('reason' in first.result) return;
    expect(first.result.report.records).toMatchObject({ carriedIn: 0, carriedInBest: null });
    expect(first.result.report.records?.written).toBeGreaterThan(0);

    // Read back scoped by identity and floor, never by objective id alone.
    const persisted = recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]?.value).toBe(first.result.best?.measured?.value ?? -1);
    expect(persisted[0]?.rootId).toBe(first.nodes[0]?.id ?? '');

    const second = await run({
      depth: 1, branches: 2, proposeWidth: null, rt,
      config: { carry: { kind: 'elites' } },
    });

    expect('reason' in second.result).toBe(false);

    if ('reason' in second.result) return;

    expect(second.result.report.records?.carriedIn).toBe(persisted.length);
    expect(second.result.report.records?.carriedInBest).toBe(persisted[0]?.value ?? -1);
    const carried = second.logger.emitted.filter((line) => line.event === 'swarm.records_carried_in');
    expect(carried).toHaveLength(1);
    expect(carried[0]?.fields).toMatchObject({ carry: 'elites', best: persisted[0]?.value ?? -1 });

    // The search was told, per the prompts sent; otherwise `carriedIn` holds with dead prompt wiring.
    const told = second.prompts.filter((sent) => sent.includes('An earlier run of this same objective'));
    expect(told).toHaveLength(second.prompts.length);
    expect(told[0]).toContain(String(persisted[0]?.value ?? -1));
    expect(told[0]).toContain('function solve');
    expect(first.prompts.some((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(false);
  });

  test('re-running the same search does not lower what the store holds', async () => {
    // Monotone rule: re-recording the same optimum is a tie, which does not displace, and the store says so.
    const { rt } = createTestRuntime();

    const first = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'elites' } },
    });

    expect('reason' in first.result).toBe(false);
    const before = recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR });

    const second = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, config: { carry: { kind: 'elites' } },
    });

    expect('reason' in second.result).toBe(false);

    if ('reason' in second.result) return;
    expect(second.result.report.records?.notBetter).toBeGreaterThan(0);
    expect(second.result.report.records?.written).toBe(0);

    const after = recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(after).toHaveLength(before.length);
    expect(after[0]?.value).toBe(before[0]?.value ?? -1);
  });

  test("`carry:'artifacts'` admissions reach persistence, and a refused one writes nothing", async () => {
    // `SWARM_CARRIES`: the admission threshold gates the write too.
    const clears = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 0 } },
    });

    expect('reason' in clears.result).toBe(false);

    if ('reason' in clears.result) return;
    const records = clears.result.report.records;
    expect(records?.written).toBeGreaterThan(0);
    expect(clears.logger.emitted.filter((line) => line.event === 'swarm.record_written').length)
      .toBe(records?.written ?? -1);

    const misses = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { carry: { kind: 'artifacts', threshold: 2 } },
    });

    expect('reason' in misses.result).toBe(false);

    if ('reason' in misses.result) return;
    expect(misses.result.report.records).toMatchObject({ written: 0, notBetter: 0 });
  });

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
    // Under `carry:'none'` the store is neither read nor written; the whole shape is asserted, not two fields.
    expect(recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR }).length)
      .toBeGreaterThan(0);
    expect(isolated.logger.emitted.filter((line) => line.event === 'swarm.carry_admitted').length)
      .toBeGreaterThan(0);
    expect(isolated.result.report.records).toEqual({
      carriedIn: 0, carriedInBest: null, carriedInCells: 0, written: 0, notBetter: 0, tooClose: 0,
    });
  });

  test('A BREACHED RUN WRITES NOTHING — the seal reaches the store', async () => {
    // *The publication seal*: a candidate refutes its bound, the floor is suspended and nothing is written.
    // The run does not halt.
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
    expect(recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: REFUTED_FLOOR })).toHaveLength(0);
    expect(breached.result.report.carrySuppressed?.carry).toBe('elites');
    expect(breached.result.report.carrySuppressed?.refused).toContain('records');
  });

  test('A BREACH SEALS ITS OBJECTIVE AND FLOOR for every later run, not only its own', async () => {
    // Spec 4.4: "Publication STOPS for that objective". The later run's candidates make
    // 2n-1 calls, over the refuted floor, so any refusal it meets is the earlier run's seal.
    // `Concurrent.lean — a_breach_stops_every_run_on_its_floor`.
    const { rt } = createTestRuntime();

    const breached = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, floor: REFUTED_FLOOR,
      config: { carry: { kind: 'elites' } },
    });

    expect('reason' in breached.result).toBe(false);

    const later = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, floor: REFUTED_FLOOR,
      answers: [THOROUGH], config: { carry: { kind: 'elites' } },
    });

    expect('reason' in later.result).toBe(false);

    if ('reason' in later.result) return;
    expect(later.result.publication.state).toMatchObject({ kind: 'sealed', breach: { floor: REFUTED_FLOOR } });
    expect(later.result.report.records).toMatchObject({ written: 0 });
    expect(later.result.report.carrySuppressed?.refused).toContain('records');
    expect(recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: REFUTED_FLOOR })).toHaveLength(0);

    const unsealed = await run({
      depth: 1, branches: 2, proposeWidth: null, floor: REFUTED_FLOOR,
      answers: [THOROUGH], config: { carry: { kind: 'elites' } },
    });

    expect('reason' in unsealed.result).toBe(false);

    if ('reason' in unsealed.result) return;
    expect(unsealed.result.publication.state.kind).toBe('open');
    expect(unsealed.result.report.records?.written).toBeGreaterThan(0);
  });
});

// The swarm path reaches `mcts/evaluation.ts`'s judge ensemble. The pool derives from the request
// (`judgeCallPool`), never `DEFAULT_CONFIG.mcts.maxEvalLLMCalls`, or a 20-sample judge runs at 3.
describe("score:'judge' reaches the ensemble the tree already owns", () => {
  test('A JUDGED TREE RUNS at the ensemble it was admitted at', async () => {
    const { result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } },
    });

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    expect(result.report.judgeEnsemble).toEqual({ requested: 20, realised: 20 });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.best).not.toBeNull();
    expect(result.best?.score).toBeGreaterThan(0);
    expect(result.best?.measured).toBeNull();
    expect(result.report.records).toBeNull();
  });

  test('the realised ensemble is PERSISTED, so a reader can state it once the call has returned', async () => {
    // The smallest realised ensemble is folded onto the run's ledger row, even when it equals the request.
    const { rt } = createTestRuntime();

    const { result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } }, rt,
    });

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    expect(result.report.judgeEnsemble).toEqual({ requested: 20, realised: 20 });

    const page = readExplorationCanvas(rt.storage.sql, rt.actor);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0];
    // Without the swarm ledger row, `readForkRunParams` answers with the transcript half alone.
    expect(entry.params?.search).toMatchObject({
      budget: 2, branches: 2, maxDepth: 1, mode: 'build',
      judgeSamplesRequested: 20, judgeSamplesRealised: 20,
    });
    expect(entry.params?.search?.judgeSamplesRealised)
      .toBe(result.report.judgeEnsemble?.realised ?? null);
    expect(entry.run.hasSearchTree).toBe(true);
    expect(entry.tree.length).toBeGreaterThan(0);
    expect(entry.run.hasNodeTranscripts).toBe(false);
    expect(entry.head).toBeNull();
  });

  test('no clamp is disclosed, because none can bind', async () => {
    // The pool is sized from the request, so no `swarm.judge_ensemble_clamped` event; a shortfall fails the run.
    const { logger, result } = await run({
      depth: 1, branches: 2, proposeWidth: null,
      config: { score: { kind: 'judge', samples: 20 } },
    });

    expect('reason' in result).toBe(false);
    expect(logger.emitted.filter((line) => line.event === 'swarm.judge_ensemble_clamped'))
      .toHaveLength(0);
  });

  test('a judged tree BELOW the marginalisation floor is refused, by the in-process entry point too', async () => {
    // Built past `swarmValidity`: `runSwarm` does not route through it, so the runner needs its own gate.
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
    expect(swarmValidity(call)?.error).toContain('samples ≥ 20');

    const { rt } = createTestRuntime();
    const refusal = await runSwarm({ rt, hostNode: NO_NODE, model: answering(null), mode: 'build' }, call);
    expect('reason' in refusal).toBe(true);

    if (!('reason' in refusal)) return;
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('samples ≥ 20');
    expect(refusal.error).toContain('maxEvalLLMCalls');
  });

  test('a FLAT judged run has no floor to clear — the bound is about trees', async () => {
    // `advance:'none'` has no selection step, so the marginalisation floor does not apply.
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
    const result = await runSwarm({ rt, hostNode: NO_NODE, model: answering(null), mode: 'build' }, call);
    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    expect(result.report.judgeEnsemble).toEqual({ requested: 1, realised: 1 });
  });
});

// A real settle goes through merge-back. Drives `runSwarm` directly to reach the workspace runtime.
describe('merge-back at the settle barrier', () => {
  test("the winner's answer reaches the origin through apply-winner", async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger },
      resolved({ depth: 1, branches: 2 }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const winner = result.best;
    expect(winner).not.toBeNull();

    if (!winner) return;

    const [applied] = logger.emitted.filter((line) => line.event === 'swarm.merge_applied');
    expect(applied?.fields).toMatchObject({ policy: 'apply-winner', files: 1 });
    expect(applied?.fields.node).toBe(winner.id);

    const landed = await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' });
    expect(landed).toBe(winner.artifact);

    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({
      policy: 'apply-winner', applied: 1, refused: 0, merge_nodes: 0, stopped_at: '',
    });
  });

  // The padding is a comment: still optimal, but too large for one host transaction.
  test('an oversized winner is refused at settle with the bound named', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const padded = `${OPTIMAL}\n// ${'x'.repeat(MAX_TX_BLOB_BYTES + 1)}\n`;

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null, [padded]), mode: 'build', logger },
      resolved({ depth: 1, branches: 1 }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    expect(result.best).not.toBeNull();

    const [oversized] = logger.emitted.filter((line) => line.event === 'swarm.merge_oversized');
    expect(oversized?.fields).toMatchObject({
      policy: 'apply-winner', bound: 'blobBytes', maximum: MAX_TX_BLOB_BYTES,
    });
    expect(String(oversized?.fields.error)).toContain('committed prefix');
    expect(logger.emitted.filter((line) => line.event === 'swarm.merge_applied')).toHaveLength(0);
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({ applied: 0, refused: 1 });
  });
});

/** A model answering from a cycling script of whole solutions, so each candidate is still really measured. */
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

/** Optimal, with a comment that changes its bytes but not its cost: two agree, a third disagrees. */
function variant(mark: string): string {
  return `${OPTIMAL}// ${mark}\n`;
}

function fanInEvents(logger: RecordingLogger, event: string): readonly LogFields[] {
  return logger.emitted.filter((line) => line.event === event).map((line) => line.fields);
}

// Asserts fan-in order and DAG edges, not merely that something merged.
describe("`expand:'aggregate'`: a level is fanned in, in dependency order", () => {
  test('a real DAG runs: agreement accumulates, a disagreement becomes a graded vertex', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: scripted([variant('same'), variant('same'), variant('odd')]), mode: 'build', logger },
      resolved({ depth: 3, branches: 3, over: { expand: 'aggregate' } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const fanIn = result.report.fanIn;
    expect(fanIn).not.toBeNull();

    if (!fanIn) return;
    expect(fanIn.levels).toBeGreaterThan(0);

    // Two parents agree, the third disagrees: exactly one node spawns via the *Merge-back* conflict policy.
    const [first] = fanInEvents(logger, 'swarm.aggregate_fan_in');
    expect(first).toMatchObject({ depth: 1, parents: 3, members: 3, merged: 2 });
    const [spawned] = fanInEvents(logger, 'swarm.merge_node_spawned');
    expect(spawned).toMatchObject({
      policy: 'conflict-spawns-a-merge-node', derived_from: 'sequential-rebase',
    });
    expect(spawned?.spawned).toBe(String(first?.vertex));

    const reverified = fanInEvents(logger, 'swarm.merge_reverified');
    expect(reverified.length).toBeGreaterThan(0);
    expect(reverified[0]).toMatchObject({ outcome: 'scored' });

    // The vertex is a real row one level below its parents, measured by the same instrument.
    const rows = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    const [vertex] = fanInEvents(logger, 'swarm.aggregate_vertex');
    const vertexRow = rows.find((row) => row.id === String(vertex?.node));
    expect(vertexRow?.depth).toBe(2);
    expect(vertexRow?.parent_id).toBe(String(vertex?.selection_parent));
    const graded = result.candidates.find((candidate) => candidate.id === vertexRow?.id);
    expect(graded?.measured?.kind).toBe('measured');
    const edges = String(vertex?.aggregated).split(',');
    expect(edges.length).toBe(3);
    expect(edges).toContain(String(vertex?.selection_parent));
  });

  test('a merge order is a topological order: a vertex is held behind the parent it consumed', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: scripted([variant('same'), variant('same'), variant('odd')]), mode: 'build', logger },
      resolved({ depth: 3, branches: 3, over: { expand: 'aggregate' } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const [vertex] = fanInEvents(logger, 'swarm.aggregate_vertex');
    const node = String(vertex?.node);
    const edges = String(vertex?.aggregated).split(',');

    // The vertex was offered before its shallower parent's work landed: where an order can invert.
    const together = fanInEvents(logger, 'swarm.aggregate_fan_in')
      .map((fields) => String(fields.order).split(','))
      .find((order) => order.includes(node) && edges.some((edge) => order.includes(edge)));

    expect(together).toBeDefined();

    if (!together) return;

    for (const edge of edges) {
      if (!together.includes(edge)) continue;
      expect(together.indexOf(edge)).toBeLessThan(together.indexOf(node));
    }

    // Non-vacuity: the offered order put the dependent first.
    expect(together[0]).not.toBe(node);
  });

  test('parents that AGREE accumulate, and no node is burned deciding nothing', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      // Byte-identical members have not conflicted, so no graded node is spawned.
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger },
      resolved({ depth: 2, branches: 2, over: { expand: 'aggregate' } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const [first] = fanInEvents(logger, 'swarm.aggregate_fan_in');
    expect(first).toMatchObject({ depth: 1, parents: 2, members: 2, merged: 2, vertex: '' });
    expect(fanInEvents(logger, 'swarm.merge_node_spawned')).toHaveLength(0);
    expect(result.report.fanIn?.vertices).toEqual([]);
    expect(result.report.fanIn?.merged).toBe(2);
    const winner = result.best;
    expect(winner).not.toBeNull();

    if (!winner) return;
    expect(await rt.storage.vfs.readFile(SOLUTION_FILE, { encoding: 'utf8' })).toBe(winner.artifact);
  });

  test('a parent the tree retired is consumed anyway, and the report says how many', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      // The reference scores 0 and is retired: a parent with a last good state.
      {
        rt,
        hostNode: NO_NODE,
        model: scripted([variant('same'), variant('same'), variant('odd'), REFERENCE]),
        mode: 'build',
        logger,
      },
      resolved({ depth: 3, branches: 3, over: { expand: 'aggregate', pruneThreshold: 0.5, minVisitsForPrune: 1 } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    const rows = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    const retired = rows.filter((row) => row.status === 'pruned').map((row) => row.id);
    // Non-vacuity: pruning fired.
    expect(retired.length).toBeGreaterThan(0);

    expect(result.report.fanIn?.prunedParents).toBeGreaterThan(0);

    const consumed = fanInEvents(logger, 'swarm.aggregate_fan_in')
      .flatMap((fields) => String(fields.order).split(','));

    expect(retired.some((id) => consumed.includes(id))).toBe(true);
  });

  test('a parent the search could not score is not consumed, and the count says so', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();

    const result = await runSwarm(
      // An unmeasurable candidate gets no edge, leaving one consumable parent: not a fan-in.
      { rt, hostNode: NO_NODE, model: scripted(['export function solve() { throw new Error("no"); }\n', OPTIMAL]), mode: 'build', logger },
      resolved({ depth: 2, branches: 2, over: { expand: 'aggregate' } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    expect(result.report.fanIn?.unusableParents).toBeGreaterThan(0);
    const [skipped] = fanInEvents(logger, 'swarm.aggregate_skipped');
    expect(skipped).toMatchObject({ reason: 'no-level', parents: 1 });
    expect(result.report.fanIn?.vertices).toEqual([]);
  });

  test('the transaction bound is checked per member, before the fan-in applies one', async () => {
    const { rt } = createTestRuntime();
    const logger = createRecordingLogger();
    const padded = `${OPTIMAL}\n// ${'x'.repeat(MAX_TX_BLOB_BYTES + 1)}\n`;

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null, [padded]), mode: 'build', logger },
      resolved({ depth: 2, branches: 2, over: { expand: 'aggregate' } }),
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    // Candidates still measure; the fan-in refuses its first member naming the bound.
    const [oversized] = fanInEvents(logger, 'swarm.merge_oversized');
    expect(oversized).toMatchObject({
      policy: 'sequential-rebase', bound: 'blobBytes', maximum: MAX_TX_BLOB_BYTES,
    });
    expect(result.report.fanIn?.merged).toBe(0);
  });

  test("`expand:'sample'` fans in nothing, and says so rather than reporting a fan-in of zero", async () => {
    const { logger, result } = await run({ depth: 2, branches: 2, proposeWidth: null });
    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    expect(result.report.fanIn).toBeNull();
    expect(logger.emitted.filter((line) => line.event.startsWith('swarm.aggregate'))).toHaveLength(0);
    const [settled] = logger.emitted.filter((line) => line.event === 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({ policy: 'apply-winner', members: 1 });
  });

  test('a composition where a fan-in could never happen is refused, naming what makes it impossible', async () => {
    const { rt } = createTestRuntime();

    const refusal = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      resolved({ depth: 1, branches: 3, over: { expand: 'aggregate' } }),
    );

    // The refusal names what this composition lacks and the fix, not a blanket "unsupported".
    expect('reason' in refusal).toBe(true);

    if (!('reason' in refusal)) return;
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('needs a level to consume');
    expect(refusal.error).toContain('Raise `depth`');
    expect(refusal.error).not.toContain('nothing here orders merges');
  });
});

// Archive cells are witnessed by the real `exec-ratio` instrument; `candOps` is the descriptor.

/** Correct but wasteful (n-1 + n calls): a different `candOps` cell from the optimum. */
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

/** The optimum restated: same cell, a few tokens apart — the near-copy an archive refuses. */
const RESTATED = `${OPTIMAL}// the same single scan, said again\n`;

/** Cells spelled out rather than computed, so a coordinate change fails here. */
const OPTIMAL_CELL = `candOps=${String(N - 1)}`;

const THOROUGH_CELL = `candOps=${String(N - 1 + N)}`;

/** Archive axes: a rejection threshold a restatement cannot clear and a different algorithm can. */
const ARCHIVE: Partial<SwarmConfig> = {
  advance: { kind: 'archive', novelty: 0.4 },
  carry: { kind: 'elites' },
};

describe("advance:'archive' bins a wave into cells, and the next run starts from them", () => {
  test('A REAL RUN FILLS THE CELLS ITS INSTRUMENT WITNESSED, one elite each', async () => {
    // The composition is served: one row per cell, keyed by the measured descriptor.
    const { rt } = createTestRuntime();

    const { result, logger } = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE,
    });

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;

    expect(result.report.settle).toBe('archive');
    expect(result.report.records?.written).toBe(2);
    expect(result.report.records?.tooClose).toBe(0);

    const rows = recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR });
    expect(rows.map((row) => present(row.descriptor, 'the record descriptor')).sort((a, b) => a.localeCompare(b))).toEqual([OPTIMAL_CELL, THOROUGH_CELL]);
    expect(bestInCell(rt.storage.sql, rt.actor, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    })?.value).toBe(N - 1);
    expect(bestInCell(rt.storage.sql, rt.actor, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: THOROUGH_CELL,
    })?.value).toBe(N - 1 + N);

    const written = logger.emitted.filter((line) => line.event === 'swarm.record_written');
    expect(written.map((line) => v.parse(v.string(), line.fields.cell)).sort((a, b) => a.localeCompare(b))).toEqual([OPTIMAL_CELL, THOROUGH_CELL]);
  });

  test('A SECOND RUN READS THE OCCUPANTS, and reports the COVERAGE it started from', async () => {
    // `carriedInCells` is coverage: an archive collapsed onto one cell would still report `carriedIn` as full.
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
    expect(second.prompts.every((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(true);
    expect(first.prompts.some((sent) => sent.includes('An earlier run of this same objective')))
      .toBe(false);
  });

  test('A NEAR-COPY OF AN OCCUPANT IS REFUSED, and the refusal NAMES the occupant', async () => {
    // Admission across two runs: the same oracle calls hit the same cell, and the second answer restates the first.
    const { rt } = createTestRuntime();

    const first = await run({
      depth: 1, branches: 1, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL], config: ARCHIVE,
    });

    expect('reason' in first.result).toBe(false);

    const occupant = bestInCell(rt.storage.sql, rt.actor, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    });

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
    expect(Number(refused?.fields.distance)).toBeLessThan(0.4);
    expect(Number(refused?.fields.distance)).toBeGreaterThan(0);
    expect(recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: SUITE_FLOOR }))
      .toHaveLength(1);
  });

  test('THE MONOTONE RULE HOLDS ACROSS RUNS, inside the cell', async () => {
    // A cell's best never falls: a tie does not displace, and the store says so.
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
    expect(second.result.report.records).toMatchObject({ written: 0, notBetter: 1, tooClose: 0 });

    const cell = bestInCell(rt.storage.sql, rt.actor, {
      identity: identityOf(), floor: SUITE_FLOOR, descriptor: OPTIMAL_CELL,
    });

    expect(cell?.value).toBe(N - 1);
    expect(cell?.displacements).toBe(0);
  });

  test('A BREACHED RUN WRITES NOTHING TO THE ARCHIVE, and says how many cells that cost', async () => {
    // *The publication seal*, barrier half: a candidate refutes its bound and the grid stays empty.
    // The cell count reports both witnessed cells: the coverage the seal cost.
    const { rt } = createTestRuntime();

    const breached = await run({
      depth: 1, branches: 2, proposeWidth: null, rt, key: 'candOps',
      answers: [OPTIMAL, THOROUGH], config: ARCHIVE, floor: REFUTED_FLOOR,
    });

    expect('reason' in breached.result).toBe(false);

    if ('reason' in breached.result) return;

    expect(breached.result.publication.state.kind).toBe('sealed');
    expect(breached.result.report.records).toMatchObject({ written: 0, tooClose: 0 });
    expect(recordsFor(rt.storage.sql, rt.actor, { identity: identityOf(), floor: REFUTED_FLOOR }))
      .toHaveLength(0);
    expect(breached.result.report.carrySuppressed).toMatchObject({
      carry: 'elites', suppressedCells: 2,
    });
    const refused = breached.logger.emitted.filter((line) => line.event === 'swarm.carry_refused');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((line) => line.fields.cause === 'sealed')).toBe(true);
  });
});

describe("the archive's own region, and the refusal `pareto` carries alone", () => {
  /** Refusal text for an expected-illegal composition, or '' when legal. */
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
    // Archive cells are written at settle, so one run has no second level to select; refused, not flattened.
    const error = archiveRefusal({ depth: 3, key: 'candOps' });
    expect(error).toContain('depth 3 cannot be run');
    expect(error).toContain('settle barrier');
    expect(error).toContain('carry:"elites"');
  });

  test('an archive with no measured objective cannot key a cell, and says so', () => {
    // A judged run has no objective identity or direction to key cells by.
    const error = archiveRefusal({
      depth: 1, key: 'candOps', config: { score: { kind: 'judge', samples: 20 } },
    });

    expect(error).toContain('keys every cell by the objective\'s identity');
    expect(error).toContain('score:"verify"');
  });

  test('a novelty threshold no distance can satisfy is refused, with the unit STATED', () => {
    // A distance floor, not a similarity ceiling: an unconverted value is stricter than intended or unenterable.
    const error = archiveRefusal({
      depth: 1, key: 'candOps', config: { advance: { kind: 'archive', novelty: 1.4 } },
    });

    expect(error).toContain('[0,1]');
    expect(error).toContain('one MINUS that number');
  });

  test('a key the instrument does not witness is refused BEFORE a candidate is expanded', async () => {
    // A key the instrument cannot report is refused once the baseline shows what it reports, not per candidate.
    const { result } = await run({
      depth: 1, branches: 1, proposeWidth: null, key: 'tactic', config: ARCHIVE,
    });

    expect('reason' in result).toBe(true);

    if (!('reason' in result)) return;
    expect(result.reason).toBe('bad_input');
    expect(result.error).toContain('"tactic" is not among the quantities');
    expect(result.error).toContain('candOps');
    expect(result.error).toContain('refOps');
  });

  test("advance:'pareto' keeps a durable nondominated vector frontier", async () => {
    const scalar = objective();

    if (scalar.kind !== 'scalar') throw new Error("the suite's objective is a scalar");

    const front: VectorObjective = {
      kind: 'vector',
      components: [
        { ...scalar, metric: 'oracle_calls' },
        { ...scalar, metric: 'oracle_calls_again' },
      ],
    };

    const call = resolveSwarm({
      preset: 'custom',
      label: 'pareto-suite',
      task: 'reach the front',
      objective: front,
      config: treeConfig({ advance: { kind: 'pareto' }, carry: { kind: 'none' } }),
      depth: 2,
      branches: 2,
    });

    if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
    expect(swarmValidity(call)).toBeNull();
    const { rt } = createTestRuntime();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      call,
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    expect(result.best).toBeNull();
    expect(result.frontier?.length).toBe(4);
    expect(result.frontier?.every((candidate) => candidate.pareto !== null)).toBe(true);
  });

  test("advance:'pareto' refuses an instanced measurement that omits an axis", async () => {
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
      label: 'pareto-missing-axis',
      task: 'reach the front',
      objective: front,
      config: treeConfig({ advance: { kind: 'pareto' }, carry: { kind: 'none' } }),
      depth: 1,
      branches: 1,
    });

    if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
    const { rt } = createTestRuntime();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      call,
    );

    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    expect(result.candidates[0]?.unmeasurable).toContain('omitted declared axis');
    expect(result.frontier).toEqual([]);
  });

  test("advance:'pareto' with nothing measured refuses instead of settling empty", async () => {
    // In-process only: `swarmValidity` refuses this at the tool surface. Without the refusal a `pareto`
    // selection with no front returns no node and the run settles empty, silently.
    const call = resolveSwarm({
      preset: 'custom',
      label: 'pareto-unmeasured',
      task: 'reach the front',
      config: treeConfig({
        advance: { kind: 'pareto' },
        // Admitted at the marginalisation floor, so the refusal is about the missing front.
        score: { kind: 'judge', samples: JUDGE_MARGINALISATION_MIN },
        carry: { kind: 'none' },
      }),
      depth: 2,
      branches: 2,
    });

    if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
    expect(swarmValidity(call)?.error).toContain('advance:"pareto"');

    const { rt } = createTestRuntime();

    const result = await runSwarm(
      { rt, hostNode: NO_NODE, model: answering(null), mode: 'build', logger: createRecordingLogger() },
      call,
    );

    if (!('reason' in result)) throw new Error('an unmeasured pareto run must refuse, not settle');
    expect(result.reason).toBe('unsupported');
    expect(result.error).toContain('orders its frontier by the axes');
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_nodes`[0]?.n ?? 0).toBe(0);
  });
});

/**
 * A judged run crowns the highest median. The shared mock judge answers 0.5 to everything, so each
 * branch here gets a distinct median, with the maximum in the middle of the wave.
 */
describe("a judged run's winner is the highest median, not the lowest", () => {
  /** Distinct medians per branch; the maximum sits at index 2, neither first nor last. */
  const MEDIANS = [0.20, 0.55, 0.95, 0.40, 0.10] as const;

  const WINNER = 2;

  /** The marker a branch writes so the judge and assertions can identify it. */
  const MARK = 'MEDIAN-MARK-';

  test('the wave is ranked highest-first, and the crown goes to the interior maximum', async () => {
    // Keyed off the branch's own angle (`Your angle:`), not a call counter: the wave runs concurrently.
    const model = new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'fake-judged-wave',
      doGenerate: async ({ prompt }) => {
        const sent = JSON.stringify(prompt);

        const branch = MEDIANS.findIndex(
          (_unused, index) => sent.includes(`Your angle: ${diversityAngle(index, MEDIANS.length)}.`),
        );

        if (branch === -1) throw new Error('a node was expanded with no angle, so no branch can be named');

        return {
          content: [{
            type: 'text' as const,
            text: 'Bound the loop by the running maximum instead of comparing every pair. '
              + `${MARK}${String(branch)}`,
          }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 22, text: 22, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    // Answers per candidate, bounded by the prompt's section header, since siblings' text is in the prompt too.
    const judgeModel: LLM = {
      // eslint-disable-next-line require-yield -- an ensemble only ever calls `complete`.
      async *stream(): AsyncIterable<string> {
        throw new Error('the judge was streamed, which no ensemble does');
      },
      async complete(prompt: string): Promise<string> {
        const candidate = prompt.split('Candidate approach:\n')[1]?.split('\nSibling approaches')[0] ?? '';
        const branch = MEDIANS.findIndex((_unused, index) => candidate.includes(`${MARK}${String(index)}`));

        if (branch === -1) {
          throw new Error(`the judge could not tell which candidate it was given: ${candidate.slice(0, 200)}`);
        }

        return JSON.stringify({ score: MEDIANS[branch], rationale: 'scored by branch' });
      },
    };

    const call = resolveSwarm({
      preset: 'custom',
      label: 'judged-rank',
      task: 'Say in prose how to find the largest token with fewer comparisons.',
      // Flat and one sample, so the realised ensemble is one and the score is the chosen median.
      config: treeConfig({ score: { kind: 'judge', samples: 1 }, advance: { kind: 'none' } }),
      depth: 1,
      branches: MEDIANS.length,
    });

    if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
    expect(swarmValidity(call)).toBeNull();

    const { rt } = createTestRuntime();

    const result = await runSwarm(
      { rt: { ...rt, judgeModel }, hostNode: NO_NODE, model, mode: 'build', logger: createRecordingLogger() },
      call,
    );

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // Five identifiable candidates, one sample, five distinct scores: a tie asserts nothing.
    expect(result.report.judgeEnsemble).toEqual({ requested: 1, realised: 1 });
    expect(result.candidates).toHaveLength(MEDIANS.length);
    const byBranch = new Map<number, number>();

    for (const candidate of result.candidates) {
      const branch = MEDIANS.findIndex(
        (_unused, index) => candidate.artifact.includes(`${MARK}${String(index)}`),
      );

      if (branch === -1) throw new Error(`a candidate carried no branch mark: ${candidate.artifact}`);

      if (candidate.score === null) throw new Error(`branch ${String(branch)} was not scored at all`);
      byBranch.set(branch, candidate.score);
    }

    expect(byBranch.size).toBe(MEDIANS.length);
    expect(new Set(byBranch.values()).size).toBe(MEDIANS.length);

    for (const [i, mine] of MEDIANS.entries()) {
      for (const [j, theirs] of MEDIANS.entries()) {
        if (mine <= theirs) continue;
        const higher = byBranch.get(i);
        const lower = byBranch.get(j);

        if (higher === undefined || lower === undefined) throw new Error('a branch went unscored');
        expect(higher).toBeGreaterThan(lower);
      }
    }

    expect(Math.max(...MEDIANS)).toBe(MEDIANS[WINNER]);
    expect(WINNER).toBeGreaterThan(0);
    expect(WINNER).toBeLessThan(MEDIANS.length - 1);
    const best = result.best;

    if (!best) throw new Error('a judged wave that scored five candidates must crown one of them');
    expect(best.artifact).toContain(`${MARK}${String(WINNER)}`);
    expect(best.score).toBe(Math.max(...byBranch.values()));

    for (const [branch, score] of byBranch) {
      if (branch === WINNER) continue;
      expect(best.score ?? 0).toBeGreaterThan(score);
    }
  });
});

describe("the drawn tree shows each swarm node's own score", () => {
  test("a node whose children scored otherwise draws its scorer's number, not its subtree's mean", async () => {
    const { rt } = createTestRuntime();
    const { nodes, result } = await run({ depth: 2, branches: 2, proposeWidth: null, answers: [THOROUGH, OPTIMAL], rt });
    expect('reason' in result).toBe(false);

    if ('reason' in result) return;
    const root = present(nodes.find((node) => node.parent_id === null), 'the swarm root');
    const rows = readSearchTree(rt.storage.sql, rt.actor, root.id);
    const drawn = present(explorationForkTree({ tree: rows, head: null }), 'the drawn tree');
    const scored = result.candidates.filter((candidate) => candidate.score !== null);
    const ownScore = new Map(scored.map((candidate) => [candidate.id, candidate.score]));

    // Some expanded node's mean moved off its own score, so a tree drawn from `value` fails here.
    expect(nodes.some((node) => ownScore.has(node.id) && ownScore.get(node.id) !== node.value)).toBe(true);

    for (const [id, score] of ownScore) expect(findForkNode(drawn, id)?.value).toBe(score);
  });
});
