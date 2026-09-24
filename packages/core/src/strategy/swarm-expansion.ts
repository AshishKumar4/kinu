/**
 * One child's expansion: its prompt, inherited seed, shared conversation prefix, and
 * answer reading (*Inherited context*, *Arbitration*). Scheduling is the runner's.
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
import type { WorkMode } from '../types/turn';
import type { Expansion, TreeNode } from './swarm-tree';
import type { ModelCallSink } from '../events/model-call';

import { generateText } from 'ai';
import { normalizeUsage, type Usage } from '../usage';
import { callAccountOf } from '../providers/quota';
import { readProposalCode } from '../execution/code-fence';
import { runNodeAgent, type NodeAgentDeps } from './node-agent';
import type { RoutedNodeModel } from './swarm-setup';
import type { SwarmBudget } from './swarm-budget';
import type { BranchAssignment } from './swarm-level';

/** Ends an answer to request a branch; a line, not a fence, so code fences cannot match it. */
const PROPOSAL_MARKER = 'PROPOSE-BRANCH';

/** A branch proposal (*Arbitration*). Strict, and carries no depth: a node never states its own (*Node identity*). */
const BranchProposalSchema = v.strictObject({
  rationale: v.string(),
  branches: v.array(v.strictObject({
    task: v.string(),
    rationale: v.string(),
    context: v.picklist(SWARM_CONTEXTS),
  })),
});

interface ReadAnswer {
  /** The answer with any proposal block removed: what gets measured. */
  readonly text: string;
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
}

/** Split a node's output into its answer and proposed branch; a malformed proposal is named, not dropped. */
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
 * The proposal invitation for a thought node, offered only where a branch could be
 * granted (*Build-time exclusion*): `atDepth + 1 <= maxDepth`, matching `arbitrateBranch`.
 * The runtime refusal stays, since the budget can empty in between.
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
    + 'narrower sub-questions, each naming what it starts from: "inherit" for your own answer as '
    + 'context, "fresh" for its own focus and your conclusion alone)}. '
    + 'You are proposing, not spawning: the search decides, against a budget and a depth cap you '
    + 'cannot see, and you will be told the reason if it refuses. Omit the block entirely if no '
    + 'thread needs one.';
}

/** Measurements on the node's own path; gated on `context:'inherit'`. */
function pathFeedback(input: {
  readonly context: ResolvedSwarm['config']['context'];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly ancestors: readonly TreeNode[];
}): string {
  const { measured, baseline } = input;

  if (input.context !== 'inherit' || !measured || baseline === null) return '';
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
 * The best an earlier run of this objective reached, value and artifact, in the prompt.
 * Never written to the verifier's path: that would change the measured baseline.
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
 * A fan-in child gets every parent's answer quoted: the disagreeing answer is not on
 * disk. `FanInParent` lives in `fanin.ts`.
 */
function aggregatedAnswers(parents: readonly FanInParent[]): string {
  if (parents.length === 0) return '';

  return `\n\nThe ${String(parents.length)} answers this fan-in combines, each under the node that `
    + `produced it:\n${
      parents.map((parent) => `--- ${parent.id} ---\n${parent.answer}`).join('\n')
    }`;
}

/** The expansion prompt for one child. Every child receives an angle. */
export function branchPrompt(input: {
  readonly resolved: ResolvedSwarm;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly index: number;
  readonly branches: number;
  /** The search's task, or the sub-question an accepted proposal named. */
  readonly task: string;
  /** The parent's answer when inherited; null at the root or where inheritance is off. */
  readonly inherited: string | null;
  /** The barrier already handed this child the compacted view; never re-embed the verbatim answer. */
  readonly inheritedCompacted?: boolean;
  /** Parents this child fans in under `expand:'aggregate'`; empty for a sampling child. */
  readonly aggregated: readonly FanInParent[];
  /** Root-first, parent-last. Read only where `context` is `'inherit'`. */
  readonly ancestors: readonly TreeNode[];
  readonly atDepth: number;
  readonly maxDepth: number;
  /** The best record an earlier run of this objective left, or null. */
  readonly carried: ExplorationRecord | null;
  /** False for an agent node, which is invited by `propose_branch` instead. */
  readonly invite: boolean;
  /** Null for a count-based wave; see {@link BranchAssignment}. */
  readonly assignment: BranchAssignment | null;
}): ExplorePrompt {
  const { resolved, index, branches } = input;
  const { context, advance } = resolved.config;
  // The written brief, or the canned angle where none was written; never both.
  const angle = `\n\nYour angle: ${input.assignment?.brief ?? diversityAngle(index, branches)}.`;

  // Keyed off what this child received: a proposal may override inheritance per branch.
  const instruction = input.inherited !== null
    ? ' Improve what you have been given rather than starting over.'
    : ' Write your approach from scratch; do not assume what is already there is a good start.';

  // A compacted prefix already is the answer; re-embedding would double admission's measure.
  const inherited = input.inherited !== null
    ? `\n\nThe answer this branch continues from${input.inheritedCompacted === true ? ' is the compacted context you inherited.' : `:\n${input.inherited}`}`
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
    // Unconditional: every child is told what its siblings were sent, from the same set as the angle.
    siblings: input.assignment?.siblings ?? siblingAngles(index, branches),
    languages: input.languages,
  });
}

/** Window share at which the *Inherited context* compaction ladder may run; a caching judgement. */
const CONTEXT_COMPACTION_THRESHOLD = 0.85;

/** The model's identifier for the window lookup; an empty spec resolves to the default window. */
function modelSpecOf(model: LanguageModel): string {
  const asSpec = v.safeParse(v.string(), model);

  if (asSpec.success) return asSpec.output;
  const asModel = v.safeParse(v.object({ modelId: v.string() }), model);

  return asModel.success ? asModel.output.modelId : '';
}

/**
 * The *Inherited context* barrier: the one prefix every child of this parent inherits.
 * Verbatim below the threshold so siblings share a cacheable prefix; above it, compacted
 * once and cached on the parent so siblings compare on an identical view. With no ladder
 * the prefix is handed over whole and the absence is reported.
 */
export async function sharedPrefix(input: {
  /** The children's model, whose window the threshold is measured against. */
  readonly model: LanguageModel;
  readonly parent: TreeNode;
  /** As {@link SwarmRunDeps.compactShared}; narrowed so this module needs no runner import. */
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

  const window = contextWindowForModel(modelSpecOf(input.model)).window;
  const room = window * CONTEXT_COMPACTION_THRESHOLD;

  if (estimateTokens(chars) < room) return parent.transcript;

  if (!input.compactShared) {
    input.log.event('swarm.compaction_absent', {
      preset: input.preset, node: parent.id, depth: parent.depth,
      estimated_tokens: estimateTokens(chars), threshold: Math.round(room),
    });

    return parent.transcript;
  }

  // Keyed by the branch point's durable id so a re-entered search replays byte-stably;
      // the window is the one the threshold measured against.
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
 * The *Inherited context* seed, assembled by the engine, never by the parent, so a parent
 * cannot supply the number its child is told to beat. Uncomputed fields are absent.
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
  readonly aggregated: readonly FanInParent[];
  /** The barrier already handed this child the compacted view; point at the artifact, do not re-embed. */
  readonly inheritedCompacted?: boolean;
}): ModelMessage {
  const { parent, measured } = input;
  const parts: string[] = [];

  if (parent.conclusion) {
    parts.push(input.inheritedCompacted === true
      ? 'What the node you continue from concluded is the compacted context you inherited.'
      : `What the node you continue from concluded:\n${parent.conclusion}`);
  }

  if (input.verifier && parent.artifact !== null) {
    // Path and digest, so the child reads the artifact rather than a prose copy.
    parts.push(`Its candidate is at ${input.verifier.artifact} `
      + `(digest ${sha256Hex(parent.artifact, 12)}). Read it rather than reconstructing it.`);
  }

  if (measured && parent.measurement?.kind === 'measured') {
    parts.push(`That candidate measured ${String(parent.measurement.value)} ${measured.unit} on `
      + `${measured.metric}, against a target of ${String(measured.target)}. That is what you have `
      + 'to beat.');
  }

  if (input.aggregated.length > 0) {
    // Each parent's measured score beside its answer; unscored parents are not consumed.
    parts.push(`This node is a fan-in over ${String(input.aggregated.length)} parents: ${
      input.aggregated
        .map((fanIn) => `${fanIn.id} scored ${fanIn.score === null ? 'nothing' : fanIn.score.toFixed(3)}`)
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

/** The inherited prefix as the journal's `SerializedMessage` records it. */
export function inheritedAsSerialized(prefix: readonly ModelMessage[]): SerializedMessage[] {
  return prefix.map((message, index) => ({
    id: `p${String(index)}`,
    role: message.role,
    content: Array.isArray(message.content)
      ? JSON.stringify(message.content)
      : message.content,
    createdAt: index,
  }));
}

/** What one run hands every child spawn; built once per run. */
export interface ExpandChildCtx {
  readonly resolved: ResolvedSwarm;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly verifier: ResolvedVerifier | null;
  /** Read once before the loop: a fan-in vertex must beat the same number as every sampled child. */
  readonly carriedBest: ExplorationRecord | null;
  readonly agentNodes: boolean;
  readonly maxDepth: number;
  readonly nodeModel: LanguageModel;
  /**
     * Resolved per-node routing: child `i` runs entry `i % length`, or {@link nodeModel}
     * when empty. Each entry keeps the caller's spec for hosted facets (`HeadInput.model`).
     */
  readonly nodeModels: readonly RoutedNodeModel[];
  readonly signal?: AbortSignal;
  readonly nodeDeps: NodeAgentDeps;
  readonly budget: SwarmBudget;
  readonly rootId: string;
  readonly log: Logger;
  /** The mission ledger a thought node's one call charges where it returns. */
  readonly charge: (spent: Usage) => Promise<void>;
  readonly reportModelCall?: ModelCallSink;
}

/**
 * Expand one child: a wave sibling or a fan-in's aggregate vertex alike, so a merge node
 * is graded like any other candidate (*Merge-back*).
 */
export async function expandChild(ctx: ExpandChildCtx, input: {
  readonly parent: TreeNode;
  readonly id: string;
  readonly index: number;
  readonly width: number;
  readonly atDepth: number;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  readonly inherited: string | null;
  readonly aggregated: readonly FanInParent[];
  readonly ancestors: readonly TreeNode[];
  readonly prefix: readonly ModelMessage[];
  /** The caller's per-node `prompt` or the parent's per-branch `rationale`; null for a count-based wave. */
  readonly assignment: BranchAssignment | null;
  }): Promise<Expansion> {
  const {
    resolved, mode, languages, measured, baseline, verifier, carriedBest, agentNodes,
    maxDepth, nodeModel, nodeModels, signal, nodeDeps, budget, rootId, log, charge,
    reportModelCall,
  } = ctx;

  const { parent, id, atDepth } = input;
  /** The slot's assigned model, else the run's. A fan-in vertex is `index: 0`. */
  const routed = nodeModels.length > 0 ? nodeModels[input.index % nodeModels.length] : undefined;
  const assignedModel = routed?.model ?? nodeModel;
  const edges = input.aggregated.map((fanned) => fanned.id);

  // When the barrier fired, the compacted prefix carries the parent's work; do not re-send it verbatim.
  const inheritedCompacted = input.context === 'inherit' && parent.compacted !== undefined;

  const prompt = branchPrompt({
    resolved, mode, languages, measured, baseline,
    index: input.index, branches: input.width,
    task: input.task,
    inherited: input.inherited, inheritedCompacted,
    aggregated: input.aggregated,
    ancestors: input.ancestors, atDepth, maxDepth,
    carried: carriedBest,
    // Agent nodes are invited by the tool being present instead.
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
      account: callAccountOf(result.response),
    });
    // Charged where the call returned, so the level guard reads a current ledger; the
        // spawning caller must not charge this spend again.
    await charge(spent);
    const answer = readAnswer(result.text);
    const code = readProposalCode(answer.text, languages);

    return {
      id, parentId: parent.id, depth: atDepth, aggregated: edges,
      artifact: code?.kind === 'runnable' ? code.code : answer.text,
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
    inheritedCompacted,
  });

  const run = await runNodeAgent({
    nodeId: id, rootId, parentId: parent.id, depth: atDepth,
    task: input.task,
    rationale: input.rationale,
    base: prompt.system,
    messages: input.context === 'inherit' ? [...input.prefix, seed] : [seed],
    inherited: input.context === 'inherit' ? inheritedAsSerialized(input.prefix) : [],
    context: input.context,
    mode,
    settle: resolved.settle,
    // A live model cannot cross an isolate boundary; the spec lands on `HeadInput.model`.
    modelSpec: routed?.spec,
    // *Build-time exclusion*: depth gates the build; the budget stays a runtime refusal
        // inside the arbiter.
    arbitrate: isTreeAdvance(resolved.config.advance.kind) && atDepth + 1 <= maxDepth
      ? (proposal) => budget.arbitrate({
        config: resolved.config, caps: resolved.caps, atDepth, proposal,
      })
      : null,
  }, agentNodes && routed !== undefined
    // A per-child copy, so `nodeDeps` keeps the run-level model.
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

  // A node that reported is a candidate whatever its status; an unfinished one is carried
    // via {@link Expansion.incomplete}, not measured or scored. A node with no report
    // still rejects from `runNodeAgent` and counts as `lost`.
  return {
    id, parentId: parent.id, depth: atDepth, aggregated: edges,
    artifact: run.candidate,
    // Only `completed` produced an answer; others carry step count and clock, never a score.
    incomplete: run.report.status === 'completed'
      ? null
      : {
        status: run.report.status,
        detail: `${run.report.status} after ${String(run.report.stepCount)} step(s) in `
          + `${String(run.report.wallClockMs)} ms`
          + (run.report.errorMessage ? `: ${run.report.errorMessage}` : ''),
      },
    answer: run.candidate,
    proposal: null,
    proposalError: null,
    granted: run.granted?.kind === 'granted' ? run.granted : null,
    conclusion: run.candidate,
    transcript: [...input.prefix, seed, ...run.produced],
    usage: run.usage,
    // Already reported per node via `reportModelCall`; only summed here.
    modelId: null,
  };
}
