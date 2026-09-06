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
 *     axis, and it is a two-way choice because `agentNodes` below is the only
 *     thing that reads it: `answer` runs a real agent per node — a tool loop with
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
import type { LanguageModel, ModelMessage } from 'ai';
import { DEFAULT_CONFIG } from '../config';
import type { PersistedSearchKnobs } from '../mcts/search-store';
import type { SwarmProfileSnapshot } from '../profiles';
import { pruneLowValueBranches } from '../mcts/pruning';
import { selectFrontierNode } from '../mcts/frontier';
import { diagnostics, type Logger } from '../obs/index';
import { renderCauseChain, type Refusal } from '../obs/error';
import { usageTotal, type Usage, addUsage } from '../usage';
import type { NodeLoopHost } from './node-agent';
import type { PublishHeadStream } from '../heads/head-stream';
import type { AnnounceHeadActivity } from '../heads/live-journal';
import { SwarmBudget } from './swarm-budget';
import type { NodeWorkspace, NodeWorkspaceProvisioner } from './node-workspace';
import { missionMeter, type MissionScope } from '../mission-budget';
import type { WebSearchProvider } from '../web/index';
import type { ResolvedVerifier } from './verifier-registry';
import { PUBLISHING_CARRIES } from './objective';
import type {
  MeasurementContext, MeasuredObjective, ObjectiveDirection, ObjectiveIdentity,
  PublishingCarry,
} from './objective';
import { isTreeAdvance } from './swarm';
import { markSwarmNodeMerged } from './swarm-resume';
import { createLevelFanIn } from './fanin';
import type {
  ResolvedSwarm, SwarmCandidate, SwarmResult,
} from './swarm';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSink } from '../events/model-call';
import type { WorkMode } from '../prompting/surface';
import {
  buildNodeDeps, createRoot, initRunLedgers, prepareMeasurement, prepareParetoMeasurement,
  readCarryIn, refuseContendedRun, regionRefusal, resolveNodeModel, resolveNodeModels,
  resolveReentry, seedResumedSearch, unavailable, unsupported,
  type PreparedParetoMeasurement,
} from './swarm-setup';
import { assignedRootGrant, planLevel, resumedWaves } from './swarm-level';
import {
  answerProposal, awaitLevel, frontierPolicyOf, pathTo, reportVerdict,
  selectParetoFrontierNode,
} from './swarm-tree';
import type { Expansion, LevelMember, TreeNode } from './swarm-tree';
import { expandChild, sharedPrefix } from './swarm-expansion';
import type { ExpandChildCtx } from './swarm-expansion';
import { measureChild, reportGate, scoreExpansion } from './swarm-scoring';
import { settleRun } from './settle';
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
  /** Where a node's transient output frames go while a step is still being
   *  produced. Absent = nothing watching; the node's durable steps are
   *  unaffected either way (heads/head-stream.ts). */
  readonly publishHeadStream?: PublishHeadStream;
  /**
   * Where this run's DURABLE journal writes are announced — a node appearing, a
   * step landing, a report filing.
   *
   * The durable twin of {@link publishHeadStream}, and the pair is the whole of
   * head liveness: a frame says what a node is producing right now and is
   * superseded by the step that contains it, while this says a node's LEDGER
   * moved and is what makes a reader re-read the store it renders from.
   *
   * A swarm carried the transient half and not this one, so a running search
   * painted a live tail whose landed step arrived only on the reader's own
   * clock — the same words on screen twice until a poll retired them. Absent is
   * a backend with nothing watching, and then the journal writes in silence
   * exactly as it always did.
   */
  readonly announceHeadActivity?: AnnounceHeadActivity;
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
  /** How a node's own runtime is built once it has a home — see
   *  {@link NodeAgentDeps.runtimeForWorkspace}. */
  readonly runtimeForWorkspace?: (workspace: NodeWorkspace) => Promise<AgentRuntime>;
  /**
   * Where a TOOL-USING node's loop runs.
   *
   * Present hands each answer node to a host that gives it its own
   * storage and its own shell state — on the Cloudflare backend a
   * `SubordinateAgent` facet in node mode, the same class a fork's head already runs in. Absent
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
  const paretoAdvance = resolved.config.advance.kind === 'pareto';
  const judgeSamples = resolved.config.score.kind === 'judge' ? resolved.config.score.samples : null;
  // THE PER-NODE ROUTING, resolved before anything spends: an unresolvable spec is
  // refused here, ahead of the baseline measurement, the ledger row and every node —
  // the "before anything spends" the field's first life lacked and its return must
  // keep. `resolveNodeModels` owns the seam and the refusal text. `null` resolved to
  // the empty array is the unrouted default: every node then runs `nodeModel` below.
  const nodeModelsResult = resolveNodeModels({
    models: resolved.models, resolveModel: deps.resolveModel,
  });
  if ('reason' in nodeModelsResult) return nodeModelsResult;
  const nodeModels = nodeModelsResult.models;
  const publishing = paretoAdvance
    ? null
    : PUBLISHING_CARRIES.find(
      (carry): carry is PublishingCarry => carry === resolved.config.carry.kind,
    ) ?? null;
  const archive = resolved.config.advance.kind === 'archive' && resolved.key !== null
    ? { key: resolved.key, novelty: resolved.config.advance.novelty }
    : null;
  const log = deps.logger ?? diagnostics;

  let measured: MeasuredObjective | null = null;
  let pareto: PreparedParetoMeasurement | null = null;
  let verifier: ResolvedVerifier | null = null;
  let witnessVerifier: ResolvedVerifier | null = null;
  let ctx: MeasurementContext | null = null;
  let baseline: number | null = null;
  let identity: ObjectiveIdentity | null = null;

  if (measures) {
    if (paretoAdvance) {
      const prepared = await prepareParetoMeasurement({ rt: deps.rt, resolved });
      if ('reason' in prepared) return prepared;
      pareto = prepared;
      ctx = prepared.ctx;
      verifier = prepared.instruments[0]?.verifier ?? null;
    } else {
      const prepared = await prepareMeasurement({ rt: deps.rt, resolved, archive, log });
      if ('reason' in prepared) return prepared;
      ({ measured, verifier, witnessVerifier, ctx, baseline, identity } = prepared);
    }
  }

  // The announcing journal when this caller has a channel, the plain one when it
  // has none — the same instance every write below goes through, so a node's
  // spawn, its steps and its report all reach an open surface by the one push.
  const { sql, journal, searchLedger } = initRunLedgers(deps.rt, deps.announceHeadActivity);
  const { carriedIn, carriedBest } = readCarryIn({
    sql,
    identity,
    publishing,
    floor: measured?.floor ?? null,
    preset: resolved.preset,
    carryKind: resolved.config.carry.kind,
    metric: measured?.metric ?? '',
    log,
  });
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
   * WHAT SELECTS THE NEXT PARENT, decided once here instead of re-derived per
   * iteration — and the reason it is one value rather than two is the state it
   * makes impossible.
   *
   * A pareto run selects on the DECLARED AXES of an instanced or vector
   * objective, and those axes exist only where the measurement was prepared, so
   * `advance:'pareto'` with nothing measured had no scheduler at all. The loop
   * expressed that as `pareto === null ? null : select(...)` inside the branch it
   * had already tested, which selects nothing on the first iteration and settles
   * the run EMPTY: no candidates, no spend, and no sentence saying why. The tool
   * surface cannot reach it (`swarmValidity` requires an instanced or vector
   * objective for a frontier, and both score by `verify`), but this is also the
   * in-process entry point, and an in-process caller got the silent version.
   *
   * Refused here, before the ledger row and before any node, in the vocabulary
   * the rest of this function refuses in.
   */
  const scheduler = policy === 'pareto'
    ? pareto === null ? null : { kind: 'pareto' as const, axes: pareto.axes }
    : { kind: 'frontier' as const, policy };
  if (scheduler === null) {
    return unsupported('advance:"pareto" orders its frontier by the axes an instanced or vector '
      + `objective declares, and this run resolved none — score:"${resolved.config.score.kind}" `
      + 'measures nothing a front could be ordered by, so every selection would return no node '
      + 'and the run would settle empty. Give it an instanced or vector `objective` with '
      + 'score:"verify", or select with advance:"uct".');
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
  const { reentry, runProfile } = resolveReentry({
    sql, searchLedger, journal, redrive: deps.redrive,
    task: resolved.task, preset: resolved.preset,
    profile: deps.profile ?? null, log,
  });

  const nodeModelResult = resolveNodeModel({
    model: deps.model, resolveModel: deps.resolveModel, runProfile,
  });
  if ('reason' in nodeModelResult) return nodeModelResult;
  const nodeModel = nodeModelResult.model;

  const contendedRefusal = refuseContendedRun({
    searchLedger, reentry, task: resolved.task, preset: resolved.preset,
    redrive: deps.redrive, log,
  });
  if (contendedRefusal) return contendedRefusal;

  const { rootId, nodes, root } = await createRoot({
    sql, reentry, verifier, ctx, resolved,
    originContext: deps.originContext, measures, journal, agentNodes,
  });

  const candidates: SwarmCandidate[] = [];
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
  const seeded = seedResumedSearch({ reentry, nodes, rankDirection, spentBy });
  candidates.push(...seeded.candidates);
  /**
   * WHAT THE SCORING BARRIER MOVES — one object, because one function moves it.
   *
   * `scoreExpansion` owns the single ordered transition every candidate crosses
   * and writes all four of these back through `state`. They were ALSO locals
   * here, copied into a fresh object at every level and copied back out after
   * it, so one piece of state had two spellings and every level had to remember
   * to re-sync them — and three of the four were initialised to a value that
   * was then overwritten unconditionally by the seed below.
   *
   * Seeded from the re-entry and not from nothing: a resumed search's best
   * candidate, its publication seal and the ensembles it already realised are
   * facts its first attempt established. Inferred rather than annotated, so the
   * seed's own types are what this carries — the four fields `scoreExpansion`
   * declares it needs, from the one function that establishes them.
   */
  const scoringState = {
    publication: seeded.publication,
    best: seeded.best,
    bestValue: seeded.bestValue,
    ensembles: [...seeded.ensembles],
  };
  const { inheritedExpansions, inheritedTokens } = seeded;
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
   * THE CALLER'S OWN FIRST LEVEL, if they assigned one: the root's proposal, written
   * by the caller and debited here (`swarm-level.ts`'s `assignedRootGrant`).
   *
   * The loop expands it through the grant path it already had, so nothing below this
   * line knows the difference between a level a node proposed and one the caller did.
   */
  const assigned = assignedRootGrant({ resolved, reentry, budget });
  if (assigned) root.granted = assigned;
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
  // A RE-ENTRY TOUCHES THE ROW IT CLAIMED instead of writing one. `begin` is a
  // plain INSERT that throws on an existing root, so calling it here would fail
  // on the row this run just claimed. The row carries no progress for a
  // swarm to write:
  // progress is derived from the tree at read time (*search-store.ts*), so a re-entry
  // refreshes only the heartbeat.
  const ledgerConfig: PersistedSearchKnobs = {
    budget: expansionBudget,
    branches,
    mode: deps.mode,
    maxDepth,
    explorationWeight: resolved.config.explorationWeight,
    judgeSamples: judgeSamples ?? undefined,
  };
  if (runProfile) Object.assign(ledgerConfig, { profile: runProfile });

  if (deps.originContext) Object.assign(ledgerConfig, {
    originContext: deps.originContext,
  });
  if (reentry) {
    searchLedger.touch(rootId, ledgerEpoch, Date.now());
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

  const nodeDeps = buildNodeDeps({
    rt: deps.rt, model: nodeModel, journal, logger: log,
    signal: deps.signal, reportModelCall: deps.reportModelCall,
    maxWallClockMs: deps.maxWallClockMs, mission: deps.mission,
    provisionHome: deps.provisionHome, runtimeForWorkspace: deps.runtimeForWorkspace,
    host: deps.host,
    executeTool: deps.executeTool, webSearch: deps.webSearch,
    publishHeadStream: deps.publishHeadStream,
  });
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
   * What every child spawn of this run is handed - the context {@link expandChild}
   * closes over, built once.
   */
  const expandCtx: ExpandChildCtx = {
    resolved,
    mode: deps.mode,
    languages,
    measured,
    baseline,
    verifier,
    carriedBest,
    agentNodes,
    maxDepth,
    nodeModel,
    // Per-node routing, empty for the unrouted default: `expandChild` assigns by slot
    // and falls back to `nodeModel` when the list is empty, so the default and the
    // routed path are one mechanism with two sources rather than two mechanisms.
    nodeModels,
    signal: deps.signal,
    nodeDeps,
    budget,
    rootId,
    log,
    reportModelCall: deps.reportModelCall,
    charge: (spent: Usage) => mission.charge(spent),
  };
  /** THE RUN'S FAN-IN (`strategy/fanin.ts`), built over this run's own collaborators.
   *  The module owns the policy — which parents are consumed, what orders a merge, where
   *  a conflict's vertex comes from, and the landed ledger across barriers; everything
   *  passed here is a seam the runner already owned. */
  const levelFanIn = createLevelFanIn<TreeNode, Expansion>({
    nodes,
    ancestorPath: (parent) => pathTo(nodes, parent),
    rootId,
    maxDepth,
    budget,
    log,
    preset: resolved.preset,
    context: resolved.config.context,
    sql,
    markMerged: (id) => markSwarmNodeMerged(sql, id, Date.now()),
    countLost: () => { lost += 1; },
    expandChild: (input) => expandChild(expandCtx, input),
    measureChild,
    sharedPrefix: agentNodes
      ? (parent) => sharedPrefix({ parent, compactShared: deps.compactShared, model: nodeModel, log, preset: resolved.preset })
      : undefined,
  });
  levelFanIn.seedLanded(
    (reentry?.nodes ?? []).filter((node) => node.merged).map((node) => node.id),
  );
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

  /** The unfinished levels this re-entry owes, drained before anything is selected
   *  (`swarm-level.ts`). Empty on a first attempt. */
  const resumeWaves = resumedWaves(reentry);

  while (resumeWaves.length > 0 || budget.remaining > 0 || reservedChildren()) {
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
    /**
     * THE WAVE THIS ITERATION RUNS, and there are three sources in strict order.
     *
     * A RESUMED WAVE FIRST, and it is neither selected nor arbitrated nor charged: it
     * was selected, arbitrated and paid for by the attempt that spawned it, its ids
     * are already durable, and `inheritedExpansions` has already debited it from this
     * attempt's budget. Draining it before selection is what keeps a re-entry from
     * expanding anywhere else while it still owes an answer for a node it created.
     *
     * A PAID GRANT NEXT, and that is not a bypass of the scheduler: the grant was
     * arbitrated against the scheduler's own policies — this `advance` expands at a
     * node, the depth cap admits the level, the budget could pay — and accepted. The
     * node was told "children reserved". Letting selection postpone that indefinitely
     * would make the verdict a lie, and letting the budget be spent elsewhere first
     * would make it unpayable.
     *
     * THEN SELECTION.
     */
    const resumed = resumeWaves.shift() ?? null;
    const owed = resumed
      ? null
      : [...nodes.values()].find((node) => node.granted !== null);
    const selected = resumed
      ? { id: resumed.parentId }
      : owed ?? (scheduler.kind === 'pareto'
        ? selectParetoFrontierNode(nodes, maxDepth, scheduler.axes)
        : selectFrontierNode(sql, {
          rootId, policy: scheduler.policy, maxDepth,
          explorationWeight: resolved.config.explorationWeight
            ?? DEFAULT_CONFIG.mcts.explorationWeight,
        }));
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
    //
    // A RESUMED WAVE ASKS NOTHING OF THE ARBITER and leaves the parent's own state
    // alone. Its width is what the dead attempt actually created, and a grant this
    // parent may still be owed is owed by a LATER iteration — clearing it here would
    // spend a debit on a wave that was already paid for.
    const grant = resumed ? null : parent.granted ?? (() => {
      const decision = answerProposal({ log, node: parent, resolved, budget });
      return decision?.kind === 'granted' ? decision : null;
    })();
    if (!resumed) {
      parent.proposal = null;
      // Cleared because a tree selector may re-select an expanded node: `uct` re-widens,
      // and a grant left in place would be spent twice off one debit.
      parent.granted = null;
    }

    // THE LEVEL'S WIDTH — what every member of it is told about its siblings.
    //
    // Committed whether or not every call came back: a rejected generation may still
    // have been paid for, and a budget that only counted successes would let a failing
    // provider buy unbounded expansions. A granted width was already debited at
    // arbitration, so charging it again here would bill the search twice — and a
    // resumed wave was debited by the attempt that created it.
    const width = resumed ? resumed.siblings : grant?.width ?? budget.take(branches);
    // The budget is spent and nothing is owed: the wave this iteration would have run
    // has no room, and creating it free is the overspend conservation exists to refuse.
    if (width === 0) break;

    const ancestors = pathTo(nodes, parent);
    const childDepth = parent.depth + 1;
    // The *Inherited context* barrier: ONE compacted view per branch point, computed
    // before any child of this parent starts, so nothing a level is ranked on can be a
    // fact about which sibling's compaction kept the useful paragraph.
    const prefix = agentNodes
      ? await sharedPrefix({ parent, compactShared: deps.compactShared, model: nodeModel, log, preset: resolved.preset })
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
    // WHAT each child is asked is decided by `swarm-level.ts` and not here: a granted
    // level, a caller-assigned one, a resumed one and a count-based one all reach this
    // barrier as the same list of decided slots, so this loop expands and does not
    // choose.
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
      planLevel({ resolved, resumed, grant, width })
        .map((slot): LevelMember => ({
          id: slot.id,
          node: expandChild(expandCtx, {
            parent,
            id: slot.id,
            index: slot.index,
            width,
            atDepth: childDepth,
            task: slot.task,
            rationale: slot.rationale,
            context: slot.context,
            assignment: slot.assignment,
            inherited: inheritedArtifact,
            // A WAVE FANS IN NOTHING. Its siblings are independent candidates, which is
            // what `expand:'sample'` is and what `expand:'aggregate'` still starts from:
            // a fan-in consumes a level, so a level has to exist first.
            aggregated: [],
            ancestors, prefix,
          }),
        })),
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
      yield* await levelFanIn.fanInAtLevel({
        ctx,
        verifier,
        witnessVerifier,
        measured,
        baseline,
        atDepth: childDepth,
      });
    };
    for await (const expansion of level()) {
      const siblings = expansion.aggregated.length > 0
        ? []
        : expansions.filter((other) => other.id !== expansion.id);
      const scoringRefusal = await scoreExpansion({
        expansion, siblings, measures, verifier, witnessVerifier, pareto, ctx, measured, baseline,
        judgeSamples, resolved, rt: deps.rt, mode: deps.mode, languages, sql, rootId,
        candidates, spentBy, nodes, log, searchLedger, ledgerEpoch, rankDirection,
        state: scoringState,
      });
      if (scoringRefusal) return scoringRefusal;
    }

    // Retire what the tree has learned is not worth selecting. Its own visit gate
    // protects single-visit leaves, so on a flat run — where nothing is ever
    // re-visited — this cannot fire, which is why a depth-1 search is unchanged.
    if (isTreeAdvance(resolved.config.advance.kind)) {
      await pruneLowValueBranches(
        deps.rt, rootId, resolved.config.pruneThreshold, resolved.config.minVisitsForPrune,
      );
    }

    // THE LEVEL BARRIER IS THIS RUN'S HEARTBEAT, and it is what makes the row readable
    // while the search is alive: `updated_at` freshness is how every reader tells a
    // working search from a hung one. The barrier is the right grain rather than a
    // timer — it is the point at which a wave is measured, compared and recorded.
    // Progress itself needs no write here: it is derived from the tree at read time
    // (*search-store.ts*), so the tree's own rows are the record. Fenced on this run's
    // lease, so an executor from a superseded activation cannot move even this.
    searchLedger.touch(rootId, ledgerEpoch, Date.now());
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
  return settleRun({
    started, log, sql, resolved, rootId, maxDepth, branches, policy,
    paretoAxes: pareto?.axes ?? null, ctx, verifier, measured, baseline, identity,
    publishing, archive, publication: scoringState.publication, candidates, best: scoringState.best,
    usage, judgeSamples, ensembles: scoringState.ensembles, spentBy, carriedIn, carriedBest,
    levelFanIn, reentry,
    aborted, missionSpent, lost, remainingBudget: budget.remaining, expansionBudget,
    inheritedExpansions, inheritedTokens, ledgerEpoch, searchLedger, runProfile,
  });
}
