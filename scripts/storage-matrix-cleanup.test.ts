import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  checkCleanup, createManifest, loadManifest, manifestPath, reconcileCounters,
  replayTeardown, writeManifest, type CleanupProbes, type TeardownManifest,
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
