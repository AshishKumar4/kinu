/** D30: the container's sync reaches its box only through `serveSync`, which holds every request to
 * the box's own record: its restored container generation, its store prefix, layers the store holds,
 * and the fenced write. `syncWorker` keeps a flush from overlapping a tick. */
import { describe, expect, test } from 'bun:test';
import {
  ChainRecordAdvanced, baseObjectKey, deltaObjectKey, type ChainState, type SnapshotChainPorts,
} from '../src/snapshot-chain';
import type { CheckpointKind, CheckpointOutcome } from '../src/storage';
import { DEVBOX_SYNC_HANDLER, DEVBOX_SYNC_HOST, serveSync, syncCaller, syncWorker } from '../src/sync';
import { ChainTestBox, chainBox } from './support/chain-box';

const ROOT = 'boxes/one/backups';

const BASE = crypto.randomUUID();

const DELTA = crypto.randomUUID();

const RESTORED = 'boot-restored';

function record(rev: number, delta: { readonly id: string; readonly bytes: number } | undefined): ChainState {
  return {
    mode: 'chain', rev, at: 0, changeVersion: undefined, upperMark: undefined,
    base: { id: BASE, bytes: 100, digest: undefined, objectVersion: undefined },
    delta: delta === undefined ? undefined : { ...delta, digest: undefined, objectVersion: undefined },
    fallback: undefined, orphans: undefined, retiredDeltas: undefined, lastFailure: undefined,
  };
}

/** The box's ports as the sync reaches them: a fenced record and a store of `held` sizes. */
function boxWire(initial: ChainState, held: ReadonlyMap<string, number>) {
  let state: ChainState | null = initial;
  const deleted: string[] = [];

  const unused = (): never => {
    throw new Error('the sync never asks the box for this');
  };

  const ports: SnapshotChainPorts = {
    containerRunning: () => true,
    allowExtraction: () => false,
    archiveExcludes: () => [],
    readState: async () => await Promise.resolve(state),
    writeState: async (next, expectedRev) => {
      const stored = state?.rev ?? null;

      if (stored !== expectedRev) throw new ChainRecordAdvanced(expectedRev, stored);
      state = await Promise.resolve(next);
    },
    clearState: unused,
    checkpointIntervalMs: () => 15_000,
    checkChanges: unused,
    exec: unused,
    storeRoot: () => ROOT,
    storeObjectUrl: unused,
    mountStore: unused,
    unmountStore: unused,
    stamp: unused,
    objectFacts: async (key) => {
      const bytes = held.get(key);

      return await Promise.resolve(bytes === undefined ? undefined : { bytes, digest: undefined, objectVersion: 'v1' });
    },
    deleteObjects: async (keys) => {
      deleted.push(...await Promise.resolve(keys));
    },
    readSeedStamp: unused,
    writeSeedStamp: unused,
    countEntries: unused,
    restoreExtract: unused,
    createExtractSnapshot: unused,
    now: () => 0,
    log: () => undefined,
  };

  const container = (generation: string | undefined) => syncCaller(
    async (body) => {
      const answer = await serveSync({ ports, generation: async () => await Promise.resolve(RESTORED) }, body);

      return { status: answer.status, text: answer.body };
    },
    async () => await Promise.resolve(generation),
  );

  return { container, deleted, stored: (): ChainState | null => state };
}

describe('the box holds the container to its own record (D30)', () => {
  const held = new Map([[baseObjectKey(ROOT, BASE), 100], [deltaObjectKey(ROOT, DELTA), 7]]);

  test('a commit from the restored container lands; the same commit from any other generation does not', async () => {
    const { container, stored } = boxWire(record(1, undefined), held);
    const next = record(2, { id: DELTA, bytes: 7 });

    await expect(container('boot-replaced')({ op: 'writeState', state: next, expectedRev: 1 })).rejects.toThrow(/generation boot-replaced/);
    expect(stored()?.rev).toBe(1);

    await container(RESTORED)({ op: 'writeState', state: next, expectedRev: 1 });
    expect(stored()?.delta?.id).toBe(DELTA);
  });

  test('a fenced refusal reaches the container as ChainRecordAdvanced, so its checkpoint re-reads', async () => {
    const { container } = boxWire(record(3, undefined), held);

    await expect(container(RESTORED)({ op: 'writeState', state: record(2, { id: DELTA, bytes: 7 }), expectedRev: 1 }))
      .rejects.toBeInstanceOf(ChainRecordAdvanced);
  });

  test('a record naming a layer the store does not hold at that size is refused', async () => {
    const { container, stored } = boxWire(record(1, undefined), held);

    await expect(container(RESTORED)({ op: 'writeState', state: record(2, { id: DELTA, bytes: 8 }), expectedRev: 1 }))
      .rejects.toThrow(/holds 7 bytes/);
    await expect(container(RESTORED)({ op: 'writeState', state: record(2, { id: crypto.randomUUID(), bytes: 7 }), expectedRev: 1 }))
      .rejects.toThrow(/no such object/);
    expect(stored()?.rev).toBe(1);
  });

  test('keys outside the store prefix are refused and nothing is deleted', async () => {
    const { container, deleted } = boxWire(record(1, undefined), held);

    await expect(container(RESTORED)({ op: 'deleteObjects', keys: [`${ROOT}/${BASE}/data.sqsh`, 'boxes/other/backups/x'] }))
      .rejects.toThrow(/outside this box's store prefix/);
    expect(deleted).toEqual([]);
  });
});

test('a flush that arrives during a tick runs after it, never beside it', async () => {
  const order: string[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });

  const { run } = syncWorker({
    attach: async () => await Promise.reject(new Error('unused')),
    discard: async () => await Promise.reject(new Error('unused')),
    checkpoint: async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
      order.push(`start:${kind}`);

      if (kind === 'tick') await held;
      order.push(`end:${kind}`);

      return { kind: 'skipped', reason: 'unchanged', bytes: undefined, movedBytes: 0 };
    },
  });

  const tick = run('tick');
  const flush = run('quiesce');
  await Promise.resolve();
  expect(order).toEqual(['start:tick']);
  release();
  await Promise.all([tick, flush]);
  expect(order).toEqual(['start:tick', 'end:tick', 'start:quiesce', 'end:quiesce']);
});

test('a checkpoint that throws is a failed outcome, and the next one still runs', async () => {
  let calls = 0;

  const { run } = syncWorker({
    attach: async () => await Promise.reject(new Error('unused')),
    discard: async () => await Promise.reject(new Error('unused')),
    checkpoint: async (): Promise<CheckpointOutcome> => {
      calls += 1;

      if (calls === 1) throw new Error('devbox.internal refused the connection');

      return await Promise.resolve({ kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1 });
    },
  });

  expect(await run('tick')).toMatchObject({ kind: 'failed', reason: expect.stringContaining('devbox.internal refused the connection') });
  expect((await run('tick')).kind).toBe('committed');
});

class SyncingBox extends ChainTestBox {
  protected override get ambientCheckpoints(): boolean {
    return true;
  }
}

/** Local `wrangler dev`: its containers get no outbound interception, so the box ticks itself. */
class ExtractingBox extends SyncingBox {
  protected override get allowExtraction(): boolean {
    return true;
  }
}

test('the box ticks its own checkpoints only where the container cannot sync, and a benchmark box neither', async () => {
  const local = chainBox(ExtractingBox);
  await local.box.devboxStartup();

  expect(local.container.scheduleRows.map((row) => row.callback)).toContain('devboxCheckpoint');
  expect(local.container.syncRunning).toBe(false);

  const bench = chainBox();
  await bench.box.devboxStartup();

  expect(bench.container.scheduleRows.map((row) => row.callback)).not.toContain('devboxCheckpoint');
  expect(bench.container.syncRunning).toBe(false);
});

test('a restored box runs its sync in the container, not on its own alarm, and a beat restarts it when gone', async () => {
  const { box, container } = chainBox(SyncingBox);
  await box.devboxStartup();

  expect(container.syncRunning).toBe(true);
  expect(container.outboundHosts.get(DEVBOX_SYNC_HOST)).toBe(DEVBOX_SYNC_HANDLER);
  expect(container.scheduleRows.map((row) => row.callback)).not.toContain('devboxCheckpoint');

  container.syncRunning = false;
  await box.devboxHeartbeat();

  expect(container.syncRunning).toBe(true);
  expect((await box.devboxIncidentReasons()).map((row) => row.reason)).toContain(
    'the container\'s sync had stopped, so nothing was committed since; restarting it',
  );
});

test('a stop ends the container\'s sync before it releases the work directory, so no tick races the detach', async () => {
  const { box, container } = chainBox(SyncingBox);
  await box.devboxStartup();

  expect((await box.quiesce()).kind).not.toBe('failed');
  expect(container.syncRunning).toBe(false);
  const stoppedAt = container.sequence.indexOf('exec:devbox-sync-stop-v1');
  expect(stoppedAt).toBeGreaterThan(-1);
  expect(stoppedAt).toBeLessThan(container.sequence.indexOf('exec:release-workdir-holders'));
});

test('discarding a box ends its sync first, so no tick publishes after the bytes are gone', async () => {
  const { box, container } = chainBox(SyncingBox);
  await box.devboxStartup();

  await box.discardState();

  expect(container.syncRunning).toBe(false);
});
