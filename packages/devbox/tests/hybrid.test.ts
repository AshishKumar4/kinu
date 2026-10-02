// D55's hybrid at the box boundary: a rest's snapshot is the next wake, and a wake that cannot use it
// recovers from the chain and says so. The chain is a model here; disk-chain-image.test.ts runs the real one.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Effect } from 'effect';
import * as v from 'valibot';
import { DiskChainStateSchema, type DiskChain, type DiskChainPorts } from '../src/disk-chain';
import { attempt } from '../src/errors';
import { ChainTestBox, chainBox } from './support/chain-box';

/** What the box asked of its chain, in order. */
const asked: string[] = [];

function modelChain(ports: DiskChainPorts): DiskChain {
  return {
    attach: (fromSnapshot) => Effect.gen(function* () {
      asked.push(`attach from ${fromSnapshot ? 'snapshot' : 'image'}`);

      if (fromSnapshot) return { kind: 'attached', detail: 'disk', recoveredTo: undefined };
      const state = yield* attempt('io', () => ports.readState());

      return state === null ? { kind: 'empty', detail: 'no record', recoveredTo: undefined } : { kind: 'attached', detail: 'lazy', recoveredTo: state.committedAt };
    }),
    commit: (kind) => Effect.gen(function* () {
      const state = yield* attempt('io', () => ports.readState());
      const at = ports.now();
      yield* attempt('io', () => ports.writeState({ format: 'disk-chain/1', rev: (state?.rev ?? 0) + 1, base: { key: 'base', bytes: 1, committedAt: at }, deltas: [], committedAt: at }, state?.rev ?? null));
      asked.push(`commit ${kind}`);

      return { kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1 };
    }),
  };
}

class HybridBox extends ChainTestBox {
  protected override get hybrid(): boolean {
    return true;
  }

  protected override get snapshotWakeCutoverMs(): number {
    return 50;
  }

  protected override hybridChain(ports: DiskChainPorts): DiskChain {
    return modelChain(ports);
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
  const { box, container, rows } = await rested();
  const committedAt = Date.now();
  container.snapshots.set('snapshot-1', 'hang');
  const destroys = container.destroys;
  await box.devboxStartup();
  const notices = (await box.devboxIncidentReasons()).map(row => row.reason).filter(reason => reason.includes('restored from its backup'));

  expect({
    starts: container.startOptions.map(startedFrom), asked, destroyed: container.destroys - destroys, snapshotKept: rows.has('devbox:snapshot'),
    notices: notices.length, restoredTo: notices[0]?.includes(new Date(committedAt).toISOString().slice(0, 16)), rebuild: notices[0]?.includes('node_modules'),
  }).toEqual({
    starts: ['image', 'snapshot-1', 'image'], asked: ['attach from image', 'commit quiesce', 'attach from image'], destroyed: 1, snapshotKept: false,
    notices: 1, restoredTo: true, rebuild: true,
  });
});

test('a snapshot the platform no longer has starts from the image at once', async () => {
  const { box, container } = await rested();
  container.snapshots.delete('snapshot-1');
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), asked }).toEqual({
    starts: ['image', 'snapshot-1', 'image'], asked: ['attach from image', 'commit quiesce', 'attach from image'],
  });
});

test('a snapshot the chain has moved past, or one past its 29 days, is not woken', async () => {
  const moved = await rested();
  const chain = v.parse(DiskChainStateSchema, moved.rows.get('devbox:disk-chain'));

  moved.rows.set('devbox:disk-chain', { ...chain, rev: 99 });
  await moved.box.devboxStartup();
  const old = await rested();
  setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await old.box.devboxStartup();

  expect({ moved: moved.container.startOptions.map(startedFrom), old: old.container.startOptions.map(startedFrom) }).toEqual({
    moved: ['image', 'image'], old: ['image', 'image'],
  });
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
    said: reasons.some(reason => reason.includes('took no snapshot') && reason.includes('snapshot quota exceeded')),
  }).toEqual({ rest: 'committed', running: true, starts: ['image', 'image'], said: true });
});
