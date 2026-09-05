/**
 * Scoped proof for the driver half of the G4 security fault cells.
 *
 * Covers the wire contract (`POST /security`), the run-level fold into
 * {@link SecurityEvidence}, and the redaction invariant: no secret value
 * ever appears in a leak description, a note, or a request body.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import {
  evaluateRun,
  type StorageRunRecord,
} from '../../storage-matrix/admission';

import {
  runSecurityFaultCells,
  securityExclusion,
  summarizeSecurity,
  type SecurityCellsObservation,
} from './cells';

const SECRET = 'fixture-secret-live-xyz-123';

function observation(overrides: Partial<SecurityCellsObservation> = {}): SecurityCellsObservation {
  const refused = (id: 'F7' | 'F10' | 'F11' | 'F12') => ({ id, status: 'refused' as const, detail: `${id} refused` });
  return {
    strategy: 'bounded-layers',
    completed: true,
    cells: [refused('F7'), refused('F10'), refused('F11'), refused('F12')],
    staleWriterAccepted: false,
    hostileMetadataAccepted: false,
    prefixEscapes: 0,
    capabilityEscapesOrReplays: 0,
    credentialLeaks: [],
    cleanupErrors: [],
    ...overrides,
  };
}

function recordWithSecurity(security: ReturnType<typeof summarizeSecurity>): StorageRunRecord {
  return {
    schema: 'storage-matrix/run@1',
    provenance: {
      runId: 'run-1', commit: '3a115f232',
      startedAt: '2026-08-25T10:00:00.000Z', finishedAt: '2026-08-25T10:01:00.000Z',
      seed: '17', image: 'docker.io/cloudflare/sandbox:0.12.8',
      versions: { '@cloudflare/sandbox': '0.12.8' }, containerFacts: 'Linux fixture 6.0',
    },
    arms: [{
      arm: 'candidate-a', kind: 'candidate', rankEligible: true,
      expectedRedChecks: [], observedRedChecks: [], attachedVerified: true,
      semanticsPassed: true, failedChecks: [], producedMeasurements: true,
    }],
    publication: {
      readOnlyDeclared: false, readOnlyRefusedWrites: null, faultCutCompleted: true,
      allOldOrAllNew: true, barrierAckLoss: 0, absentReferences: 0, rollbackOrPhantomRoot: false,
    },
    security,
    restore: [],
    declaredStages: ['blank'],
    cells: [{ stage: 'blank', tree: 'T0', change: 'C0', cache: 'K0', completed: true }],
    confirmatoryPlan: null,
    accounting: {
      source: 'fixture /ops', calls: { put: 2, get: 1 }, classA: 2, classB: 1, classFree: 0, total: 3,
    },
    cleanup: {
      attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
      bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
      localSecretsProcessesAbsent: true, countersReconciled: true,
      replayIdempotent: true, multipartResidue: 0, errors: [],
    },
    deciding: [{ id: { stage: 'blank', tree: 'T0', change: 'C0', cache: 'K0' }, values: [100, 105], wallMs: 1_000 }],
    decidingBudgetMs: 2_000,
  };
}

describe('security exclusions', () => {
  test('the decisive three are never excluded', () => {
    for (const strategy of ['snapshot-chain', 'bounded-layers', 'merkle-pack']) {
      expect(securityExclusion(strategy)).toBeUndefined();
    }
  });

  test('r2fs and overlay-cas are unable with prose, not silent', () => {
    for (const strategy of ['r2fs', 'overlay-cas']) {
      const reason = securityExclusion(strategy);
      if (reason === undefined) throw new Error(`expected exclusion prose for ${strategy}`);
      expect(reason.length).toBeGreaterThan(80);
    }
  });
});

describe('summarizeSecurity', () => {
  test('three refused arms complete the cells and hold G4', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: observation({ strategy: 'snapshot-chain' }) },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.securityCellsComplete).toBe(true);
    expect(security.prefixEscapes).toBe(0);
    expect(security.capabilityEscapesOrReplays).toBe(0);
    expect(security.staleWriterAccepted).toBe(false);
    expect(security.hostileMetadataAccepted).toBe(false);
    expect(security.credentialLeaks).toEqual([]);
    const verdict = evaluateRun(recordWithSecurity(security));
    expect(verdict.gates.find((gate) => gate.gate === 'G4')?.ok).toBe(true);
  });

  test('an unable arm refuses G4 rather than passing on zeros', () => {
    const unable: SecurityCellsObservation = {
      ...observation({ strategy: 'snapshot-chain' }),
      completed: false,
      cells: observation().cells.map((cell) => cell.id === 'F7'
        ? { ...cell, status: 'unable' as const, detail: 'no epoch to fence' }
        : cell),
    };
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: unable },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.securityCellsComplete).toBe(false);
    const verdict = evaluateRun(recordWithSecurity(security));
    const g4 = verdict.gates.find((gate) => gate.gate === 'G4');
    expect(g4?.ok).toBe(false);
    expect(g4?.reasons.join(' ')).toMatch(/incomplete/);
  });

  test('a missing arm refuses G4 rather than voting clean', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: null },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.securityCellsComplete).toBe(false);
  });

  test('an accepted stale writer fails G4 naming the epoch', () => {
    const security = summarizeSecurity({
      rows: [
        {
          strategy: 'snapshot-chain',
          observation: observation({ strategy: 'snapshot-chain', completed: false, staleWriterAccepted: true }),
        },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    const verdict = evaluateRun(recordWithSecurity(security));
    const g4 = verdict.gates.find((gate) => gate.gate === 'G4');
    expect(g4?.ok).toBe(false);
    expect(g4?.reasons.join(' ')).toMatch(/superseded writer epoch/);
  });

  test('an accepted hostile metadata fails G4', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: observation({ strategy: 'snapshot-chain' }) },
        {
          strategy: 'bounded-layers',
          observation: observation({ strategy: 'bounded-layers', completed: false, hostileMetadataAccepted: true }),
        },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    const verdict = evaluateRun(recordWithSecurity(security));
    expect(verdict.gates.find((gate) => gate.gate === 'G4')?.ok).toBe(false);
  });

  test('prefix and capability escapes sum and fail G4', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: observation({ strategy: 'snapshot-chain', completed: false, prefixEscapes: 2 }) },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers', completed: false, capabilityEscapesOrReplays: 1 }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.prefixEscapes).toBe(2);
    expect(security.capabilityEscapesOrReplays).toBe(1);
    expect(verdictG4Ok(security)).toBe(false);
  });

  test('excluded arms do not vote: r2fs and overlay-cas contribute nothing', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: observation({ strategy: 'snapshot-chain' }) },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
        { strategy: 'r2fs', observation: null },
        { strategy: 'overlay-cas', observation: null },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.securityCellsComplete).toBe(true);
  });

  test('a leaked fixture secret is reported without echoing it', () => {
    const security = summarizeSecurity({
      rows: [
        { strategy: 'snapshot-chain', observation: observation({ strategy: 'snapshot-chain' }) },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: `run output contains ${SECRET} verbatim`,
    });
    expect(security.credentialLeaks.length).toBeGreaterThan(0);
    for (const leak of security.credentialLeaks) expect(leak).not.toContain(SECRET);
    expect(verdictG4Ok(security)).toBe(false);
  });

  test('worker leak descriptions ride through without values', () => {
    const security = summarizeSecurity({
      rows: [
        {
          strategy: 'snapshot-chain',
          observation: observation({
            strategy: 'snapshot-chain', completed: false,
            credentialLeaks: ['F12: live fixture secret present in a scanned surface'],
          }),
        },
        { strategy: 'bounded-layers', observation: observation({ strategy: 'bounded-layers' }) },
        { strategy: 'merkle-pack', observation: observation({ strategy: 'merkle-pack' }) },
      ],
      token: SECRET,
      driverText: 'no secrets here',
    });
    expect(security.credentialLeaks).toEqual(['F12: live fixture secret present in a scanned surface']);
    expect(verdictG4Ok(security)).toBe(false);
  });
});

function verdictG4Ok(security: ReturnType<typeof summarizeSecurity>): boolean {
  const verdict = evaluateRun(recordWithSecurity(security));
  return verdict.gates.find((gate) => gate.gate === 'G4')?.ok === true;
}

describe('runSecurityFaultCells wire', () => {
  test('parses a live-shaped reply and never sends the token in the body', async () => {
    const obs = observation({ strategy: 'merkle-pack' });
    const real = globalThis.fetch;
    const seenUrls: string[] = [];
    const seenAuthorizations: Array<string | null> = [];
    const seenBodies: string[] = [];
    const answer = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      seenUrls.push(String(input));
      const parsedBody = v.safeParse(v.string(), init?.body);
      const parsedAuth = v.safeParse(v.looseObject({ authorization: v.string() }), init?.headers);
      seenAuthorizations.push(parsedAuth.success ? parsedAuth.output.authorization : null);
      seenBodies.push(parsedBody.success ? parsedBody.output : '');
      return new Response(JSON.stringify({ ok: true, strategy: 'merkle-pack', box: 'ab-x', security: obs, ms: 12 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    try {
      const { observation: parsed, notes } = await runSecurityFaultCells(
        { origin: 'https://bench.invalid', token: SECRET },
        'ab-x',
        'merkle-pack',
        'sec-12345678',
      );
      expect(parsed.completed).toBe(true);
      expect(parsed.cleanupErrors).toEqual([]);
      expect(notes.length).toBe(4);
      expect(seenUrls).toEqual(['https://bench.invalid/security?box=ab-x']);
      expect(seenAuthorizations).toEqual([`Bearer ${SECRET}`]);
      expect(seenBodies).toHaveLength(1);
      for (const body of seenBodies) expect(body).not.toContain(SECRET);
      expect(JSON.stringify(parsed)).not.toContain(SECRET);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('a refused route throws carrying the wire reason', async () => {
    const real = globalThis.fetch;
    const answer = async (): Promise<Response> => new Response(
      JSON.stringify({ ok: false, error: 'strategy not deployed in this run' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    try {
      await expect(runSecurityFaultCells(
        { origin: 'https://bench.invalid', token: SECRET }, 'ab-x', 'r2fs', 'sec-12345678',
      )).rejects.toThrow(/strategy not deployed/);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('a contract-breaking reply throws rather than defaulting', async () => {
    const real = globalThis.fetch;
    const answer = async (): Promise<Response> => new Response(
      JSON.stringify({ ok: true, strategy: 'merkle-pack', box: 'ab-x', security: { strategy: 'merkle-pack' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    try {
      await expect(runSecurityFaultCells(
        { origin: 'https://bench.invalid', token: SECRET }, 'ab-x', 'merkle-pack', 'sec-12345678',
      )).rejects.toThrow(/reply contract/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
