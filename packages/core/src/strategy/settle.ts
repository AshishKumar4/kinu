/**
 * The post-loop settle assembly: report shape, seal-suppression disclosure, binding
 * judge realisation, and why the run stopped. The runner only calls these in order.
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
import type { ActorHandle } from '../identity/actor-handle';
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

/** `stop`, from what the loop observed: budget spent with nothing selectable is settled,
 *  with a frontier open or narrower than configured is truncated. */
export function deriveStop(input: {
  readonly aborted: boolean;
  readonly missionSpent: boolean;
  readonly lost: number;
  readonly remainingBudget: number;
  readonly frontierOpen: boolean;
}): SwarmSettleReport['stop'] {
  const { aborted, missionSpent, lost, remainingBudget, frontierOpen } = input;

  if (aborted) return 'aborted';

  if (missionSpent || lost > 0 || (remainingBudget <= 0 && frontierOpen)) return 'budget';

  return 'settled';
}

/** Cells the seal cost (*The publication seal*), over candidates this run measured;
 *  zero unless sealed. */
export function suppressedCellCount(input: {
  readonly publication: PublicationState;
  readonly archiveKey: string | null;
  readonly measuredCells: ReadonlySet<string>;
}): number {
  if (input.publication.kind === 'open') return 0;

  if (input.archiveKey === null) return input.measuredCells.size > 0 ? 1 : 0;

  return input.measuredCells.size;
}

/** The smallest ensemble any candidate actually sampled; null where none reached one. */
export function judgeEnsembleRealised(
  requested: number | null,
  ensembles: readonly number[],
): JudgeEnsembleReport | null {
  return requested === null
    ? null
    : { requested, realised: ensembles.length > 0 ? Math.min(...ensembles) : null };
}

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
  /** The publishing `carry` in force, or null. Derived once by the caller, since the same
     *  predicate decides whether the run reads the store. */
  readonly carry: PublishingCarry | null;
  readonly records: ExplorationRecordsReport | null;
  readonly judgeEnsemble: JudgeEnsembleReport | null;
  /** Suppressed-carry cell count, computed by the caller, which knows the archive in force. */
  readonly suppressedCells: number;
  readonly expansions: number;
  readonly stop: SwarmSettleReport['stop'];
  readonly usage: Usage;
  readonly durationMs: number;
  readonly fanIn: SwarmFanInReport | null;
  readonly resumed: SwarmResumeReport | null;
}): SwarmSettleReport {
  const { resolved, measured, carry } = input;

  return {
    settle: resolved.settle,
    floorMargin: measured?.floor ? floorMargin(measured.floor, measured.direction) : null,
    baseline: input.baseline,
    // `false` means this search did not find one, not that none exists.
    witnessFound: witnessVerdict(measured, input.candidates),
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
 * The post-loop settle sequence: merge-back, carry admission, exploration records,
 * disclosures, stop, report, and the durable ledger.
 */
export async function settleRun(input: {
  readonly started: number;
  readonly log: Logger;
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
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
    started, log, sql, actor, resolved, rootId, maxDepth, branches, policy, paretoAxes, ctx, verifier,
    measured, baseline, identity, publishing, archive, publication, candidates, best,
    usage, judgeSamples, ensembles, spentBy, carriedIn, carriedBest, levelFanIn, reentry,
    aborted, missionSpent, lost, remainingBudget, expansionBudget, inheritedExpansions,
    inheritedTokens, ledgerEpoch, searchLedger, runProfile,
  } = input;

  const budget = { remaining: remainingBudget };

// Merge-back (*Merge-back*): the policy derives from `settle`, never chosen here. The
// member's diff is the node's reported answer; `base` is read at settle, so the drift and
// stale-verdict rules are satisfied structurally rather than enforced.
if (ctx) {
  const mergePolicy = mergePolicyOf(resolved.settle);
  const readOrigin = originReader(ctx.vfs);

  const members = best && verifier
    ? [await reportedMember({
      nodeId: best.id, answer: best.artifact, score: best.score,
      path: verifier.artifact,
      // No edges at the settle: exactly one member is applied and it already contains what
            // it consumed, so an edge could only refuse it.
      deps: [],
      readOrigin,
    })]
    : [];

  await mergeBack({ policy: mergePolicy, members, settled: levelFanIn.landedIds() }, {
    log,
    preset: resolved.preset,
    readOrigin,
    applyMember: singlePathApply(ctx.vfs),
  });
}

// Carry admission, after the sweep so swept candidates are eligible. The only reader of
// `carry:'artifacts'` `threshold`; `carry:'elites'` still requires a measurement.
const carried = settleCarry({
  carry: resolved.config.carry,
  publication,
  members: candidates.map((candidate) => ({ nodeId: candidate.id, score: candidate.score })),
}, { log, preset: resolved.preset });

log.event('swarm.carry_settled', {
  preset: resolved.preset,
  carry: resolved.config.carry.kind,
  admitted: carried.filter((entry) => entry.verdict.kind === 'admitted').length,
  refused: carried.filter((entry) => entry.verdict.kind === 'refused').length,
});

// Persist admissions; the writer re-checks the seal over the `records` surface. Under
// `advance:'archive'` rows are binned by the instrument's witnessed cell and duplicates
// refused. No objective identity means `records: null`, distinct from zero rows.
const records: ExplorationRecordsReport | null = identity === null ? null : (() => {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const configDigest = configDigestOf(resolved);
  let written = 0;
  let notBetter = 0;
  let tooClose = 0;

  // Keyed off the axis, not the verdict: `admitCarry` admits `none` and `reflections`,
    // so reading the verdict alone would make `carry:'none'` publish.
  for (const entry of publishing === null ? [] : carried) {
    if (entry.verdict.kind !== 'admitted') continue;
    const candidate = byId.get(entry.nodeId);

    // The record keeps the raw measured value; no measurement skips the row.
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
      // Null, not zero: no cost model reaches this runner.
      costUsd: null,
      costTokens: spentBy.get(candidate.id) ?? null,
      at: Date.now(),
    };

    // Event fields are constant across causes so one query covers them.
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
    // Read back from what the write used, so the event and the row cannot disagree.
    let cellName = '';

    if (archive === null) {
      // No partition: this objective's comparable set is one cell.
      verdict = recordExploration(sql, actor, { publication, write: { ...write, descriptor: null } });
    } else {
      const cell = archiveCellOf(archive.key, candidate.measured.measured);

      if (cell.kind === 'unwitnessed') {
        // The instrument reported this key for the baseline but not this candidate; no cell
                // may be invented for it.
        refused({ cause: 'unwitnessed', occupant: '', distance: -1 });
        continue;
      }

      cellName = cell.descriptor;
      verdict = admitToArchive(sql, actor, {
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
      // Name the occupant so a novelty rejection is traceable to what it duplicated.
      refused({ cause: verdict.cause, occupant: verdict.occupant, distance: verdict.distance });
    } else {
      if (verdict.cause === 'not-better') notBetter += 1;
      refused({ cause: verdict.cause, occupant: '', distance: -1 });
    }
  }

  return {
    carriedIn: carriedIn.length,
    carriedInBest: carriedBest?.value ?? null,
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
  expansions: candidates.length, usage, durationMs: Date.now() - started,
  fanIn: resolved.config.expand === 'aggregate' ? levelFanIn.report() : null,
  // `expansions` counts the whole search across attempts; this says what predates this activation.
  resumed: reentry === null ? null : {
    rootId,
    inheritedExpansions,
    remainingBudget: expansionBudget - inheritedExpansions,
    inheritedTokens,
    resumedNodes: reentry.pending.length,
    superseded: reentry.superseded,
    // `reclaim` bumps the lease epoch once per re-entry; epoch 0 is the first attempt.
    attempt: reentry.epoch + 1,
  },
  stop: deriveStop({
    aborted,
    missionSpent,
    lost,
    remainingBudget: budget.remaining,
    frontierOpen: policy === 'pareto'
      ? false
      : selectFrontierNode(sql, actor, {
        rootId, policy, maxDepth,
        explorationWeight: resolved.config.explorationWeight
          ?? DEFAULT_CONFIG.mcts.explorationWeight,
      }) !== null,
  }),
});

// Progress lives in the tree this run wrote; resume readers derive from it. Do not also
// write the row's MCTS checkpoint columns.
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
