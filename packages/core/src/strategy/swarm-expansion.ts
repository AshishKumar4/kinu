/**
 * One child's EXPANSION: the prompt it is asked, the seed it inherits, the conversation
 * prefix it shares with its siblings, the answer-reading that splits a proposal from an
 * answer, and — as it is extracted — the generation half of one child for both node kinds.
 *
 * Split from `swarm-run.ts` because this is PROMPT AND INHERITANCE policy under
 * *Inherited context* and *Arbitration*: what a node is told, what it may propose, and
 * what one branch point shares across its children. The loop that schedules children is
 * the runner's; the words a child sees are this module's.
 */
import * as v from 'valibot';
import type { LanguageModel, ModelMessage } from 'ai';
import { diversityAngle, siblingAngles } from '../mcts/diversity';
import { explorePrompt, type ExplorePrompt } from '../mcts/explore-prompt';
import { extractJsonObject } from '../prompts/structured';
import { renderIssues } from '../utils/json';
import { renderThrownChain, type Logger } from '../obs/index';
import { estimateTokens } from '../llm';
import { contextWindowForModel } from '../context-window';
import { sha256Hex } from '../safety/argument-digest';
import {
  BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS, isTreeAdvance,
} from './swarm';
import type {
  BranchContext, BranchProposal, ResolvedSwarm, SwarmPreset,
} from './swarm';
import type {
  ExplorationRecord, MeasuredObjective,
} from './objective';
import type { FanInParent } from './fanin';
import type { ResolvedVerifier } from './verifier-registry';
import type { SerializedMessage } from '../heads/types';
import type { WorkMode } from '../prompting/surface';
import type { Expansion, TreeNode } from './swarm-tree';
import type { ModelCallSink } from '../events/model-call';

import { generateText } from 'ai';
import { normalizeUsage, type Usage } from '../usage';
import { readProposalCode } from '../execution/code-fence';
import { runNodeAgent, type NodeAgentDeps } from './node-agent';
import type { RoutedNodeModel } from './swarm-setup';
import type { SwarmBudget } from './swarm-budget';
import type { BranchAssignment } from './swarm-level';

/** The marker a node ends its answer with to request a branch. A line rather than a
 *  fence so the answer's own code fences cannot be mistaken for it. */
const PROPOSAL_MARKER = 'PROPOSE-BRANCH';

/**
 * The proposal *Arbitration* governs, at the one boundary it crosses.
 *
 * `strictObject`, so a node that invents a field is told rather than silently having
 * it dropped — the same discipline the verifier registry applies to `spec`. Notably
 * ABSENT: any depth field. A node never states its own depth (*Node identity*), so the
 * request carries no number the engine would have to distrust.
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
export function readAnswer(text: string): ReadAnswer {
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
        + `could not be arbitrated: ${renderThrownChain({ cause: error })}`,
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
 * *Build-time exclusion*, which `head-tools.ts` already applies to `split_subheads`
 * and `node-agent.ts` applies to `propose_branch`: a request that can only ever be
 * refused MUST NOT be offered, because offering it spends a step to learn a limit the
 * surface already knew. So a flat run and a node at the depth cap are never asked.
 * The runtime refusal stays anyway — the budget can empty between the invitation and
 * the answer.
 *
 * WHICH DEPTH IS "AT THE CAP" IS THE ARBITER'S ANSWER, NOT A SECOND OPINION.
 * `arbitrateBranch` refuses `caps.depth.value <= atDepth`, so a grant is legal exactly
 * while `atDepth + 1 <= maxDepth`; the tool gate for an agent node and the fan-in skip
 * both spell it that way. This line read `>=` until 2026-08-19, one level tighter than
 * all three, which suppressed the invitation on the DEEPEST level a proposal could
 * still be granted from — and in a depth-2 thought search that is every level, so no
 * node was ever asked to propose and `expand` was unreachable through a proposal. The
 * mutation sweep found it: the two readings differ only at that one depth, and nothing
 * asserted the boundary.
 *
 * A MARKER RATHER THAN A TOOL, because this is the degenerate point: a thought node
 * has no tool call to be answered through, so its request is text the engine reads
 * and its verdict is a typed diagnostic event (*Arbitration*). An agent node gets the
 * tool.
 */
function proposalInvitation(input: {
  readonly advance: ResolvedSwarm['config']['advance'];
  readonly atDepth: number;
  readonly maxDepth: number;
}): string {
  if (!isTreeAdvance(input.advance.kind) || input.atDepth + 1 > input.maxDepth) return '';
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
 * What a node is told about the best any EARLIER run of this objective reached.
 *
 * This is FunSearch's programs database sampled into the prompt, which is the mechanism
 * `ExplorationRecord`'s own docstring names — the store is "FunSearch's program database
 * and MAP-Elites' grid", and a database is read by putting its members in front of the
 * model. It is deliberately NOT placed at the verifier's path: a run whose baseline was
 * measured on a file this engine had just overwritten would have a baseline that is not
 * "the workspace as found" (*Measured baseline*), and a better one at that, so the
 * target-already-met refusal would kill exactly the runs that had the most to inherit.
 *
 * The VALUE and the ARTIFACT together. The number alone is a bar with no way to clear
 * it, and the artifact alone is a program with no reason to believe it is good.
 */
function carriedFeedback(
  measured: MeasuredObjective | null, carried: ExplorationRecord | null,
): string {
  if (!measured || !carried) return '';
  return `\n\nAn earlier run of this same objective reached ${String(carried.value)} `
    + `${measured.unit} on ${measured.metric}. That is the number to beat, and this is what `
    + `reached it:\n${carried.artifact}`;
}

/**
 * One parent of a fan-in, as both the merge and the child that consumes it need it:
 * the id that earns the dependency edge, the text that IS the work, the score the
 * search measured, and the edges this parent itself declared.
// `FanInParent` lives in `fanin.ts` beside the policy that consumes it.
/**
 * What a fan-in's child is handed: every parent it consumes, named and quoted.
 *
 * QUOTED RATHER THAN POINTED AT, and only here. A sampling child is told WHERE its
 * parent's candidate is and asked to read it (see {@link branchSeed}), because one file
 * holds it. A fan-in has k answers and the workspace holds the accumulation of the ones
 * that AGREED — the answer that disagreed is precisely what is not on disk, and it is
 * the half this child exists to reconcile.
 */
function aggregatedAnswers(parents: readonly FanInParent[]): string {
  if (parents.length === 0) return '';
  return `\n\nThe ${String(parents.length)} answers this fan-in combines, each under the node that `
    + `produced it:\n${
      parents.map((parent) => `--- ${parent.id} ---\n${parent.answer}`).join('\n')
    }`;
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
export function branchPrompt(input: {
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
  /** The parents this child FANS IN, under `expand:'aggregate'`. Empty for a sampling
   *  child, which continues from one parent. */
  readonly aggregated: readonly FanInParent[];
  /** Root-first, parent-last. Read only where `context` is `'fork'`. */
  readonly ancestors: readonly TreeNode[];
  readonly atDepth: number;
  readonly maxDepth: number;
  /** The best record an earlier run of this objective left behind, or null when the
   *  store held none — which for the first run of an objective is every time. */
  readonly carried: ExplorationRecord | null;
  /** Whether to append the marker-line invitation. False for an agent node, which is
   *  invited by `propose_branch` being on its surface instead — two invitations for
   *  one capability would teach the model a protocol the engine does not read. */
  readonly invite: boolean;
  /** What this node was asked to do and what its siblings were asked, where somebody
   *  wrote it. Null for a count-based wave — see {@link BranchAssignment}. */
  readonly assignment: BranchAssignment | null;
}): ExplorePrompt {
  const { resolved, index, branches } = input;
  const { context, advance } = resolved.config;
  // THE ANGLE SLOT: the brief whoever asked for this node wrote, or the engine's own
  // canned angle where nobody wrote one. Never both — see {@link BranchAssignment}.
  const angle = `\n\nYour angle: ${input.assignment?.brief ?? diversityAngle(index, branches)}.`;
  // Keyed off what this child ACTUALLY received rather than off an axis, because a
  // proposal may override inheritance per branch and the instruction has to match
  // the text above it.
  const instruction = input.inherited
    ? ' Improve what you have been given rather than starting over.'
    : ' Write your approach from scratch; do not assume what is already there is a good start.';
  const inherited = input.inherited
    ? `\n\nThe answer this branch continues from:\n${input.inherited}`
    : '';
  const combining = aggregatedAnswers(input.aggregated);
  const feedback = pathFeedback({
    context, measured: input.measured, baseline: input.baseline, ancestors: input.ancestors,
  });
  const carried = carriedFeedback(input.measured, input.carried);
  return explorePrompt({
    mode: input.mode,
    context: `${input.task}${feedback}${carried}${inherited}${combining}${angle}${instruction}`
      + (input.invite
        ? proposalInvitation({ advance, atDepth: input.atDepth, maxDepth: input.maxDepth })
        : ''),
    craftedTools: [],
    // Unconditional, like the angle itself: every child is told what its siblings
    // were sent, because the axis that claimed to hide them never did. The briefs
    // where there are briefs, the canned angles where there are not — the same set
    // the angle above was taken from, so the two halves cannot describe two levels.
    siblings: input.assignment?.siblings ?? siblingAngles(index, branches),
    languages: input.languages,
  });
}

/**
 * The share of a model's window at which the compaction ladder under *Inherited
 * context* is allowed to run.
 *
 * *"When a node's context reaches roughly 85% of its window, the ladder runs; below
 * that it does not run at all."* Named because it is a CACHING judgement and not a
 * measurement of where quality falls off — the specification says so itself, and a
 * bare `0.85` in an expression would read as the second thing.
 */
const CONTEXT_COMPACTION_THRESHOLD = 0.85;

/**
 * The *Inherited context* BARRIER: the one prefix every child of this parent inherits.
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
 * objective is the fabrication *Witness objectives* forbids, reached by attrition.
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

/** The *Inherited context* BARRIER: the one prefix every child of this parent inherits,
 *  verbatim below the threshold and compacted ONCE above it. See the note above
 *  `modelSpecOf`. */
export async function sharedPrefix(input: {
  /** The model the CHILDREN of this parent run on, which is the window this
   *  threshold has to be measured against — the caller's own model is not what
   *  will be asked to hold the prefix. */
  readonly model: LanguageModel;
  readonly parent: TreeNode;
  /** The compaction ladder over inherited context, exactly as {@link SwarmRunDeps.compactShared}
   *  declares it. Narrowed to this one seam so this module needs no runner import. */
  readonly compactShared?: (
    messages: readonly ModelMessage[],
    basis: { readonly contextWindow: number; readonly key: string },
  ) => Promise<readonly ModelMessage[]>;
  readonly log: Logger;
  readonly preset: SwarmPreset;
}): Promise<readonly ModelMessage[]> {
  const { parent } = input;
  if (parent.compacted) return parent.compacted;
  if (parent.transcript.length === 0) return parent.transcript;
  const chars = parent.transcript.reduce(
    (total, message) => total + JSON.stringify(message.content).length, 0,
  );
  const window = contextWindowForModel(modelSpecOf(input.model));
  const room = window * CONTEXT_COMPACTION_THRESHOLD;
  if (estimateTokens(chars) < room) return parent.transcript;
  if (!input.compactShared) {
    input.log.event('swarm.compaction_absent', {
      preset: input.preset, node: parent.id, depth: parent.depth,
      estimated_tokens: estimateTokens(chars), threshold: Math.round(room),
    });
    return parent.transcript;
  }
  // The key is the branch point's durable id, so a re-entered search replays the same
  // plan byte-stably instead of re-summarising; the window is the one this threshold
  // measured against, so the ladder and the policy never disagree about pressure.
  const shared = await input.compactShared(parent.transcript, {
    contextWindow: window,
    key: `swarm:${parent.id}`,
  });
  parent.compacted = shared;
  input.log.event('swarm.context_compacted', {
    preset: input.preset, node: parent.id, depth: parent.depth,
    before: parent.transcript.length, after: shared.length,
  });
  return shared;
}

/**
 * The *Inherited context* SEED, assembled by the engine and never authored by the
 * parent.
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
export function branchSeed(input: {
  readonly parent: TreeNode;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly verifier: ResolvedVerifier | null;
  readonly atDepth: number;
  readonly maxDepth: number;
  readonly focus: string;
  readonly context: BranchContext;
  /** The parents this child FANS IN. Empty for a sampling child. */
  readonly aggregated: readonly FanInParent[];
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
  if (input.aggregated.length > 0) {
    // WHAT EACH PARENT MEASURED, beside the answers themselves, because a fan-in is
    // asked to keep what each member earned and cannot tell what that was from the text
    // alone. Absent for a parent the search could not score, which is a parent a fan-in
    // does not consume at all.
    parts.push(`This node is a fan-in over ${String(input.aggregated.length)} parents: ${
      input.aggregated
        .map((parent) => `${parent.id} scored ${parent.score === null ? 'nothing' : parent.score.toFixed(3)}`)
        .join('; ')
    }.`);
    parts.push(aggregatedAnswers(input.aggregated).trim());
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
export function inheritedAsSerialized(prefix: readonly ModelMessage[]): SerializedMessage[] {
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
 * The context ONE RUN hands every child spawn: everything {@link expandChild} used to
 * close over in the runner, made explicit. Built once per run.
 */
export interface ExpandChildCtx {
  readonly resolved: ResolvedSwarm;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly verifier: ResolvedVerifier | null;
  /** The records store's best for this objective, read once before the loop: a fan-in's
   *  vertex is asked to beat the same number every sampled child is. */
  readonly carriedBest: ExplorationRecord | null;
  readonly agentNodes: boolean;
  readonly maxDepth: number;
  /** The model every node of this run runs on - not necessarily the caller's own. */
  readonly nodeModel: LanguageModel;
  /**
   * The RESOLVED per-node routing, in the slot order `SwarmInput.models` assigns:
   * child `i` of a wave runs entry `i % length` when the list is non-empty, and
   * {@link nodeModel} when it is not. Empty is the unrouted default rather than an
   * error — the call resolved no list, which is the unchanged behaviour of every
   * run before this field returned. Entries are RESOLVED at run start (an
   * unresolvable spec refuses the whole run before any node exists) and each keeps
   * the caller's own SPEC beside its model: the model drives this isolate's calls,
   * and the spec is what a hosted facet takes across the wire (`HeadInput.model`).
   */
  readonly nodeModels: readonly RoutedNodeModel[];
  readonly signal?: AbortSignal;
  readonly nodeDeps: NodeAgentDeps;
  readonly budget: SwarmBudget;
  readonly rootId: string;
  readonly log: Logger;
  /** The mission ledger a THOUGHT node's one call charges where it returns. */
  readonly charge: (spent: Usage) => Promise<void>;
  readonly reportModelCall?: ModelCallSink;
}

/**
 * Expand ONE child: the generation half of an expansion, for a wave's sibling and for
 * a fan-in's aggregate vertex alike.
 *
 * ONE FUNCTION, because the merge node *Merge-back* describes is graded like any other
 * candidate, and a second generation path for it would be exactly the second mechanism
 * that policy exists to prevent. It is also where a merge node would quietly lose
 * everything a child gets for free here: a journalled transcript, arbitration at its
 * own depth, usage accounting, and the one event that says a node settled.
 */
export async function expandChild(ctx: ExpandChildCtx, input: {
  readonly parent: TreeNode;
  readonly id: string;
  /** Which sibling of the wave this is, and how wide the wave is — the diversity
   *  angle and the sibling disclosure are both derived from the pair. A fan-in's
   *  vertex is one child of one, which is what it is. */
  readonly index: number;
  readonly width: number;
  readonly atDepth: number;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  /** The parent's own answer, where this child continues from it. */
  readonly inherited: string | null;
  readonly aggregated: readonly FanInParent[];
  readonly ancestors: readonly TreeNode[];
  readonly prefix: readonly ModelMessage[];
  /** What this node was asked to do, where somebody wrote it — the caller's per-node
   *  `prompt` or the parent's per-branch `rationale`. Null for a count-based wave. */
  readonly assignment: BranchAssignment | null;
  }): Promise<Expansion> {
  const {
    resolved, mode, languages, measured, baseline, verifier, carriedBest, agentNodes,
    maxDepth, nodeModel, nodeModels, signal, nodeDeps, budget, rootId, log, charge,
    reportModelCall,
  } = ctx;

  const { parent, id, atDepth } = input;
  /**
   * THE MODEL THIS CHILD RUNS ON — the one its slot was assigned where the call
   * routed per node, and the run's own model where it did not. THE RUNNER LINE THAT
   * CONSUMES THE ASSIGNMENT: this is where `SwarmInput.models` reaches a model
   * request, by the slot `planLevel` already decided for this child. A fan-in's
   * vertex is `index: 0`, so it runs the first spec — decided by its slot rather
   * than by what it is, exactly as the assignment rule states.
   */
  const routed = nodeModels.length > 0 ? nodeModels[input.index % nodeModels.length] : undefined;
  const assignedModel = routed?.model ?? nodeModel;
  /** The DAG's edges as the row-writing loop needs them: ids, not nodes. */
  const edges = input.aggregated.map((fanned) => fanned.id);
  const prompt = branchPrompt({
    resolved, mode, languages, measured, baseline,
    index: input.index, branches: input.width,
    task: input.task,
    inherited: input.inherited, aggregated: input.aggregated,
    ancestors: input.ancestors, atDepth, maxDepth,
    // The records store's best for this objective, read once before the loop: a fan-in's
    // vertex is asked to beat the same number every sampled child is.
    carried: carriedBest,
    // A thought node's whole request is one prompt, so its invitation is part of
    // it. An agent node is invited by the tool being present instead.
    invite: !agentNodes,
    assignment: input.assignment,
  });
  if (!agentNodes) {
    const result = await generateText({
      model: assignedModel,
      system: prompt.system,
      prompt: prompt.user,
      abortSignal: signal,
    });
    const spent = normalizeUsage(result.usage);
    reportModelCall?.({
      source: 'swarm',
      usage: spent,
      modelId: result.response.modelId,
    });
    // CHARGED HERE, where the call returned, so the level guard below reads a
    // current ledger. A toolless node's whole spend is this one call — the same
    // quantity `Expansion.usage` carries down to the settle report — and the caller
    // that spawned this search must therefore charge no lump for it afterwards.
    await charge(spent);
    const answer = readAnswer(result.text);
    const code = readProposalCode(answer.text, languages);
    return {
      id, parentId: parent.id, depth: atDepth, aggregated: edges,
      artifact: code?.kind === 'runnable' ? code.code : answer.text,
      // A thought node has one `generateText`: it returned, so there is nothing
      // unfinished about it. A throw does not reach here at all.
      incomplete: null,
      answer: answer.text,
      proposal: answer.proposal,
      proposalError: answer.proposalError,
      granted: null,
      conclusion: null,
      transcript: [],
      usage: spent,
      modelId: result.response.modelId,
    };
  }
  const seed = branchSeed({
    parent, measured, baseline, verifier, atDepth, maxDepth,
    focus: prompt.user, context: input.context, aggregated: input.aggregated,
  });
  const run = await runNodeAgent({
    nodeId: id, rootId, parentId: parent.id, depth: atDepth,
    task: input.task,
    rationale: input.rationale,
    base: prompt.system,
    messages: input.context === 'fork' ? [...input.prefix, seed] : [seed],
    inherited: input.context === 'fork' ? inheritedAsSerialized(input.prefix) : [],
    context: input.context,
    mode,
    settle: resolved.settle,
    // THE HOSTED HALF OF THE ASSIGNMENT: a facet cannot take a live model over
    // RPC, so the slot's own SPEC rides the input and lands on
    // `HeadInput.model`, where `SubordinateAgent.runAsNode` resolves it through
    // the owner's registry. Undefined on an unrouted run, so the facet keeps
    // resolving its route default exactly as before.
    modelSpec: routed?.spec,
    // *Build-time exclusion*: the tool exists only where a branch could be granted.
    // Depth is what cannot change mid-run, so it gates the BUILD; the budget can
    // empty between the invitation and the answer, so it stays a runtime refusal
    // inside the arbiter.
    arbitrate: isTreeAdvance(resolved.config.advance.kind) && atDepth + 1 <= maxDepth
      ? (proposal) => budget.arbitrate({
        config: resolved.config, caps: resolved.caps, atDepth, proposal,
      })
      : null,
  }, agentNodes && routed !== undefined
    // THE ASSIGNED MODEL RIDES THE DEPS, per node: `NodeAgentDeps.model` is what the
    // in-isolate loop builds its turns on, and a shallow copy per child shares every
    // other seam (journal, arbiter, mission, host) the run already built once. The
    // copy is assigned rather than mutated, so `nodeDeps` itself still names the
    // run-level model and nothing downstream can observe one node's routing as
    // another's.
    ? { ...nodeDeps, model: assignedModel }
    : nodeDeps);
  log.event('swarm.node_settled', {
    preset: resolved.preset, node: id, depth: atDepth,
    status: run.report.status, steps: run.report.stepCount,
    tool_calls: run.report.toolCalls.length,
    wall_clock_ms: run.report.wallClockMs,
    isolation: run.isolation,
    reported: run.reportedItself ? 'self' : 'final-text',
  });
  // A NODE THAT REPORTED IS A CANDIDATE, whatever its report says — and `errored` is
  // not the exception it used to be here. This function threw on that status, so a node
  // that ran for four minutes, wrote its work and then met an expired credential
  // reached the barrier as a REJECTION: dropped from `candidates`, counted in `lost`,
  // and disclosed to the caller only as a smaller number. A live `preset:'ideate'` run
  // of three nodes returned `candidates: 1` and `stop:'budget'` that way, with nothing
  // in the result naming the other two or saying why, and their answers recoverable
  // only out of the workspace.
  //
  // The throw predates {@link Expansion.incomplete}, which is the mechanism for exactly
  // this and already names `errored` in its own docstring: an unfinished node is
  // carried, is NOT measured, is NOT scored, is NOT backpropagated, and says on its own
  // row why it stopped. So the two disagreed and the older one won. What the throw
  // guarded — an error message scored as an answer — `incomplete` guards for every
  // status alike, and one mechanism for "this node did not finish" is the point.
  //
  // A node that produced NO REPORT still rejects, from `runNodeAgent`: a transport that
  // failed before the loop has nothing to carry, and that is what `lost` counts.
  return {
    id, parentId: parent.id, depth: atDepth, aggregated: edges,
    artifact: run.candidate,
    // THE CLOCK IS NOT A SCORE. `completed` is the only status that produced an
    // answer; every other one produced a status line, and measuring a status line
    // ranks the node on when it stopped. The step count and wall clock are carried
    // because they are what distinguishes "aborted at step 26 of 500" from "errored
    // on step 1" for whoever reads the report.
    incomplete: run.report.status === 'completed'
      ? null
      : {
        status: run.report.status,
        detail: `${run.report.status} after ${String(run.report.stepCount)} step(s) in `
          + `${String(run.report.wallClockMs)} ms`
          + (run.report.errorMessage ? `: ${run.report.errorMessage}` : ''),
      },
    // An agent node REPORTS its candidate, so what it wrote and what the
    // instrument measures are the same string and there is nothing to strip.
    answer: run.candidate,
    proposal: null,
    proposalError: null,
    granted: run.granted?.kind === 'granted' ? run.granted : null,
    conclusion: run.candidate,
    transcript: [...input.prefix, seed, ...run.produced],
    usage: run.usage,
    // The node's own report already reached `reportModelCall` per node, so the
    // run does not report it twice — it only sums it for the settle report.
    modelId: null,
  };
}
