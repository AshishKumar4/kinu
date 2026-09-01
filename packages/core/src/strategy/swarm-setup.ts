/**
 * Setup and measurement context for one swarm run: the region refusals that gate what
 * this runner can execute at all, the measurement context an instrument sees, the
 * measured-baseline helpers, and — as they are extracted — the run's own context
 * construction ahead of the expansion loop.
 *
 * Split from `swarm-run.ts` because this is the SETUP policy: everything decided once,
 * before any node expands, where a refusal is free and a mistake would spend a whole
 * search. The loop and the settle barrier live elsewhere; nothing here reads loop state.
 */
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
import { measuredHalf, normalisedScore, paretoObjectiveAxes } from './objective';
import { argumentDigest } from '../safety/argument-digest';

import type { ModelCallSink } from '../events/model-call';
import type { WebSearchProvider } from '../web/index';
import type { NodeAgentDeps, NodeLoopHost } from './node-agent';
import type { PublishHeadStream } from '../heads/head-stream';
import type { NodeWorkspace, NodeWorkspaceProvisioner } from './node-workspace';
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
 * Whether this tree can execute the resolved shape, or the refusal naming what it
 * would have needed.
 *
 * Every arm names the one thing that is missing and the one move that fixes it, because
 * *Refusals* holds that a refusal offering two remedies was measured being corrected to
 * the wrong one.
 */
export function regionRefusal(resolved: ResolvedSwarm): Refusal | null {
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
  // shape is what `answer` now IS, and `thought` is the degenerate point *The six
  // axes* names, kept as the cheap tier. Both execute below.
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
  // `expand:'aggregate'` RUNS — see `fanInAtLevel`. What refuses here is a composition
  // in which a fan-in could never HAPPEN, and each arm names the one thing that makes it
  // impossible. A composition that resolved and then quietly aggregated nothing would
  // be the accepted-and-ignored axis *Accepted and ignored* refuses, which is the
  // defect the refusal it replaces was written against — the refusal was true about
  // the engine and is not any more.
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
export function measurementContext(rt: AgentRuntime): MeasurementContext | null {
  const shell = rt.shell;
  if (!shell) return null;
  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** The measured baseline this instrument reported alongside a candidate, or null when
 *  the kind measures none. *Measured baseline*: measured, never asserted. */
export function baselineOf(measurement: Measurement, key: string | null): number | null {
  if (!key) return null;
  const reported = measurement.measured?.[key];
  return reported !== undefined && Number.isFinite(reported) ? reported : null;
}

/** Whether `value` sits on the side of the floor no correct candidate can reach.
 *  Named because the comparison INVERTS with the direction, and getting it backwards
 *  turns the fraud check into a fraud. */
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

/** Resolve every instrument of a multi-axis objective before any node is expanded.
 *
 * An instanced objective has one instrument that must report every declared instance.
 * A vector objective has one instrument per component. Neither arm derives an axis
 * from a returned label: the objective declares the comparable coordinates. */
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
 * THE ARCHIVE IN FORCE, or null. Derived once from the resolved advance and passed,
 * never re-read from the axis: the descriptor a candidate is binned into, the admission
 * test that gates its write and the cell count the seal's disclosure reports are three
 * facts about one archive, and three derivations of it are three things that can
 * disagree. `key` is non-null under this arm by `regionRefusal`, so the pair is
 * complete or absent together.
 */
export interface ArchiveInForce {
  readonly key: string;
  readonly novelty: number;
}

/** What a MEASURED run resolves before anything expands: the objective half, the
 * resolved instrument, the measurement context, the workspace-as-found baseline and
 * the objective identity. Every refusal here is free - it fails the run before any
 * node is paid for - and their ORDER is load-bearing: kind, shell, runnability, then
 * spec, so a caller is never sent to correct a field while the instrument behind it
 * is unrunnable.
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
  return { measured, verifier, witnessVerifier, ctx, baseline, identity };
}

/**
 * THE RUN'S STORES, initialised in dependency order: the selection tree, the head
 * journal, the run-level search ledger, the exploration records and the per-node
 * content store a RE-ENTRY reads.
 *
 * Initialised rather than assumed because a workspace that has never run a fork or a
 * search holds none of these tables, and every read below would be a query against a
 * table that does not exist.
 */
export interface RunLedgers {
  readonly sql: SqlExecutor;
  readonly journal: HeadJournal;
  readonly searchLedger: MctsSearchStore;
}

export function initRunLedgers(
  rt: AgentRuntime,
  /**
   * Where this run's durable journal writes are announced, or absent for a
   * caller with nothing watching.
   *
   * THE ONE REASON THIS PARAMETER EXISTS. `LiveHeadJournal`'s contract is that
   * every path into the journal — hosted and unhosted, head and node, top-level
   * and recursive — goes through the instance a backend hands the controller and
   * the node host. A swarm never went through it: this factory built a raw
   * `HeadJournal` of its own, so a node's spawn, its report, and (in-isolate)
   * every one of its steps landed durably and told nobody. Only a HOSTED node's
   * steps announced anything, because those cross to the parent's
   * `recordHeadStep` and the parent's journal is the announcing one — so the
   * Exploration surface was live for one write of one transport and poll-only
   * for every other, which is the worst shape a liveness defect can take.
   *
   * A LISTENER RATHER THAN A JOURNAL INSTANCE. The tables below are `rt`'s, so
   * the journal has to be built over `rt.storage.sql`; a caller handing in an
   * instance could hand one bound to a different database than the one this just
   * initialised. Only the ANNOUNCEMENT is the backend's, which is exactly the
   * seam `LiveHeadJournal` takes.
   */
  announce?: AnnounceHeadActivity,
): RunLedgers {
  const sql = rt.storage.sql;
  initSearchTables(rt.storage.execRaw, sql);
  // The transcript store *The journal read model* governs, and it is the SAME ledger a
  // fork's turns land in: the transcript is a read model over the node's journal, never
  // a second store. `search_nodes` stays the TREE — structure and one normalised value
  // per node — and the journal stays the turns. Initialised rather than assumed, for the
  // reason `initSearchTables` is: a workspace that has never run a fork has no
  // `head_journal`.
  initHeadsTables(rt.storage.execRaw, sql);
  const journal = announce === undefined
    ? new HeadJournal(sql)
    : new LiveHeadJournal(sql, announce);
  // The run-level ledger every search in this workspace has a row in. Initialised for
  // the same reason the two above are, and written for the reason *Accepted and
  // ignored* gives: a swarm wrote a tree and no ledger row, so the surface could read
  // its structure and not one knob it ran under, and the judge clamp it computes and
  // discloses was persisted nowhere at all.
  initMctsSearchTable(rt.storage.execRaw, sql);
  const searchLedger = new MctsSearchStore(sql);
  // The leaderboard *The records store* governs, initialised for the same reason the two
  // above are: a workspace that has never run a search has no `exploration_records`, and
  // the carry-in read immediately below would be a query against a table that does not
  // exist.
  initExplorationRecordsTable(rt.storage.execRaw, sql);
  // The per-node content store a RE-ENTRY reads (*swarm-resume.ts*), initialised for
  // the same reason the three above are. `search_nodes` holds this tree's selection
  // state and cannot answer a resume — `value` is a mean over a subtree, and no column
  // holds the raw measurement a winner is ranked on or the breach that seals a run.
  initSwarmNodeRecords(rt.storage.execRaw);
  return { sql, journal, searchLedger };
}

/**
 * CARRY-IN. What earlier runs of THIS objective, under THIS floor, already reached -
 * read before anything is expanded, so the search starts from it rather than
 * rediscovering it. This is the half that makes the store a store: a writer with no
 * reader persists rows nothing ever starts from, which is the same per-invocation
 * search with a table beside it.
 *
 * Gated on a PUBLISHING carry rather than run unconditionally. `carry` is the axis
 * that says whether a run belongs to a cumulative sequence, and seeding a
 * `carry:'none'` run out of the store would break that axis in the direction nobody
 * is watching - the run would silently inherit a starting point its configuration
 * says it has none of.
 */
export interface CarryIn {
  readonly carriedIn: readonly ExplorationRecord[];
  readonly carriedBest: ExplorationRecord | null;
}

export function readCarryIn(input: {
  readonly sql: SqlExecutor;
  readonly identity: ObjectiveIdentity | null;
  readonly publishing: PublishingCarry | null;
  readonly floor: Floor | null;
  readonly preset: string;
  readonly carryKind: string;
  readonly metric: string;
  readonly log: Logger;
}): CarryIn {
  const { sql, identity, publishing, floor, preset, carryKind, metric, log } = input;
  const carriedIn = identity !== null && publishing !== null
    ? recordsFor(sql, { identity, floor })
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
 * NOTHING IS WRITTEN ON A NODE THIS RUN TAKES OVER, and the absence is the fix.
 *
 * There used to be a `RESUMED_SWARM_NODE_REASON` here — "Interrupted before it
 * reported. This search was re-entered from its durable rows, and the nodes after it
 * are the continuation." — passed into `HeadJournal.abandonRunning` by
 * {@link resolveReentry} and rendered verbatim on the exploration surface. Every
 * clause of it was false about the row it was written on: the node was not finished
 * with, the nodes "after it" were fresh ids the same re-entry then paid for a second
 * time, and a five-node search accumulated five such failures per eviction.
 *
 * A node that was spawned and never reported is UNFINISHED WORK, so the re-entry
 * re-runs it under its own id (`swarm-resume.ts`, `PendingSwarmNode`) and the
 * row is re-opened rather than retired. The only caller that may still retire one is
 * the start-of-life reconciliation, for a root nothing can re-drive — which is the
 * one place where "no report will arrive" is a true statement.
 */

/**
 * THE SEARCH THIS CALL IS: the interrupted one it re-enters, or a new one - plus THE
 * PROFILE THIS RUN RUNS UNDER.
 *
 * A re-driven background job replays the stored tool input verbatim
 * (`orchestrator/background-tools.ts`), so minting a fresh root here is what turned
 * ONE evicted five-head search into two abandoned trees, a second ledger row, and a
 * job that settled `completed - took 18m` carrying an aborted result.
 * `swarm-resume.ts` states the rest of the rule and names what a re-entry cannot
 * recover.
 *
 * The profile follows the same first-attempt/re-drive split: first attempt, the
 * caller's resolution carried down in deps - the snapshot a later re-drive replays,
 * written into the ledger row at `begin`; re-drive, the claimed row's own record, so
 * today's catalog cannot reach an in-flight tree. A first attempt says so out loud
 * with `swarm.profile_snapshot`.
 */
export interface ReentryResolution {
  readonly reentry: SwarmReentry | null;
  readonly runProfile: SwarmProfileSnapshot | null;
}

export function resolveReentry(input: {
  readonly sql: SqlExecutor;
  readonly searchLedger: MctsSearchStore;
  readonly journal: HeadJournal;
  readonly redrive: boolean | undefined;
  readonly task: string;
  readonly preset: string;
  readonly profile: SwarmProfileSnapshot | null;
  readonly log: Logger;
}): ReentryResolution {
  const { sql, searchLedger, journal, redrive, task, preset, profile, log } = input;
  const reentry = redrive === true
    ? reenterSwarm({ sql, ledger: searchLedger, journal }, {
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
 * THE MODEL EVERY NODE RUNS ON, decided once, here.
 *
 * The caller's model is what runs absent a profile record. When a profile record
 * exists, its `tier.model` is what this delegation was routed to, so that is what the
 * nodes run - and BOTH cases read the same field, which is what makes a re-drive
 * continue on the model it started on. Today's catalog cannot reach an in-flight tree
 * because today's catalog is never consulted: the re-drive arm reads the claimed
 * ledger row, and the row was frozen before the first attempt detached.
 *
 * REFUSED, not degraded, in both directions. When the seam is MISSING, running the
 * caller's model while the ledger row names the tier's would put a model that never
 * executed into the provenance AND into the spend, and both are read later as
 * evidence of what this search cost. When the seam THROWS - a session with no
 * registry to build that spec, an unknown provider, a revoked credential - the honest
 * answer is that this tier is unreachable HERE, and a refusal says so where a
 * propagated throw would hand the operator a stack instead of the fact. The cause
 * chain is kept, because the provider's own reason is the actionable half.
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
        + 'model while the run records the tier\'s. Wire AgentsForkDeps.resolveModel on this '
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
 * THE MODELS A ROUTED RUN'S NODES RUN ON, resolved once, here, and refused BEFORE
 * anything spends.
 *
 * `models` routes each node to the spec its slot is assigned (round-robin, per
 * `SwarmInput.models`). Every spec crosses the ONE seam the actor already routes a
 * delegation's tier through — {@link resolveModel}, wired by `agents-tool.ts` from
 * `AgentsForkDeps.resolveModel` — so a swarm's per-node routing and its tier routing
 * build models through the same registry, and there is no second resolver to drift.
 *
 * REFUSED, not degraded, in both directions, and for the same reason
 * {@link resolveNodeModel} refuses: a missing seam would put a model the caller never
 * named into the spend AND the transcript, and a spec the seam cannot build is a
 * caller error naming a model this session has never had. `bad_input` rather than
 * `unavailable`, because the spec is the caller's own words on this surface — the
 * tier arm keeps `unavailable` because a tier is a catalog row the caller only named
 * indirectly.
 *
 * Resolved ONCE for the whole list, not per node mid-run: a run that routes its first
 * two nodes and then faults on the third has already spent on a routing it then
 * abandoned, and a re-entry would re-fault the same spec every wave. The whole list
 * resolves before `createRoot`, which is before the baseline instrument runs, before
 * any ledger row opens, and before any node expands — the "before anything spends"
 * the field's first life lacked.
 *
 * EACH ENTRY KEEPS THE CALLER'S OWN SPEC beside the model it resolved to, because a
 * hosted node cannot be handed a live model: the spec string crosses the facet RPC on
 * `HeadInput.model` and the facet resolves it through the same owner registry
 * (`facetModelSpec('swarm', …)`), so both transports route from one vocabulary.
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
      + 'names others. Wire AgentsForkDeps.resolveModel on this backend.',
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
 * AND IF IT IS NEITHER, IT IS NOTHING. A call that did not re-enter and finds a search
 * of its own task STILL RUNNING is refused rather than given a second tree.
 *
 * This used to be the deliberate arm - "a fresh `agents.swarm` whose task matches a
 * search still expanding gets its own root" - and the case it was defending is real:
 * two concurrent deliberate calls must not grow one search between them. What it did
 * not survive is how a re-spawn actually arrives. A failed job's wake tells the model
 * "decide whether to retry or report the failure", the model retries by calling the
 * tool again, and that call carries no re-drive marker because it is not a re-drive -
 * so it took this arm and minted a second root over a tree the first attempt had left
 * running. Measured on the owner's live workspace: two roots with byte-identical task
 * text, six waves and thirty head spawns against one budget-5 job.
 *
 * A REFUSAL RATHER THAN AN ADOPTION, because adoption is exactly what the marker
 * exists to authorise: a caller with no marker has not proved it owns the earlier
 * attempt, and silently continuing somebody else's tree is the collision from the
 * other direction. So the caller is told the search is already running, told where,
 * and told its result arrives as a wake - which is the answer it wanted.
 *
 * A row this call itself superseded is gone by here: `reenterSwarm` supersedes the
 * losers before it claims, so a re-drive that genuinely found nothing to re-enter
 * leaves nothing running and falls through to a fresh search.
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
 * The ROOT: the workspace as found at depth 0 - the one node no model wrote. Recorded
 * so that selection has something to select and so that every child's depth is DERIVED
 * from a row this engine wrote rather than asserted by its author. A re-entry adopts
 * the row its first attempt wrote: re-inserting it would collide on the primary key,
 * and minting a second root is the duplicate-root defect. One run header is recorded
 * beside it so every node of this search groups under one root in the journal;
 * idempotent under a re-entry - the row is keyed on the root and re-labelled.
 */
export async function createRoot(input: {
  readonly sql: SqlExecutor;
  readonly reentry: SwarmReentry | null;
  readonly verifier: ResolvedVerifier | null;
  readonly ctx: MeasurementContext | null;
  readonly resolved: ResolvedSwarm;
  /** The origin agent's own conversation, the root's children's prefix when supplied. */
  readonly originContext?: readonly ModelMessage[];
  readonly measures: boolean;
  readonly journal: HeadJournal;
  readonly agentNodes: boolean;
}): Promise<{
  readonly rootId: string;
  readonly nodes: Map<string, TreeNode>;
  /** The node this call just built, so a caller needing it does not re-read the map
   *  it was handed and deal with an absence that cannot happen. */
  readonly root: TreeNode;
}> {
  const { sql, reentry, verifier, ctx, resolved, measures, journal, agentNodes } = input;
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
  const root: TreeNode = {
    id: rootId, parentId: null, depth: 0, artifact: rootArtifact,
    // The baseline IS the root's measurement, and its normalised score is 0 by
    // construction — the point the search climbs away from.
    measurement: null, score: measures ? 0 : null, pareto: null,
    proposal: null, proposalError: null, granted: null,
    // The root reported nothing because no model wrote it. Its children's prefix is
    // the ORIGIN's conversation when the caller supplied one (*Inherited context*: a
    // root that started blank would throw away precisely the context that made the
    // caller decide to search) and the task block alone when it did not.
    conclusion: null,
    transcript: reentry?.originContext ?? input.originContext ?? [],
    compacted: null,
    // The root aggregates nothing: it IS the workspace as found, and a fan-in consumes
    // a level the search produced.
    aggregated: [],
  };
  const nodes = new Map<string, TreeNode>([[rootId, root]]);
  // One run header, so every node of this search groups under one root in the journal
  // instead of each appearing as its own empty run — the defect `recordSplit` exists
  // to close, reached here for the same reason. Idempotent under a re-entry: the row is
  // keyed on the root and re-labelled rather than duplicated.
  if (agentNodes) {
    journal.recordSplit(rootId, resolved.label ?? resolved.preset, Date.now());
  }
  return { rootId, nodes, root };
}
/**
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
export interface ResumedSearchSeed {
  readonly candidates: SwarmCandidate[];
  readonly ensembles: number[];
  readonly publication: PublicationState;
  readonly best: SwarmCandidate | null;
  readonly bestValue: number | null;
  /**
   * HOW MANY EXPANSIONS THIS SEARCH HAS ALREADY MADE, and therefore what the budget
   * this attempt may still spend is.
   *
   * THE UNION of the two durable records of a node's existence, and it has to be the
   * union or the count is wrong in one direction or the other. A node's spawn is
   * written to `head_journal` before its model runs; its answer is written to
   * `search_nodes` only after its whole LEVEL settled. Counting tree rows alone —
   * which is what this did — made a search cut inside its only level count ZERO
   * expansions, recreate the entire budget and expand a second full wave under fresh
   * ids, so a five-node request produced ten nodes and then fifteen. Counting journal
   * rows alone would miss a `unit:'thought'` run, which journals nothing at all.
   *
   * The two sets partition cleanly, so the union is a sum with no de-duplication: a
   * node with a tree row is finished as far as the search is concerned, and a node
   * with a journal row and no tree row is exactly what `SwarmReentry.pending` is.
   */
  readonly inheritedExpansions: number;
  readonly inheritedTokens: number | null;
}

export function seedResumedSearch(input: {
  readonly reentry: SwarmReentry | null;
  readonly nodes: Map<string, TreeNode>;
  /** The direction `best` is chosen in - the objective's own, or `maximise` judged. */
  readonly rankDirection: ObjectiveDirection;
  readonly spentBy: Map<string, number | null>;
}): ResumedSearchSeed {
  const { reentry, nodes, rankDirection, spentBy } = input;
  const candidates: SwarmCandidate[] = [];
  let best: SwarmCandidate | null = null;
  let bestValue: number | null = null;
  const ensembles: number[] = [];
  let publication: PublicationState = { kind: 'open' };
  // The paid-for expansions this re-entry re-runs rather than re-buys. Counted
  // BEFORE the loop, because they are not in `reentry.nodes` — that is the whole
  // point of them.
  let inheritedExpansions = reentry?.pending.length ?? 0;
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
    const pareto = outcome?.kind === 'pareto' ? outcome.evidence : null;
    nodes.set(node.id, {
      id: node.id, parentId: node.parentId, depth: node.depth,
      artifact: node.artifact,
      measurement, score, pareto,
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
  return {
    candidates, ensembles, publication, best, bestValue,
    inheritedExpansions, inheritedTokens,
  };
}

/**
 * What every agent node of this run is handed, built ONCE.
 *
 * Assigned rather than spread conditionally, and the reason is the same one
 * `nodeWorkspace` is written for: an absent dep must be an ABSENT KEY. A key written as
 * `undefined` would make "the caller wired none" indistinguishable from "the caller
 * wired nothing", and that distinction is what decides whether a node's surface holds a
 * tool at all.
 *
 * Extracted verbatim from the runner's setup; the report gate is attached by the caller,
 * which is the one place that knows whether an instrument exists.
 */
export function buildNodeDeps(input: {
  readonly rt: AgentRuntime;
  readonly model: LanguageModel;
  readonly journal: HeadJournal;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly reportModelCall?: ModelCallSink;
  readonly publishHeadStream?: PublishHeadStream;
  readonly maxWallClockMs?: number;
  readonly mission?: MissionScope;
  readonly provisionHome?: NodeWorkspaceProvisioner;
  readonly runtimeForWorkspace?: (workspace: NodeWorkspace) => Promise<AgentRuntime>;
  readonly host?: NodeLoopHost;
  readonly executeTool?: unknown;
  readonly webSearch?: WebSearchProvider;
}): NodeAgentDeps {
  const deps = input;
  const nodeDeps: NodeAgentDeps = {
    rt: deps.rt, model: deps.model, journal: deps.journal, logger: deps.logger,
    // The wall clock is OPT-IN (deps.maxWallClockMs, wired below when declared):
    // there is no default clock over a node's work. Its turn runs until it is
    // done, cancelled, refused by its mission governor, or fails definitively.
  };
  if (deps.signal !== undefined) nodeDeps.signal = deps.signal;
  if (deps.reportModelCall !== undefined) nodeDeps.reportModelCall = deps.reportModelCall;
  if (deps.publishHeadStream !== undefined) nodeDeps.publishHeadStream = deps.publishHeadStream;
  if (deps.maxWallClockMs !== undefined) nodeDeps.maxWallClockMs = deps.maxWallClockMs;
  if (deps.mission !== undefined) nodeDeps.mission = deps.mission;
  if (deps.provisionHome !== undefined) nodeDeps.provisionHome = deps.provisionHome;
  if (deps.runtimeForWorkspace !== undefined) nodeDeps.runtimeForWorkspace = deps.runtimeForWorkspace;
  // Only reached by an agent node: the toolless `thought` branch below never
  // builds `nodeDeps` at all, which is what makes the split structural rather
  // than a condition someone has to remember.
  if (deps.host !== undefined) nodeDeps.host = deps.host;
  if (deps.executeTool !== undefined) nodeDeps.executeTool = deps.executeTool;
  if (deps.webSearch !== undefined) nodeDeps.webSearch = deps.webSearch;
  return nodeDeps;
}
