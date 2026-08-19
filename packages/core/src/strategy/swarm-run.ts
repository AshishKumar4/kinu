/**
 * Running a resolved swarm: select, expand, measure, backpropagate, settle — and
 * refusing, by name, the resolved shapes no engine in this tree can execute
 * faithfully.
 *
 * WHAT RUNS HERE, AND WHY IT IS EXACTLY THIS. A resolved configuration is a search
 * TREE bounded by `depth` and widened by `branches`, and every axis it names is
 * realised rather than approximated:
 *
 *   - `branches` candidates per expansion. What ONE candidate costs is the `unit`
 *     axis: `answer` and `generator` run a real agent per node — a tool loop with
 *     its own turns and its own journalled transcript (`node-agent.ts`, §8.1) —
 *     while `thought` is §8.9's degenerate point, one toolless generation, kept as
 *     the cheap tier. `expand:'sample'` starts a child from the workspace as
 *     found and `expand:'aggregate'` merges several parents;
 *   - `advance` through `mcts/frontier.ts` — the ONE scheduler, so `uct` re-widens,
 *     `best-first` takes the best unexpanded node and `none` expands the root once
 *     and stops;
 *   - sibling angles UNCONDITIONALLY: every child is handed its own angle and told
 *     its siblings', because the axis that claimed to gate this never did;
 *   - `context:'fork'` by putting the MEASURED BASELINE and the measurements
 *     along this node's own path into the expansion prompt — at depth 1 the only
 *     ancestor is the workspace as found, which is why that arm is unchanged;
 *   - `score:'verify'` through the registry's instrument, one candidate at a time,
 *     because candidates share one workspace and a parallel measurement would measure
 *     whichever wrote last (§10.3's isolation gap, respected rather than assumed away);
 *   - `settle` derived by `settleOf` and never chosen here.
 *
 * THE OBJECTIVE IS WHAT THE TREE CLIMBS, which is the whole reason this runner has a
 * tree of its own rather than dispatching onto `mcts/engine.ts`. That engine scores by
 * judge ensemble and execution verdict with no seam for a verifier, so a verify-scored
 * call sent to it would report a judge's number under the objective's name — the
 * accepted-and-ignored lie §2.5 exists to refuse. What IS reused is its tree
 * machinery, which is objective-agnostic and proven: `uct.ts` for selection (and its
 * WHERE-clause depth cap), `backpropagation.ts` for the ancestor mean,
 * `record-node.ts` for the one INSERT, `pruning.ts` for retirement. The reward those
 * receive is `normalisedScore` over the caller's own metric.
 *
 * A NODE DOES NOT SPAWN CHILDREN — it PROPOSES, and `advance` arbitrates (§8.2). An
 * AGENT node proposes by calling `propose_branch` and the verdict is that tool's
 * return value, so a refusal's text is the node's next instruction. A THOUGHT node
 * has no tool to be answered through, so its proposal is a marker line the engine
 * reads out of its text and its verdict is a typed diagnostic event; that path is
 * answered when selection REACHES the node, which is what makes it an input to
 * selection rather than a bypass of it, and any proposal selection never reached is
 * answered in the sweep after the loop. Both forms carry the same data and neither
 * is ever dropped silently — a node that cannot tell refusal from being ignored will
 * simply propose again.
 *
 * THE BUDGET IS CONSERVED AND NOT MERELY CAPPED, and that is new here because
 * arbitration moved. A thought node's proposal was answered in this loop, one node
 * at a time, so reading the remaining budget and spending it could not interleave.
 * An agent node asks from inside its own tool loop and N of those run concurrently,
 * so `SwarmBudget` owns the number and decides-and-debits in one synchronous step
 * (§8.11: the allocations granted to a node's children must SUM to no more than the
 * parent's remaining budget). Depth and width bound the shape; conservation bounds
 * the spend.
 *
 * WHAT THE ISOLATION PROOF COVERS, AND WHAT IT NO LONGER COVERS.
 * `MCTS/StorageIsolation.lean` holds of TOOLLESS branches: its two branch-side
 * actions carry a frame condition forbidding a branch from introducing a storage
 * identity no existing branch holds. `Exploration/Isolation.lean`'s
 * `agent_node_is_not_a_branch_explore` proves the complementary fact, and it is the
 * one that matters now: the theorem DOES NOT REACH a node that acquires its own
 * storage. So `unit:'thought'` is still inside the proof — one `generateText` call
 * whose entire output is text, `AcquiresOwnStorage` false, branch set empty,
 * `init_isolated` sufficient — and an AGENT node is NOT, because it holds a shell.
 * That obligation is named rather than assumed away, and what bounds it today is
 * `nodeWorkspace`: every agent node reports `isolation:'shared-origin-plane'`, which
 * is to say the search creates no per-node storage at all and therefore still adds
 * no branch storage — the workspace is the ORIGIN's, one plane, exactly as before.
 * What that costs is attribution, and the engine pays it the only honest way: a node
 * is graded on the candidate it REPORTS, never on a diff of a tree every node wrote.
 * A per-node home (§8.6) is what would need the preservation theorem extended, and
 * it is deliberately not built here.
 */
import { generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import * as v from 'valibot';
import { DEFAULT_CONFIG, DEFAULT_MAX_STEPS } from '../config';
import { diversityAngle, siblingAngles } from '../mcts/diversity';
import { explorePrompt, type ExplorePrompt } from '../mcts/explore-prompt';
import { initSearchTables } from '../mcts/schemas';
import { insertSearchNode } from '../mcts/record-node';
import { backpropagate } from '../mcts/backpropagation';
import { pruneLowValueBranches } from '../mcts/pruning';
import { selectFrontierNode, type FrontierPolicy } from '../mcts/frontier';
import { readProposalCode } from '../execution/code-fence';
import { extractJsonObject } from '../prompts/structured';
import { diagnostics, type Logger } from '../obs/index';
import { ProteusError, refusalOf, type Refusal } from '../obs/error';
import { renderIssues } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { normalizeUsage, usageTotal, type Usage, addUsage } from '../usage';
import { estimateTokens } from '../llm';
import { contextWindowForModel } from '../context-window';
import { HeadJournal } from '../heads/journal';
import { initHeadsTables } from '../heads/schema';
import { runNodeAgent } from './node-agent';
import type { NodeAgentDeps } from './node-agent';
import { SwarmBudget, type BranchDecision, type BranchGrant } from './swarm-budget';
import { sha256Hex } from '../safety/argument-digest';
import type { NodeWorkspaceProvisioner } from './node-workspace';
import type { SerializedMessage } from '../heads/types';
import type { MissionScope } from '../mission-budget';
import type { WebSearchProvider } from '../web/index';
import { resolveVerifier, type ResolvedVerifier } from './verifier-registry';
import {
  carrySuppression, floorMargin, isBetter, normalisedScore, PUBLISHING_CARRIES,
} from './objective';
import type {
  Floor, FloorBreach, MeasuredValue, Measurement, MeasurementContext, Objective,
  ObjectiveDirection, ObjectiveScale, PublicationState, PublishingCarry, VerifierSource,
} from './objective';
import {
  isTreeAdvance, BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS, SWARM_TREE_ADVANCES,
} from './swarm';
import type {
  BranchContext, BranchProposal, BranchRefusalPolicy, BranchVerdict,
  ResolvedSwarm, SwarmAdvance, SwarmCandidate, SwarmPreset, SwarmResult, SwarmSettleReport,
} from './swarm';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSink } from '../events/model-call';
import type { WorkMode } from '../prompting/surface';

/** What a run needs that a resolved call does not carry: a model to expand with, and
 *  a workspace to measure in. */
export interface SwarmRunDeps {
  readonly rt: AgentRuntime;
  readonly model: LanguageModel;
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
  /** Where this run's model calls are reported. Absent = unreported, which the spend
   *  coverage fraction states rather than hides. */
  readonly reportModelCall?: ModelCallSink;
  /**
   * Where this run's diagnostics land. Defaults to the process logger.
   *
   * Injected for the reason `builtins.ts` states about its own: a branch verdict is
   * reported HERE and nowhere else — a toolless node has already finished its turn
   * and cannot receive one — so this stream is the only place a refused proposal can
   * be observed, and an instrument nobody asserts on is one nobody notices has
   * stopped.
   */
  readonly logger?: Logger;
  /**
   * The step envelope one agent node runs to. Defaults to the shipped turn
   * envelope, because a node is the origin running on the same workspace and gets
   * the same room — the same argument `HeadInferenceDeps.maxSteps` records for a
   * fork. Ignored entirely by `unit:'thought'`, which has one step by construction.
   */
  readonly maxSteps?: number;
  /** The mission ledger an agent node's steps charge, when the run has one. */
  readonly mission?: MissionScope;
  /**
   * The origin agent's own conversation, which is what a swarm's ROOT starts from.
   *
   * §8.4: *"a root that started blank would throw away precisely the context that made
   * the caller decide to search"*. This is the caller-to-root edge, and it is the same
   * axis as every branch edge — `context:'fork'` gives the first level this prefix
   * verbatim, `'fresh'` gives it the task block and the seed alone.
   *
   * Absent means the caller wired none, and then the first level starts from the task
   * block. Absent rather than empty-and-claimed: a run whose root inherited nothing is
   * a different run from one whose caller had nothing to inherit.
   */
  readonly originContext?: readonly ModelMessage[];
  /** §8.6's per-node home provisioner. Absent until the substrate lands, and then
   *  every node reports `shared-origin-plane` rather than pretending otherwise. */
  readonly provisionHome?: NodeWorkspaceProvisioner;
  /** Backend-built `execute_tools` and live research, handed to every agent node.
   *  Absent means the node's surface is narrower, not broken. */
  readonly executeTool?: unknown;
  readonly webSearch?: WebSearchProvider;
  /**
   * §8.4's compaction barrier: rewrite one parent's context ONCE, for every child
   * of that parent to share.
   *
   * A SEAM and not an implementation, for §6.4's first reason. `packages/compaction`
   * is *"the @better-compact ladder that actually rewrites history"* and core does
   * not depend on it, so a summariser written here would be a second ladder that
   * drifts from the real one. What the engine owns is the POLICY — the ~85%
   * threshold, and firing once per branch point so the shared view cannot become
   * part of what siblings are ranked on — and that policy is testable without a
   * summariser. Absent means no compaction: a parent past its window inherits
   * verbatim and the provider refuses, which is a loud failure rather than a silent
   * paraphrase of the objective.
   */
  readonly compactShared?: (
    messages: readonly ModelMessage[],
  ) => Promise<readonly ModelMessage[]>;
}

/** The scalar half of an objective — the metric, direction, scale, target, floor and
 *  instrument a measured run needs. A `witness` hunt supplies its `proxy`'s, which is
 *  §2.4(c)'s rule that the proxy is what the search optimises. */
interface MeasuredObjective {
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  readonly target: number;
  readonly verify: VerifierSource;
  readonly floor: Floor | undefined;
  /** The witness predicate, when this run is a bounded hunt with a proxy. Evaluated
   *  as a SIDE CONDITION on every candidate, never as the thing being optimised. */
  readonly witness: VerifierSource | null;
}

function measuredHalf(objective: Objective): MeasuredObjective | null {
  if (objective.kind === 'witness') {
    if (!objective.proxy) return null;
    const proxy = measuredHalf(objective.proxy);
    return proxy && { ...proxy, witness: objective.check };
  }
  if (objective.kind === 'vector') return null;
  return {
    metric: objective.metric,
    unit: objective.unit,
    direction: objective.direction,
    scale: objective.scale,
    target: objective.target,
    verify: objective.verify,
    floor: objective.floor,
    witness: null,
  };
}

function unsupported(error: string): Refusal {
  return refusalOf(new ProteusError('unsupported', error));
}

function unavailable(error: string): Refusal {
  return refusalOf(new ProteusError('unavailable', error));
}

function badInput(error: string): Refusal {
  return refusalOf(new ProteusError('bad_input', error));
}

/**
 * Whether this tree can execute the resolved shape, or the refusal naming what it
 * would have needed.
 *
 * Every arm names the one thing that is missing and the one move that fixes it, per
 * §7.2: a refusal offering two remedies was measured being corrected to the wrong one.
 */
function regionRefusal(resolved: ResolvedSwarm): Refusal | null {
  const { config, caps } = resolved;
  const depth = caps.depth;
  if (!depth) {
    return badInput('neither this call nor its base states `depth`, so nothing says how deep the '
      + 'search may go — and no default exists to inherit, because a composition with no `from` has '
      + 'no preset row behind it. Pass `depth`, or name a base with `from`.');
  }
  if (!caps.branches) {
    return badInput('neither this call nor its base states `branches`, so nothing says how many '
      + 'candidates an expansion produces. Pass `branches`, or name a base with `from`.');
  }
  // NO `unit` ARM REFUSES ANY MORE, and the absence is the ticket. `trajectory` was
  // refused here because a tool-using node shares one workspace with its siblings and
  // so cannot be graded on what it changed — the measured `agent-trajectory-search`
  // region scored 18% because the design blocked the composition and nothing on the
  // surface said so. The blocker was real and it was mis-sited: it bounds the GRADING
  // SIGNAL, not the tool surface. A node now holds tools and is graded on what it
  // REPORTS (`node-agent.ts`), the value that named the shape is gone because the
  // shape is what `answer` and `generator` now are, and `thought` is §8.9's
  // degenerate point kept as the cheap tier. All three execute below.
  if (config.expand === 'aggregate') {
    return unsupported('expand:"aggregate" builds a DAG whose merges are ordered by dependency, and '
      + 'nothing here orders merges. Use expand:"sample" for independent candidates, and `context` to '
      + "say whether a child starts from its parent's conversation or from its results alone.");
  }
  if (config.score.kind !== 'verify' && config.score.kind !== 'none') {
    return unsupported(`score:"${config.score.kind}" needs a scorer this run has no engine for: judge `
      + 'needs the marginalised ensemble the shipped tree owns. Use score:"verify" with an `objective` '
      + 'to measure candidates, or score:"none" for a flat run that returns them unranked.');
  }
  if (isTreeAdvance(config.advance.kind) && config.score.kind === 'none') {
    // Unreachable through `swarmValidity`, which refuses this composition outright.
    // Kept because this function is also the in-process entry point.
    return badInput(`advance:"${config.advance.kind}" cannot select without a score.`);
  }
  if (config.advance.kind !== 'none' && !isTreeAdvance(config.advance.kind)) {
    return unsupported(`advance:"${config.advance.kind}" reports a front or an archive, and both need a `
      + 'store this run has no writer for. Use advance:"none" for a flat expansion, or one of '
      + `${SWARM_TREE_ADVANCES.join('/')} to select down a tree.`);
  }
  return null;
}

/** The workspace, as an instrument sees it. §3.2's two members and no others: no
 *  model, no network, no trajectory. */
function measurementContext(rt: AgentRuntime): MeasurementContext | null {
  const shell = rt.shell;
  if (!shell) return null;
  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** The measured baseline this instrument reported alongside a candidate, or null when
 *  the kind measures none. §2.3: measured, never asserted. */
function baselineOf(measurement: Measurement, key: string | null): number | null {
  if (!key) return null;
  const reported = measurement.measured?.[key];
  return reported !== undefined && Number.isFinite(reported) ? reported : null;
}

/** Whether `value` sits on the side of the floor no correct candidate can reach.
 *  Named because the comparison INVERTS with the direction, and getting it backwards
 *  turns the fraud check into a fraud. */
function breaches(floor: Floor, direction: ObjectiveDirection, value: number): boolean {
  return direction === 'minimise' ? value < floor.value : value > floor.value;
}

/**
 * One node of the search, as the run holds it.
 *
 * The SQL row beside it (`search_nodes`) holds the SELECTION state — visits, the
 * backpropagated mean, the depth, the status — and this holds the CONTENT. They are
 * different facts about the same node rather than two copies of one: selection reads
 * a running mean over a subtree, while an expansion prompt and the settle report need
 * the answer itself and the measurement it earned.
 */
interface TreeNode {
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
   * What this node CONCLUDED, in its own words — the report a `fresh` child is
   * seeded with (§8.4). Null for the root, which reported nothing because no model
   * wrote it, and for a `thought` node, whose whole output IS its artifact.
   */
  readonly conclusion: string | null;
  /**
   * The conversation a `fork` child of this node inherits: what this node itself
   * inherited, plus what it produced. Append-only, so every sibling of one parent
   * shares one byte-identical cacheable prefix (§8.4).
   *
   * Empty for a thought node, which has no conversation to hand down, and for the
   * root, whose children start from the origin's own framing.
   */
  readonly transcript: readonly ModelMessage[];
  /**
   * The compacted view of {@link transcript}, once this node has crossed the window
   * threshold and the barrier has run.
   *
   * Held on the PARENT and not on each child, which is the whole point of §8.4's
   * once-per-branch-point rule: a shared view cannot vary across the siblings it is
   * compared over, so no part of the ranking is a fact about which sibling's
   * compaction kept the useful paragraph.
   */
  compacted: readonly ModelMessage[] | null;
}

/** The marker a node ends its answer with to request a branch. A line rather than a
 *  fence so the answer's own code fences cannot be mistaken for it. */
const PROPOSAL_MARKER = 'PROPOSE-BRANCH';

/**
 * §8.2's proposal, at the one boundary it crosses.
 *
 * `strictObject`, so a node that invents a field is told rather than silently having
 * it dropped — the same discipline the verifier registry applies to `spec`. Notably
 * ABSENT: any depth field. A node never states its own depth (§8.3), so the request
 * carries no number the engine would have to distrust.
 */
const BranchProposalSchema = v.strictObject({
  rationale: v.string(),
  branches: v.array(v.strictObject({
    task: v.string(),
    rationale: v.string(),
    context: v.picklist(SWARM_CONTEXTS),
  })),
});

/** A node's answer, split from the branch it asked for. */
interface ReadAnswer {
  /** The answer with any proposal block removed: what gets measured. */
  readonly text: string;
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
}

/**
 * Read a node's output: its answer, and the branch it proposed if it proposed one.
 *
 * A malformed proposal is NAMED rather than dropped. The node asked for something and
 * the engine could not read the request, which is neither an acceptance nor one of
 * arbitration's five refusals, and a node told nothing would simply ask again.
 */
function readAnswer(text: string): ReadAnswer {
  const marker = text.indexOf(PROPOSAL_MARKER);
  if (marker < 0) return { text: text.trim(), proposal: null, proposalError: null };
  const answer = text.slice(0, marker).trim();
  const requested = text.slice(marker + PROPOSAL_MARKER.length);
  let json: unknown;
  try {
    json = extractJsonObject(requested);
  } catch (error) {
    return {
      text: answer,
      proposal: null,
      proposalError: `the ${PROPOSAL_MARKER} block carried no readable JSON object, so the branch `
        + `could not be arbitrated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = v.safeParse(BranchProposalSchema, json);
  if (!parsed.success) {
    return {
      text: answer,
      proposal: null,
      proposalError: `the ${PROPOSAL_MARKER} block did not describe a branch proposal, so it could `
        + `not be arbitrated: ${renderIssues(parsed.issues)}`,
    };
  }
  return { text: answer, proposal: parsed.output, proposalError: null };
}

/**
 * The invitation to propose, appended to a THOUGHT node's prompt only where a branch
 * could actually be granted.
 *
 * §8.2's build-time rule, which `head-tools.ts` already applies to `split_subheads`
 * and `node-agent.ts` applies to `propose_branch`: a request that can only ever be
 * refused MUST NOT be offered, because offering it spends a step to learn a limit the
 * surface already knew. So a flat run and a node at the depth cap are never asked.
 * The runtime refusal stays anyway — the budget can empty between the invitation and
 * the answer.
 *
 * A MARKER RATHER THAN A TOOL, because this is the degenerate point: a thought node
 * has no tool call to be answered through, so its request is text the engine reads
 * and its verdict is a typed diagnostic event (§8.2). An agent node gets the tool.
 */
function proposalInvitation(input: {
  readonly advance: ResolvedSwarm['config']['advance'];
  readonly atDepth: number;
  readonly maxDepth: number;
}): string {
  if (!isTreeAdvance(input.advance.kind) || input.atDepth + 1 >= input.maxDepth) return '';
  return `\n\nIf one thread of this task deserves its own branch of the search, end your answer with `
    + `a line reading ${PROPOSAL_MARKER} followed by a JSON object: `
    + `{"rationale": why this thread deserves the budget, "branches": [{"task", "rationale", `
    + `"context"}, ...] (${String(BRANCH_PROPOSAL_WIDTH.min)}-${String(BRANCH_PROPOSAL_WIDTH.max)} `
    + 'narrower sub-questions, each naming what it starts from: "fork" for your own answer as '
    + 'context, "fresh" for its own focus and your conclusion alone)}. '
    + 'You are proposing, not spawning: the search decides, against a budget and a depth cap you '
    + 'cannot see, and you will be told the reason if it refuses. Omit the block entirely if no '
    + 'thread needs one.';
}

/**
 * What a node is told about the measurements on its own path.
 *
 * Gated on `context:'fork'` rather than on the cut `observe:'ancestors'`, which is
 * the same gate: a forked child continues the parent's conversation and so has the
 * ancestor chain's measurements transitively. The axis went; the behaviour did not,
 * and it now hangs off the one axis that was already deciding it.
 */
function pathFeedback(input: {
  readonly context: ResolvedSwarm['config']['context'];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly ancestors: readonly TreeNode[];
}): string {
  const { measured, baseline } = input;
  if (input.context !== 'fork' || !measured || baseline === null) return '';
  const direction = measured.direction === 'minimise' ? 'lower' : 'higher';
  const path = input.ancestors
    .filter((node) => node.measurement?.kind === 'measured')
    .map((node) => `An answer already on this path measured `
      + `${String(node.measurement?.kind === 'measured' ? node.measurement.value : 0)} `
      + `${measured.unit}.`)
    .join(' ');
  return `\n\nThe workspace as found measures ${String(baseline)} ${measured.unit} on `
    + `${measured.metric}. The target is ${String(measured.target)} ${measured.unit}, `
    + `${direction} is better, and only that number is measured. This is the environment's own `
    + `measurement, not an estimate.${path ? ` ${path}` : ''}`;
}

/**
 * The expansion prompt for one child: what it is asked, the angle its siblings do
 * not have, what this path has measured, and the branch it may propose.
 *
 * THE ANGLE IS UNCONDITIONAL. It used to be gated on `decorrelate`, an axis whose
 * three values all handed out angles anyway — including `blind`, which names the
 * opposite — so the gate never selected anything and the axis is gone. What is
 * genuinely lost is the ability to turn angles OFF; what is genuinely missing, and
 * is a separate instrument rather than a fourth value, is a detector that notices
 * siblings converged despite them.
 */
function branchPrompt(input: {
  readonly resolved: ResolvedSwarm;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly index: number;
  readonly branches: number;
  /** What this child is asked. The search's own task, or the sub-question an accepted
   *  proposal named. */
  readonly task: string;
  /** The parent's answer, when this child inherits it. Null at the root, and null
   *  wherever the search or the proposal said not to inherit. */
  readonly inherited: string | null;
  /** Root-first, parent-last. Read only where `context` is `'fork'`. */
  readonly ancestors: readonly TreeNode[];
  readonly atDepth: number;
  readonly maxDepth: number;
  /** Whether to append the marker-line invitation. False for an agent node, which is
   *  invited by `propose_branch` being on its surface instead — two invitations for
   *  one capability would teach the model a protocol the engine does not read. */
  readonly invite: boolean;
}): ExplorePrompt {
  const { resolved, index, branches } = input;
  const { context, advance } = resolved.config;
  const angle = `\n\nYour angle: ${diversityAngle(index, branches)}.`;
  // Keyed off what this child ACTUALLY received rather than off an axis, because a
  // proposal may override inheritance per branch and the instruction has to match
  // the text above it.
  const instruction = input.inherited
    ? ' Improve what you have been given rather than starting over.'
    : ' Write your approach from scratch; do not assume what is already there is a good start.';
  const inherited = input.inherited
    ? `\n\nThe answer this branch continues from:\n${input.inherited}`
    : '';
  const feedback = pathFeedback({
    context, measured: input.measured, baseline: input.baseline, ancestors: input.ancestors,
  });
  return explorePrompt({
    mode: input.mode,
    context: `${input.task}${feedback}${inherited}${angle}${instruction}`
      + (input.invite
        ? proposalInvitation({ advance, atDepth: input.atDepth, maxDepth: input.maxDepth })
        : ''),
    craftedTools: [],
    // Unconditional, like the angle itself: every child is told what its siblings
    // were sent, because the axis that claimed to hide them never did.
    siblings: siblingAngles(index, branches),
    languages: input.languages,
  });
}

/**
 * The share of a model's window at which §8.4's compaction ladder is allowed to run.
 *
 * *"When a node's context reaches roughly 85% of its window, the ladder runs; below
 * that it does not run at all."* Named because it is a CACHING judgement and not a
 * measurement of where quality falls off — the specification says so itself, and a
 * bare `0.85` in an expression would read as the second thing.
 */
const CONTEXT_COMPACTION_THRESHOLD = 0.85;

/**
 * §8.4's BARRIER: the one prefix every child of this parent inherits.
 *
 * Verbatim below the threshold, which is the whole of what `context:'fork'` means and
 * a decision about caching: an unmodified prefix is a prefix a provider can cache, so
 * every sibling of one parent shares one cacheable prefix, and rewriting the history
 * per child would break that prefix for all of them at once.
 *
 * Past the threshold it fires ONCE and the result is cached on the parent, which is
 * the load-bearing half: a search ranks siblings against each other, so if compaction
 * were lossy AND per-child, part of that ranking would be a fact about which sibling's
 * compaction kept the useful paragraph. One shared view per level makes the
 * compaction identical across the comparison, so there is nothing to confound.
 *
 * With no ladder wired the prefix is handed over whole and the absence is REPORTED. A
 * provider refusing an over-long context is a loud failure; a silently paraphrased
 * objective is the §2.4(c) fabrication reached by attrition.
 */

/**
 * The model's own identifier, for the window lookup.
 *
 * PARSED rather than narrowed on a representation: the SDK's `LanguageModel` is a
 * specifier string OR a model object, and the two arms are established here, at the one
 * boundary where the value arrives, instead of every reader branching on its shape.
 * Neither arm is an error — an empty spec resolves to the shipped default window, which
 * is what an unrecognised model already gets.
 */
function modelSpecOf(model: LanguageModel): string {
  const asSpec = v.safeParse(v.string(), model);
  if (asSpec.success) return asSpec.output;
  const asModel = v.safeParse(v.object({ modelId: v.string() }), model);
  return asModel.success ? asModel.output.modelId : '';
}

/** §8.4's BARRIER: the one prefix every child of this parent inherits, verbatim below
 *  the threshold and compacted ONCE above it. See the note above `modelSpecOf`. */
async function sharedPrefix(input: {
  readonly parent: TreeNode;
  readonly deps: SwarmRunDeps;
  readonly log: Logger;
  readonly preset: SwarmPreset;
}): Promise<readonly ModelMessage[]> {
  const { parent, deps } = input;
  if (parent.compacted) return parent.compacted;
  if (parent.transcript.length === 0) return parent.transcript;
  const chars = parent.transcript.reduce(
    (total, message) => total + JSON.stringify(message.content).length, 0,
  );
  const room = contextWindowForModel(modelSpecOf(deps.model)) * CONTEXT_COMPACTION_THRESHOLD;
  if (estimateTokens(chars) < room) return parent.transcript;
  if (!deps.compactShared) {
    input.log.event('swarm.compaction_absent', {
      preset: input.preset, node: parent.id, depth: parent.depth,
      estimated_tokens: estimateTokens(chars), threshold: Math.round(room),
    });
    return parent.transcript;
  }
  const shared = await deps.compactShared(parent.transcript);
  parent.compacted = shared;
  input.log.event('swarm.context_compacted', {
    preset: input.preset, node: parent.id, depth: parent.depth,
    before: parent.transcript.length, after: shared.length,
  });
  return shared;
}

/**
 * §8.4's SEED, assembled by the engine and never authored by the parent.
 *
 * *"A parent that writes its own child's seed can launder a claim about its own value:
 * it would be supplying, one hop removed, the number its child is told to beat."* So
 * the parent authors its report and this turns that report plus its EARNED outcome
 * into a seed.
 *
 * Both context values get this. The difference between them is the conversation in
 * front of it and nothing else, which is what makes them two values of one axis.
 *
 * A field nobody computed is ABSENT rather than zero or "unknown" — an outcome exists
 * here only where the instrument produced one.
 */
function branchSeed(input: {
  readonly parent: TreeNode;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly verifier: ResolvedVerifier | null;
  readonly atDepth: number;
  readonly maxDepth: number;
  readonly focus: string;
  readonly context: BranchContext;
}): ModelMessage {
  const { parent, measured } = input;
  const parts: string[] = [];
  if (parent.conclusion) {
    parts.push(`What the node you continue from concluded:\n${parent.conclusion}`);
  }
  if (input.verifier && parent.artifact !== null) {
    // The PATH and a digest of the bytes, so the child reads the artifact rather than
    // being told about it in prose — prose about code is a lossy copy of code.
    parts.push(`Its candidate is at ${input.verifier.artifact} `
      + `(digest ${sha256Hex(parent.artifact, 12)}). Read it rather than reconstructing it.`);
  }
  if (measured && parent.measurement?.kind === 'measured') {
    parts.push(`That candidate measured ${String(parent.measurement.value)} ${measured.unit} on `
      + `${measured.metric}, against a target of ${String(measured.target)}. That is what you have `
      + 'to beat.');
  }
  parts.push(`You are at depth ${String(input.atDepth)} of ${String(input.maxDepth)}, so scope your `
    + 'work to what can finish here.');
  parts.push(`Your focus:\n${input.focus}`);
  return {
    role: 'user',
    content: parts.join('\n\n'),
  };
}

/**
 * The inherited prefix as the journal records it.
 *
 * The journal's `inheritedContext` is `SerializedMessage`, which is what a fork's
 * durable history is written as; a node's prefix is `ModelMessage`. One projection
 * here rather than a second serialised shape beside it, and content that is not a
 * plain string is rendered by the codec that already writes it — a node's prefix
 * carries tool traffic, and a JSON blob in a role-tagged row is what the read model
 * already expects.
 */
function inheritedAsSerialized(prefix: readonly ModelMessage[]): SerializedMessage[] {
  return prefix.map((message, index) => ({
    id: `p${String(index)}`,
    role: message.role,
    // A structural check rather than a `typeof`: the SDK's content is a string or a part
    // ARRAY, and the array arm is the one a node's prefix actually carries.
    content: Array.isArray(message.content)
      ? JSON.stringify(message.content)
      : message.content,
    createdAt: index,
  }));
}

/**
 * One expanded child, before it is measured.
 *
 * Its spend IS here now, unlike the flat version's unused per-child copy: an agent
 * node's usage comes off its own report rather than off one `generateText` call, so
 * the run reads it back per child instead of accumulating inside the generation.
 */
interface Expansion {
  readonly id: string;
  /** What the instrument will measure: the reported candidate for an agent node, the
   *  answer text for a thought node. */
  readonly artifact: string;
  /** A THOUGHT node's marker-line request, still unanswered. Always null for an agent
   *  node, which was answered by the tool while it ran. */
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
  /** The branch an AGENT node was granted while it ran, carried onto its tree node so
   *  selection can expand it when it reaches it. */
  readonly granted: BranchGrant | null;
  /** What an agent node concluded, for a `fresh` child's seed (§8.4). Null for a
   *  thought node, whose conclusion IS its artifact. */
  readonly conclusion: string | null;
  /** The conversation a `fork` child of this node inherits. Empty for a thought node. */
  readonly transcript: readonly ModelMessage[];
  readonly usage: Usage;
  /** Reported per call by a thought node and per node by an agent node, so this is
   *  null exactly where the model call was already reported elsewhere. */
  readonly modelId: string | null;
}

/**
 * The `advance` axis as the scheduler's policy.
 *
 * Total over the values that reach a run, and null for the two that cannot:
 * `regionRefusal` refuses `archive` and `pareto` before anything is selected, because
 * both report a store this runner has no writer for. Null rather than a substituted
 * policy — a run given a scheduler its caller did not ask for is the
 * accepted-and-ignored defect in its worst form.
 */
function frontierPolicyOf(advance: SwarmAdvance): FrontierPolicy | null {
  switch (advance) {
    case 'uct':
    case 'best-first':
    case 'none':
      return advance;
    case 'archive':
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
async function readArtifact(ctx: MeasurementContext, path: string): Promise<string | null> {
  if (!await ctx.vfs.exists(path)) return null;
  const text = v.safeParse(v.string(), await ctx.vfs.readFile(path, { encoding: 'utf8' }));
  return text.success ? text.output : null;
}

/** This node's path, root-first and inclusive of the node itself. Cycle-guarded, like
 *  every other ancestry walk here: a tree that somehow closed a loop must not hang the
 *  run it is describing. */
function pathTo(nodes: ReadonlyMap<string, TreeNode>, node: TreeNode): TreeNode[] {
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
 * finished its one call and there is no channel back to it. §8.2 requires the answer
 * to exist and states where it lands when the asker cannot receive it; this is that
 * place, with a stable dotted name so the refusals are queryable rather than merely
 * printed. An AGENT node is answered by `propose_branch`'s return value instead, and
 * the engine still logs the accepted verdict so both kinds of node leave the same
 * trail in the stream.
 */
function reportVerdict(log: Logger, input: {
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
 * it (§8.11, and `swarm-budget.ts`'s header).
 */
function answerProposal(input: {
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

/** What measuring one child produced, and what the tree must do about it. */
type ChildOutcome =
  | { readonly kind: 'instrument-faulted'; readonly error: string }
  | { readonly kind: 'unmeasurable'; readonly detail: string }
  | {
    readonly kind: 'sealed';
    readonly measurement: MeasuredValue;
    readonly breach: FloorBreach;
  }
  | {
    readonly kind: 'scored';
    readonly measurement: MeasuredValue;
    /** Null where the objective's own range admits no score for this value. */
    readonly score: number | null;
  };

/**
 * Measure one child: write it to the path the instrument reads, run the instrument,
 * and classify what came back.
 *
 * Sequential by construction — every candidate is written to the SAME path, so a
 * parallel measurement would measure whichever wrote last. That is §10.3's isolation
 * gap respected rather than assumed away, and it is also why a node needs no storage
 * of its own: the engine places the answer, the engine measures it.
 */
async function measureChild(input: {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
  readonly measured: MeasuredObjective;
  readonly baseline: number;
  readonly artifact: string;
}): Promise<ChildOutcome> {
  const { ctx, verifier, measured, baseline } = input;
  await ctx.vfs.writeFile(verifier.artifact, input.artifact);
  let measurement: Measurement;
  try {
    measurement = await verifier.verify(ctx);
  } catch (error) {
    return {
      kind: 'instrument-faulted',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (measurement.kind === 'unmeasurable') {
    return { kind: 'unmeasurable', detail: measurement.detail };
  }
  if (measured.floor && breaches(measured.floor, measured.direction, measurement.value)) {
    return {
      kind: 'sealed',
      measurement,
      breach: {
        floor: measured.floor,
        // Retained in FULL: a discarded measurement cannot adjudicate H1 against H2.
        measured: measurement,
        margin: floorMargin(measured.floor, measured.direction),
        // Fixed at exactly two because exactly two fit, and they demand opposite
        // responses. The pair is data, not prose.
        hypotheses: ['floor_wrong', 'verifier_gameable'],
      },
    };
  }
  return {
    kind: 'scored',
    measurement,
    score: normalisedScore({
      value: measurement.value, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    }),
  };
}

/**
 * Run a resolved swarm, or refuse.
 *
 * The refusals are ordered by what they cost: shape first (free), then the caps, then
 * the instrument, then the BASELINE — because §2.3's measurement is the first thing
 * that spends anything, and a run that will not start must not spend it.
 */
export async function runSwarm(
  deps: SwarmRunDeps,
  resolved: ResolvedSwarm,
): Promise<SwarmResult | Refusal> {
  const started = Date.now();
  const region = regionRefusal(resolved);
  if (region) return region;
  // All three checked by `regionRefusal`; read here so the types are narrowed once.
  const branches = resolved.caps.branches?.value ?? 0;
  const maxDepth = resolved.caps.depth?.value ?? 0;
  const measures = resolved.config.score.kind === 'verify';
  const log = deps.logger ?? diagnostics;

  let measured: MeasuredObjective | null = null;
  let verifier: ResolvedVerifier | null = null;
  let ctx: MeasurementContext | null = null;
  let baseline: number | null = null;
  let publication: PublicationState = { kind: 'open' };

  if (measures) {
    const objective = resolved.objective;
    if (!objective) return badInput('score:"verify" with no `objective` measures nothing.');
    measured = measuredHalf(objective);
    if (!measured) {
      return unsupported(`an objective of kind "${objective.kind}" is measured per component or per `
        + 'instance, and this run settles one answer against one number. Use kind:"scalar", or '
        + 'kind:"witness" with a scalar `proxy`.');
    }
    if (!('kind' in measured.verify)) {
      // The closure arm is legal for in-process callers and unusable HERE, for a
      // reason that is not about publishability: a closure declares no path a
      // candidate belongs at, so a runner holding one could only measure the
      // workspace as found and report it as a candidate's score. Registering the kind
      // is what supplies that path — and it is also what gives §3.4 a name that can
      // fail to resolve.
      return unsupported('this objective supplies `verify` as a closure, which names no path a '
        + 'candidate is written to, so this run cannot place one for it to measure. Register a '
        + 'verifier kind and pass verify as {kind, spec}.');
    }
    const resolvedVerifier = resolveVerifier(measured.verify);
    if ('reason' in resolvedVerifier) return resolvedVerifier;
    verifier = resolvedVerifier;
    ctx = measurementContext(deps.rt);
    if (!ctx) {
      return unavailable('this workspace has no shell, so nothing can run a measurement in it — a '
        + 'verifier is given a filesystem and a shell and this actor was wired neither. The call is '
        + 'well-formed; the instrument is absent.');
    }
    // §2.3: the baseline is measured on the workspace AS FOUND, before any candidate
    // exists. A fault here MUST NOT start the run — there is nothing to normalise
    // against and nothing to compare to.
    let asFound: Measurement;
    try {
      asFound = await verifier.verify(ctx);
    } catch (error) {
      return unavailable(`the baseline measurement faulted, so this run cannot start: `
        + `${error instanceof Error ? error.message : String(error)}. That is the instrument `
        + 'breaking rather than a candidate failing, and it fails the run by design.');
    }
    baseline = baselineOf(asFound, verifier.baselineKey)
      ?? (asFound.kind === 'measured' ? asFound.value : null);
    if (baseline === null) {
      return unavailable('the baseline measurement produced no number, so there is nothing to '
        + `normalise against: ${asFound.detail}`);
    }
    // §4.5 C2 — the run's own first measurement refutes the floor.
    if (measured.floor && breaches(measured.floor, measured.direction, baseline)) {
      return badInput(`the workspace as found already measures ${String(baseline)} `
        + `${measured.unit}, past a floor of ${String(measured.floor.value)} that no correct `
        + 'solution may cross. The floor is refuted by the run\'s own baseline before any candidate '
        + `exists. Re-derive the bound: ${measured.floor.proof}`);
    }
    // §2.3 — a target at or beyond the measured baseline leaves no range to score on.
    if (normalisedScore({
      value: baseline, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    }) === null) {
      return badInput(`the target of ${String(measured.target)} ${measured.unit} is already met by `
        + `the workspace as found, which measures ${String(baseline)}. Every candidate would `
        + 'saturate at 1.0 and the search would have no gradient — the baseline is measured rather '
        + `than declared, so raise the target past ${String(baseline)}.`);
    }
    log.event('swarm.baseline_measured', {
      preset: resolved.preset,
      metric: measured.metric,
      baseline,
      target: measured.target,
      kind: verifier.kind,
    });
  }

  // The tree this run owns. Its machinery is the judged engine's, which is
  // objective-agnostic and already proven: one INSERT (`record-node.ts`), one
  // scheduler (`frontier.ts`), one ancestor mean (`backpropagation.ts`), one
  // retirement sweep (`pruning.ts`). What differs is the REWARD they receive, which
  // here is `normalisedScore` over the caller's own metric.
  const sql = deps.rt.storage.sql;
  initSearchTables(deps.rt.storage.execRaw, sql);
  // §8.8's transcript store, and it is the SAME ledger a fork's turns land in: *"the
  // transcript is a read model over the node's journal, never a second store"*.
  // `search_nodes` stays the TREE — structure and one normalised value per node — and
  // the journal stays the turns. Initialised rather than assumed, for the reason
  // `initSearchTables` is: a workspace that has never run a fork has no `head_journal`.
  initHeadsTables(deps.rt.storage.execRaw, sql);
  const journal = new HeadJournal(sql);
  // Whether a node is an agent at all. `thought` is §8.9's degenerate point and takes
  // the toolless path below unchanged; the other two run `node-agent.ts`.
  const agentNodes = resolved.config.unit.kind !== 'thought';
  const languages = deps.rt.executor.languages;
  // The narrowing, not a second policy: `regionRefusal` has already refused the two
  // values with no scheduler here.
  const policy = frontierPolicyOf(resolved.config.advance.kind);
  if (!policy) {
    return unsupported(`advance:"${resolved.config.advance.kind}" has no scheduler in this runner.`);
  }

  // The ROOT is the workspace as found at depth 0 — the one node no model wrote.
  // Recorded so that selection has something to select and so that every child's
  // depth is DERIVED from a row this engine wrote rather than asserted by its author.
  const rootId = nanoid();
  const rootArtifact = verifier && ctx ? await readArtifact(ctx, verifier.artifact) : null;
  insertSearchNode(sql, {
    nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
    task: resolved.task, action: '', observation: rootArtifact ?? resolved.task,
    codeUsed: null, depth: 0, msgId: null,
  });
  const nodes = new Map<string, TreeNode>([[rootId, {
    id: rootId, parentId: null, depth: 0, artifact: rootArtifact,
    // The baseline IS the root's measurement, and its normalised score is 0 by
    // construction — the point the search climbs away from.
    measurement: null, score: measures ? 0 : null,
    proposal: null, proposalError: null, granted: null,
    // The root reported nothing because no model wrote it. Its children's prefix is
    // the ORIGIN's conversation when the caller supplied one (§8.4: *"a root that
    // started blank would throw away precisely the context that made the caller
    // decide to search"*) and the task block alone when it did not.
    conclusion: null, transcript: deps.originContext ?? [], compacted: null,
  }]]);
  // One run header, so every node of this search groups under one root in the journal
  // instead of each appearing as its own empty run — the defect `recordSplit` exists
  // to close, reached here for the same reason.
  if (agentNodes) {
    journal.recordSplit(rootId, resolved.label ?? resolved.preset, Date.now());
  }

  const candidates: SwarmCandidate[] = [];
  let best: SwarmCandidate | null = null;
  let bestValue: number | null = null;
  let usage: Usage = {};
  // THE EXPANSION BUDGET, in units of one child: `depth` waves of `branches`, DERIVED
  // from the two caps the call resolved because there is no third cap to read. §6.1's
  // table files `budget` (iterations) as a cap on `SwarmInput`, but `SwarmInput`
  // declares none and the tool surface deliberately omits it — `agents-tool.ts` records
  // that an iteration cap was meaningless at the one depth that ran, and that declaring
  // a cap nothing applies is the §2.5 lie. So the two DECLARED caps are the budget. At
  // depth 1 this is exactly `branches`, i.e. the one wave a flat run has always been,
  // so enabling the tree changes nothing about the depth that already ran. An invented
  // third number would be worse than a derivation: a default nothing declared is a
  // shape the record cannot report honestly, and this one `expansions` reports.
  //
  // OWNED BY A TYPE rather than by a `let`, because arbitration no longer happens only
  // in this loop: an agent node asks from inside its own concurrent tool loop, so the
  // read and the debit have to be one step (`swarm-budget.ts`).
  const budget = new SwarmBudget(maxDepth * branches);

  /**
   * What every agent node of this run is handed, built ONCE.
   *
   * Assigned rather than spread conditionally, and the reason is the same one
   * `nodeWorkspace` is written for: an absent dep must be an ABSENT KEY. A key written as
   * `undefined` would make "the caller wired none" indistinguishable from "the caller
   * wired nothing", and that distinction is what decides whether a node's surface holds a
   * tool at all.
   */
  const nodeDeps: NodeAgentDeps = {
    rt: deps.rt, model: deps.model, journal, logger: log,
    maxSteps: deps.maxSteps ?? DEFAULT_MAX_STEPS,
  };
  if (deps.signal !== undefined) nodeDeps.signal = deps.signal;
  if (deps.reportModelCall !== undefined) nodeDeps.reportModelCall = deps.reportModelCall;
  if (deps.mission !== undefined) nodeDeps.mission = deps.mission;
  if (deps.provisionHome !== undefined) nodeDeps.provisionHome = deps.provisionHome;
  if (deps.executeTool !== undefined) nodeDeps.executeTool = deps.executeTool;
  if (deps.webSearch !== undefined) nodeDeps.webSearch = deps.webSearch;

  let lost = 0;
  let aborted = false;

  /**
   * A grant that has been PAID FOR and not yet expanded.
   *
   * The loop's continuation test needs it because an agent node's grant debits the
   * budget the moment the arbiter pays, from inside that node's own tool call — so a
   * search can reach `remaining === 0` with children it has already bought and not yet
   * created. Stopping there would charge the run for a level it never ran, which is the
   * one way conservation could become dishonest in the other direction.
   */
  const reservedChildren = (): boolean => {
    for (const node of nodes.values()) if (node.granted) return true;
    return false;
  };

  while (budget.remaining > 0 || reservedChildren()) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }
    // A PAID GRANT IS EXPANDED FIRST, and that is not a bypass of the scheduler: the
    // grant was arbitrated against the scheduler's own policies — this `advance` expands
    // at a node, the depth cap admits the level, the budget could pay — and accepted.
    // The node was told "children reserved". Letting selection postpone that
    // indefinitely would make the verdict a lie, and letting the budget be spent
    // elsewhere first would make it unpayable.
    const owed = [...nodes.values()].find((node) => node.granted !== null);
    const selected = owed ?? selectFrontierNode(sql, {
      rootId, policy, maxDepth,
      explorationWeight: resolved.config.explorationWeight
        ?? DEFAULT_CONFIG.mcts.explorationWeight,
    });
    // Nothing selectable: the frontier is exhausted, or every open node sits at the
    // depth cap. A settled search rather than a failed one.
    if (!selected) break;
    const parent = nodes.get(selected.id);
    if (!parent) {
      // Every row in this tree was written beside its content, here, in this call. A
      // row with no content is an inconsistency rather than a state, and expanding
      // from an unknown parent would produce children nothing can explain.
      return unavailable(`the search selected node ${selected.id} of its own tree and this run holds `
        + 'no content for it, so the expansion would have no parent to continue from. That is an '
        + 'inconsistent tree rather than a missing instrument, and it stops the run.');
    }

    // ARBITRATE, before anything is spent — or read the grant this node already
    // earned. An AGENT node was answered by `propose_branch` while it ran, and the
    // budget was debited there; a THOUGHT node is answered HERE, where selection
    // reached it, which is what makes a proposal an input to selection rather than a
    // bypass of it (§8.2). Both go through one arbiter and one budget.
    const grant = parent.granted ?? (() => {
      const decision = answerProposal({ log, node: parent, resolved, budget });
      return decision?.kind === 'granted' ? decision : null;
    })();
    parent.proposal = null;
    // Cleared because a tree selector may re-select an expanded node: `uct` re-widens,
    // and a grant left in place would be spent twice off one debit.
    parent.granted = null;

    // Committed whether or not every call came back: a rejected generation may still
    // have been paid for, and a budget that only counted successes would let a failing
    // provider buy unbounded expansions. A granted width was already debited at
    // arbitration, so charging it again here would bill the search twice.
    const width = grant?.width ?? budget.take(branches);
    // The budget is spent and nothing is owed: the wave this iteration would have run
    // has no room, and creating it free is the overspend conservation exists to refuse.
    if (width === 0) break;

    const ancestors = pathTo(nodes, parent);
    const childDepth = parent.depth + 1;
    // §8.4's barrier: ONE compacted view per branch point, computed before any child
    // of this parent starts, so nothing a level is ranked on can be a fact about which
    // sibling's compaction kept the useful paragraph.
    const prefix = agentNodes ? await sharedPrefix({ parent, deps, log, preset: resolved.preset }) : [];
    // What a child starts from: the proposal's per-branch answer where one was
    // granted, otherwise the run's `context`. `expand:'mutate'` used to ask this and
    // was cut for exactly that reason — it was a second spelling of `context`.
    const inheritedArtifact = (grant
      ? grant.proposal.branches.some((branch) => branch.context === 'fork')
      : resolved.config.context === 'fork')
      ? parent.artifact
      : null;

    // EXPAND. Nodes in parallel — an agent node touches the shared plane, and that is
    // exactly why it is graded on what it REPORTS rather than on what it changed — and
    // measurement strictly sequential below, because every candidate is written to the
    // same path.
    //
    // The executor's declared languages travel into the prompt for the reason
    // explore-prompt.ts states: a candidate fenced in a language nothing here can run
    // is unverifiable, so the question has to name what the measurement can execute.
    const generated = await Promise.allSettled(
      Array.from({ length: width }, async (_unused, index): Promise<Expansion> => {
        const branch = grant?.proposal.branches[index];
        const childContext = branch?.context ?? resolved.config.context;
        const prompt = branchPrompt({
          resolved, mode: deps.mode, languages, measured, baseline,
          index, branches: width,
          task: branch?.task ?? resolved.task,
          inherited: inheritedArtifact, ancestors, atDepth: childDepth, maxDepth,
          // A thought node's whole request is one prompt, so its invitation is part of
          // it. An agent node is invited by the tool being present instead.
          invite: !agentNodes,
        });
        const id = grant?.nodeIds[index] ?? nanoid();
        if (!agentNodes) {
          const result = await generateText({
            model: deps.model,
            system: prompt.system,
            prompt: prompt.user,
            abortSignal: deps.signal,
          });
          const answer = readAnswer(result.text);
          const code = readProposalCode(answer.text, languages);
          return {
            id,
            artifact: code?.kind === 'runnable' ? code.code : answer.text,
            proposal: answer.proposal,
            proposalError: answer.proposalError,
            granted: null,
            conclusion: null,
            transcript: [],
            usage: normalizeUsage(result.usage),
            modelId: result.response.modelId,
          };
        }
        const seed = branchSeed({
          parent, measured, baseline, verifier, atDepth: childDepth, maxDepth,
          focus: prompt.user, context: childContext,
        });
        const run = await runNodeAgent({
          nodeId: id, rootId, parentId: parent.id, depth: childDepth,
          task: resolved.task,
          rationale: branch?.rationale ?? `expansion ${String(index + 1)} of ${String(width)}`,
          base: prompt.system,
          messages: childContext === 'fork' ? [...prefix, seed] : [seed],
          inherited: childContext === 'fork' ? inheritedAsSerialized(prefix) : [],
          context: childContext,
          mode: deps.mode,
          settle: resolved.settle,
          // §8.2's build-time rule: the tool exists only where a branch could be granted.
          // Depth is what cannot change mid-run, so it gates the BUILD; the budget can
          // empty between the invitation and the answer, so it stays a runtime refusal
          // inside the arbiter.
          arbitrate: isTreeAdvance(resolved.config.advance.kind) && childDepth + 1 <= maxDepth
            ? (proposal) => budget.arbitrate({
              config: resolved.config, caps: resolved.caps, atDepth: childDepth, proposal,
            })
            : null,
        }, nodeDeps);
        log.event('swarm.node_settled', {
          preset: resolved.preset, node: id, depth: childDepth,
          status: run.report.status, steps: run.report.stepCount,
          tool_calls: run.report.toolCalls.length,
          wall_clock_ms: run.report.wallClockMs,
          isolation: run.isolation,
          reported: run.reportedItself ? 'self' : 'final-text',
        });
        return {
          id,
          artifact: run.candidate,
          proposal: null,
          proposalError: null,
          granted: run.granted?.kind === 'granted' ? run.granted : null,
          conclusion: run.candidate,
          transcript: [...prefix, seed, ...run.produced],
          usage: run.usage,
          // The node's own report already reached `reportModelCall` per node, so the
          // run does not report it twice — it only sums it for the settle report.
          modelId: null,
        };
      }),
    );

    const expansions: Expansion[] = [];
    for (const settled of generated) {
      if (settled.status === 'rejected') {
        // Named, never counted: a branch lost to a provider error is one fewer
        // candidate and the report's `stop` has to be able to say the search ran
        // narrower than it was configured to.
        lost += 1;
        log.event('swarm.branch_failed', {
          preset: resolved.preset,
          depth: childDepth,
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        });
        continue;
      }
      usage = addUsage(usage, settled.value.usage);
      if (settled.value.modelId !== null) {
        deps.reportModelCall?.({
          source: 'swarm', usage: settled.value.usage, modelId: settled.value.modelId,
        });
      }
      expansions.push(settled.value);
    }
    if (grant) {
      reportVerdict(log, {
        verdict: { kind: 'accepted', nodeIds: expansions.map((child) => child.id) },
        preset: resolved.preset, nodeId: parent.id, atDepth: parent.depth, policy: null,
      });
    }

    // SCORE, then RECORD, then BACKPROPAGATE. One candidate at a time, into the one
    // path the instrument reads.
    for (const expansion of expansions) {
      const outcome = measures && verifier && ctx && measured && baseline !== null
        ? await measureChild({ ctx, verifier, measured, baseline, artifact: expansion.artifact })
        : null;
      if (outcome?.kind === 'instrument-faulted') {
        // §3.4: a throw is the INSTRUMENT breaking and is never converted into an
        // unmeasurable candidate. It fails the run: no node is scored, nothing is
        // published, and the reason reaches the caller intact.
        return unavailable(`the verifier faulted while measuring ${expansion.id}, so no number this `
          + `run produced can be trusted: ${outcome.error}`);
      }
      const candidate: SwarmCandidate = {
        id: expansion.id,
        artifact: expansion.artifact,
        measured: outcome && outcome.kind !== 'unmeasurable' ? outcome.measurement : null,
        unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
        score: outcome?.kind === 'scored' ? outcome.score : null,
      };
      candidates.push(candidate);
      // DEPTH IS DERIVED: the parent's row plus one, computed here and written by the
      // engine. A node supplies no depth, so there is no number for it to lie about.
      insertSearchNode(sql, {
        nodeId: expansion.id, parentNodeId: parent.id, parentMsgId: null, rootId,
        task: resolved.task, action: '', observation: expansion.artifact,
        codeUsed: null, depth: childDepth, msgId: null,
      });
      nodes.set(expansion.id, {
        id: expansion.id, parentId: parent.id, depth: childDepth,
        artifact: expansion.artifact,
        measurement: outcome && outcome.kind !== 'unmeasurable' ? outcome.measurement : null,
        score: outcome?.kind === 'scored' ? outcome.score : null,
        proposal: expansion.proposal,
        proposalError: expansion.proposalError,
        granted: expansion.granted,
        conclusion: expansion.conclusion,
        transcript: expansion.transcript,
        // Not yet crossed the threshold: compaction is decided when this node becomes a
        // branch point, not when it is created.
        compacted: null,
      });
      if (expansion.proposalError) {
        // The node asked for a branch and the engine could not read the request. Not
        // one of arbitration's five policies — it never reached the arbiter — and
        // never silent, because a node told nothing simply asks again.
        log.event('swarm.proposal_unreadable', {
          preset: resolved.preset, node: expansion.id, depth: childDepth,
          error: expansion.proposalError,
        });
      }
      if (outcome?.kind === 'sealed') {
        // §4.4: NOT scored zero, NOT written, and the run CONTINUES under a seal. The
        // measurement is retained in full because a discarded one cannot adjudicate
        // "the floor is wrong" against "the verifier is gameable".
        publication = { kind: 'sealed', breach: outcome.breach, clearedBy: null };
        log.event('exploration.floor_breach', {
          preset: resolved.preset,
          metric: measured?.metric ?? '',
          value: outcome.measurement.value,
          floor: outcome.breach.floor.value,
          margin: outcome.breach.margin,
          hypotheses: outcome.breach.hypotheses.join(','),
        });
      }
      if (outcome?.kind === 'scored' && outcome.score !== null) {
        backpropagate(sql, expansion.id, outcome.score);
      } else if (outcome) {
        // TAKEN OUT OF SELECTION WITHOUT PRETENDING IT SCORED: `terminal` for a node
        // sealed past its floor, `failed` for one the instrument could not measure.
        // Neither is backpropagated, so neither contributes a reward and both keep the
        // DDL's `visits = 0, value = 0` — absent rather than zero, which is the
        // distinction this whole surface is built on. A 0 reward would claim the node
        // was measured and bad; an unmeasurable node was not measured at all, and a
        // sealed one measured too well.
        const status = outcome.kind === 'sealed' ? 'terminal' : 'failed';
        void sql`UPDATE search_nodes SET status = ${status} WHERE id = ${expansion.id}`;
      }
      if (outcome?.kind === 'scored'
        && measured
        && (bestValue === null || isBetter(outcome.measurement.value, bestValue, measured.direction))) {
        best = candidate;
        bestValue = outcome.measurement.value;
      }
    }

    // Retire what the tree has learned is not worth selecting. Its own visit gate
    // protects single-visit leaves, so on a flat run — where nothing is ever
    // re-visited — this cannot fire, which is why a depth-1 search is unchanged.
    if (isTreeAdvance(resolved.config.advance.kind)) {
      await pruneLowValueBranches(
        deps.rt, rootId, resolved.config.pruneThreshold, resolved.config.minVisitsForPrune,
      );
    }
  }

  // THE SWEEP. Every THOUGHT node's proposal that selection never reached is answered
  // now, against the state that kept it waiting — §8.2's rule that a proposal is never
  // dropped silently, and the only place `depth-exhausted` and `budget-exhausted` can
  // be reached, since selection excludes a capped node and the loop guards the budget.
  // An agent node needs no sweep: its request was answered inside its own tool call.
  for (const node of nodes.values()) {
    if (!node.proposal) continue;
    answerProposal({ log, node, resolved, budget });
    node.proposal = null;
  }

  // The answer stays in the workspace. Without this the path holds whichever
  // candidate was measured last, which is a different artifact from the one reported.
  if (best && verifier && ctx) await ctx.vfs.writeFile(verifier.artifact, best.artifact);

  const report = settleReport({
    resolved, measured, baseline, publication, candidates, best,
    // Every child this run actually created and measured — the candidate list IS the
    // count, rather than a second tally beside it that could disagree.
    expansions: candidates.length, usage, durationMs: Date.now() - started,
    // Why the run ended, from what the loop observed rather than from the count. A
    // budget spent with nothing left to select is a SETTLED search; a budget spent
    // with a frontier still open is a truncated one, and a search narrower than its
    // configured width is truncated too even if it stopped for another reason.
    stop: aborted
      ? 'aborted'
      : lost > 0 || (budget.remaining <= 0 && selectFrontierNode(sql, {
        rootId, policy, maxDepth,
        explorationWeight: resolved.config.explorationWeight
          ?? DEFAULT_CONFIG.mcts.explorationWeight,
      }) !== null)
        ? 'budget'
        : 'settled',
  });
  return {
    preset: resolved.preset,
    label: resolved.label,
    config: resolved.config,
    caps: resolved.caps,
    report,
    publication: {
      state: publication,
      caveat: publication.kind === 'sealed' && publication.clearedBy === null
        ? 'this run measured a candidate past its floor, so the floor is SUSPENDED for the rest of '
          + 'the run and the answer is not publishable: the number may be a cheat the verifier '
          + 'missed, or the bound may be wrong, and this observation cannot tell which. Nothing '
          + 'clears it except a recorded re-derivation of the bound.'
        : null,
    },
    best,
    candidates,
  };
}

/** §2.4(c)'s report, assembled from what the run actually observed. */
function settleReport(input: {
  readonly resolved: ResolvedSwarm;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly publication: PublicationState;
  readonly candidates: readonly SwarmCandidate[];
  readonly best: SwarmCandidate | null;
  readonly expansions: number;
  /** Why the run ended, as the LOOP observed it. Derived there rather than inferred
   *  from the candidate count, because a tree's count carries no information about
   *  whether anything was still reachable when the budget ran out. */
  readonly stop: SwarmSettleReport['stop'];
  readonly usage: Usage;
  readonly durationMs: number;
}): SwarmSettleReport {
  const { resolved, measured, best } = input;
  const carry = PUBLISHING_CARRIES.find(
    (publishing): publishing is PublishingCarry => publishing === resolved.config.carry.kind,
  );
  return {
    settle: resolved.settle,
    floorMargin: measured?.floor ? floorMargin(measured.floor, measured.direction) : null,
    baseline: input.baseline,
    // A witness verdict about THIS RUN. `false` is "this search did not find one",
    // and there is no field on this report that could say none exists.
    witnessFound: measured?.witness ? best !== null && best.score === 1 : null,
    // The count is one per CELL rather than per refused publication: a flat run with
    // no descriptor has exactly one cell, and it costs the next run one thing — a
    // worse starting elite — or nothing at all.
    carrySuppressed: carry
      ? carrySuppression(input.publication, carry, best ? 1 : 0)
      : null,
    stop: input.stop,
    expansions: input.expansions,
    tokens: usageTotal(input.usage) ?? null,
    durationMs: input.durationMs,
  };
}
