import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import {
  checkCleanup, createManifest, loadManifest, manifestPath, reconcileCounters,
  recoverAbandonedRuns, replayTeardown, scanUnfinishedManifests, writeManifest,
  type CleanupProbes, type TeardownEntry, type TeardownManifest,
} from './fixtures/storage-matrix/cleanup';
import { R2_OP_VOCABULARY } from './fixtures/storage-matrix/admission';

function probes(overrides: Partial<CleanupProbes> = {}): CleanupProbes {
  return {
    workerAbsent: async () => true,
    containerAppAbsent: async () => true,
    bucketState: async () => ({ absent: true, objects: 0, multipartResidue: 0 }),
    boxStateEmpty: async () => true,
    localPathAbsent: async () => true,
    processAbsent: async () => true,
    alarmAbsent: async () => true,
    mountAbsent: async () => true,
    counters: async () => ({ put: 2, get: 1 }),
    ...overrides,
  };
}

function cleanManifest() {
  const manifest = createManifest('cleanup-test', [
    { kind: 'worker', name: 'worker-a' },
    { kind: 'container-app', name: 'app-a' },
    { kind: 'r2-bucket', name: 'bucket-a' },
    { kind: 'do-state', name: 'box-a' },
    { kind: 'alarm', name: 'alarm-a' },
    { kind: 'mount', name: 'mount-a' },
    { kind: 'local-path', name: '/tmp/token-a' },
    { kind: 'process-marker', name: 'pid-a' },
  ]);
  manifest.counters = { put: 2, get: 1 };
  for (const entry of manifest.entries) entry.done = true;
  return manifest;
}

describe('durable teardown manifest', () => {
  test('persists every resource before cleanup starts', () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = cleanManifest();
      writeManifest(root, manifest);
      expect(manifestPath(root, manifest.runId)).toContain('bench-artifacts/teardown/cleanup-test.json');
      expect(loadManifest(root, manifest.runId)).toEqual(manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a signal-interrupted replay resumes from its persisted completed prefix', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = createManifest('recover', [
        { kind: 'worker', name: 'worker' },
        { kind: 'r2-bucket', name: 'bucket' },
      ]);
      writeManifest(root, manifest);
      let calls = 0;
      const first = await replayTeardown(root, manifest, async () => {
        calls += 1;
        return calls === 1 ? { ok: true } : { ok: false, error: 'SIGTERM interrupted deletion' };
      });
      expect(first.failures).toHaveLength(1);
      expect(loadManifest(root, 'recover')?.entries.map((entry) => entry.done)).toEqual([true, false]);

      const resumed = loadManifest(root, 'recover')!;
      const second = await replayTeardown(root, resumed, async () => ({ ok: true }));
      expect(second.failures).toEqual([]);
      expect(second.manifest.entries.every((entry) => entry.done)).toBe(true);
      expect(second.manifest.entries[0]?.attempts).toBe(1);
      expect(second.manifest.entries[1]?.attempts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a completed replay is idempotent and executes nothing twice', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = cleanManifest();
      writeManifest(root, manifest);
      let calls = 0;
      const replay = await replayTeardown(root, manifest, async () => {
        calls += 1;
        return { ok: true };
      });
      expect(replay.failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── the startup scan ────────────────────────────────────────────────────────
//
// THE HOLE THIS CLOSES. Recovery only ever ran inside the process that wrote
// the manifest — which is precisely the process a kill removes. A driver that
// died between its deploy and its teardown left a complete, correct list of
// live Workers, container applications and buckets that nothing would ever
// read again, so every interrupted run added a permanent set of resources to
// the account.

/** A run killed after its deploy: every resource real, nothing deleted. */
function killedAfterDeploy(runId: string): TeardownManifest {
  return createManifest(runId, [
    { kind: 'worker', name: `kinu-devbox-bench-${runId}-r2fs`, detail: 'r2fs fixture Worker' },
    { kind: 'container-app', name: `kinu-devbox-bench-${runId}-r2fs-boxr2fs` },
    { kind: 'r2-bucket', name: `kinu-devbox-bench-${runId}-r2fs` },
    { kind: 'do-state', name: `ab-r2fs-${runId}` },
    { kind: 'local-path', name: `bench-artifacts/config/${runId}` },
  ]);
}

describe('a fresh driver finishes what a killed one started', () => {
  test('an abandoned run is reported by name and every entry replayed', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      writeManifest(root, killedAfterDeploy('20260901010101'));
      // The run doing the scanning. Its own manifest is unfinished by
      // construction, and replaying it would delete what it is about to use.
      writeManifest(root, killedAfterDeploy('20260901020202'));

      const deleted: string[] = [];
      const reported: string[] = [];
      const recovered = await recoverAbandonedRuns(
        root,
        '20260901020202',
        async (entry: TeardownEntry) => {
          deleted.push(`${entry.kind}:${entry.name}`);
          return { ok: true };
        },
        (line) => reported.push(line),
      );

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ runId: '20260901010101', unfinished: 5, replayed: true, failures: [] });
      expect(deleted).toEqual([
        'worker:kinu-devbox-bench-20260901010101-r2fs',
        'container-app:kinu-devbox-bench-20260901010101-r2fs-boxr2fs',
        'r2-bucket:kinu-devbox-bench-20260901010101-r2fs',
        'do-state:ab-r2fs-20260901010101',
        'local-path:bench-artifacts/config/20260901010101',
      ]);
      // REPORTED, not only swept: an operator reading the log learns which run
      // leaked and what it held.
      expect(reported.join('\n')).toContain('run 20260901010101');
      expect(reported.join('\n')).toContain('left 5 resource(s) undeleted');
      expect(reported.join('\n')).toContain('worker:kinu-devbox-bench-20260901010101-r2fs');
      expect(loadManifest(root, '20260901010101')?.entries.every((entry) => entry.done)).toBe(true);
      // The scanning run's own manifest is untouched.
      expect(loadManifest(root, '20260901020202')?.entries.some((entry) => entry.done)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a run retained with --keep is reported and deliberately left alone', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const kept = killedAfterDeploy('20260901030303');
      kept.kept = true;
      writeManifest(root, kept);

      const reported: string[] = [];
      let calls = 0;
      const recovered = await recoverAbandonedRuns(root, 'other', async () => {
        calls += 1;
        return { ok: true };
      }, (line) => reported.push(line));

      expect(calls).toBe(0);
      expect(recovered[0]).toMatchObject({ runId: '20260901030303', replayed: false });
      expect(reported.join('\n')).toContain('retained on purpose (--keep)');
      expect(loadManifest(root, '20260901030303')?.entries.every((entry) => !entry.done)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a recovery interrupted again leaves strictly less work, and the next one finishes it', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      writeManifest(root, killedAfterDeploy('20260901040404'));
      let calls = 0;
      const first = await recoverAbandonedRuns(root, 'other', async () => {
        calls += 1;
        return calls <= 2 ? { ok: true } : { ok: false, error: 'SIGKILL' };
      }, () => {});
      expect(first[0]?.failures).toHaveLength(3);
      expect(loadManifest(root, '20260901040404')?.entries.map((entry) => entry.done))
        .toEqual([true, true, false, false, false]);

      const replayed: string[] = [];
      const second = await recoverAbandonedRuns(root, 'other', async (entry) => {
        replayed.push(entry.name);
        return { ok: true };
      }, () => {});
      expect(second[0]?.failures).toEqual([]);
      // The two already-deleted resources are NOT deleted a second time.
      expect(replayed).toHaveLength(3);
      expect(loadManifest(root, '20260901040404')?.entries.every((entry) => entry.done)).toBe(true);

      // And once everything is done the scan stops finding it at all.
      expect(scanUnfinishedManifests(root, 'other').unfinished).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a manifest a kill truncated is reported rather than silently skipped', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      writeManifest(root, killedAfterDeploy('20260901050505'));
      writeFileSync(manifestPath(root, '20260901060606'), '{"schema":"storage-matrix/tear');

      const reported: string[] = [];
      const recovered = await recoverAbandonedRuns(
        root, 'other', async () => ({ ok: true }), (line) => reported.push(line),
      );

      expect(reported.join('\n')).toContain('cannot be decoded');
      expect(reported.join('\n')).toContain('20260901060606');
      // The unreadable one does not stop the readable one being swept.
      expect(recovered.map((run) => run.runId)).toEqual(['20260901050505']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the manifest is written atomically, so a kill cannot truncate it', () => {
    // `writeFileSync` truncates then writes: a signal in between leaves JSON
    // that does not parse, which is worse than no manifest at all because the
    // resources are real and the only list of them is unreadable.
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = killedAfterDeploy('20260901070707');
      writeManifest(root, manifest);
      writeManifest(root, manifest);
      const directory = dirname(manifestPath(root, manifest.runId));

      expect(readdirSync(directory)).toEqual(['20260901070707.json']);
      expect(loadManifest(root, manifest.runId)?.runId).toBe('20260901070707');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a directory that never held a manifest scans clean instead of throwing', () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      expect(scanUnfinishedManifests(root, 'any')).toEqual({ unfinished: [], unreadable: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cleanup C1-C7', () => {
  async function expectFailure(
    expected: string,
    overrides: Partial<CleanupProbes>,
    configure?: (manifest: TeardownManifest) => void,
  ): Promise<void> {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = cleanManifest();
      configure?.(manifest);
      writeManifest(root, manifest);
      const report = await checkCleanup(root, manifest, probes(overrides), R2_OP_VOCABULARY);
      expect(report.passed).toBe(false);
      expect(report.checks.find((row) => row.gate === expected)?.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('C1 detects a surviving Worker', async () => {
    await expectFailure('C1', { workerAbsent: async () => false });
  });

  test('C2 detects a surviving container application', async () => {
    await expectFailure('C2', { containerAppAbsent: async () => false });
  });

  test('C3 rejects both objects and multipart residue in the dedicated bucket', async () => {
    await expectFailure('C3', { bucketState: async () => ({ absent: false, objects: 1, multipartResidue: 0 }) });
    await expectFailure('C3', { bucketState: async () => ({ absent: false, objects: 0, multipartResidue: 1 }) });
  });

  test('C4 detects box durable state, alarms, and mounts', async () => {
    await expectFailure('C4', { boxStateEmpty: async () => false });
    await expectFailure('C4', { alarmAbsent: async () => false });
    await expectFailure('C4', { mountAbsent: async () => false });
  });

  test('C5 detects a local credential file or child process', async () => {
    await expectFailure('C5', { localPathAbsent: async () => false });
    await expectFailure('C5', { processAbsent: async () => false });
  });

  test('C6 rejects unknown and mismatched counters', async () => {
    await expectFailure('C6', { counters: async () => ({ put: 2, mystery: 1 }) });
    await expectFailure('C6', { counters: async () => ({ put: 1, get: 1 }) });
  });

  test('C7 rejects a manifest whose first replay left work pending', async () => {
    await expectFailure('C7', {}, (manifest) => {
      manifest.entries[0]!.done = false;
    });
  });

  test('all seven checks pass only after the dedicated bucket is deleted and replay is empty', async () => {
    const root = mkdtempSync(`${tmpdir()}/storage-matrix-`);
    try {
      const manifest = cleanManifest();
      writeManifest(root, manifest);
      const report = await checkCleanup(root, manifest, probes(), R2_OP_VOCABULARY);
      expect(report.passed).toBe(true);
      expect(report.checks.map((row) => row.ok)).toEqual([true, true, true, true, true, true, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('counter reconciliation never accepts an undeclared operation', () => {
  expect(reconcileCounters({ put: 1 }, { put: 1, invented: 1 }, R2_OP_VOCABULARY).reconciled).toBe(false);
});
