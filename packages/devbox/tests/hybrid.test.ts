// D55's hybrid at the box boundary: a rest's snapshot is the next wake, and a wake that cannot use it
// recovers from the chain and says so. The chain is chain-box's model; the deploy tier runs the real one.
import { afterEach, expect, jest, setSystemTime, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import { ChainTestBox, asked, chainBox } from './support/chain-box';
import { HARNESS_GOLDEN } from './support/devbox-harness';
import type { SnapshotRegistry } from '../src/snapshot-registry';

/** The registry as the box asks it to delete a snapshot: what it deleted, and an answer to give. */
class Registry {
  readonly deleted: string[] = [];
  refuse: string | undefined;
  /** The digest the next refusal says it left, its tags gone. */
  left: string | undefined;
  /** Holds the next deletion until `release` settles, telling `entered` it began. */
  hold: { readonly entered: () => void; readonly release: Promise<void> } | undefined;
}

const registry = new Registry();

/** The registry the boxes here delete their dead snapshots through. */
function fakeRegistry(): SnapshotRegistry {
  return {
    delete: async (id) => {
      const refused = registry.refuse;
      const left = registry.left;
      const hold = registry.hold;
      registry.refuse = undefined;
      registry.left = undefined;
      registry.hold = undefined;

      if (hold !== undefined) {
        hold.entered();
        await hold.release;
      }

      if (refused !== undefined) return left === undefined ? { kind: 'refused', reason: refused } : { kind: 'refused', reason: refused, left };
      registry.deleted.push(id);

      return { kind: 'deleted' };
    },
    // A box never deletes an application's snapshots; the fixtures and reset do.
    deleteApplication: async () => { throw new Error('a box deleted an application\'s snapshots'); },
  };
}

class HybridBox extends ChainTestBox {
  protected override get snapshotRegistry(): SnapshotRegistry {
    return fakeRegistry();
  }
}

/** A box on the product's own cutover, as a person's quick restart meets it. */
class QuickRestartBox extends ChainTestBox {
  protected override get snapshotRegistry(): SnapshotRegistry {
    return fakeRegistry();
  }
}

/** A box that was started, used and rested once. */
async function rested(Box: typeof ChainTestBox = HybridBox) {
  asked.length = 0;
  registry.deleted.length = 0;
  const arm = chainBox(Box);
  await arm.box.devboxStartup();
  const rest = await arm.box.quiesce();

  return { ...arm, rest };
}

const startedFrom = (options: { readonly containerSnapshot?: { readonly id: string } } | undefined) =>
  options?.containerSnapshot?.id === HARNESS_GOLDEN ? 'golden' : options?.containerSnapshot?.id;

afterEach(() => {
  setSystemTime();
});

test('a rest commits the chain, then takes the snapshot the next wake starts from with its disk as it is', async () => {
  const { box, container, rest } = await rested();
  await box.devboxStartup();

  expect({ rest: rest.kind, starts: container.startOptions.map(startedFrom), asked, snapshots: [...container.snapshots.keys()] }).toEqual({
    rest: 'committed', starts: ['golden', 'snapshot-1'], asked: ['attach from image', 'commit quiesce', 'attach from snapshot'], snapshots: [HARNESS_GOLDEN, 'snapshot-1'],
  });
});

// Review of 977bf090f: the admission probe's output was read outside its settled check, so a start refused for room after
// the probe answered failed in the lost connection's words, and read as a verdict on the snapshot.
test('a snapshot wake refused for room after its admission probe answered keeps the snapshot as its source', async () => {
  const { box, container, rows } = await rested();

  container.admissionLoss = { lost: new Error('Network connection lost.'), refusal: new Error('Account resource limit exceeded') };
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), snapshotKept: rows.has('devbox:snapshot') }).toEqual({ starts: ['golden', 'snapshot-1'], snapshotKept: true });
});

// Review, 2026-10-26: a probe that failed while the platform said nothing of the start, its connection lost, was read as a
// verdict on the snapshot; the box gave its own snapshot up and woke from the golden and the backup, its root lost (D118).
test('a snapshot wake whose admission probe loses its connection keeps its own snapshot and wakes from it, its root kept', async () => {
  asked.length = 0;
  registry.deleted.length = 0;
  const { box, container, rows } = chainBox(HybridBox);
  await box.devboxStartup();
  await box.writeFile('/root/.cache/kept', 'packages the backup leaves out');
  await box.quiesce();
  container.admissionLoss = { lost: new Error('Network connection lost.') };
  await box.devboxStartup();
  const kept = await box.exists('/root/.cache/kept');

  expect({
    starts: container.startOptions.map(startedFrom), snapshot: rows.has('devbox:snapshot'), deleted: [...registry.deleted], kept: kept.exists,
    notices: (await box.devboxIncidentReasons()).map(row => row.stage),
  }).toEqual({ starts: ['golden', 'snapshot-1'], snapshot: true, deleted: [], kept: true, notices: [] });
});

test('a snapshot wake the platform refuses starts from the golden and tells the agent when it restored to', async () => {
  setSystemTime(new Date('2026-09-30T00:00:00Z'));
  const { box, container, rows } = await rested();
  container.snapshots.delete('snapshot-1');
  const destroys = container.destroys;
  await box.devboxStartup();
  const notices = await box.devboxIncidentReasons();

  expect({
    starts: container.startOptions.map(startedFrom), asked, destroyed: container.destroys - destroys, snapshotKept: rows.has('devbox:snapshot'),
    notices: notices.map(row => row.stage), restoredTo: notices[0]?.reason.includes('2026-09-30T00:00'),
  }).toEqual({
    starts: ['golden', 'snapshot-1', 'golden'], asked: ['attach from image', 'commit quiesce', 'attach from image'], destroyed: 1, snapshotKept: false,
    notices: ['recovered'], restoredTo: true,
  });
});

// Ledger 1024-s: a quick restart's own snapshot is still on its way. 199 stop-then-start-at-once wakes on real boxes were
// admitted p50 1.64 s, p90 7.12 s, max 32.3 s (armada, 2026-10-24); the 10 s cutover discarded seven in flight in the week
// to 10-24 and woke them from the backup, the root's packages and the terminals' saved screens lost.
test('a quick restart whose own snapshot is admitted after 32 s still wakes from it, its root kept', async () => {
  const { box, container, rows } = await rested(QuickRestartBox);
  container.snapshots.set('snapshot-1', 'late');
  jest.useFakeTimers();

  try {
    const starting = box.devboxStartup();

    await container.lateStart.reached;
    jest.advanceTimersByTime(32_300);
    container.lateStart.release();
    await starting;
  } finally {
    jest.useRealTimers();
  }

  expect({ starts: container.startOptions.map(startedFrom), snapshotKept: rows.has('devbox:snapshot'), notices: (await box.devboxIncidentReasons()).map(row => row.stage) })
    .toEqual({ starts: ['golden', 'snapshot-1'], snapshotKept: true, notices: [] });
});

// Staging 222eb284e, 2026-10-26: five boxes started at once, and one's own snapshot, kept by its rest, was not admitted
// in the 60 s cutover; the box gave the snapshot up, deleted it, and woke from the golden and the backup 201 s after its
// start began, the root's 300,000 files lost (D117).
test('an own snapshot is waited for however long the platform takes to admit it, and no clock retires it', async () => {
  const { box, container, rows } = await rested(QuickRestartBox);
  container.snapshots.set('snapshot-1', 'late');
  jest.useFakeTimers();
  let woke = false;

  try {
    const starting = box.devboxStartup().then(() => { woke = true; });

    await container.lateStart.reached;
    jest.advanceTimersByTime(600_000);
    const waiting = { woke, starts: container.startOptions.map(startedFrom), kept: rows.has('devbox:snapshot'), deleted: [...registry.deleted] };
    container.lateStart.release();
    await starting;

    expect({ waiting, woke: container.startOptions.map(startedFrom), notices: (await box.devboxIncidentReasons()).map(row => row.stage) }).toEqual({
      waiting: { woke: false, starts: ['golden', 'snapshot-1'], kept: true, deleted: [] }, woke: ['golden', 'snapshot-1'], notices: [],
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a snapshot the platform no longer has starts from the golden at once, and leaves no exec to abort later', async () => {
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
    starts: ['golden', 'snapshot-1', 'golden'], asked: ['attach from image', 'commit quiesce', 'attach from image'], aborted: 0,
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
    moved: ['golden', 'snapshot-1', 'golden'], old: ['golden', 'golden'],
  });
});

test('a child is not woken once its lineage\'s root is past 29 days, however new the child', async () => {
  const { box, container } = await rested();
  setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000);
  await box.devboxStartup();
  await box.quiesce();
  setSystemTime(Date.now() + 10 * 24 * 60 * 60 * 1000);
  await box.devboxStartup();

  expect(container.startOptions.map(startedFrom)).toEqual(['golden', 'snapshot-1', 'golden']);
});

// The platform's words when the account's snapshot limit was reached (2026-10-09): the rest committed the chain first,
// so the box's work is in its backup, and only the next wake's speed is lost.
const SNAPSHOT_LIMIT = 'The snapshot could not be completed because snapshot resource limits were exceeded.';

test('a rest whose snapshot is refused still rests, says why, and the next wake recovers from the chain', async () => {
  asked.length = 0;
  const { box, container } = chainBox(HybridBox);
  await box.devboxStartup();
  container.snapshotFault = new Error(SNAPSHOT_LIMIT);
  const rest = await box.quiesce();
  await box.devboxStartup();
  const reasons = (await box.devboxIncidentReasons()).map(row => row.reason);

  expect({
    rest: rest.kind, running: container.running.running, starts: container.startOptions.map(startedFrom),
    said: reasons.some(reason => reason.includes(SNAPSHOT_LIMIT)), asked,
  }).toEqual({ rest: 'committed', running: true, starts: ['golden', 'golden'], said: true, asked: ['attach from image', 'commit quiesce', 'attach from image'] });
});

/** A hybrid box that gives up its rest's snapshot after 50 ms. */
/** A box whose rest waits 50 ms for its take, whatever its root holds. */
class ImpatientBox extends HybridBox {
  protected override get restSnapshotWaitMs(): number {
    return 50;
  }

  protected override get restSnapshotMsPerFile(): number {
    return 0;
  }
}

/** A box whose floor is 50 ms and whose root costs 1 ms per 1,000 files: 343 ms for 343,000. */
class ScaledBox extends ImpatientBox {
  protected override get restSnapshotMsPerFile(): number {
    return 0.001;
  }
}

// f44999, 2026-10-22 (D108): a rest's snapshot never answered, and the box refused every request for the 14 minutes it
// waited on it, its terminal included.
test('a rest whose snapshot never answers stops without it, says why, and a request after it starts the box from the chain', async () => {
  asked.length = 0;
  registry.deleted.length = 0;
  const { box, container, rows } = chainBox(ImpatientBox);
  await box.devboxStartup();
  const taking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  container.snapshotHold = { entered: taking.resolve, release: release.promise };
  const rest = box.quiesce();

  await taking.promise;
  const during = await box.resolveReadiness();
  const ended = await rest;
  const stopped = container.running.running;
  const after = await box.resolveReadiness();
  const reasons = (await box.devboxIncidentReasons()).map(row => row.reason);

  // The take that lands after the box stopped is owed, and deleted, never woken from.
  release.resolve();
  await box.devboxStartup();

  expect({
    during, rest: ended.kind, stopped, after: after.kind, starts: container.startOptions.map(startedFrom),
    said: reasons.some(reason => reason.includes('the platform had not answered when the container stopped')), snapshot: rows.has('devbox:snapshot'),
  }).toEqual({
    during: { kind: 'pending', reason: 'the computer is saving its work and stopping; it starts again as soon as that is done', quiescing: true },
    rest: 'committed', stopped: false, after: 'restored', starts: ['golden', 'golden'], said: true, snapshot: false,
  });
});

// hearthlit-field, production 2026-10-24/25: three rests in a row took 62, 104 and 67 s from their commit to the end of
// the stop, each giving its take up at 60 s, so every wake came from the golden and the backup without what the backup
// leaves out. On staging (2026-10-25) a take still under way when the stop began never answered (17 of 17), and a root of
// 343,000 files took 53-75 s to take (D116).
test('a rest over a root of many files waits for its take as long as those files cost: it is the next wake, its root kept', async () => {
  asked.length = 0;
  const { box, container, rows } = chainBox(ScaledBox);
  // Its clock: a box of the same 50 ms floor over the image's files alone, whose take never answers, gives its take up
  // once that floor has passed.
  const clock = chainBox(ImpatientBox);
  await box.devboxStartup();
  await clock.box.devboxStartup();
  await box.writeFile('/root/.cache/kept', 'packages the backup leaves out');
  container.rootFiles = 343_000;
  const answered = Promise.withResolvers<void>();
  container.snapshotHold = { entered: () => undefined, release: answered.promise };
  clock.container.snapshotHold = { entered: () => undefined, release: new Promise<void>(() => undefined) };
  // The take answers past the floor, within what the root's files cost.
  const [rest] = await Promise.all([box.quiesce(), clock.box.quiesce().then(() => { answered.resolve(); })]);
  await box.devboxStartup();
  const kept = await box.exists('/root/.cache/kept');

  expect({
    rest: rest.kind, starts: container.startOptions.map(startedFrom), snapshot: rows.has('devbox:snapshot'), kept: kept.exists,
    notices: (await box.devboxIncidentReasons()).map(row => row.stage),
  }).toEqual({ rest: 'committed', starts: ['golden', 'snapshot-1'], snapshot: true, kept: true, notices: [] });
});

// Review, 2026-10-26: the rest read the root's count before arming the take's wait, so a count that never answered would
// have held the box in its rest for ever, as D108's take did.
test('a rest whose root count never answers still waits only its floor for a take that never answers, and stops', async () => {
  const { box, container } = chainBox(ScaledBox);
  await box.devboxStartup();
  container.rootFiles = null;
  container.snapshotHold = { entered: () => undefined, release: new Promise<void>(() => undefined) };
  const rest = await box.quiesce();

  expect({ rest: rest.kind, running: container.running.running }).toEqual({ rest: 'committed', running: false });
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

// Deleting an account deletes everything it has: a workspace's teardown discards the box's state, then destroys the box,
// which keeps nothing of the workspace but the snapshots it still owes a deletion, for a sweep to pay.
test('a destroyed box keeps nothing of its workspace but the snapshots still owed a deletion', async () => {
  const { box, rows } = await rested();
  await box.devboxStartup();
  await box.quiesce();
  registry.refuse = 'deleting rootfs-snapshot-ab answered 403: forbidden';
  await box.discardState();
  const owed = rows.get('devbox:dead-snapshots');
  await box.destroy();

  expect({ kept: [...rows.keys()], owed: rows.get('devbox:dead-snapshots') }).toEqual({ kept: ['devbox:dead-snapshots'], owed });
  expect(owed).toHaveLength(1);
});

// Lanes fixture, 2026-10-25: a clear's discard turned the running box's generation over, its heartbeat came due while the
// discard deleted the box's store, found the box unrestored, and armed a startup that restored it again a second later.
test('a heartbeat due while the box is torn down restores nothing and arms nothing', async () => {
  const { box, container, rows } = await rested();
  await box.devboxStartup();
  const before = asked.length;
  const deleting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  registry.hold = { entered: deleting.resolve, release: release.promise };
  const clearing = box.discardState();

  await deleting.promise;
  await box.devboxHeartbeat();
  const armed = container.scheduleRows.map(row => row.callback);
  setSystemTime(Date.now() + 5_000);
  await box.alarm();
  release.resolve();
  await clearing;
  await box.destroy();

  expect({ armed, restored: asked.slice(before), running: container.running.running, kept: [...rows.keys()] })
    .toEqual({ armed: [], restored: [], running: false, kept: [] });
});

// Review finding 11: a rest's snapshot that finished after a discard was published as the next wake.
test('a discard while a rest takes its snapshot leaves nothing to wake from: the late snapshot is owed and deleted', async () => {
  asked.length = 0;
  registry.deleted.length = 0;
  const { box, container, rows } = chainBox(HybridBox);
  await box.devboxStartup();
  const taking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  container.snapshotHold = { entered: taking.resolve, release: release.promise };
  const rest = box.quiesce();

  await taking.promise;
  await box.discardState();
  release.resolve();
  await rest;

  expect({ snapshot: rows.has('devbox:snapshot'), deleted: registry.deleted, pending: rows.get('devbox:dead-snapshots') ?? [] })
    .toEqual({ snapshot: false, deleted: ['snapshot-1'], pending: [] });
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
