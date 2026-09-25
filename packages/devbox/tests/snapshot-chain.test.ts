// Snapshot-chain gate: one immutable base plus one cumulative delta; attach mounts fixed
// lazy layers moving zero bytes, a checkpoint moves only changed bytes (D2).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const suiteRoot = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}snapshot-chain-`));

afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

function devboxScratchDir(label: string): string {
  return mkdtempSync(join(suiteRoot, `${label}-`));
}

import {
  archiveCommand,
  archiveSizeCommand,
  baseObjectKey,
  chainBackupOptions,
  ChainRecordAdvanced,
  chainStoreRoot,
  CHAIN_EXCLUDES,
  deltaObjectKey,
  metadataObjectKey,
  normalizeChainState,
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

/** Paths are read off the strategy's own mount calls, never mirrored: a copy agrees by
 *  construction and cannot catch the strategy reading somewhere other than it mounted. */

/** Derived through the strategy's own helper, not spelled, so every key a test names lives
 *  under the one mount; `boxes/box-under-test` is a fixture identity. */
const STORE_ROOT = chainStoreRoot('boxes/box-under-test');

/** One mount per binding per container life: no read/write split to model; a reattach
 *  releases the registry state the last mount held and a fresh mount replaces it. */
function storeMountOf(calls: readonly string[]): string {
  const at = calls
    .filter((call) => call.startsWith('mountStore:'))
    .map((call) => call.split(':')[1])[0];

  if (at === undefined) {
    throw new Error(`the strategy mounted no store; calls: ${calls.join(', ')}`);
  }

  return at;
}

interface LayerMount {
  readonly index: number;
  readonly archive: string;
  readonly point: string;
}

function layerMountOf(calls: readonly string[], objectKey: string): LayerMount {
  const archiveName = objectKey.slice(objectKey.lastIndexOf('/') + 1);

  const index = calls.findIndex((call) => {
    const parts = call.split(':');

    return parts[0] === 'mountLayer' && parts[1]?.endsWith(`/${archiveName}`) === true;
  });

  if (index === -1) {
    throw new Error(`no layer was mounted for ${objectKey}; calls: ${calls.join(', ')}`);
  }

  const parts = calls[index].split(':');

  return { index, archive: parts[1], point: parts[2] };
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
import { sessionShellOutput, sessionShellRefusal } from './support/session-shell';

const CHAIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const EXTRACT_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

const FALLBACK_ID = 'a1b2c3d4-0000-4000-8000-0000000000fb';

const FALLBACK_BYTES = 2_048;

const BASE_BYTES = 4_096;

const DELTA_BYTES = 512;

const INTERVAL_MS = 5 * 60_000;

const STAGE_NEED_BYTES = 1_000;

const UPPER = `${DEVBOX_RUNTIME_DIR}/upper`;

const LOWER_BASE = `${DEVBOX_RUNTIME_DIR}/lower-base`;

/** What the PRODUCTION image reports for an attached chain: fuse-overlayfs, with NO dir options,
 *  over the base layer, whose mount names its archive (`fsname`). */
const MOUNTED = [
  'sysfs /sys sysfs rw,relatime 0 0',
  `/backups/${CHAIN_ID}/data.sqsh ${LOWER_BASE} fuse.squashfuse ro,nosuid,nodev,relatime 0 0`,
  `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
].join('\n');

const NOT_MOUNTED = 'proc /proc proc rw,relatime 0 0\n/dev/vdc / ext4 rw 0 0';

/** Same mount text; the upper directory is missing as a PATH, not a mount option,
 *  because fuse-overlayfs publishes no options to be missing. */
const MOUNTED_NO_UPPER = MOUNTED;

const seenAttach = new Set<string>();

const seenCheckpoint = new Set<string>();

/** Stand-in for an upload's SHA-256: deterministic per key and size so tests can predict it,
 *  and different for different content, which is the property under test. */
function digestOf(key: string, bytes: number): string {
  return createHash('sha256').update(`${key}:${bytes}`).digest('hex');
}

/** Stands in for the version the store mints per upload; kept distinct from the digest
 *  because a replacement can carry a matching digest but never a matching version. */
function versionOf(key: string, bytes: number): string {
  return `upload-${createHash('sha256').update(`${key}:${bytes}`).digest('hex').slice(0, 12)}`;
}

function baseLayer(id: string, bytes: number): ChainBaseLayer {
  return {
    id,
    bytes,
    digest: digestOf(baseObjectKey(STORE_ROOT, id), bytes),
    objectVersion: versionOf(baseObjectKey(STORE_ROOT, id), bytes),
  };
}

function deltaLayer(id: string, bytes: number): ChainLayer {
  return {
    bytes,
    digest: digestOf(deltaObjectKey(STORE_ROOT, id), bytes),
    objectVersion: versionOf(deltaObjectKey(STORE_ROOT, id), bytes),
  };
}

function publishedDeltaId(state: ChainState | null): string {
  const id = state?.delta?.id;

  if (id === undefined) throw new Error('published delta lacks its immutable identity');
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(id).not.toBe(state?.base.id);

  return id;
}

function publishedDeltaLayer(state: ChainState | null, bytes: number) {
  const id = publishedDeltaId(state);

  return { ...deltaLayer(id, bytes), id };
}

interface Harness {
  readonly ports: SnapshotChainPorts;
  readonly calls: string[];
  /** The store, as key to size. Omitting a key is a missing object; a
   *  disagreeing size is a corrupt one. */
  readonly objects: Map<string, number>;
  /** Mirrors the live publication meter: three `put`s for an s3fs `dd`, one for the
   *  egress publisher. */
  readonly attempts: { operation: 'put' | 'uploadPart' | 'complete'; key: string; bytes: number }[];
  /** The digest the STORE reports per key, which is how a same-length
   *  replacement is expressed: same size, different digest. */
  readonly digests: Map<string, string>;
  /** The upload version the STORE reports per key. A same-length replacement
   *  that even copies the digest still cannot copy this. */
  readonly versions: Map<string, string>;
  state: ChainState | null;
  /** The live fingerprint of the changed set; set it to simulate a write. */
  upperMark: string;
}

/** Call only after a case asserts a commit landed; a missing record then means it published nothing. */
function publishedState(record: Harness): ChainState {
  const { state } = record;

  if (state === null) throw new Error('the harness holds no record: nothing published one');

  return state;
}

function retainedFallback(state: ChainState): ChainGeneration {
  const { fallback } = state;

  if (fallback === undefined) throw new Error('the record names no fallback generation');

  return fallback;
}

interface ShellOutcome {
  readonly call: string;
  readonly stdout: string;
}

/** Decodes the base64 exclude list so assertions test exclude policy, not argument spelling.
 *  Non-anchored twins are dropped, so the count equals the policy's own length. */
function excludePatternsOf(command: string): readonly string[] {
  const encoded = /printf %s '(?<data>[A-Za-z0-9+/=]*)'/.exec(command)?.groups?.data ?? '';

  return atob(encoded).split('\n')
    .filter(line => line !== '' && !line.startsWith('... '));
}

/** Each composed command is checked against the container's one persistent session shell;
 *  `support/session-shell.ts` models its two real failures: an `exit` and a parse error. */

/** An unrecognised command falls through to its first word, so a new command shows up in
 *  the recorded calls instead of silently resolving as nothing. */
const DELTA_SHELL_REPLIES: ReadonlyMap<string, ShellOutcome> = new Map([
  ['# devbox-probe-v1', { call: 'deltaProbe', stdout: '0 ' }],
  ['# devbox-whiteout-v1', { call: 'deltaWhiteoutStat', stdout: '0,0' }],
  ['# devbox-basestat-v1', { call: 'deltaBaseStat', stdout: 'ABSENT' }],
  ['# devbox-blockhash-v1', { call: 'deltaBlockHash', stdout: '' }],
  ['# devbox-stage-v1', { call: 'deltaStage', stdout: '' }],
  ['# devbox-materialize-v1', { call: 'deltaMaterialize', stdout: '' }],
  ['# devbox-materialize-v1-post', { call: 'deltaMaterializePost', stdout: '' }],
  ['# devbox-manifest-v1', { call: 'deltaManifest', stdout: '' }],
]);

interface ShellWorld {
  readonly command: string;
  readonly mounts: string;
  readonly absent: (path: string) => boolean;
  readonly freeBytes: number;
  readonly upperMark: string;
  readonly stagedSize: string;
}

function shellLabel(world: ShellWorld): ShellOutcome {
  const { command, mounts, absent, freeBytes, upperMark, stagedSize } = world;
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');

  if (command === 'cat /proc/mounts') return { call: 'readMounts', stdout: mounts };

  if (command.startsWith('# devbox-tick-probe-v2\n')) return { call: 'probeTick', stdout: `${upperMark}\n${mounts}` };

  const delta = DELTA_SHELL_REPLIES.get(command.split('\n')[0]);

  if (delta !== undefined) return delta;

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

  // The retry bound lives inside the strategy's command, so this fake never models it;
  // a path a case declares absent stays absent however many times it is asked.
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
    return { call: `mountLayer:${layer.archive}:${layer.point}`, stdout: '' };
  }

  const overlay = /fuse-overlayfs -o lowerdir=(?<lowers>.+?),upperdir=.+ (?<dir>'[^']+')$/
    .exec(command)?.groups;

  if (overlay !== undefined) {
    return {
      call: `overlayAttach:${unquote(overlay.dir)}:${overlay.lowers.split(':').length}`,
      stdout: '',
    };
  }

  // No arm for a seeding `cp -a`: the delta is a layer, so any copy falls through to
  // `exec:cp` and the assertions detect it by name.
  const squash = /mksquashfs '(?<source>[^']+)'/.exec(command)?.groups?.source;

  if (squash !== undefined) {
    // Build, exclude list and measurement are one command, so the fake answers all three:
    // it counts the exclude policy decoded from the staged list and reports `<exit> <bytes>`.
    return {
      call: `makeSquashfs:${squash}:${excludePatternsOf(command).length}`,
      stdout: stagedSize,
    };
  }

  if (command.includes('sort -z') && command.includes('sha256sum')) {
    return { call: 'upperFingerprint', stdout: upperMark };
  }

  if (command.startsWith('stat -c %s')) return { call: 'statBytes', stdout: String(DELTA_BYTES) };

  return { call: `exec:${command.split(' ')[0]}`, stdout: '' };
}

/** Shared across the harnesses one test builds, so two isolates on one container
 *  see the same held mount. */
interface SdkMountRegistry {
  held?: { readonly prefix: string; readonly readOnly: boolean };
}

/** `/proc/mounts` belongs to the container, not the isolate, so a stop and a wake (two
 *  isolates, one container) must see the same shared table. */
interface ContainerMounts {
  mounted?: { readonly at: string; readonly prefix: string };
  /** The instance these mounts belong to; a new answer is a replacement. */
  generation?: string | undefined;
}

function harness(overrides: {
  state?: ChainState | null;
  mounts?: string | (() => string);
  /** Asked per path, not listed, so a case can say "the store subtree exposes nothing"
   *  without knowing where the strategy mounted the store. */
  absent?: (path: string) => boolean;
  generations?: string[];
  entriesAfterExtract?: number;
  running?: boolean;
  change?: { status: ChangeStatus; version: string } | Error;
  now?: number;
  /** The store takes nothing: the container's flush fails, the only failure a publication has. */
  failPublish?: boolean;
  failDelete?: boolean;
  /** Which `writeState` calls reject, by 1-based arrival order. `[2]` fails only the
   *  post-commit failure stamp, the one durable write after a record is published. */
  rejectWrites?: readonly number[];
  refuseOverlay?: boolean;
  /** Only the FIRST delta-layer mount dies: an attach that cannot compose its own delta
   *  must leave no overlay. */
  failDeltaLayer?: boolean;
  /** What the changed set fingerprints to. Empty means the probe failed. */
  upperMark?: string;
  /** What the archiver reports as `<exit> <bytes>`. `'0 0'` claims success with no file present. */
  stagedReport?: string;
  /** Bytes the store ends up holding when they differ from the staged size: a mid-write
   *  stat can read short while the copy lands the whole archive. */
  landedBytes?: number;
  /** Mount-reported size after the flush; a mismatch with the store's size means the flush
   *  did not carry every byte, and the publication must refuse it. */
  flushedBytes?: number;
  /** The copy reports success but the store holds nothing under the key: s3fs answers a
   *  flush from its own view, so a clean exit can cover an object the store never took. */
  publishLandsNothing?: boolean;
  landedDigest?: string;
  landedVersion?: string;
  refuseStoreMount?: boolean;
  extractLands?: boolean;
  allowExtraction?: boolean;
  archiveExcludes?: readonly string[];
  freeBytes?: number;
  /** A caller-owned array to record into, so a staged `mounts` closure can read
   *  the calls made so far without a forward reference to the harness. */
  calls?: string[];
  /** The seed stamp this container's disk already carries: which delta the upper
   *  beside it holds. A replaced container has none, which is the default. */
  seedStamp?: string;
  /** The SDK mount registry, shared across a test's harnesses so two isolates on one container
   *  see the binding's one mount, as a stop and wake do. Omitted: a private, untouched container. */
  registry?: SdkMountRegistry;
  /** Shared across harnesses: a fresh harness is a fresh isolate, not a fresh container,
   *  and `/proc/mounts` does not reset with it. */
  mountsTable?: ContainerMounts;
} = {}): Harness {
  const generations = [...(overrides.generations ?? [])];
  const calls = overrides.calls ?? [];
  const objects = new Map<string, number>();
  /** A key absent here is an object R2 was never handed a checksum for (every multipart
   *  upload); it reads as unknown, not as unsound. */
  const digests = new Map<string, string>();
  /** What the store reports as an object's upload version; R2 always has one.
   *  A key absent here expresses a pre-version record. */
  const versions = new Map<string, string>();
  let state = overrides.state ?? null;
  const staged = overrides.mounts ?? NOT_MOUNTED;
  const mounts = (): string => (staged instanceof Function ? staged() : staged);
  let extractSeq = 3;
  let seedStamp = overrides.seedStamp;
  let deltaLayerDied = false;
  let liveMark = overrides.upperMark ?? '7:4096:1700000000';
  let writes = 0;
  /** Every object-store write attempt a publication makes, in order, as the publication meter
   *  counts them: three `put`s under s3fs's `dd`, one under the egress publisher. */
  const attempts: { operation: 'put' | 'uploadPart' | 'complete'; key: string; bytes: number }[] = [];
  /** One mount, one setting, for the container's life: the SDK admits a second mount of a
   *  binding only at the same prefix and setting. Shared when asked, so stop-and-wake sees one. */
  const table: ContainerMounts = overrides.mountsTable ?? {};
  /** Models the SDK registry: a second mount of a binding is admitted only at the same prefix
   *  with the same setting. Shared when asked, since the SDK holds one per container. */
  const sdk: SdkMountRegistry = overrides.registry ?? {};

  /** The only way an object enters this store: no port carries a payload byte, so an
   *  appearing object is the container writing through the mount; none means no publication. */
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
    // The mount's own byte count after the flush; a value differing from `landed` models a lost tail.
    const flushed = overrides.flushedBytes ?? landed;

    // Models s3fs's three PUTs in its order: directory marker on `mkdir -p`, empty object on
    // `create`, payload on the fsync flush; this floor is why the egress publisher exists (D15).
    const parent = key.slice(0, key.lastIndexOf('/') + 1);

    attempts.push({ operation: 'put', key: parent, bytes: 0 });
    attempts.push({ operation: 'put', key, bytes: 0 });

    if (overrides.failPublish === true) {
      attempts.push({ operation: 'put', key, bytes: landed });

      return { stdout: '1 0', stderr: 'dd: fsync failed: Input/output error', exitCode: 0 };
    }

    attempts.push({ operation: 'put', key, bytes: landed });

    if (overrides.publishLandsNothing !== true) {
      objects.set(key, landed);
      digests.set(key, overrides.landedDigest ?? digestOf(key, landed));
      versions.set(key, overrides.landedVersion ?? versionOf(key, landed));
    }

    return { stdout: `0 ${flushed}`, stderr: '', exitCode: 0 };
  };

  /** The PUT URL is relative to the mount's prefix: the SDK's `r2EgressHandler` prepends it,
   *  so the fake lands at `${prefix}/${key}`. An unheld mount answers the handler's 403. */
  const publishEgress = (objectUrl: string) => {
    const mount = table.mounted;

    if (mount === undefined) {
      calls.push('publishArchive:unmounted-egress');

      return {
        stdout: '1 ',
        stderr: 'Access to R2 bucket is not permitted. Call mountBucket() with this bucket before accessing it.',
        exitCode: 0,
      };
    }

    const relative = /^https?:\/\/[^/]+\/[^/]+\/(?<key>.+)$/.exec(objectUrl)?.groups?.key;

    if (relative === undefined || relative.includes('..')) {
      return { stdout: '1 ', stderr: `PUT answered 403 for ${objectUrl}`, exitCode: 0 };
    }

    const key = `${mount.prefix}${relative}`;

    calls.push(`publishArchive:${key}`);
    const landed = overrides.landedBytes ?? DELTA_BYTES;
    attempts.push({ operation: 'put', key, bytes: landed });

    if (overrides.failPublish === true) {
      return { stdout: '1 ', stderr: 'PUT answered 500: the store refused the upload', exitCode: 0 };
    }

    if (overrides.publishLandsNothing !== true) {
      objects.set(key, landed);
      digests.set(key, overrides.landedDigest ?? digestOf(key, landed));
      versions.set(key, overrides.landedVersion ?? versionOf(key, landed));
    }

    // Models the publisher's HEAD after the PUT: the store reports `landed`, or `flushed`
    // for the lost-tail shape.
    const reported = overrides.publishLandsNothing === true
      ? 0
      : (overrides.flushedBytes ?? landed);

    if (reported !== landed) {
      return {
        stdout: '3 ',
        stderr: `the store reports ${reported} bytes for ${objectUrl} where ${landed} were sent`,
        exitCode: 0,
      };
    }

    return { stdout: `0 ${landed} "${versionOf(key, landed)}"`, stderr: '', exitCode: 0 };
  };


  const ports: SnapshotChainPorts = {
    containerRunning: () => overrides.running ?? true,
    stamp: (phase) => {
      calls.push(`stamp:${phase}`);
    },
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
    writeState: (next, expectedRev) => {
      writes += 1;
      const rejected = overrides.rejectWrites?.includes(writes) === true;
      calls.push(
        `writeState:${next.rev}:${next.base.id}:${next.delta === undefined ? 'base' : 'delta'}`
        + `${next.lastFailure === undefined ? '' : ':failed'}${rejected ? ':rejected' : ''}`,
      );

      // A rejected put changes nothing durable: the next reader still finds the prior record.
      if (rejected) return Promise.reject(new Error('durable storage unreachable'));
      // Models the Durable Object transaction's compare-and-set fence on `rev`.
      const stored = state?.rev ?? null;

      if (stored !== expectedRev) return Promise.reject(new ChainRecordAdvanced(expectedRev, stored));
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
    // The fake execs the strategy's real commands and models the SDK's persistent shell: `exit`
    // or an unparseable command ends the session, failing any test that runs it (D18).
    exec: (command) => {
      const refused = sessionShellRefusal(command);

      if (refused !== undefined) {
        calls.push(`sessionKilled:${command.split(' ')[0]}`);

        return Promise.reject(refused);
      }

      // The archive moves because the container writes it to the store, not via bytes to the isolate.
      // The publisher runs `bun <runtime>/devbox-publish.mjs` and lands one object attempt (D15).
      const egress = /bun '(?<script>[^']*devbox-publish\.mjs)' '(?<archive>[^']+)' '(?<url>[^']+)' \d+/
        .exec(command)?.groups;

      if (egress !== undefined) return Promise.resolve(publishEgress(egress.url));

      // The publication creates the generation's directory first (s3fs shows no parent for an
      // empty prefix), so the matcher reads the `dd` rather than the start of the line.
      const published = /dd if='(?<archive>[^']+)' of='(?<mounted>[^']+)' bs=4M conv=fsync;/
        .exec(command)?.groups;

      if (published !== undefined) return Promise.resolve(publish(published.mounted));

      // `mountStoreOnce` reads `/proc/mounts`, so the fake lists the store mount there as real s3fs
      // does: one line at the path, only while the fake holds it mounted.
      const procMounts = () => table.mounted === undefined
        ? mounts()
        : `${mounts()}\ns3fs ${table.mounted.at} fuse.s3fs rw,nosuid,nodev,relatime 0 0\n`;

      const label = shellLabel({
        command,
        mounts: procMounts(),
        absent: overrides.absent ?? (() => false),
        freeBytes: overrides.freeBytes ?? Number.MAX_SAFE_INTEGER,
        upperMark: liveMark,
        stagedSize: overrides.stagedReport ?? `0 ${DELTA_BYTES}`,
      });

      calls.push(label.call);

      if (label.call.startsWith('mountLayer:') && label.call.includes('/lower-delta/')
        && overrides.failDeltaLayer === true && !deltaLayerDied) {
        // One-shot: only the first delta mount fails, so a same-container retry can succeed,
        // modelling a transient layer failure rather than a permanent one.
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
        // Models the real local failure (no FUSE device), not the interception wording, so the
        // degrade cannot pass merely by recognising one particular sentence.
        return Promise.reject(new Error('S3FS mount failed: fuse: device not found'));
      }

      return Promise.resolve({ stdout: label.stdout, stderr: '', exitCode: 0 });
    },
    containerGeneration: async () => {
      const next = generations.length > 1 ? generations.shift() : generations[0];

      // A replacement is a new container, whose mount table is blank.
      if (next !== table.generation && table.generation !== undefined) table.mounted = undefined;
      table.generation = next;

      return next;
    },
    storeRoot: () => STORE_ROOT,
    storeObjectUrl: (key) => {
      if (!key.startsWith(`${STORE_ROOT}/`)) {
        throw new Error(`storeObjectUrl: ${key} is outside this box's store prefix ${STORE_ROOT}`);
      }

      return `http://r2.internal/BACKUP_BUCKET/${key.slice(STORE_ROOT.length + 1)}`;
    },
    mountStore: (at) => {
      calls.push(`mountStore:${at}`);

      if (overrides.refuseStoreMount === true) {
        // A container without a FUSE device; deliberately not the interception wording, so the
        // degrade cannot pass by recognising one particular sentence.
        return Promise.reject(new Error('S3FS mount failed: fuse: device not found'));
      }

      const prefix = `${STORE_ROOT}/`;
      // Models the SDK's two registries: binding admits a re-mount only at same prefix and setting;
      // path registry refuses any second mount at one path, so a repeat mount is not idempotent.
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

      // Models the product port `#chainPorts.unmountStore`, which survives the SDK's "nothing is
      // mounted here" refusal: always resolves, clearing the mount and registry entry if held.
      if (table.mounted?.at === at) table.mounted = undefined;
      sdk.held = undefined;

      return Promise.resolve();
    },
    objectFacts: (key) => {
      calls.push(`objectFacts:${key}`);
      const bytes = objects.get(key);

      if (bytes === undefined) return Promise.resolve(undefined);

      // R2 omits the digest for any object stored without a checksum, i.e. every multipart upload.
      // An absent version models a store without versions; R2 always has one.
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

  // Seeds current and fallback layers, since restore verifies both, so integrity probes pass
  // by default; a same-length replacement test overrides `digests` or `versions`.
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
      seed(deltaObjectKey(STORE_ROOT, generation.delta.id ?? generation.base.id), generation.delta);
    }
  }

  return {
    ports,
    calls,
    objects,
    digests,
    attempts,
    versions,
    get state() { return state; },
    set state(next) { state = next; },
    /** Fingerprint of the changed set now; setting it simulates a caller write between two
     *  checkpoints. */
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

/** Defaults `digest`/`objectVersion` to what the upload records; an explicit `undefined` is
 *  honoured, modelling a row checkpointed before those fields existed. */
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

/** Mounts flip to attached only after `overlayAttach` is called, so a postcondition observes
 *  a change the code made rather than one the test staged in advance. */
/** The mount table the calls so far leave: `standing` until one mounts or releases the base layer,
 *  then an overlay over the base the last mount named, since its `fsname` is the archive. */
function mountTable(calls: readonly string[], standing: string): string {
  const last = [...calls].reverse().find((call) => call === `unmountPath:${LOWER_BASE}`
    || (call.startsWith('mountLayer:') && call.endsWith(`:${LOWER_BASE}`)));

  if (last === undefined) return standing;
  const archive = last.startsWith('mountLayer:') ? last.slice('mountLayer:'.length, -`:${LOWER_BASE}`.length) : undefined;

  return [
    'sysfs /sys sysfs rw,relatime 0 0',
    ...(archive === undefined ? [] : [`${archive} ${LOWER_BASE} fuse.squashfuse ro,nosuid,nodev,relatime 0 0`]),
    `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
  ].join('\n');
}

/** A fresh box's overlay serves the empty lower, so no base layer is mounted until one is. */
const FRESH_OVERLAY = mountTable(['unmountPath:' + LOWER_BASE], '');

function mountsAfterAttach(calls: readonly string[], mounted = MOUNTED): () => string {
  return () => {
    if (!calls.some(call => call.startsWith('overlayAttach'))) return NOT_MOUNTED;

    return mounted === MOUNTED ? mountTable(calls, FRESH_OVERLAY) : mounted;
  };
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

interface Chosen {
  readonly chainId: string;
  readonly store: string;
  readonly base: string;
  readonly delta: string;
}

/** Paths come from a real attach so cases never restate the strategy's layer choice.
 *  Calls `attach()` directly, not `attachOf`, so observations skip the outcome-kind tally. */
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

/** Two generations: only two observations show a mount path is scoped by generation,
 *  which the collapse rule depends on. */
const CHOSEN = await observeAttach(CHAIN_ID);

const CHOSEN_FALLBACK = await observeAttach(FALLBACK_ID);

function composedMounts(chosen: Chosen): string {
  return [
    'sysfs /sys sysfs rw,relatime 0 0',
    `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
    `${baseObjectKey(STORE_ROOT, chosen.chainId)} ${chosen.base} fuse.squashfuse ro 0 0`,
    `${deltaObjectKey(STORE_ROOT, chosen.chainId)} ${chosen.delta} fuse.squashfuse ro 0 0`,
  ].join('\n');
}

describe('attach — the mount must be observed to have landed', () => {
  test('a box with no history restores nothing, and is still born with an overlay', async () => {
    const calls: string[] = [];
    const record = harness({ state: null, mounts: mountsAfterAttach(calls), calls });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('empty');
    expect(record.calls.filter(call => call.startsWith('mountStore'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
    // The overlay exists over an empty lower so the changed set accumulates from the first write.
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
  });

  test('a host that cannot attach an overlay stays plain instead of failing the start',
    async () => {
      // Models a plain local `wrangler dev` with no fuse-overlayfs: the box starts plain and
      // the first checkpoint decides its mode, rather than refusing to start.
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

      // Layer count is bounded whatever the chain's history: two archives, overlay over both
      // with a fresh upper on top.
      expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
      expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
      expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
      // Both layers must be mounted before the overlay: a mounted overlay is taken as proof the
      // whole composition landed, which the `already-attached` early return assumes.
      const store = storeMountOf(record.calls);
      const base = layerMountOf(record.calls, baseObjectKey(STORE_ROOT, CHAIN_ID));
      const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
      const mounted = record.calls.indexOf(`overlayAttach:${DEVBOX_WORKDIR}:2`);
      // Archives read through this attach's store mount are lazy reads, not downloads.
      expect(base.archive.startsWith(`${store}/`)).toBe(true);
      expect(delta.archive.startsWith(`${store}/`)).toBe(true);
      expect(mounted).toBeGreaterThan(delta.index);
      expect(mounted).toBeGreaterThan(base.index);
      // The delta layer stays mounted after the overlay: it is a lower, and releasing it
      // would empty the merged view of everything the changed set holds.
      expect(record.calls.slice(mounted)).not.toContain('releaseDeltaLayers');
      expect(outcome.detail).toContain(`${BASE_BYTES + DELTA_BYTES}B`);
      expect(outcome.detail).toContain('base+delta layered');
    });

  test('NEWEST LOWER FIRST: the delta precedes the base, or the base would win every path',
    async () => {
      // `lowerdir` resolves left to right; base-first would revert delta rewrites and resurrect
      // files the delta deleted, rolling the workspace back to its last rebase.
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

  test('a base-only attach verifies an unrecorded delta is absent in the store', async () => {
    const calls: string[] = [];

    const record = harness({
      state: chainState({ delta: undefined }),
      mounts: mountsAfterAttach(calls),
      calls,
      absent: (path) => path.endsWith('/delta.sqsh'),
    });

    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.calls).toContain(`objectFacts:${baseObjectKey(STORE_ROOT, CHAIN_ID)}`);
    expect(record.calls).toContain(`objectFacts:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:1`);
  });

  test('a complete unreferenced delta is adopted despite a negative mounted stat',
    async () => {
      // An unreferenced delta comes from a crash between the atomic PUT and the state write;
      // the PUT is all-or-nothing and squashfs verifies its superblock, so adopting keeps real work.
      const calls: string[] = [];

      const record = harness({
        state: chainState({ delta: undefined }),
        mounts: mountsAfterAttach(calls),
        calls,
        absent: (path) => path.endsWith('/delta.sqsh'),
      });

      record.objects.set(deltaObjectKey(STORE_ROOT, CHAIN_ID), DELTA_BYTES);
      expect((await attachOf(record)).kind).toBe('attached');
      const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
      expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
      expect(delta.point).toContain(CHAIN_ID);
      expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
    });

  test('LIVE WINDOW: a delta layer that will not mount leaves no overlay behind',
    async () => {
      // Both layers mount before the overlay composes them, so a failed delta mount leaves no
      // overlay: a mounted overlay proves both lowers existed and the retry cannot trust less.
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
      expect(mountsAfterAttach(calls)()).toBe(NOT_MOUNTED);

      const retry = await snapshotChainStorage(record.ports).attach();
      expect(retry.kind).toBe('attached');
    });

  test('P1 CONSEQUENCE: a checkpoint cannot launder a half-restored upper into the chain',
    async () => {
      // A checkpoint after a partial attach must not archive the partial upper as the new delta;
      // the overlay gate refuses it: a non-overlay work directory has no changed set to archive.
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
      expect(record.calls).not.toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
    });

  test('an already-mounted box does NOT seed again, because the mount proves it happened',
    async () => {
      // Seeding precedes the overlay mount, so a mounted overlay proves the copy finished;
      // the `already-attached` return needs no re-seed.
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await attachOf(record)).kind).toBe('already-attached');
      expect(record.calls.filter(call => call.startsWith('seedUpper'))).toEqual([]);
      expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
    });

  test('DEPLOYED DEFECT: a kernel overlay with dir options reads as attached too', async () => {
    // fuse-overlayfs never publishes `upperdir` in the mount line, so attach reads the mount fact:
    // both overlay families count as attached; an octal-escaped mountpoint resolves to its path.
    const kernelOverlay = [
      'sysfs /sys sysfs rw,relatime 0 0',
      `overlay ${DEVBOX_WORKDIR.replace(/ /g, '\\040')} overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/d 0 0`,
    ].join('\n');

    const record = harness({ state: chainState(), mounts: kernelOverlay });
    expect((await attachOf(record)).kind).toBe('already-attached');

    // A plain FUSE mount at the same path is a real filesystem and NOT an
    // overlay: reading it as one would archive a directory that has no upper.
    const fuseOnly = harness({
      state: chainState(),
      mounts: `sysfs /sys sysfs rw,relatime 0 0\ns3fs ${DEVBOX_WORKDIR} fuse.s3fs rw 0 0`,
    });

    await expect(attachOf(fuseOnly)).rejects.toThrow(/is not an overlay mount/);
  });

  test('a tick inside the minimum interval is skipped; on the boundary it commits', async () => {
    const early = harness({
      state: chainState({ at: 1_000 }), mounts: MOUNTED, upperMark: 'written',
      now: 1_000 + INTERVAL_MS - 1,
    });

    const waited = await checkpointOf(early, 'tick');
    expect(waited.kind).toBe('skipped');
    expect(waited.reason).toContain('within the minimum checkpoint interval');

    const due = harness({
      state: chainState({ at: 1_000 }), mounts: MOUNTED, upperMark: 'written',
      now: 1_000 + INTERVAL_MS,
    });

    expect((await checkpointOf(due, 'tick')).kind).toBe('committed');

    const quiesced = harness({
      state: chainState({ at: 1_000 }), mounts: MOUNTED, upperMark: 'written',
      now: 1_000 + 1,
    });

    expect((await checkpointOf(quiesced, 'quiesce')).kind).toBe('committed');
  });

  test('a quiesce commit never delays the next tick, so a refused stop keeps the loss window', async () => {
    // The loss-window model's counterexample `a_refused_stop_stretches_the_window`, P = INTERVAL_MS.
    const options = { state: chainState({ at: 10 }), mounts: MOUNTED, upperMark: 'before-the-quiesce', now: INTERVAL_MS };
    const record = harness(options);

    expect((await checkpointOf(record, 'quiesce')).kind).toBe('committed');
    record.upperMark = 'written-after-the-quiesce-capture';
    options.now = INTERVAL_MS + 10;

    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
  });

  test('movedBytes: a skip says 0, a failure says undefined, because those differ',
    async () => {
      // A skip attempted no PUT, so 0 is known; a failure may have landed an object before
      // throwing, so it cannot claim 0.
      const idle = harness({ state: chainState(), mounts: MOUNTED, running: false });
      const skipped = await checkpointOf(idle, 'tick');
      expect(skipped.kind).toBe('skipped');
      expect(skipped.movedBytes).toBe(0);

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
      // A rebase supersedes a generation, so held bytes fall while the tick moves a whole
      // fresh archive; this setup makes the two numbers disagree.
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
      // Refusing on the byte count bricks the run: the mount is the validator, and a crash between
      // the PUT and the state write leaves a larger object that never shrinks back.
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
      // The record must describe the archive the attach just served, so the digest is
      // corrected with the size and the disagreement cannot outlive the attach.
      expect(record.state?.delta)
        .toEqual({ bytes: drifted, digest: landed, objectVersion: landedVersion });
      expect(record.calls.some(call => call.startsWith('log:delta record was stale'))).toBe(true);
    });

  test('a delta the record names and the store does NOT hold is still refused', async () => {
    // A missing changed set is content loss, not a stale number: serving the base alone
    // would drop everything written since it, so this must stay a refusal.
    const record = harness({ state: chainState() });
    record.objects.delete(deltaObjectKey(STORE_ROOT, CHAIN_ID));
    await expect(attachOf(record)).rejects.toThrow(/delta archive is missing/);
  });

  test('LIVE DEFECT: every step succeeding with no overlay line FAILS the start', async () => {
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
      // The SDK tracks bucket mounts and refuses a path it believes in use; a raw `fusermount3`
      // unmounts but leaves that claim standing, so every later attach is refused.
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      expect((await attachOf(record)).kind).toBe('attached');
      // The path is the one this attach mounted, read back from its own call, so
      // the release cannot be checked against a path the strategy never used.
      const store = storeMountOf(record.calls);
      expect(record.calls).toContain(`unmountStore:${store}`);
      expect(record.calls).not.toContain(`unmountPath:${store}`);
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

// The delta is composed as a layer, never copied into a fresh upper (D2). A wake whose
// upper carries the matching stamp mounts the base alone; a blank disk mounts the delta.

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
      // Same generation and length, different upload: a replaced delta's shape, which is why
      // the stamp carries the store's own version.
      seedStamp: `${CHAIN_ID}:${DELTA_BYTES}:another-upload`,
    });

    expect((await attachOf(record)).kind).toBe('attached');
    const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
    expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
    expect(delta.point).toContain(CHAIN_ID);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
  });
});

// A stop often yields a fresh container: a blank disk with no upper and no stamp. That wake
// must not copy the changed set: the copy grows with all writes since base, against start budget.

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
    // The strategy's shell has no seeding command, so any `cp` would reach the container
    // as a raw command and be recorded as one.
    expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('seedUpper'))).toEqual([]);
    const delta = layerMountOf(record.calls, deltaObjectKey(STORE_ROOT, CHAIN_ID));
    expect(delta.archive.startsWith(`${storeMountOf(record.calls)}/`)).toBe(true);
    expect(delta.point).toContain(CHAIN_ID);
    expect(record.calls).toContain(`overlayAttach:${DEVBOX_WORKDIR}:2`);
    expect(outcome.detail).toContain('base+delta layered');
  });

  test('claims nothing about the upper: an attach writes no seed stamp', async () => {
    // A seed stamp claims the upper holds the delta; after a composed attach the layer does,
    // so a stamp would let the next commit publish the upper alone and drop the layer's data.
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });

    expect((await attachOf(record)).kind).toBe('attached');

    expect(record.calls.filter(call => call.startsWith('writeSeedStamp'))).toEqual([]);
  });

  test('the layer path names its own generation, so a later commit can see it', async () => {
    // Paths come from a real attach: inside the box's runtime directory so no caller write
    // reaches them, and scoped by generation so two generations never share a mount point.
    expect(CHOSEN.delta.startsWith(`${DEVBOX_RUNTIME_DIR}/`)).toBe(true);
    expect(CHOSEN.delta).toContain(CHAIN_ID);
    expect(CHOSEN_FALLBACK.delta).toContain(FALLBACK_ID);
    expect(CHOSEN_FALLBACK.delta).not.toBe(CHOSEN.delta);

    // Mounts are composed from the attach's chosen path so commit and attach must agree; a foreign
    // generation's layer read as this one's changed set would make every later commit collapse.
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

    // A foreign layer forces no collapse, but the overlay then serves another generation's base,
    // so the upper's changes are relative to that base, not the record's: the merged view is the
    // only exact archive (D31).
    expect((await checkpointOf(foreign, 'tick')).kind).toBe('committed');
    expect(foreign.state?.base.id).not.toBe(CHAIN_ID);
    expect(foreign.state?.delta).toBeUndefined();
  });
});

// With a composed attach the upper holds only changes since the last publication; archiving
// it as the delta would overwrite the served delta with a fragment, so the chain collapses.

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
    // The archive is the work directory, not the upper: only the merged view holds the layer
    // and the upper together.
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${DEVBOX_WORKDIR}:`))).toBe(true);
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${UPPER}:`))).toBe(false);
    expect(record.state?.base.id).not.toBe(CHAIN_ID);
    expect(record.state?.delta).toBeUndefined();
    // And the delta object of the generation being served is never rewritten,
    // which is the loss this rule exists to prevent.
    expect(record.calls).not.toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, CHAIN_ID)}`);
    // The superseded generation is RETAINED as the fallback rather than dropped:
    // its layers are what the live overlay is still serving from.
    expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
  });

  test('until a wake seats the collapsed base, the next commit archives the merged view again', async () => {
    const record = harness({
      state: chainState({ at: 1 }),
      mounts: composedMounts(CHOSEN),
      now: 10 * INTERVAL_MS,
      upperMark: 'written-since-the-wake',
    });

    const storage = snapshotChainStorage(record.ports);

    expect((await storage.checkpoint('tick')).kind).toBe('committed');
    const collapsed = publishedState(record).base.id;
    record.upperMark = 'written-after-the-collapse';

    // A quiesce, so the interval gate the collapse just reset does not decide this commit;
    // the case tests which shape the second commit takes.
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');

    // The overlay still serves the superseded base, so its upper holds files only the collapsed
    // base has: a delta over that base could not carry their deletion (D31).
    expect(record.state?.base.id).not.toBe(collapsed);
    expect(record.state?.delta).toBeUndefined();
    expect(record.calls.filter(call => call.startsWith(`makeSquashfs:${UPPER}:`))).toEqual([]);
  });

  test('an ORPHAN delta the record does not name still forces the collapse', async () => {
    // Crash-window delta: the object landed but the state write did not, so attach adopts it.
    // Archiving the upper would PUT over that object, the only copy of its changed set.
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
    // An empty upper proves nothing changed: a deletion leaves a whiteout and a metadata change
    // copies the file up, so skipping the whole-workspace collapse loses no bytes.
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
    expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
    expect(record.calls.some(call => call.startsWith(`makeSquashfs:${UPPER}:`))).toBe(true);
  });
});

// Attach-path waits are bounded: an unbounded loop spends the whole start budget and
// abandons the restore mid-mount without naming the step that never finished.

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
      await expect(refusal).rejects.toThrow(/does not expose /);

      // Path and bound are parsed from the composed probe command, never restated here, so the
      // refusal message cannot disagree with the wait that produced it.
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
      // The probe loop is one shell statement, so the fake sees one probe command whatever the
      // bound: the pacing must stay inside that command, not spread across execs.
      expect(raw.filter((command) => command.includes('printf ready'))).toHaveLength(1);
      // The refusal lists what the subtree holds, so an operator can tell an empty mount from
      // one holding another generation's archives without a second deployment.
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
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
  });
});

describe('checkpoint — gated on real change, proportional to it', () => {
  test('LIVE DEFECT: an unattached chain can answer neither skipped nor committed',
    async () => {
      // Attachment is checked before the change gate, so an unattached box reports a failure
      // instead of answering "unchanged".
      const record = harness({
        state: chainState(),
        mounts: NOT_MOUNTED,
        change: { status: 'unchanged', version: 'v9' },
      });

      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('is not an overlay mount');
      // Unattached, `checkChanges` would compare the wrong directory, so it is never asked.
      expect(record.calls).not.toContain('checkChanges');
      // The failure is durable, because a thrown scheduled callback is only a
      // console line.
      expect(record.state?.lastFailure?.reason).toContain('not an overlay mount');
    });

  test('LIVE DEFECT: a box with no baseline commits, though checkChanges says unchanged',
    async () => {
      // With no `since`, the SDK's `checkChanges` answers `unchanged` because it is establishing
      // a baseline; a box that never checkpointed must not read that as "no changes".
      const calls: string[] = [];
      const record = harness({ state: null, change: { status: 'unchanged', version: 'v1' }, calls, mounts: mountsAfterAttach(calls) });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('committed');
      expect(outcome.bytes).toBeGreaterThan(0);
      expect(record.state?.changeVersion).toBe('v1');
    });

  test('a periodic tick is not blocked by the same missing baseline', async () => {
    // The interval gate declines on `unchanged`; with no baseline that status is meaningless.
    const record = harness({ state: null, change: { status: 'unchanged', version: 'v1' } });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
  });

  test('with no baseline, an EMPTY work directory is still declined', async () => {
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
      call => call === `publishArchive:${baseObjectKey(STORE_ROOT, publishedState(record).base.id)}`,
    )).toBe(true);
    expect(record.state?.delta).toBeUndefined();
  });

  test('LIVE DEFECT: a fresh box can tick and quiesce in its FIRST generation',
    async () => {
      // Runs one generation's whole lifecycle, in order, against ONE container;
      // per-test fixtures cannot express that sequence.
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

      // Setting `upperMark` simulates a write between the checkpoints; without it the upper is
      // untouched and the tick correctly skips, proving nothing.
      record.upperMark = '9:8192:1700000900';
      record.state = { ...publishedState(record), at: 0 };
      const tick = await storage.checkpoint('tick');
      expect({ kind: tick.kind, reason: tick.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });

      // A graceful stop depends on this final checkpoint: `quiesce()` refuses to stop the
      // container when it fails.
      record.upperMark = '11:12288:1700001800';
      const final = await storage.checkpoint('quiesce');
      expect({ kind: final.kind, reason: final.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });
      expect(record.state?.delta).toEqual(publishedDeltaLayer(record.state, DELTA_BYTES));
    });

  test('a delta that outgrew its base collapses onto a fresh generation at the stop',
    async () => {
      // Every checkpoint uploads the whole cumulative delta, so past the base size a fresh base is cheaper.
      // The outgoing generation stays as restore fallback: a crash here leaves two generations, never zero.
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
      const collapsed = publishedState(record);
      expect(collapsed.base.id).not.toBe(CHAIN_ID);
      expect(collapsed.delta).toBeUndefined();
      expect(record.calls.some(c => c.startsWith(`makeSquashfs:${DEVBOX_WORKDIR}:`))).toBe(true);
      expect(record.calls.findIndex(c => c.startsWith('writeState:'))).toBeGreaterThan(-1);
      expect(record.calls.filter(c => c.startsWith('deleteObjects'))).toEqual([]);
      expect(collapsed.fallback?.base.id).toBe(CHAIN_ID);
    });

  test('a superseded generation is RETAINED as the restore fallback, not deleted',
    async () => {
      // Deleting the outgoing generation in the rebase commit leaves one copy; a missing base
      // bricks every later attach. It stays as the restore fallback until an attach proves a newer one.
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
      expect(record.calls.filter(c => c.startsWith('deleteObjects'))).toEqual([]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, publishedState(record).base.id))).toBe(true);
    });

  test('a second unproven publication orphans the UNPROVEN generation, never the proven one',
    async () => {
      // The record keeps one proven and one current generation; the proven fallback is never evicted.
      // Dropping the superseded unproven one loses no work: the new base archives the same work dir.
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
      // Orphan ids are recorded before the delete so a crash mid-sweep leaves them for the next run;
      // `backups/<uuid>/` is shared by every box, so an id no record carries can never be swept.
      const named = record.calls.findIndex(c => c.startsWith('writeState:'));
      const deleted = record.calls.findIndex(c => c.startsWith('deleteObjects'));
      expect(named).toBeGreaterThan(-1);
      expect(named).toBeLessThan(deleted);
      expect(record.state?.orphans).toBeUndefined();
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(false);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, publishedState(record).base.id))).toBe(true);
    });

  test('a crash before the sweep leaves an id the NEXT checkpoint cleans up', async () => {
    // Orphan ids stay in the record until a sweep finishes deleting them, so a crashed sweep
    // re-runs; the referenced generation is never among them.
    const stranded = 'a1b2c3d4-0000-4000-8000-0000000000ff';

    const record = harness({
      state: chainState({ orphans: [stranded] }),
      mounts: MOUNTED,
    });

    record.objects.set(baseObjectKey(STORE_ROOT, stranded), 4_096);
    await checkpointOf(record, 'quiesce');

    expect(record.objects.has(baseObjectKey(STORE_ROOT, stranded))).toBe(false);
    expect(record.state?.orphans).toBeUndefined();
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
  });

  test('a sweep that fails AFTER publication never restores the superseded pointer',
    async () => {
      // A post-publication sweep failure must not reach the checkpoint's catch: stamping it on the
      // pre-commit record would overwrite the committed pointer and strand both generations.
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

      // The archive landed and the pointer is published, so it reports `committed`; a `failed`
      // would refuse the enclosing quiesce, holding the box open over already-durable work.
      expect(outcome.kind).toBe('committed');
      const committed = publishedState(record);
      expect(committed.rev).toBe(2);
      expect(committed.base.id).not.toBe(CHAIN_ID);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, committed.base.id))).toBe(true);
      // The undeleted generation stays named in `orphans` so the next commit retries its sweep.
      expect(committed.lastFailure?.reason).toContain('store unreachable');
      expect(committed.orphans).toEqual([CHAIN_ID]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      const writes = record.calls.filter(call => call.startsWith('writeState:'));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(call => call.includes(committed.base.id))).toBe(true);
    });

  test('KINU-N030: a failure stamp that cannot be written leaves the COMMITTED record',
    async () => {
      // The failure stamp is itself a durable write bound to the committed revision; if it fails,
      // only a console line remains: the bytes are durable and the only carrier just failed.
      const record = harness({
        state: chainState({
          base: { id: CHAIN_ID, bytes: 100 },
          delta: { bytes: 4_000 },
          at: 1,
          // The fallback slot is already full, so this rebase orphans the outgoing generation
          // instead of retaining it, giving the failing sweep something to delete.
          fallback: { base: { id: FALLBACK_ID, bytes: 64 }, delta: undefined },
        }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failDelete: true,
        rejectWrites: [2],
      });

      const outcome = await checkpointOf(record, 'quiesce');

      expect(outcome.kind).toBe('committed');
      const committed = publishedState(record);
      expect(committed.rev).toBe(2);
      expect(committed.base.id).not.toBe(CHAIN_ID);
      // Only the failure stamp is lost, at no byte cost: the undeleted generation stays
      // named in `orphans`, so the next commit retries its deletion.
      expect(committed.lastFailure).toBeUndefined();
      expect(committed.orphans).toEqual([CHAIN_ID]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, committed.base.id))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      const writes = record.calls.filter(call => call.startsWith('writeState:'));
      expect(writes).toHaveLength(2);
      expect(writes.every(call => call.includes(committed.base.id))).toBe(true);
      expect(record.calls.some(call => call.startsWith('log:')
        && call.includes('is committed and its cleanup is not'))).toBe(true);
      expect(record.calls).toContain(
        `log:${DEVBOX_WORKDIR} that failure could not be stamped on the durable record`,
      );
    });

  test('a commit whose record another writer advanced is refused, and the loser is stamped on the record as it stands',
    async () => {
      // Swapping the record in `checkChanges` models a rival committing rev 2 after this read.
      // The stamp lands on the winner's record because the stale copy cannot be written either.
      const record = harness({
        state: chainState({ base: { id: CHAIN_ID, bytes: 100 }, at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });

      const rival = chainState({ base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 7_000 }, rev: 2, at: 5 });

      const ports: SnapshotChainPorts = {
        ...record.ports,
        checkChanges: async (dir, since) => {
          record.state = rival;

          return await record.ports.checkChanges(dir, since);
        },
      };

      const outcome = await snapshotChainStorage(ports).checkpoint('quiesce');

      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('another writer advanced the chain record to rev 2');
      expect(record.state).toMatchObject({ rev: 2, at: 5, delta: { bytes: 7_000 } });
      expect(record.state?.lastFailure?.reason).toContain('another writer advanced the chain record');
      // The refused pointer is the only write that went backwards, and it
      // changed nothing; the stamp is a second, in-place write on rev 2.
      expect(record.calls.filter(call => call.startsWith('writeState:2:'))).toHaveLength(2);
    });

  test('VERDICT-2: excludes shrink BOTH archives, so they cannot trip the rebase ratio',
    async () => {
      // Both archives are measured under the same excludes: `shouldRebase` asks `delta > k * base`,
      // so an excluded base against an unexcluded delta would rebase at every quiesce.
      const record = harness({
        state: chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: undefined, at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });

      await checkpointOf(record, 'quiesce');

      const staged = record.calls.filter(call => call.startsWith('makeSquashfs:'));
      const excluded = staged.filter(call => call.endsWith(`:${CHAIN_EXCLUDES.length}`));
      expect(staged.length).toBeGreaterThan(0);
      expect(excluded).toEqual(staged);
    });

  test('VERDICT-2: the rebase ratio reads two numbers gathered the same way', () => {
    const tiny = chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: { bytes: 400_000 } });
    const whole = chainState({ base: { id: CHAIN_ID, bytes: 420_000 }, delta: { bytes: 400_000 } });
    expect(shouldRebase(tiny, 'quiesce')).toBe(true);
    expect(shouldRebase(whole, 'quiesce')).toBe(false);
    const alike = chainState({ base: { id: CHAIN_ID, bytes: 20_000 }, delta: { bytes: 4_000 } });
    expect(shouldRebase(alike, 'quiesce')).toBe(false);
  });

  test('a tick never rebases, however far the delta has run ahead', async () => {
    // Collapsing must leave the upper empty, and emptying a live upper races every writer
    // in the container, so a tick appends and only the stop collapses.
    const record = harness({
      state: chainState({ base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 9_000 }, at: 1 }),
      mounts: MOUNTED,
      now: 10 * INTERVAL_MS,
    });

    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
    expect(record.state?.base.id).toBe(CHAIN_ID);
    expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
  });

  test('disk full stages in memory and commits, never a crash',
    async () => {
      // A disk archiver that fills the container disk takes the box down; a refusing disk gate
      // stages in memory instead, where tmpfs costs no disk quota.
      const record = harness({ state: chainState(), mounts: MOUNTED, freeBytes: 1 });
      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('committed');
      expect(record.calls.filter(c => c.startsWith('makeSquashfs'))).not.toEqual([]);
    });

  test('every later commit archives ONLY the upper, into the one replaceable delta',
    async () => {
      const record = harness({ state: chainState(), mounts: MOUNTED });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('committed');
      // `bytes` is what the box durably holds after the commit (base plus delta), not the
      // delta's own size: the caller compares it against held bytes.
      expect(outcome.bytes).toBe(BASE_BYTES + DELTA_BYTES);
      // Archives the changed set, not the tree, under the SAME excludes as the base;
      // excludes on one side only make the rebase ratio compare incommensurable quantities.
      expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
      expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
      expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
      expect(record.calls).not.toContain(`publishArchive:${baseObjectKey(STORE_ROOT, CHAIN_ID)}`);
    });

  // `SnapshotChainPorts` carries no payload byte in either direction: a relay through the
  // isolate slows as the archive grows. The first case restores both removed ports as refusals.

  test('a commit lands with every payload-carrying port wired to REFUSE', async () => {
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
    expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
    expect(record.calls).toContain(`objectFacts:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
  });

  test('a checkpoint publishes through a WRITABLE mount and never through the isolate',
    async () => {
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');

      // One writable mount of the chain's subtree at /backups, held for the container's life: the SDK
      // refuses one binding mounted twice under different settings, so no per-publication mount.
      expect(record.calls).toContain(`mountStore:${storeMountOf(record.calls)}`);
      expect(record.calls).toContain(`publishArchive:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
      expect(record.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(DELTA_BYTES);
      expect(record.calls).toContain(`objectFacts:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
    });

  test('the upload is verified through the held mount\'s registration, before the record',
    async () => {
      // A record must never name an object the store did not fully take: the publisher's HEAD
      // fails the PUT, then `objectFacts` rechecks the store; the held mount routes `r2.internal`.
      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');

      const mounted = record.calls.indexOf(`mountStore:${storeMountOf(record.calls)}`);
      const flushed = record.calls.indexOf(`publishArchive:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
      const read = record.calls.indexOf(`objectFacts:${deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))}`);
      const wrote = record.calls.findIndex(call => call.startsWith('writeState:2:'));
      expect(mounted).toBeGreaterThan(-1);
      expect(mounted).toBeLessThan(flushed);
      expect(flushed).toBeLessThan(read);
      // The store is asked what it holds only after the upload answered, so
      // the answer describes the object rather than a filesystem's view of it.
      expect(read).toBeLessThan(wrote);
      const store = storeMountOf(record.calls);

      const command = publishCommand({
        archivePath: '/stage/layer.sqsh',
        objectUrl: `http://r2.internal/BACKUP_BUCKET/${CHAIN_ID}/data.sqsh`,
      });

      expect(command).toContain('devbox-publish.mjs');
      expect(command).toContain(`'http://r2.internal/BACKUP_BUCKET/${CHAIN_ID}/data.sqsh'`);
      expect(command).toContain('/stage/layer.sqsh');
      expect(command).not.toContain('conv=fsync');
      // The store mount stays held: the attach's layers read through it and the publication URL
      // resolves only while its registration stands; a release before the mount is a stale entry.
      expect(record.calls.lastIndexOf(`unmountStore:${store}`)).toBeLessThan(mounted);
    });

  test('a checkpoint publishes in exactly ONE object attempt', async () => {
    // The fixture's `attempts` row is what the live meter counts: `put` attempts on the
    // box's keys plus one multipart upload (D15).
    const record = harness({ state: chainState(), mounts: MOUNTED });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');

    const key = deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state));

    expect(record.attempts).toEqual([{ operation: 'put', key, bytes: DELTA_BYTES }]);

    // Control: the fake still answers the s3fs `dd` shape and must count its three attempts;
    // a fixture that could not see three could not prove one.
    const store = storeMountOf(record.calls);
    await record.ports.exec(
      `mkdir -p '${store}/${CHAIN_ID}'; dd if='/stage/layer.sqsh' of='${store}/${CHAIN_ID}/data.sqsh' `
      + 'bs=4M conv=fsync; rc=$?; printf \'%s %s\' "$rc" 0',
    );

    const s3fsAttempts = record.attempts.slice(1);

    expect(s3fsAttempts).toEqual([
      { operation: 'put', key: `${STORE_ROOT}/${CHAIN_ID}/`, bytes: 0 },
      { operation: 'put', key: `${STORE_ROOT}/${CHAIN_ID}/data.sqsh`, bytes: 0 },
      { operation: 'put', key: `${STORE_ROOT}/${CHAIN_ID}/data.sqsh`, bytes: DELTA_BYTES },
    ]);
  });

  test('a writable mount is released even when the publication fails', async () => {
    // The SDK registry refuses a binding mounted twice under different access, so a leaked
    // mount would make every later publication fail after one bad checkpoint.
    const record = harness({ state: chainState(), mounts: MOUNTED, failPublish: true });
    expect((await checkpointOf(record, 'tick')).kind).toBe('failed');
    expect(record.objects.get(deltaObjectKey(STORE_ROOT, CHAIN_ID))).toBe(DELTA_BYTES);
    expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
  });

  test('a flush the store did not fully take is REFUSED, not recorded', async () => {
    // The copy's written count and the store's held count for one finished upload differ only
    // on a lost tail; recording it would commit a head over an archive that cannot mount.
    const record = harness({
      state: chainState(),
      mounts: MOUNTED,
      flushedBytes: 700_000,
      landedBytes: 512,
    });

    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('where 512 were sent');
    expect(outcome.reason).toContain('700000');
    expect(record.state?.rev).toBe(1);
    expect(record.state?.lastFailure?.reason).toContain('the store reports');
  });

  test('a publication the store has no object for is REFUSED, not recorded', async () => {
    // s3fs answers a flush from its own view of the mount, so a clean exit proves nothing stored.
    // A first base is used because its fresh prefix makes an absent object observable.
    const record = harness({ state: null, mounts: MOUNTED, publishLandsNothing: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('the store reports 0 bytes');
    expect(record.state).toBeNull();
  });

  test('an attach moves no payload either: mounts and metadata, nothing else', async () => {
    // squashfuse reads the archive through the store mount, so bytes arrive only on access (D2).
    const calls: string[] = [];

    const record = harness({
      state: chainState({ delta: deltaLayer(CHAIN_ID, DELTA_BYTES) }),
      mounts: mountsAfterAttach(calls),
      calls,
    });

    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.calls.filter(call => call.startsWith('publishArchive'))).toEqual([]);
    expect(record.calls.filter(call => call.startsWith('exec:cp'))).toEqual([]);
    expect(record.calls).toContain(`objectFacts:${baseObjectKey(STORE_ROOT, CHAIN_ID)}`);
    expect(record.calls.filter(call => call.startsWith('mountLayer'))).toHaveLength(2);
  });

  test('ONE MOUNT: every mount of the binding is the chain subtree at /backups',
    async () => {
      // The SDK admits one mount per binding (one prefix, one readOnly setting), so attach and
      // checkpoint share it; the attach's `rm -rf` lists its own layout paths and excludes it.
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
      // The fake refuses a second mount with a different setting or prefix, with the SDK's own
      // sentence; every mount in either role must name the same path.
      const at = [...new Set(mounts.map((mount) => mount.split(':')[1]))];
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
    // A crash between PUT and record leaves a complete delta that the next attach adopts;
    // cleaning up before the record could delete its only copy.
    expect(put).toBeLessThan(wrote);
    expect(wrote).toBeLessThan(cleaned);
  });

  test('an unchanged CHANGED SET costs nothing, and only an exact match counts', async () => {
    // The gate compares the upper's own fingerprint with the one recorded at the last commit,
    // because the upper is what a delta archives; the merged mount can read unchanged.
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

  test('RUN abc-3: a workspace that CHANGED never reads as unchanged',
    async () => {
      // The change gate must fingerprint `upperDir`, which a delta archives, not the merged
      // `/workspace`.
      const settled = '120:4096:1700000000';

      const record = harness({
        state: chainState({ upperMark: settled, at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
      });

      record.upperMark = '48000:419430400:1700000900';

      const outcome = await checkpointOf(record, 'tick');

      expect({ kind: outcome.kind, reason: outcome.reason }).toEqual({
        kind: 'committed', reason: undefined,
      });
      expect(record.calls).toContain(`makeSquashfs:${UPPER}:${CHAIN_EXCLUDES.length}`);
      expect(record.state?.upperMark).toBe('48000:419430400:1700000900');
    });

  test('a tick that CANNOT decide commits rather than skipping', async () => {
    // A failed fingerprint probe (mid-replacement, no `find`, upper gone) means archive, not skip:
    // "unreadable" is not "unchanged".
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
    // A failed probe must not be written as the new mark, or the next failed probe
    // compares equal to it and skips forever.
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
      // The staged size is taken before the bytes are read, and a file still settling reads
      // short; the fixture's staged and landed sizes differ to model that.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        stagedReport: '0 700387328',
        landedBytes: 702791680,
      });

      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('committed');

      expect(record.state?.delta).toEqual(publishedDeltaLayer(record.state, 702791680));
      expect(record.objects.get(deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state)))).toBe(702791680);
      // Every recorded size comes from an R2 head of a finished object, never a mid-write stat,
      // which reads low by whole 4096-byte blocks.
      expect(record.state?.delta?.bytes).toBe(702791680);
      expect(record.state?.delta?.bytes).not.toBe(700387328);
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
      // The staged stat is short by whole 4096-byte blocks; the record must carry the landed size,
      // not the stat, or the wake refuses to attach.
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
      expect(record.state?.delta).toEqual(publishedDeltaLayer(record.state, landed));

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
      // Build and measure run as one command, so exit 0 with no file is the archiver's own
      // contradiction, not a container replaced between two RPCs.
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        stagedReport: '0 0',
      });

      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('mksquashfs reported success');
      expect(record.state?.delta).toEqual(deltaLayer(CHAIN_ID, DELTA_BYTES));
    });

  test('a publication failure the stamp cannot record is still a classified failure',
    async () => {
      const record = harness({
        state: chainState({ upperMark: 'stale', at: 1 }),
        mounts: MOUNTED,
        now: 10 * INTERVAL_MS,
        failPublish: true,
        rejectWrites: [1],
      });

      const outcome = await checkpointOf(record, 'tick');

      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('PUT answered 500');
      expect(outcome.reason).not.toContain('durable storage unreachable');
      expect(outcome.bytes).toBeUndefined();
      expect(record.state).toEqual(chainState({ upperMark: 'stale', at: 1 }));
      // Both lines are on the console, which is the only record left.
      expect(record.calls.some(call => call.startsWith(`log:${DEVBOX_WORKDIR} checkpoint failed:`)
        && call.includes('PUT answered 500'))).toBe(true);
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
    // The watermark is advisory: an unadvanced one only widens the next window and over-reports,
    // so `failed` would misreport work and refuse a quiesce with nothing to archive.
    const record = harness({
      state: chainState({ mode: 'extract', delta: undefined, changeVersion: 'v1' }),
      change: { status: 'unchanged', version: 'v2' },
      rejectWrites: [1],
    });

    const outcome = await checkpointOf(record, 'quiesce');

    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('work directory is unchanged');
    expect(record.calls.some(call => call.endsWith(':rejected'))).toBe(true);
    expect(record.state?.changeVersion).toBe('v1');
    expect(record.calls.some(call => call.startsWith('log:')
      && call.includes('change watermark could not be advanced'))).toBe(true);
  });

  // The gate's one call runs on two shells: the image's sync runs it on its own and reads the bytes
  // bash wrote, and a box that drives its own ticks runs it through the container server, which
  // re-reads them by lines and drops NUL bytes (P6). Both must read the same mark.
  for (const [shell, output] of [
    ['on the sync\'s own shell', (raw: string): string => raw],
    ['through the container server', sessionShellOutput],
  ] as const) {
    test(`an attached tick reads its gate in one container call ${shell}, which bash runs`, async () => {
      const scratch = devboxScratchDir('devbox-probe');
      const upper = join(scratch, 'upper');
      mkdirSync(upper);
      writeFileSync(join(upper, 'notes.md'), 'written since the attach');
      const table = join(scratch, 'mounts');
      writeFileSync(table, `${MOUNTED}\n`);

      const tick = async (walked: string) => {
        const record = harness({ state: chainState({ upperMark: fingerprintOf(upper) }), mounts: MOUNTED });
        const probes: string[] = [];
        const inner = record.ports.exec;
        record.ports.exec = async (command) => {
          if (!command.startsWith('# devbox-tick-probe-')) return await inner(command);
          probes.push(command);
          // The command as sent, run by bash over a scratch upper and mount table.
          const ran = Bun.spawnSync(['bash', '-c', command.replaceAll(UPPER, walked).replaceAll('/proc/mounts', table)]);

          return { stdout: output(ran.stdout.toString()), stderr: output(ran.stderr.toString()), exitCode: ran.exitCode };
        };

        const outcome = await checkpointOf(record, 'tick');

        return { reason: outcome.reason, probes: probes.length, reads: record.calls.filter((call) => ['readMounts', 'upperFingerprint'].includes(call)) };
      };

      expect(await tick(upper)).toEqual({ reason: 'work directory is unchanged', probes: 1, reads: [] });
      // A walk that fails reads as no mark, which never matches, so the tick does not skip.
      expect((await tick(join(scratch, 'absent'))).reason).not.toBe('work directory is unchanged');
    });
  }

  test('a failed publication leaves the previous record intact and records the reason', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED, failPublish: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.bytes).toBeUndefined();
    expect(record.state?.rev).toBe(1);
    expect(record.state?.base).toEqual(baseLayer(CHAIN_ID, BASE_BYTES));
    expect(record.state?.lastFailure?.reason).toContain('PUT answered 500');
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
      const record = harness({
        state: null, refuseStoreMount: true, allowExtraction: false,
      });

      const outcome = await checkpointOf(record, 'quiesce');
      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toContain('extraction is not permitted');
      expect(outcome.reason).toContain('fuse: device not found');
      expect(record.state).toBeNull();
    });

  test('DEPLOYED DEFECT: an extract record is refused where extraction is not permitted',
    async () => {
      // Such a record comes only from a host that allowed extraction; serving it on a host that
      // does not would hide the silent fallback.
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
      // Matched on the call's prefix: the chain id is minted inside the commit and discarded
      // when the degrade happens.
      expect(record.calls.some(call => call.startsWith('mountStore:'))).toBe(true);
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
    // The superseded archive becomes the fallback, so nothing is deleted: a crash leaves two
    // archives, never zero.
    expect(record.state?.fallback?.base).toEqual(baseLayer(EXTRACT_ID, 1));
    expect(record.calls.filter(call => call.startsWith('deleteObjects:'))).toEqual([]);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, EXTRACT_ID))).toBe(true);
  });
});

describe('discard — objects before the pointer', () => {
  test('a committed base whose reseat is busy is a named checkpoint refusal', async () => {
    const record = harness({ state: null, mounts: MOUNTED });
    const exec = record.ports.exec;
    record.ports.exec = async command => command.includes("/usr/bin/fusermount3 -u '/workspace'")
      ? { stdout: '', stderr: 'Device or resource busy', exitCode: 1 } : await exec(command);
    const result = await checkpointOf(record, 'quiesce');
    expect(result.kind).toBe('failed');
    expect(result.reason).toContain('reseating');
    expect(result.reason).toContain('Device or resource busy');
    expect(record.state?.base.id).toBeDefined();
  });

  test('all three keys go, and only then the record', async () => {
    const record = harness({ state: chainState() });
    await snapshotChainStorage(record.ports).discard();
    const deleted = record.calls.findIndex(call => call.startsWith('deleteObjects:'));
    const cleared = record.calls.indexOf('clearState');
    // Reversed, a crash orphans both: nothing would name the objects and
    // nothing would delete them.
    expect(deleted).toBeLessThan(cleared);
    expect(record.calls).toContain('deleteObjects:3');
    expect(record.calls).not.toContain('deleteObjects:0');

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

// Fails when an outcome kind is added but never exercised above, so coverage of each
// decision the suite guards cannot silently lapse.

describe('denominator', () => {
  test('every attach outcome kind was produced above', () => {
    expect([...seenAttach].sort()).toEqual([...ATTACH_OUTCOME_KINDS].sort());
  });

  test('every checkpoint outcome kind was produced above', () => {
    expect([...seenCheckpoint].sort()).toEqual([...CHECKPOINT_OUTCOME_KINDS].sort());
  });
});

describe('discard sweeps every generation the record still names', () => {
  test('orphaned generations go with the referenced one, before clearState', async () => {
    // A rebase crash between state flip and sweep leaves ids in `orphans`; clearState erases the
    // only record naming them and `backups/<uuid>/` is shared, so discard must sweep them first.
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
    // Checks against the path this attach actually mounted, read back from its own calls,
    // not a path restated beside the strategy.
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
    expect(calls.filter(call => call.startsWith('mountLayer'))).toEqual([]);
  });
});

/** The whole second both fingerprint marks land in. */
const T_SAME = 1_700_000_000;

function fingerprintOf(dir: string): string {
  const proc = Bun.spawnSync(['sh', '-c', upperFingerprintCommand(dir)]);

  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());

  return proc.stdout.toString().trim();
}

describe('the skip-gate fingerprint keeps sub-second mtime', () => {

  test('a same-size rename changes the per-path mark', () => {
    const dir = devboxScratchDir('devbox-fingerprint-rename');

    const firstPath = join(dir, 'before.txt');
    const secondPath = join(dir, 'after.txt');
    writeFileSync(firstPath, 'same-size');
    utimesSync(firstPath, T_SAME + 0.5, T_SAME + 0.5);

    const first = fingerprintOf(dir);
    renameSync(firstPath, secondPath);
    utimesSync(secondPath, T_SAME + 0.5, T_SAME + 0.5);
    expect(fingerprintOf(dir)).not.toBe(first);
  });

  test('a same-size same-second rewrite changes the mark', () => {
    const dir = devboxScratchDir('devbox-fingerprint');

    const file = join(dir, 'w.txt');
    writeFileSync(file, 'aaaaaaaaaa');
    utimesSync(file, T_SAME + 0.25, T_SAME + 0.25);

    const first = fingerprintOf(dir);

    writeFileSync(file, 'bbbbbbbbbb'); // SAME SIZE
    utimesSync(file, T_SAME + 0.25, T_SAME + 0.75); // SAME SECOND, later fraction

    expect(fingerprintOf(dir)).not.toBe(first);
  });

  test('a same-path rewrite with the mtime RESTORED still changes the mark', () => {
    // The write moves ctime, which the per-path record hashes; restoring mtime cannot undo it,
    // so a same-size rewrite with the old mtime still changes the fingerprint.
    const dir = devboxScratchDir('devbox-fingerprint-restored-mtime');

    const file = join(dir, 'w.txt');
    const at = T_SAME + 0.5;
    writeFileSync(file, 'aaaaaaaaaa');
    utimesSync(file, at, at);

    const first = fingerprintOf(dir);

    writeFileSync(file, 'bbbbbbbbbb'); // SAME SIZE, SAME INODE
    utimesSync(file, at, at); // MTIME PUT BACK EXACTLY

    expect(fingerprintOf(dir)).not.toBe(first);
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

describe('archive scope keeps what no build can rebuild', () => {
  function archiverCommand(commands: readonly string[], source: string): string {
    const line = commands.find(command => command.includes(`mksquashfs '${source}'`));

    if (line === undefined) throw new Error(`nothing was archived from ${source}`);

    return line;
  }

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
      // No pattern may drop `.git` (repo dir or worktree pointer FILE): nothing under it is reproducible.
      // Checks both archives: the base is the whole tree; the delta carries later commits.
      for (const command of [
        await commandFor(null, DEVBOX_WORKDIR),
        await commandFor(chainState(), UPPER),
      ]) {
        const patterns = excludePatternsOf(command);
        expect(patterns).toEqual([...CHAIN_EXCLUDES]);

        for (const pattern of patterns) {
          expect(pattern.startsWith('.git')).toBe(false);
        }

        // The policy goes as a `-wildcards -ef` file so globs match at any depth; no pattern
        // is passed as an argument, so none can reach the shell as syntax.
        expect(command).toContain('-wildcards -ef ');
        expect(command).not.toContain(" -e '");
      }
    });
});

// These run the real mksquashfs: the exclude policy means only what the archiver does
// with it, which a fake shell cannot check.

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
  const dir = devboxScratchDir(label);

  for (const [path, size] of FIXTURE) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'y'.repeat(size));
  }

  return dir;
}

/** Runs the strategy's own archiver command and answers what the archive holds and how many source bytes it took. */
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

function estimateOf(source: string, excludes: readonly string[]): number {
  const measured = Bun.spawnSync(['sh', '-c', archiveSizeCommand(source, excludes)]);

  if (measured.exitCode !== 0) throw new Error(measured.stderr.toString());

  return Number(measured.stdout.toString().trim());
}

describe('the real archiver applies the policy this file claims', () => {
  test('git metadata travels at every depth, as a directory and as a worktree file', () => {
    const dir = fixtureTree('devbox-archive-git');

    const { entries } = archiveOf(dir, CHAIN_EXCLUDES);

    for (const kept of ['.git', '.git/HEAD', '.git/objects/ab/cd', 'sub/.git/HEAD', 'wt/.git']) {
      expect(entries).toContain(kept);
    }

    expect(entries).toContain('keep.txt');
  });

  test('a regenerable tree goes at EVERY depth, not only the top level', () => {
    // `a.log` is checked too: a glob without `-wildcards` matches nothing.
    const dir = fixtureTree('devbox-archive-depth');

    const { entries } = archiveOf(dir, CHAIN_EXCLUDES);

    for (const gone of [
      'node_modules', 'node_modules/p/i.js', 'sub/deep/node_modules/p/i.js',
      'a.log', 'sub/b.log', 'dist/o.js', 'sub/dist/o.js', '.cache/x', 'sub/.cache/x',
    ]) {
      expect(entries).not.toContain(gone);
    }
  });

  test('globstar patterns mean what the SDK makes them mean', () => {
    // The chain path normalises globstars as the extraction path does before mksquashfs.
    // A bare `**` means nothing; if it meant everything this archive would be empty.
    const dir = fixtureTree('devbox-archive-globstar');

    const { entries } = archiveOf(dir, ['**/node_modules', 'dist/**', '**', 'a/**/b']);
    expect(entries).toContain('keep.txt');
    expect(entries).toContain('.git/HEAD');

    for (const gone of [
      'node_modules/p/i.js', 'sub/deep/node_modules/p/i.js', 'dist/o.js', 'sub/dist/o.js',
      'a/b/c.txt', 'x/a/b/c.txt',
    ]) {
      expect(entries).not.toContain(gone);
    }

    expect(entries).toContain('a.log');
    expect(entries).toContain('sub/.cache/x');
  });

  test('the extraction options carry the box\'s own exclude policy, not a copy of the default', () => {
    // If `chainBackupOptions` spelled the policy itself, a box that replaced it would be
    // obeyed in the chain path and ignored in the extraction path.
    const replaced = ['**/node_modules', 'dist/**'];

    expect(chainBackupOptions(true, replaced).excludes).toEqual(replaced);
  });

  test('the staging estimate measures exactly the bytes the archive takes', () => {
    // The estimate is the archive's worst case only while both agree which files travel;
    // an underestimate lets a checkpoint fill the container disk.
    const dir = fixtureTree('devbox-archive-estimate');

    for (const policy of [CHAIN_EXCLUDES, ['**/node_modules', 'dist/**', '**', 'a/**/b'], []]) {
      expect(estimateOf(dir, policy)).toBe(archiveOf(dir, policy).bytes);
    }
  });
});

/** A record retaining one older generation: every record between a publication that
 *  superseded a generation and the attach that proves the new one. */
function withFallback(over: StateLiteral = {}): ChainState {
  return chainState({
    fallback: { base: { id: FALLBACK_ID, bytes: FALLBACK_BYTES }, delta: undefined },
    ...over,
  });
}

describe('the binding has ONE mount for the container\'s life', () => {
  test('checkpoint -> stop -> wake-attach -> checkpoint commits, one mount, one setting',
    async () => {
      // The SDK mount registry and `/proc/mounts` are shared across harnesses: both belong to the
      // container, not the isolate, and a stop then wake is two isolates on one container.
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

      // A fresh isolate on the SAME container: the registry keeps what the first checkpoint left,
      // so the wake's attach must take the same writable store mount the publication uses.
      const wakeCalls: string[] = [];

      const woken = harness({
        state: first.state, mounts: mountsAfterAttach(wakeCalls), calls: wakeCalls,
        registry, mountsTable: container,
      });

      woken.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), BASE_BYTES);
      woken.objects.set(deltaObjectKey(STORE_ROOT, publishedDeltaId(first.state)), DELTA_BYTES);
      expect((await attachOf(woken)).kind).toBe('attached');

      // `upperMark` differs from the fingerprint the first commit recorded, so there is a delta
      // to publish rather than a skip.
      const secondCalls: string[] = [];

      const second = harness({
        state: { ...publishedState(first), upperMark: 'stale-again', at: 1 },
        mounts: MOUNTED,
        calls: secondCalls,
        registry, mountsTable: container,
        upperMark: '8:4096:1700000000',
        now: 20 * INTERVAL_MS,
      });

      expect((await checkpointOf(second, 'tick')).kind).toBe('committed');

      const one = [...new Set([...firstCalls, ...wakeCalls, ...secondCalls]
        .filter(call => call.startsWith('mountStore:'))
        .map(call => call.split(':')[1]))];

      expect(one).toHaveLength(1);
      expect(second.objects.get(deltaObjectKey(STORE_ROOT, publishedDeltaId(second.state)))).toBe(DELTA_BYTES);
    });

  test('a REBASE across a container life mounts nothing new, and the fold commits',
    async () => {
      // A rebase keeps the old generation's layers mounted as overlay lowers, so the fold must
      // publish through the box-root store mount; the SDK refuses a second prefix at that path.
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

      const foldCalls: string[] = [];

      const fold = harness({
        state: woken.state,
        // Mount paths are read back from the wake's own calls, so the fold never gets a mount line
        // the strategy disagrees with.
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
      expect(fold.state?.base.id).not.toBe(CHAIN_ID);
      expect(foldCalls.filter(call => call.startsWith('mountStore:'))).toEqual([]);
      expect(mountsAfterWake).toBe(1);
      expect(registry.held).toEqual({ prefix: `${STORE_ROOT}/`, readOnly: false });
      expect(fold.objects.has(baseObjectKey(STORE_ROOT, publishedState(fold).base.id))).toBe(true);
    });

  test('a generation that changes releases the one mount before the next takes it',
    async () => {
      // The SDK refuses a second mount of a binding at a different prefix, so a generation change
      // unmounts first, unconditionally; the product port survives an unmount of nothing held.
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
    // Between a publication and the start that proves it the box holds two generations,
    // so a restore is never down to a single unproven copy.
    let attached = true;

    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: 100 }, delta: { bytes: 4_000 }, at: 1,
      }),
      mounts: () => (attached ? mountTable(record.calls, MOUNTED) : NOT_MOUNTED),
      now: 10 * INTERVAL_MS,
    });

    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      // Mount state flips only when the attach runs the overlay mount, so the postcondition
      // observes a change this attach made.
      if (command.includes('fuse-overlayfs -o lowerdir=')) attached = true;

      return await inner(command);
    };

    const storage = snapshotChainStorage(record.ports);

    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');
    const rebased = publishedState(record).base.id;
    expect(rebased).not.toBe(CHAIN_ID);
    expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);

    // `attached = false` models a replaced container, so the next start attaches for real;
    // only that real attach retires the fallback, which becomes an orphan rather than deleted.
    attached = false;
    expect((await storage.attach()).kind).toBe('attached');
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.state?.orphans).toEqual([CHAIN_ID]);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);

    record.upperMark = 'restarted-and-wrote';
    expect((await storage.checkpoint('quiesce')).kind).toBe('committed');
    expect(record.state?.orphans).toBeUndefined();
    expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(false);
    expect(record.state?.base.id).toBe(rebased);
    expect(record.state?.fallback).toBeUndefined();
    expect(record.objects.has(baseObjectKey(STORE_ROOT, rebased))).toBe(true);
  });
});

describe('a legacy delta publication carries its fallback evidence', () => {
  test('unobserved directory opacity refuses publication instead of changing formats', async () => {
    const record = harness({ state: chainState(), mounts: MOUNTED });
    const exec = record.ports.exec;
    record.ports.exec = async command => command.startsWith('# devbox-probe-v1')
      ? { stdout: '78 ', stderr: 'unsupported opaque xattr value', exitCode: 0 } : await exec(command);
    const before = record.state?.rev;
    const priorDelta = record.state?.delta;
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('opaque-directory namespace could not be observed');
    expect(outcome.reason).toContain('unsupported opaque xattr value');
    expect(record.state?.rev).toBe(before);
    expect(record.state?.delta).toEqual(priorDelta);
  });

  const DELTA_PROBE_FAILURES = ['upper-probe-failed', 'upper-empty', 'whiteout-probe-failed', 'base-probe-failed', 'block-hash-failed', 'stage-failed'] as const;

  /** The two upper reasons are the refusal itself; every other reason needs a well-formed upper
   *  so its failure happens at a later probe. */
  function upperProbeReply(reason: (typeof DELTA_PROBE_FAILURES)[number], encoded: string): string {
    if (reason === 'upper-probe-failed') return '1 failed';

    if (reason === 'upper-empty') return '0 ';

    return `0 ${encoded}`;
  }

  for (const reason of DELTA_PROBE_FAILURES) {
    test(reason, async () => {
      const record = harness({ state: chainState(), mounts: MOUNTED });
      const exec = record.ports.exec;
      const type = reason === 'whiteout-probe-failed' ? 'c' : 'f';
      const size = reason === 'block-hash-failed' ? 65536 : 32;
      const encoded = Buffer.from([type, '42', '1', '644', '0', '0', String(size), '0', '0', '', 'file', ''].join('\0')).toString('base64');

      record.ports.exec = async command => {
        let stdout: string | undefined;

        if (command.startsWith('# devbox-probe-v1')) stdout = upperProbeReply(reason, encoded);

        if (command.startsWith('# devbox-whiteout-v1')) stdout = '';

        if (command.startsWith('# devbox-basestat-v1')) stdout = reason === 'base-probe-failed' ? 'garbled' : 'ABSENT';

        if (command.startsWith('# devbox-blockhash-v1')) stdout = 'USIDE 0\n';

        if (reason === 'stage-failed' && command.startsWith('# devbox-stage-v1')) return { stdout: '', stderr: 'stage refused', exitCode: 1 };

        return stdout === undefined ? await exec(command) : { stdout, stderr: '', exitCode: 0 };
      };

      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
      expect(record.state?.deltaFormat).toBeUndefined();
      expect(record.state?.deltaFallback?.reason).toBe(reason);
      expect(record.state?.deltaFallback?.detail.length).toBeGreaterThan(0);
      const fallback = record.state?.deltaFallback;
      expect(normalizeChainState({ mode: 'chain', rev: 2, at: 1, base: { id: CHAIN_ID, bytes: BASE_BYTES },
        deltaFallback: fallback === undefined ? undefined : { ...fallback },
      })?.deltaFallback).toEqual(fallback);
      expect(record.calls.some(call => call.includes('"event":"devbox.checkpoint.delta.fallback"') && call.includes(`"reason":"${reason}"`))).toBe(true);
      expect(record.calls.some(call => call.includes('"event":"devbox.checkpoint.published"') && call.includes(`"reason":"${reason}"`))).toBe(true);
    });
  }
});

describe('the retained fallback', () => {
  test('is bounded by the two roles, not by how many publications happen', () => {
    // An empty slot retains the outgoing (attach-proven) generation; later publications with no
    // attach between orphan their own outgoing one, so the proven one is never evicted.
    let state = chainState();
    const retained: string[] = [];

    for (let publication = 0; publication < 5; publication += 1) {
      const roles = supersedeGeneration(state);
      expect(roles.fallback).toBeDefined();
      state = chainState({
        base: baseLayer(`a1b2c3d4-0000-4000-8000-00000000000${publication}`, 100),
        delta: undefined,
        ...roles,
      });
      retained.push(retainedFallback(state).base.id);
    }

    expect(retained).toEqual([CHAIN_ID, CHAIN_ID, CHAIN_ID, CHAIN_ID, CHAIN_ID]);
    // Non-retained generations are listed as orphans, not dropped, so storage stays bounded
    // by the roles and the sweep can still find every id.
    expect(state.orphans).toHaveLength(4);
  });

  test('does not move until the pointer that moves it is durable', async () => {
    // The roles move in the same write as the pointer, so a publication whose record cannot be
    // written moves neither: the box still names the generation it can attach from.
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
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
  });

  test('is retired by the attach that PROVES the generation the record names', async () => {
    const calls: string[] = [];
    const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });

    expect((await attachOf(record)).kind).toBe('attached');

    expect(record.state?.fallback).toBeUndefined();
    // An attach publishes nothing, so it deletes nothing: the fallback is only named an orphan;
    // the sweep belongs to the next commit and is re-runnable.
    expect(record.state?.orphans).toEqual([FALLBACK_ID]);
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
  });

  test('survives an already-attached container, which proves nothing', async () => {
    // A mount already up may come from a generation a later rebase superseded, so it proves
    // nothing about what the record names now.
    const record = harness({ state: withFallback(), mounts: MOUNTED });

    expect((await attachOf(record)).kind).toBe('already-attached');

    expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
    expect(record.calls.filter(call => call.startsWith('writeState'))).toEqual([]);
  });

  test('is not spent on a host that cannot mount the store at all', async () => {
    // A host with no FUSE says nothing about any generation's bytes: the fallback would fail
    // identically, spend the record's promotion, and bury the platform's own reason.
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
      record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));

      const outcome = await attachOf(record);

      expect(outcome.kind).toBe('attached');
      expect(outcome.detail).toContain('recovered');
      // Recovery mounts the box's root once and reads the fallback's layers through it;
      // the mount path is the strategy's own choice, read back off its call.
      const store = storeMountOf(record.calls);
      expect(record.calls.filter(call => call.startsWith('mountStore:')))
        .toEqual([`mountStore:${store}`]);
      expect(record.calls).toContain(`awaitLayer:${store}/${FALLBACK_ID}/data.sqsh`);
      // The record is promoted before the mount: a crash after mounting must not leave it naming
      // the refused generation, or the next checkpoint writes a delta onto a missing base.
      const promoted = record.calls.findIndex(call => call.startsWith('writeState:'));
      const mounted = record.calls.findIndex(call => call.startsWith('mountStore:'));
      expect(promoted).toBeGreaterThan(-1);
      expect(promoted).toBeLessThan(mounted);
      const state = publishedState(record);
      expect(state.base).toEqual(baseLayer(FALLBACK_ID, FALLBACK_BYTES));
      expect(state.delta).toBeUndefined();
      expect(state.rev).toBe(2);
      expect(state.lastFailure?.reason).toContain(CHAIN_ID);
      expect(state.lastFailure?.reason).toContain('missing from the store');
      expect(state.orphans).toEqual([CHAIN_ID]);
      expect(state.fallback).toBeUndefined();
      // The mark described a generation this box no longer serves; a mark that cannot describe
      // the upper must never match, or the next tick skips the archive.
      expect(state.upperMark).toBeUndefined();
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('a base whose size disagrees is refused rather than adopted, and the fallback serves',
    async () => {
      // The base is written once and never rewritten, so a disagreeing size means a different object;
      // unlike the delta (see `probe`), this stays a refusal.
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
      // The integrity probe compares only sizes, so the mount is the real read: a squashfuse
      // refusal on this generation's own archive is its own failure, not the host's.
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

    // Neither broken generation is deleted: each remains a recovery chance for an operator.
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
    // The promotion is a recovery's only durable write before it mounts anything, so its
    // failure is pre-commit: the box does not start and the record is unchanged.
    const record = harness({ state: withFallback(), mounts: NOT_MOUNTED, rejectWrites: [1] });
    record.objects.delete(baseObjectKey(STORE_ROOT, CHAIN_ID));

    await expect(attachOf(record)).rejects.toThrow(/durable storage unreachable/);

    expect(record.calls.filter(call => call.startsWith('mountStore'))).toEqual([]);
    expect(record.state?.base.id).toBe(CHAIN_ID);
    expect(record.state?.fallback?.base.id).toBe(FALLBACK_ID);
  });

  test('a proof that cannot be written leaves the box ATTACHED and the id still named',
    async () => {
      // The fallback-retirement write happens after the workspace is mounted, so its failure must
      // not fail the start; the id stays named and the next attach repeats the retirement.
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
    // Containment rests on the absence of a copy: archives are reachable only via mounts under
    // the private runtime directory and the upper starts empty, so no copy exists to escape.
    const calls: string[] = [];
    const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
    const raw: string[] = [];
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      raw.push(command);

      return await inner(command);
    };

    expect((await attachOf(record)).kind).toBe('attached');

    expect(raw.filter(command => /^(cp|tar|rsync|unsquashfs)\b/.test(command))).toEqual([]);

    // The upper is emptied BEFORE anything is mounted over it, so a composed
    // attach's writable layer holds exactly what is written after it.
    const emptied = raw.findIndex(command =>
      command.startsWith('rm -rf') && command.includes(UPPER) && command.includes('mkdir -p'));

    const mounted = raw.findIndex(command => command.includes('squashfuse'));
    expect(emptied).toBeGreaterThan(-1);
    expect(mounted).toBeGreaterThan(emptied);

    // Every archive is mounted only under this strategy's runtime directory, so a layer never
    // lands over the workspace or anywhere a caller writes.
    for (const command of raw.filter(line => line.includes('squashfuse'))) {
      expect(command).toContain(`${DEVBOX_RUNTIME_DIR}/`);
      expect(command).not.toContain(`${DEVBOX_WORKDIR} `);
    }
  });
});

/** A same-length replacement: the store's digest disagrees while every byte count agrees.
 *  A valid squashfs image here mounts the wrong workspace, which a count cannot detect. */
const REPLACED_DIGEST = 'f'.repeat(64);

/** The version the store reports for that replacement upload. R2 mints one per
 *  upload, so a replacement can never carry the recorded one. */
const REPLACED_VERSION = 'upload-that-replaced-it';

describe('an archive replaced at the same length is refused', () => {
  test('an immutable delta also refuses replacement at a different length', async () => {
    const id = '12345678-1111-4111-8111-123456789abc';
    const calls: string[] = [];
    const state = chainState();

    const record = harness({ state: { ...state, delta: { ...deltaLayer(id, DELTA_BYTES), id } },
      calls, mounts: mountsAfterAttach(calls) });

    record.objects.set(deltaObjectKey(STORE_ROOT, id), DELTA_BYTES + 4096);
    await expect(attachOf(record)).rejects.toThrow('state declares');
  });

  test('the current generation is refused and the retained fallback serves', async () => {
    const calls: string[] = [];
    const record = harness({ state: withFallback(), mounts: mountsAfterAttach(calls), calls });
    record.digests.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);

    const outcome = await attachOf(record);

    expect(outcome.detail).toContain('recovered');
    expect(record.state?.base.id).toBe(FALLBACK_ID);
    expect(record.state?.lastFailure?.reason).toContain('different archive of the same length');
    expect(record.objects.get(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(BASE_BYTES);
    expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
  });

  test('a delta replaced at the same length is refused, while a delta of a different '
    + 'length is still adopted', async () => {
      // A size mismatch is the crash-window delta (complete, not yet recorded) and is adopted;
      // a matching size with a different identity is corruption and is refused.
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

      expect(record.state?.base.id).toBe(FALLBACK_ID);
      expect(record.state?.fallback?.base.id).toBe(CHAIN_ID);
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(true);
      expect(record.objects.has(baseObjectKey(STORE_ROOT, FALLBACK_ID))).toBe(true);
    });

  test('a record written before layer digests existed still attaches', async () => {
    // An absent digest is UNKNOWN, so only the size check applies and the box starts;
    // refusing it would lose data on live rows (`Devbox.strategy` defaults to the chain).
    const calls: string[] = [];

    const record = harness({
      state: chainState({
        base: { id: CHAIN_ID, bytes: BASE_BYTES, digest: undefined, objectVersion: undefined },
        delta: { bytes: DELTA_BYTES, digest: undefined, objectVersion: undefined },
      }),
      mounts: mountsAfterAttach(calls),
      calls,
    });

    // The store reports a digest and version, but the record holds neither, so nothing is compared.
    record.digests.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_DIGEST);
    record.versions.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_VERSION);

    expect((await attachOf(record)).kind).toBe('attached');
    expect(record.state?.lastFailure).toBeUndefined();
  });

  test('a MULTIPART archive replaced at the same length is refused on the store version, '
    + 'even when the replacement copies the digest', async () => {
      // The Workers multipart API takes no checksum, so R2 reports no digest for a multipart
      // archive; only the version R2 minted for the recorded upload can detect a replacement.
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
      expect(record.objects.get(baseObjectKey(STORE_ROOT, CHAIN_ID))).toBe(BASE_BYTES);
      expect(record.calls.filter(call => call.startsWith('deleteObjects'))).toEqual([]);
    });

  test('agreeing content outranks a new store version, because a re-upload is not a replacement',
    async () => {
      // A version is minted per upload: a lost state write can leave the store a version ahead with
      // identical content, so a matching digest wins and the version decides only without one.
      const calls: string[] = [];
      const record = harness({ state: chainState(), mounts: mountsAfterAttach(calls), calls });
      record.versions.set(baseObjectKey(STORE_ROOT, CHAIN_ID), REPLACED_VERSION);

      expect((await attachOf(record)).kind).toBe('attached');
      expect(record.state?.lastFailure).toBeUndefined();
    });

  test('a record declaring a zero-byte base is refused, and the fallback serves', async () => {
    const calls: string[] = [];

    const record = harness({
      state: withFallback({ base: { id: CHAIN_ID, bytes: 0 } }), mounts: mountsAfterAttach(calls), calls,
    });

    record.objects.set(baseObjectKey(STORE_ROOT, CHAIN_ID), 0);

    expect((await attachOf(record)).detail).toContain('recovered');
    expect(record.state?.base.id).toBe(FALLBACK_ID);
    expect(record.state?.lastFailure?.reason).toContain('declares 0 bytes');
  });

  test('the SAME multipart object attaches, so the version check is not a false alarm',
    async () => {
      // Same size, no digest, and the recorded version must attach normally, or the version
      // check would refuse every large archive on every boot.
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
      // The digest is only knowable while the bytes move; unrecorded at commit, it needs a read-back.
      // Both layers, because both are uploaded by the same path.
      const born: string[] = [];
      const fresh = harness({ state: null, mounts: mountsAfterAttach(born), calls: born });
      expect((await checkpointOf(fresh, 'tick')).kind).toBe('committed');
      const generation = publishedState(fresh).base.id;
      expect(fresh.state?.base).toEqual(baseLayer(generation, DELTA_BYTES));
      expect(fresh.state?.delta).toBeUndefined();

      const record = harness({ state: chainState(), mounts: MOUNTED });
      expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
      expect(record.state?.delta).toEqual(publishedDeltaLayer(record.state, DELTA_BYTES));
      // The store records the digest it verified; that record is what makes the pre-attach
      // comparison possible.
      expect(record.digests.get(deltaObjectKey(STORE_ROOT, publishedDeltaId(record.state))))
        .toBe(record.state?.delta?.digest);
    });
});
