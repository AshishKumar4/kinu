/**
 * Running a resolved swarm: select, expand, measure, backpropagate, settle — and
 * refusing, by name, the resolved shapes no engine in this tree can execute
 * faithfully.
 *
 * Specified by docs/EXPLORATION.md — "The six axes", "One spelling per axis",
 * "Presets", "Validity over the resolved configuration", "Accepted and ignored",
 * "Refusals", "What the engine refuses outright", "The objective", "Witness
 * objectives", "The closed verifier registry", "Comparability", "The floor", "The
 * publication seal", "The records store", "The archive", "A node is an agent",
 * "Node identity", "Inherited context", "Arbitration", "Budget conservation", "The
 * journal read model", "Isolation", "Settle is derived" and "Merge-back". Handles
 * named alone below are that document's.
 *
 * WHAT RUNS HERE, AND WHY IT IS EXACTLY THIS. A resolved configuration is a search
 * TREE bounded by `depth` and widened by `branches`, and every axis it names is
 * realised rather than approximated:
 *
 *   - `branches` candidates per expansion. What ONE candidate costs is the `unit`
 *     axis: `answer` and `generator` run a real agent per node — a tool loop with
 *     its own turns and its own journalled transcript (`node-agent.ts`; *A node is
 *     an agent*) — while `thought` is the degenerate point *The six axes* names,
 *     one toolless generation, kept as the cheap tier. `expand:'sample'` starts a
 *     child from the workspace as found and `expand:'aggregate'` fans a level IN —
 *     see below;
 *   - `advance` through `mcts/frontier.ts` — the ONE scheduler, so `uct` re-widens,
 *     `best-first` takes the best unexpanded node and `none` expands the root once
 *     and stops;
 *   - sibling angles UNCONDITIONALLY: every child is handed its own angle and told
 *     its siblings', because the axis that claimed to gate this never did. This is
 *     also the whole of the run's candidate diversity, deliberately: Self-MoA
 *     (2502.00674) re-ran Mixture-of-Agents' own ablation over the same six models
 *     and found the HOMOGENEOUS ensemble beat the mixed one 65.7 vs 59.1 with the
 *     proposer count and topology held fixed, quality dominating diversity by up to
 *     3.2×. So a model zoo measures WORSE than repeated sampling from the best model
 *     when the purpose is variety, and prompt angle rather than model identity is
 *     where diversity is bought here;
 *   - `context:'fork'` by putting the MEASURED BASELINE and the measurements
 *     along this node's own path into the expansion prompt — at depth 1 the only
 *     ancestor is the workspace as found, which is why that arm is unchanged;
 *   - `score:'verify'` through the registry's instrument, one candidate at a time,
 *     because candidates share one workspace and a parallel measurement would measure
 *     whichever wrote last (the isolation gap *Isolation* names, respected rather
 *     than assumed away);
 *   - `settle` derived by `settleOf` and never chosen here.
 *
 * `expand:'aggregate'` MAKES THIS A DAG RATHER THAN A TREE, and it is the one axis value
 * whose claim is an ORDER. At each level barrier — where a wave has been measured and its
 * siblings compared — the level's parents are offered to merge-back as members in a
 * topological order of the dependency edges they declare, and the machinery specified
 * under *Merge-back* does the rest: members that agree accumulate, the first
 * disagreement spawns the merge node that IS the fan-in's vertex, a member whose base
 * the member before it moved is re-verified through the registry, and the transaction
 * bound is checked per member. So the DAG's structure and the DAG's merges are one
 * mechanism rather than two, a conflict has exactly one policy, and the vertex is
 * graded on the way back through the same
 * scoring body a sampled sibling takes (`fanInAtLevel`). The dependency edges live beside
 * the selection edge on the node, never instead of it: `search_nodes.parent_id` is what
 * selection descends and backpropagation walks, and one measurement reaching two ancestor
 * means would make the selector's comparison a fact about how many parents a node had.
 *
 * THE OBJECTIVE IS WHAT THE TREE CLIMBS, which is the whole reason this runner has a
 * tree of its own rather than dispatching onto `mcts/engine.ts`. That engine scores by
 * judge ensemble and execution verdict with no seam for a verifier, so a verify-scored
 * call sent to it would report a judge's number under the objective's name — the
 * exact lie *Accepted and ignored* exists to refuse. What IS reused is its tree
 * machinery, which is objective-agnostic and proven: `uct.ts` for selection (and its
 * WHERE-clause depth cap), `backpropagation.ts` for the ancestor mean,
 * `record-node.ts` for the one INSERT, `pruning.ts` for retirement. The reward those
 * receive is `normalisedScore` over the caller's own metric.
 *
 * A NODE DOES NOT SPAWN CHILDREN — it PROPOSES, and `advance` arbitrates
 * (*Arbitration*). An AGENT node proposes by calling `propose_branch` and the verdict
 * is that tool's return value, so a refusal's text is the node's next instruction. A
 * THOUGHT node has no tool to be answered through, so its proposal is a marker line
 * the engine reads out of its text and its verdict is a typed diagnostic event; that
 * path is
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
 * (*Budget conservation*: the allocations granted to a node's children must SUM to no
 * more than the parent's remaining budget). Depth and width bound the shape;
 * conservation bounds the spend.
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
 * That obligation is named rather than assumed away, and it is now LIVE rather
 * than hypothetical: on a host whose filesystem is in this isolate, `provisionHome`
 * is wired and every agent node reports `isolation:'private-home'`, which is a node
 * acquiring a storage identity no existing branch holds — exactly the case the
 * preservation theorem does not reach. On a host without a uid-0 view the value is
 * `shared-origin-plane`, the search creates no per-node storage, and the workspace
 * is the ORIGIN's one plane exactly as before. What THAT costs is attribution, and
 * the engine pays it the only honest way: a node is graded on the candidate it
 * REPORTS, never on a diff of a tree every node wrote — which is why the grading
 * rule is the same under both values and needs no theorem at all.
 */
import { generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import * as v from 'valibot';
import { DEFAULT_CONFIG } from '../config';
import { diversityAngle, siblingAngles } from '../mcts/diversity';
import { explorePrompt, type ExplorePrompt } from '../mcts/explore-prompt';
import { initSearchTables } from '../mcts/schemas';
import { initMctsSearchTable, MctsSearchStore, type PersistedSearchKnobs } from '../mcts/search-store';
import type { SwarmProfileSnapshot } from '../profiles';
import { insertSearchNode } from '../mcts/record-node';
import { backpropagate } from '../mcts/backpropagation';
import { pruneLowValueBranches } from '../mcts/pruning';
import { selectFrontierNode, type FrontierPolicy } from '../mcts/frontier';
import { evaluateWithMultiModelJudging } from '../mcts/evaluation';
import type { BranchEvaluation } from '../mcts/evaluation';
import { readProposalCode } from '../execution/code-fence';
import { extractJsonObject } from '../prompts/structured';
import { diagnostics, renderThrownChain, type Logger } from '../obs/index';
import {
  KinuError, refusalOf, renderCauseChain, toKinuError, type Refusal,
} from '../obs/error';
import { renderIssues } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { normalizeUsage, usageTotal, type Usage, addUsage } from '../usage';
import { estimateTokens } from '../llm';
import { contextWindowForModel } from '../context-window';
import { HeadJournal } from '../heads/journal';
import { initHeadsTables } from '../heads/schema';
import { runNodeAgent } from './node-agent';
import type { NodeAgentDeps, NodeLoopHost } from './node-agent';
import { SwarmBudget, type BranchDecision, type BranchGrant } from './swarm-budget';
import { sha256Hex } from '../safety/argument-digest';
import type { NodeWorkspaceProvisioner } from './node-workspace';
import type { HeadReport, SerializedMessage } from '../heads/types';
import { missionMeter, type MissionScope } from '../mission-budget';
import type { WebSearchProvider } from '../web/index';
import {
  preflightVerifier, registeredVerifierKind, resolveVerifier, unregisteredKindRefusalFor,
  type ResolvedVerifier,
} from './verifier-registry';
import {
  carrySuppression, floorMargin, isBetter, normalisedScore, PUBLISHING_CARRIES,
} from './objective';
import type {
  ExplorationRecord, Floor, Measurement, MeasurementContext,
  Objective, ObjectiveDirection, ObjectiveIdentity, ObjectiveScale, PublicationState,
  PublishingCarry, VerifierSource,
} from './objective';
import {
  archiveRegionRefusal, configDigestOf, isTreeAdvance, judgeCallPool,
  judgeMarginalisationRefusal, JUDGE_MARGINALISATION_MIN,
  BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS, SWARM_TREE_ADVANCES,
} from './swarm';
import {
  initExplorationRecordsTable, recordExploration, recordsFor, verifierDigestOf,
} from './records';
import type { ExplorationRecordsReport, ExplorationWrite } from './records';
import { admitToArchive, archiveCellOf } from './archive';
import type { ArchiveVerdict } from './archive';
import {
  baseDigestOf, memberDigestOf, mergeBack, mergePolicyOf, originReader, settleCarry,
  type MemberApply, type MemberDiff, type MergeBackDeps, type MergeMember,
  type MergeNodeRequest, type Reverifier,
} from './merge-back';
import {
  initSwarmNodeRecords, markSwarmNodeMerged, recordSwarmNode, reenterSwarm,
  type ChildOutcome,
} from './swarm-resume';
import type { VFS } from '../types/primitives';
import type {
  BranchContext, BranchProposal, BranchRefusalPolicy, BranchVerdict, JudgeEnsembleReport,
  ResolvedSwarm, SwarmAdvance, SwarmCandidate, SwarmFanInReport, SwarmPreset, SwarmResult,
  SwarmResumeReport, SwarmSettleReport,
} from './swarm';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSink } from '../events/model-call';
import type { WorkMode } from '../prompting/surface';

/**
 * The lease epoch a swarm's FIRST attempt writes, and the reason the number matters.
 *
 * `MctsSearchStore.begin` writes zero, and every attempt after the first claims a
 * higher one through `reclaim` (`swarm-resume.ts`). That fencing is live rather than
 * decorative now: a swarm HAS a resume, so an executor from the activation that was
 * evicted could still be holding the old lease, and a `converge` from it would settle
 * a row a re-entry is making progress on. Every ledger write below is stamped with
 * this run's own epoch for exactly that reason.
 */
const SWARM_FIRST_LEDGER_EPOCH = 0;

/**
 * What a node's row in the head journal records when a re-entry takes over the attempt
 * that spawned it.
 *
 * Written into `head_journal.error_message`, which the Exploration surface shows
 * verbatim, so it is worded for the person reading the node — the same reason
 * `heads/controller.ts` words `RECLAIMED_RUN_REASON` that way. Two observations and no
 * cause: the row said "spawned, never reported", and this run found nothing left that
 * could report it.
 */
const RESUMED_SWARM_NODE_REASON =
  'Interrupted before it reported. This search was re-entered from its durable rows, '
  + 'and the nodes after it are the continuation.';

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
   * A caller-declared wall clock for ONE agent node, observed at its step
   * boundaries. OPTIONAL — there is no default clock over a node's work (owner
   * ruling, 2026-08-21: no per-turn bounds). Absent, a node runs until its work
   * is done; present is a search or a test declaring a tighter deadline. The
   * derived-default this field used to fall back to was the product of a deleted
   * step cap and a deleted turn envelope — the exact per-turn bounds the ruling
   * removed.
   */
  readonly maxWallClockMs?: number;
  /**
   * The mission ledger this run charges, per model call, as the calls happen.
   *
   * EVERY MODEL CALL THIS RUN MAKES, not some of them: an agent swarm node's steps
   * debit inside its own loop, and a toolless node's one call debits where it returns.
   * The caller that spawned the search must therefore charge NO lump for it afterwards
   * — the two would be the same tokens twice, and a silent double bill is
   * indistinguishable from the cap working.
   *
   * Absent = unbudgeted, the default, and then nothing here queries or writes.
   */
  readonly mission?: MissionScope;
  /**
   * The origin agent's own conversation, which is what a swarm's ROOT starts from.
   *
   * *Inherited context*: a root that started blank would throw away precisely the
   * context that made the caller decide to search. This is the caller-to-root edge, and
   * it is the same axis as every branch edge — `context:'fork'` gives the first level
   * this prefix verbatim, `'fresh'` gives it the task block and the seed alone.
   *
   * Absent means the caller wired none, and then the first level starts from the task
   * block. Absent rather than empty-and-claimed: a run whose root inherited nothing is
   * a different run from one whose caller had nothing to inherit.
   */
  readonly originContext?: readonly ModelMessage[];
  /** The per-node home provisioner *Isolation* requires. Absent on a host with no
   *  uid-0 view, and then every node reports `shared-origin-plane` rather than
   *  pretending otherwise. */
  readonly provisionHome?: NodeWorkspaceProvisioner;
  /**
   * Where a TOOL-USING node's loop runs.
   *
   * Present hands each answer or generator node to a host that gives it its own
   * storage and its own shell state — on the Cloudflare backend an
   * `ExplorationAgent` facet, the same host a fork's head already runs in. Absent
   * runs the loop in this isolate, which is the honest answer for a backend with
   * no facets rather than a refusal: the body is the same function either way, so
   * an absent host costs a node nothing but its storage boundary.
   *
   * `unit:'thought'` NEVER reaches this, and that is the rule rather than an
   * omission: a thought node is one toolless `generateText` call that acquires no
   * tools, no journal row and no shell, so there is nothing for a facet to
   * isolate and the storage-isolation proof already covers it for exactly that
   * reason. The dispatch that enforces it is `agentNodes` below.
   */
  readonly host?: NodeLoopHost;
  /** Backend-built `execute_tools` and live research, handed to every agent node.
   *  Absent means the node's surface is narrower, not broken. */
  readonly executeTool?: unknown;
  readonly webSearch?: WebSearchProvider;
  /**
   * The compaction barrier over *Inherited context*: rewrite one parent's context
   * ONCE, for every child of that parent to share.
   *
   * A SEAM and not an implementation, for the reason *One spelling per axis* gives.
   * `packages/compaction` is the @better-compact ladder that actually rewrites
   * history, and core does not depend on it, so a summariser written here would be a
   * second ladder that drifts from the real one. What the engine owns is the POLICY —
   * the ~85% threshold, and firing once per branch point so the shared view cannot
   * become part of what siblings are ranked on — and that policy is testable without a
   * summariser. Absent means no compaction: a parent past its window inherits
   * verbatim and the provider refuses, which is a loud failure rather than a silent
   * paraphrase of the objective.
   */
  readonly compactShared?: (
    messages: readonly ModelMessage[],
    basis: { readonly contextWindow: number; readonly key: string },
  ) => Promise<readonly ModelMessage[]>;
  /**
   * The resolved turn profile this run STARTED under, with its precedence
   * sources. Written into the run's ledger row at `begin` — before any node
   * expands, which is the moment a durable detach becomes possible — so a
   * re-drive re-enters under THIS record instead of resolving against
   * today's catalog. Absent: the caller wired no profile authority, and the
   * run records none.
   */
  readonly profile?: SwarmProfileSnapshot;
  /**
   * Turns a resolved tier's model SPEC into the model a node runs on.
   *
   * Wired by `agents-tool.ts` from `AgentsForkDeps.resolveModel`, which every
   * backend with a profile authority supplies. It exists because {@link model}
   * is the CALLER's turn model and a delegation's `tier` is documented as the
   * one routing input: without this seam the run recorded the tier's model in
   * {@link profile} and then ran the caller's, so the spend and the provenance
   * both named a model that never executed.
   *
   * Required whenever {@link profile} is present — the run REFUSES otherwise
   * rather than run one model under a record naming another. Absent with no
   * profile is the unrouted case: no catalog, no tier, nodes run {@link model}.
   */
  readonly resolveModel?: (spec: string) => LanguageModel;
  /**
   * This call is an evict/exit RE-DRIVE of a durable job row, so it RE-ENTERS the
   * interrupted search for this task rather than starting a new one.
   *
   * Set by `orchestrator/background-tools.ts` and by nothing else — the delegation
   * tool reads the marker off the call's options bag
   * (`jobs/threshold.ts` {@link RESUME_REDRIVE_OPTION}) and passes it here. It is a
   * property of the CALL rather than of the input, because the input is the durable row
   * and a re-drive replays it verbatim: there is nothing in it that could tell the two
   * apart.
   *
   * Absent (the default) is a first call, and a first call never adopts another run's
   * tree — which is what keeps two concurrent `agents.swarm` calls with the same task
   * from growing one search between them.
   */
  readonly redrive?: boolean;
}

/** The scalar half of an objective — the metric, direction, scale, target, floor and
 *  instrument a measured run needs. A `witness` hunt supplies its `proxy`'s, which is
 *  the rule in *Witness objectives* that the proxy is what the search optimises. */
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
  // BOTH multi-axis kinds return null, and `instanced` was the one that did not. It
  // carries every field a scalar does, so it fell through this function and was measured
  // as though its `instances` were not there — the refusal below already said "measured
  // per component or per instance" while only the component half was reachable. A run
  // that reduces a declared front to one aggregate number is the accepted-and-ignored
  // axis *Accepted and ignored* refuses, so the objective's own kind is what refuses.
  if (objective.kind === 'vector' || objective.kind === 'instanced') return null;
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
  return refusalOf(new KinuError('unsupported', error));
}

function unavailable(error: string): Refusal {
  return refusalOf(new KinuError('unavailable', error));
}

function badInput(error: string): Refusal {
  return refusalOf(new KinuError('bad_input', error));
}

/**
 * Whether this tree can execute the resolved shape, or the refusal naming what it
 * would have needed.
 *
 * Every arm names the one thing that is missing and the one move that fixes it, because
 * *Refusals* holds that a refusal offering two remedies was measured being corrected to
 * the wrong one.
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
  // shape is what `answer` and `generator` now are, and `thought` is the degenerate
  // point *The six axes* names, kept as the cheap tier. All three execute below.
  // NO `score` ARM REFUSES `judge` ANY MORE, and this is the second time the absence is
  // the ticket. It was refused because "judge needs the marginalised ensemble the
  // shipped tree owns" — and the tree DOES own one: `mcts/evaluation.ts` marginalises a
  // judge over samples, clamps the ensemble against the per-evaluation call budget and
  // reports the size it actually ran. Nothing about it is tree-shaped; it takes a task,
  // a candidate's text, an executor and two LLMs. So the ensemble is REACHED below
  // rather than reimplemented, which is what the refusal was pointing at all along.
  //
  // What survives is the one refusal that is about the measurement rather than about
  // the wiring: a judged TREE below the marginalisation floor runs a scorer the
  // literature says is not worth building, and it is refused here as well as in
  // `swarmValidity` because this function is also the in-process entry point.
  const marginalisation = judgeMarginalisationRefusal(config);
  if (marginalisation) return marginalisation;
  if (isTreeAdvance(config.advance.kind) && config.score.kind === 'none') {
    // Unreachable through `swarmValidity`, which refuses this composition outright.
    // Kept because this function is also the in-process entry point.
    return badInput(`advance:"${config.advance.kind}" cannot select without a score.`);
  }
  // `advance:'archive'` RUNS — see `admitToArchive` at the settle barrier. The refusal it
  // used to share with `pareto` said both "need a store this run has no writer for", and
  // that sentence was one refusal covering two different causes: the store landed, and
  // `exploration_records` IS the archive's grid — a row keyed by a descriptor, one elite
  // per cell, monotone, sealed. What refuses below is the archive's own region, checked
  // through the predicate `swarmValidity` shares so an in-process caller cannot run a
  // shape the tool surface refuses.
  const archive = archiveRegionRefusal(config, caps);
  if (archive) return archive;
  if (!resolved.key && config.advance.kind === 'archive') {
    // Unreachable through `swarmValidity`, which refuses an archive with no descriptor
    // outright. Kept because this function is also the in-process entry point, and
    // because everything below binds the cell to this field.
    return badInput('advance:"archive" bins its elites by a descriptor and this call named none. '
      + 'Supply `key`, naming a quantity the objective\'s own instrument reports.');
  }
  if (config.advance.kind === 'pareto') {
    // AND THIS IS THE OTHER CAUSE, now stated as itself. `pareto` is not waiting on a
    // store: `swarmValidity` already requires its objective to be `instanced` or
    // `vector`, and this runner measures NEITHER — `measuredHalf` refuses both above,
    // one `MeasuredObjective` carries a single metric and direction, the tree's reward is
    // `normalisedScore` over that one value, and `MeasuredValue.perInstance` is read
    // nowhere. A front here would be an argmax over an aggregate reported as a frontier,
    // which is the shape *Settle is derived* forbids.
    return unsupported('advance:"pareto" selects the NON-DOMINATED set, and being non-dominated is a '
      + 'statement about several axes: `objective` must be kind:"instanced" or kind:"vector" for the '
      + 'front to exist at all. This runner measures one number per candidate — one metric, one '
      + 'direction, one normalised reward — and reads neither a per-instance vector nor a per-metric '
      + 'one, so it would report an argmax over an aggregate as a frontier. What is missing is a '
      + 'per-instance measurement path and a dominance comparison, not a store. Use advance:'
      + `"${SWARM_TREE_ADVANCES.join('"/"')}" over kind:"scalar", which is the aggregate that argmax `
      + 'was over.');
  }
  // `expand:'aggregate'` RUNS — see `fanInAtLevel`. What refuses here is a composition
  // in which a fan-in could never HAPPEN, and each arm names the one thing that makes it
  // impossible. A composition that resolved and then quietly aggregated nothing would
  // be the accepted-and-ignored axis *Accepted and ignored* refuses, which is the
  // defect the refusal it replaces was written against — the refusal was true about
  // the engine and is not any more.
  if (config.expand === 'aggregate') {
    if (depth.value < 2) {
      return badInput('expand:"aggregate" is fan-in — k parents consumed by one child — and a '
        + `fan-in needs a level to consume. depth:${String(depth.value)} runs one wave off the `
        + 'root, whose level is the root alone, so nothing would ever be aggregated. Raise `depth` '
        + 'past 1, or use expand:"sample" for one flat wave of independent candidates.');
    }
    if (!isTreeAdvance(config.advance.kind)) {
      return badInput(`expand:"aggregate" needs a second level and advance:"${config.advance.kind}" `
        + 'has no selection step, so this search stops after the root\'s one wave and no level is '
        + `ever consumed. Use one of ${SWARM_TREE_ADVANCES.join('/')}.`);
    }
    if (config.score.kind !== 'verify') {
      // NOT "judge cannot score". It scores, and the ensemble is reached above — what it
      // does not do is PLACE a candidate. A fan-in merges its parents' work, and a
      // member's diff is the answer this engine wrote to the verifier's own artifact
      // path; a judged run has no such path, so there is nothing for a fan-in to take a
      // diff against and no measured verdict for merge-back's binding rule — *A verdict
      // is bound to the exact pair it was issued over* — to read.
      return badInput('expand:"aggregate" merges what its parents produced, and a member\'s diff is '
        + `the candidate this engine PLACED at the objective's own path. score:"${config.score.kind}" `
        + 'names no path and issues no measured verdict, so every fan-in could only refuse for want '
        + 'of one. Use score:"verify" with an `objective` to fan in, or expand:"sample" to keep the '
        + 'scorer and lose the DAG.');
    }
  }
  return null;
}

/** The workspace, as an instrument sees it. The two members *Measurement context* names
 *  and no others: no model, no network, no trajectory. */
function measurementContext(rt: AgentRuntime): MeasurementContext | null {
  const shell = rt.shell;
  if (!shell) return null;
  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** The measured baseline this instrument reported alongside a candidate, or null when
 *  the kind measures none. *Measured baseline*: measured, never asserted. */
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
 *
 * A TYPE RATHER THAN A NARROWED {@link TreeNode}, because "consumable" is a real
 * predicate and this is its output: a node with no answer or no score cannot be a
 * parent of a fan-in, and carrying it as a `TreeNode | null` would push that check
 * into every reader.
 */
interface FanInParent {
  readonly id: string;
  readonly answer: string;
  readonly score: number | null;
  readonly aggregated: readonly string[];
}

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
    // were sent, because the axis that claimed to hide them never did.
    siblings: siblingAngles(index, branches),
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
async function sharedPrefix(input: {
  /** The model the CHILDREN of this parent run on, which is the window this
   *  threshold has to be measured against — the caller's own model is not what
   *  will be asked to hold the prefix. */
  readonly model: LanguageModel;
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
  const window = contextWindowForModel(modelSpecOf(input.model));
  const room = window * CONTEXT_COMPACTION_THRESHOLD;
  if (estimateTokens(chars) < room) return parent.transcript;
  if (!deps.compactShared) {
    input.log.event('swarm.compaction_absent', {
      preset: input.preset, node: parent.id, depth: parent.depth,
      estimated_tokens: estimateTokens(chars), threshold: Math.round(room),
    });
    return parent.transcript;
  }
  // The key is the branch point's durable id, so a re-entered search replays the same
  // plan byte-stably instead of re-summarising; the window is the one this threshold
  // measured against, so the ladder and the policy never disagree about pressure.
  const shared = await deps.compactShared(parent.transcript, {
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
function branchSeed(input: {
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
 * HOW A NODE STOPPED SHORT: the report's own status, and the line a reader gets.
 *
 * `completed` is excluded by the type rather than by a convention, because a stop is
 * exactly what a node that finished does not have.
 */
interface NodeStop {
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
interface Expansion {
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
type NodeAnswer =
  | { readonly kind: 'expanded'; readonly expansion: Expansion }
  | { readonly kind: 'failed'; readonly error: KinuError };

/** One member of a level as the barrier waits on it: the node's own run, and its id. */
interface LevelMember {
  readonly id: string;
  readonly node: Promise<Expansion>;
}

/** What one member of a level came to, named against its id so the caller can settle
 *  and report the member it belongs to. */
interface LevelAnswer {
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
async function awaitLevel(members: readonly LevelMember[]): Promise<readonly LevelAnswer[]> {
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
function frontierPolicyOf(advance: SwarmAdvance): FrontierPolicy | null {
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
 * finished its one call and there is no channel back to it. *Arbitration* requires the
 * answer to exist and states where it lands when the asker cannot receive it; this is
 * that place, with a stable dotted name so the refusals are queryable rather than merely
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
 * it (*Budget conservation*, and `swarm-budget.ts`'s header).
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

/**
 * THE REPORT CONTRACT (*The report contract*): the gate a node's own `report` call runs
 * through when this run has an instrument.
 *
 * The owner's ask, and it is one sentence: *"If it's something that is verifiable, run
 * and compute the metric/results — and block the report tool until it runs
 * successfully, else return the error to the agent."* What shipped ran the instrument
 * LATER, at the settle barrier, so a node whose answer the instrument could not run at
 * all learnt nothing and arrived as an unmeasurable candidate with the node long gone.
 * The information existed; nothing delivered it to the one agent that could act on it.
 *
 * IT GATES ON RUNNABILITY, NOT ON SCORE, and the distinction is the whole design. A
 * candidate the instrument measures passes, whatever the number — grading stays at the
 * barrier, because *No self-grading* means a node never supplies the quantity it would
 * have to lie about. A candidate the instrument reports `unmeasurable` for, or throws
 * on, is turned back with the reason as the node's next instruction.
 *
 * SERIALISED, for {@link measureChild}'s exact reason and not by analogy with it: every
 * candidate is written to the SAME path, and nodes run in PARALLEL, so two gates racing
 * would each measure whichever wrote last. The lane is one promise chain.
 *
 * THE LANE COSTS THE LAST NODE `width x instrument`, and that wait happens INSIDE its
 * turn, under the stream-inactivity watchdog — which counts a silent tool call as a
 * stall, deliberately and on measured grounds (`chat.ts`: "a tool call that never
 * returns stalls the same turn through the same silence"). So a run whose instrument
 * takes t seconds gives its last node `width x t` of silence to survive, against a
 * five-minute default. It is stated rather than guarded because the alternative is a
 * per-node artifact path, and where the candidate is written is the verifier contract's
 * to decide, not this function's.
 *
 * A THROW IS THE INSTRUMENT BREAKING, and here it is still returned to the node rather
 * than failing the run. At the barrier a throw means no number can be trusted; here it
 * means this candidate could not be placed, and the node is the party that can try
 * something else. The barrier keeps its own verdict either way — this gate decides
 * nothing the run records.
 */
function reportGate(input: {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
}): (candidate: string) => Promise<string | null> {
  const { ctx, verifier } = input;
  let lane: Promise<unknown> = Promise.resolve();
  return (candidate: string): Promise<string | null> => {
    const measured = lane.then(async (): Promise<string | null> => {
      let measurement: Measurement;
      try {
        // The WRITE is inside the try beside the measurement, so this function has one
        // failure story rather than two: everything between placing the candidate and
        // reading the verdict is the instrument's attempt, and the node hears about all
        // of it. It also makes the returned promise total, which is what lets the lane
        // below advance without a catch that would flatten a rejection into a value.
        await ctx.vfs.writeFile(verifier.artifact, candidate);
        measurement = await verifier.verify(ctx);
      } catch (error) {
        return `the verifier could not run over what you reported: `
          + `${renderThrownChain({ cause: error })}. Fix the answer and report again.`;
      }
      if (measurement.kind === 'unmeasurable') {
        return `the verifier ran and could not measure what you reported: ${measurement.detail}. `
          + 'Fix the answer and report again — a report the instrument cannot read is a '
          + 'candidate the search cannot score.';
      }
      return null;
    });
    // The lane advances on the MEASUREMENT rather than on the caller, so a node that is
    // cancelled between the two cannot leave the next one measuring its file. No catch
    // is needed and none is written: the function above returns the instrument's
    // failures as text, so this promise does not reject.
    lane = measured;
    return measured;
  };
}

/**
 * Measure one child: write it to the path the instrument reads, run the instrument,
 * and classify what came back.
 *
 * Sequential by construction — every candidate is written to the SAME path, so a
 * parallel measurement would measure whichever wrote last. That is the isolation gap
 * *Isolation* names, respected rather than assumed away, and it is also why a node needs
 * no storage of its own: the engine places the answer, the engine measures it.
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
      error: renderThrownChain({ cause: error }),
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
 * Score one child by the MARGINALISED JUDGE ENSEMBLE the shipped tree already owns.
 *
 * REACHED, not reimplemented. `mcts/evaluation.ts` runs `samples` independent judge
 * calls over one prompt, takes their MEDIAN, drops the ones that timed out or would not
 * parse, and clamps the ensemble against the per-evaluation call budget — and it is
 * objective-agnostic, taking a task, a candidate's text, an executor and two LLMs. A
 * second ensemble written here would be the drifting second spelling this file refuses
 * everywhere else, and it would also lose the clamp disclosure, which is the one thing
 * about this scorer that was measured going silent.
 *
 * THE POOL IS FUNDED FROM THE REQUEST. `maxEvalLLMCalls` is the whole per-evaluation
 * call pool that check generation and the ensemble share, and this path used to hand the
 * evaluator the MCTS engine's shipped 4 — so a judged tree admitted at the
 * marginalisation floor of 20 realised `min(20, 4 − 1) = 3`. {@link judgeCallPool} sizes
 * the pool at `samples + 1` instead, so the clamp cannot bind.
 *
 * AN ENSEMBLE SHRINKS TWO WAYS AND BOTH ARE REFUSED HERE. The pool is one: it decides
 * how many calls are ASKED FOR, and a shortfall there means the evaluator did not honour
 * the budget it was handed. Dropped samples are the other, and they are the door the
 * pool fix does not close: `completeWithinTimeout` returns null for a judge call that
 * lost its race and `sampleJudgeScore` returns null for one that would not parse, so the
 * median can be taken over far fewer opinions than were asked for. Under sustained rate
 * limiting, the transport may spend three 180 s retry windows waiting to send against
 * the judge's 600 s envelope, so this is reachable rather than theoretical. Found by
 * `SwarmRuntimeFix` while pacing the provider, and it is the same defect the pool fix
 * removes arriving by another door: an
 * ensemble admitted at one size and MEDIANED at another.
 *
 * SO THE REPORTED ENSEMBLE IS THE ONE THE MEDIAN WAS TAKEN OVER, `judgeSamplesUsed`,
 * rather than the number asked for. A run whose realised marginalisation falls below
 * `minEnsemble` fails rather than scoring: below the floor the measurement says the
 * scorer is not worth building, and a caller who wants headroom against drops asks for
 * more than the floor rather than being quietly given less.
 *
 * A THROWN judge is the instrument breaking and takes the run down through the same arm
 * a thrown verifier does (*The closed verifier registry*). It is NOT converted into a
 * badly-scored candidate: a judge that failed produced no opinion, and scoring the
 * candidate on the absence of one is the accepted-and-ignored lie in its purest form.
 */
async function judgeChild(input: {
  readonly rt: AgentRuntime;
  readonly mode: WorkMode;
  readonly samples: number;
  /** The smallest median this run may be scored by: {@link JUDGE_MARGINALISATION_MIN}
   *  down a tree, where the floor is stated, and 1 for a flat run, where it is not —
   *  but where a median over nothing is still not an opinion. */
  readonly minEnsemble: number;
  readonly task: string;
  /** The node's output AS WRITTEN — fences intact. Not the extracted artifact: the
   *  judge grades the answer, and stripping it to its code hides the reasoning the
   *  ensemble is being asked about. */
  readonly answer: string;
  readonly siblings: readonly string[];
  readonly siblingsProducedCode: boolean;
}): Promise<ChildOutcome> {
  const { rt } = input;
  const options = {
    task: input.task,
    trajectory: input.answer,
    siblings: input.siblings,
    siblingsProducedCode: input.siblingsProducedCode,
    // Plan mode never invokes the executor, so its evaluation is judge-only and spends
    // no call on a check suite — the same gate `mcts/engine.ts` applies.
    executionPolicy: input.mode === 'plan' ? ('judge-only' as const) : ('grounded' as const),
    executor: rt.executor,
    explorer: rt.llm,
    judgeSamples: input.samples,
    // FUNDED AT THE REQUEST, which is the whole of the judge-ceiling fix. This used to
    // be `DEFAULT_CONFIG.mcts.maxEvalLLMCalls` — the MCTS engine's dial, 4, sized for
    // that engine's own `judgeSamples: 3` — so every judged swarm realised
    // `min(samples, 3)` no matter what the marginalisation floor admitted. See
    // {@link judgeCallPool}.
    maxLLMCalls: judgeCallPool(input.samples),
  };
  let evaluation: BranchEvaluation;
  try {
    // A cross-model judge where the runtime holds one, and the explorer where it does
    // not — the documented fallback, spelled as an ABSENT KEY rather than an explicit
    // `undefined` for `nodeDeps`' reason.
    evaluation = rt.judgeModel === undefined
      ? await evaluateWithMultiModelJudging(options)
      : await evaluateWithMultiModelJudging({ ...options, judge: rt.judgeModel });
  } catch (error) {
    return {
      kind: 'instrument-faulted',
      error: renderThrownChain({ cause: error }),
    };
  }
  if (evaluation.judgeSamplesAttempted > 0
    && evaluation.judgeSamplesUsed < input.minEnsemble) {
    // THE DROPPED-SAMPLE DOOR. The calls were asked for and some of them answered with
    // nothing — a timeout or an unparseable reply — so the median stands on fewer
    // opinions than the floor this run was admitted at. Refused rather than scored,
    // because a median over four samples reported as a twenty-sample ensemble is the
    // silent downgrade in its purest form.
    return {
      kind: 'instrument-faulted',
      error: `the judge ensemble answered with ${String(evaluation.judgeSamplesUsed)} usable `
        + `samples of the ${String(evaluation.judgeSamplesAttempted)} asked for, below the `
        + `${String(input.minEnsemble)} this run was admitted at, so its median is a different `
        + 'scorer from the one validity checked. A judge call that times out or will not parse '
        + 'is dropped, so ask for more than the floor where the provider is being rate-limited.',
    };
  }
  if (evaluation.judgeSamplesAttempted > 0
    && evaluation.judgeSamplesAttempted < input.samples) {
    // UNREACHABLE BY CONSTRUCTION, and stated anyway. The pool above is sized so the
    // clamp cannot bind; if it binds regardless, the evaluator did not honour the
    // budget it was handed, and a candidate scored by a smaller ensemble than the one
    // this run was admitted at is exactly the silent downgrade the fix exists to
    // remove. It is the instrument breaking, so it takes the run down the way a thrown
    // verifier does rather than returning a number nothing validated.
    return {
      kind: 'instrument-faulted',
      error: `the judge ensemble realised ${String(evaluation.judgeSamplesAttempted)} of the `
        + `${String(input.samples)} samples this run was admitted at, so its median is a different `
        + 'scorer from the one validity checked. The per-evaluation pool was sized at '
        + `${String(judgeCallPool(input.samples))} calls for exactly this reason.`,
    };
  }
  return {
    kind: 'judged',
    score: evaluation.score,
    // USED, not attempted: the ensemble is the number of opinions the median stands on,
    // and reporting the number asked for would restate the request as a result.
    ensemble: evaluation.judgeSamplesUsed,
    grounding: evaluation.grounding,
  };
}

/**
 * Run a resolved swarm, or refuse.
 *
 * The refusals are ordered by what they cost: shape first (free), then the caps, then
 * the instrument, then the BASELINE — because the measurement *Measured baseline*
 * requires is the first thing that spends anything, and a run that will not start must
 * not spend it.
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
  // The judge ensemble's request, or null for a run that scores by anything else. The
  // number is on the axis VALUE — `samples` is tagged onto `score:'judge'` — so a
  // judged run always states it and there is no default to inherit here.
  const judgeSamples = resolved.config.score.kind === 'judge' ? resolved.config.score.samples : null;
  // The `carry` values whose whole purpose is publication. A run under one of them is
  // part of a CUMULATIVE sequence: it reads what earlier runs reached and writes what it
  // reached. `none` and `reflections` write nothing a later run reads, and seeding one
  // from the store would make the axis a lie in the other direction.
  const publishing = PUBLISHING_CARRIES.find(
    (carry): carry is PublishingCarry => carry === resolved.config.carry.kind,
  ) ?? null;
  // THE ARCHIVE IN FORCE, or null. Derived once and passed, never re-read from the axis:
  // the descriptor a candidate is binned into, the admission test that gates its write and
  // the cell count the seal's disclosure reports are three facts about one archive, and
  // three derivations of it are three things that can disagree. `key` is non-null under
  // this arm by `regionRefusal`, so the pair is complete or absent together.
  const archive = resolved.config.advance.kind === 'archive' && resolved.key !== null
    ? { key: resolved.key, novelty: resolved.config.advance.novelty }
    : null;
  const log = deps.logger ?? diagnostics;

  let measured: MeasuredObjective | null = null;
  let verifier: ResolvedVerifier | null = null;
  let ctx: MeasurementContext | null = null;
  let baseline: number | null = null;
  let publication: PublicationState = { kind: 'open' };
  // What makes two runs comparable: the metric and the instrument, and nothing about
  // the artifact under work. Null for a run that measured no objective — a judged or
  // unscored run has no identity, so it has no records to read and none to write.
  let identity: ObjectiveIdentity | null = null;

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
      // is what supplies that path — and it is also what gives the closed registry
      // (*The closed verifier registry*) a name that can fail to resolve.
      return unsupported('this objective supplies `verify` as a closure, which names no path a '
        + 'candidate is written to, so this run cannot place one for it to measure. Register a '
        + 'verifier kind and pass verify as {kind, spec}.');
    }
    // ORDER MATTERS HERE, and it used to be wrong.
    //
    // Old order: validate `spec`, then build the measurement context, then
    // measure the baseline. So a caller learned about its spec's fields first and
    // about an instrument that cannot run in this workspace at all LAST — one
    // refusal per attempt, each one a real turn step. Measured in production: a
    // model spent five of its ten steps on that sequence (an unregistered kind, two
    // spec-shape complaints, then two faulted baselines) and the turn was cut
    // before it ever ran a search.
    //
    // New order: the kind, the shell, then whether THIS instrument can run in THIS
    // shell, and only then the spec. Every refusal above the spec is one no spec
    // could have avoided, so a caller is never sent to correct a field while the
    // instrument behind it is unrunnable.
    const kind = registeredVerifierKind(measured.verify.kind);
    if (kind === null) return unregisteredKindRefusalFor(measured.verify.kind);
    ctx = measurementContext(deps.rt);
    if (!ctx) {
      return unavailable('this workspace has no shell, so nothing can run a measurement in it — a '
        + 'verifier is given a filesystem and a shell and this actor was wired neither. The call is '
        + 'well-formed; the instrument is absent.');
    }
    const instrumentFault = await preflightVerifier(kind, ctx);
    if (instrumentFault !== null) {
      return unavailable(`the "${kind}" instrument cannot run in this workspace's shell, so no `
        + `score:"verify" search can start here — and no \`spec\` would change that: ${instrumentFault}. `
        + 'That is the instrument breaking rather than a candidate failing. Either take an objective '
        + 'this workspace can measure, or DROP `objective` and re-issue the same preset: without one '
        + 'a named preset runs a judged sweep at its own width, which needs no instrument at all. '
        + 'Switching preset is not required and would cost you this one\'s width and unit.');
    }
    const resolvedVerifier = resolveVerifier(measured.verify);
    if ('reason' in resolvedVerifier) return resolvedVerifier;
    verifier = resolvedVerifier;
    // The identity *Comparability* requires, COMPLETE: the spec the caller named and
    // the code that name resolved to. `argumentDigest({kind, spec})` alone cannot tell
    // two runs whose kind resolved to different implementations apart, and pooling those
    // as comparable is what `ResolvedVerifier.implementation` exists to prevent. Built
    // here because this is the one place both halves are in hand.
    identity = {
      metric: measured.metric,
      unit: measured.unit,
      direction: measured.direction,
      scale: measured.scale,
      verifierDigest: verifierDigestOf(measured.verify, resolvedVerifier.implementation),
    };
    // *Measured baseline*: the baseline is measured on the workspace AS FOUND, before
    // any candidate exists. A fault here MUST NOT start the run — there is nothing to
    // normalise against and nothing to compare to.
    let asFound: Measurement;
    try {
      asFound = await verifier.verify(ctx);
    } catch (error) {
      return unavailable(`the baseline measurement faulted, so this run cannot start: `
        + `${renderThrownChain({ cause: error })}. That is the instrument `
        + 'breaking rather than a candidate failing, and it fails the run by design.');
    }
    baseline = baselineOf(asFound, verifier.baselineKey)
      ?? (asFound.kind === 'measured' ? asFound.value : null);
    if (baseline === null) {
      return unavailable('the baseline measurement produced no number, so there is nothing to '
        + `normalise against: ${asFound.detail}`);
    }
    // *Floor margin*: the run's own first measurement refutes the floor.
    if (measured.floor && breaches(measured.floor, measured.direction, baseline)) {
      return badInput(`the workspace as found already measures ${String(baseline)} `
        + `${measured.unit}, past a floor of ${String(measured.floor.value)} that no correct `
        + 'solution may cross. The floor is refuted by the run\'s own baseline before any candidate '
        + `exists. Re-derive the bound: ${measured.floor.proof}`);
    }
    // *Measured baseline* — a target at or beyond the measured baseline leaves no range
    // to score on.
    if (normalisedScore({
      value: baseline, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    }) === null) {
      return badInput(`the target of ${String(measured.target)} ${measured.unit} is already met by `
        + `the workspace as found, which measures ${String(baseline)}. Every candidate would `
        + 'saturate at 1.0 and the search would have no gradient — the baseline is measured rather '
        + `than declared, so raise the target past ${String(baseline)}.`);
    }
    // THE ARCHIVE'S KEY, CHECKED AGAINST THE INSTRUMENT THAT HAS TO WITNESS IT — here,
    // because this is the first and cheapest moment it can be: the baseline measurement
    // has just reported the quantities this instrument reports, and a key naming none of
    // them would otherwise be discovered one candidate at a time at the settle barrier,
    // where every write is refused for want of a cell and the run reports coverage over an
    // archive it could never have written. Refused before a single candidate is expanded,
    // naming the keys this instrument does report.
    if (archive) {
      const cell = archiveCellOf(archive.key, asFound.measured);
      if (cell.kind === 'unwitnessed') {
        return badInput(`advance:"archive" bins every candidate by \`key\`, and the descriptor has to be `
          + `WITNESSED by the instrument rather than claimed by a node — but "${archive.key}" is not among `
          + `the quantities kind:"${verifier.kind}" reports${cell.reported.length > 0
            ? `, which are: ${cell.reported.join(', ')}`
            : ' (it reports none at all)'}. Name one of those as \`key\`, or drop advance:"archive" for a `
          + 'run with no coverage claim.');
      }
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
  // The transcript store *The journal read model* governs, and it is the SAME ledger a
  // fork's turns land in: the transcript is a read model over the node's journal, never
  // a second store. `search_nodes` stays the TREE — structure and one normalised value
  // per node — and the journal stays the turns. Initialised rather than assumed, for the
  // reason `initSearchTables` is: a workspace that has never run a fork has no
  // `head_journal`.
  initHeadsTables(deps.rt.storage.execRaw, sql);
  const journal = new HeadJournal(sql);
  // The run-level ledger every search in this workspace has a row in. Initialised for
  // the same reason the two above are, and written for the reason *Accepted and
  // ignored* gives: a swarm wrote a tree and no ledger row, so the surface could read
  // its structure and not one knob it ran under, and the judge clamp it computes and
  // discloses was persisted nowhere at all.
  initMctsSearchTable(deps.rt.storage.execRaw, sql);
  const searchLedger = new MctsSearchStore(sql);
  // The leaderboard *The records store* governs, initialised for the same reason the two
  // above are: a workspace that has never run a search has no `exploration_records`, and
  // the carry-in read immediately below would be a query against a table that does not
  // exist.
  initExplorationRecordsTable(deps.rt.storage.execRaw, sql);
  // The per-node content store a RE-ENTRY reads (*swarm-resume.ts*), initialised for
  // the same reason the three above are. `search_nodes` holds this tree's selection
  // state and cannot answer a resume — `value` is a mean over a subtree, and no column
  // holds the raw measurement a winner is ranked on or the breach that seals a run.
  initSwarmNodeRecords(deps.rt.storage.execRaw);

  // CARRY-IN. What earlier runs of THIS objective, under THIS floor, already reached —
  // read before anything is expanded, so the search starts from it rather than
  // rediscovering it. This is the half that makes the store a store: a writer with no
  // reader persists rows nothing ever starts from, which is the same per-invocation
  // search with a table beside it.
  //
  // Gated on a PUBLISHING carry rather than run unconditionally. `carry` is the axis
  // that says whether a run belongs to a cumulative sequence, and seeding a
  // `carry:'none'` run out of the store would break that axis in the direction nobody
  // is watching — the run would silently inherit a starting point its configuration
  // says it has none of.
  const carriedIn = identity !== null && publishing !== null
    ? recordsFor(sql, { identity, floor: measured?.floor ?? null })
    : [];
  // Best FIRST, by `recordsFor`'s own ordering in the objective's direction.
  const carriedBest = carriedIn[0] ?? null;
  if (carriedBest) {
    log.event('swarm.records_carried_in', {
      preset: resolved.preset,
      carry: resolved.config.carry.kind,
      metric: measured?.metric ?? '',
      rows: carriedIn.length,
      best: carriedBest.value,
      displacements: carriedBest.displacements,
    });
  }
  // Whether a node is an agent at all. `thought` is the degenerate point *The six axes*
  // names, and it takes the toolless path below unchanged; the other two run
  // `node-agent.ts`.
  const agentNodes = resolved.config.unit.kind !== 'thought';
  const languages = deps.rt.executor.languages;
  // The narrowing, not a second policy: `regionRefusal` has already refused the two
  // values with no scheduler here.
  const policy = frontierPolicyOf(resolved.config.advance.kind);
  if (!policy) {
    return unsupported(`advance:"${resolved.config.advance.kind}" has no scheduler in this runner.`);
  }

  /**
   * THE SEARCH THIS CALL IS: the interrupted one it re-enters, or a new one.
   *
   * A re-driven background job replays the stored tool input verbatim
   * (`orchestrator/background-tools.ts`), so minting a fresh root here is what turned
   * ONE evicted five-head search into two abandoned trees, a second ledger row, and a
   * job that settled `completed — took 18m` carrying an aborted result.
   * `swarm-resume.ts` states the rest of the rule and names what a re-entry cannot
   * recover.
   */
  const reentry = deps.redrive === true
    ? reenterSwarm({ sql, ledger: searchLedger, journal }, {
      task: resolved.task, reason: RESUMED_SWARM_NODE_REASON, now: Date.now(),
    })
    : null;
  /**
   * THE PROFILE THIS RUN RUNS UNDER. First attempt: the caller's resolution,
   * carried down in deps and written into the ledger row at `begin` below —
   * the snapshot a later re-drive replays. Re-drive: the claimed row's own
   * record, so today's catalog cannot reach an in-flight tree.
   */
  const runProfile = deps.profile ?? reentry?.profile ?? null;
  if (runProfile && !deps.redrive) {
    log.event('swarm.profile_snapshot', {
      role: runProfile.profile.role.id, tier: runProfile.profile.tier.id,
      model: runProfile.profile.tier.model, preset: resolved.preset,
      roleSource: runProfile.sources.roleSource,
      tierSource: runProfile.sources.tierSource,
      presetSource: runProfile.sources.presetSource,
      catalogVersion: runProfile.profile.catalogVersion,
      digest: runProfile.profile.digest,
    });
  }

  /**
   * THE MODEL EVERY NODE RUNS ON, decided once, here.
   *
   * `deps.model` is the CALLER's own turn model. When a profile record exists,
   * its `tier.model` is what this delegation was routed to, so that is what the
   * nodes run — and BOTH cases read the same field, which is what makes a
   * re-drive continue on the model it started on. Today's catalog cannot reach
   * an in-flight tree because today's catalog is never consulted: the re-drive
   * arm reads the claimed ledger row, and the row was frozen before the first
   * attempt detached.
   *
   * REFUSED, not degraded, in both directions. When the seam is MISSING,
   * running the caller's model while the ledger row names the tier's would put
   * a model that never executed into the provenance AND into the spend, and
   * both are read later as evidence of what this search cost. When the seam
   * THROWS — a session with no registry to build that spec, an unknown
   * provider, a revoked credential — the honest answer is that this tier is
   * unreachable HERE, and a refusal says so where a propagated throw would hand
   * the operator a stack instead of the fact. The cause chain is kept, because
   * the provider's own reason is the actionable half.
   */
  let nodeModel = deps.model;
  if (runProfile) {
    const spec = runProfile.profile.tier.model;
    const tier = runProfile.profile.tier.id;
    if (!deps.resolveModel) {
      return unsupported(
        `this search is routed to the ${tier} tier, model ${JSON.stringify(spec)}, but no model `
        + 'resolver is wired in this runner — so its nodes could only run the caller\'s own '
        + 'model while the run records the tier\'s. Wire AgentsForkDeps.resolveModel on this '
        + 'backend.',
      );
    }
    try {
      nodeModel = deps.resolveModel(spec);
    } catch (error) {
      return refusalOf(new KinuError('unavailable',
        `this search is routed to the ${tier} tier, model ${JSON.stringify(spec)}, and this `
        + 'runtime cannot build that model, so the tier it was routed to is unreachable here. '
        + 'Point the tier at a model this session can resolve, or give the session a resolver '
        + 'that can.',
        { cause: error }));
    }
  }

  /**
   * AND IF IT IS NEITHER, IT IS NOTHING. A call that did not re-enter and finds a
   * search of its own task STILL RUNNING is refused rather than given a second tree.
   *
   * This used to be the deliberate arm — "a fresh `agents.swarm` whose task matches a
   * search still expanding gets its own root" — and the case it was defending is real:
   * two concurrent deliberate calls must not grow one search between them. What it did
   * not survive is how a re-spawn actually arrives. A failed job's wake tells the model
   * "decide whether to retry or report the failure", the model retries by calling the
   * tool again, and that call carries no re-drive marker because it is not a re-drive —
   * so it took this arm and minted a second root over a tree the first attempt had left
   * running. Measured on the owner's live workspace: two roots with byte-identical task
   * text, six waves and thirty head spawns against one budget-5 job.
   *
   * A REFUSAL RATHER THAN AN ADOPTION, because adoption is exactly what the marker
   * exists to authorise: a caller with no marker has not proved it owns the earlier
   * attempt, and silently continuing somebody else's tree is the collision from the
   * other direction. So the caller is told the search is already running, told where,
   * and told its result arrives as a wake — which is the answer it wanted.
   *
   * A row this call itself superseded is gone by here: `reenterSwarm` supersedes the
   * losers before it claims, so a re-drive that genuinely found nothing to re-enter
   * leaves nothing running and falls through to a fresh search.
   */
  const live = reentry ? [] : searchLedger.findRunningSwarms(resolved.task);
  const contended = live[0];
  if (contended) {
    log.event('swarm.duplicate_root_refused', {
      preset: resolved.preset, root: contended.rootId,
      redrive: deps.redrive === true, running: live.length,
    });
    return unavailable(`this workspace is already running a swarm for this task (${contended.rootId}, `
      + `iteration ${String(contended.iteration)}, ${String(contended.budget)} of its expansion budget `
      + 'left), and a second search over one task would pay twice for one answer and crown a winner '
      + 'from whichever tree happened to finish. That run reports itself when it settles — its result '
      + 'arrives as a background wake, so wait for it rather than re-spawning. Cancel it first if you '
      + 'meant to start over.');
  }
  // The ROOT is the workspace as found at depth 0 — the one node no model wrote.
  // Recorded so that selection has something to select and so that every child's
  // depth is DERIVED from a row this engine wrote rather than asserted by its author.
  // A re-entry adopts the row its first attempt wrote: re-inserting it would collide on
  // the primary key, and minting a second root is the defect above.
  const rootId = reentry?.rootId ?? nanoid();
  // MEASURED NOW IN BOTH CASES, never read back off the row. The root IS the workspace
  // as found, and what a re-entering run finds is the state its own first attempt left
  // — including the winner an earlier settle applied. Reading the stored `observation`
  // instead would hand a resumed run the workspace as it was BEFORE any of that, and
  // that column also carries the task string where the path held nothing, which is not
  // an artifact at all.
  const rootArtifact = verifier && ctx ? await readArtifact(ctx, verifier.artifact) : null;
  if (!reentry) {
    insertSearchNode(sql, {
      nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
      task: resolved.task,
      // The root's label is the RUN'S NAME — what the exploration surface
      // draws where every other node carries its proposal's why. A caller who
      // named nothing leaves it to a composed configuration's provenance
      // label; with neither, the read model derives from the task and this
      // stays empty exactly as it always has.
      action: resolved.name ?? resolved.label ?? '',
      observation: rootArtifact ?? resolved.task,
      codeUsed: null, depth: 0, msgId: null,
    });
  }
  const nodes = new Map<string, TreeNode>([[rootId, {
    id: rootId, parentId: null, depth: 0, artifact: rootArtifact,
    // The baseline IS the root's measurement, and its normalised score is 0 by
    // construction — the point the search climbs away from.
    measurement: null, score: measures ? 0 : null,
    proposal: null, proposalError: null, granted: null,
    // The root reported nothing because no model wrote it. Its children's prefix is
    // the ORIGIN's conversation when the caller supplied one (*Inherited context*: a
    // root that started blank would throw away precisely the context that made the
    // caller decide to search) and the task block alone when it did not.
    conclusion: null, transcript: deps.originContext ?? [], compacted: null,
    // The root aggregates nothing: it IS the workspace as found, and a fan-in consumes
    // a level the search produced.
    aggregated: [],
  }]]);
  // One run header, so every node of this search groups under one root in the journal
  // instead of each appearing as its own empty run — the defect `recordSplit` exists
  // to close, reached here for the same reason. Idempotent under a re-entry: the row is
  // keyed on the root and re-labelled rather than duplicated.
  if (agentNodes) {
    journal.recordSplit(rootId, resolved.label ?? resolved.preset, Date.now());
  }

  const candidates: SwarmCandidate[] = [];
  let best: SwarmCandidate | null = null;
  let bestValue: number | null = null;
  let usage: Usage = {};
  /**
   * The direction `best` is chosen in — the objective's own where one was measured, and
   * `maximise` for a judged run, where the ensemble's [0,1] median is better when it is
   * higher by construction.
   *
   * Resolved ONCE rather than per candidate: a comparison whose direction is recomputed
   * in a loop is a comparison that can be recomputed differently, and getting this
   * backwards silently reverses the search.
   */
  const rankDirection: ObjectiveDirection = measured?.direction ?? 'maximise';
  /** Per-candidate spend, for that candidate's own record. Keyed by node id because the
   *  settle barrier is past the loop that observed it. */
  const spentBy = new Map<string, number | null>();
  /** Every ensemble size a candidate actually sampled, for the report's binding
   *  realisation. Empty for a run that scored by anything other than a judge. */
  const ensembles: number[] = [];
  /**
   * WHAT AN EARLIER ATTEMPT OF THIS SEARCH ALREADY SETTLED, put back.
   *
   * Every accumulator above is seeded from the durable rows so a re-entry continues
   * one search instead of reporting the half of it that happens to be in memory: the
   * tree (so selection descends what exists), the candidate list (so `expansions`
   * counts the whole search), the WINNER (so a resumed run cannot crown a candidate
   * worse than one already measured), the SEAL (so a run that breached its floor stays
   * unpublishable — resuming open would publish work the seal exists to hold back),
   * the realised ensembles and the per-candidate spend.
   *
   * Nodes arrive parent-before-child, which is what lets a `context:'fork'` child of a
   * re-entered parent inherit that parent's conversation: the transcript is composed
   * down the chain exactly as the loop composes it. What it does NOT carry is each
   * child's own seed message — a user turn built from prompt state that was never
   * durable — so an inherited prefix is the ancestors' turns without the questions that
   * prompted them. Named because it is a real difference in what a resumed child reads,
   * and the alternative was persisting every node's whole prefix, which is quadratic in
   * depth.
   *
   * A node with a tree row and no record cannot happen going forward — the record is
   * written first, so a row implies one — but an older workspace can hold one, and it
   * is rebuilt as a selectable parent that is not a candidate: it has an answer and no
   * measurement, and ranking it would rank an unmeasured node.
   */
  let inheritedExpansions = 0;
  let inheritedTokens: number | null = null;
  for (const node of reentry?.nodes ?? []) {
    // The root was seeded above, measured against the workspace as it is NOW.
    if (node.parentId === null) continue;
    inheritedExpansions += 1;
    const { record } = node;
    const outcome = record?.outcome ?? null;
    const measurement = outcome?.kind === 'sealed' || outcome?.kind === 'scored'
      ? outcome.measurement
      : null;
    const score = outcome?.kind === 'scored' || outcome?.kind === 'judged'
      ? outcome.score
      : null;
    nodes.set(node.id, {
      id: node.id, parentId: node.parentId, depth: node.depth,
      artifact: node.artifact,
      measurement, score,
      // A proposal and a grant were in-memory state of the dead attempt. Both are
      // named losses in `swarm-resume.ts`: the node is selectable again and expands
      // under the run's own `context`, and the grant's debit is refunded because
      // nothing was created.
      proposal: null, proposalError: null, granted: null,
      conclusion: record?.conclusion ?? null,
      transcript: [...(nodes.get(node.parentId)?.transcript ?? []), ...node.produced],
      // Recomputed when this node becomes a branch point, exactly as a fresh one is.
      compacted: null,
      aggregated: record?.aggregated ?? [],
    });
    if (!record) continue;
    const candidate: SwarmCandidate = {
      id: node.id,
      artifact: node.artifact,
      measured: measurement,
      unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
      incomplete: outcome?.kind === 'incomplete' ? outcome.detail : null,
      score,
    };
    candidates.push(candidate);
    spentBy.set(node.id, record.tokens);
    if (record.tokens !== null) inheritedTokens = (inheritedTokens ?? 0) + record.tokens;
    if (outcome?.kind === 'judged' && outcome.ensemble > 0) ensembles.push(outcome.ensemble);
    if (outcome?.kind === 'sealed') {
      publication = { kind: 'sealed', breach: outcome.breach, clearedBy: null };
    }
    // THE SAME RANK EXPRESSION THE LOOP USES, over the same arms: a verified candidate
    // ranks on its RAW measurement and a judged one on the ensemble's median, and a
    // sealed candidate ranks on nothing at all.
    const rank = outcome?.kind === 'scored'
      ? outcome.measurement.value
      : outcome?.kind === 'judged' ? outcome.score : null;
    if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
      best = candidate;
      bestValue = rank;
    }
  }
  // THE EXPANSION BUDGET, in units of one child: `depth` waves of `branches`, DERIVED
  // from the two caps the call resolved because there is no third cap to read. `budget`
  // (iterations) was filed as a cap on `SwarmInput`, but `SwarmInput` declares none and
  // the tool surface deliberately omits it — `agents-tool.ts` records that an iteration
  // cap was meaningless at the one depth that ran, and that declaring a cap nothing
  // applies is the lie *Accepted and ignored* refuses. So the two DECLARED caps are the
  // budget. At depth 1 this is exactly `branches`, i.e. the one wave a flat run has
  // always been, so enabling the tree changes nothing about the depth that already ran.
  // An invented third number would be worse than a derivation: a default nothing
  // declared is a shape the record cannot report honestly, and this one `expansions`
  // reports.
  //
  // OWNED BY A TYPE rather than by a `let`, because arbitration no longer happens only
  // in this loop: an agent node asks from inside its own concurrent tool loop, so the
  // read and the debit have to be one step (`swarm-budget.ts`).
  const expansionBudget = maxDepth * branches;
  /**
   * WHAT THIS ATTEMPT MAY STILL SPEND.
   *
   * Derived from the TREE and not from the ledger's `budget` column, and the two can
   * disagree: a swarm checkpoints at its level barriers, so an attempt cut inside a
   * level left the column reading the level before it. The tree is the record of
   * expansions that actually HAPPENED, so this never re-pays for a settled node — and
   * never charges for one that was bought and never created, which is the other
   * direction: an agent node's grant debits from inside its own tool call, so an
   * eviction can lose children the run had already paid for, and refunding them is
   * correct because nothing exists that they paid for.
   */
  const budget = new SwarmBudget(Math.max(0, expansionBudget - inheritedExpansions));
  /**
   * THE LEASE every ledger write of this run is stamped with: the epoch a re-entry
   * claimed, or zero for a first attempt.
   *
   * Live fencing rather than the constant zero it used to be. A swarm has a resume now,
   * so an executor from the evicted activation may still hold the previous lease, and a
   * `converge` from it would settle a row this run is making progress on.
   */
  const ledgerEpoch = reentry?.epoch ?? SWARM_FIRST_LEDGER_EPOCH;
  // THE RUN'S OWN LEDGER ROW. Written at the START so a live swarm reads as running and
  // a settled one as settled, which is the same discipline `mcts/engine.ts` keeps: the
  // alternative — one row at the settle barrier — would leave every in-flight run
  // indistinguishable from one that never recorded anything. Knobs left `undefined` are
  // omitted by `JSON.stringify`, and the read model reports an absent knob as
  // unrecorded rather than as a default it invented.
  //
  // A RE-ENTRY CHECKPOINTS THE ROW IT CLAIMED instead of writing one. `begin` is an
  // INSERT OR REPLACE that resets the status to `running` and the epoch to zero, so
  // calling it here would throw away the lease this run just took and un-fence the
  // executor it was taken from. What the row needs is the truth about progress, which
  // is what the checkpoint carries.
  const ledgerConfig: PersistedSearchKnobs = {
    budget: expansionBudget,
    branches,
    mode: deps.mode,
    maxDepth,
    explorationWeight: resolved.config.explorationWeight,
    judgeSamples: judgeSamples ?? undefined,
  };
  if (runProfile) Object.assign(ledgerConfig, { profile: runProfile });

  if (reentry) {
    searchLedger.checkpoint(
      rootId, ledgerEpoch, inheritedExpansions, budget.remaining, Date.now(),
    );
  } else {
    searchLedger.begin({
      rootId,
      task: resolved.task,
      engine: 'swarm',
      // A swarm's root is the workspace as found, not a message in a conversation.
      rootMsgId: null,
      config: ledgerConfig,
      budget: expansionBudget,
      now: Date.now(),
    });
  }

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
    rt: deps.rt, model: nodeModel, journal, logger: log,
    // The wall clock is OPT-IN (deps.maxWallClockMs, wired below when declared):
    // there is no default clock over a node's work. Its turn runs until it is
    // done, cancelled, refused by its mission governor, or fails definitively.
  };
  if (deps.signal !== undefined) nodeDeps.signal = deps.signal;
  if (deps.reportModelCall !== undefined) nodeDeps.reportModelCall = deps.reportModelCall;
  if (deps.maxWallClockMs !== undefined) nodeDeps.maxWallClockMs = deps.maxWallClockMs;
  if (deps.mission !== undefined) nodeDeps.mission = deps.mission;
  if (deps.provisionHome !== undefined) nodeDeps.provisionHome = deps.provisionHome;
  // Only reached by an agent node: the toolless `thought` branch below never
  // builds `nodeDeps` at all, which is what makes the split structural rather
  // than a condition someone has to remember.
  if (deps.host !== undefined) nodeDeps.host = deps.host;
  if (deps.executeTool !== undefined) nodeDeps.executeTool = deps.executeTool;
  if (deps.webSearch !== undefined) nodeDeps.webSearch = deps.webSearch;
  // THE REPORT CONTRACT, wired exactly where an instrument exists. A judged run gets no
  // gate at all — an absent key, because a check that passed and a check that never
  // existed are different facts — and the ABSENCE is what makes a judged node's report
  // land the way it always did.
  if (verifier && ctx && measured) {
    const grade = reportGate({ ctx, verifier });
    nodeDeps.gradeReport = grade;
  }

  let lost = 0;
  let aborted = false;
  /**
   * THE MISSION LEDGER, asked between levels and charged per toolless call.
   *
   * An AGENT swarm node needs neither half here: its loop is `runHeadInference`, which
   * guards before its first call, between its steps and between its turns, and debits
   * each step off the provider's own report — so wiring {@link SwarmRunDeps.mission}
   * into `nodeDeps` above is the whole of that path. A THOUGHT node has no loop to put
   * either question in, and this is where both go.
   *
   * THE LEVEL IS GUARDED, NEVER THE CHILD, and that is the same choice `mcts/engine.ts`
   * makes for the same reason: a child that refused its own call would return empty
   * text, be measured at whatever the instrument gives an empty candidate, and have
   * that ranked as an opinion about the search space. Stopping at the level settles the
   * run on what it actually explored.
   */
  const mission = missionMeter(deps.mission);
  /** True when the ledger, not the expansion budget, ended the run — so `stop` says
   *  `budget` rather than claiming the space was exhausted. */
  let missionSpent = false;

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
  const expandChild = async (input: {
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
  }): Promise<Expansion> => {
    const { parent, id, atDepth } = input;
    /** The DAG's edges as the row-writing loop needs them: ids, not nodes. */
    const edges = input.aggregated.map((fanned) => fanned.id);
    const prompt = branchPrompt({
      resolved, mode: deps.mode, languages, measured, baseline,
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
    });
    if (!agentNodes) {
      const result = await generateText({
        model: nodeModel,
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: deps.signal,
      });
      const spent = normalizeUsage(result.usage);
      // CHARGED HERE, where the call returned, so the level guard below reads a
      // current ledger. A toolless node's whole spend is this one call — the same
      // quantity `Expansion.usage` carries down to the settle report — and the caller
      // that spawned this search must therefore charge no lump for it afterwards.
      await mission.charge(spent);
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
      task: resolved.task,
      rationale: input.rationale,
      base: prompt.system,
      messages: input.context === 'fork' ? [...input.prefix, seed] : [seed],
      inherited: input.context === 'fork' ? inheritedAsSerialized(input.prefix) : [],
      context: input.context,
      mode: deps.mode,
      settle: resolved.settle,
      // *Build-time exclusion*: the tool exists only where a branch could be granted.
      // Depth is what cannot change mid-run, so it gates the BUILD; the budget can
      // empty between the invitation and the answer, so it stays a runtime refusal
      // inside the arbiter.
      arbitrate: isTreeAdvance(resolved.config.advance.kind) && atDepth + 1 <= maxDepth
        ? (proposal) => budget.arbitrate({
          config: resolved.config, caps: resolved.caps, atDepth, proposal,
        })
        : null,
    }, nodeDeps);
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
  };

  /** THE RUN'S MERGE LEDGER: what a fan-in has already landed in the origin.
   *  *Dependency order* asks whether a dependency has SETTLED, and one that settled at
   *  an earlier barrier of this run has — a DAG merged one fan-in at a time is still one
   *  merge order.
   *
   *  SEEDED FROM THE DURABLE RECORDS, because "landed" is a fact about the ORIGIN and
   *  the origin outlives the activation: a member an earlier attempt applied is in the
   *  workspace, and re-offering it would re-apply bytes the origin already holds and
   *  could only disagree with a sibling that barrier already reconciled. */
  const landed = new Set<string>(
    (reentry?.nodes ?? []).filter((node) => node.merged).map((node) => node.id),
  );
  /** Level members no fan-in could consume, and members a fan-in consumed after the tree
   *  had retired them. Sets, so two fan-ins over one level cannot count a node twice. */
  const unusableParents = new Set<string>();
  const prunedParents = new Set<string>();
  const mergeOrder: string[] = [];
  const aggregateVertices: string[] = [];
  let fanInLevels = 0;
  let fanInMerged = 0;

  /**
   * THE FAN-IN, at the level barrier — `expand:'aggregate'`, and the DAG this engine
   * runs rather than the tree every other axis value produces.
   *
   * WHAT A FAN-IN IS HERE. A level is complete and its siblings have been compared, so
   * their WORK meets: the level's parents are offered to merge-back as members, in a
   * topological order of the dependency edges they declare, and everything after that is
   * the machinery *Merge-back* states rather than a second copy of it —
   *
   *   - members that AGREE accumulate. Their diffs land in order, each rebased onto the
   *     result of the last, and the level's answer is that accumulation. Two members that
   *     wrote the same bytes have not conflicted, so no node is spawned to decide nothing;
   *   - the first DISAGREEMENT spawns the merge node *Merge-back* names, and that node
   *     IS the aggregate vertex — k parents consumed by one child, its task the merge,
   *     graded like any other candidate. There is no second conflict mechanism because
   *     there is no second conflict: a fan-in is exactly where two candidates' work
   *     meets;
   *   - a member whose BASE MOVED under the member before it is re-verified through the
   *     registry, so a stale verdict never applies (`reverify` below);
   *   - the transaction bound is checked per member before its own apply, unchanged.
   *
   * WHAT ORDERS IT. {@link dependencyOrder}, over each member's own edges, against the
   * ledger of what this run already landed. A cycle is refused naming the cycle, and that
   * refusal is merge-back's rather than this loop's precisely so it holds for whoever
   * offers one: this engine cannot construct a cycle, because an edge only ever points at
   * a node that already produced an answer, and a guarantee that rests on that is worth
   * nothing to the next caller.
   *
   * WHAT BECOMES OF A PARENT THE SEARCH DID NOT KEEP — decided here, in one place, and
   * disclosed rather than left to be inferred:
   *
   *   - NO USABLE ANSWER means NO EDGE. Unmeasurable, sealed past the floor, or lost to a
   *     provider error: the fan-in does not consume it. A vertex's whole claim is that it
   *     consumed its parents, and one silently missing makes that claim false while the
   *     answer still reads as if it aggregated k. Counted in the report as
   *     `unusableParents`, never dropped in silence;
   *   - RETIRED BY PRUNING KEEPS ITS EDGE, and its dependent proceeds from that parent's
   *     last good state. `pruneLowValueBranches` says where the next unit of budget goes,
   *     not whether measured work reaches the origin, and a level a vertex already
   *     consumed cannot be un-consumed by a later selection decision. The status is read
   *     ONLY to disclose it (`prunedParents`), because a decision nobody can see is the
   *     one this field exists to prevent;
   *   - A MEMBER WHOSE MERGE DID NOT LAND KEEPS ITS DEPENDENT BEHIND IT. The fan-in stops
   *     where merge-back stopped, so a vertex whose parent has not reached the origin is
   *     not applied over it; the next barrier re-offers both, with the parent ordered
   *     ahead of the vertex again. That is why *Dependency order* never refuses from
   *     here: the member set is CLOSED over unlanded edges and the ledger accounts for
   *     the landed ones, which is what satisfying a rule looks like as opposed to dodging
   *     it. Drop either half and the DAG's own merges refuse by name.
   *
   * Returns the vertex it produced, for the barrier loop to score exactly as it scores a
   * sampled child — never a second grading path.
   */
  const fanInAtLevel = async (input: {
    readonly ctx: MeasurementContext;
    readonly verifier: ResolvedVerifier;
    readonly measured: MeasuredObjective;
    readonly baseline: number;
    readonly atDepth: number;
  }): Promise<readonly Expansion[]> => {
    const { ctx: measureIn, verifier: instrument, atDepth } = input;
    // THE LEVEL, and what of it a fan-in can consume. A node this run already merged has
    // been consumed: offering it again would re-apply bytes the origin holds and could
    // only disagree with a sibling an earlier fan-in already reconciled.
    const parents: FanInParent[] = [];
    for (const node of nodes.values()) {
      if (node.depth !== atDepth || landed.has(node.id)) continue;
      if (node.artifact === null || node.score === null) {
        unusableParents.add(node.id);
        continue;
      }
      parents.push({
        id: node.id, answer: node.artifact, score: node.score, aggregated: node.aggregated,
      });
    }
    if (parents.length < 2 || atDepth + 1 > maxDepth) {
      // NEITHER A REFUSAL NOR SILENCE. A fan-in over one parent is `sample` under another
      // name and the engine will not relabel it; a vertex past the cap is the one thing
      // the depth cap in *Arbitration* forbids. Both say which.
      log.event('swarm.aggregate_skipped', {
        preset: resolved.preset, depth: atDepth, parents: parents.length,
        reason: parents.length < 2 ? 'no-level' : 'depth-cap',
      });
      return [];
    }

    // THE MEMBERS: this level's parents, closed over the edges they declare through
    // anything the run has not landed. A vertex's answer was written against its own
    // parents' combined state, so a parent whose work is not in the origin has to land
    // before it — that edge is what `dependencyOrder` orders, and dropping it would apply
    // a diff onto a base its verdict never saw.
    const consumed: FanInParent[] = [];
    const known = new Set<string>();
    const queue = [...parents];
    for (let member = queue.shift(); member !== undefined; member = queue.shift()) {
      if (known.has(member.id)) continue;
      known.add(member.id);
      consumed.push(member);
      for (const dep of member.aggregated) {
        const node = nodes.get(dep);
        if (node === undefined || landed.has(dep) || known.has(dep)) continue;
        // An edge is only ever given to a node that produced a usable answer, so this
        // narrows the row rather than filtering it.
        if (node.artifact === null || node.score === null) continue;
        queue.push({
          id: dep, answer: node.artifact, score: node.score, aggregated: node.aggregated,
        });
      }
    }
    for (const row of sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE root_id = ${rootId} AND status = 'pruned'`) {
      if (known.has(row.id)) prunedParents.add(row.id);
    }

    const readOrigin = originReader(measureIn.vfs);
    const members = await Promise.all(consumed.map((member) => reportedMember({
      nodeId: member.id, answer: member.answer, score: member.score,
      path: instrument.artifact, deps: member.aggregated, readOrigin,
    })));
    const answers = new Map(consumed.map((member) => [member.id, member.answer]));

    /**
     * Re-verification under *A verdict is bound to the exact pair it was issued over*,
     * through the SAME instrument the search scored with.
     *
     * A fan-in applies members onto one another, so every member after the first has a
     * base its verdict never saw — that is the rebase, and the binding rule is what keeps
     * it from being a licence. The check is the measurement itself rather than a cheaper
     * proxy: a re-verified verdict is then the same KIND of fact as the original one.
     *
     * IT PUTS THE WORKSPACE BACK. The instrument measures a candidate in place, so
     * re-measuring moves the very path the merge is about; a member that then REFUSED
     * would have left its bytes behind as an apply nothing gated. The restore is the
     * atomic writer the applies themselves ride, not a second write path.
     */
    const reverify: Reverifier = async ({ member, baseDigest }) => {
      const answer = answers.get(member.nodeId);
      if (answer === undefined) {
        return refusalOf(new KinuError('unavailable',
          `this fan-in holds no answer for node ${member.nodeId}, so nothing here can re-measure it `
          + 'against the base the members before it moved. A verdict that cannot be revalidated '
          + 'never applies.'));
      }
      const before = await readOrigin(instrument.artifact);
      const outcome = await measureChild({
        ctx: measureIn, verifier: instrument, measured: input.measured,
        baseline: input.baseline, artifact: answer,
      });
      await singlePathApply(measureIn.vfs)([
        { path: instrument.artifact, base: answer, after: before },
      ]);
      if (outcome.kind === 'instrument-faulted') {
        return refusalOf(new KinuError('unavailable',
          `the instrument faulted while re-checking ${member.nodeId} against the base this fan-in `
          + `moved: ${outcome.error}. That is the instrument breaking rather than the member `
          + 'failing, and it refuses the apply instead of guessing.'));
      }
      log.event('swarm.merge_reverified', {
        preset: resolved.preset, node: member.nodeId, depth: atDepth, outcome: outcome.kind,
      });
      // CLEAN IS `scored` AND NOTHING ELSE. Rule 4 asks whether the verdict still holds on
      // the base this member would land on: unmeasurable is "not measurable there any
      // more", and sealed is the instrument disagreeing with itself about content it has
      // already scored. Neither is a verdict that lands.
      return {
        memberDigest: memberDigestOf(member.diff),
        baseDigest,
        clean: outcome.kind === 'scored',
      };
    };

    /** The vertex, in an array because it is assigned from inside the spawner and read
     *  after it: one element where a conflict was graded, none where there was none. */
    const vertices: Expansion[] = [];
    const spawnMergeNode = async (request: MergeNodeRequest): Promise<string> => {
      // THE ROW HANGS OFF THE MEMBER ALREADY APPLIED — the state this vertex starts from —
      // and every other parent is a dependency edge, because one measurement must not
      // reach two ancestor means. Looked up BEFORE the budget is charged: a debit taken
      // for a vertex that is then not created is a child the run paid for and never ran.
      const primary = nodes.get(request.parents[0]);
      const paid = primary === undefined ? 0 : budget.take(1);
      if (primary === undefined || paid === 0) {
        // ONE OUTCOME, TWO REASONS, and the reason is a field. Merge-back has already named
        // the conflict; what is missing is the child that would resolve it — either because
        // a child off an empty budget is the overspend conservation refuses, or because the
        // spawner was handed a member this fan-in never offered. An empty id reads exactly
        // as an absent spawner does: named, and nothing there to grade it.
        log.event('swarm.aggregate_skipped', {
          preset: resolved.preset, depth: atDepth, parents: parents.length,
          reason: primary === undefined ? 'no-parent' : 'budget',
        });
        return '';
      }
      const id = nanoid();
      try {
        vertices.push(await expandChild({
          parent: primary,
          id,
          // One child of one: the diversity angle and the sibling disclosure are both
          // derived from the pair, and a fan-in has no sibling to be decorrelated from.
          index: 0,
          width: 1,
          atDepth: atDepth + 1,
          task: request.task,
          rationale: `fan-in over ${String(consumed.length)} parents of depth ${String(atDepth)}`,
          // What `context` decides for a vertex is only whether it also inherits the
          // applied member's conversation: its parents' ANSWERS reach it either way, as
          // the seed's fan-in block, because they are what it was created to reconcile.
          context: resolved.config.context,
          inherited: primary.artifact,
          aggregated: consumed,
          ancestors: pathTo(nodes, primary),
          prefix: agentNodes
            ? await sharedPrefix({ parent: primary, deps, model: nodeModel, log, preset: resolved.preset })
            : [],
        }));
      } catch (error) {
        // Named and counted exactly as a lost wave sibling is, so the report's `stop` can
        // still say the search ran narrower than it was configured to.
        lost += 1;
        log.event('swarm.branch_failed', {
          preset: resolved.preset, depth: atDepth + 1,
          error: renderThrownChain({ cause: error }),
        });
        return '';
      }
      // THE DAG'S EDGES, IN THE RECORD. `search_nodes` holds the selection edge and only
      // that (see the fan-in's note above), so this event is where the other k−1 are
      // written down. Without it the run would merge a graph nothing afterwards could
      // reconstruct, and "the edges are disclosed" would be a claim with no evidence.
      log.event('swarm.aggregate_vertex', {
        preset: resolved.preset,
        node: id,
        depth: atDepth + 1,
        selection_parent: primary.id,
        aggregated: consumed.map((member) => member.id).join(','),
        conflict: `${request.parents[0]},${request.parents[1]}`,
        paths: request.paths.length,
      });
      return id;
    };

    // A FAN-IN IS A SEQUENTIAL REBASE BY SHAPE, not by axis, and that is why
    // `mergePolicyOf` is not consulted here. It derives the SETTLE policy from `settle`
    // because there the axes decide how many members are wanted; a fan-in's arity is
    // stated by the DAG's edges, so there is nothing to derive — and a fan-in that applied
    // one member and discarded the rest would not be a fan-in.
    const merging: MergeBackDeps = {
      log,
      preset: resolved.preset,
      readOrigin,
      applyMember: singlePathApply(measureIn.vfs),
      reverify,
    };
    const report = await mergeBack(
      { policy: 'sequential-rebase', members, settled: [...landed] },
      // THE SPAWNER IS ABSENT WHERE THE BUDGET CANNOT PAY, and absent is what merge-back
      // reads as "the conflict was named and nothing was there to grade it" — the honest
      // record, where a vertex created off an empty budget would be a child nothing paid
      // for.
      budget.remaining > 0 ? { ...merging, spawnMergeNode } : merging,
    );

    fanInLevels += 1;
    mergeOrder.push(...report.order);
    for (const outcome of report.outcomes) {
      if (outcome.kind !== 'applied') continue;
      landed.add(outcome.nodeId);
      // AND DURABLY, because what this records is a fact about the ORIGIN: the bytes are
      // in the workspace and outlive the activation, so a re-entry that re-offered this
      // member would re-apply them.
      markSwarmNodeMerged(sql, outcome.nodeId, Date.now());
      fanInMerged += 1;
    }
    for (const vertex of vertices) aggregateVertices.push(vertex.id);
    log.event('swarm.aggregate_fan_in', {
      preset: resolved.preset,
      depth: atDepth,
      parents: parents.length,
      members: members.length,
      order: report.order.join(','),
      merged: report.outcomes.filter((outcome) => outcome.kind === 'applied').length,
      pruned: [...prunedParents].filter((id) => known.has(id)).length,
      vertex: vertices[0]?.id ?? '',
      stopped_at: report.stoppedAt ?? '',
    });
    return vertices;
  };

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
    // THE CAP, ENFORCED MID-RUN. A declared mission budget that ran out stops the next
    // level from opening, so the money left is what the caller still has rather than
    // what a lump after the run reports it no longer had. A run nobody labelled asks
    // nothing and reaches no storage.
    if (await mission.outOfBudget()) {
      missionSpent = true;
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
      // The ledger is settled on the way out: a run that returned a refusal is not a
      // run still going, and this row is what the surface reads its status from.
      searchLedger.fail(rootId, ledgerEpoch, Date.now());
      return unavailable(`the search selected node ${selected.id} of its own tree and this run holds `
        + 'no content for it, so the expansion would have no parent to continue from. That is an '
        + 'inconsistent tree rather than a missing instrument, and it stops the run.');
    }

    // ARBITRATE, before anything is spent — or read the grant this node already
    // earned. An AGENT node was answered by `propose_branch` while it ran, and the
    // budget was debited there; a THOUGHT node is answered HERE, where selection
    // reached it, which is what makes a proposal an input to selection rather than a
    // bypass of it (*Arbitration*). Both go through one arbiter and one budget.
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
    // The *Inherited context* barrier: ONE compacted view per branch point, computed
    // before any child of this parent starts, so nothing a level is ranked on can be a
    // fact about which sibling's compaction kept the useful paragraph.
    const prefix = agentNodes
      ? await sharedPrefix({ parent, deps, model: nodeModel, log, preset: resolved.preset })
      : [];
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
    //
    // The barrier names every settled member. It deliberately remains pending
    // while a member's provider remains pending: elapsed silence is not evidence
    // of failure. Completion, explicit cancellation, or a definitive error is
    // what produces the `expanded` or `failed` value read below.
    const answers = await awaitLevel(
      Array.from({ length: width }, (_unused, index): LevelMember => {
        const branch = grant?.proposal.branches[index];
        const id = grant?.nodeIds[index] ?? nanoid();
        return {
          id,
          node: expandChild({
            parent, id,
            index, width, atDepth: childDepth,
            task: branch?.task ?? resolved.task,
            rationale: branch?.rationale ?? `expansion ${String(index + 1)} of ${String(width)}`,
            context: branch?.context ?? resolved.config.context,
            inherited: inheritedArtifact,
            // A WAVE FANS IN NOTHING. Its siblings are independent candidates, which is
            // what `expand:'sample'` is and what `expand:'aggregate'` still starts from:
            // a fan-in consumes a level, so a level has to exist first.
            aggregated: [],
            ancestors, prefix,
          }),
        };
      }),
    );

    const expansions: Expansion[] = [];
    /**
     * Why each member of this level produced no usable candidate, in order — the text
     * the run's own refusal quotes when the whole level did. A count alone made a dead
     * level report `best: null` with the cause nowhere in it.
     *
     * TWO KINDS SIT HERE UNDER ONE NAME, because "this branch produced nothing the search
     * can continue from" is one fact: a member the barrier rejected left no report at
     * all, and a member that reported `incomplete` left a status line rather than an
     * answer. The second kind used to be the first — an `errored` node was thrown — and
     * collapsing them again in the other direction would put a node the caller can read
     * back into the bucket for the ones that vanished.
     */
    const unusable: string[] = [];
    for (const { id, answer } of answers) {
      /**
       * WHY THIS MEMBER PRODUCED NOTHING THE LEVEL CAN CONTINUE FROM, or null where it
       * produced an answer.
       *
       * Read for both kinds before either is handled, so the attribution below has ONE
       * call site: two sites raising one event name are two vocabularies for one fact.
       */
      const stopped = answer.kind === 'failed'
        ? renderCauseChain(answer.error)
        : answer.expansion.incomplete?.detail ?? null;
      if (answer.kind === 'failed') {
        // LOST IS THE NARROWER CLAIM: the search holds NOTHING for this node, so the
        // report's `stop` says it ran narrower than it was configured to. An incomplete
        // member is carried with its reason on its own candidate and is therefore not
        // lost — the run has it, and says what happened to it.
        lost += 1;
      } else {
        const expansion = answer.expansion;
        usage = addUsage(usage, expansion.usage);
        // THIS CANDIDATE's spend, retained for its own record. The run's total would
        // attribute every node's tokens to every row, which is a number a leaderboard
        // would quote and be wrong about; null where the provider reported nothing,
        // because an unmeasured spend is not a free one.
        spentBy.set(expansion.id, usageTotal(expansion.usage) ?? null);
        if (expansion.modelId !== null) {
          deps.reportModelCall?.({
            source: 'swarm', usage: expansion.usage, modelId: expansion.modelId,
          });
        }
        expansions.push(expansion);
      }
      if (stopped === null) continue;
      unusable.push(`${id}: ${stopped}`);
      log.event('swarm.branch_failed', {
        preset: resolved.preset,
        depth: childDepth,
        node: id,
        error: stopped,
      });
    }
    // A LEVEL THAT PRODUCED NO USABLE CANDIDATE ENDS THE RUN, by name. This is a fact
    // about the level's OUTCOME and needs no timer: continuing would select the same
    // parent again and pay another whole wave to learn the same thing, and the budget it
    // would burn doing that is what turned a dead provider into a twenty-minute run
    // reporting `best: null` with no cause anywhere in it. The causes are quoted rather
    // than summarised, because a level's failure is only actionable if the reader can see
    // which node said what.
    //
    // WHAT ENDS IT IS A LEVEL THAT BROKE, and that is narrower than a level that produced
    // no answer. A node whose provider failed left nothing to learn and the next wave
    // would meet the same provider; a node the caller's own deadline CUT, or one that ran
    // out of steps, is a node the run reports as it found it — the caller knows what
    // stopped it and reads each candidate's own stop. So the test is the report's status
    // rather than the absence of an answer, and a level holding one broken node and one
    // cut one settles instead of refusing.
    if (unusable.length > 0 && expansions.every((child) => child.incomplete?.status === 'errored')) {
      // THE LEDGER IS SETTLED ON THE WAY OUT, as it is on every other refusal past
      // `begin`. A refused run left `running` used to be merely untidy; now it is a
      // RESUME TARGET — the next re-drive of this task would re-enter a tree whose run
      // already gave up — so a refusal that does not settle its row is a refusal that
      // silently continues.
      searchLedger.fail(rootId, ledgerEpoch, Date.now());
      return unavailable(`the level at depth ${String(childDepth)} produced no candidate: all `
        + `${String(width)} of its nodes failed. ${unusable.join(' | ')}`);
    }
    if (grant) {
      reportVerdict(log, {
        verdict: { kind: 'accepted', nodeIds: expansions.map((child) => child.id) },
        preset: resolved.preset, nodeId: parent.id, atDepth: parent.depth, policy: null,
      });
    }

    // SCORE, then RECORD, then BACKPROPAGATE. One candidate at a time, into the one
    // path the instrument reads.
    /**
     * THE LEVEL this iteration scores: the wave, and then — under `expand:'aggregate'` —
     * the vertex its fan-in produced.
     *
     * A GENERATOR RATHER THAN A SECOND LOOP, because a vertex must reach the same scoring
     * body a sampled sibling reaches: one measurement, one row, one backpropagation, one
     * ranking. *Merge-back* says a merge node is graded like any other candidate, and the
     * cheapest way to make that true is for there to be nowhere else it could be graded.
     *
     * THE BARRIER IS WHERE THIS YIELDS. The fan-in runs after the body has finished with
     * every sibling of the wave — the point at which the level is complete and its
     * siblings have been compared — and it runs ONCE, because the vertex it produces is a
     * level of one and folding that into itself would consume the same work twice.
     */
    const level = async function* level(): AsyncGenerator<Expansion> {
      yield* expansions;
      if (resolved.config.expand !== 'aggregate') return;
      // The narrowing repeats the measurement guard rather than asserting it:
      // `regionRefusal` refuses `aggregate` on a run that measures nothing, so the other
      // arm is unreachable for any run that fans in at all.
      if (!ctx || !verifier || !measured || baseline === null) return;
      yield* await fanInAtLevel({ ctx, verifier, measured, baseline, atDepth: childDepth });
    };
    for await (const expansion of level()) {
      // ONE SCORER PER RUN, chosen by the axis. `verify` runs the registry's instrument
      // against the objective; `judge` runs the marginalised ensemble. Neither is a
      // fallback for the other — a judged run has no objective to measure and a verified
      // run must never report a judge's number under the objective's name.
      //
      // A FAN-IN'S VERTEX HAS NO SIBLING: it is one child of one, and the wave it
      // consumed is its PARENTS rather than its peers. `expand:'aggregate'` and
      // `score:'judge'` do not compose today — `regionRefusal` refuses the pair, because a
      // judged run places no candidate for a member's diff to be taken from — so this is
      // the shape the comparison would need rather than a path a run reaches.
      const siblings = expansion.aggregated.length > 0
        ? []
        : expansions.filter((other) => other.id !== expansion.id);
      // AN UNFINISHED NODE IS NOT SCORED AT ALL, and this is the FIRST branch because
      // every scorer below it would otherwise be handed a status line as an answer. The
      // instrument is not asked, the ensemble is not sampled, and the run pays for
      // neither — a node the clock stopped has nothing for either to look at.
      const outcome = expansion.incomplete !== null
        ? { kind: 'incomplete' as const, detail: expansion.incomplete.detail }
        : measures && verifier && ctx && measured && baseline !== null
          ? await measureChild({ ctx, verifier, measured, baseline, artifact: expansion.artifact })
          : judgeSamples !== null
            ? await judgeChild({
              rt: deps.rt, mode: deps.mode, samples: judgeSamples, task: resolved.task,
              // The floor is stated over TREE selectors only, so a flat judged run is
              // held to 1 — an ensemble that answered nothing is still not an opinion.
              minEnsemble: isTreeAdvance(resolved.config.advance.kind)
                ? JUDGE_MARGINALISATION_MIN
                : 1,
              answer: expansion.answer,
              siblings: siblings.map((other) => other.answer),
              // WP-A5's band loophole: a prose-only candidate is capped at the fail
              // ceiling where a sibling actually attempted code, so declining to attempt
              // it cannot beat attempting and failing.
              siblingsProducedCode: siblings.some(
                (other) => readProposalCode(other.answer, languages)?.kind === 'runnable',
              ),
            })
            : null;
      if (outcome?.kind === 'instrument-faulted') {
        // *The closed verifier registry*: a throw is the INSTRUMENT breaking and is never
        // converted into an unmeasurable candidate. It fails the run: no node is scored,
        // nothing is published, and the reason reaches the caller intact.
        // NAMED, because there are two scorers now and "the verifier faulted" on a judged
        // run sends a reader to an instrument the run never ran.
        searchLedger.fail(rootId, ledgerEpoch, Date.now());
        return unavailable(`the ${measures ? 'verifier' : 'judge'} faulted while scoring `
          + `${expansion.id}, so no number this run produced can be trusted: ${outcome.error}`);
      }
      // A MEASUREMENT exists only where an instrument produced one. A judged candidate
      // has none: the ensemble's median is a score and not a value in any objective's
      // unit, and putting it here would place a judge's opinion in the field the records
      // store keeps raw measurements in.
      const measurement = outcome?.kind === 'sealed' || outcome?.kind === 'scored'
        ? outcome.measurement
        : null;
      // The [0,1] the tree climbs, from whichever scorer this run has. Null where the
      // objective's own range admits none, and null for an unmeasurable candidate.
      const score = outcome?.kind === 'scored' || outcome?.kind === 'judged'
        ? outcome.score
        : null;
      const candidate: SwarmCandidate = {
        id: expansion.id,
        artifact: expansion.artifact,
        measured: measurement,
        unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
        incomplete: outcome?.kind === 'incomplete' ? outcome.detail : null,
        score,
      };
      candidates.push(candidate);
      // THE NODE'S OWN RECORD, and it is written BEFORE the tree row on purpose: a
      // record with no row is invisible to the re-entry reader, which joins from the
      // tree, while a row with no record would be a node with an answer and no
      // measurement — selectable, unrankable, and indistinguishable from one the
      // instrument could not measure. This ordering makes the second state unreachable
      // for anything this build writes (*swarm-resume.ts*).
      //
      // `outcome` is null only for a run whose `score` axis measures nothing, which is
      // an outcome that was never asked for rather than one that produced no number.
      recordSwarmNode(sql, {
        rootId,
        nodeId: expansion.id,
        record: {
          outcome,
          conclusion: expansion.conclusion,
          aggregated: expansion.aggregated,
          tokens: spentBy.get(expansion.id) ?? null,
        },
        now: Date.now(),
      });
      // DEPTH IS DERIVED: the parent's row plus one, computed here and written by the
      // engine. A node supplies no depth, so there is no number for it to lie about.
      insertSearchNode(sql, {
        nodeId: expansion.id, parentNodeId: expansion.parentId, parentMsgId: null, rootId,
        task: resolved.task, action: '', observation: expansion.artifact,
        codeUsed: null, depth: expansion.depth, msgId: null,
      });
      nodes.set(expansion.id, {
        id: expansion.id, parentId: expansion.parentId, depth: expansion.depth,
        artifact: expansion.artifact,
        measurement,
        score,
        proposal: expansion.proposal,
        proposalError: expansion.proposalError,
        granted: expansion.granted,
        conclusion: expansion.conclusion,
        transcript: expansion.transcript,
        // Not yet crossed the threshold: compaction is decided when this node becomes a
        // branch point, not when it is created.
        compacted: null,
        aggregated: expansion.aggregated,
      });
      if (expansion.proposalError) {
        // The node asked for a branch and the engine could not read the request. Not
        // one of arbitration's five policies — it never reached the arbiter — and
        // never silent, because a node told nothing simply asks again.
        log.event('swarm.proposal_unreadable', {
          preset: resolved.preset, node: expansion.id, depth: expansion.depth,
          error: expansion.proposalError,
        });
      }
      if (outcome?.kind === 'sealed') {
        // *The publication seal*: NOT scored zero, NOT written, and the run CONTINUES
        // under a seal. The measurement is retained in full because a discarded one cannot
        // adjudicate "the floor is wrong" against "the verifier is gameable".
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
      if (outcome?.kind === 'judged' && outcome.ensemble > 0) {
        // The ensemble this candidate ACTUALLY sampled. Collected rather than
        // recomputed from the knobs, because the realisation is the fact and the knobs
        // are the request. Zero attempts is excluded: an evaluation that
        // short-circuited before the ensemble never asked, which is not a realisation
        // of zero.
        ensembles.push(outcome.ensemble);
        // And onto the run's ledger row, which is where a surface can read it: a
        // measurement disclosed once and persisted nowhere is a measurement taken and
        // dropped. The store keeps the smallest any candidate reached.
        //
        // A `swarm.judge_ensemble_clamped` event used to sit here, emitted once per
        // distinct realised size when a candidate came back below the request. It is
        // GONE rather than quietened: the per-evaluation pool is now sized from the
        // request (`judgeCallPool`), so a shortfall is no longer a disclosed downgrade
        // but a broken instrument, and `judgeChild` fails the run on it. The two
        // engines that still borrow the shipped dial keep their own events —
        // `mcts.judge_ensemble_clamped` and `head.judge_ensemble_clamped` — because
        // there the clamp is still reachable and still honest.
        searchLedger.observeJudgeEnsemble(rootId, outcome.ensemble);
      }
      if (score !== null) {
        backpropagate(sql, expansion.id, score);
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
      // THE WINNER, in the quantity this run's own scorer produced. A verified run ranks
      // on the RAW measurement in the objective's direction — `normalisedScore` clamps
      // at 1, so two candidates that both reached the target would tie on the score and
      // not on the value — and a judged run ranks on the ensemble's median, where higher
      // is better by construction.
      const rank = outcome?.kind === 'scored'
        ? outcome.measurement.value
        : outcome?.kind === 'judged' ? outcome.score : null;
      if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
        best = candidate;
        bestValue = rank;
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

    // THE LEVEL BARRIER IS THIS RUN'S CHECKPOINT, and it is what makes the ledger row
    // readable while the search is alive. The row used to be written once at `begin`
    // and once at the settle barrier, so an evicted run left `iter=0/5` on disk
    // forever — the state two rows of the live incident were still in eleven hours
    // later — and a re-entry had nothing to read progress from. The barrier is the
    // right grain rather than a timer: it is the point at which a wave is measured,
    // compared and recorded, so the numbers written here are facts the tree agrees
    // with. Fenced on this run's lease, so an executor from a superseded activation
    // cannot write over it.
    searchLedger.checkpoint(
      rootId, ledgerEpoch, candidates.length, budget.remaining, Date.now(),
    );
    // AND IT IS SAID OUT LOUD, the way `mcts.checkpoint_reached` is. The ledger row is
    // the only real heartbeat a hosted search has, and the MCTS half of that lesson was
    // learned once already: a durably-checkpointed search ran for hours and produced
    // nothing in Workers Logs per iteration, so nobody could tell a working search from
    // a hung one. A swarm now checkpoints, so it says so.
    log.event('swarm.checkpoint_reached', {
      preset: resolved.preset,
      root_id: rootId,
      epoch: ledgerEpoch,
      expansions: candidates.length,
      remaining: budget.remaining,
    });
  }

  // THE SWEEP. Every THOUGHT node's proposal that selection never reached is answered
  // now, against the state that kept it waiting — the rule in *Arbitration* that a
  // proposal is never dropped silently, and the only place `depth-exhausted` and
  // `budget-exhausted` can be reached, since selection excludes a capped node and the
  // loop guards the budget.
  // An agent node needs no sweep: its request was answered inside its own tool call.
  for (const node of nodes.values()) {
    if (!node.proposal) continue;
    answerProposal({ log, node, resolved, budget });
    node.proposal = null;
  }

  // MERGE-BACK: how a settled swarm's work reaches the origin (*Merge-back*), and the
  // reason the answer does not simply stay in a workspace nobody reads again. Without this
  // the path holds whichever candidate was measured last, which is a different artifact
  // from the one reported.
  //
  // THE POLICY IS DERIVED FROM `settle`, never chosen here — the same move as `settleOf`
  // deriving `settle` from the axes. A scored run settles on one incumbent and applies
  // it; `settle:'merge'` scores nothing, so it has no verifier and no `best`, and
  // `synthesis` correctly applies nothing.
  //
  // THE MEMBER'S DIFF IS `reported`, and that provenance is what makes this reachable
  // today. The per-node homes *Isolation* describes are not built, so no node has a
  // workspace diff that could be said to be its own — but the engine places the node's
  // REPORTED answer, and a report is that node's by construction whatever plane it ran on.
  //
  // WHAT THIS ADDS OVER THE BARE WRITE IT REPLACES, stated narrowly so nobody reads more
  // into it. The settle placement is now a POLICY with a named event trail, and the
  // transaction bound is checked before it, so an oversized winner is refused with the
  // bound named instead of handed to the substrate to split.
  //
  // WHAT IT DOES NOT ADD: `base` is read from the origin at settle, so the drift and
  // stale-verdict rules are structurally satisfied here rather than enforced. That is
  // deliberate and it preserves behaviour exactly — a reported answer is a whole-file
  // replacement, not a patch against an earlier base, and `measureChild` has already
  // overwritten this path once per candidate. Taking the base from measurement time
  // instead would refuse the winner on every multi-candidate run. Those rules bite when a
  // member's diff comes from a private home, which is *Isolation*'s to deliver.
  if (ctx) {
    const policy = mergePolicyOf(resolved.settle);
    const readOrigin = originReader(ctx.vfs);
    const members = best && verifier
      ? [await reportedMember({
        nodeId: best.id, answer: best.artifact, score: best.score,
        path: verifier.artifact,
        // NO EDGES AT THE SETTLE, even where the winner is a fan-in's own vertex, and the
        // asymmetry with the fan-in is the point. There the order is load-bearing —
        // whichever member lands LAST is what the path holds, so an aggregation applied
        // before a parent it reconciled would be overwritten by that parent. Here exactly
        // one member is applied: its reported answer replaces the path whole, and it
        // already CONTAINS what it consumed. A dependency edge would refuse the winner
        // for the state of members this policy applies none of, and the refusal's own
        // remedy — reorder the members — cannot be followed with one.
        deps: [],
        readOrigin,
      })]
      : [];
    await mergeBack({ policy, members, settled: [...landed] }, {
      log,
      preset: resolved.preset,
      readOrigin,
      applyMember: singlePathApply(ctx.vfs),
    });
  }

  // CARRY ADMISSION, at the barrier and after the sweep, because a candidate answered
  // by the sweep is a candidate that could be carried and deciding before it would
  // silently exclude the whole swept set.
  //
  // This is the threshold's ONLY reader. `carry:'artifacts'` declares an admission
  // `threshold` on its own arm (*Presets*) and nothing consulted it, which made a tagged
  // parameter that a preset cannot even construct into config that changed nothing —
  // exactly the accepted-and-ignored shape *Accepted and ignored* refuses.
  // `carry:'elites'` declares no threshold and still requires a MEASUREMENT: an
  // unmeasurable candidate is not a zero-scoring elite, and seeding the next run from one
  // is how an unscored artifact becomes an incumbent.
  //
  // COMPLEMENTARY TO `carrySuppressed`, not a second copy of it. That is the SEAL, per
  // cell, about the run; this is ADMISSION, per candidate, about the candidate. A run
  // can be unsealed and still carry nothing because everything scored under the bar.
  const carried = settleCarry({
    carry: resolved.config.carry,
    publication,
    members: candidates.map((candidate) => ({ nodeId: candidate.id, score: candidate.score })),
  }, { log, preset: resolved.preset });

  // The aggregate beside the per-candidate events, because "how many survived this
  // run" is a question a reader should not have to answer by counting N lines.
  log.event('swarm.carry_settled', {
    preset: resolved.preset,
    carry: resolved.config.carry.kind,
    admitted: carried.filter((entry) => entry.verdict.kind === 'admitted').length,
    refused: carried.filter((entry) => entry.verdict.kind === 'refused').length,
  });

  // AND THE ADMISSIONS REACH PERSISTENCE. This is what the barrier was deciding for:
  // admission was computed at the one place that knows both the score and the seal, and
  // the write it gates now exists. `elites` and `artifacts` BOTH land here — the records
  // store is where that axis lands — and the seal is checked a second time inside the
  // writer, over the `records` surface, rather than assumed from the barrier's verdict.
  //
  // UNDER `advance:'archive'` THE WRITER IS THE ARCHIVE'S. Same store and same rows — the
  // grid IS this table, one descriptor partition per cell — with two things the bare write
  // does not do: the candidate is binned into the cell its INSTRUMENT witnessed, and it is
  // refused when it duplicates an occupant of that cell. `carry:'elites'` is what makes
  // those occupants the next run's starting population, which is the whole reason the
  // admission the barrier computes is worth computing.
  //
  // A run with no OBJECTIVE IDENTITY records nothing and says so: a record is keyed by
  // the metric and the instrument, and a judged or unscored run measured neither. That
  // is `records: null` on the report, which is a different claim from zero rows written.
  const records: ExplorationRecordsReport | null = identity === null ? null : (() => {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const configDigest = configDigestOf(resolved);
    let written = 0;
    let notBetter = 0;
    let tooClose = 0;
    // KEYED OFF THE AXIS AND NOT OFF THE VERDICT. `admitCarry` returns `admitted` for
    // `none` and `reflections` because the gate is not those values' business — neither
    // reaches a publication surface — so a loop that read the verdict alone would make
    // `carry:'none'` publish, which is the axis accepted and ignored. The barrier's
    // verdict decides which of a PUBLISHING carry's candidates survive; whether the run
    // publishes at all is this axis.
    for (const entry of publishing === null ? [] : carried) {
      if (entry.verdict.kind !== 'admitted') continue;
      const candidate = byId.get(entry.nodeId);
      // An admitted candidate under a publishing carry always carries a score, and a
      // score on a verified run always comes from a measurement — but the record keeps
      // the RAW value, so the measurement is what it is read from and its absence skips
      // the row rather than fabricating one.
      if (!candidate || candidate.measured === null) continue;
      const write: Omit<ExplorationWrite, 'descriptor'> = {
        identity,
        artifact: candidate.artifact,
        value: candidate.measured.value,
        detail: candidate.measured.detail,
        measured: candidate.measured.measured ?? null,
        preset: resolved.preset,
        label: resolved.label,
        rootId,
        configDigest,
        depth: maxDepth,
        branches,
        floor: measured?.floor ?? null,
        // NULL and not zero. Nothing here prices tokens — no cost model reaches this
        // runner — and a record claiming a run cost nothing is worse than one admitting
        // the spend was never converted.
        costUsd: null,
        costTokens: spentBy.get(candidate.id) ?? null,
        at: Date.now(),
      };
      // One refusal event with one field set, three causes filling it. The fields are
      // CONSTANT across the causes for `settleCarry`'s reason — a name assembled per branch
      // produces one name per outcome and none a query can be written against — and the two
      // that only the novelty test has are empty and -1 elsewhere, the same way that
      // function spells an inapplicable threshold.
      const raw = candidate.measured.value;
      const refused = (fields: {
        readonly cause: string; readonly occupant: string; readonly distance: number;
      }): void => {
        log.event('swarm.record_refused', {
          preset: resolved.preset,
          carry: resolved.config.carry.kind,
          node: candidate.id,
          metric: identity.metric,
          value: raw,
          ...fields,
        });
      };
      let verdict: ArchiveVerdict;
      // The cell this row landed in, empty for a run with no partition. Read back from
      // what the write USED rather than recomputed for the event, so the coverage a reader
      // greps and the descriptor in the row cannot disagree.
      let cellName = '';
      if (archive === null) {
        // NO PARTITION, which is not "the unnamed cell": this objective has no descriptor
        // and its comparable set is one cell, exactly as `ExplorationRecord.descriptor`'s
        // nullability states.
        verdict = recordExploration(sql, { publication, write: { ...write, descriptor: null } });
      } else {
        const cell = archiveCellOf(archive.key, candidate.measured.measured);
        if (cell.kind === 'unwitnessed') {
          // The run-level check refuses a key this instrument never reports, so reaching
          // here means the instrument reported it for the baseline and not for this
          // candidate. There is no cell to place it in and none to invent: an elite binned
          // into a fabricated coordinate is the mis-binning *Validity over the resolved
          // configuration* refuses, and it is silently unrecoverable in a way a refusal
          // is not.
          refused({ cause: 'unwitnessed', occupant: '', distance: -1 });
          continue;
        }
        cellName = cell.descriptor;
        verdict = admitToArchive(sql, {
          publication,
          write: { ...write, descriptor: cell.descriptor },
          novelty: archive.novelty,
        });
      }
      if (verdict.kind === 'recorded') {
        written += 1;
        log.event('swarm.record_written', {
          preset: resolved.preset,
          carry: resolved.config.carry.kind,
          node: candidate.id,
          metric: identity.metric,
          value: candidate.measured.value,
          record: verdict.recordKey,
          displaced: verdict.displaced ? 1 : 0,
          cell: cellName,
        });
      } else if (verdict.cause === 'too-close') {
        tooClose += 1;
        // THE OCCUPANT IS NAMED. A novelty rejection nobody can trace back to what it
        // duplicated is indistinguishable from a threshold set wrong, and the two want
        // opposite corrections.
        refused({ cause: verdict.cause, occupant: verdict.occupant, distance: verdict.distance });
      } else {
        if (verdict.cause === 'not-better') notBetter += 1;
        refused({ cause: verdict.cause, occupant: '', distance: -1 });
      }
    }
    return {
      carriedIn: carriedIn.length,
      carriedInBest: carriedBest?.value ?? null,
      // The COVERAGE carried in, over the cells those rows span. `new Set` over a list
      // already in hand rather than a second query: the rows were read at the top of the
      // run and counting their partitions is arithmetic on them.
      carriedInCells: new Set(carriedIn.map((record) => record.descriptor)).size,
      written,
      notBetter,
      tooClose,
    };
  })();

  // WHAT THE SEAL COST, IN CELLS. The disclosure *The publication seal* requires is
  // stated over cells rather than over refused writes, and the field was pinned at one
  // because a flat run has exactly one partition — true then, and an archive is the value
  // that makes it false. Counted over the candidates this run MEASURED, because those are
  // the cells it would have published into, and only under a seal: with the run open there
  // is no suppression to report and the number would be a set built for nobody.
  const suppressedCells = publication.kind === 'open'
    ? 0
    : archive === null
      ? (best === null ? 0 : 1)
      : new Set(candidates.flatMap((candidate) => {
        if (candidate.measured === null) return [];
        const cell = archiveCellOf(archive.key, candidate.measured.measured);
        return cell.kind === 'cell' ? [cell.descriptor] : [];
      })).size;

  // The BINDING realisation: the smallest ensemble any candidate actually sampled. Null
  // where none reached the ensemble, which for a judged run means every candidate
  // short-circuited before a judge was asked.
  const judgeEnsemble: JudgeEnsembleReport | null = judgeSamples === null
    ? null
    : { requested: judgeSamples, realised: ensembles.length > 0 ? Math.min(...ensembles) : null };

  const report = settleReport({
    resolved, measured, baseline, publication, candidates, best, carry: publishing,
    records, judgeEnsemble, suppressedCells,
    // Every child this run actually created and measured — the candidate list IS the
    // count, rather than a second tally beside it that could disagree.
    expansions: candidates.length, usage, durationMs: Date.now() - started,
    // WHAT THE FAN-INS DID, or null on a run that fans in nothing — which is every
    // `expand:'sample'` run, and is a different claim from a fan-in that did nothing.
    fanIn: resolved.config.expand === 'aggregate'
      ? {
        levels: fanInLevels,
        order: mergeOrder,
        merged: fanInMerged,
        vertices: aggregateVertices,
        unusableParents: unusableParents.size,
        prunedParents: prunedParents.size,
      }
      : null,
    // WHAT THIS RUN RE-ENTERED, or null on a first attempt. `expansions` above counts
    // the WHOLE search across attempts — one request, one tree, one count — so this is
    // the field that says how much of it predates this activation.
    resumed: reentry === null ? null : {
      rootId,
      inheritedExpansions,
      remainingBudget: expansionBudget - inheritedExpansions,
      inheritedTokens,
      abandonedNodes: reentry.abandoned,
      superseded: reentry.superseded,
      // The lease IS the attempt counter: `reclaim` bumps it exactly once per re-entry,
      // and epoch 0 is the first attempt — so this run is the (epoch + 1)th.
      attempt: reentry.epoch + 1,
    },
    // Why the run ended, from what the loop observed rather than from the count. A
    // budget spent with nothing left to select is a SETTLED search; a budget spent
    // with a frontier still open is a truncated one, and a search narrower than its
    // configured width is truncated too even if it stopped for another reason. A
    // mission cap that ran out is `budget` with expansions still unspent — the one
    // case where the two budgets disagree, and the ledger's is the one that stopped
    // the run.
    stop: aborted
      ? 'aborted'
      : missionSpent || lost > 0 || (budget.remaining <= 0 && selectFrontierNode(sql, {
        rootId, policy, maxDepth,
        explorationWeight: resolved.config.explorationWeight
          ?? DEFAULT_CONFIG.mcts.explorationWeight,
      }) !== null)
        ? 'budget'
        : 'settled',
  });

  // THE LEDGER, SETTLED. The progress columns say what the run finished rather than
  // where it was checkpointed, because a swarm has no checkpoint: its budget unit is
  // one child, so the candidates it produced ARE its spent iterations and the budget
  // it never spent is what is left. `aborted` is a failed run here — the caller gets a
  // settle report either way, but a row that says `converged` about a run cut short
  // would make the surface claim a search settled that did not.
  searchLedger.checkpoint(
    rootId, ledgerEpoch, candidates.length, budget.remaining, Date.now(),
  );
  if (aborted) searchLedger.fail(rootId, ledgerEpoch, Date.now());
  else searchLedger.converge(rootId, ledgerEpoch, Date.now());
  const result: SwarmResult = {
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
  if (runProfile) Object.assign(result, { profile: runProfile });
  return result;
}

/**
 * One node's answer as a merge-back member, with its diff taken from what it REPORTED.
 *
 * One path — the verifier's artifact — because that is what this engine places, and `base`
 * is read from the origin NOW so the diff is a patch against the state it is about to be
 * applied onto rather than against a state nobody checked.
 *
 * THE VERDICT IS REAL, not a placeholder. A node reaches this having been measured through
 * the verifier registry, so it HAS been checked; the pair it binds is this diff against
 * this base, which is the base its own apply will see. That is why rule 4 does not fire at
 * a settle of one member — and why it does fire, and re-verifies, for every member after
 * the first of a fan-in, whose base the member before it moved.
 *
 * `deps` ARE THE DAG'S EDGES and empty is not "unordered": a sampled node depends on
 * nothing this settle applies, and a vertex depends on the parents it consumed.
 */
async function reportedMember(input: {
  readonly nodeId: string;
  readonly answer: string;
  readonly score: number | null;
  readonly path: string;
  readonly deps: readonly string[];
  readonly readOrigin: (path: string) => Promise<string | null>;
}): Promise<MergeMember> {
  const { readOrigin } = input;
  const diff: MemberDiff = {
    nodeId: input.nodeId,
    files: [{ path: input.path, base: await readOrigin(input.path), after: input.answer }],
    provenance: 'reported',
  };
  return {
    nodeId: input.nodeId,
    diff,
    verdict: {
      memberDigest: memberDigestOf(diff),
      baseDigest: await baseDigestOf(diff, readOrigin),
      clean: true,
    },
    // The engine chose the path, so there is no declared scope to escape, and the score
    // is what the search measured.
    scope: null,
    deps: input.deps,
    score: input.score,
  };
}

/**
 * The atomic write a reported member's apply rides.
 *
 * ONE PATH, and it REFUSES more, which is the honest shape of what this workspace can
 * promise. `vfs.writeFile` is path-atomic, so a single-file member is genuinely
 * all-or-nothing; a multi-file member would need the substrate's one-transaction batch
 * write, and looping here instead would be exactly the torn apply the size bound exists
 * to prevent. A reported member is always one path, so the refusal is unreachable today
 * and stays fail-closed for whoever offers a multi-file member first.
 */
function singlePathApply(vfs: VFS): MemberApply {
  return async (files) => {
    if (files.length > 1) {
      throw new KinuError('unsupported',
        `this workspace can apply one path atomically and this member has ${
          String(files.length)
        }. A per-file loop would publish a committed prefix if a later file failed, so it is `
        + "refused instead: wire the substrate's one-transaction batch write.");
    }
    for (const file of files) {
      if (file.after === null) await vfs.unlink(file.path);
      else await vfs.writeFile(file.path, file.after);
    }
  };
}

/** The report *Witness objectives* requires, assembled from what the run actually
 *  observed. */
function settleReport(input: {
  readonly resolved: ResolvedSwarm;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly publication: PublicationState;
  readonly candidates: readonly SwarmCandidate[];
  readonly best: SwarmCandidate | null;
  /** The publishing `carry` in force, or null when this run's carry writes nothing a
   *  later run reads. Derived once by the caller and passed rather than re-derived here:
   *  the same predicate decides whether the run reads the store at all, and two
   *  derivations of one fact are two things that can disagree. */
  readonly carry: PublishingCarry | null;
  readonly records: ExplorationRecordsReport | null;
  readonly judgeEnsemble: JudgeEnsembleReport | null;
  /**
   * The cell count *The publication seal* discloses for a suppressed carry, computed by
   * the caller because only it knows the archive in force: one for a flat run's single
   * partition, and for `advance:'archive'` the number of cells the run measured into and
   * could not keep. Zero on an open run, where there is no suppression to report.
   */
  readonly suppressedCells: number;
  readonly expansions: number;
  /** Why the run ended, as the LOOP observed it. Derived there rather than inferred
   *  from the candidate count, because a tree's count carries no information about
   *  whether anything was still reachable when the budget ran out. */
  readonly stop: SwarmSettleReport['stop'];
  readonly usage: Usage;
  readonly durationMs: number;
  /** What the fan-ins did, or null on a run that fans in nothing. */
  readonly fanIn: SwarmFanInReport | null;
  /** What this run re-entered, or null on a first attempt. */
  readonly resumed: SwarmResumeReport | null;
}): SwarmSettleReport {
  const { resolved, measured, best, carry } = input;
  return {
    settle: resolved.settle,
    floorMargin: measured?.floor ? floorMargin(measured.floor, measured.direction) : null,
    baseline: input.baseline,
    // A witness verdict about THIS RUN. `false` is "this search did not find one",
    // and there is no field on this report that could say none exists.
    witnessFound: measured?.witness ? best !== null && best.score === 1 : null,
    // The count is one per CELL rather than per refused publication, and the cells are
    // the caller's to count: a flat run has exactly one partition, while an archive run
    // has as many as its candidates witnessed.
    carrySuppressed: carry
      ? carrySuppression(input.publication, carry, input.suppressedCells)
      : null,
    records: input.records,
    judgeEnsemble: input.judgeEnsemble,
    stop: input.stop,
    expansions: input.expansions,
    tokens: usageTotal(input.usage) ?? null,
    durationMs: input.durationMs,
    fanIn: input.fanIn,
    resumed: input.resumed,
  };
}
