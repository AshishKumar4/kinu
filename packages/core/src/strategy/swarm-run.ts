/**
 * Running a resolved swarm: select, expand, measure, backpropagate, settle — and
 * refusing, by name, the resolved shapes no engine in this tree can execute
 * faithfully.
 *
 * WHAT RUNS HERE, AND WHY IT IS EXACTLY THIS. A resolved configuration is a search
 * TREE bounded by `depth` and widened by `branches`, and every axis it names is
 * realised rather than approximated:
 *
 *   - `branches` candidates per expansion, each a single toolless generation, which
 *     is what an `expand:'sample'` or `expand:'mutate'` step IS (a child of the root
 *     starts from the workspace as found; a child of a deeper node starts from that
 *     node's own answer);
 *   - `advance` through `mcts/frontier.ts` — the ONE scheduler, so `uct` re-widens,
 *     `beam` sweeps a level at a time, `best-first` takes the best unexpanded node
 *     and `none` expands the root once and stops;
 *   - `decorrelate` by what a sibling is SHOWN: `angles` hands each child its own
 *     angle and names its siblings', `blind` hands an angle and hides the siblings,
 *     `none` hands neither;
 *   - `observe:'ancestors'` by putting the MEASURED BASELINE and the measurements
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
 * A NODE DOES NOT SPAWN CHILDREN — it PROPOSES, and `advance` arbitrates (§8.2). The
 * proposal is read out of the node's own text, because a node here is toolless and a
 * proposal is therefore text the engine reads (§8.6). It is answered when selection
 * REACHES that node, which is what makes it an input to selection rather than a
 * bypass of it, and any proposal selection never reached is answered in the sweep
 * after the loop — a node that cannot tell refusal from being ignored will simply
 * propose again.
 *
 * WHY THE ISOLATION PROOF STILL COVERS THIS, STATED RATHER THAN ASSUMED.
 * `MCTS/StorageIsolation.lean` holds because branches are toolless: its two
 * branch-side actions carry a frame condition forbidding a branch from introducing a
 * storage identity no existing branch holds, and `Exploration/Isolation.lean`'s
 * `agent_node_is_not_a_branch_explore` shows the theorem does not reach a node that
 * acquires its own storage. THIS expansion gives a node neither tools nor storage: a
 * node is one `generateText` call whose entire output is text, and the ENGINE writes
 * that text to the one verifier path and measures it, serially. So the swarm creates
 * no branch storage at all — `AcquiresOwnStorage` is false for every node here, the
 * branch set stays empty, and `init_isolated` covers it without needing the
 * preservation theorem. Nothing is extended and nothing new is claimed. The shape
 * that WOULD need a new argument is `unit:'trajectory'`, a tool-using agent node,
 * and it is refused below for exactly that reason.
 */
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import { DEFAULT_CONFIG } from '../config';
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
import { resolveVerifier, type ResolvedVerifier } from './verifier-registry';
import {
  carrySuppression, floorMargin, isBetter, normalisedScore, PUBLISHING_CARRIES,
} from './objective';
import type {
  Floor, FloorBreach, MeasuredValue, Measurement, MeasurementContext, Objective,
  ObjectiveDirection, ObjectiveScale, PublicationState, PublishingCarry, VerifierSource,
} from './objective';
import {
  arbitrateBranch, isTreeAdvance, BRANCH_PROPOSAL_WIDTH, SWARM_TREE_ADVANCES,
} from './swarm';
import type {
  BranchArbitration, BranchProposal, BranchRefusalPolicy, BranchVerdict, ResolvedSwarm,
  SwarmAdvance, SwarmCandidate, SwarmPreset, SwarmResult, SwarmSettleReport,
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
  // §8.6 requires the BLOCKED composition to be said, not merely omitted. A caller
  // who composes `unit:'trajectory'` has composed it CORRECTLY for the task — the
  // measured `agent-trajectory-search` region scored 18% because the design blocked it
  // and nothing on the surface did. So this arm names the blocker (nodes share one
  // workspace, so a node cannot be graded on what it changed), names what would
  // unblock it (per-node workspace isolation), and states ONE imperative. It does not
  // offer "wait for isolation", which is not something a caller can do.
  if (config.unit.kind === 'trajectory') {
    return unsupported('unit:"trajectory" makes each node a tool-using agent, and every node here '
      + 'shares ONE workspace — so a node cannot be graded on what it changed, because every node '
      + 'changed the same tree. What would unblock it is per-node workspace isolation, and nothing '
      + `else.${config.unit.inherit ? ' Inheriting the caller\'s turns does not change that: the '
        + 'blocker is the shared workspace, not the context.' : ''} Use unit:"answer", which is the `
      + 'shape that is gradeable today.');
  }
  if (config.unit.kind !== 'answer') {
    return unsupported(`unit:"${config.unit.kind}" is not executable here — a node is one complete `
      + 'answer, measured as a whole. Use unit:"answer".');
  }
  if (config.observe === 'own') {
    return unsupported('observe:"own" gives a node feedback about its OWN attempt, and a node here is '
      + 'one complete answer measured as a whole — it is never re-attempted, so there is no second '
      + 'attempt of the same node for that feedback to be about. This is true at every depth: a '
      + 'deeper search adds new nodes, not further tries at an existing one. Use '
      + 'observe:"ancestors", which is how a child is told what the answers on its own path '
      + 'measured, or observe:"none" for a blind expansion.');
  }
  if (config.expand === 'aggregate') {
    return unsupported('expand:"aggregate" builds a DAG whose merges are ordered by dependency, and '
      + 'nothing here orders merges. Use expand:"sample" for independent candidates or '
      + 'expand:"mutate" to improve what the workspace already holds.');
  }
  if (config.score.kind !== 'verify' && config.score.kind !== 'none') {
    return unsupported(`score:"${config.score.kind}" needs a scorer this run has no engine for: `
      + 'novelty needs an archive with a rejection test, and judge needs the marginalised ensemble '
      + 'the shipped tree owns. Use score:"verify" with an `objective` to measure candidates, or '
      + 'score:"none" for a flat run that returns them unranked.');
  }
  if (isTreeAdvance(config.advance) && config.score.kind === 'none') {
    // Unreachable through `swarmValidity`, which refuses this composition outright.
    // Kept because this function is also the in-process entry point.
    return badInput(`advance:"${config.advance}" cannot select without a score.`);
  }
  if (config.advance !== 'none' && !isTreeAdvance(config.advance)) {
    return unsupported(`advance:"${config.advance}" reports a front or an archive, and both need a `
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
  branches: v.array(v.strictObject({ task: v.string(), rationale: v.string() })),
  inherit: v.boolean(),
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
 * The invitation to propose, appended to an expansion prompt only where a branch
 * could actually be granted.
 *
 * §8.2's build-time rule, which `head-tools.ts:110` already applies to
 * `split_subheads`: a request that can only ever be refused MUST NOT be offered,
 * because offering it spends a step to learn a limit the surface already knew. So a
 * flat run and a node at the depth cap are never asked. The runtime refusal stays
 * anyway — the budget can empty between the invitation and the answer.
 */
function proposalInvitation(input: {
  readonly advance: ResolvedSwarm['config']['advance'];
  readonly atDepth: number;
  readonly maxDepth: number;
}): string {
  if (!isTreeAdvance(input.advance) || input.atDepth + 1 >= input.maxDepth) return '';
  return `\n\nIf one thread of this task deserves its own branch of the search, end your answer with `
    + `a line reading ${PROPOSAL_MARKER} followed by a JSON object: `
    + `{"rationale": why this thread deserves the budget, "branches": [{"task", "rationale"}, ...] `
    + `(${String(BRANCH_PROPOSAL_WIDTH.min)}-${String(BRANCH_PROPOSAL_WIDTH.max)} narrower `
    + `sub-questions), "inherit": whether those children should be given your answer as context}. `
    + 'You are proposing, not spawning: the search decides, against a budget and a depth cap you '
    + 'cannot see, and you will be told the reason if it refuses. Omit the block entirely if no '
    + 'thread needs one.';
}

/** What a node is told about the measurements on its own path, under `observe`. */
function pathFeedback(input: {
  readonly observe: ResolvedSwarm['config']['observe'];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly ancestors: readonly TreeNode[];
}): string {
  const { measured, baseline } = input;
  if (input.observe !== 'ancestors' || !measured || baseline === null) return '';
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
 * The expansion prompt for one child: what it is asked, the angle its siblings do not
 * have, what this path has measured, and the branch it may propose.
 *
 * `decorrelate` decides what a sibling is SHOWN, and each of its three values lands
 * somewhere different rather than all three reducing to the angle set: `angles` hands
 * an angle and names the siblings', `blind` hands an angle and hides them — a child
 * expanded without sight of what its siblings proposed — and `none` hands neither.
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
  /** Root-first, parent-last. Used only by `observe:'ancestors'`. */
  readonly ancestors: readonly TreeNode[];
  readonly atDepth: number;
  readonly maxDepth: number;
}): ExplorePrompt {
  const { resolved, index, branches } = input;
  const { decorrelate, expand, observe, advance } = resolved.config;
  const angle = decorrelate === 'none' ? '' : `\n\nYour angle: ${diversityAngle(index, branches)}.`;
  const instruction = expand === 'mutate'
    ? ' Improve what you have been given rather than starting over.'
    : ' Write your approach from scratch; do not assume what is already there is a good start.';
  const inherited = input.inherited
    ? `\n\nThe answer this branch continues from:\n${input.inherited}`
    : '';
  const feedback = pathFeedback({
    observe, measured: input.measured, baseline: input.baseline, ancestors: input.ancestors,
  });
  return explorePrompt({
    mode: input.mode,
    context: `${input.task}${feedback}${inherited}${angle}${instruction}`
      + proposalInvitation({ advance, atDepth: input.atDepth, maxDepth: input.maxDepth }),
    craftedTools: [],
    // `blind` is exactly this: the child is not shown what its siblings were sent.
    siblings: decorrelate === 'angles' ? siblingAngles(index, branches) : [],
    languages: input.languages,
  });
}

/** One generated child, before it is measured. Its token spend is NOT here: the run
 *  accumulates that as it reads each generation, and a per-child copy nothing reads
 *  was carried through the flat version unused. */
interface Expansion {
  readonly id: string;
  readonly artifact: string;
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
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
    case 'beam':
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
 * Disclose a verdict — the ONE place a proposal's answer is reported.
 *
 * It goes to the diagnostics stream and nowhere else, and that is forced rather than
 * chosen: a node here is toolless, so by the time the engine can answer, the node has
 * already finished its one call and there is no channel back to it. The specification
 * requires the answer to exist and says nothing about where it lands when the asker
 * cannot receive it; this is that place, with a stable dotted name so the refusals are
 * queryable rather than merely printed.
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
 * Answer one node's branch proposal, or return null when it made none.
 *
 * The arbiter itself is `arbitrateBranch` in `swarm.ts` — pure, total, and a port of
 * the proven one. This is the engine half: it supplies the two facts the node is not
 * allowed to supply (its own depth, read from the row this engine wrote, and the
 * budget that remains) and it discloses the answer.
 */
function answerProposal(input: {
  readonly log: Logger;
  readonly node: TreeNode;
  readonly resolved: ResolvedSwarm;
  readonly remainingChildren: number;
}): BranchArbitration | null {
  const { node, resolved } = input;
  const proposal = node.proposal;
  if (!proposal) return null;
  const arbitration = arbitrateBranch({
    config: resolved.config,
    caps: resolved.caps,
    atDepth: node.depth,
    remainingChildren: input.remainingChildren,
    proposal,
  });
  if (arbitration.kind === 'refused') {
    reportVerdict(input.log, {
      verdict: { kind: 'refused', reason: 'denied', error: arbitration.error },
      preset: resolved.preset, nodeId: node.id, atDepth: node.depth,
      policy: arbitration.policy,
    });
  }
  return arbitration;
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
  const languages = deps.rt.executor.languages;
  // The narrowing, not a second policy: `regionRefusal` has already refused the two
  // values with no scheduler here.
  const policy = frontierPolicyOf(resolved.config.advance);
  if (!policy) {
    return unsupported(`advance:"${resolved.config.advance}" has no scheduler in this runner.`);
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
    proposal: null, proposalError: null,
  }]]);

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
  let childBudget = maxDepth * branches;
  let lost = 0;
  let aborted = false;

  while (childBudget > 0) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }
    const selected = selectFrontierNode(sql, {
      rootId, policy, maxDepth, beamWidth: branches,
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

    // ARBITRATE, before anything is spent. A node PROPOSED and `advance` answers —
    // here, where selection reached it, which is what makes a proposal an input to
    // selection rather than a bypass of it (§8.2).
    const granted = answerProposal({
      log, node: parent, resolved, remainingChildren: childBudget,
    });
    const accepted = granted?.kind === 'accepted' ? parent.proposal : null;
    parent.proposal = null;

    // EXPAND. Model calls in parallel — they touch nothing — and measurement strictly
    // sequential below, because every candidate is written to the same path.
    //
    // The executor's declared languages travel into the prompt for the reason
    // explore-prompt.ts states: a proposal fenced in a language nothing here can run
    // is unverifiable, so the question has to name what the measurement can execute.
    const width = accepted ? accepted.branches.length : branches;
    const inherited = (accepted ? accepted.inherit : resolved.config.expand === 'mutate')
      ? parent.artifact
      : null;
    const ancestors = pathTo(nodes, parent);
    const childDepth = parent.depth + 1;
    const generated = await Promise.allSettled(
      Array.from({ length: width }, async (_unused, index) => {
        const prompt = branchPrompt({
          resolved, mode: deps.mode, languages, measured, baseline,
          index, branches: width,
          task: accepted?.branches[index]?.task ?? resolved.task,
          inherited, ancestors, atDepth: childDepth, maxDepth,
        });
        const result = await generateText({
          model: deps.model,
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: deps.signal,
        });
        return {
          text: result.text,
          usage: normalizeUsage(result.usage),
          modelId: result.response.modelId,
        };
      }),
    );
    // Committed whether or not every call came back: a rejected generation may still
    // have been paid for, and a budget that only counted successes would let a
    // failing provider buy unbounded expansions.
    childBudget -= width;

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
      const { text, usage: spent, modelId } = settled.value;
      usage = addUsage(usage, spent);
      deps.reportModelCall?.({ source: 'swarm', usage: spent, modelId });
      const answer = readAnswer(text);
      // A proposal fenced in a language the executor cannot run is kept WHOLE rather
      // than dropped: it is still the branch's answer, the measurement will report it
      // as unmeasurable with the instrument's own reason, and a caller reading the
      // report can see what was proposed instead of an absence.
      const code = readProposalCode(answer.text, languages);
      expansions.push({
        id: nanoid(),
        artifact: code?.kind === 'runnable' ? code.code : answer.text,
        proposal: answer.proposal,
        proposalError: answer.proposalError,
      });
    }
    if (granted?.kind === 'accepted') {
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
    if (isTreeAdvance(resolved.config.advance)) {
      await pruneLowValueBranches(
        deps.rt, rootId, resolved.config.pruneThreshold, resolved.config.minVisitsForPrune,
      );
    }
  }

  // THE SWEEP. Every proposal selection never reached is answered now, against the
  // state that kept it waiting — §8.2's rule that a proposal is never dropped
  // silently, and the only place `depth-exhausted` and `budget-exhausted` can be
  // reached, since selection excludes a capped node and the loop guards the budget.
  for (const node of nodes.values()) {
    if (!node.proposal) continue;
    answerProposal({ log, node, resolved, remainingChildren: Math.max(0, childBudget) });
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
      : lost > 0 || (childBudget <= 0 && selectFrontierNode(sql, {
        rootId, policy, maxDepth, beamWidth: branches,
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
