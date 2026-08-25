/**
 * The search tree as the run holds it, and the machinery around one level of it: the
 * node row's CONTENT (`TreeNode`), one child's pre-measurement shape
 * (`Expansion`), how a node stopped short, the level barrier that awaits a wave,
 * the scheduler-policy table, the workspace-as-found read, ancestry walks, and the
 * engine half of arbitration.
 *
 * Split from `swarm-run.ts` because these are TREE mechanics, shared by the expansion
 * path, the fan-in and the scoring loop alike — state transitions and projections over
 * the tree rather than orchestration of it.
 */
import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import type { Usage } from '../usage';
import { toKinuError, type KinuError } from '../obs/error';
import type { Logger } from '../obs/index';
import type { FrontierPolicy } from '../mcts/frontier';
import type { HeadReport } from '../heads/types';
import type { BranchDecision, BranchGrant, SwarmBudget } from './swarm-budget';
import type {
  BranchProposal, BranchRefusalPolicy, BranchVerdict, ResolvedSwarm, SwarmAdvance,
  SwarmPreset,
} from './swarm';
import type {
  Measurement, MeasurementContext,
} from './objective';

/**
 * One node of the search, as the run holds it.
 *
 * The SQL row beside it (`search_nodes`) holds the SELECTION state — visits, the
 * backpropagated mean, the depth, the status — and this holds the CONTENT. They are
 * different facts about the same node rather than two copies of one: selection reads
 * a running mean over a subtree, while an expansion prompt and the settle report need
 * the answer itself and the measurement it earned.
 */
export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  /** Written by the ENGINE as its parent's depth plus one, and read back from the row
   *  for arbitration. Never supplied by a node. */
  readonly depth: number;
  /** The complete answer this node is. The root's is the workspace as found, which is
   *  null when the verifier's path holds nothing yet. */
  readonly artifact: string | null;
  /** What the instrument said. Null for a node that produced no usable answer, which
   *  is a different fact from a measurement of zero. */
  readonly measurement: Measurement | null;
  /** This node's own normalised score in [0,1] — the reward its ancestors received.
   *  Null when it was never scored (unmeasurable, or sealed past a floor). */
  readonly score: number | null;
  /** The branch this node asked for, still unanswered. Cleared when arbitration
   *  answers it, so the post-loop sweep can find exactly the ones selection never
   *  reached. */
  proposal: BranchProposal | null;
  /** Why a proposal could not be READ, when the node tried and produced something
   *  unparseable. Not one of arbitration's five policies — it never reached the
   *  arbiter — and reported under its own event for that reason. */
  readonly proposalError: string | null;
  /**
   * The branch an AGENT node was granted while it ran, still unexpanded.
   *
   * Distinct from {@link proposal}, and the distinction is the whole difference
   * between the two node kinds: a thought node's request is UNANSWERED until selection
   * reaches it, while an agent node's was answered and PAID FOR inside its own tool
   * call. Cleared when the engine expands it, because a tree selector may re-select an
   * expanded node and a grant left in place would be spent twice off one debit.
   */
  granted: BranchGrant | null;
  /**
   * What this node CONCLUDED, in its own words — the report a `fresh` child is seeded
   * with, per *Inherited context*. Null for the root, which reported nothing because no
   * model wrote it, and for a `thought` node, whose whole output IS its artifact.
   */
  readonly conclusion: string | null;
  /**
   * The conversation a `fork` child of this node inherits: what this node itself
   * inherited, plus what it produced. Append-only, so every sibling of one parent
   * shares one byte-identical cacheable prefix — the caching decision *Inherited
   * context* makes.
   *
   * Empty for a thought node, which has no conversation to hand down, and for the
   * root, whose children start from the origin's own framing.
   */
  readonly transcript: readonly ModelMessage[];
  /**
   * The compacted view of {@link transcript}, once this node has crossed the window
   * threshold and the barrier has run.
   *
   * Held on the PARENT and not on each child, which is the whole point of the
   * once-per-branch-point rule *Inherited context* states: a shared view cannot vary
   * across the siblings it is compared over, so no part of the ranking is a fact about
   * which sibling's compaction kept the useful paragraph.
   */
  compacted: readonly ModelMessage[] | null;
  /**
   * The parents this node FANNED IN, under `expand:'aggregate'` — the DAG's dependency
   * edges, and the reason this is a graph rather than a tree. Empty for every node of a
   * sampling run and for the root.
   *
   * BESIDE {@link parentId} RATHER THAN INSTEAD OF IT, and the two are different edges.
   * `parentId` is the SELECTION edge: the row `search_nodes` holds, the lineage
   * `backpropagate` walks and the depth every child derives from. These are DEPENDENCY
   * edges: whose work this node's answer was written against, which is what orders a
   * merge, per *Dependency order*. Recording a second selection edge would hand one
   * measurement to two ancestor means and make the selector's comparison a fact about
   * how many parents a node happened to have.
   */
  readonly aggregated: readonly string[];
}
/**
 * HOW A NODE STOPPED SHORT: the report's own status, and the line a reader gets.
 *
 * `completed` is excluded by the type rather than by a convention, because a stop is
 * exactly what a node that finished does not have.
 */
export interface NodeStop {
  readonly status: Exclude<HeadReport['status'], 'completed'>;
  /** The status, the steps and the clock, as the caller reads them off the candidate. */
  readonly detail: string;
}

/**
 * One expanded child, before it is measured.
 *
 * Its spend IS here now, unlike the flat version's unused per-child copy: an agent
 * node's usage comes off its own report rather than off one `generateText` call, so
 * the run reads it back per child instead of accumulating inside the generation.
 */
export interface Expansion {
  readonly id: string;
  /**
   * The row this child hangs off, and the depth that row derives.
   *
   * CARRIED BY THE EXPANSION rather than read from the wave that produced it, because a
   * fan-in's vertex hangs off a different parent at a different depth from the level it
   * consumed — and the scoring loop that records both is one loop for both kinds.
   */
  readonly parentId: string;
  readonly depth: number;
  /** The parents this child FANNED IN: the DAG's dependency edges, empty for a wave's
   *  sibling. */
  readonly aggregated: readonly string[];
  /** What the instrument will measure: the reported candidate for an agent node, the
   *  answer text for a thought node. */
  readonly artifact: string;
  /**
   * WHY THIS NODE NEVER FINISHED, and null when it did.
   *
   * THE DISTINCTION THE RANKING DEPENDS ON. An agent node that was aborted, ran out of
   * steps or errored still returns a report, and that report's summary is deliberately
   * NOT its mid-flight text (`incompleteHeadSummary`) — but it IS a string, and a string
   * is what {@link artifact} carries to the instrument. So an unfinished node used to be
   * measured exactly like a finished one and took whatever the instrument said about its
   * own status line: on the live run that was "no runnable code", which blames the
   * verifier for a node the clock stopped. Worse where the summary happens to carry a
   * fence: then the unfinished node is SCORED, and the tree ranks on how far a node got
   * before the clock rather than on how good its answer was.
   *
   * Non-null therefore means "do not measure this": the scoring loop short-circuits, no
   * reward is backpropagated, and the caller is told which node stopped and why. Always
   * null for a thought node, whose one `generateText` either returns an answer or throws.
   *
   * THE STATUS RIDES WITH THE DETAIL because the level barrier needs the two apart. A
   * node that BROKE and a node that was CUT are both unmeasurable and the caller reads
   * the same field for both, but a level of nodes that all broke is a dead provider the
   * run must refuse rather than re-select against, while a level the caller's own
   * deadline cut is a run reporting what each node had reached. Deriving that from the
   * detail STRING would be the drift-prone half of this pair; the report's own
   * vocabulary is not.
   */
  readonly incomplete: NodeStop | null;
  /**
   * The node's output AS WRITTEN, code fences intact — what a JUDGE grades.
   *
   * It differs from {@link artifact} for a thought node and only there: the artifact is
   * the extracted program, because that is what the instrument is handed, while the
   * ensemble is asked about the answer the model actually gave. Judging the extraction
   * would hide the reasoning and would also cost the judge its own code detection, so
   * the run would score a code candidate as prose.
   */
  readonly answer: string;
  /** A THOUGHT node's marker-line request, still unanswered. Always null for an agent
   *  node, which was answered by the tool while it ran. */
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
  /** The branch an AGENT node was granted while it ran, carried onto its tree node so
   *  selection can expand it when it reaches it. */
  readonly granted: BranchGrant | null;
  /** What an agent node concluded, for a `fresh` child's seed — see *Inherited context*.
   *  Null for a thought node, whose conclusion IS its artifact. */
  readonly conclusion: string | null;
  /** The conversation a `fork` child of this node inherits. Empty for a thought node. */
  readonly transcript: readonly ModelMessage[];
  readonly usage: Usage;
  /** Reported per call by a thought node and per node by an agent node, so this is
   *  null exactly where the model call was already reported elsewhere. */
  readonly modelId: string | null;
}

/**
 * ONE NODE'S ANSWER AT A LEVEL BARRIER.
 *
 * A rejection is CLASSIFIED where it is caught rather than carried out as `unknown`: a
 * thrown non-`Error` is a link in the chain rather than something every reader has to
 * re-narrow, and the barrier is the boundary where a promise's reason stops being a
 * language value and becomes this run's failure.
 *
 * There were three arms. The third was `silent` — a member the barrier gave up on after
 * {@link TURN_WALL_CLOCK_ENVELOPE_MS} of recording no step — and it is DELETED rather
 * than re-tuned, together with the clock that produced it. The clock was added to end a
 * sixty-three-minute hang and it did, but it was never a measured quantity: reusing a
 * measured constant does not measure a DIFFERENT thing, and a level barrier's patience
 * and one turn's wall clock are not the same thing. Its first live outing gave up on
 * three nodes at 600,002 / 600,028 / 600,029 ms and reported "a provider or transport
 * that is not answering" — while that provider answered a direct request in 1.5 s. It
 * was wrong about the cause, which is worse than slack: an unwarranted bound
 * manufactures false diagnoses.
 *
 * What replaces it is not another bound. A node now runs on the shared turn
 * loop until it finishes, the caller cancels it, the mission governor refuses a
 * step, or a provider or tool fails definitively. The barrier awaits that
 * settled outcome and never diagnoses elapsed silence. It MUST NOT run a clock
 * here, because a node that can background work legitimately records nothing
 * while it awaits a wake: a node waiting an hour is healthy, and no elapsed-time
 * instrument can tell that from one that never began.
 */
export type NodeAnswer =
  | { readonly kind: 'expanded'; readonly expansion: Expansion }
  | { readonly kind: 'failed'; readonly error: KinuError };

/** One member of a level as the barrier waits on it: the node's own run, and its id. */
export interface LevelMember {
  readonly id: string;
  readonly node: Promise<Expansion>;
}

/** What one member of a level came to, named against its id so the caller can settle
 *  and report the member it belongs to. */
export interface LevelAnswer {
  readonly id: string;
  readonly answer: NodeAnswer;
}

/**
 * THE LEVEL BARRIER — every member answers or fails, and the barrier returns either way.
 *
 * It is `Promise.all` over classified members and not `allSettled`, because the
 * classification is the point: a rejection becomes this run's failure, named
 * against its node. Nothing here bounds a member's time. A member settles when
 * its turn completes, the caller cancels it, or a provider or tool fails
 * definitively; otherwise this barrier remains pending.
 */
export async function awaitLevel(members: readonly LevelMember[]): Promise<readonly LevelAnswer[]> {
  return Promise.all(members.map(async (member): Promise<LevelAnswer> => {
    try {
      return { id: member.id, answer: { kind: 'expanded', expansion: await member.node } };
    } catch (cause) {
      return {
        id: member.id,
        answer: {
          kind: 'failed',
          error: toKinuError({
            doing: `expand node ${member.id} of this level`, cause, otherwise: 'unavailable',
          }),
        },
      };
    }
  }));
}

/**
 * The `advance` axis as the scheduler's policy.
 *
 * `archive` IS `none`'s one expansion step, and that is not a substituted scheduler —
 * which would be the accepted-and-ignored defect in its worst form. `archiveRegionRefusal`
 * pins an archive run to depth 1, so there is exactly ONE expansion, off the root, and
 * every policy in this table agrees about it: there is no second level for a frontier
 * order to disagree over. What makes `archive` a different axis value from `none` is not
 * a selection rule but the two things it does that `none` cannot — it BINS its candidates
 * by a witnessed descriptor and it REFUSES the ones that duplicate a cell's occupants —
 * and both happen at the settle barrier, where `advance:'none'` has neither a key nor a
 * rejection test to apply.
 *
 * `pareto` stays null: `regionRefusal` refuses it for a cause that is about the
 * measurement rather than the schedule, and returning `'none'` for it would run a flat
 * wave and call the winner a front.
 */
export function frontierPolicyOf(advance: SwarmAdvance): FrontierPolicy | null {
  switch (advance) {
    case 'uct':
    case 'best-first':
    case 'none':
      return advance;
    case 'archive':
      return 'none';
    case 'pareto':
      return null;
  }
}

/**
 * The workspace as found, at the path the instrument reads, or null when there is no
 * text there.
 *
 * Absence is CHECKED rather than caught: a `sample` run legitimately starts from
 * nothing, while a read that fails for any other reason is a broken instrument and
 * must not be flattened into "empty". The bytes are parsed at this boundary — a VFS
 * read is declared over text OR bytes, and a node's inherited context is text, so the
 * one place that difference is decided is here.
 */
export async function readArtifact(ctx: MeasurementContext, path: string): Promise<string | null> {
  if (!await ctx.vfs.exists(path)) return null;
  const text = v.safeParse(v.string(), await ctx.vfs.readFile(path, { encoding: 'utf8' }));
  return text.success ? text.output : null;
}

/** This node's path, root-first and inclusive of the node itself. Cycle-guarded, like
 *  every other ancestry walk here: a tree that somehow closed a loop must not hang the
 *  run it is describing. */
export function pathTo(nodes: ReadonlyMap<string, TreeNode>, node: TreeNode): TreeNode[] {
  const path: TreeNode[] = [];
  const seen = new Set<string>();
  let current: TreeNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? undefined : nodes.get(current.parentId);
  }
  return path;
}

/**
 * Disclose a verdict — the one place a THOUGHT node's proposal is answered.
 *
 * It goes to the diagnostics stream and nowhere else, and for a toolless node that is
 * forced rather than chosen: by the time the engine can answer, the node has already
 * finished its one call and there is no channel back to it. *Arbitration* requires the
 * answer to exist and states where it lands when the asker cannot receive it; this is
 * that place, with a stable dotted name so the refusals are queryable rather than merely
 * printed. An AGENT node is answered by `propose_branch`'s return value instead, and
 * the engine still logs the accepted verdict so both kinds of node leave the same
 * trail in the stream.
 */
export function reportVerdict(log: Logger, input: {
  readonly verdict: BranchVerdict;
  readonly preset: SwarmPreset;
  readonly nodeId: string;
  readonly atDepth: number;
  readonly policy: BranchRefusalPolicy | null;
}): void {
  if (input.verdict.kind === 'accepted') {
    log.event('swarm.branch_accepted', {
      preset: input.preset, node: input.nodeId, depth: input.atDepth,
      children: input.verdict.nodeIds.length,
    });
    return;
  }
  log.event('swarm.branch_refused', {
    preset: input.preset, node: input.nodeId, depth: input.atDepth,
    // The token as well as the prose: the prose is for the node, the token is what
    // makes "none of the five is unreachable" checkable on the shipped engine.
    policy: input.policy ?? '',
    reason: input.verdict.reason,
    error: input.verdict.error,
  });
}

/**
 * Answer one THOUGHT node's branch proposal, or return null when it made none.
 *
 * The arbiter itself is `arbitrateBranch` in `swarm.ts` — pure, total, and a port of
 * the proven one. This is the engine half: it supplies the two facts the node is not
 * allowed to supply (its own depth, read from the row this engine wrote, and the
 * budget that remains), DEBITS an accepted grant, and discloses the answer.
 *
 * The budget is asked rather than passed, because conservation is the budget's own
 * invariant and a caller that read the number first and handed it in could not hold
 * it (*Budget conservation*, and `swarm-budget.ts`'s header).
 */
export function answerProposal(input: {
  readonly log: Logger;
  readonly node: TreeNode;
  readonly resolved: ResolvedSwarm;
  readonly budget: SwarmBudget;
}): BranchDecision | null {
  const { node, resolved } = input;
  const proposal = node.proposal;
  if (!proposal) return null;
  const decision = input.budget.arbitrate({
    config: resolved.config,
    caps: resolved.caps,
    atDepth: node.depth,
    proposal,
  });
  if (decision.kind === 'refused') {
    reportVerdict(input.log, {
      verdict: { kind: 'refused', reason: 'denied', error: decision.error },
      preset: resolved.preset, nodeId: node.id, atDepth: node.depth,
      policy: decision.policy,
    });
  }
  return decision;
}
