/**
 * G0–G9 run admission over the frozen staged manifest.
 *
 * A benchmark run is ADMITTED only when all ten gates hold. An unadmitted run
 * cannot produce a recommendation — `requireAdmitted` throws, and the drivers'
 * `recommend` entries call it before ranking anything. Admission judges the
 * instrument, never the algorithms: a fast number from a blank disk, an
 * incomplete matrix, unknown accounting, or leftover resources is worse than no
 * number, so those runs are refused outright.
 *
 * Cleanup is an admission gate (G8), never a score: a failed teardown
 * invalidates the whole run without touching any algorithm number.
 */

import type { RestoreWork } from '@kinu.run/devbox/durability/contracts';
import type { RunArtifact } from '../r2-bench/report';
import type { CleanupGateId, CleanupReport } from './cleanup';
import {
  R2_CLASS_A_OPERATIONS as R2_CLASS_A_OPS,
  R2_CLASS_B_OPERATIONS as R2_CLASS_B_OPS,
  R2_CLASS_FREE_OPERATIONS as R2_CLASS_FREE_OPS,
  R2_OPERATION_NAMES as R2_OP_VOCABULARY,
} from '../../../packages/devbox/bench/r2-operations';
import {
  scoreCells, stageCells, type CellId, type ConfirmatoryPlan, type MeasuredCell,
  type ScoredCell, type StageId,
} from './protocol';

// ── the operation-counter vocabulary ────────────────────────────────────────

export {
  R2_CLASS_A_OPS,
  R2_CLASS_B_OPS,
  R2_CLASS_FREE_OPS,
  R2_OP_VOCABULARY,
};

// ── the run record ──────────────────────────────────────────────────────────

/** G0. What produced every number in the run. Absent anywhere, the run is
 *  unattributable and therefore unusable. */
export interface RunProvenance {
  readonly runId: string;
  /** The git commit the driver and fixtures ran from. */
  readonly commit: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seed: string;
  readonly image: string;
  /** Dependency versions the fixture reported. */
  readonly versions: Readonly<Record<string, string>>;
  /** The container's own description of itself; empty when never collected. */
  readonly containerFacts: string;
}

export type ArmKind = 'calibration' | 'control' | 'candidate';

/** Per-arm evidence for G1 and G2. An arm carries the exact red witnesses it is
 *  REQUIRED to reproduce, whether or not it competes. */
export interface ArmEvidence {
  readonly arm: string;
  /** What the arm is FOR. A `candidate` competes: it enters G3/G5 evaluation
   *  and the ranking. A `control` or `calibration` measures the instrument or
   *  the bare machine — the layout benchmark's native disk — and never ranks
   *  because it is not a strategy, NOT because of the defects it carries. */
  readonly kind: ArmKind;
  /** Whether this arm's numbers may be ranked. Must be false for every
   *  non-candidate kind. */
  readonly rankEligible: boolean;
  /** The red witnesses this arm MUST produce, preregistered before the run:
   *  e.g. overlay-cas's unbounded restore claim, r2fs's known semantic gaps.
   *  Empty for an arm with no preregistered defect. These are MEASURED COSTS
   *  reproduced to prove the instrument still sees them; a competing arm may
   *  carry them and still win on its numbers. */
  readonly expectedRedChecks: readonly string[];
  /** The checks that actually failed on this arm. */
  readonly observedRedChecks: readonly string[];
  /** The strategy's own surface was verified to hold the bytes — attach or
   *  mount landed and a check saw them. The honest native CONTROL counts as
   *  verified: its disk is the thing being measured, on purpose. */
  readonly attachedVerified: boolean;
  /** POSIX/semantics verdicts held on the attached surface. For an expected-red
   *  control this is false by design; witness matching judges it instead. */
  readonly semanticsPassed: boolean;
  readonly failedChecks: readonly string[];
  /** The arm produced metric rows. Measurements on an unverified surface are
   *  the blank-disk shape and fail G1 instead of ranking. */
  readonly producedMeasurements: boolean;
}

/** G3 evidence: what the run proved about publishing safely at the cut.
 *  Missing evidence is a refusal, never a pass: the drivers default every
 *  field to its failing value and only real fault-cut instrumentation may set
 *  them to passing. */
export interface PublicationEvidence {
  /** A read-only surface was declared somewhere in the run. */
  readonly readOnlyDeclared: boolean;
  /** That surface refused writes, when probed. Null when never probed. */
  readonly readOnlyRefusedWrites: boolean | null;
  /** The F0–F5-style interruption AT the publication cut was actually
   *  injected and the run completed it, rather than skipping the cell. */
  readonly faultCutCompleted: boolean;
  /** Every observer saw all-old or all-new state across the cut — never a
   *  mixture. Null when no observer checked. */
  readonly allOldOrAllNew: boolean | null;
  /** Barrier acknowledgements lost across the cut. Null when not counted. */
  readonly barrierAckLoss: number | null;
  /** References that resolved to absent objects after publication. Null when
   *  not swept. */
  readonly absentReferences: number | null;
  /** A rollback or a phantom root was observed. Null when never checked. */
  readonly rollbackOrPhantomRoot: boolean | null;
}

/** G4 evidence: the security fault cells ran and nothing escaped. The escape
 *  counters are only meaningful once their cells ran, so an incomplete cell
 *  set refuses on its own and cannot hide behind zeros. */
export interface SecurityEvidence {
  readonly credentialLeaks: readonly string[];
  /** The F7 stale-writer-epoch, F10 hostile-metadata, F11 capability
   *  escape-or-replay, and F12 credential-exposure cells all completed. */
  readonly securityCellsComplete: boolean;
  /** Objects written outside the run's own key prefix. */
  readonly prefixEscapes: number;
  /** Capability escapes or replays the surface accepted. */
  readonly capabilityEscapesOrReplays: number;
  /** A write from a superseded writer epoch was accepted. */
  readonly staleWriterAccepted: boolean;
  /** Hostile metadata was stored or served rather than refused. */
  readonly hostileMetadataAccepted: boolean;
}

/** What restore bound an arm CLAIMS, stated before the run. `unbounded` is a
 *  confession rather than a class: an expected-durable arm claiming it cannot
 *  be admitted. */
export type RestoreClaim = 'none' | 'strict-o1' | 'bounded-k' | 'log-p' | 'unbounded';

/** G5 evidence: restore complexity, per arm that claims durability. A counted
 *  RestoreWork row alone is insufficient — the arm must also name its claimed
 *  bound and show it was verified mechanically. */
export interface RestoreEvidence {
  readonly arm: string;
  readonly expected: boolean;
  /** The counted remote work of restoring, from the shared durability
   *  contract. Null when the arm never exercised a restore. */
  readonly work: RestoreWork | null;
  /** The restore class the arm claims. */
  readonly claim: RestoreClaim;
  /** A mechanical check — a measured counter against the claimed class's
   *  bound, not prose — confirmed the claim on this run. */
  readonly mechanicalBoundVerified: boolean;
}

/** One matrix cell the run attempted, for G6 completeness. */
export interface CellCompletion extends CellId {
  readonly completed: boolean;
}
/** G7 evidence: the run's reconciled operation tally. */
export interface AccountingEvidence {
  /** Where the tally came from, e.g. `fixture /ops after final arm`. */
  readonly source: string;
  readonly calls: Readonly<Record<string, number>>;
  readonly classA: number;
  readonly classB: number;
  readonly classFree: number;
  readonly total: number;
}

/** G8 evidence: the state cleanup finished in, as the seven explicit C-gates.
 *  A generic "passed" cannot substitute: every check is recorded on its own,
 *  and missing evidence defaults to false, which refuses. */
export interface CleanupEvidence {
  /** Teardown actually ran. A run that never attempted cleanup is not clean. */
  readonly attempted: boolean;
  /** The operator asked for resources to survive (--keep). Deliberate, but it
   *  means cleanup did not complete, so the run cannot recommend. */
  readonly kept: boolean;
  /** C1 — the fixture Worker is absent. */
  readonly workerAbsent: boolean;
  /** C2 — container applications and their runtime instances are absent. */
  readonly runtimeAbsent: boolean;
  /** C3 — the dedicated bucket was deleted, or holds zero objects AND zero
   *  multipart uploads; a pre-existing bucket's run prefix is drained. */
  readonly bucketAndMultipartEmpty: boolean;
  /** C4 — box durable rows (state, alarms, mounts) are empty. */
  readonly boxDurableStateEmpty: boolean;
  /** C5 — local secrets, generated configs, and child processes are absent. */
  readonly localSecretsProcessesAbsent: boolean;
  /** C6 — operation counters reconcile against the manifest's expectation. */
  readonly countersReconciled: boolean;
  /** C7 — a second replay pass performed zero further deletions. */
  readonly replayIdempotent: boolean;
  readonly multipartResidue: number;
  readonly errors: readonly string[];
}

export interface StorageRunRecord {
  readonly schema: 'storage-matrix/run@1';
  readonly provenance: RunProvenance;
  readonly arms: readonly ArmEvidence[];
  readonly publication: PublicationEvidence;
  readonly security: SecurityEvidence;
  readonly restore: readonly RestoreEvidence[];
  /** Which staged stages this run declares. G6 completes exactly these. */
  readonly declaredStages: readonly StageId[];
  readonly cells: readonly CellCompletion[];
  readonly confirmatoryPlan: ConfirmatoryPlan | null;
  readonly accounting: AccountingEvidence | null;
  readonly cleanup: CleanupEvidence;
  /**
   * The preregistered deciding measurements, one per cell that must survive to
   * a ranking. Completion (did the cell run) and dispersion (did it measure
   * stably) are different claims, so they ride on different fields.
   */
  readonly deciding: readonly MeasuredCell[];
  /** Wall-time budget for one deciding cell, chosen by the driver that owns
   *  the workload. A cell past it is censored, never scored as slow. */
  readonly decidingBudgetMs: number;
}

const cellKey = (cell: CellId): string => `${cell.tree}/${cell.change}/${cell.cache}`;

// ── evaluation ──────────────────────────────────────────────────────────────

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';

export interface GateResult {
  readonly gate: GateId;
  readonly purpose: string;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface AdmissionVerdict {
  readonly admitted: boolean;
  readonly gates: readonly GateResult[];
}

const GATE_PURPOSES = {
  G0: 'Provenance.',
  G1: 'Mount truth.',
  G2: 'Filesystem semantics.',
  G3: 'Publication safety.',
  G4: 'Security.',
  G5: 'Restore complexity.',
  G6: 'Complete cells.',
  G7: 'Reconciled accounting.',
  G8: 'Complete cleanup.',
  G9: 'Statistical validity.',
} as const satisfies Record<GateId, string>;

function gate(id: GateId, reasons: readonly string[]): GateResult {
  return { gate: id, purpose: GATE_PURPOSES[id]!, ok: reasons.length === 0, reasons };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function provenanceProblems(provenance: RunProvenance): string[] {
  const problems: string[] = [];
  if (provenance.runId.trim() === '') problems.push('runId is empty');
  if (!/^[0-9a-f]{7,64}$/.test(provenance.commit)) {
    problems.push(`commit "${provenance.commit}" is not a git revision`);
  }
  if (!ISO_TIMESTAMP.test(provenance.startedAt)) problems.push(`startedAt "${provenance.startedAt}" is not ISO`);
  if (!ISO_TIMESTAMP.test(provenance.finishedAt)) problems.push(`finishedAt "${provenance.finishedAt}" is not ISO`);
  if (
    ISO_TIMESTAMP.test(provenance.startedAt) && ISO_TIMESTAMP.test(provenance.finishedAt)
    && Date.parse(provenance.finishedAt) < Date.parse(provenance.startedAt)
  ) problems.push('finishedAt precedes startedAt');
  if (provenance.seed.trim() === '') problems.push('seed is empty');
  if (provenance.image.trim() === '') problems.push('container image is empty');
  if (Object.keys(provenance.versions).length === 0) problems.push('no dependency versions recorded');
  if (provenance.containerFacts.trim() === '') problems.push('container facts were never collected');
  return problems;
}

/** Expected cells for the stages the run declares, including the frozen
 *  confirmatory plan's cells when that stage is declared. */
export function expectedCells(
  declaredStages: readonly StageId[],
  confirmatoryPlan: ConfirmatoryPlan | null,
): CellId[] {
  const out: CellId[] = [];
  for (const stage of declaredStages) out.push(...stageCells(stage));
  if (declaredStages.includes('confirmatory') && confirmatoryPlan !== null) {
    out.push(...confirmatoryPlan.cells);
  }
  return out;
}

function censorProblems(scored: readonly ScoredCell[]): string[] {
  const problems: string[] = [];
  for (const cell of scored) {
    if (cell.censored && cell.censorReason !== null) {
      problems.push(`deciding cell ${cellKey(cell.id)} censored: ${cell.censorReason}`);
    }
  }
  if (scored.length > 0 && scored.every((cell) => cell.censored)) {
    problems.push('every deciding cell is censored, so no statistical claim survives');
  }
  return problems;
}
function semanticsProblems(record: StorageRunRecord): string[] {
  const problems: string[] = [];
  for (const arm of record.arms) {
    // WITNESSES ARE JUDGED ON EVERY ARM, whatever its rank eligibility. This
    // used to run only on the non-candidate branch, so an instrument that made
    // its arms rank-eligible silently stopped checking that their preregistered
    // defects still reproduced. Preregistration is a drift detector; it is not
    // a statement about who may win, and the two must not be wired together.
    problems.push(...witnessProblems(arm));
    if (arm.kind !== 'candidate') {
      // A calibration reference — the layout benchmark's native disk — measures
      // the machine rather than a strategy, so a rankEligible flag on one is an
      // instrument error regardless of how its checks came out.
      if (arm.rankEligible) {
        problems.push(`arm \`${arm.arm}\` is a ${arm.kind} but is marked rank-eligible`);
      }
      continue;
    }
    if (arm.producedMeasurements && !arm.semanticsPassed) {
      problems.push(`arm \`${arm.arm}\` failed ${arm.failedChecks.length} semantics check(s)`
        + ` (${arm.failedChecks.slice(0, 5).join(', ')})`);
    }
    if (!arm.rankEligible) {
      problems.push(`competing arm \`${arm.arm}\` is marked rank-ineligible`);
    }
  }
  return problems;
}

/**
 * An arm must produce EXACTLY its preregistered witnesses. An observed failure
 * nobody predicted means the instrument found something new; a missing witness
 * means the defect the preregistration exists to catch has silently
 * disappeared. Both are instrument drift and both refuse the run.
 *
 * What this never does is rank. A witness is a MEASURED COST attached to the
 * arm that carries it, and an arm carrying one still competes on its numbers.
 */
function witnessProblems(arm: ArmEvidence): string[] {
  const expected = new Set(arm.expectedRedChecks);
  const observed = new Set(arm.observedRedChecks);
  const problems: string[] = [];
  for (const name of arm.observedRedChecks) {
    if (!expected.has(name)) {
      problems.push(`arm \`${arm.arm}\` failed unexpected check "${name}" not in its preregistered witnesses`);
    }
  }
  for (const name of arm.expectedRedChecks) {
    if (!observed.has(name)) {
      problems.push(
        `arm \`${arm.arm}\` did NOT produce its expected red witness "${name}": `
        + 'an expected failure that vanished is instrument drift',
      );
    }
  }
  return problems;
}

function publicationProblems(publication: PublicationEvidence): string[] {
  const problems: string[] = [];
  if (publication.readOnlyDeclared && publication.readOnlyRefusedWrites !== true) {
    problems.push('a read-only surface was declared but was not proven to refuse writes');
  }
  if (!publication.faultCutCompleted) {
    problems.push('no completed fault-cut evidence: the interruption at the publication cut never ran to completion');
  }
  if (publication.allOldOrAllNew !== true) {
    problems.push('observers did not confirm all-old-or-all-new state across the cut');
  }
  const ackLoss = publication.barrierAckLoss;
  if (ackLoss === null || ackLoss > 0) {
    problems.push(ackLoss === null
      ? 'barrier-ack loss across the cut was never counted'
      : `${ackLoss} barrier acknowledgement(s) were lost`);
  }
  const absent = publication.absentReferences;
  if (absent === null || absent > 0) {
    problems.push(absent === null
      ? 'post-publication references were never swept for absent objects'
      : `${absent} reference(s) resolved to absent objects after publication`);
  }
  if (publication.rollbackOrPhantomRoot !== false) {
    problems.push(publication.rollbackOrPhantomRoot === null
      ? 'rollback and phantom-root behaviour was never checked'
      : 'a rollback or a phantom root was observed');
  }
  return problems;
}

function securityProblems(security: SecurityEvidence): string[] {
  const problems: string[] = [...security.credentialLeaks];
  if (!security.securityCellsComplete) {
    problems.push('security fault cells incomplete: F7 stale-writer, F10 hostile-metadata, '
      + 'F11 capability escape/replay, and F12 credential exposure must all have run');
  }
  if (security.prefixEscapes > 0) {
    problems.push(`${security.prefixEscapes} object(s) landed outside the run's own key prefix`);
  }
  if (security.capabilityEscapesOrReplays > 0) {
    problems.push(`${security.capabilityEscapesOrReplays} capability escape(s) or replay(s) were accepted`);
  }
  if (security.staleWriterAccepted) {
    problems.push('a write from a superseded writer epoch was accepted');
  }
  if (security.hostileMetadataAccepted) {
    problems.push('hostile metadata was stored or served rather than refused');
  }
  return problems;
}

function restoreProblems(record: StorageRunRecord): string[] {
  const kinds = new Map(record.arms.map((arm) => [arm.arm, arm.kind]));
  const problems: string[] = [];
  for (const row of record.restore) {
    // A red control's unbounded-restore claim is its WITNESS, not a defect:
    // only candidate rows are held to the restore-class bar.
    if (!row.expected || kinds.get(row.arm) !== 'candidate') continue;
    if (row.work === null) {
      problems.push(`arm \`${row.arm}\` declares durability but never exercised a restore`);
    }
    if (row.claim === 'unbounded') {
      problems.push(`arm \`${row.arm}\` claims an unbounded restore class, which no durable arm may claim`);
    }
    if (row.claim !== 'none' && !row.mechanicalBoundVerified) {
      problems.push(`arm \`${row.arm}\` claims a ${row.claim} restore bound that was never mechanically verified`);
    }
    if (row.claim === 'none' && row.work !== null) {
      problems.push(`arm \`${row.arm}\` declares durability but claims no restore class at all`);
    }
  }
  return problems;
}

/**
 * Evaluate every gate against the run record. Pure: no platform access, so the
 * gates are provable hermetically and the same code judges a live run.
 *
 * G9 re-derives dispersion from the raw repetitions rather than trusting any
 * precomputed flag: `scoreCells` in protocol.ts is the one place the CV ceiling
 * (`MAX_CV`) and the censoring rules live.
 */
export function evaluateRun(record: StorageRunRecord): AdmissionVerdict {
  const gates: GateResult[] = [
    gate('G0', provenanceProblems(record.provenance)),
    gate('G1', mountTruthProblems(record)),
    gate('G2', semanticsProblems(record)),
    // Run-level publication, security, and restore-class posture is judged
    // only when the run actually contains candidate arms; a controls-only
    // instrument run has no candidate claim to protect.
    gate('G3', record.arms.some((arm) => arm.kind === 'candidate')
      ? publicationProblems(record.publication)
      : []),
    gate('G4', record.arms.some((arm) => arm.kind === 'candidate')
      ? securityProblems(record.security)
      : []),
    gate('G5', restoreProblems(record)),
    gate('G6', completenessProblems(record)),
    gate('G7', accountingProblems(record.accounting)),
    gate('G8', cleanupProblems(record.cleanup)),
    gate(
      'G9',
      censorProblems(scoreCells(record.deciding, record.decidingBudgetMs)),
    ),
  ];
  return { admitted: gates.every((row) => row.ok), gates };
}

function mountTruthProblems(record: StorageRunRecord): string[] {
  const problems: string[] = [];
  for (const arm of record.arms) {
    if (arm.producedMeasurements && !arm.attachedVerified) {
      problems.push(
        `arm \`${arm.arm}\` produced measurements without a verified attach: they describe `
        + 'the container\'s own blank disk, not the strategy',
      );
    }
    if (!arm.producedMeasurements && !arm.attachedVerified && arm.failedChecks.length === 0) {
      problems.push(`arm \`${arm.arm}\` neither attached nor recorded why`);
    }
  }
  return problems;
}

function completenessProblems(record: StorageRunRecord): string[] {
  const done = new Set(record.cells.filter((cell) => cell.completed).map(cellKey));
  return expectedCells(record.declaredStages, record.confirmatoryPlan)
    .filter((cell) => !done.has(cellKey(cell)))
    .map((cell) => `cell ${cellKey(cell)} (${cell.stage}) did not complete`);
}

function accountingProblems(accounting: AccountingEvidence | null): string[] {
  if (accounting === null) return ['the run recorded no operation accounting at all'];
  const problems: string[] = [];
  const known = new Set<string>(R2_OP_VOCABULARY);
  for (const name of Object.keys(accounting.calls)) {
    if (!known.has(name)) problems.push(`unknown operation counter "${name}" in ${accounting.source}`);
  }
  const classesSum = accounting.classA + accounting.classB + accounting.classFree;
  if (classesSum !== accounting.total) {
    problems.push(`class totals (${classesSum}) do not equal the recorded total (${accounting.total})`);
  }
  const callsSum = Object.values(accounting.calls).reduce((sum, count) => sum + count, 0);
  if (callsSum !== accounting.total) {
    problems.push(`counter sum (${callsSum}) does not equal the recorded total (${accounting.total})`);
  }
  return problems;
}

function cleanupProblems(cleanup: CleanupEvidence): string[] {
  const problems: string[] = [];
  if (!cleanup.attempted) problems.push('cleanup never ran');
  if (cleanup.kept) problems.push('--keep left resources in place, so cleanup did not complete');
  problems.push(...cleanup.errors.map((error) => `cleanup error: ${error}`));
  if (cleanup.multipartResidue > 0) {
    problems.push(`${cleanup.multipartResidue} incomplete multipart upload(s) remain`);
  }
  if (!cleanup.workerAbsent) problems.push('C1: the fixture Worker is still present');
  if (!cleanup.runtimeAbsent) problems.push('C2: container applications or runtime instances remain');
  if (!cleanup.bucketAndMultipartEmpty) {
    problems.push('C3: the dedicated bucket was not deleted, or objects and multipart uploads remain');
  }
  if (!cleanup.boxDurableStateEmpty) problems.push('C4: box durable rows, alarms, or mounts remain');
  if (!cleanup.localSecretsProcessesAbsent) {
    problems.push('C5: local secrets, generated configs, or child processes remain');
  }
  if (!cleanup.countersReconciled) problems.push('C6: operation counters do not reconcile');
  if (cleanup.attempted && !cleanup.kept && !cleanup.replayIdempotent) {
    problems.push('C7: the cleanup replay was not idempotent');
  }
  return problems;
}


// ── verdict consumption ─────────────────────────────────────────────────────

/** Throw unless every gate held. The message names each failing gate and why. */
export function requireAdmitted(verdict: AdmissionVerdict): void {
  if (verdict.admitted) return;
  throw new Error(refusalText(verdict));
}

/** The refusal a renderer prints instead of a recommendation. */
export function refusalText(verdict: AdmissionVerdict): string {
  const failed = verdict.gates.filter((row) => !row.ok);
  const lines = failed.map(
    (row) => `- ${row.gate} ${row.purpose}: ${row.reasons.join('; ')}`,
  );
  return [
    'RECOMMENDATION REFUSED. This run failed admission, so ranking anything it measured would '
    + 'publish a claim the instrument cannot support:',
    ...lines,
  ].join('\n');
}

/**
 * Map a live C1–C7 report onto the record's explicit per-check evidence. A
 * gate the report does not carry maps to false, and absence of evidence
 * refuses — never the reverse.
 */
export function cleanupEvidenceFromReport(report: CleanupReport): CleanupEvidence {
  const byGate = new Map(report.checks.map((row) => [row.gate, row]));
  const okOr = (gate: CleanupGateId): boolean => byGate.get(gate)?.ok ?? false;
  return {
    attempted: true,
    kept: report.kept,
    workerAbsent: okOr('C1'),
    runtimeAbsent: okOr('C2'),
    bucketAndMultipartEmpty: okOr('C3') && report.multipartResidue === 0,
    boxDurableStateEmpty: okOr('C4'),
    localSecretsProcessesAbsent: okOr('C5'),
    countersReconciled: okOr('C6'),
    replayIdempotent: okOr('C7'),
    multipartResidue: report.multipartResidue,
    errors: report.checks.filter((row) => !row.ok).map((row) => `${row.gate}: ${row.detail}`),
  };
}

// ── mapping helpers for the existing drivers ────────────────────────────────

/**
 * Every occurrence of a secret in serialized output. The driver owns its token;
 * the record carries only what leaked, so G4 judges presence rather than
 * trusting a boolean someone set.
 */
export function findCredentialLeaks(text: string, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret !== '' && text.includes(secret))
    .map(() => `credential material appears verbatim in the run's own output`);
}

/** What the caller supplies that an r2-bench artifact cannot carry. The
 *  publication, security, and restore rows must be stated in FULL: a driver
 *  without fault-cut instrumentation passes refusing defaults, never
 *  implicit truths. */
export interface R2RecordExtras {
  readonly declaredStages: readonly StageId[];
  readonly confirmatoryPlan: ConfirmatoryPlan | null;
  readonly cleanup: CleanupEvidence;
  readonly deciding: readonly MeasuredCell[];
  readonly decidingBudgetMs: number;
  readonly publication: PublicationEvidence;
  readonly security: SecurityEvidence;
  readonly restore: readonly RestoreEvidence[];
}

const NATIVE_CONTROL = 'native';

function armFromLayout(layout: RunArtifact['layouts'][number]): ArmEvidence {
  const failed = layout.mountError !== null
    ? [`mount refused: ${layout.mountError}`]
    : [];
  let semanticsPassed = layout.mountError === null;
  if (semanticsPassed && layout.id !== NATIVE_CONTROL) {
    // The control runs on the container disk by design; every mounted arm must
    // hold the same POSIX verdicts the control held, per repetition, or G2
    // refuses the arm.
    const broken = new Set<string>();
    for (const run of layout.reps) {
      for (const phase of run.phases) {
        for (const verdictRow of phase.verdicts) {
          if (!verdictRow.holds) broken.add(verdictRow.name);
        }
      }
    }
    for (const name of broken) failed.push(name);
    semanticsPassed = broken.size === 0;
  }
  return {
    arm: layout.id,
    kind: layout.id === NATIVE_CONTROL ? 'control' : 'candidate',
    rankEligible: layout.id !== NATIVE_CONTROL,
    // THE LAYOUT BENCHMARK PREREGISTERS NO WITNESSES, so it observes none. A
    // mount refusal is a FAILED CHECK — it is already in `failedChecks`, and it
    // is what makes this arm unattached and its semantics unproven — never an
    // "observed red witness", which means "a defect predicted before the run
    // showed up where it was predicted". Recording it in both places made
    // `witnessProblems` see an unpredicted red on an arm whose instrument has
    // no predictions to check it against.
    expectedRedChecks: [],
    observedRedChecks: [],
    attachedVerified: layout.id === NATIVE_CONTROL || layout.mountError === null,
    semanticsPassed,
    failedChecks: failed,
    producedMeasurements: layout.reps.some((run) => run.phases.some((phase) => phase.metrics.length > 0)),
  };
}

/**
 * Build an admission record from an r2-bench artifact plus the facts only the
 * driver knows. The mapping is total over the artifact: a field the fixture
 * never filled becomes a gate failure here rather than an undefined downstream.
 */
export function recordFromR2Artifact(
  artifact: Omit<RunArtifact, 'admission'>,
  extras: R2RecordExtras,
): StorageRunRecord {
  return {
    schema: 'storage-matrix/run@1',
    provenance: {
      runId: artifact.runId,
      commit: artifact.versions['commit'] ?? '',
      startedAt: artifact.startedAt,
      finishedAt: artifact.finishedAt,
      seed: String(artifact.seed),
      image: artifact.versions['image'] ?? '',
      versions: { ...artifact.versions },
      containerFacts: artifact.containerFacts,
    },
    arms: artifact.layouts.map(armFromLayout),
    publication: extras.publication,
    security: extras.security,
    restore: extras.restore,
    declaredStages: extras.declaredStages,
    cells: [],
    confirmatoryPlan: extras.confirmatoryPlan,
    accounting: aggregateR2Accounting(artifact),
    cleanup: extras.cleanup,
    deciding: extras.deciding,
    decidingBudgetMs: extras.decidingBudgetMs,
  };
}

/** Sum every arm's `/ops` tally into one accounting row. Arms that never read
 *  a tally contribute nothing; an all-null sum leaves accounting absent so G7
 *  refuses instead of pricing zero operations. */
export function aggregateR2Accounting(
  artifact: Pick<RunArtifact, 'layouts'>,
): AccountingEvidence | null {
  const tallies = artifact.layouts.map((layout) => layout.ops).filter((ops) => ops !== null);
  if (tallies.length === 0) return null;
  const calls: Record<string, number> = {};
  let classA = 0;
  let classB = 0;
  let classFree = 0;
  let total = 0;
  for (const ops of tallies) {
    classA += ops.classA;
    classB += ops.classB;
    classFree += ops.classFree;
    total += ops.total;
    for (const [name, count] of Object.entries(ops.calls)) calls[name] = (calls[name] ?? 0) + count;
  }
  return {
    source: `fixture /ops tallies summed over ${tallies.length} arm(s)`,
    calls,
    classA,
    classB,
    classFree,
    total,
  };
}
