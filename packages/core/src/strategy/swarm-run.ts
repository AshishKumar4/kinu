/**
 * Running a resolved swarm: select, expand, measure, backpropagate, settle, and refuse by name
 * the shapes no engine here executes faithfully. Spec: docs/EXPLORATION.md (from "The six axes"
 * through "Merge-back").
 * Measurement is sequential: candidates share one workspace path. `expand:'aggregate'` fans in
 * through merge-back at each level barrier; dependency edges sit beside `parent_id`, never replace it.
 * Isolation: `MCTS/StorageIsolation.lean` covers toolless branches only;
 * `Exploration/Isolation.lean`'s `agent_node_is_not_a_branch_explore` shows it does not reach
 * agent nodes, so nodes are graded on what they report, never on a tree diff.
 */
import type { Clock } from '../types/clock';
import type { LanguageModel, ModelMessage } from 'ai';
import { DEFAULT_CONFIG } from '../config';
import type { PersistedSearchKnobs } from '../mcts/search-store';
import type { SwarmProfileSnapshot } from '../profiles';
import { pruneLowValueBranches } from '../mcts/pruning';
import { selectFrontierNode } from '../mcts/frontier';
import { diagnostics, type Logger } from '../obs/index';
import { renderCauseChain, type Refusal } from '../obs/error';
import { usageTotal, type Usage, addUsage } from '../usage';
import type { PublishHeadStream } from '../heads/head-stream';
import type { AnnounceHeadActivity } from '../heads/live-journal';
import { SwarmBudget } from './swarm-budget';
import type { NodeIdentity, NodeWorkspace, NodeWorkspaceProvisioner } from './node-workspace';
import type { HostedNodeSeat } from './node-agent';
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
import type { WorkMode } from '../types/turn';
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

/** The epoch a first attempt writes; re-entries claim higher ones via `reclaim` (`swarm-resume.ts`). */
const SWARM_FIRST_LEDGER_EPOCH = 0;

export interface SwarmRunDeps {
  /** The caller's runtime: owns the run ledgers, journal and archive; not any node's runtime. */
  readonly rt: AgentRuntime;
  /** Acquire the hosted logical actor one node runs as, by that node's identity. */
  readonly hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  readonly model: LanguageModel;
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
  /** See HeadInferenceDeps.clock. */
  readonly clock?: Clock;
  /** Absent = unreported, which the spend coverage fraction states. */
  readonly reportModelCall?: ModelCallSink;
  /** Transient output frames (heads/head-stream.ts). Absent = nothing watching. */
  readonly publishHeadStream?: PublishHeadStream;
  /** Durable journal-write announcements, the twin of {@link publishHeadStream}. Absent = silent journal. */
  readonly announceHeadActivity?: AnnounceHeadActivity;
  /** Defaults to the process logger. The only place a refused toolless proposal is observable. */
  readonly logger?: Logger;
  /** Optional per-agent-node wall-clock deadline. No default: owner ruling 2026-08-21, no per-turn bounds. */
  readonly maxWallClockMs?: number;
  /**
   * Charged per model call as calls happen, for every call this run makes; the spawning
   * caller must not charge a lump afterwards. Absent = unbudgeted.
   */
  readonly mission?: MissionScope;
  /** The origin agent's conversation the root inherits (*Inherited context*). Absent = wired none, distinct from empty. */
  readonly originContext?: readonly ModelMessage[];
  /** Per-node home provisioner (*Isolation*). Absent: every node reports `shared-origin-plane`. */
  readonly provisionHome?: NodeWorkspaceProvisioner;
  /** See {@link NodeAgentDeps.runtimeForWorkspace}. */
  readonly runtimeForWorkspace?: (workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>;
  /** Absent narrows the agent node's surface; it does not break it. */
  readonly codemodeTool?: unknown;
  readonly webSearch?: WebSearchProvider;
  /**
   * Compaction seam over *Inherited context*: rewrite a parent's context once for all its children.
   * The summariser lives in `packages/compaction`; core owns only the policy. Absent: no compaction.
   */
  readonly compactShared?: (
    messages: readonly ModelMessage[],
    basis: { readonly contextWindow: number; readonly key: string },
  ) => Promise<readonly ModelMessage[]>;
  /** The resolved turn profile, recorded at `begin` so a re-drive re-enters under it. */
  readonly profile?: SwarmProfileSnapshot;
  /** Resolves a tier's model spec to the model a node runs on. Required whenever {@link profile} is present. */
  readonly resolveModel?: (spec: string) => LanguageModel;
  /**
   * This call is an evict/exit re-drive, so it re-enters the interrupted search. Set only by
   * `orchestrator/background-tools.ts` ({@link RESUME_REDRIVE_OPTION}); absent never adopts another run's tree.
   */
  readonly redrive?: boolean;
}

/** Run a resolved swarm, or refuse. Refusals are ordered by cost; nothing spends before the baseline. */
export async function runSwarm(
  deps: SwarmRunDeps,
  resolved: ResolvedSwarm,
): Promise<SwarmResult | Refusal> {
  const started = Date.now();
  const region = regionRefusal(resolved, deps.mode);

  if (region) return region;
  // Checked by `regionRefusal`; read here so the types are narrowed once.
  const branches = resolved.caps.branches?.value ?? 0;
  const maxDepth = resolved.caps.depth?.value ?? 0;
  const measures = resolved.config.score.kind === 'verify';
  const paretoAdvance = resolved.config.advance.kind === 'pareto';
  const judgeSamples = resolved.config.score.kind === 'judge' ? resolved.config.score.samples : null;

  // Per-node routing is resolved before anything spends. `null` → empty array: every node runs `nodeModel`.
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

  // One journal instance for every write, announcing when the caller has a channel.
  const { sql, journal, searchLedger } = initRunLedgers(deps.rt, deps.announceHeadActivity);

  const { carriedIn, carriedBest } = readCarryIn({
    sql, actor: deps.rt.actor,
    identity,
    publishing,
    floor: measured?.floor ?? null,
    preset: resolved.preset,
    carryKind: resolved.config.carry.kind,
    metric: measured?.metric ?? '',
    log,
  });

  // `thought` takes the toolless path; the other units run `node-agent.ts`.
  const agentNodes = resolved.config.unit.kind !== 'thought';
  const languages = deps.rt.executor.languages;
  // `regionRefusal` has already refused the values with no scheduler here.
  const policy = frontierPolicyOf(resolved.config.advance.kind);

  if (!policy) {
    return unsupported(`advance:"${resolved.config.advance.kind}" has no scheduler in this runner.`);
  }

  /** The parent selector, decided once. `pareto` with nothing measured is refused here rather than settling empty. */
  const paretoScheduler = pareto === null ? null : { kind: 'pareto' as const, axes: pareto.axes };

  const scheduler = policy === 'pareto' ? paretoScheduler : { kind: 'frontier' as const, policy };

  if (scheduler === null) {
    return unsupported('advance:"pareto" orders its frontier by the axes an instanced or vector '
      + `objective declares, and this run resolved none — score:"${resolved.config.score.kind}" `
      + 'measures nothing a front could be ordered by, so every selection would return no node '
      + 'and the run would settle empty. Give it an instanced or vector `objective` with '
      + 'score:"verify", or select with advance:"uct".');
  }

  /** The interrupted search this call re-enters, or a new one; see `swarm-resume.ts`. */
  const { reentry, runProfile } = resolveReentry({
    sql, searchLedger, journal, actor: deps.rt.actor, redrive: deps.redrive,
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
    sql, actor: deps.rt.actor, reentry, verifier, ctx, resolved,
    originContext: deps.originContext, measures, journal, agentNodes,
  });

  const candidates: SwarmCandidate[] = [];
  let usage: Usage = {};
  /** Resolved once: a reversed direction silently reverses the search. Judged runs maximise. */
  const rankDirection: ObjectiveDirection = measured?.direction ?? 'maximise';
  /** Per-candidate spend, keyed by node id for the settle barrier. */
  const spentBy = new Map<string, number | null>();
  const seeded = seedResumedSearch({ reentry, nodes, rankDirection, spentBy });
  candidates.push(...seeded.candidates);

  /** The state `scoreExpansion` moves, seeded from the re-entry. */
  const scoringState = {
    publication: seeded.publication,
    best: seeded.best,
    bestValue: seeded.bestValue,
    ensembles: [...seeded.ensembles],
  };

  const { inheritedExpansions, inheritedTokens } = seeded;
  // Expansion budget in children: `depth` waves of `branches`, derived from the two declared caps.
  // Owned by `swarm-budget.ts` because agent nodes read and debit it concurrently.
  const expansionBudget = maxDepth * branches;
  /** Derived from the tree, not the ledger's `budget` column, which can lag inside a level. */
  const budget = new SwarmBudget(Math.max(0, expansionBudget - inheritedExpansions));
  /** The caller's assigned first level, if any (`swarm-level.ts`'s `assignedRootGrant`). */
  const assigned = assignedRootGrant({ resolved, reentry, budget });

  if (assigned) root.granted = assigned;
  /** The lease every ledger write is stamped with: the re-entry's claimed epoch, or zero. */
  const ledgerEpoch = reentry?.epoch ?? SWARM_FIRST_LEDGER_EPOCH;

  // The ledger row is written at start so a live run reads as running.
  // A re-entry only refreshes the heartbeat: `begin` throws on an existing root.
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
    hostNode: deps.hostNode, model: nodeModel, journal, logger: log,
    signal: deps.signal, clock: deps.clock, reportModelCall: deps.reportModelCall,
    maxWallClockMs: deps.maxWallClockMs, mission: deps.mission,
    provisionHome: deps.provisionHome, runtimeForWorkspace: deps.runtimeForWorkspace,
    codemodeTool: deps.codemodeTool, webSearch: deps.webSearch,
    publishHeadStream: deps.publishHeadStream,
  });

  // Report gate only where an instrument exists; a judged run gets an absent key.
  if (verifier && ctx && measured) {
    const grade = reportGate({ ctx, verifier });
    nodeDeps.gradeReport = grade;
  }

  let lost = 0;
  let aborted = false;
  /**
   * Mission ledger for thought nodes (agent nodes guard and debit inside `runHeadInference`).
   * The level is guarded, never the child, as in `mcts/engine.ts`.
   */
  const mission = missionMeter(deps.mission);
  /** True when the ledger, not the expansion budget, ended the run, so `stop` says `budget`. */
  let missionSpent = false;

  /** The context {@link expandChild} closes over, built once. */
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
    // Empty for the unrouted default; `expandChild` then falls back to `nodeModel`.
    nodeModels,
    signal: deps.signal,
    nodeDeps,
    budget,
    rootId,
    log,
    reportModelCall: deps.reportModelCall,
    charge: (spent: Usage) => mission.charge(spent),
  };

  /** The run's fan-in (`strategy/fanin.ts`); the module owns the policy. */
  const levelFanIn = createLevelFanIn<TreeNode, Expansion>({
    nodes,
    actor: deps.rt.actor,
    ancestorPath: (parent) => pathTo(nodes, parent),
    rootId,
    maxDepth,
    budget,
    log,
    preset: resolved.preset,
    context: resolved.config.context,
    sql,
    markMerged: (id) => markSwarmNodeMerged(sql, deps.rt.actor, id, Date.now()),
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

  /** A grant paid for and not yet expanded; the loop must continue for it even at `remaining === 0`. */
  const reservedChildren = (): boolean => {
    for (const node of nodes.values()) if (node.granted) return true;

    return false;
  };

  /** Unfinished levels this re-entry owes, drained before selection (`swarm-level.ts`). */
  const resumeWaves = resumedWaves(reentry);

  while (resumeWaves.length > 0 || budget.remaining > 0 || reservedChildren()) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }

    // A spent mission budget stops the next level from opening.
    if (await mission.outOfBudget()) {
      missionSpent = true;
      break;
    }

    /** The wave, from three sources in order: a resumed wave (already paid), a paid grant, then selection. */
    const resumed = resumeWaves.shift() ?? null;

    const owed = resumed
      ? null
      : [...nodes.values()].find((node) => node.granted !== null);

    const selected = resumed
      ? { id: resumed.parentId }
      : owed ?? (scheduler.kind === 'pareto'
        ? selectParetoFrontierNode(nodes, maxDepth, scheduler.axes)
        : selectFrontierNode(sql, deps.rt.actor, {
          rootId, policy: scheduler.policy, maxDepth,
          explorationWeight: resolved.config.explorationWeight
            ?? DEFAULT_CONFIG.mcts.explorationWeight,
        }));

    // Nothing selectable: frontier exhausted or every open node at the depth cap. Settled, not failed.
    if (!selected) break;
    const parent = nodes.get(selected.id);

    if (!parent) {
      // A row with no content is an inconsistency. Settle the ledger on the way out.
      searchLedger.fail(rootId, ledgerEpoch, Date.now());

      return unavailable(`the search selected node ${selected.id} of its own tree and this run holds `
        + 'no content for it, so the expansion would have no parent to continue from. That is an '
        + 'inconsistent tree rather than a missing instrument, and it stops the run.');
    }

    // Arbitrate before spending (*Arbitration*): agent nodes were answered by `propose_branch`,
    // thought nodes are answered here. A resumed wave asks nothing and leaves the parent's grant alone.
    const grant = resumed ? null : parent.granted ?? (() => {
      const decision = answerProposal({ log, node: parent, resolved, budget });

      return decision?.kind === 'granted' ? decision : null;
    })();

    if (!resumed) {
      parent.proposal = null;
      // Cleared because `uct` may re-select an expanded node; a grant left in place would be spent twice.
      parent.granted = null;
    }

    // Committed whether or not every call returned: failed generations may still be paid for.
    // Granted and resumed widths were already debited.
    const width = resumed ? resumed.siblings : grant?.width ?? budget.take(branches);

    // Budget spent and nothing owed: creating the wave free would overspend.
    if (width === 0) break;

    const ancestors = pathTo(nodes, parent);
    const childDepth = parent.depth + 1;

    // *Inherited context* barrier: one compacted view per branch point, before any child starts.
    const prefix = agentNodes
      ? await sharedPrefix({ parent, compactShared: deps.compactShared, model: nodeModel, log, preset: resolved.preset })
      : [];

    // The proposal's per-branch context where granted, otherwise the run's `context`.
    const inheritedArtifact = (grant
      ? grant.proposal.branches.some((branch) => branch.context === 'inherit')
      : resolved.config.context === 'inherit')
      ? parent.artifact
      : null;

    // Expand in parallel; measure strictly sequentially below (one shared path).
    // Slots are decided by `swarm-level.ts`. The barrier stays pending while a provider is pending:
    // silence is not failure.
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
            // A wave fans in nothing: a fan-in consumes a level, so the level must exist first.
            aggregated: [],
            ancestors, prefix,
          }),
        })),
    );

    const expansions: Expansion[] = [];
    /** Why each member produced no usable candidate, in order: rejected members and `incomplete` reports. */
    const unusable: string[] = [];

    for (const { id, answer } of answers) {
      /** Why this member produced nothing usable, or null. Read once so attribution has one call site. */
      const stopped = answer.kind === 'failed'
        ? renderCauseChain(answer.error)
        : answer.expansion.incomplete?.detail ?? null;

      if (answer.kind === 'failed') {
        // Lost means the search holds nothing for this node; an incomplete member is carried, not lost.
        lost += 1;
      } else {
        const expansion = answer.expansion;
        usage = addUsage(usage, expansion.usage);
        // This candidate's own spend; null when unreported (unmeasured is not free).
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

    // A level whose nodes broke (by report status, not missing answer) ends the run, quoting each cause.
    // Cut or step-exhausted nodes settle instead of refusing.
    if (unusable.length > 0 && expansions.every((child) => child.incomplete?.status === 'errored')) {
      // Settle the ledger on refusal: a row left `running` is a resume target.
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

    // Score, record, backpropagate: one candidate at a time, into the one path the instrument reads.
    /**
     * The wave, then under `expand:'aggregate'` its fan-in vertex, yielded once at the barrier
     * so the vertex takes the same scoring body as a sampled sibling.
     */
    const level = async function* level(): AsyncGenerator<Expansion> {
      yield* expansions;

      if (resolved.config.expand !== 'aggregate') return;

      // `regionRefusal` refuses `aggregate` on a run that measures nothing; the other arm is unreachable.
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
        expansion, siblings, measures, verifier, witnessVerifier, pareto, ctx, measured, identity, baseline,
        judgeSamples, resolved, rt: deps.rt, mode: deps.mode, languages, sql, rootId,
        candidates, spentBy, nodes, log, searchLedger, ledgerEpoch, rankDirection,
        state: scoringState,
      });

      if (scoringRefusal) return scoringRefusal;
    }

    // Retire unpromising nodes. Its visit gate protects single-visit leaves, so a flat run is unaffected.
    if (isTreeAdvance(resolved.config.advance.kind)) {
      await pruneLowValueBranches(
        deps.rt, rootId, resolved.config.pruneThreshold, resolved.config.minVisitsForPrune,
      );
    }

    // The level barrier is the run's heartbeat (`updated_at`), fenced on this run's lease.
    searchLedger.touch(rootId, ledgerEpoch, Date.now());
    // Logged like `mcts.checkpoint_reached`, so a working search is distinguishable from a hung one.
    log.event('swarm.checkpoint_reached', {
      preset: resolved.preset,
      root_id: rootId,
      epoch: ledgerEpoch,
      expansions: candidates.length,
      remaining: budget.remaining,
    });
  }

  // The sweep (*Arbitration*): answer every thought-node proposal selection never reached;
  // the only place `depth-exhausted` and `budget-exhausted` occur. Agent nodes need none.
  for (const node of nodes.values()) {
    if (!node.proposal) continue;
    answerProposal({ log, node, resolved, budget });
    node.proposal = null;
  }

  return settleRun({
    started, log, sql, actor: deps.rt.actor, resolved, rootId, maxDepth, branches, policy,
    paretoAxes: pareto?.axes ?? null, ctx, verifier, measured, baseline, identity,
    publishing, archive, publication: scoringState.publication, candidates, best: scoringState.best,
    usage, judgeSamples, ensembles: scoringState.ensembles, spentBy, carriedIn, carriedBest,
    levelFanIn, reentry,
    aborted, missionSpent, lost, remainingBudget: budget.remaining, expansionBudget,
    inheritedExpansions, inheritedTokens, ledgerEpoch, searchLedger, runProfile,
  });
}
