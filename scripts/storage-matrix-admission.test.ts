import { describe, expect, test } from 'bun:test';
import {
  evaluateRun, expectedCells, refusalText, requireAdmitted,
  type AdmissionVerdict, type ArmEvidence, type CleanupEvidence, type GateId,
  type StorageRunRecord,
} from './fixtures/storage-matrix/admission';
import { type CellCompletion } from './fixtures/storage-matrix/admission';
import { type MeasuredCell } from './fixtures/storage-matrix/protocol';
import { summarize } from './fixtures/r2-bench/stats';
import type { ProbeRun } from './fixtures/r2-bench/report';
import {
  COLD_ATTACH_CEILING_MS,
  DECIDING_METRIC,
  EXPECTED_LADDER_ROWS,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_DIGEST,
  devboxAdmission,
  controlWitnessChecks,
  devboxArmEvidence,
  type ArmResult,
  type RunIdentity,
  type Strategy,
  type ControlWitnessFacts,
} from './bench-devbox-strategies';

const cell: CellCompletion = { stage: 'blank', tree: 'T0', change: 'C0', cache: 'K0', completed: true };
const deciding: MeasuredCell = { id: cell, values: [100, 105], wallMs: 1_000 };

/**
 * Facts in which every control's own documented defect DID show up: the shape a
 * deployed run's witness cells produce when the instrument still sees what it
 * was built to see. One set for all three arms, because each classifier only
 * reads the groups its own witnesses name.
 */
const WITNESSED_FACTS: ControlWitnessFacts = {
  deltaLayerCollapse: {
    chainId: 'chain-7',
    deltaBytes: 71_303_168,
    attachDetail: 'chain chain-7 142606336B base+delta layered',
    deltaLayerMounted: true,
    markerInMergedView: true,
    markerInUpper: false,
    collapsedChainId: 'chain-8',
    collapsedNamesDelta: false,
  },
  mutableDelta: {
    key: 'backups/chain-7/delta.sqsh',
    etagBefore: 'e1',
    etagAfter: 'e2',
    bytesBefore: 65_536,
    bytesAfter: 131_072,
  },
  unboundedPendingReplay: {
    smallPending: 50, smallReplayed: 50, largePending: 500, largeReplayed: 500,
  },
  upperScan: { smallEntries: 210, smallMs: 900, largeEntries: 2_010, largeMs: 7_400 },
  openWriteLoss: { wroteBytes: 41, survivedBytes: null },
  nonAtomicRename: {
    fileBytes: 1_048_576, storeOps: 3, sourcePresent: false, destinationBytes: 1_048_576,
  },
  posixGap: { syncedKeyPresent: false, key: 'boxes/probe/witness-open-write.bin' },
};

function candidateArm(overrides: Partial<ArmEvidence> = {}): ArmEvidence {
  return {
    arm: 'candidate-a',
    kind: 'candidate',
    rankEligible: true,
    expectedRedChecks: [],
    observedRedChecks: [],
    attachedVerified: true,
    semanticsPassed: true,
    failedChecks: [],
    producedMeasurements: true,
    ...overrides,
  };
}

function cleanCleanup(): CleanupEvidence {
  return {
    attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
    bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
    localSecretsProcessesAbsent: true, countersReconciled: true,
    replayIdempotent: true, multipartResidue: 0, errors: [],
  };
}

function validRecord(): StorageRunRecord {
  return {
    schema: 'storage-matrix/run@1',
    provenance: {
      runId: 'run-1', commit: '3a115f232',
      startedAt: '2026-08-25T10:00:00.000Z', finishedAt: '2026-08-25T10:01:00.000Z',
      seed: '17', image: 'docker.io/cloudflare/sandbox:0.12.8',
      versions: { '@cloudflare/sandbox': '0.12.8' }, containerFacts: 'Linux fixture 6.0',
    },
    arms: [candidateArm()],
    publication: {
      readOnlyDeclared: false, readOnlyRefusedWrites: null, faultCutCompleted: true,
      allOldOrAllNew: true, barrierAckLoss: 0, absentReferences: 0, rollbackOrPhantomRoot: false,
    },
    security: {
      credentialLeaks: [], securityCellsComplete: true, prefixEscapes: 0,
      capabilityEscapesOrReplays: 0, staleWriterAccepted: false, hostileMetadataAccepted: false,
    },
    restore: [],
    declaredStages: ['blank'],
    cells: [cell],
    confirmatoryPlan: null,
    accounting: {
      source: 'fixture /ops', calls: { put: 2, get: 1 }, classA: 2, classB: 1, classFree: 0, total: 3,
    },
    cleanup: cleanCleanup(),
    deciding: [deciding],
    decidingBudgetMs: 2_000,
  };
}

function expectsGate(record: StorageRunRecord, gate: string, phrase: string): void {
  const verdict = evaluateRun(record);
  expect(verdict.admitted).toBe(false);
  const result = verdict.gates.find((row) => row.gate === gate);
  expect(result?.ok).toBe(false);
  expect(result?.reasons.join(' ')).toContain(phrase);
  expect(() => requireAdmitted(verdict)).toThrow(phrase);
}

describe('G0-G9 storage run admission', () => {
  test('admits a fully-proven blank-stage run with one clean candidate', () => {
    const verdict = evaluateRun(validRecord());
    expect(verdict.admitted).toBe(true);
    expect(verdict.gates.map((row) => row.gate)).toEqual([
      'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9',
    ]);
  });

  test('G0 refuses missing provenance before any recommendation can be derived', () => {
    expectsGate(
      { ...validRecord(), provenance: { ...validRecord().provenance, commit: '' } },
      'G0', 'not a git revision',
    );
  });

  test('G1 refuses measured blank disk rows', () => {
    expectsGate({
      ...validRecord(),
      arms: [candidateArm({ attachedVerified: false })],
    }, 'G1', 'blank disk');
  });

  test('G2 refuses a candidate semantics failure even when the mount landed', () => {
    expectsGate({
      ...validRecord(),
      arms: [candidateArm({ semanticsPassed: false, failedChecks: ['rename-atomic'] })],
    }, 'G2', 'rename-atomic');
  });

  test('a rank-ineligible flag on a non-candidate kind is an instrument error', () => {
    expectsGate({
      ...validRecord(),
      arms: [
        candidateArm(),
        candidateArm({ arm: 'red-overlay', kind: 'control', rankEligible: true }),
      ],
    }, 'G2', 'rank-eligible');
  });
  test('one expected-red control beside one clean candidate admits', () => {
    const record: StorageRunRecord = {
      ...validRecord(),
      arms: [...validRecord().arms, candidateArm({
        arm: 'red-overlay-cas',
        kind: 'control',
        rankEligible: false,
        expectedRedChecks: ['restore-class-unbounded'],
        observedRedChecks: ['restore-class-unbounded'],
        semanticsPassed: false,
      })],
    };
    expect(evaluateRun(record).admitted).toBe(true);
  });

  test('a devbox run whose witness cells never ran cannot recommend', () => {
    const record: StorageRunRecord = {
      ...validRecord(),
      arms: (['snapshot-chain', 'r2fs', 'overlay-cas'] as const).map((strategy) => devboxArmEvidence({
        strategy,
        verifyPassed: true,
        verifyChecks: [],
        phases: [],
        checkpoints: [],
        decisiveTicks: [],
        witnessChecks: [],
      })),
    };
    const verdict = evaluateRun(record);
    expect(verdict.admitted).toBe(false);
    const g2 = verdict.gates.find((row) => row.gate === 'G2');
    expect(g2?.reasons.join(' ')).toContain('expected failure that vanished');
    expect(() => requireAdmitted(verdict)).toThrow('RECOMMENDATION REFUSED');
  });

  test('an arm whose cells OBSERVED every preregistered witness satisfies G2 and still ranks', () => {
    // THE RULING THIS PINS. A preregistered defect is a MEASURED COST, so an arm
    // that reproduced all of its own is admitted AND rank-eligible. It used to
    // be neither: `devboxArmEvidence` marked these three `kind: 'control'` with
    // `rankEligible: false`, and G2 would have refused any attempt to rank them.
    //
    // The repair the witness cells exist for: the expectations are unchanged and
    // the observation now happens, so a control that failed as predicted stops
    // refusing the run it was meant to validate.
    const observed = (strategy: 'snapshot-chain' | 'r2fs' | 'overlay-cas'): ArmEvidence =>
      devboxArmEvidence({
        strategy,
        verifyPassed: true,
        verifyChecks: [],
        phases: [],
        checkpoints: [],
        decisiveTicks: [],
        witnessChecks: controlWitnessChecks(strategy, WITNESSED_FACTS),
      });
    const record: StorageRunRecord = {
      ...validRecord(),
      arms: [...validRecord().arms, observed('snapshot-chain'), observed('r2fs'), observed('overlay-cas')],
    };
    const g2 = evaluateRun(record).gates.find((row) => row.gate === 'G2');
    expect(g2?.reasons).toEqual([]);
    expect(g2?.ok).toBe(true);
    for (const strategy of ['snapshot-chain', 'r2fs', 'overlay-cas'] as const) {
      expect(observed(strategy).rankEligible).toBe(true);
    }
  });

  test('one witness that vanished still refuses, with the others observed', () => {
    const arm = devboxArmEvidence({
      strategy: 'r2fs',
      verifyPassed: true,
      verifyChecks: [],
      phases: [],
      checkpoints: [],
      decisiveTicks: [],
      // The rename is atomic now — which would be an improvement, and is exactly
      // the drift a control exists to notice rather than absorb.
      witnessChecks: controlWitnessChecks('r2fs', {
        ...WITNESSED_FACTS,
        nonAtomicRename: { fileBytes: 1_048_576, storeOps: 0, sourcePresent: false, destinationBytes: 1_048_576 },
      }),
    });
    expectsGate(
      { ...validRecord(), arms: [...validRecord().arms, arm] },
      'G2',
      'did NOT produce its expected red witness "non-atomic-rename"',
    );
  });

  test('an unexpected control failure refuses as instrument drift', () => {
    expectsGate({
      ...validRecord(),
      arms: [
        candidateArm(),
        candidateArm({
          arm: 'red-r2fs',
          kind: 'control',
          rankEligible: false,
          expectedRedChecks: ['fsync-directory'],
          observedRedChecks: ['fsync-directory', 'rename-atomic'],
          semanticsPassed: false,
        }),
      ],
    }, 'G2', 'unexpected check "rename-atomic"');
  });

  test('a vanished red witness refuses as silent defect drift', () => {
    expectsGate({
      ...validRecord(),
      arms: [
        candidateArm(),
        candidateArm({
          arm: 'red-snapshot-seed',
          kind: 'control',
          rankEligible: false,
          expectedRedChecks: ['seed-not-pinned'],
          observedRedChecks: [],
          semanticsPassed: true,
        }),
      ],
    }, 'G2', 'expected failure that vanished');
  });

  test('G3 fault-cut evidence is required field by field for candidates', () => {
    expectsGate({
      ...validRecord(),
      publication: { ...validRecord().publication, faultCutCompleted: false },
    }, 'G3', 'fault-cut evidence');
    expectsGate({
      ...validRecord(),
      publication: { ...validRecord().publication, allOldOrAllNew: null },
    }, 'G3', 'all-old-or-all-new');
    expectsGate({
      ...validRecord(),
      publication: { ...validRecord().publication, barrierAckLoss: 2 },
    }, 'G3', 'barrier acknowledgement(s) were lost');
    expectsGate({
      ...validRecord(),
      publication: { ...validRecord().publication, absentReferences: 1 },
    }, 'G3', 'absent objects');
    expectsGate({
      ...validRecord(),
      publication: { ...validRecord().publication, rollbackOrPhantomRoot: true },
    }, 'G3', 'phantom root was observed');
  });

  test('G4 requires complete security cells and zero escapes of every class', () => {
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, securityCellsComplete: false },
    }, 'G4', 'security fault cells incomplete');
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, prefixEscapes: 1 },
    }, 'G4', 'key prefix');
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, capabilityEscapesOrReplays: 1 },
    }, 'G4', 'capability escape');
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, staleWriterAccepted: true },
    }, 'G4', 'superseded writer epoch');
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, hostileMetadataAccepted: true },
    }, 'G4', 'hostile metadata');
    expectsGate({
      ...validRecord(),
      security: { ...validRecord().security, credentialLeaks: ['token reached artifact'] },
    }, 'G4', 'token reached artifact');
  });

  test('G5 holds only candidate rows to the restore-class bar', () => {
    const withControl: StorageRunRecord = {
      ...validRecord(),
      arms: [
        ...validRecord().arms,
        candidateArm({
          arm: 'red-overlay', kind: 'control', rankEligible: false,
          expectedRedChecks: ['restore-class-unbounded'], observedRedChecks: ['restore-class-unbounded'],
        }),
      ],
      restore: [{
        arm: 'red-overlay', expected: true, work: null, claim: 'unbounded', mechanicalBoundVerified: false,
      }],
    };
    expect(evaluateRun(withControl).gates.find((row) => row.gate === 'G5')?.ok).toBe(true);

    // The same claim on a candidate refuses three ways.
    expectsGate({
      ...validRecord(),
      restore: [{ arm: 'candidate-a', expected: true, work: null, claim: 'unbounded', mechanicalBoundVerified: false }],
    }, 'G5', 'never exercised a restore');
    expectsGate({
      ...validRecord(),
      restore: [{
        arm: 'candidate-a', expected: true,
        work: { serialRemoteOps: 1, totalRemoteOps: 1, metadataBytes: 0, payloadBytes: 0, cpuSteps: 0, mounts: 0, replayUnits: 0 },
        claim: 'unbounded', mechanicalBoundVerified: false,
      }],
    }, 'G5', 'unbounded restore class');
    expectsGate({
      ...validRecord(),
      restore: [{
        arm: 'candidate-a', expected: true,
        work: { serialRemoteOps: 1, totalRemoteOps: 1, metadataBytes: 0, payloadBytes: 0, cpuSteps: 0, mounts: 0, replayUnits: 0 },
        claim: 'log-p', mechanicalBoundVerified: false,
      }],
    }, 'G5', 'never mechanically verified');
  });

  test('G3 and G4 are vacuous for a controls-only run but G2 witnesses still bite', () => {
    const controlsOnly: StorageRunRecord = {
      ...validRecord(),
      arms: [candidateArm({
        arm: 'red-control', kind: 'control', rankEligible: false,
        expectedRedChecks: ['witness'], observedRedChecks: ['witness'], semanticsPassed: false,
      })],
      publication: { ...validRecord().publication, faultCutCompleted: false },
      security: { ...validRecord().security, securityCellsComplete: false },
    };
    const verdict = evaluateRun(controlsOnly);
    expect(verdict.gates.find((row) => row.gate === 'G3')?.ok).toBe(true);
    expect(verdict.gates.find((row) => row.gate === 'G4')?.ok).toBe(true);
  });

  test('G6 refuses a declared matrix cell that did not complete', () => {
    expectsGate({ ...validRecord(), cells: [{ ...cell, completed: false }] }, 'G6', 'T0/C0/K0');
  });

  test('G7 refuses unknown accounting instead of reading it as zero', () => {
    expectsGate({
      ...validRecord(),
      accounting: { source: 'fixture /ops', calls: { put: 2, mystery: 1 }, classA: 2, classB: 1, classFree: 0, total: 3 },
    }, 'G7', 'unknown operation counter');
  });

  test('G8 judges each C-gate explicitly; no generic pass substitutes', () => {
    for (const [field, phrase] of [
      ['workerAbsent', 'C1'],
      ['runtimeAbsent', 'C2'],
      ['bucketAndMultipartEmpty', 'C3'],
      ['boxDurableStateEmpty', 'C4'],
      ['localSecretsProcessesAbsent', 'C5'],
      ['countersReconciled', 'C6'],
      ['replayIdempotent', 'C7'],
    ] as const) {
      expectsGate({
        ...validRecord(),
        cleanup: { ...cleanCleanup(), [field]: false },
      }, 'G8', phrase);
    }
    expectsGate({ ...validRecord(), cleanup: { ...cleanCleanup(), kept: true } }, 'G8', '--keep');
    expectsGate({
      ...validRecord(),
      cleanup: { ...cleanCleanup(), errors: ['bucket delete denied'] },
    }, 'G8', 'bucket delete denied');
    expectsGate({
      ...validRecord(),
      cleanup: { ...cleanCleanup(), multipartResidue: 1 },
    }, 'G8', 'multipart upload');
  });

  test('G9 censors noisy and over-budget cells rather than scoring them as zero', () => {
    expectsGate({
      ...validRecord(), deciding: [{ ...deciding, values: [1, 100], wallMs: 1_000 }],
    }, 'G9', 'CV');
    expectsGate({
      ...validRecord(), deciding: [{ ...deciding, wallMs: 2_001 }],
    }, 'G9', 'exceeded budget');
  });

  test('the refusal text names every failed gate rather than returning a winner-shaped fallback', () => {
    const verdict = evaluateRun({ ...validRecord(), accounting: null });
    expect(refusalText(verdict)).toContain('G7 Reconciled accounting.');
    expect(refusalText(verdict)).not.toContain('DEFAULT TO');
  });

  test('the frozen blank stage has exactly the one expected cell this fixture completes', () => {
    expect(expectedCells(['blank'], null)).toEqual([{ stage: 'blank', tree: 'T0', change: 'C0', cache: 'K0' }]);
  });
});

// ── the devbox run's own requirements on the shared gates ───────────────────
//
// `evaluateRun` judges a RECORD, and the record this driver used to hand it had
// `restore: []`, `declaredStages: []`, `cells: []` and `deciding: []`. Every one
// of those gates then passed VACUOUSLY — `restoreProblems` iterates an empty
// array, `completenessProblems` compares against `expectedCells([])`, and
// `censorProblems` guards its only run-level check behind `scored.length > 0` —
// so three of the ten gates could not fail at all. Its provenance was no better:
// `git rev-parse HEAD` cannot see uncommitted driver changes, both timestamps
// were synthesized from the calendar date one second apart, and `versions` held
// the container image under the `@cloudflare/sandbox` key.
//
// Each test below fixes one of those directions. G3 and G4 refuse throughout by
// design (this driver runs no fault-cut or security-cell instrumentation), so
// every assertion names its own gate rather than the whole verdict.

/** A run identity with every G0 field present and distinct. */
function fullIdentity(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return {
    commit: '3a115f232',
    dirtyDigest: 'clean',
    workerVersion: '0f0a1e2c-9a1b-4c3d-8e5f-6a7b8c9d0e1f',
    startedAt: '2026-08-30T10:00:00.000Z',
    finishedAt: '2026-08-30T10:41:00.000Z',
    image: SANDBOX_IMAGE,
    imageSha256: SANDBOX_IMAGE_DIGEST,
    dockerfileSha256: `sha256:${'a'.repeat(64)}`,
    candidateRunnerSha256: `sha256:${'b'.repeat(64)}`,
    overlayRunnerSha256: `sha256:${'c'.repeat(64)}`,
    journalDaemonSha256: `sha256:${'d'.repeat(64)}`,
    ...overrides,
  };
}

/** One probe run that measured the deciding metric once. Two of these are one
 *  arm's minimum repetition set. */
function probeRun(p50: number): ProbeRun {
  return {
    schema: 'r2-bench/probe@1',
    root: '/workspace/ab',
    seed: 20_260_824,
    loopBudgetMs: 8_000,
    phases: [{
      phase: 'small1k',
      status: 'ok',
      wallMs: 900,
      cpuUserMs: 120,
      cpuSystemMs: 40,
      metrics: [{ name: DECIDING_METRIC, summary: summarize([p50]), wallMs: 400 }],
      verdicts: [],
    }],
  };
}

/** The full ladder, sized from the driver's own expectation so a change to the
 *  ladder cannot leave this fixture asserting a stale count. */
const ladderRows = Array.from({ length: EXPECTED_LADDER_ROWS }, (_unused, index) => ({
  changeKiB: 64,
  kind: index % 2 === 0 ? 'quiesce' as const : 'tick' as const,
  ms: 120,
  bytes: 65_536,
  outcome: 'committed',
}));

/** An arm that completed everything this instrument asks of one. */
function measuredArm(strategy: Strategy, overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    strategy,
    box: `ab-${strategy}-20260830`,
    verifyPassed: true,
    verifyChecks: [{ name: 'the wake attached durable bytes', pass: true, detail: 'attached' }],
    attachColdMs: 4_200,
    attachColdKind: 'attached',
    attachColdBootId: `cold-${strategy}`,
    attachWarmMs: 90,
    attachWarmKind: 'attached',
    wakeBootId: `wake-${strategy}`,
    attachWarmBootId: `wake-${strategy}`,
    checkpoints: [...ladderRows],
    stopMs: 310,
    wakeMs: 5_100,
    wakeKind: 'attached',
    phases: [probeRun(1.10), probeRun(1.15)],
    decisiveTicks: [],
    quiescesBeforeDecisive: 3,
    decisiveQuiesces: 0,
    generationBeforeLadder: null,
    generationAfterLadder: null,
    treeBytes: {},
    ops: { calls: { put: 4, get: 2 }, classA: 4, classB: 2, classFree: 0, total: 6 },
    teardown: null,
    // A CANDIDATE PREREGISTERS NO WITNESS, so an empty list here is complete
    // evidence rather than a missing cell. Control arms carry the rows their
    // cells observed; `controlWitnessChecks` builds those.
    witnessChecks: [],
    notes: [],
    ...overrides,
  };
}

const CANDIDATE_ARMS: readonly Strategy[] = ['bounded-layers', 'merkle-pack'];

function devboxVerdict(
  arms: readonly ArmResult[],
  requested: readonly Strategy[] = CANDIDATE_ARMS,
  identity: RunIdentity = fullIdentity(),
  /** What `--repetitions` asked for. Two by default, which is what a decisive
   *  run asks for and the fewest G9 will score. */
  repetitions = 2,
): AdmissionVerdict {
  return devboxAdmission({
    arms,
    requested,
    repetitions,
    identity,
    meta: {
      date: '2026-08-30',
      run: 'kinu-devbox-bench-20260830',
      worker: 'kinu-devbox-bench-20260830-bounded-layers, kinu-devbox-bench-20260830-merkle-pack',
      bucket: 'kinu-devbox-bench-20260830-bounded-layers, kinu-devbox-bench-20260830-merkle-pack',
      image: SANDBOX_IMAGE,
      seed: '20260824',
      'loop budget ms': '8000',
      'deciding repetitions': String(repetitions),
    },
    token: 'devbox-test-token',
    cleanup: cleanCleanup(),
  });
}

function gateReasons(verdict: AdmissionVerdict, gate: GateId): string {
  return verdict.gates.find((row) => row.gate === gate)?.reasons.join(' | ') ?? '(gate absent)';
}

function gateHeld(verdict: AdmissionVerdict, gate: GateId): boolean {
  return verdict.gates.find((row) => row.gate === gate)?.ok === true;
}

/** The complete two-candidate run every test below degrades one field of. */
const completeArms = (): ArmResult[] => CANDIDATE_ARMS.map((strategy) => measuredArm(strategy));

describe('the devbox run\'s own admission requirements', () => {
  test('a complete run holds G0, G6, G7 and G9, so the refusals below are discriminating', () => {
    const verdict = devboxVerdict(completeArms());
    for (const gate of ['G0', 'G1', 'G2', 'G6', 'G7', 'G8', 'G9'] as const) {
      expect(gateHeld(verdict, gate), `${gate}: ${gateReasons(verdict, gate)}`).toBe(true);
    }
    // Still not admitted, and for the honest reasons: no fault-cut cells, no
    // security cells, and no counted restore anywhere in this instrument.
    expect(verdict.admitted).toBe(false);
    for (const gate of ['G3', 'G4', 'G5'] as const) expect(gateHeld(verdict, gate)).toBe(false);
  });
  test('G0 refuses every identity field on its own rather than defaulting it', () => {
    const blanked: readonly [keyof RunIdentity, string][] = [
      ['commit', 'source'],
      ['workerVersion', 'worker-version'],
      ['image', 'container-image'],
      ['imageSha256', 'container-image-digest'],
      ['dockerfileSha256', 'candidate-image-dockerfile'],
      ['candidateRunnerSha256', 'candidate-runner-bundle'],
      ['overlayRunnerSha256', 'overlay-cas-runner-bundle'],
      ['journalDaemonSha256', 'journal-daemon-source'],
      ['dirtyDigest', 'source-tree'],
    ];
    for (const [field, recorded] of blanked) {
      const verdict = devboxVerdict(completeArms(), CANDIDATE_ARMS, fullIdentity({ [field]: '' }));
      expect(gateHeld(verdict, 'G0'), field).toBe(false);
      expect(gateReasons(verdict, 'G0')).toContain(`no ${recorded}`);
    }
  });

  test('G0 refuses a dirty-tree digest that is neither `clean` nor a digest', () => {
    const verdict = devboxVerdict(
      completeArms(),
      CANDIDATE_ARMS,
      fullIdentity({ dirtyDigest: 'dirty' }),
    );
    expect(gateReasons(verdict, 'G0')).toContain('neither `clean` nor a digest');
  });

  test('G0 refuses a tag-only image or a malformed image digest', () => {
    const tagged = devboxVerdict(
      completeArms(),
      CANDIDATE_ARMS,
      fullIdentity({ image: 'docker.io/cloudflare/sandbox:0.12.8' }),
    );
    expect(gateReasons(tagged, 'G0')).toContain('is not pinned to');

    const malformed = devboxVerdict(
      completeArms(),
      CANDIDATE_ARMS,
      fullIdentity({ imageSha256: 'sha256:not-a-digest' }),
    );
    expect(gateReasons(malformed, 'G0')).toContain('is not a sha256 digest');
  });

  test('G0 refuses the synthesized one-second window the artifact used to carry', () => {
    const verdict = devboxVerdict(completeArms(), CANDIDATE_ARMS, fullIdentity({
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:00:00.000Z',
    }));
    expect(gateReasons(verdict, 'G0')).toContain('no run was timed');
  });

  test('G5 refuses every requested arm for an uncounted restore instead of passing an empty array', () => {
    const verdict = devboxVerdict(completeArms());
    expect(gateHeld(verdict, 'G5')).toBe(false);
    // The refusal names the missing source per field, not the old blanket
    // sentence: an arm whose bracket never landed says which bill is missing.
    for (const strategy of CANDIDATE_ARMS) {
      expect(gateReasons(verdict, 'G5')).toContain(`arm \`${strategy}\` totalRemoteOps: the wake-window /ops bracket never landed`);
    }
    expect(gateReasons(verdict, 'G5')).toContain('no live byte counter');
  });

  test('G6 refuses a cold attach past the admission ceiling, whatever the fixture budget allows', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { attachColdMs: COLD_ATTACH_CEILING_MS + 1 }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateHeld(verdict, 'G6')).toBe(false);
    expect(gateReasons(verdict, 'G6')).toContain(`past the ${COLD_ATTACH_CEILING_MS} ms admission ceiling`);
    // The declared cell is incomplete for the same reason, rather than being
    // scored as a fast arm.
    expect(gateReasons(verdict, 'G6')).toContain('T0/C0/K0');
  });

  test('G6 accepts a cold attach exactly at the ceiling', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { attachColdMs: COLD_ATTACH_CEILING_MS }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateHeld(verdict, 'G6'), gateReasons(verdict, 'G6')).toBe(true);
  });

  test('G6 refuses missing cold evidence and a warm attach that changed generation', () => {
    const noCold = devboxVerdict([
      measuredArm('bounded-layers', { attachColdMs: null }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(noCold, 'G6')).toContain('recorded no cold attach');

    const wrongKind = devboxVerdict([
      measuredArm('bounded-layers', { attachWarmKind: 'empty' }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(wrongKind, 'G6')).toContain('did not observe the unchanged generation');

    // `attached` alone is not evidence of unchanged state: a replacement can
    // restore successfully and still report that kind. The boot ids prove this
    // warm probe observed the generation wake had already attached.
    const replaced = devboxVerdict([
      measuredArm('bounded-layers', { attachWarmBootId: 'replacement-generation' }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(replaced, 'G6')).toContain('warm attach changed generation');

    const unrecorded = devboxVerdict([
      measuredArm('bounded-layers', { wakeBootId: null, attachWarmBootId: null }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(unrecorded, 'G6')).toContain('unchanged attach was not evidenced');
  });

  test('G6 refuses a short checkpoint ladder rather than completing the cell anyway', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { checkpoints: ladderRows.slice(0, EXPECTED_LADDER_ROWS - 1) }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(verdict, 'G6')).toContain(
      `recorded ${EXPECTED_LADDER_ROWS - 1} of ${EXPECTED_LADDER_ROWS} ladder checkpoints`,
    );
  });

  test('G7 refuses an arm with no tally instead of summing only the arms that reported one', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers'),
      measuredArm('merkle-pack', { ops: null }),
    ]);
    expect(gateHeld(verdict, 'G7')).toBe(false);
    expect(gateReasons(verdict, 'G7')).toContain('arm `merkle-pack` recorded no `/ops` tally');
    // And the summed row is withheld entirely, so the shared gate cannot price
    // the run off a partial total either.
    expect(gateReasons(verdict, 'G7')).toContain('no operation accounting at all');
  });

  test('G7 refuses a tally carrying no total', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { ops: { calls: { put: 1 }, classA: 1, classB: 0, classFree: 0 } }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(verdict, 'G7')).toContain('reported a tally carrying no total');
  });

  test('G9 refuses one deciding repetition instead of scoring an unrepeated median as stable', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { phases: [probeRun(1.10)] }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateHeld(verdict, 'G9')).toBe(false);
    expect(gateReasons(verdict, 'G9')).toContain(
      `measured the deciding metric \`${DECIDING_METRIC}\` 1 time(s)`,
    );
  });

  test('two repetitions of the deciding cell hold G9, and one still refuses it', () => {
    // WHAT `--repetitions` BUYS, and the whole of it. Every arm of run
    // 20260902154130 measured the deciding metric once or not at all, so every
    // deciding cell was censored and no statistical claim survived — and the
    // driver had no way to ask for a second pass. Two repetitions per arm is
    // what a decisive run now asks for, and this is the pair of directions
    // that makes the count load-bearing rather than decorative.
    const twice = devboxVerdict(
      [
        measuredArm('bounded-layers', { phases: [probeRun(1.10), probeRun(1.15)] }),
        measuredArm('merkle-pack', { phases: [probeRun(1.20), probeRun(1.24)] }),
      ],
      CANDIDATE_ARMS,
      fullIdentity(),
      2,
    );
    expect(gateHeld(twice, 'G9'), gateReasons(twice, 'G9')).toBe(true);

    const once = devboxVerdict(
      [
        measuredArm('bounded-layers', { phases: [probeRun(1.10)] }),
        measuredArm('merkle-pack', { phases: [probeRun(1.20)] }),
      ],
      CANDIDATE_ARMS,
      fullIdentity(),
      1,
    );
    expect(gateHeld(once, 'G9')).toBe(false);
    expect(gateReasons(once, 'G9')).toContain('fewer than two repetitions');
  });

  test('G9 refuses an arm that measured fewer repetitions than the run asked for', () => {
    // A run that asked for two and got one LOST a repetition. The floor check
    // alone would report the survivor as the whole intent, so the count the
    // driver asked for is fed to admission and named in the refusal.
    const verdict = devboxVerdict(
      [
        measuredArm('bounded-layers', { phases: [probeRun(1.10), probeRun(1.15), probeRun(1.12)] }),
        measuredArm('merkle-pack', { phases: [probeRun(1.20), probeRun(1.24)] }),
      ],
      CANDIDATE_ARMS,
      fullIdentity(),
      3,
    );
    expect(gateHeld(verdict, 'G9')).toBe(false);
    expect(gateReasons(verdict, 'G9')).toContain('2 time(s) where the run asked for 3');
    // And the arm that produced all three is not named by that refusal.
    expect(gateReasons(verdict, 'G9')).not.toContain('`bounded-layers` measured the deciding metric');
  });

  test('G9 refuses an arm that measured the deciding metric not at all', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { phases: [] }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateReasons(verdict, 'G9')).toContain('0 time(s)');
  });

  test('G9 censors dispersed repetitions rather than ranking their midpoint', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', { phases: [probeRun(1), probeRun(100)] }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateHeld(verdict, 'G9')).toBe(false);
    expect(gateReasons(verdict, 'G9')).toContain('CV');
  });

  test('G5, G6 and G9 each refuse an arm set that is not exactly the requested one', () => {
    const lost = devboxVerdict([measuredArm('bounded-layers')]);
    for (const gate of ['G5', 'G6', 'G9'] as const) {
      expect(gateReasons(lost, gate)).toContain(
        'arm `merkle-pack` was requested but contributed no result row',
      );
    }

    const extra = devboxVerdict([...completeArms(), measuredArm('overlay-cas')], CANDIDATE_ARMS);
    for (const gate of ['G5', 'G6', 'G9'] as const) {
      expect(gateReasons(extra, gate)).toContain(
        'arm `overlay-cas` produced a result row without being requested',
      );
    }

    const duplicate = devboxVerdict(
      [...completeArms(), measuredArm('bounded-layers')],
      CANDIDATE_ARMS,
    );
    for (const gate of ['G5', 'G6', 'G9'] as const) {
      expect(gateReasons(duplicate, gate)).toContain(
        'arm `bounded-layers` produced 2 result rows but was requested 1 time(s)',
      );
    }

    const none = devboxVerdict([], []);
    for (const gate of ['G5', 'G6', 'G9'] as const) {
      expect(gateReasons(none, gate)).toContain('no expected arm set to complete');
    }
  });

  test('an arm whose lifecycle proof failed cannot complete the declared cell', () => {
    const verdict = devboxVerdict([
      measuredArm('bounded-layers', {
        verifyPassed: false,
        verifyChecks: [{
          name: 'the work directory is the journal daemon\'s FUSE mount',
          pass: false,
          detail: '/workspace is not mounted',
        }],
      }),
      measuredArm('merkle-pack'),
    ]);
    expect(gateHeld(verdict, 'G6')).toBe(false);
    expect(gateReasons(verdict, 'G6')).toContain('T0/C0/K0');
    expect(refusalText(verdict)).toContain('G6 Complete cells.');
  });
});
