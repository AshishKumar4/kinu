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
  chainStoreRoot,
  CHAIN_EXCLUDES,
  deltaObjectKey,
  isOverlayMounted,
  metadataObjectKey,
  publishCommand,
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

/**
 * THE STRATEGY'S PATHS ARE OBSERVED, NEVER RESTATED.
 *
 * This block used to hold the mirrors of the strategy's private layer
 * vocabulary — the delta layer's mount point, a reimplementation of its
 * `/proc/mounts` probe, the visibility-probe ceiling, and the store mount
 * point — under a comment saying "drift fails these tests, which is the
 * point". It is not the point. A mirror agrees with the module by
 * construction. Both sides read the test's copy, so the only thing it can
 * catch is the strategy MOVING a path, and the thing it cannot catch is the
 * strategy looking somewhere other than where it mounted — which is the defect
 * that costs a workspace.
 *
 * Every path is now read off a call the strategy really made. The host is
 * handed each mount point as an ARGUMENT — `mountStore(at)`,
 * `squashfuse <archive> <point>`, `fuse-overlayfs -o lowerdir=…` — so the
 * fake receives the strategy's own choice and the assertions read it back.
 * What the cases then assert are its PROPERTIES: inside the box's own runtime
 * directory, scoped by the chain generation, read through the one mount, and
 * the same path the strategy later reads `/proc/mounts` for.
 */

/** This box's chain root, DERIVED through the strategy's own exported helper
 *  rather than spelled: every key a test names lives under it, and the one
 *  mount covers it. `boxes/box-under-test` is this suite's box prefix, which
 *  is a fixture identity rather than a value the strategy owns. */
const STORE_ROOT = chainStoreRoot('boxes/box-under-test');

/** The store mount point the strategy chose, read off its own
 *  `mountStore:<at>` call. One mount per binding per container life now, so
 *  there is no read/write split to model — the registry state the last mount
 *  held is what a reattach releases and a fresh mount replaces. */
function storeMountOf(calls: readonly string[]): string {
  const at = calls
    .filter((call) => call.startsWith('mountStore:'))
    .map((call) => call.split(':')[1])[0];
  if (at === undefined) {
    throw new Error(`the strategy mounted no store; calls: ${calls.join(', ')}`);
  }
  return at;
}

/** One layer mount the strategy made: where in the call sequence it happened,
 *  the archive path it read, and the point it chose. */
interface LayerMount {
  readonly index: number;
  readonly archive: string;
  readonly point: string;
}

/** The layer mount the strategy made for `objectKey`, read off its own
 *  `mountLayer:<archive>:<point>` call: where in the sequence it happened, the
 *  archive path it read THROUGH the store mount, and the point it chose. */
function layerMountOf(calls: readonly string[], objectKey: string): LayerMount {
  const archiveName = objectKey.split('/').at(-1)!;
  const index = calls.findIndex((call) => {
    const parts = call.split(':');
    return parts[0] === 'mountLayer' && parts[1]?.endsWith(`/${archiveName}`) === true;
  });
  if (index === -1) {
    throw new Error(`no layer was mounted for ${objectKey}; calls: ${calls.join(', ')}`);
  }
  const parts = calls[index]!.split(':');
  return { index, archive: parts[1]!, point: parts[2]! };
}

import {
  ATTACH_OUTCOME_KINDS,
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
} from '../src/storage';
import { sessionShellRefusal } from './support/session-shell';

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
/** The overlay's bottom lower: the base layer's mount point. */
const LOWER_BASE = `${DEVBOX_RUNTIME_DIR}/lower-base`;

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
    digest: digestOf(baseObjectKey(STORE_ROOT, id), bytes),
    objectVersion: versionOf(baseObjectKey(STORE_ROOT, id), bytes),
  };
}

/** The delta descriptor a record carries for a generation of this size. */
function deltaLayer(id: string, bytes: number): ChainLayer {
  return {
    bytes,
    digest: digestOf(deltaObjectKey(STORE_ROOT, id), bytes),
    objectVersion: versionOf(deltaObjectKey(STORE_ROOT, id), bytes),
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
 * Every command this strategy composes, held to what the container's ONE
 * persistent session shell would do with it — `support/session-shell.ts` owns
 * the two failures that shell really answers with: a command that says `exit`,
 * and a command it cannot parse.
 */

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
  absent: (path: string) => boolean,
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
      stdout: absent(exists) ? 'no' : 'yes',
    };
  }
  // The BOUNDED visibility probe: ONE command that asks the store mount for one
  // layer a bounded number of times and, when it never appears, reports what the
  // subtree does hold. The bound lives inside the command the strategy composed,
  // so this fake never has to know it — the case that asserts the refusal reads
  // it off the command instead. A path a case declares absent stays absent
  // however many times it is asked.
  if (command.includes('printf ready')) {
    const awaited = /test -e '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '';
    return {
      call: `awaitLayer:${awaited}`,
      stdout: absent(awaited) ? 'missing data.sqsh delta.sqsh' : 'ready',
    };
  }
  // Releasing every delta layer this container serves, whichever generation
  // mounted it: one command over /proc/mounts rather than one path.
  if (command.includes('awk -v r=')) return { call: 'releaseDeltaLayers', stdout: '' };
  const unmounted = /fusermount3 -u(?:z)? '(?<path>[^']+)'/.exec(command)?.groups?.path;
  if (unmounted !== undefined) return { call: `unmountPath:${unmounted}`, stdout: '' };
  const reset = /^rm -rf (?<paths>.+?) && mkdir -p /.exec(command)?.groups?.paths;
  if (reset !== undefined) {
    return {
      call: `resetDirs:${reset.split(' ').map(unquote).join(',')}`,
      stdout: '',
    };
  }
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
  // NO ARM FOR A SEEDING COPY, deliberately. The strategy no longer has one —
  // the delta is a layer — so a `cp -a` reaching this fake would fall through to
  // `exec:cp` and show up in the recorded calls, which is what the assertions
  // below check for by name.
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
/** The SDK's mount registry as a test holds it: one held entry for the one
 *  binding, shared across the harnesses one test builds so two isolates on one
 *  container see the same mount. */
interface SdkMountRegistry {
  held?: { readonly prefix: string; readonly readOnly: boolean };
}

/** The CONTAINER's own mount table, shared the same way the SDK registry is:
 *  `/proc/mounts` belongs to the container, not to the isolate reading it, so
 *  a stop and a wake — two isolates, one container — see the same lines. */
interface ContainerMounts {
  mounted?: { readonly at: string; readonly prefix: string };
}

function harness(overrides: {
  state?: ChainState | null;
  mounts?: string | (() => string);
  /** Which container paths this case says are NOT there, asked per path rather
   *  than listed — so a case can say "the store subtree exposes nothing"
   *  without knowing where the strategy mounted the store. */
  absent?: (path: string) => boolean;
  generations?: string[];
  entriesAfterExtract?: number;
  running?: boolean;
  change?: { status: ChangeStatus; version: string } | Error;
  now?: number;
  /** The store takes nothing: the container's flush fails, which is the only
   *  failure a publication can have. */
  failPublish?: boolean;
  /** The store refuses every delete. The post-publication sweep runs on it. */
  failDelete?: boolean;
  /** Which `writeState` calls reject, by 1-based order of arrival. `[2]` fails
   *  only the post-commit failure stamp, which is the one durable write that
   *  happens after a record is already published. */
  rejectWrites?: readonly number[];
  refuseOverlay?: boolean;
  /** The FIRST attempt to mount the delta layer dies, which is the window under
   *  test: an attach that cannot compose its own delta must leave no overlay. */
  failDeltaLayer?: boolean;
  /** What the changed set fingerprints to. Empty means the probe failed. */
  upperMark?: string;
  /** What the archiver reports as `<exit> <bytes>`. `'0 0'` is the shape that
   *  bit a deployed run: success claimed, no file present. */
  stagedReport?: string;
  /** Bytes the STORE ends up holding, when they differ from the staged size —
   *  the deployed shape, where a mid-write stat read short and the copy landed
   *  the whole archive. */
  landedBytes?: number;
  /** Bytes the MOUNT reports after the flush, when they differ from what the
   *  store took. Two readings of one finished upload: a difference is a flush
   *  that did not carry every byte, and the publication must refuse it. */
  flushedBytes?: number;
  /** The copy reports success and the store ends up holding NOTHING under the
   *  key. s3fs answers a flush from its own view, so a publication can report
   *  a clean exit over an object the store never took. */
  publishLandsNothing?: boolean;
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
  /** The seed stamp this container's disk already carries: which delta the upper
   *  beside it holds. A replaced container has none, which is the default. */
  seedStamp?: string;
  /** The SDK's mount registry, SHARED across the harnesses one test builds so
   *  two isolates on the same container see the one binding's one mount —
   *  which is exactly what a stop and a wake are. Omitted means this harness
   *  owns a private registry, which is a container nothing else has touched. */
  registry?: SdkMountRegistry;
  /** The container's mount table, shared for the same reason: a fresh harness
   *  is a fresh isolate, not a fresh container, and `/proc/mounts` does not
   *  reset with it. */
  mountsTable?: ContainerMounts;
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
  let seedStamp = overrides.seedStamp;
  let deltaLayerDied = false;
  let liveMark = overrides.upperMark ?? '7:4096:1700000000';
  let writes = 0;
  /** The generation whose subtree is mounted right now, and the prefix a flush
   *  through it lands under. The ONE mount, one setting, held for the
   *  container's life — the shape the SDK's own registry forces, because it
   *  admits a second mount of a binding only at the same prefix with the same
   *  setting. Shared with the harness's siblings when the caller says so, so a
   *  stop-and-wake sees one container. */
  const table: ContainerMounts = overrides.mountsTable ?? {};
  /**
   * The SDK's own registry: what it last mounted for the one binding.
   *
   * THE RULE THE DEPLOYED RUN DIED ON, stated as the fake's behaviour rather
   * than as a comment: `@cloudflare/sandbox` admits a second mount of a binding
   * only at the SAME prefix with the SAME setting, and it says so with
   * `R2 binding "BACKUP_BUCKET" is already mounted at <path> with a different
   * readOnly setting` (measured live, runs e2e20260902032038 and
   * e2e20260902032318, on the second checkpoint after a wake). A fake without
   * the rule cannot hold the one-mount design, because two settings look fine
   * to it. SHARED when the caller says so, because the registry belongs to the
   * SDK — one per container, whichever isolate asks.
   */
  const sdk: SdkMountRegistry = overrides.registry ?? {};
  /**
   * The container's publication, as the container performs it.
   *
   * THE ONLY WAY AN OBJECT GETS INTO THIS STORE. There is no port that carries
   * a payload byte any more, so a test that sees an object appear is watching
   * the container write it through the mount — and one that sees none is
   * watching a checkpoint that never published.
   */
  const publish = (mountedPath: string) => {
    const mount = table.mounted;
    if (mount === undefined || !mountedPath.startsWith(`${mount.at}/`)) {
      // What a real container answers when the path is not on a mount: the
      // directory is not there to be written into.
      calls.push(`publishArchive:unmounted:${mountedPath}`);
      return { stdout: '1 0', stderr: `dd: can't open '${mountedPath}': No such file`, exitCode: 0 };
    }
    const key = `${mount.prefix}${mountedPath.slice(mount.at.length + 1)}`;
    calls.push(`publishArchive:${key}`);
    const landed = overrides.landedBytes ?? DELTA_BYTES;
    // The mount's own reading after the flush. Equal to what the store took
    // unless a test says otherwise, which is the lost-tail shape.
    const flushed = overrides.flushedBytes ?? landed;
    if (overrides.failPublish === true) {
      return { stdout: '1 0', stderr: 'dd: fsync failed: Input/output error', exitCode: 0 };
    }
    if (overrides.publishLandsNothing !== true) {
      objects.set(key, landed);
      digests.set(key, overrides.landedDigest ?? digestOf(key, landed));
      versions.set(key, overrides.landedVersion ?? versionOf(key, landed));
    }
    return { stdout: `0 ${flushed}`, stderr: '', exitCode: 0 };
  };

  const ports: SnapshotChainPorts = {
    containerRunning: () => overrides.running ?? true,
    readSeedStamp: () => {
      calls.push('readSeedStamp');
      return Promise.resolve(seedStamp);
    },
    writeSeedStamp: (stamp) => {
      calls.push(`writeSeedStamp:${stamp}`);
      seedStamp = stamp;
      return Promise.resolve();
    },
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
    //
    // AND IT IS A PERSISTENT SHELL, which is the fact two deployed runs turned
    // on: a command that says `exit` ends the session rather than the script,
    // and a command the shell cannot parse ends it too. Both are modelled here
    // rather than asserted anywhere, so the defect is unrepresentable — any
    // command template that grows an `exit` or loses a separator fails every
    // test that runs it. See `support/session-shell.ts`.
    exec: (command) => {
      const refused = sessionShellRefusal(command);
      if (refused !== undefined) {
        calls.push(`sessionKilled:${command.split(' ')[0]!}`);
        return Promise.reject(refused);
      }
      // THE PUBLICATION IS A COMMAND, which is the whole change: the archive
      // moves because the container was told to copy it onto a mount, not
      // because a port handed bytes to the isolate.
      // THE COPY, whatever precedes it in the same command: the publication
      // creates the generation's directory on the mount first (s3fs shows no
      // parent for a key nothing lives under yet), so the matcher reads the `dd`
      // rather than the start of the line.
      const published = /dd if='(?<archive>[^']+)' of='(?<mounted>[^']+)' bs=4M conv=fsync;/
        .exec(command)?.groups;
      if (published !== undefined) return Promise.resolve(publish(published.mounted!));
      // THE CONTAINER'S OWN VIEW: the strategy's `mountStoreOnce` reads
      // `/proc/mounts`, so the store mount has to appear there exactly as a real
      // s3fs mount does — one line at the path, for exactly as long as the fake
      // holds it mounted. That is what makes the one-mount design observable to
      // the code rather than remembered by it.
      const procMounts = () => table.mounted === undefined
        ? mounts()
        : `${mounts()}\ns3fs ${table.mounted.at} fuse.s3fs rw,nosuid,nodev,relatime 0 0\n`;
      const label = shellLabel(
        command, procMounts(), overrides.absent ?? (() => false),
        overrides.freeBytes ?? Number.MAX_SAFE_INTEGER,
        liveMark,
        overrides.stagedReport ?? `0 ${DELTA_BYTES}`,
      );
      calls.push(label.call);
      if (label.call.startsWith('mountLayer:') && label.call.includes('/lower-delta/')
        && overrides.failDeltaLayer === true && !deltaLayerDied) {
        // ONE-SHOT: the first mount dies, a retry on the same container
        // succeeds. That is the sequence a transient layer failure lives in, so
        // the fake has to be able to express it rather than failing forever.
        deltaLayerDied = true;
        return Promise.resolve({
          stdout: '', stderr: 'squashfuse: unable to read squashfs_super_block', exitCode: 1,
        });
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
    storeRoot: () => STORE_ROOT,
    mountStore: (at) => {
      calls.push(`mountStore:${at}`);
      if (overrides.refuseStoreMount === true) {
        // The real local failure: the container has no FUSE device. Deliberately
        // NOT the interception wording, so the degrade cannot be passing because
        // it recognised one particular sentence.
        return Promise.reject(new Error('S3FS mount failed: fuse: device not found'));
      }
      // THE SDK'S OWN REFUSAL, not a test's opinion: a second mount of this
      // binding is admitted only at the same prefix with the same setting, which
      // under the one-mount design is the SAME mount asked for again. Anything
      // else is the shape that killed the deployed second checkpoint.
      const prefix = `${STORE_ROOT}/`;
      // TWO REGISTRIES, because the SDK holds two. The BINDING registry admits a
      // second mount only at the same prefix with the same setting; the PATH
      // registry refuses a second mount at one path UNCONDITIONALLY
      // (`activeMounts.has(mountPath)`, sandbox-CPj2jsbz.js:8369 — measured live
      // as `Mount path "/backups" is already in use by bucket "BACKUP_BUCKET"`,
      // run e2e20260902060426). Together they say: one mount call, at one path,
      // with one setting — asking again is not idempotent.
      const held = sdk.held;
      if (held !== undefined && (held.prefix !== prefix || held.readOnly !== false)) {
        return Promise.reject(new Error(
          `R2 binding "BACKUP_BUCKET" is already mounted at ${at} with a different `
          + 'readOnly setting. Mount the same binding only once, or use the same readOnly '
          + 'value for additional mounts.',
        ));
      }
      if (held !== undefined || table.mounted?.at === at) {
        return Promise.reject(new Error(
          `Mount path "${at}" is already in use by bucket "BACKUP_BUCKET". Unmount the `
          + 'existing bucket first or use a different mount path.',
        ));
      }
      sdk.held = { prefix, readOnly: false };
      table.mounted = { at, prefix };
      return Promise.resolve();
    },
    unmountStore: (at) => {
      calls.push(`unmountStore:${at}`);
      // THE PRODUCT PORT, not the SDK's raw call: the strategy's ports go
      // through `#chainPorts.unmountStore`, which catches the SDK's
      // "nothing is mounted here" refusal and survives it, so this fake answers
      // the same way — resolved, with the mount and the registry entry gone
      // when the path was the one being held.
      if (table.mounted?.at === at) table.mounted = undefined;
      sdk.held = undefined;
      return Promise.resolve();
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
      objects.set(baseObjectKey(STORE_ROOT, id), DELTA_BYTES);
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
    seed(baseObjectKey(STORE_ROOT, generation.base.id), generation.base);
    if (generation.delta !== undefined) {
      seed(deltaObjectKey(STORE_ROOT, generation.base.id), generation.delta);
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
      ...layer(baseObjectKey(STORE_ROOT, literal.base.id), literal.base),
    },
    delta: literal.delta === undefined
      ? undefined
      : layer(deltaObjectKey(STORE_ROOT, literal.base.id), literal.delta),
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

/** The mount points one production attach chose for one generation. */
interface Chosen {
  readonly chainId: string;
  /** Where it mounted the box's chain root — the one mount. */
  readonly store: string;
  /** Where it mounted the base layer, and the generation's own delta layer. */
  readonly base: string;
  readonly delta: string;
}

/**
 * Run one production attach and read back the paths it chose.
 *
 * OBSERVED BEFORE THE CASES THAT NEED THEM. A case that composes a
 * `/proc/mounts` line has to know the layer path BEFORE it can run its own
 * scenario, and restating that path is what made this file's mirrors: the test
 * and the strategy then both read the test's copy. An attach that already ran
 * answers the same question with the strategy's own choice.
 *
 * `snapshotChainStorage(...).attach()` directly rather than `attachOf`, so an
 * observation does not pad the outcome-kind denominator at the end of this
 * file.
 */
async function observeAttach(chainId: string): Promise<Chosen> {
  const calls: string[] = [];
  const record = harness({
    state: chainState({ base: { id: chainId, bytes: BASE_BYTES }, delta: { bytes: DELTA_BYTES } }),
    mounts: mountsAfterAttach(calls),
    calls,
  });
  const outcome = await snapshotChainStorage(record.ports).attach();
  if (outcome.kind !== 'attached') {
    throw new Error(`observing ${chainId}: the attach answered ${outcome.kind}`);
  }
  return {
    chainId,
    store: storeMountOf(calls),
    base: layerMountOf(calls, baseObjectKey(STORE_ROOT, chainId)).point,
    delta: layerMountOf(calls, deltaObjectKey(STORE_ROOT, chainId)).point,
  };
}

/**
 * TWO generations, because one cannot show that a path is scoped by
 * generation. The collapse rule turns on the layer belonging to THIS
 * generation and not another, and two observations can tell those apart where
 * a mirror on both sides never could.
 */
const CHOSEN = await observeAttach(CHAIN_ID);
const CHOSEN_FALLBACK = await observeAttach(FALLBACK_ID);

/** Mounts that hold the composed shape a wake leaves: an overlay over the base
 *  and the generation's own delta layer, at the paths the strategy CHOSE for
 *  that generation. */
function composedMounts(chosen: Chosen): string {
  return [
    'sysfs /sys sysfs rw,relatime 0 0',
    `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
    `${baseObjectKey(STORE_ROOT, chosen.chainId)} ${chosen.base} fuse.squashfuse ro 0 0`,
    `${deltaObjectKey(STORE_ROOT, chosen.chainId)} ${chosen.delta} fuse.squashfuse ro 0 0`,
  ].join('\n');
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
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
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

  test('a production attach composes base and delta as layers and copies nothing',
    async () => {
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      const outcome = await attachOf(record);
      expect(outcome.kind).toBe('attached');

      // A BOUNDED number of layers, whatever the chain's history: two archives
      // mounted, and the overlay composed over BOTH with a fresh upper on top.
      expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
      // ZERO bytes moved: no stream is opened, no object is downloaded, and —
      // the point of this change — nothing is copied into the upper.
      expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
      expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
      // BOTH LAYERS EXIST BEFORE THE OVERLAY TAKES THEM. An overlay is composed
      // from mount points it is handed; a mounted overlay therefore proves the
      // whole composition landed, which is what the `already-attached` early
      // return assumes.
      const store = storeMountOf(record.calls);
      const base = layerMountOf(record.calls, baseObjectKey(STORE_ROOT, CHAIN_ID));
      const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
      const mounted = record.calls.indexOf(`overlayAttach:${DEVBOX_WORKDIR}:2`);
      // Both archives were read THROUGH the store mount this attach made, which
      // is what makes them lazy reads rather than downloads.
      expect(base.archive.startsWith(`${store}/`)).toBe(true);
      expect(delta.archive.startsWith(`${store}/`)).toBe(true);
      expect(mounted).toBeGreaterThan(delta.index);
      expect(mounted).toBeGreaterThan(base.index);
      // The delta layer is NOT released after the overlay: it is one of its
      // lowers now, and releasing it would empty the merged view of everything
      // the changed set holds.
      expect(record.calls.slice(mounted)).not.toContain('releaseDeltaLayers');
      expect(outcome.detail).toContain(`${BASE_BYTES + DELTA_BYTES}B`);
      expect(outcome.detail).toContain('base+delta layered');
    });

  test('NEWEST LOWER FIRST: the delta precedes the base, or the base would win every path',
    async () => {
      // `lowerdir` resolves left to right, so the order IS the composition. With
      // the base first, every path the delta rewrote would resolve to its
      // pre-delta content and every file the delta deleted would come back —
      // a workspace silently rolled back to its last rebase.
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      const raw: string[] = [];
      const inner = record.ports.exec;
      record.ports.exec = async (command) => {
        raw.push(command);
        return await inner(command);
      };

      expect((await attachOf(record)).kind).toBe('attached');

      const composed = raw.find(command => command.includes('fuse-overlayfs -o lowerdir='));
      expect(composed).toBeDefined();
      expect(composed).toContain(
        `lowerdir='${layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID)).point}':`
        + `'${layerMountOf(record.calls, baseObjectKey(STORE_ROOT, CHAIN_ID)).point}'`,
      );
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
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
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
      record.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), DELTA_BYTES);
      expect((await attachOf(record)).kind).toBe('attached');
      // Adopted means COMPOSED: the orphan delta becomes a layer under the fresh
      // upper, exactly like a referenced one.
      // The delta became a LAYER: its archive is read through the store mount this
      // attach made, and its point is scoped by the generation it belongs to.
      const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
      expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
      expect(delta.point).toContain(CHAIN_ID);
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
    });

  test('LIVE WINDOW: a delta layer that will not mount leaves no overlay behind',
    async () => {
      // THE WINDOW THE COMPOSITION INHERITS. Both layers are mounted before the
      // overlay takes them, so a delta that will not mount means no overlay was
      // ever composed — the retry cannot mistake a half-composed restoration for
      // a finished one, because a mounted overlay is the proof that both lowers
      // existed. Killed AT the delta mount, the container is still plain and the
      // attach refuses in the container's own words.
      const calls: string[] = [];
      const record = harness({
        state: chainState(),
        mounts: mountsAfterAttach(calls),
        calls,
        failDeltaLayer: true,
      });
      await expect(attachOf(record)).rejects.toThrow(/squashfs_super_block/);
      // Nothing was mounted over the work directory, so the next attach starts
      // from scratch rather than early-returning over half a composition.
      expect(record.calls.filter(call => call.startsWith('overlayAttach'))).toEqual([]);
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
        failDeltaLayer: true,
      });
      await expect(attachOf(record)).rejects.toThrow(/squashfs_super_block/);

      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('not an overlay mount');
      // The delta the chain already holds is untouched: nothing was archived
      // over it, so the content the attach failed to restore is still there.
      expect(record.calls).not.toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
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
    record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));
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
      record.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), drifted);
      // A DIFFERENT archive, which is what a crash between the PUT and the state
      // write leaves: another size and another identity under the same key.
      const landed = digestOf(deltaObjectKey(STORE_ROOT, CHAIN_ID), drifted);
      const landedVersion = versionOf(deltaObjectKey(STORE_ROOT, CHAIN_ID), drifted);
      record.digests.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), landed);
      record.versions.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), landedVersion);

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
    record.objects.delete(deltaObjectKey(STORE_ROOT, CHAIN_ID));
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
      absent: (path) => path === UPPER,
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
      // The path is the one this attach mounted, read back from its own call, so
      // the release cannot be checked against a path the strategy never used.
      const store = storeMountOf(record.calls);
      expect(record.calls).toContain(`unmountStore:${store}`);
      // And the store path is never released by path, which would bypass the
      // registry.
      expect(record.calls).not.toContain(`unmountPath:${store}`);
      // A stale claim from a previous generation is cleared BEFORE the mount.
      expect(record.calls.indexOf(`unmountStore:${store}`))
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

// ── the delta across a stop, and what serves it ─────────────────────────────
//
// MEASURED. The deployed `snapshot-chain` arm died with
//
//   ContainerStartOverrun: Devbox.attach exceeded its 300000ms budget
//
// on the wake after a stop, while the COLD attach of the same box passed. The
// difference between the two used to be a COPY: a cold box has no delta, and a
// woken one had the whole cumulative changed set copied into a fresh upper —
// read through squashfuse over the mounted store, the only full read of an
// archive anywhere on this path. The header's claim that "an attach moves NO
// bytes" was true of everything except the one step that moved all of them.
//
// So the delta is a LAYER now, and there are exactly two shapes. A stop does not
// necessarily take the container with it: when the same instance comes back its
// upper already holds what the last publication archived, the stamp proves it,
// and the base alone is mounted under it. When the instance CHANGED — a blank
// disk, no stamp — the delta is composed as a lower and nothing is copied at
// all.

describe('a wake whose upper already holds this delta', () => {
  const stampFor = (chainId = CHAIN_ID, bytes = DELTA_BYTES): string =>
    `${chainId}:${bytes}:${versionOf(deltaObjectKey(STORE_ROOT, chainId), bytes)}`;

  test('mounts the base alone over the upper it kept', async () => {
    const calls: string[] = [];
    const record = harness({
      state: chainState(),
      mounts: mountsAfterAttach(calls),
      calls,
      seedStamp: stampFor(),
    });

    const outcome = await attachOf(record);

    expect(outcome.kind).toBe('attached');
    // ONE layer mount, not two: the delta needs no layer, because the changed
    // set it holds is already in this upper.
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(1);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
    expect(outcome.detail).toContain('already in this upper');
  });

  test('keeps the upper, because emptying it would throw away the delta AND the pending change',
    async () => {
      const calls: string[] = [];
      const record = harness({
        state: chainState(), mounts: mountsAfterAttach(calls), calls, seedStamp: stampFor(),
      });

      await attachOf(record);

      expect(record.calls.some(call => call.startsWith('resetDirs') && call.includes(UPPER)))
        .toBe(false);
    });

  test('a stamp naming another delta is not this delta: the layer is composed', async () => {
    const calls: string[] = [];
    const record = harness({
      state: chainState(),
      mounts: mountsAfterAttach(calls),
      calls,
      // Same generation, same length, a DIFFERENT upload — the shape a replaced
      // delta has, and the reason the stamp carries the store's own version.
      seedStamp: `${CHAIN_ID}:${DELTA_BYTES}:another-upload`,
    });

    expect((await attachOf(record)).kind).toBe('attached');
    // The delta became a LAYER: its archive is read through the store mount this
    // attach made, and its point is scoped by the generation it belongs to.
    const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
    expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
    expect(delta.point).toContain(CHAIN_ID);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
  });
});

// ── THE WAKE THAT COST THE BUDGET ───────────────────────────────────────────
//
// A stop yields a FRESH container instance often enough that this is the
// ordinary wake, not the exotic one: a blank disk carries no upper and no stamp,
// so nothing about the previous instance can be claimed. What that wake must NOT
// do is copy the changed set: the copy is proportional to everything written
// since the base, it runs against the container-start budget, and at the size a
// deployed ladder leaves it does not finish.

describe('a wake whose container instance changed', () => {
  test('composes the delta as a layer and copies NOTHING', async () => {
    const calls: string[] = [];
    // A blank disk: no seed stamp, and a delta far too large to copy inside any
    // start budget.
    const record = harness({
      state: chainState({ delta: { bytes: 512 << 20 } }),
      mounts: mountsAfterAttach(calls),
      calls,
    });

    const outcome = await attachOf(record);

    expect(outcome.kind).toBe('attached');
    // THE ASSERTION THIS DESCRIBE EXISTS FOR: no copy, in any spelling. The
    // strategy's shell has no seeding command at all now, so a `cp` would reach
    // the container as a raw command and be recorded as one.
    expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('seedUpper'))).toEqual([]);
    // What replaced it: the delta mounted at its own generation's layer path,
    // and an overlay composed over two lowers.
    // The delta became a LAYER: its archive is read through the store mount this
    // attach made, and its point is scoped by the generation it belongs to.
    const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
    expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
    expect(delta.point).toContain(CHAIN_ID);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
    expect(outcome.detail).toContain('base+delta layered');
  });

  test('claims nothing about the upper: an attach writes no seed stamp', async () => {
    // The stamp means "this upper HOLDS that delta", and after a composed attach
    // it does not: the layer does. A stamp written here would tell the next
    // commit it may archive the upper as the whole changed set, which is exactly
    // the publication that would drop everything the layer holds.
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });

    expect((await attachOf(record)).kind).toBe('attached');

    expect(record.calls.filter(call => call.startsWith('writeSeedStamp'))).toEqual([]);
  });

  test('the layer path names its own generation, so a later commit can see it', async () => {
    // OBSERVED, AND ASSERTED AS PROPERTIES. This case used to build a
    // `/proc/mounts` line from a test-local copy of the strategy's layer path
    // and hand it to a test-local copy of the strategy's own probe — both sides
    // reading the test's copy, so nothing the strategy did could turn it red.
    //
    // The paths are now the ones a real attach mounted at, and what they have to
    // satisfy is: inside the box's own runtime directory, so nothing a caller
    // writes can reach them, and scoped by the generation, so two generations
    // cannot share one mount point.
    expect(CHOSEN.delta.startsWith(`${DEVBOX_RUNTIME_DIR}/`)).toBe(true);
    expect(CHOSEN.delta).toContain(CHAIN_ID);
    expect(CHOSEN_FALLBACK.delta).toContain(FALLBACK_ID);
    expect(CHOSEN_FALLBACK.delta).not.toBe(CHOSEN.delta);

    // AND THE COMMIT LOOKS THERE, which is the half a restatement on both sides
    // could never reach:
    // a commit reads `/proc/mounts` for its own generation's layer, so composing
    // the mount line from the path the ATTACH chose proves the two halves of the
    // strategy agree. Both directions — this generation's layer collapses the
    // chain, another generation's does not — because reading a foreign layer as
    // this one's changed set is what would make every commit after a collapse
    // collapse again.
    const own = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });
    expect((await checkpointOf(own, 'tick')).kind).toBe('committed');
    expect(own.state?.base.id).not.toBe(CHAIN_ID);

    const foreign = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN_FALLBACK),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });
    expect((await checkpointOf(foreign, 'tick')).kind).toBe('committed');
    expect(foreign.state?.base.id).toBe(CHAIN_ID);
    expect(foreign.state?.delta).toBeDefined();
  });
});

// ── the collapse that keeps a delta object whole ────────────────────────────
//
// THE INVARIANT THE COMPOSITION PUTS AT RISK, and the rule that keeps it. Every
// delta commit archives the upper, and that is the whole cumulative changed set
// only while nothing else is holding part of it. A composed attach breaks that:
// the layer holds everything up to the last publication and the upper holds
// everything since. Archiving the upper THERE would replace the one delta object
// the next attach reads with a fragment of itself — silent, durable loss of
// every byte the layer was serving.
//
// So a commit that finds a layer serving its own generation's delta collapses
// the chain onto a fresh base instead. The merged view is the one tree that
// expresses both, and archiving it is an operation this file already had.

describe('a commit whose upper is not the whole changed set collapses the chain', () => {

  test('archives the merged view as a fresh base instead of the upper as a delta', async () => {
    const record = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });

    const outcome = await checkpointOf(record, 'tick');

    expect(outcome.kind).toBe('committed');
    // THE ARCHIVE IS THE WORK DIRECTORY, not the upper: the merged view is what
    // holds the layer and the upper together.
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${DEVBOX_WORKDIR}:`))).toBe(true);
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${UPPER}:`))).toBe(false);
    // A FRESH GENERATION with no delta, so the next attach mounts one layer.
    expect(record.state?.base.id).not.toBe(CHAIN_ID);
    expect(record.state?.delta).toBeUndefined();
    // And the delta object of the generation being served is never rewritten,
    // which is the loss this rule exists to prevent.
    expect(record.calls).not.toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    // The superseded generation is RETAINED as the fallback rather than dropped:
    // its layers are what the live overlay is still serving from.
    expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
  });

  test('collapses ONCE: the next commit is an ordinary delta again', async () => {
    const record = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });
    const storage = snapshotChainStorage(record.ports);

    expect((await storage.checkpoint('tick')).kind).toBe('committed');
    const collapsed = record.state!.base.id;
    record.upperMark = 'written-after-the-collapse';

    // A quiesce, so the interval gate the collapse just reset is not what this
    // case is about: the question is which SHAPE the second commit takes.
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');

    // The layer is STILL mounted — it is a lower of a live overlay and cannot be
    // released — but it serves a generation the record no longer names, so it is
    // no longer a reason to collapse. A rule keyed on a fixed mount path rather
    // than on the generation would rebase here forever.
    expect(record.state?.base.id).toBe(collapsed);
    expect(record.state?.delta).toBeDefined();
    expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, collapsed)}`);
  });

  test('an ORPHAN delta the record does not name still forces the collapse', async () => {
    // The crash-window delta: a previous run landed the object and died before
    // the state write, so the record names none and the attach adopts it as a
    // layer. Archiving the upper here would PUT over that object — the one copy
    // of a changed set nothing else holds.
    const record = harness({
      state: chainState({ delta: undefined, at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });
    record.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), DELTA_BYTES);

    const outcome = await checkpointOf(record, 'tick');

    expect(outcome.kind).toBe('committed');
    expect(record.state?.base.id).not.toBe(CHAIN_ID);
    expect(record.calls).not.toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
  });

  test('a wake that wrote nothing pays for nothing', async () => {
    // The collapse archives the whole workspace, so a box that woke and did
    // nothing must not trigger one: the durable chain already holds every byte
    // the layers serve. An empty upper is the proof — a deletion leaves a
    // whiteout in it and a metadata change copies its file up, so "empty"
    // cannot hide a change.
    const record = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'the-empty-upper',
      entriesAfterExtract: 0,
    });

    const outcome = await checkpointOf(record, 'quiesce');

    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('nothing has been written since the attach');
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
  });

  test('an upper that HOLDS the delta commits a delta, layer or no layer', async () => {
    // The same-instance shape: the stamp proves the upper is the whole changed
    // set, no layer was composed, and the ordinary delta commit is correct.
    const record = harness({
      state: chainState({ at: 1 }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-publication',
      seedStamp: `${CHAIN_ID}:${DELTA_BYTES}:${versionOf(deltaObjectKey(STORE_ROOT, CHAIN_ID), DELTA_BYTES)}`,
    });

    const outcome = await checkpointOf(record, 'tick');

    expect(outcome.kind).toBe('committed');
    expect(record.state?.base.id).toBe(CHAIN_ID);
    expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${UPPER}:`))).toBe(true);
  });
});

// ── waits that end ──────────────────────────────────────────────────────────
//
// Both of these used to be unbounded loops, and an unbounded loop on the attach
// path spends the whole container-start budget and reports nothing: the
// restoration is abandoned mid-mount, the box records an overrun, and nobody
// learns which step never finished.

describe('an attach that cannot see or cannot release says so', () => {
  test('a store subtree that never exposes the base refuses by count, naming what it holds',
    async () => {
      const record = harness({
        state: chainState(),
        mounts: NOT_MOUNTED,
        absent: () => true,
      });
      const raw: string[] = [];
      const inner = record.ports.exec;
      record.ports.exec = async (command) => {
        raw.push(command);
        return await inner(command);
      };

      const refusal = attachOf(record);
      // The attach has to RUN before its commands can be read back off the fake.
      await expect(refusal).rejects.toThrow(/does not expose /);

      // THE PATH AND THE COUNT both come off the command the strategy composed,
      // never off a number restated here. The probe names the store mount it
      // lists and the path it waits for, and its own bound is what the refusal
      // repeats — so the message cannot disagree with the wait that produced it.
      const probe = raw.find((command) => command.includes('printf ready'));
      expect(probe).toBeDefined();
      const listed = /ls -1A '(?<path>[^']+)'/.exec(probe ?? '')?.groups?.path ?? '';
      const awaited = /test -e '(?<path>[^']+)'/.exec(probe ?? '')?.groups?.path ?? '';
      const bound = Number(/seq 1 (?<n>\d+)/.exec(probe ?? '')?.groups?.n ?? 0);
      expect(listed).not.toBe('');
      expect(awaited).not.toBe('');
      expect(bound).toBeGreaterThan(0);
      await expect(refusal).rejects.toThrow(
        `does not expose ${awaited} after ${String(bound)} probes`,
      );
      // THE PACE LIVES IN ONE COMMAND. The loop is a single shell statement, so
      // the count of probe COMMANDS the fake received is exactly one, whatever
      // the bound inside it — the pacing that made the deployed probe kill the
      // session stays where it was put.
      expect(raw.filter((command) => command.includes('printf ready'))).toHaveLength(1);
      // WHAT THE SUBTREE DOES HOLD travels with the refusal: an operator reading
      // it can tell "the mount is empty" from "the mount holds another
      // generation's archives" without a second deployment.
      await expect(refusal).rejects.toThrow(/holds: data.sqsh delta.sqsh/);
    });

  test('a mount that will not release is a named failure, not a hang', async () => {
    const record = harness({ state: chainState(), mounts: NOT_MOUNTED });
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      if (command.includes('fusermount3 -u') && command.includes(LOWER_BASE)) {
        return {
          stdout: '',
          stderr: 'still mounted after 20 release attempts',
          exitCode: 1,
        };
      }
      return await inner(command);
    };

    await expect(attachOf(record)).rejects.toThrow(/releasing the mount at .*lower-base/);
    // Nothing was mounted on top of a mount this attach could not release.
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
  });
});

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
    expect(record.calls.some(
      call => call === `publishArchive:${baseObjectKey(STORE_ROOT, record.state!.base.id)}`,
    )).toBe(true);
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
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, record.state!.base.id))).toBe(true);
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
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(false);
      // The proven fallback and the new generation both survived it.
      expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, record.state!.base.id))).toBe(true);
    });

  test('a crash before the sweep leaves an id the NEXT checkpoint cleans up', async () => {
    // Re-runnable is the property: the ids sit in the record until a run
    // finishes deleting them, and the referenced generation is never among them.
    const stranded = 'a1b2c3d4-0000-4000-8000-0000000000ff';
    const record = harness({
      state: chainState({ orphans: [stranded] }),
      mounts: MOUNTED,
    });
    record.objects.set(baseObjectKey(STORE_ROOT, stranded), 4_096);
    await checkpointOf(record, 'quiesce');

    expect(record.objects.has(baseObjectKey(STORE_ROOT, stranded))).toBe(false);
    expect(record.state?.orphans).toBeUndefined();
    // The live generation survived the sweep that removed the stranded one.
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
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
      expect(record.objects.has(baseObjectKey(STORE_ROOT, committed.base.id))).toBe(true);
      // The failure is stamped on the COMMITTED revision, and the generation
      // the sweep could not delete is still named, so the next commit retries
      // it and nothing reachable was dropped.
      expect(committed.lastFailure?.reason).toContain('store unreachable');
      expect(committed.orphans).toEqual([CHAIN_ID]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
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
      expect(record.objects.has(baseObjectKey(STORE_ROOT, committed.base.id))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
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
      expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
      // The base is untouched: same id, same bytes, and nothing published to it.
      expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
      expect(record.calls).not.toContain(`publishArchive:${baseObjectKey(STORE_ROOT, CHAIN_ID)}`);
    });

  // ── the byte plane ────────────────────────────────────────────────────────
  //
  // MEASURED DEFECT THESE HOLD. The archive used to leave the container as
  // base64 SSE frames, cross the owning Durable Object's isolate, and go back
  // out to the store through the Workers R2 binding. On a live container against
  // a real store that relay moved 3.34 MiB/s at 64 MiB and 3.64 at 256 MiB,
  // against 23.22 and 39.00 for the same bytes moved by the container itself —
  // and it was the ONLY arm that got slower as the archive grew, which is what
  // says the cost is the isolate rather than a constant overhead.
  //
  // THE PORT SURFACE IS THE PROOF. `SnapshotChainPorts` has no entry that can
  // carry a payload byte in either direction: no stream out, no object in. The
  // first case below puts both of the deleted ones BACK as refusals, so the
  // property is a postcondition of a real commit rather than an argument about
  // an interface; the rest assert the mechanism that replaced them.

  test('a commit lands with every payload-carrying port wired to REFUSE', async () => {
    // The two entries the relay used, restored as throws. A strategy that still
    // reached for either — a stream out of the container, or an object into the
    // store from this side — fails here with the sentence it was refused with.
    // This commits because nothing on this side is on the byte path.
    const record = harness({ state: chainState(), mounts: MOUNTED });
    const refusing = Object.assign(record.ports, {
      readFileStream: (): never => {
        throw new Error('payload must not be streamed out of the container');
      },
      putObject: (): never => {
        throw new Error('payload must not be put into the store from the isolate');
      },
    });
    const outcome = await snapshotChainStorage(refusing).checkpoint('tick');

    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(DELTA_BYTES);
    // It moved the bytes the way it now moves them: the container copied the
    // archive onto a writable mount, and this side read the store's metadata.
    expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    expect(record.calls).toContain(`objectFacts:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
  });

  test('a checkpoint publishes through a WRITABLE mount and never through the isolate',
    async () => {
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');

      // ONE MOUNT, ONE SETTING, ONE MOUNT POINT: the chain's subtree, at
      // /backups, held writable for the container's life — which is what the
      // publication writes through. The old design mounted a second path
      // writable for one publication, and the SDK refuses one binding mounted
      // twice under different settings: measured live, the second checkpoint
      // after a wake (runs e2e20260902032038, e2e20260902032318).
      expect(record.calls).toContain(`mountStore:${storeMountOf(record.calls)}`);
      // The archive went in through that mount, under the key the record names.
      expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
      expect(record.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(DELTA_BYTES);
      // And the ONLY thing this side learned about it is metadata.
      expect(record.calls).toContain(`objectFacts:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    });

  test('the flush happens through the held mount, before the record',
    async () => {
      // R2's own precondition, and the one way this step could lose committed
      // data: a release returns as soon as the mount leaves the namespace and
      // cannot flush, so bytes still held by s3fs would be gone while the record
      // already named them. The flush is therefore part of the copy command —
      // `conv=fsync` — and the mount it flushes through is the one the box
      // HOLDS, so there is no release window at all any more: the mount cannot
      // be released while squashfuse reads layer files through it, which is why
      // the one-mount design exists.
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');

      const mounted = record.calls.indexOf(`mountStore:${storeMountOf(record.calls)}`);
      const flushed = record.calls.indexOf(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
      const read = record.calls.indexOf(`objectFacts:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
      const wrote = record.calls.findIndex(call => call.startsWith('writeState:2:'));
      expect(mounted).toBeGreaterThan(-1);
      expect(mounted).toBeLessThan(flushed);
      expect(flushed).toBeLessThan(read);
      // The store is asked what it holds only after the flush answered, so the
      // answer describes the object rather than a filesystem's view of it.
      expect(read).toBeLessThan(wrote);
      // The flush is IN the command, not a separate hope.
      expect(publishCommand({ archivePath: 'a', mountedPath: 'b' })).toContain('conv=fsync');
      // AND SO IS THE GENERATION'S DIRECTORY. The mount covers the box's chain
      // root, so the target is `<mount>/<generation>/<name>`; s3fs shows no
      // parent for a key nothing lives under yet, and `dd` then refuses with
      // `No such file or directory` — measured live on the first checkpoint of a
      // fresh box, run e2e20260902083130.
      const store = storeMountOf(record.calls);
      const command = publishCommand({
        archivePath: '/stage/layer.sqsh',
        mountedPath: `${store}/${CHAIN_ID}/data.sqsh`,
      });
      expect(command).toStartWith(`mkdir -p '${store}/${CHAIN_ID}';`);
      expect(command.indexOf('mkdir -p')).toBeLessThan(command.indexOf('dd if='));
      // AND THE MOUNT IS STILL HELD: no unmount of the store path anywhere in
      // the commit, because the attach's layers are reading through it.
      expect(record.calls).not.toContain(`unmountStore:${store}`);
    });

  test('a writable mount is released even when the publication fails', async () => {
    // A mount left behind is refused by the SDK's own registry on the next
    // publication — one binding cannot be mounted twice under different access —
    // so a failure that kept it would turn one bad checkpoint into every later
    // one.
    const record = harness({ state: chainState(), mounts: MOUNTED, failPublish: true });
    expect((await checkpointOf(record, 'tick')).kind).toBe('failed');
    // Nothing landed, and the record still describes what the box can attach.
    expect(record.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(DELTA_BYTES);
    expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
  });

  test('a flush the store did not fully take is REFUSED, not recorded', async () => {
    // The one failure a mount publication has that a relay did not: the copy
    // reports what it wrote, the store reports what it holds, and a difference
    // between two readings of one finished upload is a lost tail. Recording it
    // would commit a head over an archive that cannot mount.
    const record = harness({
      state: chainState(),
      mounts: MOUNTED,
      flushedBytes: 700_000,
      landedBytes: 512,
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('did not carry every byte');
    expect(outcome.reason).toContain('512');
    expect(outcome.reason).toContain('700000');
    // The record still names the generation the box can still attach from.
    expect(record.state?.rev).toBe(1);
    expect(record.state?.lastFailure?.reason).toContain('did not carry every byte');
  });

  test('a publication the store has no object for is REFUSED, not recorded', async () => {
    // The other half of the cross-check, and the reason the store is asked at
    // all. s3fs answers a flush from its own view of the mount, so a clean exit
    // is not evidence the store took anything — and a record written on that
    // exit alone would name an object no attach can ever find.
    //
    // A FIRST BASE, because that is where the absence is observable: a fresh
    // generation's prefix holds nothing, so a publication that lands nothing
    // leaves the store with nothing to answer for the key.
    const record = harness({ state: null, mounts: MOUNTED, publishLandsNothing: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('the store holds no such object');
    // Nothing was recorded: no first generation exists to attach from.
    expect(record.state).toBeNull();
  });

  test('an attach moves no payload either: mounts and metadata, nothing else', async () => {
    // THE OTHER DIRECTION. Reading a chain back was already container-side —
    // squashfuse parses the archive through the store mount and the bytes arrive
    // when something touches them — and this is what keeps it that way. An
    // attach that published, copied or streamed anything would show up here.
    const calls: string[] = [];
    const record = harness({
      state: chainState({ delta: deltaLayer(CHAIN_ID, DELTA_BYTES) }),
      mounts: mountsAfterAttach(calls),
      calls,
    });
    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
    // What it DID ask the store for: metadata, and only metadata.
    expect(record.calls).toContain(`objectFacts:${baseObjectKey(STORE_ROOT, CHAIN_ID)}`);
    // The layers were mounted, which is where the bytes come from.
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
  });

  test('ONE MOUNT: every mount of the binding is the chain subtree at /backups',
    async () => {
      // THE RULE THE SDK ITSELF ENFORCES, asserted rather than remembered: one
      // binding admits one mount, at one prefix, in one setting, and the
      // deployed consequence of violating it was the second checkpoint after a
      // wake refusing with `R2 binding "BACKUP_BUCKET" is already mounted at
      // /backups with a different readOnly setting` (runs e2e20260902032038 and
      // e2e20260902032318). So both roles — the attach that reads its layers
      // through it and the checkpoint that writes its archive through it — use
      // the same mount, and what keeps the archives out of the attach's `rm -rf`
      // is that the reset lists its own layout paths and excludes this one.
      const checkpointCalls: string[] = [];
      const committed = harness({
        state: chainState(), mounts: MOUNTED, calls: checkpointCalls,
      });
      expect((await checkpointOf(committed, 'tick')).kind).toBe('committed');
      const attachCalls: string[] = [];
      const attached = harness({
        state: chainState({ delta: deltaLayer(CHAIN_ID, DELTA_BYTES) }),
        mounts: mountsAfterAttach(attachCalls),
        calls: attachCalls,
      });
      expect((await attachOf(attached)).kind).toBe('attached');

      const mounts = [...checkpointCalls, ...attachCalls]
        .filter(call => call.startsWith('mountStore:'));
      expect(mounts.length).toBeGreaterThan(0);
      // THE ONE MOUNT POINT, in both roles. The fake's own registry holds the
      // rule — a second mount with a different setting or prefix is refused
      // with the SDK's own sentence — so these assertions are the reader's view
      // of a constraint the fake would have failed on.
      // THE ONE MOUNT POINT, read off the calls rather than restated: every
      // mount either role made names the same path.
      const at = [...new Set(mounts.map((mount) => mount.split(':')[1]!))];
      expect(at).toHaveLength(1);
      // And a wake that re-attaches releases the store mount first, so a new
      // generation's subtree can take its place at the one mount point.
      const againCalls: string[] = [];
      const attachedAgain = harness({
        state: chainState({ delta: deltaLayer(CHAIN_ID, DELTA_BYTES) }),
        mounts: mountsAfterAttach(againCalls),
        calls: againCalls,
      });
      expect((await attachOf(attachedAgain)).kind).toBe('attached');
      expect(attachedAgain.calls.indexOf(`unmountStore:${storeMountOf(attachedAgain.calls)}`))
        .toBeLessThan(attachedAgain.calls.findIndex(call => call.startsWith('mountStore:')));
    });

  test('CRASH ORDERING: the state write lands before any cleanup', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED });
    await checkpointOf(record, 'tick');
    const put = record.calls.indexOf(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
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
      expect(record.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(702791680);
      // EVERY STATE SIZE COMES FROM A COMPLETED UPLOAD. There are four writers
      // of a size into the record — the commit's own layer, the extract path's
      // stored base, and the adoption below — and each one's provenance is an R2
      // head of a finished object: the publication reads the store back rather
      // than counting bytes it never saw. None is a mid-write stat, which is the
      // measurement that read 4096-multiples low on the deployed runs.
      expect(record.state?.delta?.bytes).toBe(702791680);
      expect(record.state?.delta?.bytes).not.toBe(700387328);
      // And the consequence that was actually measured: the wake attaches.
      const wokenCalls: string[] = [];
      const woken = harness({
        state: record.state, mounts: mountsAfterAttach(wokenCalls), calls: wokenCalls,
      });
      woken.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), 702791680);
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
      woken.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), landed);
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

  test('a publication failure the stamp cannot record is still a classified failure',
    async () => {
      // The pre-commit half of the same storage hazard. Nothing was published
      // here, so the record the caller read is the right one to stamp — but the
      // stamp is a durable write and can fail exactly as the publication did.
      // Letting that rejection travel replaced the answer a scheduled callback
      // needs with a throw, and the throw carried the STORAGE failure rather
      // than the publication's reason: the caller lost both the classification
      // and the cause.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failPublish: true,
        rejectWrites: [1],
      });
      const outcome = await checkpointOf(record, 'tick');

      expect(outcome.kind).toBe('failed');
      // THE OPERATION's reason, carrying the container's own words, and not the
      // durable-storage failure that swallowed it.
      expect(outcome.reason).toContain('dd: fsync failed');
      expect(outcome.reason).not.toContain('durable storage unreachable');
      expect(outcome.bytes).toBeUndefined();
      // Nothing durable moved in either direction: no layer landed, and the
      // record still describes the generation the box can still attach from.
      expect(record.state).toEqual(chainState({ upperMark: 'stale', at: 1 }));
      // Both lines are on the console, which is the only record left.
      expect(record.calls.some(call => call.startsWith(`log:${DEVBOX_WORKDIR} checkpoint failed:`)
        && call.includes('dd: fsync failed'))).toBe(true);
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

  test('a failed publication leaves the previous record intact and records the reason', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED, failPublish: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.bytes).toBeUndefined();
    expect(record.state?.rev).toBe(1);
    expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
    expect(record.state?.lastFailure?.reason).toContain('dd: fsync failed');
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
    record.objects.set(baseObjectKey(STORE_ROOT, EXTRACT_ID), 1);
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(record.calls.findIndex(call => call.startsWith('writeState:'))).toBeGreaterThan(-1);
    // ONE POLICY FOR BOTH MODES. The superseded archive is the fallback now, so
    // nothing is deleted here and a crash leaves two archives, never zero.
    expect(record.state?.fallback?.base).toEqual(baseLayer(EXTRACT_ID, 1));
    expect(record.calls.filter(call => call.startsWith('deleteObjects:'))).toEqual([]);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, EXTRACT_ID))).toBe(true);
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
    for (const key of [baseObjectKey(STORE_ROOT, CHAIN_ID), deltaObjectKey(STORE_ROOT, CHAIN_ID),
      metadataObjectKey(STORE_ROOT, CHAIN_ID)]) {
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
      record.objects.set(baseObjectKey(STORE_ROOT, id), BASE_BYTES);
      record.objects.set(deltaObjectKey(STORE_ROOT, id), DELTA_BYTES);
      record.objects.set(metadataObjectKey(STORE_ROOT, id), 64);
    }

    await snapshotChainStorage(record.ports).discard();

    const deleted = record.calls.findIndex(call => call.startsWith('deleteObjects:'));
    const cleared = record.calls.indexOf('clearState');
    expect(deleted).toBeLessThan(cleared);
    expect(record.calls).toContain('deleteObjects:6');
    for (const id of [CHAIN_ID, stranded]) {
      for (const key of [baseObjectKey(STORE_ROOT, id), deltaObjectKey(STORE_ROOT, id), metadataObjectKey(STORE_ROOT, id)]) {
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
    // Against the path this attach really mounted — read back from its own
    // call — rather than a path restated beside the strategy.
    const store = storeMountOf(record.calls);
    for (const command of resets) {
      expect(command).not.toContain(store);
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
    // The attach asks for the mount again rather than assuming it survived
    // the container, and the SDK admits the same prefix at the same setting.
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

describe('the binding has ONE mount for the container\'s life', () => {
  test('checkpoint -> stop -> wake-attach -> checkpoint commits, one mount, one setting',
    async () => {
      // THE DEPLOYED FAILURE, reproduced as a lifecycle rather than as an
      // assertion. Runs e2e20260902032038 and e2e20260902032318 both died at
      // their second checkpoint after a wake, with the SDK's own sentence:
      // `R2 binding "BACKUP_BUCKET" is already mounted at /backups with a
      // different readOnly setting`. The wake's attach had mounted the chain
      // subtree READ-ONLY, could not release it — squashfuse reads each layer's
      // archive through it — and left the SDK's registry holding the read-only
      // entry; the publication then asked for the same binding WRITABLE and was
      // refused.
      //
      // The registry AND the container's mount table are both SHARED across the
      // three harnesses, because neither belongs to the isolate: the SDK keeps
      // one registry per container, and `/proc/mounts` is the container's own
      // file. A stop and a wake are two isolates on one container, which is
      // exactly the sequence that killed the live run.
      const registry: SdkMountRegistry = {};
      const container: ContainerMounts = {};
      const firstCalls: string[] = [];
      const first = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        calls: firstCalls,
        registry, mountsTable: container,
      });
      expect((await checkpointOf(first, 'tick')).kind).toBe('committed');

      // The stop, then the wake: a fresh isolate on the SAME container, so the
      // registry still holds whatever the first checkpoint left. The wake's
      // attach is the moment the old design's read mount is taken.
      const wakeCalls: string[] = [];
      const woken = harness({
        state: first.state, mounts: mountsAfterAttach(wakeCalls), calls: wakeCalls,
        registry, mountsTable: container,
      });
      woken.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), DELTA_BYTES);
      expect((await attachOf(woken)).kind).toBe('attached');

      // THE SECOND CHECKPOINT, and it commits. Under the two-setting design it
      // is refused by the registry with the SDK's own sentence. Its upper is a
      // DIFFERENT fingerprint from the one the first commit recorded, so there
      // is a delta to publish rather than a skip.
      const secondCalls: string[] = [];
      const second = harness({
        state: { ...first.state!, upperMark: 'stale-again', at: 1 },
        mounts: MOUNTED,
        calls: secondCalls,
        registry, mountsTable: container,
        upperMark: '8:4096:1700000000',
        now: 20 * INTERVAL_MS,
      });
      expect((await checkpointOf(second, 'tick')).kind).toBe('committed');

      // AND EVERY MOUNT IS THE ONE MOUNT: the chain's subtree, at the one mount
      // point, in the one setting — across the checkpoint that wrote a base, the
      // attach that read it back, and the checkpoint that wrote a delta after
      // the wake.
      const one = [...new Set([...firstCalls, ...wakeCalls, ...secondCalls]
        .filter(call => call.startsWith('mountStore:'))
        .map(call => call.split(':')[1]!))];
      expect(one).toHaveLength(1);
      // Both publications landed, and the wake's attach proved the first one.
      expect(second.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(DELTA_BYTES);
    });

  test('a REBASE across a container life mounts nothing new, and the fold commits',
    async () => {
      // THE LATENT HAZARD THE PER-BOX ROOT CLOSES. A rebase mints a NEW
      // generation id while the old generation's layers are still mounted as the
      // live overlay's lowers — squashfuse reads them through the store mount, so
      // that mount cannot be released. Under a per-GENERATION prefix the fold's
      // publication needed a different subtree at the same path, which the SDK
      // refuses ('already mounted at … with a different prefix'), and the box
      // could never collapse its chain again. Under the box's own root the fold
      // writes through the mount it already holds.
      const registry: SdkMountRegistry = {};
      const container: ContainerMounts = {};
      const wakeCalls: string[] = [];
      const woken = harness({
        state: chainState({ delta: deltaLayer(CHAIN_ID, DELTA_BYTES) }),
        mounts: mountsAfterAttach(wakeCalls),
        calls: wakeCalls,
        registry, mountsTable: container,
      });
      expect((await attachOf(woken)).kind).toBe('attached');
      const mountsAfterWake = wakeCalls.filter(call => call.startsWith('mountStore:')).length;

      // The upper is NOT the whole changed set — the delta is a layer — so this
      // commit collapses the chain onto a fresh generation.
      const foldCalls: string[] = [];
      const fold = harness({
        state: woken.state,
        // The composed shape the wake left, at the paths THAT attach chose —
        // read back from its own calls rather than restated here, so the fold
        // cannot be handed a mount line the strategy disagrees with. The layer
        // paths are what make the upper less than the whole changed set and
        // force the collapse.
        mounts: composedMounts({
          chainId: CHAIN_ID,
          store: storeMountOf(wakeCalls),
          base: layerMountOf(wakeCalls, baseObjectKey(STORE_ROOT, CHAIN_ID)).point,
          delta: layerMountOf(wakeCalls, deltaObjectKey(STORE_ROOT, CHAIN_ID)).point,
        }),
        calls: foldCalls,
        registry, mountsTable: container,
        upperMark: 'written-since-the-wake',
        now: 20 * INTERVAL_MS,
      });
      const folded = await checkpointOf(fold, 'quiesce');

      expect(folded.kind).toBe('committed');
      // A FRESH generation, published through the mount the wake already held.
      expect(fold.state?.base.id).not.toBe(CHAIN_ID);
      expect(foldCalls.filter(call => call.startsWith('mountStore:'))).toEqual([]);
      expect(mountsAfterWake).toBe(1);
      // And the registry still holds exactly the box's root, unchanged by a
      // generation that did not exist when it was mounted.
      expect(registry.held).toEqual({ prefix: `${STORE_ROOT}/`, readOnly: false });
      expect(fold.objects.has(baseObjectKey(STORE_ROOT, fold.state!.base.id))).toBe(true);
    });

  test('a generation that changes releases the one mount before the next takes it',
    async () => {
      // The other half of one-mount: a NEW chain id needs a different prefix,
      // and the SDK refuses a second mount of a binding at a different prefix.
      // So the attach that changes generation releases the mount FIRST — the
      // call is unconditional, on a path nothing holds, which the product port
      // survives when there is nothing to release.
      const registry: SdkMountRegistry = {};
      const firstCalls: string[] = [];
      const first = harness({
        state: chainState(), mounts: mountsAfterAttach(firstCalls), calls: firstCalls,
        registry,
      });
      expect((await attachOf(first)).kind).toBe('attached');
      // THE BOX'S ROOT, not a generation's: that is what lets one mount serve
      // every generation this box will publish, a rebase included.
      expect(registry.held).toEqual({ prefix: `${STORE_ROOT}/`, readOnly: false });

      const secondCalls: string[] = [];
      const second = harness({
        state: first.state, mounts: mountsAfterAttach(secondCalls), calls: secondCalls,
        registry,
      });
      expect((await attachOf(second)).kind).toBe('attached');
      expect(secondCalls.indexOf(`unmountStore:${storeMountOf(secondCalls)}`))
        .toBeLessThan(secondCalls.findIndex(call => call.startsWith('mountStore:')));
    });
});

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
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);

    // The container is replaced, so the next start attaches for real. THAT is
    // the proof, and it is what retires the fallback — named, not deleted.
    attached = false;
    expect((await storage.attach()).kind).toBe('attached');
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.state?.orphans).toEqual([CHAIN_ID]);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);

    // The next publication is what finally deletes it, through the sweep that
    // has always run there.
    record.upperMark = 'restarted-and-wrote';
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');
    expect(record.state?.orphans).toBeUndefined();
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(false);
    // One generation left, and it is the one an attach has served.
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.objects.has(baseObjectKey(STORE_ROOT, rebased))).toBe(true);
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
    expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
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
      record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));

      const outcome = await attachOf(record);

      expect(outcome.kind).toBe('attached');
      expect(outcome.detail).toContain('recovered');
      // The FALLBACK's layers are what mounted, and the refused generation's
      // store subtree was never even mounted.
      // ONE mount, whichever generation it ends up serving: the recovery
      // mounts the box's root once and reads the fallback's layers through it.
      // The path is the strategy's own choice, read back off its call.
      const store = storeMountOf(record.calls);
      expect(record.calls.filter(call => call.startsWith('mountStore:')))
        .toEqual([`mountStore:${store}`]);
      // And what it READ is the fallback's objects, never the refused one's.
      expect(record.calls).toContain(`awaitLayer:${store}/${FALLBACK_ID}/data.sqsh`);
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
      record.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES + 4_096);

      expect((await attachOf(record)).detail).toContain('recovered');

      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.lastFailure?.reason).toContain('state declares');
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
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
    record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));
    record.objects.delete(baseObjectKey(STORE_ROOT, FALLBACK_ID));

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
      record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));

      await expect(attachOf(record)).rejects.toThrow(/names no earlier generation/);

      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('a promotion that cannot be written serves nothing', async () => {
    // The promotion is the only durable write a recovery makes before it mounts
    // anything, so its failure is pre-commit and travels: the box does not
    // start, and the record still names exactly what it named before.
    const record = harness({ state: withFallback(), mounts: NOT_MOUNTED, rejectWrites: [1] });
    record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));

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
  test('nothing is copied out of an archive at all, and the upper is emptied first', async () => {
    // WHAT USED TO CARRY THIS PROPERTY, and what carries it now. The restore's
    // only write into the workspace was `cp -a` out of a mounted squashfs, so
    // the containment argument was about that copy: `-a` recreates symlinks
    // instead of following them, and the reset in the same attach guaranteed no
    // symlink was already sitting at a path the copy walked.
    //
    // A composed attach writes NO archive content anywhere. An archive is
    // reachable only through its own mount point, which is inside this
    // strategy's private runtime directory, and the overlay's upper starts
    // empty. There is no copy to escape through, which is a stronger statement
    // than a careful copy — so this pins the absence.
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
    const raw: string[] = [];
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      raw.push(command);
      return await inner(command);
    };

    expect((await attachOf(record)).kind).toBe('attached');

    // No extraction, in any spelling the image offers.
    expect(raw.filter(command => /^(cp|tar|rsync|unsquashfs)\b/.test(command))).toEqual([]);
    // The upper is emptied BEFORE anything is mounted over it, so a composed
    // attach's writable layer holds exactly what is written after it.
    const emptied = raw.findIndex(command =>
      command.startsWith('rm -rf') && command.includes(UPPER) && command.includes('mkdir -p'));
    const mounted = raw.findIndex(command => command.includes('squashfuse'));
    expect(emptied).toBeGreaterThan(-1);
    expect(mounted).toBeGreaterThan(emptied);
    // And every archive is reachable only under this strategy's own runtime
    // directory: a layer cannot be mounted over the workspace or anywhere a
    // caller writes.
    for (const command of raw.filter(line => line.includes('squashfuse'))) {
      expect(command).toContain(`${DEVBOX_RUNTIME_DIR}/`);
      expect(command).not.toContain(`${DEVBOX_WORKDIR} `);
    }
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
    record.digests.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);

    const outcome = await attachOf(record);

    expect(outcome.detail).toContain('recovered');
    expect(record.state?.base.id).toBe(FALLBACK_ID);
    expect(record.state?.lastFailure?.reason).toContain('different archive of the same length');
    // The SIZE never disagreed, so nothing but the digest could have caught it,
    // and nothing was deleted on the way through.
    expect(record.objects.get(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(BASE_BYTES);
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
      corrupt.digests.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);
      expect((await attachOf(corrupt)).detail).toContain('recovered');
      expect(corrupt.state?.lastFailure?.reason).toContain('delta archive');
      expect(corrupt.state?.lastFailure?.reason).toContain('different archive of the same length');

      const adopting: string[] = [];
      const superseded = harness({
        state: withFallback(), mounts: mountsAfterAttach(adopting), calls: adopting,
      });
      const drifted = DELTA_BYTES + 4_096;
      superseded.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), drifted);
      superseded.digests.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);
      superseded.versions.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_VERSION);

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
      record.digests.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);
      record.digests.set(baseObjectKey(STORE_ROOT, FALLBACK_ID), REPLACED_DIGEST);

      const failure = attachOf(record);
      await expect(failure).rejects.toThrow(/different archive of the same length/);
      await expect(failure).rejects.toThrow(/cannot be served either/);

      // Both generations are still named and still there.
      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
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
    record.digests.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);
    record.versions.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_VERSION);

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
      record.versions.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_VERSION);

      const outcome = await attachOf(record);

      expect(outcome.detail).toContain('recovered');
      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.lastFailure?.reason).toContain('written by a different upload');
      expect(record.state?.lastFailure?.reason).toContain('no checksum');
      // Size never disagreed and no digest existed on either side, so the
      // version is the only thing that could have caught it.
      expect(record.objects.get(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(BASE_BYTES);
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
        .toBe(versionOf(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES));
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
      expect(record.digests.get(deltaObjectKey(STORE_ROOT, CHAIN_ID)))
        .toBe(record.state?.delta?.digest);
    });
});
