/**
 * Setup for one swarm run: region refusals, measurement context, measured-baseline helpers and
 * run context construction. Decided once before any node expands; nothing here reads loop state.
 */
import type { Clock } from '../types/clock';
import {
  KinuError, refusalOf, type Refusal,
} from '../obs/error';
import type { AgentRuntime } from '../types/agent-runtime';
import {
  archiveRegionRefusal, isTreeAdvance, judgeMarginalisationRefusal,
  SWARM_TREE_ADVANCES,
} from './swarm';
import type { ResolvedSwarm } from './swarm';
import type {
  Floor, InstancedObjective, Measurement, MeasurementContext, ObjectiveDirection,
  ParetoAxis, VectorObjective,
} from './objective';

import { renderThrownChain, type Logger } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import { initSearchTables } from '../mcts/schemas';
import { initMctsSearchTable, MctsSearchStore } from '../mcts/search-store';
import { HeadJournal } from '../heads/journal';
import { LiveHeadJournal, type AnnounceHeadActivity } from '../heads/live-journal';
import { initHeadsTables } from '../heads/schema';
import {
  initExplorationRecordsTable, recordsFor, verifierDigestOf,
} from './records';
import { initSwarmNodeRecords } from './swarm-resume';
import { archiveCellOf } from './archive';
import {
  preflightVerifier, registeredVerifierKind, resolveVerifier,
  unregisteredKindRefusalFor, type ResolvedVerifier,
} from './verifier-registry';
import { measuredHalf, normalisedScore, paretoObjectiveAxes, PUBLISHING_CARRIES } from './objective';
import { argumentDigest } from '../safety/argument-digest';
import { workModeRefusal } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';

import type { ModelCallSink } from '../events/model-call';
import type { WebSearchProvider } from '../web/index';
import type { NodeAgentDeps } from './node-agent';
import type { PublishHeadStream } from '../heads/head-stream';
import type { NodeIdentity, NodeWorkspace, NodeWorkspaceProvisioner } from './node-workspace';
import type { HostedNodeSeat, NodeCodemode } from './node-agent';
import type { MissionScope } from '../mission-budget';
import type { SwarmCandidate } from './swarm';
import type { PublicationState } from './objective';
import { isBetter } from './objective';

import type { LanguageModel, ModelMessage } from 'ai';
import { nanoid } from '../utils/nanoid';
import { insertSearchNode } from '../mcts/record-node';
import { reenterSwarm, type SwarmReentry } from './swarm-resume';
import type { SwarmProfileSnapshot } from '../profiles';
import { readArtifact, type TreeNode } from './swarm-tree';
import type { ActorHandle } from '../identity/actor-handle';
import type {
  ExplorationRecord, MeasuredObjective, ObjectiveIdentity, PublishingCarry,
} from './objective';

export function unsupported(error: string): Refusal {
  return refusalOf(new KinuError('unsupported', error));
}

export function unavailable(error: string): Refusal {
  return refusalOf(new KinuError('unavailable', error));
}

export function badInput(error: string): Refusal {
  return refusalOf(new KinuError('bad_input', error));
}

/**
 * Whether this tree can execute the resolved shape now, or the refusal naming what it needs.
 * Each arm names one remedy (*Refusals*). Measuring, publishing or applying is Build work.
 */
export function regionRefusal(resolved: ResolvedSwarm, mode: WorkMode): Refusal | null {
  const composition = compositionRefusal(resolved);

  if (composition) return composition;
  const { config, settle } = resolved;
  const publishes = config.advance.kind !== 'pareto' && PUBLISHING_CARRIES.some((carry) => carry === config.carry.kind);
  const planAllowed = settle === 'merge' && config.score.kind !== 'verify' && !publishes;

  return workModeRefusal(mode, planAllowed, 'Search measurement, publication or project apply');
}

function compositionRefusal(resolved: ResolvedSwarm): Refusal | null {
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

  // Judged scoring reaches the `mcts/evaluation.ts` ensemble. The marginalisation refusal is repeated
  // from `swarmValidity` because this is also the in-process entry point.
  const marginalisation = judgeMarginalisationRefusal(config);

  if (marginalisation) return marginalisation;

  if (isTreeAdvance(config.advance.kind) && config.score.kind === 'none') {
    // Also refused by `swarmValidity`; kept for in-process callers.
    return badInput(`advance:"${config.advance.kind}" cannot select without a score.`);
  }

  if (config.advance.kind === 'pareto'
    && PUBLISHING_CARRIES.some((carry) => carry === config.carry.kind)) {
    // Also refused by `swarmValidity`; kept for in-process callers.
    return badInput('advance:"pareto" keeps its durable frontier in node evidence and cannot '
      + 'publish a vector through the scalar records store. Use carry:"none" or "reflections".');
  }

  // The archive's own region, via the predicate `swarmValidity` shares, so an in-process caller
  // cannot run a shape the tool surface refuses.
  const archive = archiveRegionRefusal(config, caps);

  if (archive) return archive;

  if (!resolved.key && config.advance.kind === 'archive') {
    // Also refused by `swarmValidity`; kept for in-process callers and because the cell binds to `key`.
    return badInput('advance:"archive" bins its elites by a descriptor and this call named none. '
      + 'Supply `key`, naming a quantity the objective\'s own instrument reports.');
  }

  // Refuse compositions where a fan-in could never happen (*Accepted and ignored*).
  if (config.expand === 'aggregate' && config.advance.kind === 'pareto') {
    return badInput('expand:"aggregate" needs a scalar verifier verdict to re-grade a merge node, '
      + 'while advance:"pareto" preserves a vector without collapsing it. Use expand:"sample".');
  }

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
      // A fan-in diffs against the placed artifact path; a judged run has no such path and no measured
      // verdict for merge-back to bind to.
      return badInput('expand:"aggregate" merges what its parents produced, and a member\'s diff is '
        + `the candidate this engine PLACED at the objective's own path. score:"${config.score.kind}" `
        + 'names no path and issues no measured verdict, so every fan-in could only refuse for want '
        + 'of one. Use score:"verify" with an `objective` to fan in, or expand:"sample" to keep the '
        + 'scorer and lose the DAG.');
    }
  }

  return null;
}

/** The workspace as an instrument sees it: only the members *Measurement context* names. */
export function measurementContext(rt: AgentRuntime): MeasurementContext | null {
  const shell = rt.shell;

  if (!shell) return null;

  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** The measured baseline reported alongside a candidate, or null (*Measured baseline*). */
export function baselineOf(measurement: Measurement, key: string | null): number | null {
  if (!key) return null;
  const reported = measurement.measured?.[key];

  return reported !== undefined && Number.isFinite(reported) ? reported : null;
}

/** Whether `value` sits past the floor; the comparison inverts with the direction. */
export function breaches(floor: Floor, direction: ObjectiveDirection, value: number): boolean {
  return direction === 'minimise' ? value < floor.value : value > floor.value;
}

/** The instruments and declared axes that produce one Pareto vector. */
export interface PreparedParetoMeasurement {
  readonly axes: readonly ParetoAxis[];
  readonly ctx: MeasurementContext;
  readonly instruments: readonly {
    readonly axisIds: readonly string[];
    readonly perInstance: boolean;
    readonly verifier: ResolvedVerifier;
  }[];
}

/**
 * Resolve every instrument of a multi-axis objective before any node expands. Axes come from
 * the objective declaration, never from returned labels.
 */
export async function prepareParetoMeasurement(input: {
  readonly rt: AgentRuntime;
  readonly resolved: ResolvedSwarm;
}): Promise<PreparedParetoMeasurement | Refusal> {
  const objective = input.resolved.objective;

  if (!objective || (objective.kind !== 'instanced' && objective.kind !== 'vector')) {
    return badInput('advance:"pareto" requires an instanced or vector objective.');
  }

  const axes = paretoObjectiveAxes(objective);

  if ('reason' in axes) return badInput(axes.reason);
  const ctx = measurementContext(input.rt);

  if (!ctx) {
    return unavailable('this workspace has no shell, so its Pareto instruments cannot run.');
  }

  const components: readonly {
    readonly axisIds: readonly string[];
    readonly perInstance: boolean;
    readonly objective: InstancedObjective | VectorObjective['components'][number];
  }[] = objective.kind === 'instanced'
    ? [{ axisIds: objective.instances, perInstance: true, objective }]
    : objective.components.map((component) => ({
      axisIds: [component.metric],
      perInstance: false,
      objective: component,
    }));

  const instruments: PreparedParetoMeasurement['instruments'][number][] = [];

  for (const component of components) {
    if (!('kind' in component.objective.verify)) {
      return unsupported('a Pareto objective supplies a closure verifier, which names no durable '
        + 'artifact path. Register a verifier kind for every Pareto axis.');
    }

    const kind = registeredVerifierKind(component.objective.verify.kind);

    if (kind === null) return unregisteredKindRefusalFor(component.objective.verify.kind);
    const fault = await preflightVerifier(kind, ctx);

    if (fault !== null) {
      return unavailable(`the "${kind}" Pareto instrument cannot run in this workspace: ${fault}`);
    }

    const resolvedVerifier = resolveVerifier(component.objective.verify);

    if ('reason' in resolvedVerifier) return resolvedVerifier;
    instruments.push({
      axisIds: component.axisIds,
      perInstance: component.perInstance,
      verifier: resolvedVerifier,
    });
  }

  return { axes: axes.axes, ctx, instruments };
}


/** What {@link prepareMeasurement} resolves for a run that measures an objective. */
export interface PreparedMeasurement {
  readonly measured: MeasuredObjective;
  readonly verifier: ResolvedVerifier;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly ctx: MeasurementContext;
  readonly baseline: number;
  readonly identity: ObjectiveIdentity;
}

/**
 * The archive in force, or null. Derived once and passed, never re-read from the axis, so binning,
 * admission and the seal disclosure cannot disagree.
 */
export interface ArchiveInForce {
  readonly key: string;
  readonly novelty: number;
}

/**
 * What a measured run resolves before anything expands. Refusal order is load-bearing: kind,
 * shell, runnability, then spec, so a caller never fixes a field of an unrunnable instrument.
 */
export async function prepareMeasurement(input: {
  readonly rt: AgentRuntime;
  readonly resolved: ResolvedSwarm;
  readonly archive: ArchiveInForce | null;
  readonly log: Logger;
}): Promise<PreparedMeasurement | Refusal> {
  const { rt, resolved, archive, log } = input;
const objective = resolved.objective;

if (!objective) return badInput('score:"verify" with no `objective` measures nothing.');
const measured = measuredHalf(objective);

if (!measured) {
  return unsupported(`an objective of kind "${objective.kind}" is measured per component or per `
    + 'instance, and this run settles one answer against one number. Use kind:"scalar", or '
    + 'kind:"witness" with a scalar `proxy`.');
}

if (!('kind' in measured.verify)) {
  // A closure declares no candidate path; registering the kind supplies one (*The closed verifier registry*).
  return unsupported('this objective supplies `verify` as a closure, which names no path a '
    + 'candidate is written to, so this run cannot place one for it to measure. Register a '
    + 'verifier kind and pass verify as {kind, spec}.');
}

// Order matters: kind, shell, runnability, then spec (see above).
const kind = registeredVerifierKind(measured.verify.kind);

if (kind === null) return unregisteredKindRefusalFor(measured.verify.kind);
const ctx = measurementContext(rt);

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
    + 'Switching preset is not required and would cost this one its width and unit.');
}

const resolvedVerifier = resolveVerifier(measured.verify);

if ('reason' in resolvedVerifier) return resolvedVerifier;
const verifier = resolvedVerifier;
let witnessVerifier: ResolvedVerifier | null = null;
let witnessDigest: string | null = null;

if (measured.witness !== null) {
  if (!('kind' in measured.witness)) {
    return unsupported('this witness check is a closure, which names no candidate path and '
      + 'cannot be identified across durable runs. Register it as a verifier kind.');
  }

  const witnessKind = registeredVerifierKind(measured.witness.kind);

  if (witnessKind === null) return unregisteredKindRefusalFor(measured.witness.kind);
  const witnessFault = await preflightVerifier(witnessKind, ctx);

  if (witnessFault !== null) {
    return unavailable(`the witness instrument cannot run in this workspace: ${witnessFault}`);
  }

  const resolvedWitness = resolveVerifier(measured.witness);

  if ('reason' in resolvedWitness) return resolvedWitness;
  witnessVerifier = resolvedWitness;
  witnessDigest = verifierDigestOf(measured.witness, resolvedWitness.implementation);
}

const proxyDigest = verifierDigestOf(measured.verify, resolvedVerifier.implementation);

const identity = {
  metric: measured.metric,
  unit: measured.unit,
  direction: measured.direction,
  scale: measured.scale,
  verifierDigest: witnessDigest === null
    ? proxyDigest
    : argumentDigest({ proxy: proxyDigest, witness: witnessDigest }),
};

// *Measured baseline*: measured on the workspace as found; a fault must not start the run.
let asFound: Measurement;

try {
  asFound = await verifier.verify(ctx);
} catch (error) {
  return unavailable(`the baseline measurement faulted, so this run cannot start: `
    + `${renderThrownChain({ cause: error })}. That is the instrument `
    + 'breaking rather than a candidate failing, and it fails the run by design.');
}

const baseline = baselineOf(asFound, verifier.baselineKey)
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

// *Measured baseline*: a target already met leaves no range to score on.
if (normalisedScore({
  value: baseline, baseline, target: measured.target,
  direction: measured.direction, scale: measured.scale,
}) === null) {
  return badInput(`the target of ${String(measured.target)} ${measured.unit} is already met by `
    + `the workspace as found, which measures ${String(baseline)}. Every candidate would `
    + 'saturate at 1.0 and the search would have no gradient — the baseline is measured rather '
    + `than declared, so raise the target past ${String(baseline)}.`);
}

// The archive key must be a quantity the instrument reports; checked here, at the baseline,
// before any candidate is expanded.
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

  return { measured, verifier, witnessVerifier, ctx, baseline, identity };
}

/** The run's stores, initialised in dependency order; a workspace that never ran a search has none of these tables. */
export interface RunLedgers {
  readonly sql: SqlExecutor;
  readonly journal: HeadJournal;
  readonly searchLedger: MctsSearchStore;
}

export function initRunLedgers(
  rt: AgentRuntime,
  /**
   * Where this run's journal writes are announced, or absent. A listener rather than a journal
   * instance, so the journal is always built over `rt.storage.sql`.
   */
  announce?: AnnounceHeadActivity,
): RunLedgers {
  const sql = rt.storage.sql;
  initSearchTables(rt.storage.execRaw);
  // *The journal read model*: the same ledger a fork's turns land in; `search_nodes` stays the tree.
  initHeadsTables(rt.storage.execRaw);

  const journal = announce === undefined
    ? new HeadJournal(sql, rt.actor)
    : new LiveHeadJournal(sql, rt.actor, announce);

  // The run-level ledger (*Accepted and ignored*): persists the knobs and judge clamp a run ran under.
  initMctsSearchTable(rt.storage.execRaw);
  const searchLedger = new MctsSearchStore(sql, rt.actor);
  // The leaderboard *The records store* governs.
  initExplorationRecordsTable(rt.storage.execRaw);
  // Per-node content a re-entry reads (swarm-resume.ts); `search_nodes` cannot answer a resume.
  initSwarmNodeRecords(rt.storage.execRaw);

  return { sql, journal, searchLedger };
}

/**
 * Carry-in: what earlier runs of this objective under this floor reached, read before expansion.
 * Gated on a publishing carry so a `carry:'none'` run inherits nothing.
 */
export interface CarryIn {
  readonly carriedIn: readonly ExplorationRecord[];
  readonly carriedBest: ExplorationRecord | null;
}

export function readCarryIn(input: {
  readonly sql: SqlExecutor;
  /** The run's own actor, never a node's. */
  readonly actor: ActorHandle;
  readonly identity: ObjectiveIdentity | null;
  readonly publishing: PublishingCarry | null;
  readonly floor: Floor | null;
  readonly preset: string;
  readonly carryKind: string;
  readonly metric: string;
  readonly log: Logger;
}): CarryIn {
  const { sql, actor, identity, publishing, floor, preset, carryKind, metric, log } = input;

  const carriedIn = identity !== null && publishing !== null
    ? recordsFor(sql, actor, { identity, floor })
    : [];

  // Best FIRST, by `recordsFor`'s own ordering in the objective's direction.
  const carriedBest = carriedIn[0] ?? null;

  if (carriedBest) {
    log.event('swarm.records_carried_in', {
      preset,
      carry: carryKind,
      metric,
      rows: carriedIn.length,
      best: carriedBest.value,
      displacements: carriedBest.displacements,
    });
  }

  return { carriedIn, carriedBest };
}

/**
 * Re-entry resumes an unreported node under its existing ID (`PendingSwarmNode`); only start-of-life
 * reconciliation may retire a node, when its root has no re-drive path.
 */

/**
 * The search this call is (the interrupted one it re-enters, or a new one) and the profile it
 * runs under. A re-drive replays tool input verbatim, so it must re-enter rather than mint a root;
 * its profile is the claimed row's record, never today's catalog.
 */
export interface ReentryResolution {
  readonly reentry: SwarmReentry | null;
  readonly runProfile: SwarmProfileSnapshot | null;
}

export function resolveReentry(input: {
  readonly sql: SqlExecutor;
  readonly searchLedger: MctsSearchStore;
  readonly journal: HeadJournal;
  readonly actor: ActorHandle;
  readonly redrive: boolean | undefined;
  readonly task: string;
  readonly preset: string;
  readonly profile: SwarmProfileSnapshot | null;
  readonly log: Logger;
}): ReentryResolution {
  const { sql, searchLedger, journal, actor, redrive, task, preset, profile, log } = input;

  const reentry = redrive === true
    ? reenterSwarm({ sql, ledger: searchLedger, journal, actor }, {
      task: task, now: Date.now(),
    })
    : null;

  const runProfile = profile ?? reentry?.profile ?? null;

  if (runProfile && !redrive) {
    log.event('swarm.profile_snapshot', {
      role: runProfile.profile.role.id, tier: runProfile.profile.tier.id,
      model: runProfile.profile.tier.model, preset: preset,
      roleSource: runProfile.sources.roleSource,
      tierSource: runProfile.sources.tierSource,
      presetSource: runProfile.sources.presetSource,
      catalogVersion: runProfile.profile.catalogVersion,
      digest: runProfile.profile.digest,
    });
  }

  return { reentry, runProfile };
}

/**
 * The model every node runs on. With a profile record, its `tier.model` (the claimed row's, so a
 * re-drive keeps its model). A missing or throwing resolver refuses rather than degrading to the
 * caller's model, which would misstate provenance and spend.
 */
export function resolveNodeModel(input: {
  readonly model: LanguageModel;
  readonly resolveModel: ((spec: string) => LanguageModel) | undefined;
  readonly runProfile: SwarmProfileSnapshot | null;
}): { readonly model: LanguageModel } | Refusal {
  let nodeModel = input.model;

  if (input.runProfile) {
    const spec = input.runProfile.profile.tier.model;
    const tier = input.runProfile.profile.tier.id;

    if (!input.resolveModel) {
      return unsupported(
        `this search is routed to the ${tier} tier, model ${JSON.stringify(spec)}, but no model `
        + 'resolver is wired in this runner — so its nodes could only run the caller\'s own '
        + 'model while the run records the tier\'s. Wire AgentsSwarmDeps.resolveModel on this '
        + 'backend.',
      );
    }

    try {
      nodeModel = input.resolveModel(spec);
    } catch (error) {
      return refusalOf(new KinuError('unavailable',
        `this search is routed to the ${tier} tier, model ${JSON.stringify(spec)}, and this `
        + 'runtime cannot build that model, so the tier it was routed to is unreachable here. '
        + 'Point the tier at a model this session can resolve, or give the session a resolver '
        + 'that can.',
        { cause: error }));
    }
  }

  return { model: nodeModel };
}

/**
 * Per-node routed models, resolved once through {@link resolveModel} before `createRoot`, so nothing
 * spends on a routing that later faults. Refused like {@link resolveNodeModel}, but `bad_input`:
 * the spec is the caller's own words. Each entry keeps its spec for `HeadInput.model`.
 */
export interface RoutedNodeModel {
  readonly spec: string;
  readonly model: LanguageModel;
}

export function resolveNodeModels(input: {
  readonly models: readonly string[] | null;
  readonly resolveModel: ((spec: string) => LanguageModel) | undefined;
}): { readonly models: readonly RoutedNodeModel[] } | Refusal {
  if (input.models === null) return { models: [] };

  if (!input.resolveModel) {
    return unsupported(
      'this search routes each node through `models`, but no model resolver is wired in '
      + 'this runner — so its nodes could only run the caller\'s own model while the call '
      + 'names others. Wire AgentsSwarmDeps.resolveModel on this backend.',
    );
  }

  const resolved: RoutedNodeModel[] = [];

  for (const [index, spec] of input.models.entries()) {
    try {
      resolved.push({ spec, model: input.resolveModel(spec) });
    } catch (error) {
      return refusalOf(new KinuError('bad_input',
        `\`models\` entry ${String(index + 1)} is ${JSON.stringify(spec)}, and this session `
        + 'cannot build that model — so the node it would be assigned cannot run it. Name a '
        + 'spec this session resolves, or drop `models` to run every node on the one model '
        + 'the call resolved to.',
        { cause: error }));
    }
  }

  return { models: resolved };
}

/**
 * A call that did not re-enter and finds a search of its own task still running is refused, not
 * given a second root or adopted: without a re-drive marker it has not proved it owns the tree.
 */
export function refuseContendedRun(input: {
  readonly searchLedger: MctsSearchStore;
  readonly reentry: SwarmReentry | null;
  readonly task: string;
  readonly preset: string;
  readonly redrive: boolean | undefined;
  readonly log: Logger;
}): Refusal | null {
  const { searchLedger, reentry, task, preset, redrive, log } = input;
  const live = reentry ? [] : searchLedger.findRunningSwarms(task);
  const contended = live[0];

  if (!contended) return null;
  log.event('swarm.duplicate_root_refused', {
    preset, root: contended.rootId,
    redrive: redrive === true, running: live.length,
  });

  return unavailable(`this workspace is already running a swarm for this task (${contended.rootId}, `
    + `iteration ${String(contended.iteration)}, ${String(contended.budget)} of its expansion budget `
    + 'left), and a second search over one task would pay twice for one answer and crown a winner '
    + 'from whichever tree happened to finish. That run reports itself when it settles — its result '
    + 'arrives as a background wake, so wait for it rather than re-spawning. Cancel it first if you '
    + 'meant to start over.');
}

/**
 * The root: the workspace as found at depth 0, so every child's depth is derived. A re-entry adopts
 * the existing row; the journal run header is idempotent.
 */
export async function createRoot(input: {
  readonly sql: SqlExecutor;
  /** The run's own actor; the whole tree is keyed to it. */
  readonly actor: ActorHandle;
  readonly reentry: SwarmReentry | null;
  readonly verifier: ResolvedVerifier | null;
  readonly ctx: MeasurementContext | null;
  readonly resolved: ResolvedSwarm;
  readonly originContext?: readonly ModelMessage[];
  readonly measures: boolean;
  readonly journal: HeadJournal;
  readonly agentNodes: boolean;
}): Promise<{
  readonly rootId: string;
  readonly nodes: Map<string, TreeNode>;
  readonly root: TreeNode;
}> {
  const { actor, sql, reentry, verifier, ctx, resolved, measures, journal, agentNodes } = input;
  const rootId = reentry?.rootId ?? nanoid();
  // Measured now even on re-entry: the stored `observation` predates earlier settles and may hold the task text.
  const rootArtifact = verifier && ctx ? await readArtifact(ctx, verifier.artifact) : null;

  if (!reentry) {
    insertSearchNode(sql, actor, {
      nodeId: rootId, parentNodeId: null, parentMsgId: null, rootId,
      task: resolved.task,
      // The run's name, else a composed configuration's label, else empty (the read model derives from the task).
      action: resolved.name ?? resolved.label ?? '',
      observation: rootArtifact ?? resolved.task,
      codeUsed: null, depth: 0, msgId: null,
    });
  }

  const root: TreeNode = {
    id: rootId, parentId: null, depth: 0, artifact: rootArtifact,
    // The root's normalised score is 0 by construction.
    measurement: null, score: measures ? 0 : null, pareto: null,
    proposal: null, proposalError: null, granted: null,
    // Children's prefix is the origin's conversation when supplied (*Inherited context*).
    conclusion: null,
    transcript: reentry?.originContext ?? input.originContext ?? [],
    compacted: null,
    aggregated: [],
  };

  const nodes = new Map<string, TreeNode>([[rootId, root]]);

  // One run header so every node groups under one root; idempotent under re-entry.
  if (agentNodes) {
    journal.recordSplit(rootId, resolved.label ?? resolved.preset, Date.now());
  }

  return { rootId, nodes, root };
}

/**
 * Accumulators seeded from durable rows so a re-entry continues one search, including the winner
 * and the seal. Resumed inherit-children lack their seed message (never durable). A tree row with
 * no record (older workspaces) is a selectable parent, not a candidate.
 */
export interface ResumedSearchSeed {
  readonly candidates: SwarmCandidate[];
  readonly ensembles: number[];
  readonly publication: PublicationState;
  readonly best: SwarmCandidate | null;
  readonly bestValue: number | null;
  /**
   * Expansions already made: tree rows plus pending journal-only nodes. The two sets partition, so
   * the union is a plain sum; either alone miscounts.
   */
  readonly inheritedExpansions: number;
  readonly inheritedTokens: number | null;
}

export function seedResumedSearch(input: {
  readonly reentry: SwarmReentry | null;
  readonly nodes: Map<string, TreeNode>;
  readonly rankDirection: ObjectiveDirection;
  readonly spentBy: Map<string, number | null>;
}): ResumedSearchSeed {
  const { reentry, nodes, rankDirection, spentBy } = input;
  const candidates: SwarmCandidate[] = [];
  let best: SwarmCandidate | null = null;
  let bestValue: number | null = null;
  const ensembles: number[] = [];
  let publication: PublicationState = { kind: 'open' };
  // Pending expansions are re-run, not re-bought; they are not in `reentry.nodes`.
  let inheritedExpansions = reentry?.pending.length ?? 0;
  let inheritedTokens: number | null = null;

  for (const node of reentry?.nodes ?? []) {
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

    const pareto = outcome?.kind === 'pareto' ? outcome.evidence : null;
    nodes.set(node.id, {
      id: node.id, parentId: node.parentId, depth: node.depth,
      artifact: node.artifact,
      measurement, score, pareto,
      // Named losses in `swarm-resume.ts`: the grant is refunded because nothing was created.
      proposal: null, proposalError: null, granted: null,
      conclusion: record?.conclusion ?? null,
      transcript: [...(nodes.get(node.parentId)?.transcript ?? []), ...node.produced],
      compacted: null,
      aggregated: record?.aggregated ?? [],
    });

    if (!record) continue;

    const candidate: SwarmCandidate = {
      id: node.id,
      artifact: node.artifact,
      measured: measurement,
      unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
      witnessFound: outcome?.kind === 'sealed'
        || outcome?.kind === 'scored'
        || outcome?.kind === 'unmeasurable'
        ? outcome.witnessFound ?? null
        : null,
      incomplete: outcome?.kind === 'incomplete' ? outcome.detail : null,
      score,
      pareto,
    };

    candidates.push(candidate);
    spentBy.set(node.id, record.tokens);

    if (record.tokens !== null) inheritedTokens = (inheritedTokens ?? 0) + record.tokens;

    if (outcome?.kind === 'judged' && outcome.ensemble > 0) ensembles.push(outcome.ensemble);

    if (outcome?.kind === 'sealed') {
      publication = { kind: 'sealed', breach: outcome.breach, clearedBy: null };
    }

    // Same rank expression as the loop: raw measurement, judged median, sealed ranks nothing.
    let rank: number | null = null;

    if (outcome?.kind === 'scored') rank = outcome.measurement.value;
    else if (outcome?.kind === 'judged') rank = outcome.score;

    if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
      best = candidate;
      bestValue = rank;
    }
  }

  return {
    candidates, ensembles, publication, best, bestValue,
    inheritedExpansions, inheritedTokens,
  };
}

/**
 * What every agent node is handed, built once. Absent deps stay absent keys: presence decides
 * whether a node holds a tool. The report gate is attached by the caller.
 */
export function buildNodeDeps(input: {
  /** Per node, never per run: see {@link NodeAgentDeps.hostNode}. */
  readonly hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  readonly model: LanguageModel;
  readonly journal: HeadJournal;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly reportModelCall?: ModelCallSink;
  readonly publishHeadStream?: PublishHeadStream;
  readonly mission?: MissionScope;
  readonly provisionHome?: NodeWorkspaceProvisioner;
  readonly runtimeForWorkspace?: (workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>;
  readonly nodeCodemode?: NodeCodemode;
  readonly webSearch?: WebSearchProvider;
}): NodeAgentDeps {
  const deps = input;

  const nodeDeps: NodeAgentDeps = {
    hostNode: deps.hostNode, model: deps.model, journal: deps.journal, logger: deps.logger,
  };

  if (deps.signal !== undefined) nodeDeps.signal = deps.signal;

  if (deps.clock !== undefined) nodeDeps.clock = deps.clock;

  if (deps.reportModelCall !== undefined) nodeDeps.reportModelCall = deps.reportModelCall;

  if (deps.publishHeadStream !== undefined) nodeDeps.publishHeadStream = deps.publishHeadStream;

  if (deps.mission !== undefined) nodeDeps.mission = deps.mission;

  if (deps.provisionHome !== undefined) nodeDeps.provisionHome = deps.provisionHome;

  if (deps.runtimeForWorkspace !== undefined) nodeDeps.runtimeForWorkspace = deps.runtimeForWorkspace;

  if (deps.nodeCodemode !== undefined) nodeDeps.nodeCodemode = deps.nodeCodemode;

  if (deps.webSearch !== undefined) nodeDeps.webSearch = deps.webSearch;

  return nodeDeps;
}
