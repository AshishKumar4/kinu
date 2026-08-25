import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  durabilityArtifactPath, persistDurabilityArtifact,
  type DurabilityProbeArtifact,
} from './sandbox-durability-probe';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('sandbox durability evidence', () => {
  test('persists the complete deployed-run record outside stdout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinu-durability-artifact-'));
    temporaryDirectories.push(root);
    const artifact: DurabilityProbeArtifact = {
      schemaVersion: 1,
      command: 'bun scripts/sandbox-durability-probe.ts --run',
      runId: '31158290',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:11:00.000Z',
      baseMiB: 64,
      idleMinutes: 11,
      outcome: 'green',
      evidence: {
        P1: { bigFile: 'big.bin', baseMib: 64, checkpoint: { kind: 'committed', bytes: 64 * 1024 * 1024 } },
        P2: { wakeWallMs: 79, sliceWallMs: 82, overlay: 'overlay', restartVerified: true },
        P3: { deletedAbsent: true, additionPresent: true, checkpoint: { kind: 'committed', bytes: 4096 } },
        P4: { processId: 'process-1', httpBefore: '200', httpAfter: '200', urlToken: 'preview-token' },
        P5: {
          idleMinutes: 11,
          chainAlive: true,
          instanceReplaced: true,
          workspaceIntact: true,
          supervisedServing: true,
        },
        P6: { intactAfterFinalStop: true },
      },
    };

    const path = await persistDurabilityArtifact(root, artifact);

    expect(path).toBe(durabilityArtifactPath(root, artifact.runId));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(artifact);
  });

  test('refuses to overwrite evidence for an existing run id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinu-durability-artifact-'));
    temporaryDirectories.push(root);
    const artifact: DurabilityProbeArtifact = {
      schemaVersion: 1,
      command: 'bun scripts/sandbox-durability-probe.ts --run',
      runId: 'e54c7de8',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:11:00.000Z',
      baseMiB: 64,
      idleMinutes: 11,
      outcome: 'green',
      evidence: {
        P1: { bigFile: 'big.bin', baseMib: 64, checkpoint: { kind: 'committed' } },
      },
    };

    const path = await persistDurabilityArtifact(root, artifact);

    await expect(persistDurabilityArtifact(root, {
      ...artifact,
      outcome: 'failed',
      failure: 'a later attempt failed',
    })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(artifact);
  });

  test('persists partial evidence and the failure when a phase fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kinu-durability-artifact-'));
    temporaryDirectories.push(root);
    const artifact: DurabilityProbeArtifact = {
      schemaVersion: 1,
      command: 'bun scripts/sandbox-durability-probe.ts --run',
      runId: 'failed-p5',
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:11:00.000Z',
      baseMiB: 64,
      idleMinutes: 11,
      outcome: 'failed',
      evidence: {
        P1: { bigFile: 'big.bin', baseMib: 64, checkpoint: { kind: 'committed', bytes: 64 * 1024 * 1024 } },
        P2: { wakeWallMs: 79, sliceWallMs: 82, overlay: 'overlay', restartVerified: true },
        P3: { deletedAbsent: true, additionPresent: true, checkpoint: { kind: 'committed', bytes: 4096 } },
        P4: { processId: 'process-1', httpBefore: '200', httpAfter: '200', urlToken: 'preview-token' },
      },
      failure: 'heartbeat chain died during idle',
    };

    const path = await persistDurabilityArtifact(root, artifact);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(artifact);
  });

  test('refuses a run id that could write outside the artifact root', () => {
    expect(() => durabilityArtifactPath('/tmp/artifacts', '../outside')).toThrow('safe artifact id');
  });
});
