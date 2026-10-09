// D55's hybrid at the box boundary: a rest's snapshot is the next wake, and a wake that cannot use it
// recovers from the chain and says so. The chain is chain-box's model; the deploy tier runs the real one.
import { afterEach, expect, jest, setSystemTime, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import { ChainTestBox, asked, chainBox } from './support/chain-box';
import type { SnapshotRegistry } from '../src/snapshot-registry';

/** The registry as the box asks it to delete a snapshot: what it deleted, and an answer to give. */
class Registry {
  readonly deleted: string[] = [];
  refuse: string | undefined;
  /** The digest the next refusal says it left, its tags gone. */
  left: string | undefined;
}

const registry = new Registry();

class HybridBox extends ChainTestBox {
  protected override get snapshotWakeCutoverMs(): number {
    return 50;
  }

  protected override get snapshotRegistry(): SnapshotRegistry {
    return {
      delete: async (id) => {
        const refused = registry.refuse;
        const left = registry.left;
        registry.refuse = undefined;
        registry.left = undefined;

        if (refused !== undefined) return left === undefined ? { kind: 'refused', reason: refused } : { kind: 'refused', reason: refused, left };
        registry.deleted.push(id);

        return { kind: 'deleted' };
      },
    };
  }
}

/** The same box after a deploy that changed its image. */
class ImageChangedBox extends HybridBox {
  static image = '';

  protected override get containerImage(): string | undefined {
    return ImageChangedBox.image;
  }
}

/** A box that was started, used and rested once. */
async function rested() {
  asked.length = 0;
  registry.deleted.length = 0;
  const arm = chainBox(HybridBox);
  await arm.box.devboxStartup();
  const rest = await arm.box.quiesce();

  return { ...arm, rest };
}

const startedFrom = (options: { readonly image?: string; readonly containerSnapshot?: { readonly id: string } } | undefined) =>
  options?.containerSnapshot === undefined ? 'image' : options.containerSnapshot.id;

afterEach(() => {
  setSystemTime();
});

test('a rest commits the chain, then takes the snapshot the next wake starts from with its disk as it is', async () => {
  const { box, container, rest } = await rested();
  await box.devboxStartup();

  expect({ rest: rest.kind, starts: container.startOptions.map(startedFrom), asked, snapshots: [...container.snapshots.keys()] }).toEqual({
    rest: 'committed', starts: ['image', 'snapshot-1'], asked: ['attach from image', 'commit quiesce', 'attach from snapshot'], snapshots: ['snapshot-1'],
  });
});

test('a snapshot wake that is not admitted within the cutover starts from the image and tells the agent when it restored to', async () => {
  setSystemTime(new Date('2026-09-30T00:00:00Z'));
  const { box, container, rows } = await rested();
  container.snapshots.set('snapshot-1', 'hang');
  const destroys = container.destroys;
  await box.devboxStartup();
  const notices = await box.devboxIncidentReasons();

  expect({
    starts: container.startOptions.map(startedFrom), asked, destroyed: container.destroys - destroys, snapshotKept: rows.has('devbox:snapshot'),
    notices: notices.map(row => row.stage), restoredTo: notices[0]?.reason.includes('2026-09-30T00:00'),
  }).toEqual({
    starts: ['image', 'snapshot-1', 'image'], asked: ['attach from image', 'commit quiesce', 'attach from image'], destroyed: 1, snapshotKept: false,
    notices: ['recovered'], restoredTo: true,
  });
});

test('a snapshot the platform no longer has starts from the image at once, and leaves no exec to abort later', async () => {
  const { box, container } = await rested();
  container.snapshots.delete('snapshot-1');
  jest.useFakeTimers();

  try {
    await box.devboxStartup();
    // Live, an exec's signal aborting after the cutover took the image's container down with it.
    jest.advanceTimersByTime(60_000);
  } finally {
    jest.useRealTimers();
  }

  expect({ starts: container.startOptions.map(startedFrom), asked, aborted: container.execSignals.filter(signal => signal.aborted).length }).toEqual({
    starts: ['image', 'snapshot-1', 'image'], asked: ['attach from image', 'commit quiesce', 'attach from image'], aborted: 0,
  });
});

test('a snapshot the chain has moved past, or one past its 29 days, is not woken', async () => {
  const moved = await rested();
  await moved.box.devboxStartup();
  expect((await moved.box.checkpointNow('tick')).kind).toBe('committed');
  await moved.container.stop();

  await moved.box.devboxStartup();
  const old = await rested();
  setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await old.box.devboxStartup();

  expect({ moved: moved.container.startOptions.map(startedFrom), old: old.container.startOptions.map(startedFrom) }).toEqual({
    moved: ['image', 'snapshot-1', 'image'], old: ['image', 'image'],
  });
});

test('a child is not woken once its lineage\'s root is past 29 days, however new the child', async () => {
  const { box, container } = await rested();
  setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000);
  await box.devboxStartup();
  await box.quiesce();
  setSystemTime(Date.now() + 10 * 24 * 60 * 60 * 1000);
  await box.devboxStartup();

  expect(container.startOptions.map(startedFrom)).toEqual(['image', 'snapshot-1', 'image']);
});

test('a snapshot of another image is not woken: the new image starts and recovers the chain', async () => {
  const { box, container } = await rested();
  ImageChangedBox.image = 'registry.example/devbox@sha256:next';
  Object.setPrototypeOf(box, ImageChangedBox.prototype);
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), asked }).toEqual({
    starts: ['image', 'image'], asked: ['attach from image', 'commit quiesce', 'attach from image'],
  });
});

test('a rest whose snapshot is refused still rests, says why, and the next wake recovers from the chain', async () => {
  asked.length = 0;
  const { box, container } = chainBox(HybridBox);
  await box.devboxStartup();
  container.snapshotFault = new Error('snapshot quota exceeded');
  const rest = await box.quiesce();
  await box.devboxStartup();
  const reasons = (await box.devboxIncidentReasons()).map(row => row.reason);

  expect({
    rest: rest.kind, running: container.running.running, starts: container.startOptions.map(startedFrom),
    said: reasons.some(reason => reason.includes('snapshot quota exceeded')),
  }).toEqual({ rest: 'committed', running: true, starts: ['image', 'image'], said: true });
});

test('a discard empties the box\'s store whether it holds no object or more than one listing of them', async () => {
  const empty = chainBox(HybridBox);
  await empty.box.devboxStartup();
  const many = chainBox(HybridBox);
  await many.box.devboxStartup();

  for (let at = 0; at < 1500; at++) many.objects.set(`boxes/devbox-under-test/backups/disk/layer-${String(at)}.sqsh`, new Uint8Array([1]));
  const discarded = await Promise.allSettled([empty.box.discardState(), many.box.discardState()]);

  expect({ discarded: discarded.map(outcome => outcome.status), left: many.objects.size, record: many.rows.has('devbox:disk-chain') })
    .toEqual({ discarded: ['fulfilled', 'fulfilled'], left: 0, record: false });
});

const lineage = (rows: Map<string, unknown>) => v.parse(v.object({ id: v.string(), lineage: v.array(v.string()) }), rows.get('devbox:snapshot'));

test('a rest after a wake from a snapshot keeps that snapshot: it is the new one\'s parent', async () => {
  const { box, rows } = await rested();
  await box.devboxStartup();
  await box.quiesce();

  expect({ deleted: registry.deleted, current: lineage(rows) }).toEqual({ deleted: [], current: { id: 'snapshot-2', lineage: ['snapshot-1'] } });
});

test('a rest after the object is evicted mid-session still knows its snapshot is a child', async () => {
  const { box, evict, rows } = await rested();
  await box.devboxStartup();
  await evict().quiesce();

  expect({ deleted: registry.deleted, current: lineage(rows) }).toEqual({ deleted: [], current: { id: 'snapshot-2', lineage: ['snapshot-1'] } });
});

test('a box re-rooted through chain recovery deletes its whole old lineage, and its next snapshot is a root', async () => {
  const { box, container, rows } = await rested();
  await box.devboxStartup();
  await box.quiesce();
  container.snapshots.delete('snapshot-2');
  await box.devboxStartup();
  await box.quiesce();

  expect({ deleted: [...registry.deleted].sort(), current: lineage(rows), pending: rows.get('devbox:dead-snapshots') ?? [] })
    .toEqual({ deleted: ['snapshot-1', 'snapshot-2'], current: { id: 'snapshot-3', lineage: [] }, pending: [] });
});

test('a deletion the platform refuses is logged in its words, holds up neither the rest nor the wake, and is asked again', async () => {
  const { box, container, rows } = await rested();
  container.snapshots.delete('snapshot-1');
  registry.refuse = 'deleting rootfs-snapshot-ab answered 403: forbidden';
  const logged: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((line: string) => { logged.push(line); });

  try {
    await box.devboxStartup();
    const rest = await box.quiesce();
    await box.devboxStartup();
    const woke = container.startOptions.map(startedFrom).at(-1);
    await box.quiesce();

    expect({ rest: rest.kind, woke, said: logged.some(line => line.includes('snapshot-1') && line.includes('answered 403: forbidden')), deleted: registry.deleted, pending: rows.get('devbox:dead-snapshots') ?? [] })
      .toEqual({ rest: 'committed', woke: 'snapshot-2', said: true, deleted: ['snapshot-1'], pending: [] });
  } finally { spy.mockRestore(); }
});

test('discarding the workspace deletes its whole lineage', async () => {
  const { box, rows } = await rested();
  await box.devboxStartup();
  await box.quiesce();
  await box.discardState();

  expect({ deleted: [...registry.deleted].sort(), snapshot: rows.has('devbox:snapshot'), pending: rows.get('devbox:dead-snapshots') ?? [] })
    .toEqual({ deleted: ['snapshot-1', 'snapshot-2'], snapshot: false, pending: [] });
});

test('a deletion refused after the tags went is owed as the digest the registry left, and the next sweep deletes that', async () => {
  const { box, container, rows } = await rested();
  container.snapshots.delete('snapshot-1');
  registry.refuse = 'deleting sha256:ab answered 503: busy';
  registry.left = 'sha256:ab';
  const spy = spyOn(console, 'error').mockImplementation(() => {});

  try {
    await box.devboxStartup();
    await box.quiesce();
    await box.devboxStartup();
    await box.quiesce();

    // The id was refused once; what was deleted after is the digest it left, never the id again.
    expect({ deleted: registry.deleted, pending: rows.get('devbox:dead-snapshots') ?? [] }).toEqual({ deleted: ['sha256:ab'], pending: [] });
  } finally { spy.mockRestore(); }
});
