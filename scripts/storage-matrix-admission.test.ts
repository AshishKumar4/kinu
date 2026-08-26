import { describe, expect, test } from 'bun:test';
import {
  evaluateRun, expectedCells, refusalText, requireAdmitted,
  type ArmEvidence, type CleanupEvidence, type StorageRunRecord,
} from './fixtures/storage-matrix/admission';
import { type CellCompletion } from './fixtures/storage-matrix/admission';
import { type MeasuredCell } from './fixtures/storage-matrix/protocol';
import { devboxArmEvidence } from './bench-devbox-strategies';

const cell: CellCompletion = { stage: 'blank', tree: 'T0', change: 'C0', cache: 'K0', completed: true };
const deciding: MeasuredCell = { id: cell, values: [100, 105], wallMs: 1_000 };

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

  test('a current-only devbox run cannot recommend: shipped arms are controls whose cells have not run', () => {
    const record: StorageRunRecord = {
      ...validRecord(),
      arms: (['snapshot-chain', 'r2fs', 'overlay-cas'] as const).map((strategy) => devboxArmEvidence({
        strategy,
        verifyPassed: true,
        verifyChecks: [],
        phases: [],
        checkpoints: [],
        decisiveTicks: [],
      })),
    };
    const verdict = evaluateRun(record);
    expect(verdict.admitted).toBe(false);
    const g2 = verdict.gates.find((row) => row.gate === 'G2');
    expect(g2?.reasons.join(' ')).toContain('expected failure that vanished');
    expect(() => requireAdmitted(verdict)).toThrow('RECOMMENDATION REFUSED');
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
