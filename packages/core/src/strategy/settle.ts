/**
 * The post-loop settle ASSEMBLY: what the run's observations become when the expansion
 * loop ends — the report's shape, the seal-suppression disclosure, the binding judge
 * realisation, and the vocabulary that says why the run stopped.
 *
 * Split from `swarm-run.ts` because this is reporting POLICY, not loop mechanics: each
 * function here owns one fact the settle report states and the exact derivation another
 * consumer may quote. What stays in the runner is orchestration only — calling these in
 * order with the state the loop observed.
 */
import { carrySuppression, floorMargin, paretoFront } from './objective';
import type {
  MeasuredObjective, ParetoAxis, PublicationState, PublishingCarry,
} from './objective';
import { usageTotal, type Usage } from '../usage';
import type {
  JudgeEnsembleReport, ResolvedSwarm, SwarmCandidate, SwarmFanInReport,
  SwarmResumeReport, SwarmResult, SwarmSettleReport,
} from './swarm';
import type { ExplorationRecordsReport } from './records';


import { DEFAULT_CONFIG } from '../config';
import { selectFrontierNode, type FrontierPolicy } from '../mcts/frontier';
import type { Logger } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import type { MctsSearchStore } from '../mcts/search-store';
import type { SwarmProfileSnapshot } from '../profiles';
import { admitToArchive, archiveCellOf, type ArchiveVerdict } from './archive';
import { reportedMember, singlePathApply } from './fanin';
import { mergeBack, mergePolicyOf, originReader, settleCarry } from './merge-back';
import { configDigestOf } from './swarm';
import type { ExplorationRecord, MeasurementContext, ObjectiveIdentity } from './objective';
import type { ResolvedVerifier } from './verifier-registry';
import type { SwarmReentry } from './swarm-resume';
import type { ArchiveInForce } from './swarm-setup';
import { recordExploration, type ExplorationWrite } from './records';

/** The `stop` value, from what the LOOP observed rather than from the count. A budget
 *  spent with nothing left to select is a SETTLED search; a budget spent with a frontier
 *  still open is a truncated one, and a search narrower than its configured width is
 *  truncated too even if it stopped for another reason. A mission cap that ran out is
 *  `budget` with expansions still unspent — the one case where the two budgets disagree,
 *  and the ledger's is the one that stopped the run. */
export function deriveStop(input: {
  readonly aborted: boolean;
  readonly missionSpent: boolean;
  readonly lost: number;
  readonly remainingBudget: number;
  readonly frontierOpen: boolean;
}): SwarmSettleReport['stop'] {
  const { aborted, missionSpent, lost, remainingBudget, frontierOpen } = input;
  return aborted
    ? 'aborted'
    : missionSpent || lost > 0 || (remainingBudget <= 0 && frontierOpen)
      ? 'budget'
      : 'settled';
}

/** WHAT THE SEAL COST, IN CELLS. The disclosure *The publication seal* requires is
 *  stated over cells rather than over refused writes. Counted over the candidates this
 *  run MEASURED, because those are the cells it would have published into, and only under
 *  a seal: with the run open there is no suppression to report and the number would be a
 *  set built for nobody. */
export function suppressedCellCount(input: {
  readonly publication: PublicationState;
  readonly archiveKey: string | null;
  readonly measuredCells: ReadonlySet<string>;
}): number {
  if (input.publication.kind === 'open') return 0;
  if (input.archiveKey === null) return input.measuredCells.size > 0 ? 1 : 0;
  return input.measuredCells.size;
}

/** The BINDING realisation: the smallest ensemble any candidate actually sampled. Null
 *  where none reached the ensemble, which for a judged run means every candidate
 *  short-circuited before a judge was asked. */
export function judgeEnsembleRealised(
  requested: number | null,
  ensembles: readonly number[],
): JudgeEnsembleReport | null {
  return requested === null
    ? null
    : { requested, realised: ensembles.length > 0 ? Math.min(...ensembles) : null };
}

/** The report *Witness objectives* requires, assembled from what the run actually
 *  observed. */
export function witnessVerdict(
  measured: MeasuredObjective | null,
  candidates: readonly SwarmCandidate[],
): boolean | null {
  return measured?.witness
    ? candidates.some((candidate) => candidate.witnessFound === true)
    : null;
}

export function measuredCellsFor(
  archive: ArchiveInForce | null,
  candidates: readonly SwarmCandidate[],
): Set<string> {
  if (archive === null) {
    return candidates.some((candidate) => candidate.measured !== null)
      ? new Set(['flat'])
      : new Set();
  }
  return new Set(candidates.flatMap((candidate) => {
    if (candidate.measured === null) return [];
    const cell = archiveCellOf(archive.key, candidate.measured.measured);
    return cell.kind === 'cell' ? [cell.descriptor] : [];
  }));
}

export function settleReport(input: {
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
  const { resolved, measured, carry } = input;
  return {
    settle: resolved.settle,
    floorMargin: measured?.floor ? floorMargin(measured.floor, measured.direction) : null,
    baseline: input.baseline,
    // A witness verdict about THIS RUN. `false` is "this search did not find one",
    // and there is no field on this report that could say none exists.
    witnessFound: witnessVerdict(measured, input.candidates),
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


/**
 * The entire POST-LOOP SETTLE sequence. The expansion loop hands this module its final
 * observations; this module applies derived merge-back, decides carry admission, writes
 * exploration records, discloses suppression and judge realisation, derives the stop,
 * assembles the report and settles the durable ledger.
 */
export async function settleRun(input: {
  readonly started: number;
  readonly log: Logger;
  readonly sql: SqlExecutor;
  readonly resolved: ResolvedSwarm;
  readonly rootId: string;
  readonly maxDepth: number;
  readonly branches: number;
  readonly policy: FrontierPolicy | 'pareto';
  readonly paretoAxes: readonly ParetoAxis[] | null;
  readonly ctx: MeasurementContext | null;
  readonly verifier: ResolvedVerifier | null;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly identity: ObjectiveIdentity | null;
  readonly publishing: PublishingCarry | null;
  readonly archive: ArchiveInForce | null;
  readonly publication: PublicationState;
  readonly candidates: readonly SwarmCandidate[];
  readonly best: SwarmCandidate | null;
  readonly usage: Usage;
  readonly judgeSamples: number | null;
  readonly ensembles: readonly number[];
  readonly spentBy: ReadonlyMap<string, number | null>;
  readonly carriedIn: readonly ExplorationRecord[];
  readonly carriedBest: ExplorationRecord | null;
  readonly levelFanIn: {
    landedIds(): readonly string[];
    report(): SwarmFanInReport;
  };
  readonly reentry: SwarmReentry | null;
  readonly aborted: boolean;
  readonly missionSpent: boolean;
  readonly lost: number;
  readonly remainingBudget: number;
  readonly expansionBudget: number;
  readonly inheritedExpansions: number;
  readonly inheritedTokens: number | null;
  readonly ledgerEpoch: number;
  readonly searchLedger: MctsSearchStore;
  readonly runProfile: SwarmProfileSnapshot | null;
}): Promise<SwarmResult> {
  const {
    started, log, sql, resolved, rootId, maxDepth, branches, policy, paretoAxes, ctx, verifier,
    measured, baseline, identity, publishing, archive, publication, candidates, best,
    usage, judgeSamples, ensembles, spentBy, carriedIn, carriedBest, levelFanIn, reentry,
    aborted, missionSpent, lost, remainingBudget, expansionBudget, inheritedExpansions,
    inheritedTokens, ledgerEpoch, searchLedger, runProfile,
  } = input;
  const budget = { remaining: remainingBudget };

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
  await mergeBack({ policy, members, settled: levelFanIn.landedIds() }, {
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

const measuredCells = measuredCellsFor(archive, candidates);
const suppressedCells = suppressedCellCount({
  publication,
  archiveKey: archive?.key ?? null,
  measuredCells,
});

const judgeEnsemble = judgeEnsembleRealised(judgeSamples, ensembles);

const report = settleReport({
  resolved, measured, baseline, publication, candidates, best, carry: publishing,
  records, judgeEnsemble, suppressedCells,
  // Every child this run actually created and measured — the candidate list IS the
  // count, rather than a second tally beside it that could disagree.
  expansions: candidates.length, usage, durationMs: Date.now() - started,
  // WHAT THE FAN-INS DID, or null on a run that fans in nothing — which is every
  // `expand:'sample'` run, and is a different claim from a fan-in that did nothing.
  fanIn: resolved.config.expand === 'aggregate' ? levelFanIn.report() : null,
  // WHAT THIS RUN RE-ENTERED, or null on a first attempt. `expansions` above counts
  // the WHOLE search across attempts — one request, one tree, one count — so this is
  // the field that says how much of it predates this activation.
  resumed: reentry === null ? null : {
    rootId,
    inheritedExpansions,
    remainingBudget: expansionBudget - inheritedExpansions,
    inheritedTokens,
    resumedNodes: reentry.pending.length,
    superseded: reentry.superseded,
    // The lease IS the attempt counter: `reclaim` bumps it exactly once per re-entry,
    // and epoch 0 is the first attempt — so this run is the (epoch + 1)th.
    attempt: reentry.epoch + 1,
  },
  stop: deriveStop({
    aborted,
    missionSpent,
    lost,
    remainingBudget: budget.remaining,
    frontierOpen: policy === 'pareto'
      ? false
      : selectFrontierNode(sql, {
        rootId, policy, maxDepth,
        explorationWeight: resolved.config.explorationWeight
          ?? DEFAULT_CONFIG.mcts.explorationWeight,
      }) !== null,
  }),
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
  frontier: paretoAxes === null
    ? null
    : paretoFront(
      paretoAxes,
      candidates
        .filter((candidate) => candidate.pareto !== null)
        .sort((left, right) => left.id.localeCompare(right.id))
        .flatMap((candidate) => candidate.pareto === null
          ? []
          : [{ candidate, evidence: candidate.pareto }]),
    ).map(({ candidate }) => candidate),
};
if (runProfile) Object.assign(result, { profile: runProfile });
return result;
}
