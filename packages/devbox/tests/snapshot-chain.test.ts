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
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';

import {
  archiveCommand,
  archiveExcludeFile,
  archiveSizeCommand,
  baseObjectKey,
  chainBackupOptions,
  CHAIN_EXCLUDES,
  CHAIN_STORE_MOUNT,
  deltaObjectKey,
  isOverlayMounted,
  metadataObjectKey,
  shouldRebase,
  snapshotChainStorage,
  supersedeGeneration,
  upperFingerprintCommand,
  type ChainBaseLayer,
  type ChainGeneration,
  type ChainLayer,
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
/** The generation a record retains as its restore fallback. */
const FALLBACK_ID = 'a1b2c3d4-0000-4000-8000-0000000000fb';
const FALLBACK_BYTES = 2_048;
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

/** A stand-in for the SHA-256 an upload reports: deterministic per key and
 *  size, so a test can predict what the record should carry, and different for
 *  different content, which is the whole property under test. */
function digestOf(key: string, bytes: number): string {
  return createHash('sha256').update(`${key}:${bytes}`).digest('hex');
}

/** A stand-in for the version the STORE mints per upload. Deterministic the
 *  same way, and distinct from the digest, because the two are separate facts:
 *  a replacement can carry a matching digest and cannot carry a matching
 *  version. */
function versionOf(key: string, bytes: number): string {
  return `upload-${createHash('sha256').update(`${key}:${bytes}`).digest('hex').slice(0, 12)}`;
}

/** The base descriptor a record carries for a generation of this size. */
function baseLayer(id: string, bytes: number): ChainBaseLayer {
  return {
    id,
    bytes,
    digest: digestOf(baseObjectKey(id), bytes),
    objectVersion: versionOf(baseObjectKey(id), bytes),
  };
}

/** The delta descriptor a record carries for a generation of this size. */
function deltaLayer(id: string, bytes: number): ChainLayer {
  return {
    bytes,
    digest: digestOf(deltaObjectKey(id), bytes),
    objectVersion: versionOf(deltaObjectKey(id), bytes),
  };
}

interface Harness {
  readonly ports: SnapshotChainPorts;
  /** Every port call, in order. The ordering assertions read this. */
  readonly calls: string[];
  /** The store, as key to size. Omitting a key is a missing object; a
   *  disagreeing size is a corrupt one. */
  readonly objects: Map<string, number>;
  /** The digest the STORE reports per key, which is how a same-length
   *  replacement is expressed: same size, different digest. */
  readonly digests: Map<string, string>;
  /** The upload version the STORE reports per key. A same-length replacement
   *  that even copies the digest still cannot copy this. */
  readonly versions: Map<string, string>;
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
 * The exclude list an archiver command really stages, as patterns.
 *
 * The list travels as base64 inside the command, so nothing a caller writes can
 * become shell syntax. Reading it back here is what makes an assertion about
 * exclude POLICY rather than about argument spelling. The non-anchored twin of
 * each pattern is dropped, so the count is the policy's own length.
 */
function excludePatternsOf(command: string): readonly string[] {
  const encoded = /printf %s '(?<data>[A-Za-z0-9+/=]*)'/.exec(command)?.groups?.data ?? '';
  return atob(encoded).split('\n')
    .filter(line => line !== '' && !line.startsWith('... '));
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
  const unmounted = /fusermount3 -u(?:z)? '(?<path>[^']+)'/.exec(command)?.groups?.path;
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
    // The build, its exclude list and its measurement are ONE command, so the
    // fake answers all three: it counts the policy the archiver will really
    // apply — decoded from the list the command stages — and reports
    // `<exit> <bytes>`.
    return {
      call: `makeSquashfs:${squash}:${excludePatternsOf(command).length}`,
      stdout: stagedSize,
    };
  }
  if (command.includes('sort -z') && command.includes('sha256sum')) {
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
  generations?: string[];
  entriesAfterExtract?: number;
  running?: boolean;
  change?: { status: ChangeStatus; version: string } | Error;
  now?: number;
  failPut?: boolean;
  /** The store refuses every delete. The post-publication sweep runs on it. */
  failDelete?: boolean;
  /** Which `writeState` calls reject, by 1-based order of arrival. `[2]` fails
   *  only the post-commit failure stamp, which is the one durable write that
   *  happens after a record is already published. */
  rejectWrites?: readonly number[];
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
  /** The digest the upload reports, when a test needs to pin it. */
  landedDigest?: string;
  /** The upload version the store reports, when a test needs to pin it. */
  landedVersion?: string;
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
  const generations = [...(overrides.generations ?? [])];
  const calls = overrides.calls ?? [];
  const objects = new Map<string, number>();
  /** What the STORE reports as an object's own digest. A key absent here is an
   *  object R2 was never handed a checksum for — every multipart upload — which
   *  reads as unknown, not as unsound. */
  const digests = new Map<string, string>();
  /** What the STORE reports as an object's own upload version. R2 always has
   *  one; a key absent here is this fake saying otherwise, which is how a
   *  pre-version record is expressed. */
  const versions = new Map<string, string>();
  let state = overrides.state ?? null;
  const staged = overrides.mounts ?? NOT_MOUNTED;
  const mounts = (): string => (staged instanceof Function ? staged() : staged);
  let extractSeq = 3;
  let seedDied = false;
  let liveMark = overrides.upperMark ?? '7:4096:1700000000';
  let writes = 0;

  const ports: SnapshotChainPorts = {
    containerRunning: () => overrides.running ?? true,
    allowExtraction: () => overrides.allowExtraction ?? true,
    archiveExcludes: () => overrides.archiveExcludes ?? CHAIN_EXCLUDES,
    readState: () => Promise.resolve(state),
    writeState: (next) => {
      writes += 1;
      const rejected = overrides.rejectWrites?.includes(writes) === true;
      calls.push(
        `writeState:${next.rev}:${next.base.id}:${next.delta === undefined ? 'base' : 'delta'}`
        + `${next.lastFailure === undefined ? '' : ':failed'}${rejected ? ':rejected' : ''}`,
      );
      // A rejected put changes nothing durable, which is the whole point: the
      // record a reader would find next is still the one before this call.
      if (rejected) return Promise.reject(new Error('durable storage unreachable'));
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
    containerGeneration: async () => {
      if (generations.length > 1) return generations.shift();
      return generations[0];
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
      const digest = overrides.landedDigest ?? digestOf(key, landed);
      const objectVersion = overrides.landedVersion ?? versionOf(key, landed);
      objects.set(key, landed);
      digests.set(key, digest);
      versions.set(key, objectVersion);
      // What LANDED, which is what the record must carry: the count AND both
      // identities, because a count cannot tell one archive from another
      // archive of the same length.
      return Promise.resolve({ bytes: landed, digest, objectVersion });
    },
    objectFacts: (key) => {
      calls.push(`objectFacts:${key}`);
      const bytes = objects.get(key);
      if (bytes === undefined) return Promise.resolve(undefined);
      // The STORE's own answers. An absent digest is what R2 gives for an
      // object it was never handed a checksum for, which is every multipart
      // upload; an absent version is only how this fake expresses a store that
      // has none, which R2 never is.
      return Promise.resolve({
        bytes,
        digest: digests.get(key),
        objectVersion: versions.get(key),
      });
    },
    deleteObjects: (keys) => {
      calls.push(`deleteObjects:${keys.length}`);
      if (overrides.failDelete === true) return Promise.reject(new Error('store unreachable'));
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

  // Pre-seed whatever layers the starting state references — both roles, since
  // a restore verifies the fallback the same way it verifies the current
  // generation — so an integrity probe passes unless a test deliberately breaks
  // it. The store agrees with the record about both identities too: a test that
  // wants a same-length replacement sets `digests` or `versions` to something
  // else.
  const seed = (key: string, layer: ChainLayer): void => {
    objects.set(key, layer.bytes);
    if (layer.digest !== undefined) digests.set(key, layer.digest);
    if (layer.objectVersion !== undefined) versions.set(key, layer.objectVersion);
  };
  for (const generation of state === null
    ? []
    : [state, ...(state.fallback === undefined ? [] : [state.fallback])]) {
    seed(baseObjectKey(generation.base.id), generation.base);
    if (generation.delta !== undefined) {
      seed(deltaObjectKey(generation.base.id), generation.delta);
    }
  }
  return {
    ports,
    calls,
    objects,
    digests,
    versions,
    get state() { return state; },
    set state(next) { state = next; },
    /** What the changed set fingerprints to RIGHT NOW. Setting it is how a test
     *  says "the caller wrote something" between two checkpoints. */
    get upperMark() { return liveMark; },
    set upperMark(next) { liveMark = next; },
  };
}

/** A layer as a test writes it: the digest is optional, because the point of a
 *  test is usually the sizes, and the store agrees with the record by default. */
interface LayerLiteral {
  readonly id?: string;
  readonly bytes: number;
  readonly digest?: string | undefined;
  readonly objectVersion?: string | undefined;
}

interface GenerationLiteral {
  readonly base: LayerLiteral & { readonly id: string };
  readonly delta?: LayerLiteral | undefined;
}

type StateLiteral = Omit<Partial<ChainState>, 'base' | 'delta' | 'fallback'> & {
  readonly base?: LayerLiteral & { readonly id: string };
  readonly delta?: LayerLiteral | undefined;
  readonly fallback?: GenerationLiteral | undefined;
};

/** Fill in the identities the upload would have recorded, so a test only spells
 *  one when that identity is what it is about. Spelling `digest: undefined` or
 *  `objectVersion: undefined` explicitly means what it says — the row of a box
 *  that checkpointed before those fields existed — so it is honoured rather
 *  than defaulted. */
function generationLiteral(literal: GenerationLiteral): ChainGeneration {
  const layer = (key: string, spelled: LayerLiteral): ChainLayer => ({
    bytes: spelled.bytes,
    digest: 'digest' in spelled ? spelled.digest : digestOf(key, spelled.bytes),
    objectVersion: 'objectVersion' in spelled
      ? spelled.objectVersion
      : versionOf(key, spelled.bytes),
  });
  return {
    base: {
      id: literal.base.id,
      ...layer(baseObjectKey(literal.base.id), literal.base),
    },
    delta: literal.delta === undefined
      ? undefined
      : layer(deltaObjectKey(literal.base.id), literal.delta),
  };
}

function chainState(over: StateLiteral = {}): ChainState {
  const { base, delta, fallback, ...rest } = over;
  return {
    mode: 'chain',
    rev: 1,
    ...generationLiteral({
      base: base ?? { id: CHAIN_ID, bytes: BASE_BYTES },
      delta: 'delta' in over ? delta : { bytes: DELTA_BYTES },
    }),
    at: 0,
    changeVersion: 'v1',
    upperMark: undefined,
    fallback: fallback === undefined ? undefined : generationLiteral(fallback),
    orphans: undefined,
    lastFailure: undefined,
    ...rest,
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
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
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
      // A DIFFERENT archive, which is what a crash between the PUT and the state
      // write leaves: another size and another identity under the same key.
      const landed = digestOf(deltaObjectKey(CHAIN_ID), drifted);
      const landedVersion = versionOf(deltaObjectKey(CHAIN_ID), drifted);
      record.digests.set(deltaObjectKey(CHAIN_ID), landed);
      record.versions.set(deltaObjectKey(CHAIN_ID), landedVersion);

      const outcome = await attachOf(record);

      expect(outcome.kind).toBe('attached');
      // And the record is corrected, so the disagreement cannot outlive the
      // attach that adopted it — the digest with the size, because the record
      // must describe the archive it just served.
      expect(record.state?.delta)
        .toEqual({ bytes: drifted, digest: landed, objectVersion: landedVersion });
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
      // The writes after the base landed in a delta, rather than being lost —
      // under the generation this box minted for itself.
      const generation = record.state!.base.id;
      expect(record.state?.delta).toEqual(deltaLayer(generation, DELTA_BYTES));
    });

  test('a delta that outgrew its base collapses onto a fresh generation at the stop',
    async () => {
      // The chain uploads the WHOLE cumulative delta every checkpoint, so once
      // the delta passes the base every later commit moves more bytes than a
      // fresh base would cost. The collapse writes a NEW generation id, and the
      // outgoing generation is RETAINED as the restore fallback — so a crash
      // here leaves two generations and never zero.
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
      // ORDER: the record naming the new generation lands, and the old one is
      // still there afterwards under the fallback role.
      expect(record.calls.findIndex(c => c.startsWith('writeState:'))).toBeGreaterThan(-1);
      expect(record.calls.filter(c => c.startsWith('deleteObjects'))).toEqual([]);
      expect(collapsed.fallback?.base.id).toBe(CHAIN_ID);
    });

  test('a superseded generation is RETAINED as the restore fallback, not deleted',
    async () => {
      // KINU-015: the rebase's own sweep used to delete the outgoing generation
      // in the SAME commit, so from that moment the box held exactly one copy of
      // itself — and a base object that went missing bricked every later attach
      // with nothing left to try. The outgoing generation is now the fallback a
      // restore falls back to, and it goes only once a newer generation has been
      // proven by an attach.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 }, at: 1,
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      await checkpointOf(record, 'quiesce');

      expect(record.state?.fallback)
        .toEqual(generationLiteral({ base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 } }));
      expect(record.state?.orphans).toBeUndefined();
      // NOTHING was deleted, so both generations are whole and both are named.
      expect(record.calls.filter(c => c.startsWith('deleteObjects'))).toEqual([]);
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(record.state!.base.id))).toBe(true);
    });

  test('a second unproven publication orphans the UNPROVEN generation, never the proven one',
    async () => {
      // The bound is the two roles, not the traffic: however many publications
      // land with no restart between them, the record keeps one proven
      // generation and one current one. The proven fallback is all a restore has
      // left, so it is never the one evicted — and the unproven generation this
      // rebase supersedes loses no work, because the new base archives the same
      // live work directory.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 },
          delta: { bytes: 4_000 },
          at: 1,
          fallback: { base: { id: FALLBACK_ID, bytes: 64 }, delta: undefined },
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });
      await checkpointOf(record, 'quiesce');

      expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
      // NAMED BEFORE DELETED, and forgotten only once the delete is done: a
      // crash mid-sweep leaves the id for the next run, and `backups/<uuid>/` is
      // shared by every box, so an id no record carries can never be swept.
      const named = record.calls.findIndex(c => c.startsWith('writeState:'));
      const deleted = record.calls.findIndex(c => c.startsWith('deleteObjects'));
      expect(named).toBeGreaterThan(-1);
      expect(named).toBeLessThan(deleted);
      expect(record.state?.orphans).toBeUndefined();
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(false);
      // The proven fallback and the new generation both survived it.
      expect(record.objects.has(baseObjectKey(FALLBACK_ID))).toBe(true);
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

  test('a sweep that fails AFTER publication never restores the superseded pointer',
    async () => {
      // Every step after the record's write deletes bytes the new record no
      // longer names, and a failure there used to travel to the checkpoint's
      // catch — which stamped it on the PRE-COMMIT record and wrote that over
      // the committed pointer. After a rebase that is a record naming the
      // generation the sweep was in the middle of deleting, so every later
      // attach refuses on a base the store no longer holds; and the generation
      // this commit had just written loses the only name it ever had, which in
      // a `backups/<uuid>/` namespace shared by every box means it can never be
      // swept.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 },
          delta: { bytes: 4_000 },
          at: 1,
          // A full slot makes this rebase orphan its outgoing generation, so
          // there is a sweep to fail. See `supersedeGeneration`.
          fallback: { base: { id: FALLBACK_ID, bytes: 64 }, delta: undefined },
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failDelete: true,
      });
      const outcome = await checkpointOf(record, 'quiesce');

      // The archive landed and the pointer is published, so that is what it
      // reports. A `failed` here would also refuse the quiesce this ran under,
      // holding a box open over work that is already durable.
      expect(outcome.kind).toBe('committed');
      const committed = record.state!;
      expect(committed.rev).toBe(2);
      expect(committed.base.id).not.toBe(CHAIN_ID);
      expect(record.objects.has(baseObjectKey(committed.base.id))).toBe(true);
      // The failure is stamped on the COMMITTED revision, and the generation
      // the sweep could not delete is still named, so the next commit retries
      // it and nothing reachable was dropped.
      expect(committed.lastFailure?.reason).toContain('store unreachable');
      expect(committed.orphans).toEqual([CHAIN_ID]);
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
      // No write went backwards: every record this checkpoint wrote names the
      // new generation.
      const writes = record.calls.filter(call => call.startsWith('writeState:'));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(call => call.includes(committed.base.id))).toBe(true);
    });

  test('KINU-N030: a failure stamp that cannot be written leaves the COMMITTED record',
    async () => {
      // The residual the test above left open. Its stamp is itself a durable
      // write, so it can fail too — and when it did, the throw travelled to the
      // checkpoint's catch, which stamped the PRE-COMMIT record and wrote that
      // over the committed pointer. One storage failure was handled; two
      // reverted the publication, which is the outcome the whole boundary
      // exists to make unrepresentable.
      //
      // Both writes this commit performs are therefore bound to the committed
      // revision, and the second one failing is a console line: the note is
      // about bytes that are already durable, and the only writer that could
      // carry it is the one that just failed.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 },
          delta: { bytes: 4_000 },
          at: 1,
          // The slot is already full, so this rebase orphans the outgoing
          // generation instead of retaining it — which is what gives the sweep
          // below something to fail at.
          fallback: { base: { id: FALLBACK_ID, bytes: 64 }, delta: undefined },
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failDelete: true,
        rejectWrites: [2],
      });
      const outcome = await checkpointOf(record, 'quiesce');

      expect(outcome.kind).toBe('committed');
      const committed = record.state!;
      // The published pointer, unchanged by either failure.
      expect(committed.rev).toBe(2);
      expect(committed.base.id).not.toBe(CHAIN_ID);
      // The stamp is the ONLY thing lost, and losing it costs no bytes: the
      // generation the sweep could not delete is still named, so the next
      // commit retries it.
      expect(committed.lastFailure).toBeUndefined();
      expect(committed.orphans).toEqual([CHAIN_ID]);
      // Everything either record names is still reachable.
      expect(record.objects.has(baseObjectKey(committed.base.id))).toBe(true);
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
      // TWO writes, both naming the new generation, and no third attempt that
      // could have carried the pre-commit record.
      const writes = record.calls.filter(call => call.startsWith('writeState:'));
      expect(writes).toHaveLength(2);
      expect(writes.every(call => call.includes(committed.base.id))).toBe(true);
      // Both lines are still there, on the one channel that still works: the
      // cleanup failure in full, and the fact that it never reached the record.
      expect(record.calls.some(call => call.startsWith('log:')
        && call.includes('is committed and its cleanup is not'))).toBe(true);
      expect(record.calls).toContain(
        `log:${DEVBOX_WORKDIR} that failure could not be stamped on the durable record`,
      );
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
      expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
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
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, 702791680));
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
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, landed));

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
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
    });

  test('an upload failure the stamp cannot record is still a classified failure',
    async () => {
      // The pre-commit half of the same storage hazard. Nothing was published
      // here, so the record the caller read is the right one to stamp — but the
      // stamp is a durable write and can fail exactly as the upload did. Letting
      // that rejection travel replaced the answer a scheduled callback needs
      // with a throw, and the throw carried the STORAGE failure rather than the
      // upload's reason: the caller lost both the classification and the cause.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failPut: true,
        rejectWrites: [1],
      });
      const outcome = await checkpointOf(record, 'tick');

      expect(outcome.kind).toBe('failed');
      // The OPERATION's reason, not the storage failure that swallowed it.
      expect(outcome.reason).toBe('store unreachable');
      expect(outcome.bytes).toBeUndefined();
      // Nothing durable moved in either direction: no layer landed, and the
      // record still describes the generation the box can still attach from.
      expect(record.state).toEqual(chainState({ upperMark: 'stale', at: 1 }));
      // Both lines are on the console, which is the only record left.
      expect(record.calls).toContain(
        `log:${DEVBOX_WORKDIR} checkpoint failed: store unreachable`,
      );
      expect(record.calls).toContain(
        `log:${DEVBOX_WORKDIR} that failure could not be stamped on the durable record`,
      );
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

  test('an unchanged skip whose watermark cannot be advanced still skips', async () => {
    // The watermark is ADVISORY, so a rejection cannot change the answer. Not
    // advancing it makes the next check ask about a wider window, which can only
    // over-report change, and over-reporting archives — so nothing is at risk
    // and `failed` would be a false claim about work. It would also refuse the
    // quiesce this may be running under, holding open a box whose work
    // directory has nothing to archive.
    const record = harness({
      state: chainState({ mode: 'extract', delta: undefined, changeVersion: 'v1' }),
      change: { status: 'unchanged', version: 'v2' },
      rejectWrites: [1],
    });
    const outcome = await checkpointOf(record, 'quiesce');

    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('work directory is unchanged');
    // The write was attempted and changed nothing, so the next check is still
    // relative to the version the box already held.
    expect(record.calls.some(call => call.endsWith(':rejected'))).toBe(true);
    expect(record.state?.changeVersion).toBe('v1');
    expect(record.calls.some(call => call.startsWith('log:')
      && call.includes('change watermark could not be advanced'))).toBe(true);
  });

  test('a failed PUT leaves the previous record intact and records the reason', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED, failPut: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.bytes).toBeUndefined();
    expect(record.state?.rev).toBe(1);
    expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
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

  test('extraction stays whole-tree and RETAINS the archive it supersedes', async () => {
    const record = harness({
      state: chainState({
        mode: 'extract', base: { id: EXTRACT_ID, bytes: 1 }, delta: undefined,
      }),
    });
    record.objects.set(baseObjectKey(EXTRACT_ID), 1);
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(record.calls.findIndex(call => call.startsWith('writeState:'))).toBeGreaterThan(-1);
    // ONE POLICY FOR BOTH MODES. The superseded archive is the fallback now, so
    // nothing is deleted here and a crash leaves two archives, never zero.
    expect(record.state?.fallback?.base).toEqual(baseLayer(EXTRACT_ID, 1));
    expect(record.calls.filter(call => call.startsWith('deleteObjects:'))).toEqual([]);
    expect(record.objects.has(baseObjectKey(EXTRACT_ID))).toBe(true);
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
  test('a same-size rename changes the per-path mark', () => {
    const dir = scratchDir('devbox-fingerprint-rename');
    try {
      const firstPath = join(dir, 'before.txt');
      const secondPath = join(dir, 'after.txt');
      writeFileSync(firstPath, 'same-size');
      utimesSync(firstPath, T_SAME + 0.5, T_SAME + 0.5);
      const run = (): string => {
        const proc = Bun.spawnSync(['sh', '-c', upperFingerprintCommand(dir)]);
        if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
        return proc.stdout.toString().trim();
      };
      const first = run();
      renameSync(firstPath, secondPath);
      utimesSync(secondPath, T_SAME + 0.5, T_SAME + 0.5);
      expect(run()).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-size same-second rewrite changes the mark', () => {
    // THE ORIGINAL RED PROOF. The old `%d` format truncated both marks below
    // to the same whole second and matched — the narrow unchanged-lie window
    // this gate exists to keep shut.
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

      expect(run()).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-path rewrite with the mtime RESTORED still changes the mark', () => {
    // THE METADATA COLLISION Main named. Same path, same size, and the writer
    // restores the old mtime after the write — every field the summary
    // fingerprint hashed agreed, so the gate skipped forever while content
    // drifted. The write itself moved ctime, which the per-path record hashes;
    // only an mtime restoration cannot undo that.
    const dir = scratchDir('devbox-fingerprint-restored-mtime');
    try {
      const file = join(dir, 'w.txt');
      const at = T_SAME + 0.5;
      writeFileSync(file, 'aaaaaaaaaa');
      utimesSync(file, at, at);
      const run = (): string => {
        const proc = Bun.spawnSync(['sh', '-c', upperFingerprintCommand(dir)]);
        if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
        return proc.stdout.toString().trim();
      };
      const first = run();

      writeFileSync(file, 'bbbbbbbbbb'); // SAME SIZE, SAME INODE
      utimesSync(file, at, at); // MTIME PUT BACK EXACTLY

      expect(run()).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('container replacement during chain attach', () => {
  test('restarts the whole mount sequence on the replacement generation', async () => {
    const calls: string[] = [];
    const record = harness({
      state: chainState(),
      mounts: mountsAfterAttach(calls),
      calls,
      generations: ['generation-a', 'generation-b'],
    });

    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.calls.filter((call) => call.startsWith('mountStore:'))).toHaveLength(2);
  });
});

// ── KINU-014: the archive carries the repository ─────────────────────────────

describe('archive scope keeps what no build can rebuild', () => {
  /** The whole archiver command one commit really ran for `source`. */
  function archiverCommand(commands: readonly string[], source: string): string {
    const line = commands.find(command => command.includes(`mksquashfs '${source}'`));
    if (line === undefined) throw new Error(`nothing was archived from ${source}`);
    return line;
  }

  /** The archiver command one commit ran for its own archive. */
  async function commandFor(state: ChainState | null, source: string): Promise<string> {
    const record = harness({ state, mounts: state === null ? NOT_MOUNTED : MOUNTED });
    const raw: string[] = [];
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      raw.push(command);
      return await inner(command);
    };
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
    return archiverCommand(raw, source);
  }

  test('a commit that was never pushed survives, because no archive drops .git',
    async () => {
      // MEASURED, not argued: an anchored `.git` exclude dropped a top-level
      // `.git` whether it was the repository's own directory or a linked
      // worktree's pointer FILE. So an agent that committed without pushing
      // restored the work with no history to explain it, and a worktree restored
      // as a tree git no longer recognised as a repository. Nothing under `.git`
      // is reproducible from a lockfile or a build, which is the only test the
      // exclude list applies.
      //
      // Both archives are checked: the base is the whole tree, and the delta is
      // the changed set that carries the repository's later commits.
      for (const command of [
        await commandFor(null, DEVBOX_WORKDIR),
        await commandFor(chainState(), UPPER),
      ]) {
        const patterns = excludePatternsOf(command);
        expect(patterns).toEqual([...CHAIN_EXCLUDES]);
        for (const pattern of patterns) {
          expect(pattern.startsWith('.git')).toBe(false);
        }
        // The policy travels as a FILE with wildcards enabled, which is what
        // makes a glob a glob and a pattern match at any depth. Nothing is
        // spelled as an argument, so no pattern can reach the shell as syntax.
        expect(command).toContain('-wildcards -ef ');
        expect(command).not.toContain(" -e '");
      }
    });
});

// ── the real archiver ───────────────────────────────────────────────────────
//
// Everything above asks what command the strategy builds. These run it. The
// exclude policy is only as good as what mksquashfs does with it, and this file
// has twice recorded a policy that meant something different from what its
// comment claimed: `*.log` matched nothing without `-wildcards`, and an
// anchored pattern dropped `<source>/node_modules` while keeping
// `<source>/sub/deep/node_modules`. A fake shell cannot catch either.

/** One byte size per fixture path, so a byte total identifies its files. */
const FIXTURE = new Map<string, number>([
  ['keep.txt', 10],
  ['.git/HEAD', 20],
  ['.git/objects/ab/cd', 30],
  ['sub/.git/HEAD', 40],
  // A linked worktree's `.git` is a FILE, and its one line is what makes the
  // tree a repository.
  ['wt/.git', 50],
  ['a.log', 60],
  ['sub/b.log', 70],
  ['node_modules/p/i.js', 80],
  ['sub/deep/node_modules/p/i.js', 90],
  ['dist/o.js', 100],
  ['sub/dist/o.js', 110],
  ['.cache/x', 120],
  ['sub/.cache/x', 130],
  ['a/b/c.txt', 140],
  ['x/a/b/c.txt', 150],
]);

function fixtureTree(label: string): string {
  const dir = scratchDir(label);
  for (const [path, size] of FIXTURE) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'y'.repeat(size));
  }
  return dir;
}

/** Run the strategy's OWN archiver command, and answer what the archive holds
 *  and how many bytes of source it took. */
function archiveOf(source: string, excludes: readonly string[]) {
  const archivePath = join(source, '..', `${basename(source)}.sqsh`);
  rmSync(archivePath, { force: true });
  const built = Bun.spawnSync(['sh', '-c', archiveCommand({
    sourceDir: source,
    archivePath,
    excludeFile: join(source, '..', `${basename(source)}.excludes`),
    excludes,
  })]);
  const [code] = built.stdout.toString().trim().split(/\s+/);
  if (code !== '0') {
    throw new Error(`archiver failed: ${built.stdout.toString()} ${built.stderr.toString()}`);
  }
  const listed = Bun.spawnSync(['unsquashfs', '-l', archivePath]);
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  const entries = listed.stdout.toString().split('\n')
    .filter(line => line.startsWith('squashfs-root/'))
    .map(line => line.slice('squashfs-root/'.length));
  let bytes = 0;
  for (const entry of entries) bytes += FIXTURE.get(entry) ?? 0;
  return { entries, bytes };
}

/** What the staging estimate would require for the same tree and policy. */
function estimateOf(source: string, excludes: readonly string[]): number {
  const measured = Bun.spawnSync(['sh', '-c', archiveSizeCommand(source, excludes)]);
  if (measured.exitCode !== 0) throw new Error(measured.stderr.toString());
  return Number(measured.stdout.toString().trim());
}

describe('the real archiver applies the policy this file claims', () => {
  test('git metadata travels at every depth, as a directory and as a worktree file', () => {
    const dir = fixtureTree('devbox-archive-git');
    try {
      const { entries } = archiveOf(dir, CHAIN_EXCLUDES);
      for (const kept of ['.git', '.git/HEAD', '.git/objects/ab/cd', 'sub/.git/HEAD', 'wt/.git']) {
        expect(entries).toContain(kept);
      }
      expect(entries).toContain('keep.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a regenerable tree goes at EVERY depth, not only the top level', () => {
    // The anchored form kept `sub/deep/node_modules`, `sub/b.log`, `sub/dist`
    // and `sub/.cache` on every archive this strategy has ever written, and
    // `a.log` too, because a glob without `-wildcards` matches nothing.
    const dir = fixtureTree('devbox-archive-depth');
    try {
      const { entries } = archiveOf(dir, CHAIN_EXCLUDES);
      for (const gone of [
        'node_modules', 'node_modules/p/i.js', 'sub/deep/node_modules/p/i.js',
        'a.log', 'sub/b.log', 'dist/o.js', 'sub/dist/o.js', '.cache/x', 'sub/.cache/x',
      ]) {
        expect(entries).not.toContain(gone);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('globstar patterns mean what the SDK makes them mean', () => {
    // The extraction path normalises these before mksquashfs ever sees them, so
    // the chain path normalises identically: a leading globstar segment is
    // stripped, an interior one collapses, a trailing one is dropped, and a bare
    // globstar means nothing at all — if it meant "everything", this archive
    // would be empty.
    const dir = fixtureTree('devbox-archive-globstar');
    try {
      const { entries } = archiveOf(dir, ['**/node_modules', 'dist/**', '**', 'a/**/b']);
      expect(entries).toContain('keep.txt');
      expect(entries).toContain('.git/HEAD');
      for (const gone of [
        'node_modules/p/i.js', 'sub/deep/node_modules/p/i.js', 'dist/o.js', 'sub/dist/o.js',
        'a/b/c.txt', 'x/a/b/c.txt',
      ]) {
        expect(entries).not.toContain(gone);
      }
      // Nothing this policy does not name is touched.
      expect(entries).toContain('a.log');
      expect(entries).toContain('sub/.cache/x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the extraction options and the direct command are one policy', () => {
    // Two modes, one question. `chainBackupOptions` used to spell the policy
    // itself while the chain path asked the box for it, so a box that replaced
    // the policy was obeyed in one mode and ignored in the other.
    const dir = fixtureTree('devbox-archive-parity');
    try {
      const declared = chainBackupOptions(true, CHAIN_EXCLUDES).excludes ?? [];
      expect(declared).toEqual([...CHAIN_EXCLUDES]);
      expect(archiveExcludeFile(declared)).toBe(archiveExcludeFile(CHAIN_EXCLUDES));
      expect(archiveOf(dir, declared).entries).toEqual(archiveOf(dir, CHAIN_EXCLUDES).entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the staging estimate measures exactly the bytes the archive takes', () => {
    // The estimate is the archive's worst case only while the two agree about
    // which files travel. They did not: the estimate pruned at every depth while
    // the archive excluded the top level only, so it was UNDER the truth for
    // exactly the trees that dominate a work directory — and a checkpoint that
    // underestimates fills the container disk, which is the one failure the
    // probe exists to prevent.
    const dir = fixtureTree('devbox-archive-estimate');
    try {
      for (const policy of [CHAIN_EXCLUDES, ['**/node_modules', 'dist/**', '**', 'a/**/b'], []]) {
        expect(estimateOf(dir, policy)).toBe(archiveOf(dir, policy).bytes);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── KINU-015: a restore is never down to one hope ────────────────────────────

/** A record that retains one older generation, which is every record between a
 *  publication that superseded a generation and the attach that proves the new
 *  one. */
function withFallback(over: StateLiteral = {}): ChainState {
  return chainState({
    fallback: { base: { id: FALLBACK_ID, bytes: FALLBACK_BYTES }, delta: undefined },
    ...over,
  });
}

describe('the generation lifecycle, against ONE box', () => {
  test('a publication retains, the next start proves, and only then does the old '
    + 'generation go', async () => {
    // The whole cycle in order, which is the only place the invariant is
    // visible: between a publication and the start that proves it the box holds
    // TWO generations, and it drops to one only when that one has been served.
    // A restore is therefore never down to a single unproven copy.
    let attached = true;
    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 }, at: 1,
      }),
      mounts: () => (attached ? MOUNTED : NOT_MOUNTED),
      now: 10 * INTERVAL_MS,
    });
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      // The overlay lands when the attach really mounts one, so the
      // postcondition reads a world this box changed.
      if (command.includes('fuse-overlayfs -o lowerdir=')) attached = true;
      return await inner(command);
    };
    const storage = snapshotChainStorage(record.ports);

    // The stop collapses the chain onto a fresh generation and keeps the old one.
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');
    const rebased = record.state!.base.id;
    expect(rebased).not.toBe(CHAIN_ID);
    expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
    expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);

    // The container is replaced, so the next start attaches for real. THAT is
    // the proof, and it is what retires the fallback — named, not deleted.
    attached = false;
    expect((await storage.attach()).kind).toBe('attached');
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.state?.orphans).toEqual([CHAIN_ID]);
    expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);

    // The next publication is what finally deletes it, through the sweep that
    // has always run there.
    record.upperMark = 'restarted-and-wrote';
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');
    expect(record.state?.orphans).toBeUndefined();
    expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(false);
    // One generation left, and it is the one an attach has served.
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.objects.has(baseObjectKey(rebased))).toBe(true);
  });
});

describe('the retained fallback', () => {
  test('is bounded by the two roles, not by how many publications happen', () => {
    // A publication with an empty slot retains its outgoing generation, because
    // an attach proved it. Every publication after it with no attach in between
    // orphans its OWN outgoing generation instead, so the proven one is never
    // the one evicted and the record never names a third.
    let state = chainState();
    const retained: string[] = [];
    for (let publication = 0; publication < 5; publication += 1) {
      const roles = supersedeGeneration(state);
      expect(roles.fallback).toBeDefined();
      state = {
        ...state,
        base: baseLayer(`a1b2c3d4-0000-4000-8000-00000000000${publication}`, 100),
        delta: undefined,
        ...roles,
      };
      retained.push(state.fallback!.base.id);
    }
    // The first outgoing generation is the proven one, and it is still the
    // slot's occupant five publications later.
    expect(retained).toEqual([CHAIN_ID, CHAIN_ID, CHAIN_ID, CHAIN_ID, CHAIN_ID]);
    // Everything else is named for deletion rather than retained, so storage is
    // bounded by the roles and the sweep can still find every id.
    expect(state.orphans).toHaveLength(4);
  });

  test('does not move until the pointer that moves it is durable', async () => {
    // The roles move in the SAME write as the pointer, so a publication whose
    // record cannot be written moves neither: the box still names the generation
    // it can still attach from, and the slot is exactly as it was.
    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 }, at: 1,
      }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
      rejectWrites: [1],
    });

    const outcome = await checkpointOf(record, 'quiesce');

    expect(outcome.kind).toBe('failed');
    expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, 100));
    expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, 4_000));
    expect(record.state?.fallback).toBeUndefined();
    expect(record.state?.orphans).toBeUndefined();
    // And nothing was deleted on the way out.
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
  });

  test('is retired by the attach that PROVES the generation the record names', async () => {
    const calls: string[] = [];
    const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });

    expect((await attachOf(record)).kind).toBe('attached');

    expect(record.state?.fallback).toBeUndefined();
    // NAMED, NOT DELETED. An attach publishes nothing, so it deletes nothing:
    // the sweep belongs to the next commit and is re-runnable.
    expect(record.state?.orphans).toEqual([FALLBACK_ID]);
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    expect(record.objects.has(baseObjectKey(FALLBACK_ID))).toBe(true);
  });

  test('survives an already-attached container, which proves nothing', async () => {
    // The overlay may have been mounted from the generation a later rebase
    // superseded, so a mount that is already up says nothing about what the
    // record names now.
    const record = harness({ state: withFallback(), mounts: MOUNTED });

    expect((await attachOf(record)).kind).toBe('already-attached');

    expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
    expect(record.calls.filter(call => call.startsWith('writeState'))).toEqual([]);
  });

  test('is not spent on a host that cannot mount the store at all', async () => {
    // A host with no FUSE says nothing about any generation's bytes. Trying the
    // fallback there would fail identically, cost the record a promotion, and
    // bury the platform's own reason under a recovery that never had a chance.
    const record = harness({ state: withFallback(), refuseStoreMount: true });

    await expect(attachOf(record)).rejects.toThrow(/could not be mounted here/);

    expect(record.calls.filter(call => call.startsWith('mountStore'))).toHaveLength(1);
    expect(record.calls.filter(call => call.startsWith('writeState'))).toEqual([]);
    expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
  });
});

describe('a restore that refuses the newest generation recovers from the older one', () => {
  test('a missing base falls back, publishes which generation recovered, deletes nothing',
    async () => {
      const calls: string[] = [];
      const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });
      // The newest generation's base is gone from the store. Before KINU-015
      // this was terminal: the record named one generation, the sweep had
      // already deleted the one before it, and the only advice on offer was to
      // discard the box's state — which is the whole workspace.
      record.objects.delete(baseObjectKey(CHAIN_ID));

      const outcome = await attachOf(record);

      expect(outcome.kind).toBe('attached');
      expect(outcome.detail).toContain('recovered');
      // The FALLBACK's layers are what mounted, and the refused generation's
      // store subtree was never even mounted.
      expect(record.calls).toContain(`mountStore:${FALLBACK_ID}`);
      expect(record.calls).not.toContain(`mountStore:${CHAIN_ID}`);
      // PROMOTED BEFORE SERVED: a crash after the mount must never leave the box
      // running on these bytes under a record that still names what it refused,
      // because the next checkpoint would write a delta into a generation whose
      // base is gone.
      const promoted = record.calls.findIndex(call => call.startsWith('writeState:'));
      const mounted = record.calls.findIndex(call => call.startsWith('mountStore:'));
      expect(promoted).toBeGreaterThan(-1);
      expect(promoted).toBeLessThan(mounted);
      // The record now names the recovered generation, says what it lost on the
      // failure field it already had, and names the refused generation for the
      // next sweep — after the replacement was proven, never before.
      const state = record.state!;
      expect(state.base).toEqual(baseLayer(FALLBACK_ID, FALLBACK_BYTES));
      expect(state.delta).toBeUndefined();
      expect(state.rev).toBe(2);
      expect(state.lastFailure?.reason).toContain(CHAIN_ID);
      expect(state.lastFailure?.reason).toContain('missing from the store');
      expect(state.orphans).toEqual([CHAIN_ID]);
      expect(state.fallback).toBeUndefined();
      // The fingerprint described the changed set of a generation this box is
      // not serving, and a mark that cannot describe the upper must never be
      // able to match it, or the next tick would skip the archive.
      expect(state.upperMark).toBeUndefined();
      // A RESTORE DELETES NOTHING, whatever it finds.
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('a base whose size disagrees is refused rather than adopted, and the fallback serves',
    async () => {
      // The base is written ONCE and never rewritten, so a size that disagrees
      // means the object is not the archive the record describes. That asymmetry
      // with the delta is deliberate — see `probe` — and it stays a refusal.
      const calls: string[] = [];
      const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });
      record.objects.set(baseObjectKey(CHAIN_ID), BASE_BYTES + 4_096);

      expect((await attachOf(record)).detail).toContain('recovered');

      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.lastFailure?.reason).toContain('state declares');
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
    });

  test('a base that will not read is that generation own failure, so the fallback serves',
    async () => {
      // The integrity probe cannot see rot: it compares two sizes. The mount is
      // the read, so a squashfuse refusal on this generation's own archive is
      // this generation's refusal — not the host's.
      const calls: string[] = [];
      const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });
      let mounts = 0;
      const inner = record.ports.exec;
      record.ports.exec = async (command) => {
        if (command.includes('squashfuse')) {
          mounts += 1;
          // ONLY the first layer mount, which is the newest generation's base.
          if (mounts === 1) {
            return {
              stdout: '', stderr: 'squashfuse: unable to read squashfs_super_block', exitCode: 1,
            };
          }
        }
        return await inner(command);
      };

      expect((await attachOf(record)).detail).toContain('recovered');

      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.lastFailure?.reason).toContain('could not be read');
      expect(record.state?.lastFailure?.reason).toContain('squashfs_super_block');
    });

  test('both generations unsound is an honest failure that deletes neither', async () => {
    const record = harness({ state: withFallback(), mounts: NOT_MOUNTED });
    record.objects.delete(baseObjectKey(CHAIN_ID));
    record.objects.delete(baseObjectKey(FALLBACK_ID));

    const failure = attachOf(record);
    await expect(failure).rejects.toThrow(/was refused at attach/);
    await expect(failure).rejects.toThrow(/cannot be served either/);

    // Both generations are still named and still there. Two broken generations
    // are two chances for an operator; one broken generation and a tidy bucket
    // is none.
    expect(record.state?.base.id).toBe(FALLBACK_ID);
    expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
  });

  test('a box with no retained generation still refuses rather than serving an empty tree',
    async () => {
      const record = harness({ state: chainState(), mounts: NOT_MOUNTED });
      record.objects.delete(baseObjectKey(CHAIN_ID));

      await expect(attachOf(record)).rejects.toThrow(/names no earlier generation/);

      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('a promotion that cannot be written serves nothing', async () => {
    // The promotion is the only durable write a recovery makes before it mounts
    // anything, so its failure is pre-commit and travels: the box does not
    // start, and the record still names exactly what it named before.
    const record = harness({ state: withFallback(), mounts: NOT_MOUNTED, rejectWrites: [1] });
    record.objects.delete(baseObjectKey(CHAIN_ID));

    await expect(attachOf(record)).rejects.toThrow(/durable storage unreachable/);

    expect(record.calls.filter(call => call.startsWith('mountStore'))).toEqual([]);
    expect(record.state?.base.id).toBe(CHAIN_ID);
    expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
  });

  test('a proof that cannot be written leaves the box ATTACHED and the id still named',
    async () => {
      // Retiring the fallback is a note about something that already happened.
      // The workspace is mounted by the time it is written, so a failed write
      // must not fail the start — the retry would find the overlay up and take
      // the already-attached path anyway. The id stays named, so the next attach
      // repeats the retirement.
      const calls: string[] = [];
      const record = harness({
        state: withFallback(), mounts: mountsAfterAttach(calls), calls, rejectWrites: [1],
      });

      expect((await attachOf(record)).kind).toBe('attached');

      expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
      expect(record.calls.some(call => call.startsWith('log:')
        && call.includes('could not be updated to say so'))).toBe(true);
    });
});

describe('a restore stays inside the tree it is restoring', () => {
  test('the seed target is emptied before any archive content is copied into it', async () => {
    // The only content a restore writes is the delta, copied out of a mounted
    // squashfs with `cp -a`, which recreates symlinks instead of following them.
    // So the one way an archive could write outside the upper is through a
    // symlink ALREADY sitting at a path the copy walks — and the reset in this
    // same attach is what guarantees there is none. A squashfs cannot express a
    // `..` escape at all: it is a tree, and mksquashfs strips the source prefix.
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
    const raw: string[] = [];
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      raw.push(command);
      return await inner(command);
    };

    expect((await attachOf(record)).kind).toBe('attached');

    const emptied = raw.findIndex(command =>
      command.startsWith('resetting directories') || (command.startsWith('rm -rf')
        && command.includes(UPPER) && command.includes('mkdir -p')));
    const copied = raw.findIndex(command => command.startsWith('cp -a'));
    expect(emptied).toBeGreaterThan(-1);
    expect(copied).toBeGreaterThan(emptied);
    // `-a` implies `--no-dereference`; nothing may turn that off.
    expect(raw[copied]).toContain(`cp -a '${DEVBOX_RUNTIME_DIR}/lower-delta/.' '${UPPER}/'`);
    expect(raw[copied]).not.toMatch(/--dereference|\s-L\b/);
  });
});

// ── KINU-N025: a same-length archive is not the same archive ─────────────────

/** A different archive of IDENTICAL length, expressed the only way it can be:
 *  the store's digest disagrees with the record's while every byte count
 *  agrees. A valid squashfs image in this state mounts and serves the wrong
 *  workspace, which is exactly what a count cannot see. */
const REPLACED_DIGEST = 'f'.repeat(64);
/** The version the store reports for that replacement upload. R2 mints one per
 *  upload, so a replacement can never carry the recorded one. */
const REPLACED_VERSION = 'upload-that-replaced-it';

describe('an archive replaced at the same length is refused', () => {
  test('the current generation is refused and the retained fallback serves', async () => {
    const calls: string[] = [];
    const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });
    record.digests.set(baseObjectKey(CHAIN_ID), REPLACED_DIGEST);

    const outcome = await attachOf(record);

    expect(outcome.detail).toContain('recovered');
    expect(record.state?.base.id).toBe(FALLBACK_ID);
    expect(record.state?.lastFailure?.reason).toContain('different archive of the same length');
    // The SIZE never disagreed, so nothing but the digest could have caught it,
    // and nothing was deleted on the way through.
    expect(record.objects.get(baseObjectKey(CHAIN_ID))).toBe(BASE_BYTES);
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
  });

  test('a delta replaced at the same length is refused, while a delta of a different '
    + 'length is still adopted', async () => {
      // The two halves of the same rule. A size that disagrees is the
      // crash-window delta this file's header describes — a complete archive the
      // record does not mention yet — and it is adopted. A size that agrees
      // while the identity does not is corruption, and it is refused.
      const refusing: string[] = [];
      const corrupt = harness({
        state: withFallback(), mounts: mountsAfterAttach(refusing), calls: refusing,
      });
      corrupt.digests.set(deltaObjectKey(CHAIN_ID), REPLACED_DIGEST);
      expect((await attachOf(corrupt)).detail).toContain('recovered');
      expect(corrupt.state?.lastFailure?.reason).toContain('delta archive');
      expect(corrupt.state?.lastFailure?.reason).toContain('different archive of the same length');

      const adopting: string[] = [];
      const superseded = harness({
        state: withFallback(), mounts: mountsAfterAttach(adopting), calls: adopting,
      });
      const drifted = DELTA_BYTES + 4_096;
      superseded.objects.set(deltaObjectKey(CHAIN_ID), drifted);
      superseded.digests.set(deltaObjectKey(CHAIN_ID), REPLACED_DIGEST);
      superseded.versions.set(deltaObjectKey(CHAIN_ID), REPLACED_VERSION);

      const outcome = await attachOf(superseded);

      expect(outcome.kind).toBe('attached');
      expect(outcome.detail).not.toContain('recovered');
      expect(superseded.state?.base.id).toBe(CHAIN_ID);
      expect(superseded.state?.delta)
        .toEqual({ bytes: drifted, digest: REPLACED_DIGEST, objectVersion: REPLACED_VERSION });
    });

  test('both generations replaced at the same length fails honestly and deletes neither',
    async () => {
      const record = harness({ state: withFallback(), mounts: NOT_MOUNTED });
      record.digests.set(baseObjectKey(CHAIN_ID), REPLACED_DIGEST);
      record.digests.set(baseObjectKey(FALLBACK_ID), REPLACED_DIGEST);

      const failure = attachOf(record);
      await expect(failure).rejects.toThrow(/different archive of the same length/);
      await expect(failure).rejects.toThrow(/cannot be served either/);

      // Both generations are still named and still there.
      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
      expect(record.objects.has(baseObjectKey(CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(FALLBACK_ID))).toBe(true);
    });

  test('a record written before layer digests existed still attaches', async () => {
    // Those rows are live: `Devbox.strategy` defaults to the chain and the
    // product's own sandbox class is deployed on it. An absent digest is
    // UNKNOWN, so the size check stands alone and the box starts — refusing it
    // would be the data loss the chain exists to prevent.
    const calls: string[] = [];
    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: BASE_BYTES, digest: undefined, objectVersion: undefined },
        delta: { bytes: DELTA_BYTES, digest: undefined, objectVersion: undefined },
      }),
      mounts: mountsAfterAttach(calls),
      calls,
    });
    // The store has answers; the record has neither. Nothing to compare.
    record.digests.set(baseObjectKey(CHAIN_ID), REPLACED_DIGEST);
    record.versions.set(baseObjectKey(CHAIN_ID), REPLACED_VERSION);

    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.state?.lastFailure).toBeUndefined();
  });

  test('a MULTIPART archive replaced at the same length is refused on the store version, '
    + 'even when the replacement copies the digest', async () => {
      // The case no checksum can reach. A large archive goes up in parts, and
      // the Workers multipart API takes no checksum, so R2 reports no digest for
      // it however carefully the record kept one. Here the record has no digest
      // either — which is what a multipart layer's record looks like — and the
      // replacement even carries the same digest metadata. What it cannot carry
      // is the version R2 minted for the upload the record describes.
      const calls: string[] = [];
      const record = harness({
        state: withFallback({
          base: { id: CHAIN_ID, bytes: BASE_BYTES, digest: undefined },
          delta: { bytes: DELTA_BYTES, digest: undefined },
        }),
        mounts: mountsAfterAttach(calls),
        calls,
      });
      // The store holds the recorded length, no digest of its own, and a version
      // from a different upload.
      record.versions.set(baseObjectKey(CHAIN_ID), REPLACED_VERSION);

      const outcome = await attachOf(record);

      expect(outcome.detail).toContain('recovered');
      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.lastFailure?.reason).toContain('written by a different upload');
      expect(record.state?.lastFailure?.reason).toContain('no checksum');
      // Size never disagreed and no digest existed on either side, so the
      // version is the only thing that could have caught it.
      expect(record.objects.get(baseObjectKey(CHAIN_ID))).toBe(BASE_BYTES);
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('the SAME multipart object attaches, so the version check is not a false alarm',
    async () => {
      // The other half of the discriminator: identical size, no digest either
      // side, and the version the record already names. A box whose archive was
      // never touched must start normally, or the check above would refuse every
      // large archive on every boot.
      const calls: string[] = [];
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: BASE_BYTES, digest: undefined },
          delta: { bytes: DELTA_BYTES, digest: undefined },
        }),
        mounts: mountsAfterAttach(calls),
        calls,
      });

      expect((await attachOf(record)).kind).toBe('attached');

      expect(record.state?.lastFailure).toBeUndefined();
      expect(record.state?.base.objectVersion)
        .toBe(versionOf(baseObjectKey(CHAIN_ID), BASE_BYTES));
    });

  test('the record carries the digest the upload reported, for the base and for the delta',
    async () => {
      // The identity is only knowable while the bytes move, so if the commit
      // does not record it nothing can afterwards without reading the object
      // back. Both layers, because both are uploaded by the same path.
      const born: string[] = [];
      const fresh = harness({ state: null, mounts: mountsAfterAttach(born), calls: born });
      expect((await checkpointOf(fresh, 'tick')).kind).toBe('committed');
      const generation = fresh.state!.base.id;
      expect(fresh.state?.base).toEqual(baseLayer(generation, DELTA_BYTES));
      expect(fresh.state?.delta).toBeUndefined();

      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
      // And the store was asked to verify it, which is what makes the pre-attach
      // comparison possible at all.
      expect(record.digests.get(deltaObjectKey(CHAIN_ID)))
        .toBe(record.state?.delta?.digest);
    });
});
