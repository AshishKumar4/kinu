// The snapshot-chain gate.
//
// The storage model under test: ONE immutable full base plus ONE cumulative
// changed layer, at `backups/<uuid>/data.sqsh` and `delta.sqsh`. A production
// attach mounts a FIXED number of lazy layers and moves zero bytes; a
// checkpoint moves only changed bytes. Local development keeps extraction and
// says so.
//
// TWO TESTS HERE COME FROM A LIVE FAILURE, and they are the reason the rest is
import { describe, expect, test } from 'bun:test';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';

import {
  baseObjectKey,
  CHAIN_EXCLUDES,
  CHAIN_STORE_MOUNT,
  deltaObjectKey,
  isOverlayMounted,
  metadataObjectKey,
  shouldRebase,
  snapshotChainStorage,
  upperFingerprintCommand,
  type ChainState,
  type ChangeStatus,
  type SnapshotChainPorts,
} from '../src/snapshot-chain';
import {
  ATTACH_OUTCOME_KINDS,
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
} from '../src/storage';

const CHAIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const EXTRACT_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
const BASE_BYTES = 4_096;
const DELTA_BYTES = 512;
const INTERVAL_MS = 5 * 60_000;
/** What the fake tree measures as its uncompressed size. */
const STAGE_NEED_BYTES = 1_000;

const UPPER = `${DEVBOX_RUNTIME_DIR}/upper`;

/** What the PRODUCTION image reports: fuse-overlayfs, with NO dir options. */
const MOUNTED = [
  'sysfs /sys sysfs rw,relatime 0 0',
  `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
].join('\n');
/** The live failure's shape: the container is up, the disk is there, and the
 *  work directory is a plain directory on the container's own ext4. */
const NOT_MOUNTED = 'proc /proc proc rw,relatime 0 0\n/dev/vdc / ext4 rw 0 0';
/** The same mount, with the strategy's own upper directory missing from the
 *  container. Writes would have nowhere to land, so no checkpoint could capture
 *  them. Expressed as a missing PATH, not a missing mount option, because
 *  fuse-overlayfs publishes no options to be missing. */
const MOUNTED_NO_UPPER = MOUNTED;

/** Every outcome kind either half of the suite produced. */
const seenAttach = new Set<string>();
const seenCheckpoint = new Set<string>();

interface Harness {
  readonly ports: SnapshotChainPorts;
  /** Every port call, in order. The ordering assertions read this. */
  readonly calls: string[];
  /** The store, as key to size. Omitting a key is a missing object; a
   *  disagreeing size is a corrupt one. */
  readonly objects: Map<string, number>;
  /** The record the ports read and write, exposed for assertions. */
  state: ChainState | null;
  /** The live fingerprint of the changed set; set it to simulate a write. */
  upperMark: string;
}

/**
 * What one recognised shell command turns into: the recorded label the
 * assertions read, and the stdout the strategy consumes.
 */
interface ShellOutcome {
  readonly call: string;
  readonly stdout: string;
}

/**
 * Read one container command and answer as the container would.
 *
 * The strategy owns its shell now, so this is where the suite meets it. Each
 * arm names the command it recognises with the label the assertions read, and
 * an unrecognised command falls through to its first word — so a NEW command
 * shows up in the recorded calls instead of silently resolving as nothing.
 */
function shellLabel(
  command: string,
  mounts: string,
  missingPaths: readonly string[],
  freeBytes: number,
  upperMark: string,
  stagedSize: string,
): ShellOutcome {
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');
  if (command === 'cat /proc/mounts') return { call: 'readMounts', stdout: mounts };
  // The staging-space probe: one command reporting `<need> <free>`.
  if (command.includes('df -Pk')) {
    return { call: 'stagingShortfall', stdout: `${STAGE_NEED_BYTES} ${freeBytes}` };
  }
  const exists = /^test -e '(?<path>[^']+)'/.exec(command)?.groups?.path;
  if (exists !== undefined) {
    return {
      call: `pathExists:${exists}`,
      stdout: missingPaths.includes(exists) ? 'no' : 'yes',
    };
  }
  const unmounted = /fusermount3 -uz '(?<path>[^']+)'/.exec(command)?.groups?.path;
  if (unmounted !== undefined) return { call: `unmountPath:${unmounted}`, stdout: '' };
  const layer = /squashfuse '(?<archive>[^']+)' '(?<point>[^']+)'/.exec(command)?.groups;
  if (layer !== undefined) {
    return { call: `mountLayer:${layer.archive!}:${layer.point!}`, stdout: '' };
  }
  const overlay = /fuse-overlayfs -o lowerdir=(?<lowers>.+?),upperdir=.+ (?<dir>'[^']+')$/
    .exec(command)?.groups;
  if (overlay !== undefined) {
    return {
      call: `overlayAttach:${unquote(overlay.dir!)}:${overlay.lowers!.split(':').length}`,
      stdout: '',
    };
  }
  const seed = /^cp -a '(?<lower>[^']+)\/\.' '(?<upper>[^']+)\//.exec(command)?.groups;
  if (seed !== undefined) {
    return { call: `seedUpper:${seed.lower!}->${seed.upper!}`, stdout: '' };
  }
  const squash = /mksquashfs '(?<source>[^']+)'/.exec(command)?.groups?.source;
  if (squash !== undefined) {
    // The build and its measurement are ONE command now, so the fake answers
    // both: `<exit> <bytes>`.
    return {
      call: `makeSquashfs:${squash}:${(command.match(/ -e '/g) ?? []).length}`,
      stdout: stagedSize,
    };
  }
  if (command.includes("-printf '%s %T@")) {
    return { call: 'upperFingerprint', stdout: upperMark };
  }
  if (command.startsWith('stat -c %s')) return { call: 'statBytes', stdout: String(DELTA_BYTES) };
  return { call: `exec:${command.split(' ')[0]!}`, stdout: '' };
}

/**
 * A container and a store that behave exactly as told.
 *
 * Objects are a map of key to size: omitting one is a missing object and
 * disagreeing sizes are a corrupt one. `mounts` is a closure so a test can make
 * the world change as the code acts on it, which is what lets a postcondition
 * read the world rather than the intention.
 */
function harness(overrides: {
  state?: ChainState | null;
  mounts?: string | (() => string);
  missingPaths?: readonly string[];
  entriesAfterExtract?: number;
  running?: boolean;
  change?: { status: ChangeStatus; version: string } | Error;
  now?: number;
  failPut?: boolean;
  refuseOverlay?: boolean;
  /** The FIRST delta copy into the upper dies, which is the window under test. */
  failSeed?: boolean;
  /** What the changed set fingerprints to. Empty means the probe failed. */
  upperMark?: string;
  /** What the archiver reports as `<exit> <bytes>`. `'0 0'` is the shape that
   *  bit a deployed run: success claimed, no file present. */
  stagedReport?: string;
  /** Bytes the upload actually lands, when it differs from the staged size. */
  landedBytes?: number;
  refuseStoreMount?: boolean;
  extractLands?: boolean;
  allowExtraction?: boolean;
  archiveExcludes?: readonly string[];
  /** Bytes the staging filesystem reports free. Default: room for anything. */
  freeBytes?: number;
  /** A caller-owned array to record into, so a staged `mounts` closure can read
   *  the calls made so far without a forward reference to the harness. */
  calls?: string[];
} = {}): Harness {
  const calls = overrides.calls ?? [];
  const objects = new Map<string, number>();
  let state = overrides.state ?? null;
  const staged = overrides.mounts ?? NOT_MOUNTED;
  const mounts = (): string => (staged instanceof Function ? staged() : staged);
  let extractSeq = 3;
  let seedDied = false;
  let liveMark = overrides.upperMark ?? '7:4096:1700000000';

  const ports: SnapshotChainPorts = {
    containerRunning: () => overrides.running ?? true,
    allowExtraction: () => overrides.allowExtraction ?? true,
    archiveExcludes: () => overrides.archiveExcludes ?? CHAIN_EXCLUDES,
    readState: () => Promise.resolve(state),
    writeState: (next) => {
      calls.push(
        `writeState:${next.rev}:${next.base.id}:${next.delta === undefined ? 'base' : 'delta'}`
        + `${next.lastFailure === undefined ? '' : ':failed'}`,
      );
      state = next;
      return Promise.resolve();
    },
    clearState: () => {
      calls.push('clearState');
      state = null;
      return Promise.resolve();
    },
    checkpointIntervalMs: () => INTERVAL_MS,
    checkChanges: () => {
      calls.push('checkChanges');
      const change = overrides.change ?? { status: 'changed' as const, version: 'v2' };
      if (change instanceof Error) return Promise.reject(change);
      return Promise.resolve(change);
    },
    // ONE PORT, so the fake is a container rather than a set of intentions. The
    // strategy builds its own commands now, and this reads them: an assertion
    // below about `overlayAttach:…` is an assertion about the fuse-overlayfs
    // command line the production image would really receive.
    exec: (command) => {
      const label = shellLabel(
        command, mounts(), overrides.missingPaths ?? [],
        overrides.freeBytes ?? Number.MAX_SAFE_INTEGER,
        liveMark,
        overrides.stagedReport ?? `0 ${DELTA_BYTES}`,
      );
      calls.push(label.call);
      if (label.call.startsWith('seedUpper') && overrides.failSeed === true && !seedDied) {
        // ONE-SHOT: the first copy dies, a retry on the same container succeeds.
        // That is the sequence the defect lived in, so the fake has to be able
        // to express it rather than failing forever.
        seedDied = true;
        return Promise.resolve({ stdout: '', stderr: 'cp: cannot stat: I/O error', exitCode: 1 });
      }
      if (label.call.startsWith('overlayAttach') && overrides.refuseOverlay === true) {
        return Promise.resolve({
          stdout: '', stderr: 'fuse: device not found', exitCode: 1,
        });
      }
      if (label.call.startsWith('makeSquashfs') && overrides.refuseStoreMount === true) {
        // The real local failure: the container has no FUSE device. Deliberately
        // NOT the interception wording, so the degrade cannot be passing because
        // it recognised one particular sentence.
        return Promise.reject(new Error('S3FS mount failed: fuse: device not found'));
      }
      return Promise.resolve({ stdout: label.stdout, stderr: '', exitCode: 0 });
    },
    mountStore: (chainId) => {
      calls.push(`mountStore:${chainId}`);
      return overrides.refuseStoreMount === true
        // The real local failure: the container has no FUSE device. Deliberately
        // NOT the interception wording, so the degrade cannot be passing because
        // it recognised one particular sentence.
        ? Promise.reject(new Error('S3FS mount failed: fuse: device not found'))
        : Promise.resolve();
    },
    unmountStore: () => {
      calls.push('unmountStore');
      return Promise.resolve();
    },
    readFileStream: (path) => {
      calls.push(`readFileStream:${path}`);
      return Promise.resolve({ stream: new ReadableStream<Uint8Array>(), size: DELTA_BYTES });
    },
    putObject: (key) => {
      if (overrides.failPut === true) return Promise.reject(new Error('store unreachable'));
      calls.push(`putObject:${key}`);
      const landed = overrides.landedBytes ?? DELTA_BYTES;
      objects.set(key, landed);
      // What LANDED, which is what the record must carry.
      return Promise.resolve(landed);
    },
    objectBytes: (key) => {
      calls.push(`objectBytes:${key}`);
      return Promise.resolve(objects.get(key));
    },
    deleteObjects: (keys) => {
      calls.push(`deleteObjects:${keys.length}`);
      for (const key of keys) objects.delete(key);
      return Promise.resolve();
    },
    countEntries: () => {
      calls.push('countEntries');
      return Promise.resolve(overrides.entriesAfterExtract ?? 3);
    },
    restoreExtract: (backup) => {
      calls.push(`restoreExtract:${backup.id}`);
      return Promise.resolve({ success: overrides.extractLands ?? true });
    },
    createExtractSnapshot: (options) => {
      calls.push(`createExtractSnapshot:${options.localBucket}`);
      const id = `a1b2c3d4-0000-4000-8000-${String(extractSeq).padStart(12, '0')}`;
      extractSeq += 1;
      objects.set(baseObjectKey(id), DELTA_BYTES);
      return Promise.resolve({ id, dir: options.dir, localBucket: true });
    },
    now: () => overrides.now ?? 10 * INTERVAL_MS,
    log: (message) => calls.push(`log:${message}`),
  };

  // Pre-seed whatever layers the starting state references, so an integrity
  // probe passes unless a test deliberately breaks it.
  if (state !== null) {
    objects.set(baseObjectKey(state.base.id), state.base.bytes);
    if (state.delta !== undefined) {
      objects.set(deltaObjectKey(state.base.id), state.delta.bytes);
    }
  }
  return {
    ports,
    calls,
    objects,
    get state() { return state; },
    set state(next) { state = next; },
    /** What the changed set fingerprints to RIGHT NOW. Setting it is how a test
     *  says "the caller wrote something" between two checkpoints. */
    get upperMark() { return liveMark; },
    set upperMark(next) { liveMark = next; },
  };
}

function chainState(over: Partial<ChainState> = {}): ChainState {
  return {
    mode: 'chain',
    rev: 1,
    base: { id: CHAIN_ID, bytes: BASE_BYTES },
    delta: { bytes: DELTA_BYTES },
    at: 0,
    changeVersion: 'v1',
    upperMark: undefined,
    orphans: undefined,
    lastFailure: undefined,
    ...over,
  };
}

/** Mounts that flip to attached once `overlayAttach` has been called, so a
 *  postcondition observes a world the code actually changed rather than one the
 *  test staged in advance. */
function mountsAfterAttach(calls: readonly string[], mounted = MOUNTED): () => string {
  return () => (calls.some(call => call.startsWith('overlayAttach')) ? mounted : NOT_MOUNTED);
}

async function attachOf(record: Harness): Promise<AttachOutcome> {
  const outcome = await snapshotChainStorage(record.ports).attach();
  seenAttach.add(outcome.kind);
  return outcome;
}

async function checkpointOf(record: Harness, kind: CheckpointKind): Promise<CheckpointOutcome> {
  const outcome = await snapshotChainStorage(record.ports).checkpoint(kind);
  seenCheckpoint.add(outcome.kind);
  return outcome;
}

// ── attach ──────────────────────────────────────────────────────────────────

describe('attach — the mount must be observed to have landed', () => {
  test('a box with no history restores nothing, and is still born with an overlay', async () => {
    const calls: string[] = [];
    const record = harness({ state: null, mounts: mountsAfterAttach(calls), calls });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('empty');
    // Nothing was RESTORED: no store mount, no layer, no bytes.
    expect(record.calls.filter(call => call.startsWith('mountStore'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('readFileStream'))).toEqual([]);
    // But the overlay exists, over an empty lower, so the changed set has
    // somewhere to accumulate from the very first write.
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
  });

  test('a host that cannot attach an overlay stays plain instead of failing the start',
    async () => {
      // A plain local `wrangler dev` has no fuse-overlayfs. That host is the one
      // extraction exists for, so the box is born plain and the first checkpoint
      // decides its mode as before — rather than refusing to start.
      const record = harness({ state: null, refuseOverlay: true });
      const outcome = await attachOf(record);
      expect(outcome.kind).toBe('empty');
      expect(outcome.detail).toBe('no chain recorded');
    });

  test('an already-attached work directory skips the transfer, trusting no marker', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED });
    expect((await attachOf(record)).kind).toBe('already-attached');
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
  });

  test('a production attach mounts base and delta lazily, seeds the upper, releases both',
    async () => {
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      const outcome = await attachOf(record);
      expect(outcome.kind).toBe('attached');

      // A BOUNDED number of layers, whatever the chain's history — which is the
      // property this pins, and its NUMBER changed when the seed moved ahead of
      // the mount. Two archives are still mounted (base and delta), but the
      // delta is copied into the upper and released BEFORE the overlay lands,
      // so the overlay itself carries one lower plus a pre-seeded upper.
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
      expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
      // ZERO bytes moved: no stream is opened and no object is downloaded.
      expect(record.calls.filter(call => call.startsWith('readFileStream'))).toEqual([]);
      // The delta's contents move into the fresh upper, and only then is the
      // delta mount released. From here the upper alone is the changed set.
      const seeded = record.calls.indexOf(`seedUpper:${DEVBOX_RUNTIME_DIR}/lower-delta->${UPPER}`);
      // `lastIndexOf`: the delta path is also unmounted defensively BEFORE the
      // layers are mounted, and the release that matters is the one after the
      // seed.
      const released = record.calls.lastIndexOf(`unmountPath:${DEVBOX_RUNTIME_DIR}/lower-delta`);
      expect(seeded).toBeGreaterThan(-1);
      expect(released).toBeGreaterThan(seeded);
      // AND THE SEED PRECEDES THE OVERLAY. This is the ordering that makes a
      // mounted overlay PROVE the seeding finished, so a re-driven attach can
      // trust its own `already-attached` early return.
      const mounted = record.calls.indexOf(`overlayAttach:${DEVBOX_WORKDIR}:1`);
      expect(seeded).toBeLessThan(mounted);
      expect(released).toBeLessThan(mounted);
      expect(outcome.detail).toContain(`${BASE_BYTES + DELTA_BYTES}B`);
    });

  test('attach cost is independent of the bytes stored: fixed mounts, zero streams', async () => {
    const calls: string[] = [];
    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: 8 * 1024 ** 3 },
        delta: { bytes: 64 << 20 },
      }),
      mounts: mountsAfterAttach(calls),
      calls,
    });
    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
    expect(record.calls.filter(call => call.startsWith('readFileStream'))).toEqual([]);
  });

  test('a complete but unreferenced delta adopts itself; the mount is its validator',
    async () => {
      // A previous run crashed between the atomic PUT and the state write. The
      // PUT was all-or-nothing and squashfs verifies its own superblock, so the
      // bytes are sound and dropping them would lose real work.
      const calls: string[] = [];
      const record = harness({
        state: chainState({ delta: undefined }),
        mounts: mountsAfterAttach(calls),
        calls,
      });
      record.objects.set(deltaObjectKey(CHAIN_ID), DELTA_BYTES);
      expect((await attachOf(record)).kind).toBe('attached');
      // Adopted means SEEDED: the orphan delta is copied into the upper before
      // the overlay lands, exactly like a referenced one.
      expect(record.calls).toContain(`seedUpper:${DEVBOX_RUNTIME_DIR}/lower-delta->${UPPER}`);
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
    });

  test('LIVE WINDOW: a kill between the mount and the seed cannot leave a mounted overlay',
    async () => {
      // THE EXACT WINDOW. In the old order the overlay was mounted first and the
      // delta copied into the upper after it, so a throw here left the overlay
      // UP and the upper HALF-SEEDED — and the retry asked the container, saw an
      // overlay, took `already-attached`, and never finished the copy.
      //
      // The new order makes that state unrepresentable: if the seed dies, the
      // overlay was never mounted, so the retry cannot mistake a partial
      // restoration for a finished one. Killed AT the seed, the container is
      // still plain and the attach refuses.
      const calls: string[] = [];
      const record = harness({
        state: chainState(),
        mounts: mountsAfterAttach(calls),
        calls,
        failSeed: true,
      });
      await expect(attachOf(record)).rejects.toThrow(/upper seeding/);
      // Nothing was mounted over the work directory, so the next attach starts
      // from scratch rather than early-returning over a half-seeded upper.
      expect(record.calls).not.toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
      expect(isOverlayMounted(mountsAfterAttach(calls)(), DEVBOX_WORKDIR)).toBe(false);

      // And the retry, on the same container, completes the whole restoration.
      const retry = await snapshotChainStorage(record.ports).attach();
      expect(retry.kind).toBe('attached');
    });

  test('P1 CONSEQUENCE: a checkpoint cannot launder a half-restored upper into the chain',
    async () => {
      // What made the old defect permanent rather than transient: after a
      // partial attach the box looked ready, and the NEXT checkpoint archived
      // that partial upper as the new delta — so content that was merely
      // unrestored became content the durable chain no longer holds.
      //
      // The refusal that prevents it is the overlay gate. A work directory that
      // is not an overlay has no changed set to archive, so a checkpoint on a
      // box whose attach did not finish reports FAILED and writes nothing.
      const calls: string[] = [];
      const record = harness({
        state: chainState(),
        mounts: mountsAfterAttach(calls),
        calls,
        failSeed: true,
      });
      await expect(attachOf(record)).rejects.toThrow(/upper seeding/);

      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('not an overlay mount');
      // The delta the chain already holds is untouched: nothing was archived
      // over it, so the content the attach failed to restore is still there.
      expect(record.calls).not.toContain(`putObject:${deltaObjectKey(CHAIN_ID)}`);
      expect(record.state?.delta).toEqual({ bytes: DELTA_BYTES });
    });

  test('an already-mounted box does NOT seed again, because the mount proves it happened',
    async () => {
      // The CONSEQUENCE of the ordering, pinned so it stays legible. Once the
      // seed precedes the overlay, a mounted overlay is proof the copy
      // finished, and the `already-attached` early return needs no re-check.
      // If someone later adds a defensive re-seed to that path, this says why
      // it is redundant rather than silently tolerating a second mechanism
      // maintaining an invariant the ordering already guarantees.
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await attachOf(record)).kind).toBe('already-attached');
      expect(record.calls.filter(call => call.startsWith('seedUpper'))).toEqual([]);
      expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
    });

  test('movedBytes: a skip says 0, a failure says undefined, because those differ',
    async () => {
      // Adopted from overlay-cas after it drew the distinction I had missed: my
      // skips reported `undefined`, which conflates "moved nothing" with
      // "cannot say". A skip KNOWS it moved nothing — no PUT was attempted —
      // and that is measurable. A failure cannot know: a checkpoint that threw
      // mid-flight may have landed an object before it failed, so 0 there would
      // assert something the path cannot establish.
      const idle = harness({ state: chainState(), mounts: MOUNTED, running: false });
      const skipped = await checkpointOf(idle, 'tick');
      expect(skipped.kind).toBe('skipped');
      expect(skipped.movedBytes).toBe(0);

      // EVERY skip, not just that one. The others come from a shared literal,
      // and a mutant proved this assertion missed them: reverting that literal
      // to `undefined` failed nothing until this case existed.
      const unchanged = harness({
        state: chainState({ upperMark: 'm1', at: 1 }),
        mounts: MOUNTED,
        upperMark: 'm1',
        now: 10 * INTERVAL_MS,
      });
      const quiet = await checkpointOf(unchanged, 'tick');
      expect(quiet.kind).toBe('skipped');
      expect(quiet.reason).toContain('unchanged');
      expect(quiet.movedBytes).toBe(0);

      // A work directory that is not an overlay: no changed set, so the
      // checkpoint fails rather than archiving the whole tree.
      const broken = harness({ state: chainState() });
      const failed = await checkpointOf(broken, 'quiesce');
      expect(failed.kind).toBe('failed');
      expect(failed.movedBytes).toBeUndefined();
    });

  test('movedBytes: a commit reports what IT moved, which held bytes cannot give you',
    async () => {
      // The reason the field exists: a caller was differencing consecutive held
      // readings and getting NEGATIVE per-tick costs, because a rebase
      // supersedes a generation so held bytes fall while the tick moved a whole
      // fresh archive. Here the two numbers genuinely disagree.
      const record = harness({
        state: chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: undefined, at: 1 }),
        mounts: MOUNTED, now: 10 * INTERVAL_MS,
      });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('committed');
      expect(outcome.movedBytes).toBeGreaterThan(0);
      expect(outcome.movedBytes).not.toBe(outcome.bytes);
    });

  test('a missing base object refuses the start loudly', async () => {
    const record = harness({ state: chainState() });
    record.objects.delete(baseObjectKey(CHAIN_ID));
    await expect(attachOf(record)).rejects.toThrow(/base.*missing|Refusing to start/i);
  });

  test('RUN abc-4: a delta whose recorded size went stale is ADOPTED, not refused',
    async () => {
      // This test used to pin the opposite, and the opposite was a terminal
      // brick. Measured across two deployed runs: `archive 506834944, state
      // declares 506494976`, and twice more, every difference an exact multiple
      // of 4096 — the padding every squashfs archive carries, so the signature
      // of two DIFFERENT archives rather than one archive measured twice. The
      // cause is a crash between the atomic PUT and the state write, which this
      // file's header already says an attach should ADOPT because the mount is
      // the validator. The probe refused on the byte count before the mount
      // could validate anything, and the object never shrinks back to the
      // declared number, so every later operation failed for the rest of the
      // run. One occurrence cost an arm fourteen of its twenty segments.
      const calls: string[] = [];
      const drifted = DELTA_BYTES + 4096;
      const record = harness({
        state: chainState(), mounts: mountsAfterAttach(calls), calls,
      });
      record.objects.set(deltaObjectKey(CHAIN_ID), drifted);

      const outcome = await attachOf(record);

      expect(outcome.kind).toBe('attached');
      // And the record is corrected, so the disagreement cannot outlive the
      // attach that adopted it.
      expect(record.state?.delta).toEqual({ bytes: drifted });
      expect(record.calls.some(call => call.startsWith('log:delta record was stale'))).toBe(true);
    });

  test('a delta the record names and the store does NOT hold is still refused', async () => {
    // The other half, and it must stay a refusal: a missing changed set is real
    // content loss, not a stale number. Serving the base alone would hand the
    // caller a workspace missing everything since it.
    const record = harness({ state: chainState() });
    record.objects.delete(deltaObjectKey(CHAIN_ID));
    await expect(attachOf(record)).rejects.toThrow(/delta archive is missing/);
  });

  test('LIVE DEFECT: every step succeeding with no overlay line FAILS the start', async () => {
    // Run 9cdda407: the chain reported success and the work directory was never
    // an overlay, so the box served the container's own blank disk and called it
    // a restore. The postcondition is the only thing that catches this.
    const record = harness({ state: chainState(), mounts: NOT_MOUNTED });
    await expect(attachOf(record)).rejects.toThrow(/is not an overlay mount/);
  });

  test('LIVE DEFECT: an overlay whose upper does not exist FAILS the start', async () => {
    // A mount line is not enough. With no upper directory nothing the caller
    // writes can be captured, so the box would lose every write silently.
    const calls: string[] = [];
    const record = harness({
      state: chainState(),
      mounts: mountsAfterAttach(calls, MOUNTED_NO_UPPER),
      missingPaths: [UPPER],
      calls,
    });
    await expect(attachOf(record)).rejects.toThrow(/upper directory .* does not exist/);
  });

  test('DEPLOYED DEFECT: the store mount is released through the SDK, never the kernel',
    async () => {
      // The SDK keeps its own registry of bucket mounts and refuses a mount whose
      // path it still believes is in use. A raw `fusermount3` unmounts the
      // filesystem and leaves that claim standing forever, so the next attach is
      // refused for a mount that no longer exists. Deployed symptom: a chain
      // written once and never attachable again, every operation refused.
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      expect((await attachOf(record)).kind).toBe('attached');
      expect(record.calls).toContain('unmountStore');
      // And the store path is never released by path, which would bypass the
      // registry.
      expect(record.calls).not.toContain(`unmountPath:${CHAIN_STORE_MOUNT}`);
      // A stale claim from a previous generation is cleared BEFORE the mount.
      expect(record.calls.indexOf('unmountStore'))
        .toBeLessThan(record.calls.findIndex(call => call.startsWith('mountStore:')));
    });

  test('a chain that already HAS layers never degrades to extraction', async () => {
    // Degrading would hand the caller an empty tree and report success. The
    // start fails instead, carrying the platform's own reason.
    const record = harness({ state: chainState(), refuseStoreMount: true });
    await expect(attachOf(record)).rejects.toThrow(
      /stored as lazy layers and its store subtree could not be mounted.*fuse: device not found/,
    );
  });

  test('local development extracts, and says which mode it used', async () => {
    const record = harness({
      state: chainState({
        mode: 'extract', base: { id: EXTRACT_ID, bytes: DELTA_BYTES }, delta: undefined,
      }),
    });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('attached');
    expect(outcome.detail).toStartWith('extract ');
    expect(record.calls).toContain(`restoreExtract:${EXTRACT_ID}`);
  });

  test('an extraction that lands empty fails the start rather than lying', async () => {
    const record = harness({
      state: chainState({
        mode: 'extract', base: { id: EXTRACT_ID, bytes: DELTA_BYTES }, delta: undefined,
      }),
      entriesAfterExtract: 0,
    });
    await expect(attachOf(record)).rejects.toThrow(/reported success, but the directory is empty/);
  });

  test('an extraction that reports failure fails the start', async () => {
    const record = harness({
      state: chainState({
        mode: 'extract', base: { id: EXTRACT_ID, bytes: DELTA_BYTES }, delta: undefined,
      }),
      extractLands: false,
    });
    await expect(attachOf(record)).rejects.toThrow(/reported failure/);
  });
});

// ── checkpoint ──────────────────────────────────────────────────────────────

describe('checkpoint — gated on real change, proportional to it', () => {
  test('LIVE DEFECT: an unattached chain can answer neither skipped nor committed',
    async () => {
      // Run 9cdda407 answered a FORCED checkpoint "unchanged" while the work
      // directory was not attached. Attachment is therefore asked BEFORE the
      // change gate, so a broken box reports a failure instead of health.
      const record = harness({
        state: chainState(),
        mounts: NOT_MOUNTED,
        change: { status: 'unchanged', version: 'v9' },
      });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('is not an overlay mount');
      // And it never even asked about changes: the question would be about the
      // wrong directory.
      expect(record.calls).not.toContain('checkChanges');
      // The failure is durable, because a thrown scheduled callback is only a
      // console line.
      expect(record.state?.lastFailure?.reason).toContain('not an overlay mount');
    });

  test('LIVE DEFECT: a box with no baseline commits, though checkChanges says unchanged',
    async () => {
      // `checkChanges` answers "changed since the version you hold". A box that
      // has never checkpointed holds none, and the SDK's documented answer to a
      // call with no `since` is `unchanged` — it is establishing a baseline.
      //
      // Reproduced against the real thing before this test existed: a fresh box
      // execed a file into the work directory, `/stop` answered
      // `skipped: work directory is unchanged`, and nothing was ever stored.
      // Every call reported success.
      const record = harness({ state: null, change: { status: 'unchanged', version: 'v1' } });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('committed');
      expect(outcome.bytes).toBeGreaterThan(0);
      // And the baseline is recorded, so the NEXT tick is a real comparison.
      expect(record.state?.changeVersion).toBe('v1');
    });

  test('a periodic tick is not blocked by the same missing baseline', async () => {
    // The interval gate reads the change status, and `unchanged` fails it. With
    // no baseline that status is meaningless, so a tick would have been declined
    // too — for a different stated reason and the same lost bytes.
    const record = harness({ state: null, change: { status: 'unchanged', version: 'v1' } });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
  });

  test('with no baseline, an EMPTY work directory is still declined', async () => {
    // Content is the change only when there is content. Archiving an empty
    // directory would make `committed` mean nothing.
    const record = harness({
      state: null, change: { status: 'unchanged', version: 'v1' }, entriesAfterExtract: 0,
    });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('empty');
  });

  test('a stored record that carries no version is treated as having no baseline', async () => {
    const record = harness({
      state: chainState({ changeVersion: undefined }),
      mounts: MOUNTED,
      change: { status: 'unchanged', version: 'v7' },
    });
    expect((await checkpointOf(record, 'quiesce')).kind).toBe('committed');
  });

  test('the first commit lays the FULL base, with derived trees excluded', async () => {
    const record = harness({ state: null });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(outcome.bytes).toBe(DELTA_BYTES);
    const squashed = record.calls.find(call => call.startsWith('makeSquashfs'));
    expect(squashed).toStartWith(`makeSquashfs:${DEVBOX_WORKDIR}:`);
    expect(squashed).not.toBe(`makeSquashfs:${DEVBOX_WORKDIR}:0`);
    expect(record.calls.some(call => call === `putObject:${baseObjectKey(record.state!.base.id)}`))
      .toBe(true);
    expect(record.state?.delta).toBeUndefined();
  });

  test('LIVE DEFECT: a fresh box can tick and quiesce in its FIRST generation',
    async () => {
      // The whole lifecycle of one container generation, in order, against ONE
      // container — which is what the per-test fixtures could not express, and
      // is why this shipped. A box was born with a plain `/workspace`; its
      // first checkpoint wrote `mode:'chain'` and attached nothing; and from
      // that moment the "not an overlay mount" gate refused every later
      // checkpoint AND the quiesce. So the box filed a checkpoint incident
      // every interval, could not stop gracefully, and lost everything written
      // after the base when the platform finally evicted the container.
      //
      // Being born with an overlay is what makes that state unrepresentable.
      const calls: string[] = [];
      const record = harness({
        state: null,
        mounts: mountsAfterAttach(calls),
        calls,
        now: 10 * INTERVAL_MS,
      });
      const storage = snapshotChainStorage(record.ports);

      expect((await storage.attach()).kind).toBe('empty');
      const base = await storage.checkpoint('quiesce');
      expect(base.kind).toBe('committed');
      expect(record.state?.mode).toBe('chain');

      // The tick that used to fail. The caller wrote between the two calls,
      // which the changed set reflects — a tick over an untouched upper would
      // now correctly skip, and did while this line was missing.
      record.upperMark = '9:8192:1700000900';
      record.state = { ...record.state!, at: 0 };
      const tick = await storage.checkpoint('tick');
      expect({ kind: tick.kind, reason: tick.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });

      // And the final one, which is what a graceful stop depends on: `quiesce()`
      // refuses to stop the container when this fails.
      record.upperMark = '11:12288:1700001800';
      const final = await storage.checkpoint('quiesce');
      expect({ kind: final.kind, reason: final.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });
      // The writes after the base landed in a delta, rather than being lost.
      expect(record.state?.delta).toEqual({ bytes: DELTA_BYTES });
    });

  test('a delta that outgrew its base collapses onto a fresh generation at the stop',
    async () => {
      // The chain uploads the WHOLE cumulative delta every checkpoint, so once
      // the delta passes the base every later commit moves more bytes than a
      // fresh base would cost. The collapse writes a NEW generation id, and the
      // old generation's objects go only AFTER the record naming the new one is
      // durable — so a crash leaves two generations and never zero.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 },
          delta: { bytes: 4_000 },
          at: 1,
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      const outcome = await checkpointOf(record, 'quiesce');

      expect(outcome.kind).toBe('committed');
      const collapsed = record.state!;
      expect(collapsed.base.id).not.toBe(CHAIN_ID);
      expect(collapsed.delta).toBeUndefined();
      // The whole merged tree, with the box's exclude policy applied.
      expect(record.calls.some(c => c.startsWith(`makeSquashfs:${DEVBOX_WORKDIR}:`))).toBe(true);
      // ORDER: new generation written, record flipped, THEN the old one deleted.
      const wrote = record.calls.findIndex(c => c.startsWith('writeState:'));
      const deleted = record.calls.findIndex(c => c.startsWith('deleteObjects'));
      expect(wrote).toBeGreaterThan(-1);
      expect(deleted).toBeGreaterThan(wrote);
    });

  test('a superseded generation is named before it is deleted, and the sweep is re-runnable',
    async () => {
      // LEAN FINDING stored_generations_are_unbounded: a crash between the
      // rebase's state flip and the old generation's deletion used to orphan
      // that generation forever, because nothing anywhere still named it. It
      // cannot be found by listing either — `backups/<uuid>/` is shared by
      // every box, so a sweep that enumerated it would see other boxes' live
      // generations. The record names them instead.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 }, at: 1,
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      await checkpointOf(record, 'quiesce');

      // The superseded generation was NAMED in a record that landed before any
      // delete, and is forgotten only once the delete is done.
      const named = record.calls.findIndex(c => c.startsWith('writeState:'));
      const deleted = record.calls.findIndex(c => c.startsWith('deleteObjects'));
      expect(named).toBeLessThan(deleted);
      expect(record.state?.orphans).toBeUndefined();
      // The old generation's objects are gone; the referenced one is untouched.
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(false);
      expect(record.objects.has(baseObjectKey(record.state!.base.id))).toBe(true);
    });

  test('a crash before the sweep leaves an id the NEXT checkpoint cleans up', async () => {
    // Re-runnable is the property: the ids sit in the record until a run
    // finishes deleting them, and the referenced generation is never among them.
    const stranded = 'a1b2c3d4-0000-4000-8000-0000000000ff';
    const record = harness({
      state: chainState({ orphans: [stranded] }),
      mounts: MOUNTED,
    });
    record.objects.set(baseObjectKey(stranded), 4_096);
    await checkpointOf(record, 'quiesce');

    expect(record.objects.has(baseObjectKey(stranded))).toBe(false);
    expect(record.state?.orphans).toBeUndefined();
    // The live generation survived the sweep that removed the stranded one.
    expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
  });

  test('VERDICT-2: excludes shrink BOTH archives, so they cannot trip the rebase ratio',
    async () => {
      // The measured defect: excludes applied to the base only. `shouldRebase`
      // asks `delta > k * base`, so a small excludes-applied base against a
      // delta measured WITHOUT them is satisfied essentially always — a full
      // re-archive at every quiesce that the unexcluded arm never performs.
      // Verdict-2 measured the excluded chain arm at 1.42x tick time and 1.34x
      // class-A of the plain one, so the policy was costing where it was meant
      // to save, and paying for rebases rather than for filtering.
      //
      // The invariant that prevents it: both archives are measured under the
      // same excludes, so the ratio compares like with like.
      const record = harness({
        state: chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: undefined, at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      await checkpointOf(record, 'quiesce');

      const staged = record.calls.filter(call => call.startsWith('makeSquashfs:'));
      const excluded = staged.filter(call => call.endsWith(`:${CHAIN_EXCLUDES.length}`));
      // Every archive this commit staged applied the policy. A single `:0`
      // among them is the half-application that was measured.
      expect(staged.length).toBeGreaterThan(0);
      expect(excluded).toEqual(staged);
    });

  test('VERDICT-2: the rebase ratio reads two numbers gathered the same way', () => {
    // Stated as the property rather than as a scenario, because the defect was
    // never a bad threshold — k is fine. It was that the two sides of the
    // comparison were measured under different rules, which no value of k can
    // repair.
    const tiny = chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: { bytes: 400_000 } });
    const whole = chainState({ base: { id: CHAIN_ID, bytes: 420_000 }, delta: { bytes: 400_000 } });
    // Under the OLD half-applied policy these two were the SAME workspace: an
    // excluded base of 20k against an unexcluded delta of 400k, versus an
    // unexcluded base of 420k against the same delta. One rebased at every
    // quiesce and the other never did.
    expect(shouldRebase(tiny, 'quiesce')).toBe(true);
    expect(shouldRebase(whole, 'quiesce')).toBe(false);
    // With both sides measured alike, that workspace has one description, and
    // its delta is the small one — which is the saving the policy promised.
    const alike = chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: { bytes: 4_000 } });
    expect(shouldRebase(alike, 'quiesce')).toBe(false);
  });

  test('a tick never rebases, however far the delta has run ahead', async () => {
    // Collapsing means the upper must end up empty, and emptying a live upper
    // races every writer in the container. A tick therefore appends; the stop
    // is what collapses.
    const record = harness({
      state: chainState({ base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 9_000 }, at: 1 }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
    });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
    expect(record.state?.base.id).toBe(CHAIN_ID);
    expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
  });

  test('no room to stage is a FAILED checkpoint naming the shortfall, never a crash',
    async () => {
      // An archiver that fills the container disk takes the box down with it.
      const record = harness({ state: chainState(), mounts: MOUNTED, freeBytes: 1 });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('Refusing to archive');
      // Nothing was archived and nothing was recorded as archived.
      expect(record.calls.filter(c => c.startsWith('makeSquashfs'))).toEqual([]);
    });

  test('every later commit archives ONLY the upper, into the one replaceable delta',
    async () => {
      const record = harness({ state: chainState(), mounts: MOUNTED });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('committed');
      // ONE MEANING FOR `bytes`: what this box durably holds after the commit,
      // which is base plus delta. The delta's own size is not the same
      // quantity, and reporting it here made this field mean layer-size on this
      // strategy and corpus-size on r2fs — two measurements under one name.
      expect(outcome.bytes).toBe(BASE_BYTES + DELTA_BYTES);
      // The changed set, not the tree — under the SAME excludes as the base.
      // See the commit path: applying them to one side only delivered no saving
      // and made the rebase ratio compare incommensurable quantities.
      expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
      expect(record.calls).toContain(`putObject:${deltaObjectKey(CHAIN_ID)}`);
      // The base is untouched: same id, same bytes, and no PUT against its key.
      expect(record.state?.base).toEqual({ id: CHAIN_ID, bytes: BASE_BYTES });
      expect(record.calls).not.toContain(`putObject:${baseObjectKey(CHAIN_ID)}`);
    });

  test('CRASH ORDERING: the state write lands before any cleanup', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED });
    await checkpointOf(record, 'tick');
    const put = record.calls.indexOf(`putObject:${deltaObjectKey(CHAIN_ID)}`);
    const wrote = record.calls.findIndex(call => call.startsWith('writeState:2:'));
    const cleaned = record.calls.lastIndexOf('exec:rm');
    // PUT, then record, then clean up. A crash between the PUT and the record
    // leaves a complete delta that the next attach adopts; the other order
    // could delete the only copy of it.
    expect(put).toBeLessThan(wrote);
    expect(wrote).toBeLessThan(cleaned);
  });

  test('an unchanged CHANGED SET costs nothing, and only an exact match counts', async () => {
    // The gate compares the upper's own fingerprint against the one recorded at
    // the last commit, because the upper IS what a delta archives. Asking the
    // merged mount instead is what let five ticks skip over 400 MiB of npm.
    const settled = '7:4096:1700000000';
    const record = harness({
      state: chainState({ upperMark: settled }),
      mounts: MOUNTED,
      upperMark: settled,
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('unchanged');
    expect(record.calls.filter(call => call.startsWith('makeSquashfs'))).toEqual([]);
  });

  test('RUN abc-3: a workspace that CHANGED can no longer read as unchanged',
    async () => {
      // THE DATA-LOSS WINDOW, verbatim from the deployed A/B/C. Five consecutive
      // chain ticks answered `skipped (work directory is unchanged)` while npm
      // wrote 400 MiB, and the next workload's first tick then committed 487
      // MiB of it — the work survived only because a later tick happened to
      // catch it. The gate had been asking the SDK about the merged
      // `/workspace` while a delta archives `upperDir`.
      const settled = '120:4096:1700000000';
      const record = harness({
        state: chainState({ upperMark: settled, at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      // npm lands in the upper. Nothing else about the box changes.
      record.upperMark = '48000:419430400:1700000900';

      const outcome = await checkpointOf(record, 'tick');

      expect({ kind: outcome.kind, reason: outcome.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });
      expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
      // And the record now carries what it archived, so the NEXT tick over an
      // untouched upper is the one that skips.
      expect(record.state?.upperMark).toBe('48000:419430400:1700000900');
    });

  test('a tick that CANNOT decide commits rather than skipping', async () => {
    // "Unreadable" is not "unchanged". If the fingerprint probe fails — the
    // container is mid-replacement, find is unavailable, the upper is gone —
    // the honest answer is to archive, because the alternative is the window
    // above with no evidence that anything was lost.
    const record = harness({
      state: chainState({ upperMark: '120:4096:1700000000', at: 1 }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
      upperMark: '',
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
  });

  test('an empty fingerprint is never recorded as a match, so it cannot latch', async () => {
    // The corollary: a failed probe must not be WRITTEN as the new mark, or the
    // next failed probe would compare equal to it and skip forever.
    const record = harness({
      state: chainState({ upperMark: '', at: 1 }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
      upperMark: '',
    });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
  });

  test('RUN abc-3: the record carries what LANDED, so the next wake is not refused',
    async () => {
      // `delta archive is 702791680 bytes, state declares 700387328` — every arm,
      // every wake refused, no arm measured one. The staged size is taken before
      // the bytes are read and a file still settling reads short, so the record
      // described something the store did not hold and the integrity probe
      // correctly refused every attach afterwards.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        stagedReport: '0 700387328',
        landedBytes: 702791680,
      });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('committed');

      // The record agrees with the object, which is the whole point.
      expect(record.state?.delta).toEqual({ bytes: 702791680 });
      expect(record.objects.get(deltaObjectKey(CHAIN_ID))).toBe(702791680);
      // EVERY STATE SIZE COMES FROM A COMPLETED UPLOAD. There are four writers
      // of a size into the record — the commit's own layer, the extract path's
      // stored base, and the adoption below — and each one's provenance is
      // either `putObject`'s returned landed count or an R2 head of a finished
      // object. None is a mid-write stat, which is the measurement that read
      // 4096-multiples low on the deployed runs.
      expect(record.state?.delta?.bytes).toBe(702791680);
      expect(record.state?.delta?.bytes).not.toBe(700387328);
      // And the consequence that was actually measured: the wake attaches.
      const wokenCalls: string[] = [];
      const woken = harness({
        state: record.state, mounts: mountsAfterAttach(wokenCalls), calls: wokenCalls,
      });
      woken.objects.set(baseObjectKey(CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(CHAIN_ID), 702791680);
      const attached = await snapshotChainStorage(woken.ports).attach();
      expect(attached.kind).toBe('attached');
    });

  test('RUN abc-4: an archive that settles larger than ANY mid-write stat still attaches',
    async () => {
      // Main's extension of the consequence test, and the sharpest form of it:
      // the staged measurement is short by whole 4096-blocks — 83 of them, the
      // smallest real instance — and the upload lands the true size. The record
      // must carry the landed number, and the wake that reads it must attach
      // rather than refuse. A record wired to the stat instead of the upload
      // fails here with the exact production message.
      const staged = 506494976;
      const landed = 506834944;
      expect((landed - staged) % 4096).toBe(0);

      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        stagedReport: `0 ${staged}`,
        landedBytes: landed,
      });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
      expect(record.state?.delta).toEqual({ bytes: landed });

      const wokenCalls: string[] = [];
      const woken = harness({
        state: record.state, mounts: mountsAfterAttach(wokenCalls), calls: wokenCalls,
      });
      woken.objects.set(baseObjectKey(CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(CHAIN_ID), landed);
      expect((await snapshotChainStorage(woken.ports).attach()).kind).toBe('attached');
    });

  test('RUN abc-3: an archiver that claims success and leaves no file FAILS by name',
    async () => {
      // `staged archive /var/tmp/devbox/stage/layer.sqsh has no size; the
      // archiver did not land`, three times in one run. mksquashfs reported exit
      // 0 and a separate stat exec found nothing — a container replaced between
      // two RPCs. Build and measure are one command now, so a success with no
      // file is the archiver's own contradiction and is reported as such.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        stagedReport: '0 0',
      });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('mksquashfs reported success');
      // Nothing was recorded over the delta the chain already holds.
      expect(record.state?.delta).toEqual({ bytes: DELTA_BYTES });
    });

  test('a change inside the interval is declined WITHOUT forgetting it', async () => {
    const record = harness({ state: chainState({ at: 1 }), mounts: MOUNTED, now: 2 });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('interval');
    // NOT advanced. Advancing here would discard the change signal and the next
    // tick would believe the work was already saved.
    expect(record.state?.changeVersion).toBe('v1');
  });

  test('a quiesce skips the interval gate but NEVER the change gate', async () => {
    const settled = '7:4096:1700000000';
    const idle = harness({
      state: chainState({ upperMark: settled }), mounts: MOUNTED, upperMark: settled,
    });
    expect((await checkpointOf(idle, 'quiesce')).kind).toBe('skipped');

    const due = harness({
      state: chainState({ at: 1, upperMark: 'stale' }), mounts: MOUNTED, now: 2,
    });
    const outcome = await checkpointOf(due, 'quiesce');
    expect(outcome.kind).toBe('committed');
    expect(outcome.bytes).toBe(BASE_BYTES + DELTA_BYTES);
  });

  test('lost change state is treated as changed and is archived', async () => {
    const record = harness({
      state: chainState(), mounts: MOUNTED, change: { status: 'resync', version: 'v3' },
    });
    expect((await checkpointOf(record, 'quiesce')).kind).toBe('committed');
  });

  test('a failed PUT leaves the previous record intact and records the reason', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED, failPut: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.bytes).toBeUndefined();
    expect(record.state?.rev).toBe(1);
    expect(record.state?.base).toEqual({ id: CHAIN_ID, bytes: BASE_BYTES });
    expect(record.state?.lastFailure?.reason).toContain('store unreachable');
  });

  test('a checkChanges failure is a recorded failure, not a silent skip', async () => {
    const record = harness({
      state: chainState(), mounts: MOUNTED, change: new Error('change state gone'),
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('change state gone');
  });

  test('a stopped container is asked nothing at all', async () => {
    const record = harness({ running: false, state: chainState() });
    expect((await checkpointOf(record, 'tick')).kind).toBe('skipped');
    expect(record.calls).toEqual([]);
  });

  test('DEPLOYED DEFECT: a refused mount where extraction is not permitted FAILS',
    async () => {
      // Measured on a deployed probe: a failed mount was converted into
      // extraction, the box archived a base, and every write after it was lost.
      // The loss surfaced two phases later as "delta content lost across
      // restore". A failure has to be a failure, carrying the mount's reason.
      const record = harness({
        state: null, refuseStoreMount: true, allowExtraction: false,
      });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('extraction is not permitted');
      expect(outcome.reason).toContain('fuse: device not found');
      // And nothing was archived, so no record can claim otherwise.
      expect(record.state).toBeNull();
    });

  test('DEPLOYED DEFECT: an extract record is refused where extraction is not permitted',
    async () => {
      // Such a record can only have come from a host that allowed it. Serving it
      // on a host that does not would hide the silent fallback a second time.
      const record = harness({
        state: chainState({
          mode: 'extract', base: { id: EXTRACT_ID, bytes: DELTA_BYTES }, delta: undefined,
        }),
        allowExtraction: false,
      });
      await expect(attachOf(record)).rejects.toThrow(/archived by extraction, which is not permitted/);
    });

  test('with no base yet and extraction permitted, a refused chain degrades ONCE',
    async () => {
      const record = harness({ state: null, refuseStoreMount: true });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('committed');
      expect(record.state?.mode).toBe('extract');
      // The mount was PROVEN, not predicted: the proof ran before anything was
      // written. Matched on the call's prefix because the chain id is minted
      // inside the commit and then discarded when the degrade happens.
      expect(record.calls.some(call => call.startsWith('mountStore:'))).toBe(true);
      // And the reason travels: a degrade nobody can explain is a degrade
      // nobody notices.
      expect(record.calls.some(call =>
        call.startsWith('log:extraction is permitted')
        && call.includes('fuse: device not found'))).toBe(true);
    });

  test('extraction stays whole-tree and supersedes only AFTER recording', async () => {
    const record = harness({
      state: chainState({
        mode: 'extract', base: { id: EXTRACT_ID, bytes: 1 }, delta: undefined,
      }),
    });
    record.objects.set(baseObjectKey(EXTRACT_ID), 1);
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    const wrote = record.calls.findIndex(call => call.startsWith('writeState:'));
    const deleted = record.calls.findIndex(call => call.startsWith('deleteObjects:'));
    // A crash between them leaves TWO archives, never zero.
    expect(wrote).toBeLessThan(deleted);
    expect(record.objects.has(baseObjectKey(EXTRACT_ID))).toBe(false);
  });
});

// ── discard ─────────────────────────────────────────────────────────────────

describe('discard — objects before the pointer', () => {
  test('all three keys go, and only then the record', async () => {
    const record = harness({ state: chainState() });
    await snapshotChainStorage(record.ports).discard();
    const deleted = record.calls.findIndex(call => call.startsWith('deleteObjects:'));
    const cleared = record.calls.indexOf('clearState');
    // Reversed, a crash orphans both: nothing would name the objects and
    // nothing would delete them.
    expect(deleted).toBeLessThan(cleared);
    expect(record.calls).toContain('deleteObjects:3');
    for (const key of [baseObjectKey(CHAIN_ID), deltaObjectKey(CHAIN_ID),
      metadataObjectKey(CHAIN_ID)]) {
      expect(record.objects.has(key)).toBe(false);
    }
    expect(record.state).toBeNull();
  });

  test('discarding a box with no record touches nothing', async () => {
    const record = harness({ state: null });
    await snapshotChainStorage(record.ports).discard();
    expect(record.calls).toEqual([]);
  });
});

// ── the denominator ─────────────────────────────────────────────────────────
//
// The suite's own coverage of the implementation's enumerations. Adding an
// outcome kind without exercising it here turns these red, so the suite cannot
// quietly stop covering a decision it exists to guard.

describe('denominator', () => {
  test('every attach outcome kind was produced above', () => {
    expect([...seenAttach].sort()).toEqual([...ATTACH_OUTCOME_KINDS].sort());
  });

  test('every checkpoint outcome kind was produced above', () => {
    expect([...seenCheckpoint].sort()).toEqual([...CHECKPOINT_OUTCOME_KINDS].sort());
  });
});


// ── accepted review findings ────────────────────────────────────────────────

describe('discard sweeps every generation the record still names', () => {
  test('orphaned generations go with the referenced one, before clearState', async () => {
    // A rebase crash between the state flip and the sweep leaves ids in
    // `orphans`. clearState erases the only record naming them and
    // `backups/<uuid>/` is shared by every box — so a discard that ignored the
    // list leaked those objects permanently.
    const stranded = 'a1b2c3d4-0000-4000-8000-0000000000ff';
    const record = harness({ state: chainState({ orphans: [stranded] }) });
    for (const id of [CHAIN_ID, stranded]) {
      record.objects.set(baseObjectKey(id), BASE_BYTES);
      record.objects.set(deltaObjectKey(id), DELTA_BYTES);
      record.objects.set(metadataObjectKey(id), 64);
    }

    await snapshotChainStorage(record.ports).discard();

    const deleted = record.calls.findIndex(call => call.startsWith('deleteObjects:'));
    const cleared = record.calls.indexOf('clearState');
    expect(deleted).toBeLessThan(cleared);
    expect(record.calls).toContain('deleteObjects:6');
    for (const id of [CHAIN_ID, stranded]) {
      for (const key of [baseObjectKey(id), deltaObjectKey(id), metadataObjectKey(id)]) {
        expect(record.objects.has(key)).toBe(false);
      }
    }
    expect(record.state).toBeNull();
  });
});

describe('attachChain resets only its OWN directories', () => {
  test('no rm -rf ever names the read-only store mount', async () => {
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
    const raw: string[] = [];
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      raw.push(command);
      return await inner(command);
    };

    expect((await attachOf(record)).kind).toBe('attached');

    const resets = raw.filter(command => command.startsWith('rm -rf'));
    expect(resets.length).toBeGreaterThan(0);
    for (const command of resets) {
      expect(command).not.toContain(CHAIN_STORE_MOUNT);
    }
  });

  test('a failed reset is a NAMED failure, never a silent pass', async () => {
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      if (command.startsWith('rm -rf')) {
        return { stdout: '', stderr: 'rm: cannot remove: Read-only file system', exitCode: 1 };
      }
      return await inner(command);
    };

    await expect(attachOf(record)).rejects.toThrow(/resetting directories/);
    // And nothing ran on top of an unreset container: no layer was mounted.
    expect(calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
  });
});


/** The whole second both fingerprint marks land in. */
const T_SAME = 1_700_000_000;

describe('the skip-gate fingerprint keeps sub-second mtime', () => {
  test('a same-size same-second rewrite changes the mark', () => {
    // THE RED PROOF, against the real find|awk pipeline. The old `%d` format
    // truncated both marks below to the same whole second and matched — the
    // narrow unchanged-lie window this gate exists to keep shut. The integer
    // parts agree here on purpose: that is exactly the case the fraction
    // decides.
    const dir = scratchDir('devbox-fingerprint');
    try {
      const file = join(dir, 'w.txt');
      writeFileSync(file, 'aaaaaaaaaa');
      utimesSync(file, T_SAME + 0.25, T_SAME + 0.25);
      const run = (): string => {
        const proc = Bun.spawnSync(['sh', '-c', upperFingerprintCommand(dir)]);
        if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
        return proc.stdout.toString().trim();
      };
      const first = run();

      writeFileSync(file, 'bbbbbbbbbb'); // SAME SIZE
      utimesSync(file, T_SAME + 0.25, T_SAME + 0.75); // SAME SECOND, later fraction
      const second = run();

      const m1 = Number(first.split(':')[2]);
      const m2 = Number(second.split(':')[2]);
      expect(Math.trunc(m1)).toBe(T_SAME);
      expect(Math.trunc(m2)).toBe(T_SAME);
      expect(first).not.toBe(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
