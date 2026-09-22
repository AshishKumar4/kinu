/** Snapshot chain: immutable squashfs base plus one cumulative delta at a fresh UUID key.
 *  Attach reads no payload bytes (D2); CAS publishes the pointer before cleanup (D7). */

import type { BackupOptions, DirectoryBackup } from '@cloudflare/sandbox';
import * as v from 'valibot';

import {
  CHAIN_SERVED_WORDS,
  type ChainServedWord,
  DELTA_BLOCK_BYTES,
  DELTA_MANIFEST_NAME,
  DELTA_OPS_PER_COMMAND,
  DELTA_TREE_DIR,
  type DeltaBaseFact,
  type DeltaFileHashes,
  type DeltaManifest,
  DeltaManifestSchema,
  DeltaNamespaceProbeFailed,
  type DeltaProbeEntry,
  buildDeltaAttachOps,
  buildDeltaStageOps,
  deltaBaseStatCommand,
  deltaBlockHashCommand,
  deltaHashCandidates,
  deltaProbeCommand,
  parseDeltaBaseStat,
  parseDeltaBlockHashes,
  parseDeltaProbe,
  planDeltaPublication,
  mergeDeltaPublication,
  readDeltaIndex,
  shellPath,
} from './chunked-delta';
import { DeltaFallbackSchema, type DeltaFallback, type StoragePhase } from './durability/contracts';
import { describeThrown as describe, findMount } from './lifecycle';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type FailureStampDeps,
  type StoredValue,
  recordCheckpointFailure,
  stampFailure,
} from './storage';

/** One writable mount for the container's life: the SDK refuses a binding remounted with a
 *  different readOnly setting, and squashfuse holds layer files under it; the prefix bounds. */
const CHAIN_STORE_MOUNT = '/backups';

/** R2 refuses a multipart part under 5 MiB unless it is the last, so a smaller part size
 *  fails mid-upload rather than running slower. */
const PUBLISH_PART_BYTES = 5 * 1024 * 1024;

/** s3fs PUTs a directory marker and an empty object before flush, so publishing bypasses the
 *  mount (D15); a `Bun.file` slice sends no body, so parts send `slice.stream()` (Bun 1.3.12). */
const PUBLISH_SCRIPT = `// devbox-publish-v1
const [archive, url, partArg] = process.argv.slice(2);
const partBytes = Number(partArg);

function refuse(code, message) {
  process.stderr.write(message + '\\n');
  process.exit(code);
}

if (archive === undefined || url === undefined || !Number.isSafeInteger(partBytes) || partBytes <= 0) {
  refuse(2, 'usage: publish.mjs <archive> <url> <partBytes>');
}

const file = Bun.file(archive);

if (!(await file.exists())) refuse(2, 'no archive at ' + archive);
const size = file.size;

if (size <= 0) refuse(2, archive + ' is empty');

async function answered(label, response) {
  if (response.ok) return response;
  const body = (await response.text()).slice(0, 300);
  throw new Error(label + ' answered ' + response.status + ': ' + body);
}

function tag(text, name) {
  const found = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(text);

  return found === null ? '' : found[1];
}

let etag = '';

if (size <= partBytes) {
  const put = await answered('PUT', await fetch(url, { method: 'PUT', body: file }));
  etag = put.headers.get('etag') ?? '';
} else {
  const opened = await answered('POST ?uploads', await fetch(url + '?uploads=', { method: 'POST' }));
  const uploadId = tag(await opened.text(), 'UploadId');

  if (uploadId.length === 0) refuse(1, 'the multipart upload was opened without an id');
  const id = encodeURIComponent(uploadId);
  const parts = [];

  try {
    for (let number = 1, offset = 0; offset < size; number += 1, offset += partBytes) {
      const slice = file.slice(offset, Math.min(size, offset + partBytes));
      const part = await answered('PUT part ' + number, await fetch(url + '?partNumber=' + number + '&uploadId=' + id, {
        method: 'PUT',
        headers: { 'content-length': String(slice.size) },
        body: slice.stream(),
      }));
      parts.push('<Part><PartNumber>' + number + '</PartNumber><ETag>' + (part.headers.get('etag') ?? '') + '</ETag></Part>');
    }

    const completed = await answered('POST ?uploadId', await fetch(url + '?uploadId=' + id, {
      method: 'POST', body: '<CompleteMultipartUpload>' + parts.join('') + '</CompleteMultipartUpload>',
    }));
    etag = tag(await completed.text(), 'ETag');
  } catch (error) {
    const aborted = await fetch(url + '?uploadId=' + id, { method: 'DELETE' });
    refuse(1, String(error && error.message ? error.message : error) + '; multipart ' + uploadId + (aborted.ok ? ' aborted' : ' NOT aborted (' + aborted.status + ')'));
  }
}

const head = await answered('HEAD', await fetch(url, { method: 'HEAD' }));
const landed = Number(head.headers.get('content-length'));

if (landed !== size) refuse(3, 'the store reports ' + landed + ' bytes for ' + url + ' where ' + size + ' were sent');
process.stdout.write(size + ' ' + etag);
`;

/** `PUBLISH_SCRIPT` as it travels inside {@link publishCommand}: base64, so
 *  no byte of it can become shell syntax. */
const PUBLISH_SCRIPT_B64 = btoa(PUBLISH_SCRIPT);

class ContainerChangedDuringAttach extends Error {
  constructor() {
    super('the container generation changed while snapshot-chain attached its lower layers');
    this.name = 'ContainerChangedDuringAttach';
  }
}

/** Only a generation's own archive failing to mount or read; the caller may fall back to an
 *  older generation. Other attach failures say nothing about its bytes and never cost a promotion. */
class LayerUnreadable extends Error {
  constructor(layer: string, generation: string, thrown: { readonly cause: unknown }) {
    super(`the ${layer} layer of generation ${generation} could not be read`, {
      cause: thrown.cause,
    });
    this.name = 'LayerUnreadable';
  }
}

/** Extraction-path archive lifetime only; never put a lifecycle rule on the chain prefix:
 *  it deletes by upload age and the once-written base would vanish from an active box. */
const EXTRACT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Excluded trees must be regenerable from kept lockfiles; never exclude a lockfile or `.git`,
 *  which holds unpushed commits and refs (a linked worktree's `.git` is a file). */
export const CHAIN_EXCLUDES = [
  'node_modules', '*.log', '.cache',
  '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist',
] as const;

/** Mirrors `@cloudflare/sandbox` `BackupService` normalisation exactly: a different one would
 *  exclude a different file set from the same policy; null means the pattern matches nothing. */
function normalizeArchiveExclude(pattern: string): string | null {
  let normalized = pattern;

  while (normalized.startsWith('**/')) normalized = normalized.slice(3);

  while (normalized.includes('/**/')) normalized = normalized.replaceAll('/**/', '/');

  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3);

  if (normalized === '' || normalized === '**') return null;

  return normalized;
}

/** Two lines per pattern: mksquashfs anchors an exclude to the source dir unless prefixed `... `;
 *  with `-wildcards`, both lines exclude the pattern at every depth. */
export function archiveExcludeFile(patterns: readonly string[]): string {
  const lines: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeArchiveExclude(pattern);

    if (normalized === null) continue;
    lines.push(normalized, `... ${normalized}`);
  }

  return lines.map(line => `${line}\n`).join('');
}

/** Rebase once the delta outgrows the base by this factor: beyond it, every checkpoint
 *  moves more bytes than a fresh base would cost. */
const REBASE_DELTA_RATIO = 1;

/** Rebase only at a quiesce: it pays only if the upper is then empty, and emptying a live
 *  upper races every writer. A tick keeps appending however large the delta grows. */
export function shouldRebase(state: ChainState | null, kind: CheckpointKind): boolean {
  if (kind !== 'quiesce' || state === null || state.mode !== 'chain') return false;

  if (state.delta === undefined) return false;

  return state.delta.bytes > REBASE_DELTA_RATIO * state.base.bytes;
}

/** Empty `fallback` means an attach proved the current generation, so the outgoing one takes it;
 *  else the proven copy stays and the outgoing base is orphaned, losing no work. */
export function supersedeGeneration(
  previous: ChainState,
): Pick<ChainState, 'fallback' | 'orphans'> {
  if (previous.fallback === undefined) {
    return {
      fallback: { base: previous.base, delta: previous.delta, deltaFormat: previous.deltaFormat, deltaFallback: previous.deltaFallback },
      orphans: previous.orphans,
    };
  }

  return {
    fallback: previous.fallback,
    orphans: [...(previous.orphans ?? []), previous.base.id],
  };
}

/** Every object key is built from a chain id, so anything that is not a UUID
 *  (`..`, a path separator, another box's guess) dies before it becomes a key. */
const CHAIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChainId(id: string): boolean {
  return CHAIN_ID_RE.test(id);
}

function assertChainId(id: string): string {
  if (!isChainId(id)) {
    throw new Error(
      `chain id ${JSON.stringify(id.slice(0, 64))} is not a UUID; refusing to build `
      + 'storage keys from it',
    );
  }

  return id;
}

/** Per-box prefix: the SDK admits a second mount of a binding only at the same prefix, and
 *  a rebase mints a new generation while the old layers stay mounted as the overlay's lowers. */
export function chainStoreRoot(boxPrefix: string): string {
  return `${boxPrefix}/backups`;
}

export function baseObjectKey(root: string, chainId: string): string {
  assertChainId(chainId);

  return `${root}/${chainId}/data.sqsh`;
}

/** The cumulative changed set: ONE key, replaced by each checkpoint's PUT. */
export function deltaObjectKey(root: string, chainId: string): string {
  assertChainId(chainId);

  return `${root}/${chainId}/delta.sqsh`;
}

/** The SDK's own metadata object, written only by its backup API: extraction
 *  handles, and discard cleaning up after them. */
export function metadataObjectKey(root: string, chainId: string): string {
  assertChainId(chainId);

  return `${root}/${chainId}/meta.json`;
}

/** Checks fstype only: `fuse-overlayfs` does not publish `lowerdir`/`upperdir`/`workdir`
 *  in `/proc/mounts`; the upper is the path passed to the mount, verified by a probe. */
function isOverlayMounted(procMounts: string, dir: string): boolean {
  const line = findMount(procMounts, dir);

  return line !== undefined && line.fstype.includes('overlay');
}

/** Size is not identity: `digest` (SHA-256, store-confirmed only for checksummed single PUTs)
 *  and per-upload `objectVersion` both check it; an absent side is unknown and skipped. */
export function layerIntegrityFailure(input: {
  declared: ChainLayer | undefined;
  stored: ChainLayer | undefined;
  label: string;
}): string | null {
  const { declared, stored, label } = input;

  if (declared === undefined) return `${label} declares no size`;

  if (stored === undefined) return `${label} archive object is missing from the store`;

  if (declared.bytes <= 0) return `${label} declares ${declared.bytes} bytes`;

  if (stored.bytes !== declared.bytes) {
    return `${label} archive is ${stored.bytes} bytes, state declares ${declared.bytes}`;
  }

  // Digest wins when both sides have one: versions are minted per upload, so identical
  // re-puts or a lost state write change the version; refusing on it burns the fallback.
  if (declared.digest !== undefined && stored.digest !== undefined) {
    if (stored.digest === declared.digest) return null;

    return `${label} archive is ${stored.bytes} bytes, exactly as recorded, and its content `
      + `digest is ${stored.digest}, while the record describes ${declared.digest}. That is a `
      + 'different archive of the same length, so the count proves nothing about it.';
  }

  if (declared.objectVersion !== undefined && stored.objectVersion !== undefined
    && stored.objectVersion !== declared.objectVersion) {
    return `${label} archive is ${stored.bytes} bytes, exactly as recorded, and the store holds `
      + `version ${stored.objectVersion} where the record describes `
      + `${declared.objectVersion}. Nothing here can compare content — the Workers multipart `
      + 'API carries no checksum — and the object under this key was written by a different '
      + 'upload, so it is a different archive of the same length however its metadata reads.';
  }

  return null;
}

/** `chain` is the production lazy-mount path; `extract` is local development.
 *  Persisted: a box always attaches the way it was checkpointed. */
export type ChainMode = 'chain' | 'extract';

/** Mirrors the SDK's `CheckChangesResult.status`. `resync` means the retained
 *  change state was lost, so the directory counts as changed. */
export type ChangeStatus = 'unchanged' | 'changed' | 'resync';

/** One type for record and store sides, so {@link layerIntegrityFailure} compares whole layers.
 *  Absent `digest`/`objectVersion` mean UNKNOWN, never sound; backfill would re-read every byte. */
export interface ChainLayer {
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the bytes that landed, when it is known. */
  readonly digest: string | undefined;
  /** The store's own name for the upload that wrote the object, when it is
   *  known. R2 mints one per upload and reports it from `head` forever after. */
  readonly objectVersion: string | undefined;
}

/** The base layer also NAMES the generation: its UUID is the store prefix
 *  every key in that generation is built from. */
export interface ChainBaseLayer extends ChainLayer {
  readonly id: string;
}

interface ChainDeltaLayer extends ChainLayer {
  /** Immutable publication identity. Absent only on a legacy-only archive. */
  readonly id?: string | undefined;
}

type DeltaPublication = { kind: 'chunked'; layer: ChainLayer } | { kind: 'whole-upper'; fallback: DeltaFallback };

/** A retained fallback carries the same format and fallback evidence as the current generation. */
export interface ChainGeneration {
  /** The full base. Immutable once written. */
  readonly base: ChainBaseLayer;
  readonly delta: ChainDeltaLayer | undefined;
  /** `chunked`: changed extents plus per-file indexes, served through composed lazy lowers.
   *  Absent: a full squashfs of the upper composed as an overlay lower, served until replaced. */
  readonly deltaFormat?: 'chunked' | undefined;
  readonly deltaFallback?: DeltaFallback | undefined;
}

/** One record, one writer, replaced whole. */
export interface ChainState extends ChainGeneration {
  /** Superseded immutable deltas, retained while a fallback or live mount uses them. */
  readonly retiredDeltas?: readonly string[];
  readonly mode: ChainMode;
  /** Monotonic revision. Every publication bumps it, and so does a restore
   *  that promotes the fallback. */
  readonly rev: number;
  /** Epoch ms the checkpoint completed. The interval gate reads this. */
  readonly at: number;
  /** Advanced only on a successful checkpoint or an unchanged report, never after an unarchived
   *  change: the next tick would believe it was already saved. */
  readonly changeVersion: string | undefined;
  /** The upper's fingerprint at the last successful commit; the skip gate
   *  compares against it. */
  readonly upperMark: string | undefined;
  /** Undefined once the current generation is proven; that attach moves the occupant to `orphans`.
   *  Carries sizes because a fallback the integrity probe cannot check is not a fallback. */
  readonly fallback: ChainGeneration | undefined;
  /** Named BEFORE the delete and cleared after it, so a crash between a rebase's state flip
   *  and the deletion cannot orphan an unnamed generation; see `sweepOrphans`. */
  readonly orphans: readonly string[] | undefined;
  /** The alarm loop reduces a thrown scheduled callback to a console line, so durable state keeps
   *  a failing checkpoint visible; a restore that refused a generation records it here too. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/** A durable row is untrusted: a row this code did not write reads as absent (a fresh box),
 *  not as a chain whose base cannot be found (a box that refuses to start forever). */
const DigestSchema = v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)));

/** The store's own version string. Its FORM is the store's business, so this
 *  asks only for a non-empty string. */
const ObjectVersionSchema = v.optional(v.pipe(v.string(), v.minLength(1)));

const ChainGenerationSchema = v.object({
  base: v.object({
    id: v.pipe(v.string(), v.regex(CHAIN_ID_RE)),
    bytes: v.number(),
    digest: DigestSchema,
    objectVersion: ObjectVersionSchema,
  }),
  delta: v.optional(v.object({
    id: v.optional(v.pipe(v.string(), v.regex(CHAIN_ID_RE))),
    bytes: v.number(),
    digest: DigestSchema,
    objectVersion: ObjectVersionSchema,
  })),
  deltaFormat: v.optional(v.picklist(['chunked'])),
  deltaFallback: v.optional(DeltaFallbackSchema),
});

const ChainStateSchema = v.object({
  ...ChainGenerationSchema.entries,
  mode: v.picklist(['chain', 'extract']),
  rev: v.number(),
  at: v.number(),
  changeVersion: v.optional(v.string()),
  upperMark: v.optional(v.string()),
  fallback: v.optional(ChainGenerationSchema),
  orphans: v.optional(v.array(v.pipe(v.string(), v.regex(CHAIN_ID_RE)))),
  retiredDeltas: v.optional(v.array(v.pipe(v.string(), v.regex(CHAIN_ID_RE)))),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

/** Written out rather than spread, so an absent delta, digest or version
 *  becomes present-and-undefined: what the contract declares. */
function generationOf(row: v.InferOutput<typeof ChainGenerationSchema>): ChainGeneration {
  return {
    base: {
      id: row.base.id,
      bytes: row.base.bytes,
      digest: row.base.digest,
      objectVersion: row.base.objectVersion,
    },
    delta: row.delta === undefined ? undefined : {
      id: row.delta.id,
      bytes: row.delta.bytes,
      digest: row.delta.digest,
      objectVersion: row.delta.objectVersion,
    },
    deltaFormat: row.deltaFormat,
    deltaFallback: row.deltaFallback,
  };
}

export function normalizeChainState(raw: StoredValue): ChainState | null {
  const parsed = v.safeParse(ChainStateSchema, raw);

  if (!parsed.success) return null;
  const row = parsed.output;

  return {
    mode: row.mode,
    rev: row.rev,
    ...generationOf(row),
    at: row.at,
    changeVersion: row.changeVersion,
    upperMark: row.upperMark,
    fallback: row.fallback === undefined ? undefined : generationOf(row.fallback),
    orphans: row.orphans,
    retiredDeltas: row.retiredDeltas,
    lastFailure: row.lastFailure,
  };
}

function shouldCheckpoint(
  change: ChangeStatus,
  lastCheckpointAt: number,
  now: number,
  minIntervalMs: number,
): boolean {
  if (change === 'unchanged') return false;

  return now - lastCheckpointAt >= minIntervalMs;
}

export class ChainRecordAdvanced extends Error {
  constructor(expectedRev: number | null, storedRev: number | null) {
    super(`another writer advanced the chain record to rev ${storedRev ?? 'none'} after this one read rev ${expectedRev ?? 'none'}`);
    this.name = 'ChainRecordAdvanced';
  }
}

/** The adapter decides nothing: each entry maps to one public Sandbox SDK primitive,
 *  one object-store binding call, or the box's own durable storage. */
export interface SnapshotChainPorts {
  /** Must not wake a sleeping container: asking it whether it changed would keep it alive forever. */
  containerRunning(): boolean;
  /** Declared by the host, never discovered: extraction leaves no upper, so writes after the
   *  base are lost on restore. A mount failure where extraction is not permitted is a failure. */
  allowExtraction(): boolean;
  /** What a whole-tree base leaves behind, for THIS box. Defaults to
   *  {@link CHAIN_EXCLUDES}. */
  archiveExcludes(): readonly string[];
  readState(): Promise<ChainState | null>;
  /** `null` means no record. Read, compare and put are ONE transaction, so two boots that
   *  read one record cannot both advance it. */
  writeState(state: ChainState, expectedRev: number | null): Promise<void>;
  clearState(): Promise<void>;
  /** Minimum gap between two commits, from the host's policy: one place
   *  decides the cadence for the schedule and this gate. */
  checkpointIntervalMs(): number;
  /** Has the work directory changed since `since`, per the container's own
   *  retained change state? */
  checkChanges(dir: string, since: string | undefined):
    Promise<{ status: ChangeStatus; version: string }>;
  /** The only container-shell port: the strategy builds every command (mount flags, squashfs
   *  options, probes) itself. A property, not a method: the suites read it off the record to wrap it. */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  containerGeneration?(): Promise<string | undefined>;
  /** This box's chain root in the store, see {@link chainStoreRoot}. A port
   *  because the box's identity is the host's. */
  storeRoot(): string;
  /** URL the store mount's egress host serves for `key`; the publisher PUTs to it directly (D15).
   *  A key outside the mount's prefix has no URL: the handler would write a different object. */
  storeObjectUrl(key: string): string;
  /** Writable, yet credentials never leave the DO: s3fs holds a dummy password and a Worker
   *  resolves its requests. The mount serves reads and registers the route `storeObjectUrl` uses. */
  mountStore(at: string): Promise<void>;
  /** Release through the SDK: a raw `fusermount3` leaves the SDK registry claiming the path.
   *  A release is not a flush; publication reads the store (HEAD, `objectFacts`), not the mount. */
  unmountStore(at: string): Promise<void>;
  /** A phase of the attach landed. The host keeps the clock; the strategy must call this
   *  because only it knows which of its commands was the mount. */
  stamp(phase: StoragePhase): void;
  /** The store's own `digest`/`objectVersion` (either may be undefined): the only way a
   *  publication learns what landed, since the container writes through a mount. */
  objectFacts(key: string): Promise<ChainLayer | undefined>;
  deleteObjects(keys: readonly string[]): Promise<void>;
  /** Records which delta the upper on this container disk holds; lives beside the upper so no archive
   *  carries it, and off durable storage because the fact dies with the disk (P1). */
  readSeedStamp(): Promise<string | undefined>;
  writeSeedStamp(stamp: string): Promise<void>;
  /** Entry count of the work directory. The extraction-mode postcondition. */
  countEntries(dir: string): Promise<number>;
  /** Extraction-mode attach, through the SDK's own local-store path. */
  restoreExtract(backup: DirectoryBackup): Promise<{ success: boolean }>;
  /** Extraction-mode checkpoint: the SDK archives a whole tree and moves it
   *  through the binding. LOCAL DEVELOPMENT ONLY. */
  createExtractSnapshot(options: BackupOptions): Promise<DirectoryBackup>;
  /** Properties, not methods: the failure-stamp deps carry both by reference. */
  now: () => number;
  log: (message: string) => void;
}

/** TTL lives only here: the SDK enforces it at restore on archives its backup API wrote.
 *  Excludes are the caller's, passed raw: the SDK normalises them like `normalizeArchiveExclude`. */
export function chainBackupOptions(
  localBucket: boolean,
  excludes: readonly string[],
): BackupOptions {
  return {
    dir: DEVBOX_WORKDIR,
    localBucket,
    gitignore: true,
    excludes: [...excludes],
    ttl: EXTRACT_TTL_SECONDS,
    // zstd: every byte is paid on upload and again on every attach.
    compression: { format: 'zstd' },
  };
}

/** The overlay's writable upper: the whole changed set since the base. */
const upperDir = `${DEVBOX_RUNTIME_DIR}/upper`;

/** fuse-overlayfs's own scratch directory. Not readable as content. */
const workDir = `${DEVBOX_RUNTIME_DIR}/work`;

const stageDir = `${DEVBOX_RUNTIME_DIR}/stage`;

/** tmpfs staging costs no disk quota; used only when the disk gate refuses, since memory
 *  is smaller than disk and a large tree that fits on disk must not be forced through it. */
const tmpStageDir = `/dev/shm/devbox-stage`;

/** Mount point for the base layer: the overlay's bottom lower, mounted for
 *  as long as the overlay is. */
const lowerBase = `${DEVBOX_RUNTIME_DIR}/lower-base`;

const blockLower = `${DEVBOX_RUNTIME_DIR}/block-lower`;

const blockStats = `${DEVBOX_RUNTIME_DIR}/block-lower-stats.json`;

const lowerDeltaRoot = `${DEVBOX_RUNTIME_DIR}/lower-delta`;

/** An empty lower for a box with no chain yet, so "chain mode" and "`/workspace` is a plain
 *  directory" can never both be true. See `attachFresh`. */
const lowerEmpty = `${DEVBOX_RUNTIME_DIR}/lower-empty`;

/** Named per generation: a later checkpoint checks this path to tell its own layer from a
 *  mount left by a superseded generation; one fixed path would make every commit collapse. */
function deltaLayerMountPoint(chainId: string): string {
  return `${lowerDeltaRoot}/${assertChainId(chainId)}`;
}

/** The read path's `squashfuse` source and the write path's `dd` target share this one answer
 *  so they cannot drift apart. */
function mountedLayerPath(mountPoint: string, root: string, objectKey: string): string {
  const relative = objectKey.startsWith(`${root}/`) ? objectKey.slice(root.length + 1) : objectKey;

  return `${mountPoint}/${relative}`;
}

/** True means the changed set spans the layer and the upper, so a commit must collapse, not archive.
 *  Reads `/proc/mounts`: a recorded note can outlive the container that mounted the layer. */
function deltaLayerServed(procMounts: string, chainId: string): boolean {
  return findMount(procMounts, deltaLayerMountPoint(chainId)) !== undefined;
}

function retirementAfter(previous: ChainState | null): string[] {
  const ids = new Set(previous?.retiredDeltas ?? []);
  const id = previous?.delta?.id;

  if (id !== undefined) ids.add(id);

  return [...ids];
}

/** A count, not a deadline: the FUSE mount is proven, so only the store's first metadata
 *  answer is outstanding; waiting against the restoration budget does not improve it. */
const LAYER_VISIBILITY_PROBES = 20;

/** A count, not a timer: a release succeeds or is refused by a holder, and retrying never
 *  frees a holder; the bound turns a stuck mount into a diagnosis instead of a hang. */
const MOUNT_RELEASE_ATTEMPTS = 20;

type ContainerExec = SnapshotChainPorts['exec'];

function chainShell(exec: ContainerExec, root: string) {
  const must = async (doing: string, command: string): Promise<string> => {
    const result = await exec(command);

    if (result.exitCode !== 0) {
      throw new Error(`${doing} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }

    return result.stdout;
  };

  return {
    readMounts: async (): Promise<string> => await must('reading the mount table', 'cat /proc/mounts'),
    /** A mount line without a usable upper is a box whose writes have nowhere to land. */
    pathExists: async (path: string): Promise<boolean> =>
      (await exec(`test -e ${shellPath(path)} && echo yes || echo no`)).stdout.trim() === 'yes',
    /** Only for squashfuse layers: releasing an SDK mount this way leaves its registry claiming it.
     *  Still mounted after the last attempt fails, since an attach would mount on top; no `exit`. */
    unmountPath: async (path: string): Promise<void> => {
      await must(`releasing the mount at ${path}`,
        `for _ in $(seq 1 ${String(MOUNT_RELEASE_ATTEMPTS)}); do `
          + `grep -qs ${shellPath(` ${path} `)} /proc/mounts || break; `
          + `/usr/bin/fusermount3 -u ${shellPath(path)} || true; sleep 0.1; done; `
          + `if grep -qs ${shellPath(` ${path} `)} /proc/mounts; then `
          + `echo "still mounted after ${String(MOUNT_RELEASE_ATTEMPTS)} release attempts" >&2; `
          + 'false; fi');
    },
    /** Unmount every delta layer, deepest first, even ones another generation mounted; safe only
     *  where `/workspace` is not an overlay. Every stuck layer is named, not just the first. */
    releaseDeltaLayers: async (): Promise<void> => {
      await must('releasing delta layers',
        `stuck=; for p in $(awk -v r=${shellPath(`${lowerDeltaRoot}/`)} `
          + `'index($2, r) == 1 {print $2}' /proc/mounts | sort -r); do `
          + `for _ in $(seq 1 ${String(MOUNT_RELEASE_ATTEMPTS)}); do `
          + `grep -qs " $p " /proc/mounts || break; `
          + `/usr/bin/fusermount3 -u "$p" 2>/dev/null || true; sleep 0.1; done; `
          + `if grep -qs " $p " /proc/mounts; then `
          + `echo "delta layer $p is still mounted" >&2; stuck=1; fi; done; [ -z "$stuck" ]`);
    },
    /** Each probe re-lists the store subtree: a listing repopulates a stat cache that said ENOENT.
     *  Never `exit`: every command shares the SDK's persistent shell, and `exit` kills the session. */
    awaitLayer: async (path: string): Promise<{ ready: boolean; holds: string }> => {
      const probed = await exec(
        `seen=; for _ in $(seq 1 ${String(LAYER_VISIBILITY_PROBES)}); do `
          + `if test -e ${shellPath(path)}; then seen=1; break; fi; `
          + `ls -1A ${shellPath(CHAIN_STORE_MOUNT)} >/dev/null 2>&1; sleep 0.25; done; `
          + 'if [ -n "$seen" ]; then printf ready; else '
          + `printf 'missing '; ls -1A ${shellPath(CHAIN_STORE_MOUNT)} 2>&1 | head -20 | tr '\n' ' '; fi`,
      );

      const answer = probed.stdout.trim();

      return {
        ready: answer === 'ready',
        holds: answer.startsWith('missing') ? answer.slice('missing'.length).trim() : answer,
      };
    },
    /** Mountpoint is created in the same command: a spot container can be replaced between RPCs,
     *  and fuse refuses a mountpoint an earlier exec prepared (`bad mount point`). */
    mountLayer: async (objectKey: string, mountPoint: string): Promise<void> => {
      const source = mountedLayerPath(CHAIN_STORE_MOUNT, root, objectKey);
      await must('squashfuse mount', `mkdir -p ${shellPath(mountPoint)} && /usr/local/bin/devbox-squashfuse `
        + `${shellPath(mountedLayerPath(CHAIN_STORE_MOUNT, root, objectKey))} ${shellPath(mountPoint)} `
        + `-o ${shellPath(`allow_other,ro,nonempty,subtype=squashfuse,fsname=${source}`)}`);
    },
    mountBlockLower: async (generation: string, delta: string, baseSource: string, deltaSource: string): Promise<void> => {
      await must('read-only block lower mount', '# devbox-block-lower-v2\n'
        + `mkdir -p ${shellPath(blockLower)}\n`
        + `setsid nohup /usr/local/bin/devbox-block-lower --base ${shellPath(lowerBase)} --delta ${shellPath(delta)} `
        + `--mount ${shellPath(blockLower)} --generation ${shellPath(generation)} `
        + `--base-source ${shellPath(baseSource)} --delta-source ${shellPath(deltaSource)} `
        + `--stats ${shellPath(blockStats)} </dev/null >${shellPath(`${DEVBOX_RUNTIME_DIR}/block-lower.log`)} 2>&1 &\n`
        + `block_pid=$!; for _ in $(seq 1 100); do mountpoint -q ${shellPath(blockLower)} && break; `
        + `kill -0 "$block_pid" 2>/dev/null || break; sleep 0.05; done\n`
        + `mountpoint -q ${shellPath(blockLower)} || { cat ${shellPath(`${DEVBOX_RUNTIME_DIR}/block-lower.log`)} >&2; false; }`);
    },
    /** Attach `lowers` (first entry is newest) with a fresh writable upper,
     *  created in the same command for the reason {@link mountLayer} states. */
    overlayAttach: async (dir: string, lowers: readonly string[]): Promise<void> => {
      await must('fuse-overlayfs attach', `mkdir -p ${shellPath(upperDir)} `
        + `${shellPath(workDir)} && /usr/bin/fuse-overlayfs `
        + `-o lowerdir=${lowers.map(shellPath).join(':')}`
        + `,upperdir=${shellPath(upperDir)},workdir=${shellPath(workDir)} ${shellPath(dir)}`);
    },
    /** Build and measure stay one command for the reason {@link archiveCommand} states. */
    makeSquashfs: async (
      sourceDir: string, archivePath: string, excludes: readonly string[],
    ): Promise<number> => {
      const excludeFile = `${archivePath.slice(0, archivePath.lastIndexOf('/'))}/excludes.txt`;

      const result = await exec(archiveCommand({
        sourceDir, archivePath, excludeFile, excludes,
      }));

      const [code, size] = result.stdout.trim().split(/\s+/);

      if (code !== '0') {
        throw new Error(
          `staging the exclude list or building the squashfs failed (${code ?? '?'}): `
          + `${result.stderr.trim() || 'no output'}`,
        );
      }

      const bytes = Number(size);

      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(
          `mksquashfs reported success but ${archivePath} is ${size ?? 'absent'}: `
          + `${result.stderr.trim() || 'the archiver left no diagnostics'}`,
        );
      }

      return bytes;
    },
    /** Writes to the final name: a temp name plus rename is a server-side COPY of every byte,
     *  and the object is visible only once the PUT completes, so no reader sees a partial (D15). */
    publishArchive: async (archivePath: string, objectUrl: string): Promise<number> => {
      const result = await exec(publishCommand({ archivePath, objectUrl }));
      const [code, size, etag] = result.stdout.trim().split(/\s+/);

      if (code !== '0') {
        throw new Error(
          `publishing ${archivePath} to ${objectUrl} failed (${code ?? '?'}): `
          + `${result.stderr.trim() || 'no output'}`,
        );
      }

      const bytes = Number(size);

      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(
          `the store reports ${objectUrl} as ${size ?? 'absent'} after a publication `
          + `that reported success${etag === undefined ? '' : ` (etag ${etag})`}: `
          + `${result.stderr.trim() || 'no diagnostics'}`,
        );
      }

      return bytes;
    },
    /** Upper bound: squashfs never exceeds its input; size and exclude come off one policy list.
     *  Both readings run in one command so a container replacement cannot split them. */
    stagingShortfall: async (
      sourceDir: string,
      excludes: readonly string[],
    ): Promise<string | null> => {
      const measured = await exec(
        `mkdir -p ${shellPath(stageDir)}; `
        + `need=$(${archiveSizeCommand(sourceDir, excludes)}); `
        + `free=$(df -Pk ${shellPath(stageDir)} | awk 'NR==2 {print $4*1024}'); `
        + `echo "$need $free"`,
      );

      const [need, free] = measured.stdout.trim().split(/\s+/).map(Number);

      // An unreadable answer is NOT a refusal: refusing every checkpoint
      // because a probe could not parse would lose more than a full disk.
      if (!Number.isFinite(need) || !Number.isFinite(free)) return null;

      if (free >= need) return null;

      return `staging ${sourceDir} needs up to ${need} bytes and ${stageDir} has ${free} free.`;
    },
    /** Skip-gate fingerprint of the upper: walks metadata, not content, O(entries).
     *  The gate in `checkpoint` states why the SDK's change check is not the question. */
    upperFingerprint: async (): Promise<string> => {
      const measured = await exec(upperFingerprintCommand(upperDir));

      return measured.exitCode === 0 ? measured.stdout.trim() : '';
    },
    statBytes: async (path: string): Promise<number | undefined> => {
      const raw = (await exec(`stat -c %s ${shellPath(path)} 2>/dev/null || echo ''`)).stdout.trim();

      return raw.length > 0 ? Number.parseInt(raw, 10) : undefined;
    },
    /** Runs through `must()`: a reset that fails silently leaves the attach on a stale tree. */
    resetDirs: async (paths: readonly string[]): Promise<void> => {
      await must('resetting directories',
        `rm -rf ${shellPaths(paths)} && mkdir -p ${shellPaths(paths)}`);
    },
  };
}

interface ChainCommitOptions {
  /** Archive the merged work directory as a new base under a new generation. */
  readonly rebasing?: boolean;
  readonly upperMark?: string;
  readonly kind?: CheckpointKind;
}

interface ComposedMounts {
  readonly mounts: string;
  readonly token: string;
  readonly baseSource: string;
  readonly deltaSource: string;
  readonly deltaLayer: string;
}

function restoredFrom(haveDelta: boolean, held: boolean, chunked: boolean): ChainServedWord {
  if (!haveDelta) return CHAIN_SERVED_WORDS.base;

  if (held) return CHAIN_SERVED_WORDS.held;

  return chunked ? CHAIN_SERVED_WORDS.chunked : CHAIN_SERVED_WORDS.layered;
}

function commitWord(rebasing: boolean, first: boolean): string {
  if (rebasing) return 'rebase';

  return first ? 'base' : 'delta';
}

/** `set -e` stays inside the batch's own subshell: the SDK runs all commands in one persistent
 *  bash session, where a top-level `set -e` ends it on any later failure (D18). */
function opsBatchCommand(header: string, ops: readonly string[]): string {
  return [header, '(', 'set -e', ...ops, ')'].join('\n');
}

export function snapshotChainStorage(ports: SnapshotChainPorts): DevboxStorage {
  const shell = chainShell(ports.exec, ports.storeRoot());
  const root = ports.storeRoot();

  /** A stamp lands on the revision it read, or not at all. */
  const stamps: FailureStampDeps<ChainState> = {
    writeState: async (next) => await ports.writeState(next, next.rev),
    log: ports.log,
    now: ports.now,
  };

  /** A base is written once, so a size mismatch is refused; a size-mismatched delta is the
   *  crash-window PUT, adopted whole. A missing delta, or same-size digest mismatch, is refused. */
  const probe = async (
    mode: ChainMode,
    generation: ChainGeneration,
  ): Promise<
    { refusal: string } | { refusal: null; delta: ChainDeltaLayer | undefined }
  > => {
    if (mode === 'extract') return { refusal: null, delta: undefined };

    const unsound = layerIntegrityFailure({
      declared: generation.base,
      stored: await ports.objectFacts(baseObjectKey(root, generation.base.id)),
      label: 'base',
    });

    if (unsound !== null) return { refusal: unsound };

    if (generation.delta === undefined) return { refusal: null, delta: undefined };
    const stored = await ports.objectFacts(deltaObjectKey(root, generation.delta.id ?? generation.base.id));

    if (stored === undefined) {
      return {
        refusal: `delta archive is missing from the store, but the record names one of `
          + `${generation.delta.bytes} bytes. Refusing rather than attaching a chain whose `
          + 'changed set is gone.',
      };
    }

    if (generation.delta.id !== undefined || stored.bytes === generation.delta.bytes) {
      const corrupt = layerIntegrityFailure({
        declared: generation.delta,
        stored,
        label: 'delta',
      });

      if (corrupt !== null) return { refusal: corrupt };
    }

    return { refusal: null, delta: { ...generation.delta, ...stored } };
  };

  const attachExtract = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    const result = await ports.restoreExtract({
      id: generation.base.id, dir: DEVBOX_WORKDIR, localBucket: true,
    });

    // An archive that will not extract is this generation's own failure, so
    // it travels as one: an older generation may still start.
    if (!result.success) {
      throw new LayerUnreadable('extraction', generation.base.id, {
        cause: new Error(`extraction of ${DEVBOX_WORKDIR} reported failure.`),
      });
    }

    if ((await ports.countEntries(DEVBOX_WORKDIR)) === 0) {
      throw new LayerUnreadable('extraction', generation.base.id, {
        cause: new Error(
          `extraction of ${DEVBOX_WORKDIR} reported success, but the directory is empty.`,
        ),
      });
    }

    ports.log(`${DEVBOX_WORKDIR} extracted from ${generation.base.id}`);

    return { kind: 'attached', detail: `extract ${generation.base.id}` };
  };

  /** Generation, size and object version are all needed: generation matches after a rebase,
   *  size matches another archive; no digest, as R2 reports none for mount-written archives. */
  const seedStampOf = (chainId: string, delta: ChainLayer): string =>
    `${chainId}:${delta.bytes}:${delta.objectVersion ?? 'no-version'}`;

  /** Record what the upper now holds. BEST EFFORT: a missing stamp costs a
   *  composed attach and one collapse, never correctness. */
  const stampSeededUpper = async (chainId: string, delta: ChainLayer): Promise<void> => {
    try {
      await ports.writeSeedStamp(seedStampOf(chainId, delta));
    } catch (error) {
      ports.log(
        `${upperDir} holds delta ${chainId} and the seed stamp could not be written, so the `
        + `next attach on this container composes it as a layer instead: `
        + `${describe({ cause: error })}`,
      );
    }
  };

  /** The container's `/proc/mounts` is the authority: the SDK path registry is unreadable, resets
   *  with the isolate, and refuses a second mount; a bare-path unmount clears a stale entry. */
  const mountStoreOnce = async (): Promise<string | undefined> => {
    const mounts = await shell.readMounts();

    if (findMount(mounts, CHAIN_STORE_MOUNT) !== undefined) return mounts;
    await ports.unmountStore(CHAIN_STORE_MOUNT);
    await ports.mountStore(CHAIN_STORE_MOUNT);
    ports.stamp('storeMount');

    return undefined;
  };

  /** Overrides must be block-aligned, ascending and inside the file: `dd seek` over any other
   *  map writes past what the manifest declares. A chunked record with no manifest fails. */
  const readSidecarManifest = async (
    deltaLayer: string,
    generation: ChainGeneration,
    layerFailed: (layer: string, thrown: { readonly cause: unknown }) => Promise<never>,
  ): Promise<DeltaManifest | null> => {
    const cat = await ports.exec(`# devbox-manifest-v1\ncat ${shellPath(`${deltaLayer}/${DELTA_MANIFEST_NAME}`)} 2>/dev/null`);
    let manifest: DeltaManifest | null = null;
    let refusedVersion = false;

    if (cat.exitCode === 0 && cat.stdout.trim() !== '') {
      try {
        const json: unknown = JSON.parse(cat.stdout);
        const version = v.safeParse(v.object({ v: v.number() }), json);
        refusedVersion = version.success && version.output.v !== 2;
        const read = v.safeParse(DeltaManifestSchema, json);

        if (read.success) manifest = read.output;
      } catch (error) {
        // Non-JSON here is a legacy full delta whose tree holds this path; log it, since a
        // chunked record over such bytes is refused just after.
        ports.log(`${deltaLayer}/${DELTA_MANIFEST_NAME} is not a delta manifest: ${describe({ cause: error })}`);
      }
    }

    if (refusedVersion) await layerFailed('delta', { cause: new Error('unsupported delta manifest version; reset deployment required') });

    if (manifest === null && generation.deltaFormat === 'chunked') {
      await layerFailed('delta', { cause: new Error('the record names a chunked delta whose mount serves no manifest') });
    }

    if (manifest === null) return null;

    return manifest;
  };

  const readSidecarIndexes = async (manifest: DeltaManifest, deltaLayer: string): Promise<Map<string, Uint8Array>> => {
    const indexes = new Map<string, Uint8Array>();

    for (const file of manifest.files) {
      if (file.kind !== 'chunked' || indexes.has(file.over.index)) continue;
      const result = await ports.exec(`# devbox-index-v2\nbase64 ${shellPath(`${deltaLayer}/.devbox-delta/${file.over.index}`)}`);

      if (result.exitCode !== 0) throw new Error(`delta index could not be read: ${result.stderr}`);
      const bytes = Buffer.from(result.stdout.trim(), 'base64');
      readDeltaIndex(file.over, file.s, bytes);
      indexes.set(file.over.index, bytes);
    }

    return indexes;
  };

  /** An unobserved earlier reading counts as the same container: it has no baseline to differ from. */
  const containerReplaced = (pinned: string | undefined, observed: string | undefined): boolean =>
    pinned !== undefined && observed !== pinned;

  const attachChainOnce = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    const containerGeneration = await ports.containerGeneration?.();
    // A chain whose layers EXIST cannot be served by extraction,
    // so a mount failure fails the start.
    let standing: string | undefined;

    try {
      standing = await mountStoreOnce();
    } catch (error) {
      throw new Error(
        `chain ${generation.base.id} is stored as lazy layers and its store subtree could not `
        + `be mounted here: ${describe({ cause: error })}`,
        { cause: error },
      );
    }

    const mountedGeneration = await ports.containerGeneration?.();

    if (containerReplaced(containerGeneration, mountedGeneration)) {
      throw new ContainerChangedDuringAttach();
    }

    /** An unmountable or unreadable layer fails this generation, unless the container was
     *  replaced underneath: then the attach fails and is retried on the replacement. */
    const layerFailed = async (
      layer: string,
      thrown: { readonly cause: unknown },
    ): Promise<never> => {
      const failedGeneration = await ports.containerGeneration?.();

      if (containerReplaced(mountedGeneration, failedGeneration)) {
        throw new ContainerChangedDuringAttach();
      }

      throw new LayerUnreadable(layer, generation.base.id, thrown);
    };

    const mountedBase = mountedLayerPath(CHAIN_STORE_MOUNT, root, baseObjectKey(root, generation.base.id));
    const visible = await shell.awaitLayer(mountedBase);

    if (!visible.ready) {
      if (containerReplaced(mountedGeneration, await ports.containerGeneration?.())) {
        throw new ContainerChangedDuringAttach();
      }

      throw new Error(
        `chain ${generation.base.id} store mount does not expose ${mountedBase} after `
        + `${LAYER_VISIBILITY_PROBES} probes; ${CHAIN_STORE_MOUNT} holds: `
        + `${visible.holds.length === 0 ? '(nothing)' : visible.holds}`,
      );
    }

    // The layer mounts from the stored object; a delta the record names was already adopted by
    // `serve`. A mounted negative may be cached or a stat error, never proof of absence.
    const storedDelta: ChainDeltaLayer | undefined = generation.delta ?? await ports.objectFacts(deltaObjectKey(root, generation.base.id));
    const deltaId = storedDelta?.id ?? generation.base.id;
    const deltaSource = mountedLayerPath(CHAIN_STORE_MOUNT, root, deltaObjectKey(root, deltaId));
    const blockToken = `${generation.base.id}:${deltaId}:${mountedGeneration ?? 'unobserved'}`;
    const haveDelta = storedDelta !== undefined;

    // The seed stamp names the delta and is written only by the commit archiving this upper;
    // a stamp beside a missing upper claims nothing. Only a match keeps the upper on attach.
    const held = storedDelta !== undefined
      && (await ports.readSeedStamp()) === seedStampOf(generation.base.id, storedDelta)
      && (await shell.pathExists(upperDir));

    const composing = haveDelta && !held;

    // A base an earlier attach on this container mounted from THIS archive is kept with its
    // store mount: a base is written once, so a Durable Object reset mid-attach re-mounts nothing.
    const baseHeld = standing !== undefined && findMount(standing, lowerBase)?.source === mountedBase;

    await shell.unmountPath(DEVBOX_WORKDIR);
    await shell.unmountPath(blockLower);

    if (!baseHeld) await shell.unmountPath(lowerBase);
    await shell.releaseDeltaLayers();
    // `CHAIN_STORE_MOUNT` is excluded: `rm -rf` on it exits non-zero and would destroy archives.
    // The upper is emptied before mounting, except when `held`: it holds this delta's changes.
    await shell.resetDirs([
      ...(baseHeld ? [] : [lowerBase]), lowerDeltaRoot, blockLower, ...(held ? [] : [upperDir]), workDir,
    ]);

    if (!baseHeld) {
      try {
        await shell.mountLayer(baseObjectKey(root, generation.base.id), lowerBase);
        ports.stamp('baseAttach');
      } catch (error) {
        await layerFailed('base', { cause: error });
      }
    }

    // Mount the delta before the overlay: a mounted overlay then proves the whole composition
    // landed, which the `already-attached` return relies on.
    const deltaLayer = deltaLayerMountPoint(generation.base.id);
    const lowerLayers = [lowerBase];
    let chunked = false;

    if (composing) {
      try {
        await shell.mountLayer(deltaObjectKey(root, deltaId), deltaLayer);
      } catch (error) {
        await layerFailed('delta', { cause: error });
      }

      // The mounted manifest decides the format. Chunked records use the
      // block server and tree lower; a legacy image is one whole lower.
      const manifest = await readSidecarManifest(deltaLayer, generation, layerFailed);

      if (manifest === null) {
        lowerLayers.unshift(deltaLayer);
      } else {
        try {
          await runOpsBatched('preparing delta namespace', buildDeltaAttachOps(manifest, upperDir));
          await shell.mountBlockLower(blockToken, deltaLayer, mountedBase,
            deltaSource);
          lowerLayers.unshift(blockLower, `${deltaLayer}/${DELTA_TREE_DIR}`);
          chunked = true;
        } catch (error) {
          await layerFailed('delta', { cause: error });
        }
      }
    }

    // fuse-overlayfs resolves `lowerdir` left to right, so a delta precedes the base: it holds
    // the newer version of every path it names and the whiteouts hiding base entries.
    await shell.overlayAttach(DEVBOX_WORKDIR, lowerLayers);
    await assertOverlayLanded(`chain ${generation.base.id}`);

    const completedMounts = await shell.readMounts();

    if (chunked) {
      assertComposedMounts({ mounts: completedMounts, token: blockToken, baseSource: mountedBase, deltaSource, deltaLayer });
    }

    if (containerReplaced(mountedGeneration, await ports.containerGeneration?.())) throw new ContainerChangedDuringAttach();
    // The store mount stays: squashfuse reads each layer through it while the overlay serves
    // the work directory, so a release is refused EBUSY; publication writes through it too.

    const bytes = generation.base.bytes + (generation.delta?.bytes ?? 0);

    // Only a legacy layered delta requires collapse. A v2 publication merges
    // retained records with the cumulative upper and writes an immutable key.
    const restored = restoredFrom(haveDelta, held, chunked);

    ports.log(
      `${DEVBOX_WORKDIR} attached from ${generation.base.id} `
      + `(chain, ${bytes} bytes, ${restored})`,
    );

    return {
      kind: 'attached',
      detail: `chain ${generation.base.id} ${bytes}B ${restored}`,
    };
  };

  const assertComposedMounts = ({ mounts, token, baseSource, deltaSource, deltaLayer }: ComposedMounts): void => {
    const block = findMount(mounts, blockLower);
    const base = findMount(mounts, lowerBase);
    const delta = findMount(mounts, deltaLayer);
    ports.log(JSON.stringify({ event: 'devbox.attach.composition', token, blockType: block?.fstype,
      blockSourceMatches: block?.source === `devbox-block:${token}`, storeMounted: findMount(mounts, CHAIN_STORE_MOUNT) !== undefined,
      baseSourceMatches: base?.source === baseSource, baseType: base?.fstype,
      deltaSourceMatches: delta?.source === deltaSource, deltaType: delta?.fstype }));

    // The block mount reports plain `fuse` (D11); the exact source token fences all three identities.
    if (block?.source !== `devbox-block:${token}` || block.fstype !== 'fuse'
      || findMount(mounts, CHAIN_STORE_MOUNT) === undefined
      || base?.source !== baseSource || !base.fstype.includes('squashfuse')
      || delta?.source !== deltaSource || !delta.fstype.includes('squashfuse')) {
      throw new Error('composed lower mounts or generation do not match; readiness refused');
    }
  };

  const assertStandingComposition = async (mounts: string, state: ChainState | null): Promise<void> => {
    const block = findMount(mounts, blockLower);

    if (block === undefined) {
      if (state?.deltaFormat === 'chunked' && deltaLayerServed(mounts, state.base.id)) throw new Error('incomplete composed mounts; readiness refused');

      return;
    }

    const [prefix, baseId = '', deltaId = '', runtime] = block.source.split(':');

    if (prefix !== 'devbox-block' || !isChainId(baseId) || !isChainId(deltaId)
      || runtime !== ((await ports.containerGeneration?.()) ?? 'unobserved')) throw new Error('composed mount generation mismatch');
    assertComposedMounts({
      mounts,
      token: `${baseId}:${deltaId}:${runtime}`,
      baseSource: mountedLayerPath(CHAIN_STORE_MOUNT, root, baseObjectKey(root, baseId)),
      deltaSource: mountedLayerPath(CHAIN_STORE_MOUNT, root, deltaObjectKey(root, deltaId)),
      deltaLayer: deltaLayerMountPoint(baseId),
    });
  };

  const attachChain = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    for (;;) {
      try {
        return await attachChainOnce(generation);
      } catch (error) {
        if (!(error instanceof ContainerChangedDuringAttach)) throw error;
        ports.log(
          `container changed while chain ${generation.base.id} attached; `
          + 'retrying on its replacement',
        );
      }
    }
  };

  /** A box with no chain still gets an overlay over an empty lower, so chain mode with a plain
   *  `/workspace` is unrepresentable; a host without fuse-overlayfs stays plain until checkpoint. */
  const attachFresh = async (): Promise<AttachOutcome> => {
    await shell.resetDirs([lowerEmpty, upperDir, workDir]);

    try {
      await shell.overlayAttach(DEVBOX_WORKDIR, [lowerEmpty]);
      await assertOverlayLanded('a fresh box');
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} stays a plain directory: this host cannot attach an overlay `
        + `(${describe({ cause: error })}). The first checkpoint decides the mode.`,
      );

      return { kind: 'empty', detail: 'no chain recorded' };
    }

    return { kind: 'empty', detail: 'no chain recorded; an empty overlay is attached' };
  };

  /** A successful attach call is not a landed mount: /proc/mounts answers for the overlay,
   *  an existence probe for the upper directory. */
  const assertOverlayLanded = async (what: string): Promise<void> => {
    if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} reported success, but ${DEVBOX_WORKDIR} `
        + 'is not an overlay mount.',
      );
    }

    if (!(await shell.pathExists(upperDir))) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for ${what} produced an overlay whose upper directory `
        + `${upperDir} does not exist, so nothing the caller writes could be checkpointed.`,
      );
    }
  };

  /** A refusal concerns only THIS generation; other failures throw, since retrying an older
   *  generation on a broken host fails twice and hides why. Probe+mount is no content digest. */
  const serve = async (
    mode: ChainMode,
    offered: ChainGeneration,
  ): Promise<{ served: AttachOutcome; generation: ChainGeneration } | { refusal: string }> => {
    const sound = await probe(mode, offered);

    if (sound.refusal !== null) return { refusal: sound.refusal };
    // A size mismatch is the crash-window delta: adopt the stored size and digest.
    // Same size with a different digest never reaches here; `probe` refuses it as corruption.
    let generation = offered;

    if (offered.delta !== undefined && sound.delta !== undefined
      && sound.delta.bytes !== offered.delta.bytes) {
      const drift = sound.delta.bytes - offered.delta.bytes;
      ports.log(
        `delta record was stale by ${drift} bytes (${Math.abs(drift) / 4096} squashfs blocks); `
        + `adopting the stored archive of ${sound.delta.bytes} bytes`,
      );
      generation = { ...offered, delta: sound.delta };
    }

    try {
      const served = mode === 'chain'
        ? await attachChain(generation)
        : await attachExtract(generation);

      return { served, generation };
    } catch (error) {
      if (!(error instanceof LayerUnreadable)) throw error;

      return { refusal: describe({ cause: error }) };
    }
  };

  /** Best effort: the workspace is already mounted, so a failed write must not fail the start;
   *  the fallback ids stay named, so the next attach repeats the write. */
  const recordProven = async (record: ChainState, served: ChainGeneration): Promise<void> => {
    const adopted = served.delta?.bytes !== record.delta?.bytes
      || served.delta?.digest !== record.delta?.digest;

    if (record.fallback === undefined && !adopted) return;

    try {
      await ports.writeState({
        ...record,
        ...served,
        fallback: undefined,
        orphans: record.fallback === undefined
          ? record.orphans
          : [...(record.orphans ?? []), record.fallback.base.id],
      }, record.rev);
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} is attached from generation ${served.base.id} and the record could `
        + `not be updated to say so, so the next attach repeats it: `
        + `${describe({ cause: error })}`,
      );
    }
  };

  /** Promote the fallback in one state write before serving it: serving first lets a crash
   *  leave a record naming the refused generation. If both refuse, nothing is deleted. */
  const attachStored = async (state: ChainState): Promise<AttachOutcome> => {
    // The persisted mode is the contract: an `extract` record on a deployed box means a silent
    // fallback, and serving it would hide that twice.
    if (state.mode === 'extract' && !ports.allowExtraction()) {
      throw new Error(
        `chain ${state.base.id} was archived by extraction, which is not permitted here. `
        + 'That record can only have come from a host that allowed it, so this box is '
        + 'refusing rather than serving a work directory whose changes are never archived.',
      );
    }

    const current = await serve(state.mode, state);

    if ('served' in current) {
      await recordProven(state, current.generation);

      return current.served;
    }

    if (state.fallback === undefined) {
      throw new Error(
        `Cannot attach ${DEVBOX_WORKDIR} from chain ${state.base.id}: ${current.refusal}. The `
        + 'record names no earlier generation to fall back to, so this box is refusing to '
        + 'start rather than serve an empty work directory. Nothing has been deleted.',
      );
    }

    const reason = `chain ${state.base.id} was refused at attach: ${current.refusal}`;

    const promoted: ChainState = {
      ...state,
      ...state.fallback,
      rev: state.rev + 1,
      // The mark described another generation's changed set. An undefined
      // mark never matches, so the next tick archives rather than skips.
      upperMark: undefined,
      fallback: { base: state.base, delta: state.delta, deltaFormat: state.deltaFormat, deltaFallback: state.deltaFallback },
      lastFailure: { at: ports.now(), reason },
    };

    ports.log(`${DEVBOX_WORKDIR} ${reason}; falling back to generation ${promoted.base.id}`);
    await ports.writeState(promoted, state.rev);
    const fallback = await serve(promoted.mode, promoted);

    if (!('served' in fallback)) {
      throw new Error(
        `Cannot attach ${DEVBOX_WORKDIR}: ${reason}, and the fallback generation `
        + `${promoted.base.id} cannot be served either: ${fallback.refusal}. Refusing to `
        + 'start, and deleting neither generation.',
      );
    }

    await recordProven(promoted, fallback.generation);
    ports.log(
      `${DEVBOX_WORKDIR} recovered from generation ${promoted.base.id}; `
      + `${state.base.id} is superseded and kept for cleanup`,
    );

    return {
      kind: fallback.served.kind,
      detail: `recovered ${fallback.served.detail}`,
    };
  };

  const attach = async (): Promise<AttachOutcome> => {
    const state = await ports.readState();

    // Idempotence reads /proc/mounts, not a stored marker: the start hook fires at least once.
    // A standing overlay may serve a superseded generation; the fallback stays until attach.
    const mounts = await shell.readMounts();

    if (isOverlayMounted(mounts, DEVBOX_WORKDIR)) {
      await assertStandingComposition(mounts, state);

      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);

      return {
        kind: 'already-attached',
        detail: state === null ? 'no chain recorded' : `chain ${state.base.id}`,
      };
    }

    if (state === null) return await attachFresh();

    return await attachStored(state);
  };

  /** Publishes via the mount's egress host (D15) and returns what the store then holds.
   *  `tmpStaged` means the archive sits on tmpfs, returned whether or not the record is written. */
  const publishStagedArchive = async (
    key: string,
    staged: string,
    storeHeld: boolean,
    tmpStaged: boolean,
  ): Promise<ChainLayer> => {
    // The mount is required though no byte goes through s3fs: its registration routes
    // `r2.internal` to the bucket, and it serves the layers' reads for the container's life.
    if (!storeHeld) await mountStoreOnce();
    const objectUrl = ports.storeObjectUrl(key);
    const published = await shell.publishArchive(staged, objectUrl);
    const landed = await ports.objectFacts(key);

    if (tmpStaged) {
      try {
        const removed = await ports.exec(`rm -rf ${shellPath(tmpStageDir)}`);

        if (removed.exitCode !== 0) ports.log(`${tmpStageDir} could not be cleared after publishing ${key}: ${removed.stderr.trim()}`);
      } catch (error) {
        ports.log(`${tmpStageDir} could not be cleared after publishing ${key}: ${describe({ cause: error })}`);
      }
    }

    if (landed === undefined) {
      throw new Error(
        `the container published ${key} to ${objectUrl} and the store holds no `
        + 'such object, so nothing has been recorded.',
      );
    }

    if (landed.bytes !== published) {
      throw new Error(
        `the store holds ${landed.bytes} bytes for ${key} where the container uploaded `
        + `${published}. Refusing to record a layer whose upload did not carry every byte.`,
      );
    }

    return landed;
  };

  /** Bytes never reach this isolate: the container stages the archive and PUTs it via egress.
   *  Record what the store holds, checked against the container's re-read, not the staged count. */
  const stageAndPut = async (
    key: string,
    sourceDir: string,
    excludes: readonly string[],
    /** The store mount is already held by this checkpoint; the SDK refuses a second mount
     *  at one path (see {@link mountStoreOnce}). */
    storeHeld = false,
  ): Promise<ChainLayer> => {
    const archivePath = `${stageDir}/layer.sqsh`;
    // Check room before archiving: a full disk kills the box mid-checkpoint; short disks stage in tmpfs.
    // Staging stays on a filesystem because mksquashfs seeks back to its superblock at the end.
    const short = await shell.stagingShortfall(sourceDir, excludes);
    const staged = short === null ? archivePath : `${tmpStageDir}/layer.sqsh`;

    if (short !== null) ports.log(`${short} Staging ${sourceDir} in memory at ${tmpStageDir} instead.`);
    await shell.makeSquashfs(sourceDir, staged, excludes);

    return await publishStagedArchive(key, staged, storeHeld, short !== null);
  };

  /** Batches of {@link DELTA_OPS_PER_COMMAND} keep round trips per checkpoint far below one per file;
   *  each batch repeats the `# devbox-…` header and runs under a scoped `set -e` (D18). */
  const runOpsBatched = async (doing: string, [header = '', ...ops]: readonly string[]): Promise<void> => {
    for (let at = 0; at < ops.length; at += DELTA_OPS_PER_COMMAND) {
      const result = await ports.exec(opsBatchCommand(header, ops.slice(at, at + DELTA_OPS_PER_COMMAND)));

      if (result.exitCode !== 0) {
        throw new Error(`${doing} failed in batch ${at / DELTA_OPS_PER_COMMAND + 1} (${result.exitCode}): ${result.stderr || result.stdout}`);
      }
    }
  };

  /** A retained chunked delta refuses whole-upper fallback: the upper alone no longer holds its data.
   *  The package is one squashfs, so each checkpoint publishes exactly one object (D4). */
  const stageChunkedDelta = async (chainId: string, deltaId: string, storeHeld: boolean, retained?: DeltaManifest): Promise<DeltaPublication> => {
    const fallback = (reason: DeltaFallback['reason'], detail: string) => {
      if (retained !== undefined) throw new Error(`refusing to lose the retained delta: ${reason}: ${detail}`);
      ports.log(JSON.stringify({ event: 'devbox.checkpoint.delta.fallback', chainId, deltaId, reason, detail }));

      return { kind: 'whole-upper', fallback: { reason, detail } } satisfies DeltaPublication;
    };

    const excludes: string[] = [];

    for (const pattern of ports.archiveExcludes()) {
      const normalized = normalizeArchiveExclude(pattern);

      if (normalized !== null) excludes.push(normalized);
    }

    let upperProbe: DeltaProbeEntry[];
    const observed = await ports.exec(deltaProbeCommand(upperDir, excludes));

    try {
      upperProbe = parseDeltaProbe(observed.stdout);
    } catch (error) {
      if (error instanceof DeltaNamespaceProbeFailed) throw new Error(`${error.message}: ${observed.stderr}`, { cause: error });

      return fallback('upper-probe-failed', `the upper probe did not answer: ${describe({ cause: error })}`);
    }

    if (upperProbe.length === 0) return fallback('upper-empty', 'the probe listed nothing');
    // The package and hash scratch are bounded by the upper's own bytes, so a disk short of
    // those stages in tmpfs, as the whole-tree archive does.
    const short = await shell.stagingShortfall(upperDir, ports.archiveExcludes());
    const stageRoot = short === null ? stageDir : tmpStageDir;

    if (short !== null) ports.log(`${short} Staging the chunked delta in memory at ${tmpStageDir} instead.`);
    // A `c` entry is a whiteout only when it is the 0/0 device fuse-overlayfs
    // mints; any other device travels whole.
    const devices = upperProbe.filter((entry) => entry.type === 'c').map((entry) => entry.path);
    const whiteouts = new Set<string>();

    if (devices.length > 0) {
      const statted = await ports.exec(['# devbox-whiteout-v1', ...devices.map((path) =>
        `stat -c '%t,%T' ${shellPath(`${upperDir}/${path}`)} 2>/dev/null || printf 'x\\n'`)].join('\n'));

      const lines = statted.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('#'));

      if (lines.length !== devices.length) return fallback('whiteout-probe-failed', 'the whiteout probe answered short');

      for (const [at, path] of devices.entries()) if (lines[at] === '0,0') whiteouts.add(path);
    }

    const carried = upperProbe.filter((entry) => entry.type !== 'd' && entry.type !== 'o' && !whiteouts.has(entry.path)).map((entry) => entry.path);
    let baseFacts = new Map<string, DeltaBaseFact | null>();

    if (carried.length > 0) {
      try {
        baseFacts = parseDeltaBaseStat((await ports.exec(deltaBaseStatCommand(carried, lowerBase))).stdout, carried);
      } catch (error) {
        return fallback('base-probe-failed', `the base probe did not answer: ${describe({ cause: error })}`);
      }
    }

    ports.log(JSON.stringify({ event: 'devbox.checkpoint.delta.base', chainId, deltaId, carried: carried.length,
      fileBases: [...baseFacts.values()].filter(fact => fact?.kind === 'file').length,
      absentBases: [...baseFacts.values()].filter(fact => fact === null).length }));

    let hashFiles = deltaHashCandidates(upperProbe);
    let hashes = new Map<number, DeltaFileHashes>();

    if (hashFiles.length > 0) {
      const sizes = new Map(upperProbe.map((entry) => [entry.path, entry.size] as const));

      const files = hashFiles.map((path, index) => {
        const fact = baseFacts.get(path);

        return { index, upperPath: `${upperDir}/${path}`, basePath: fact?.kind === 'file' ? `${lowerBase}/${path}` : null };
      });

      const wanted = new Map(hashFiles.map((path, index) => {
        const fact = baseFacts.get(path);

        return [index, {
          upperBlocks: Math.ceil((sizes.get(path) ?? 0) / DELTA_BLOCK_BYTES),
          baseBlocks: fact?.kind === 'file' ? Math.ceil(fact.size / DELTA_BLOCK_BYTES) : null,
        }] as const;
      }));

      const hashed = await ports.exec(deltaBlockHashCommand({ workDir: `${stageRoot}/hash`, files }));

      try {
        hashes = parseDeltaBlockHashes(hashed.stdout, wanted);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'NOSPLIT') {
          return fallback('block-hash-failed', `the block hashes did not answer: ${describe({ cause: error })}; exit ${hashed.exitCode}; ${hashed.stderr}`);
        }

        // No `split` on this host: big files travel whole, still one object.
        hashFiles = [];
      }
    }

    const upperPlan = planDeltaPublication({ probe: upperProbe, baseFacts, hashes, hashFiles, whiteouts });

    for (const [file, hashed] of hashes) {
      let matching = 0;

      for (const [block, digest] of hashed.upper) if (hashed.base?.get(block) === digest) matching += 1;
      ports.log(JSON.stringify({ event: 'devbox.checkpoint.delta.hashes', chainId, deltaId, file,
        upperBlocks: hashed.upper.size, baseBlocks: hashed.base?.size ?? 0, matchingBlocks: matching }));
    }

    const sideDir = deltaLayerMountPoint(chainId);

    const plan = retained === undefined ? upperPlan
      : mergeDeltaPublication(upperPlan, retained, await readSidecarIndexes(retained, sideDir), sideDir);

    const pkgDir = `${stageRoot}/pkg`;

    try {
      await runOpsBatched('staging the chunked delta', buildDeltaStageOps(plan, { upperDir, pkgDir }));
    } catch (error) {
      return fallback('stage-failed', `the stage did not complete: ${describe({ cause: error })}`);
    }

    try {
      return { kind: 'chunked', layer: await stageAndPut(deltaObjectKey(root, deltaId), pkgDir, [], storeHeld) };
    } finally {
      // The package lives in memory when the disk was short; it is released
      // whether or not the publication landed.
      if (short !== null) await ports.exec(`rm -rf ${shellPath(tmpStageDir)}`);
    }
  };

  const commitExtract = async (
    previous: ChainState | null,
    version: string,
  ): Promise<CheckpointOutcome> => {
    // LOCAL DEVELOPMENT ONLY: the SDK archives the whole tree.
    const backup = await ports.createExtractSnapshot(
      chainBackupOptions(true, ports.archiveExcludes()),
    );

    const stored = await ports.objectFacts(baseObjectKey(root, backup.id));

    if (stored === undefined || stored.bytes <= 0) {
      throw new Error(`archive ${backup.id} is not sound: the object is missing or empty`);
    }

    const storedBytes = stored.bytes;

    const committed: ChainState = {
      mode: 'extract',
      rev: (previous?.rev ?? 0) + 1,
      // The SDK wrote this archive, so its identity is what the store reports: multipart uploads
      // carry no digest, and an absent digest means unknown.
      base: { id: backup.id, ...stored },
      delta: undefined,
      at: ports.now(),
      changeVersion: version,
      upperMark: undefined,
      // The superseded archive is recorded before anything deletes it and kept as the fallback,
      // by the same policy as the chain path.
      ...(previous !== null && previous.base.id !== backup.id
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };

    await publish(previous, committed);
    ports.log(`${DEVBOX_WORKDIR} archived as ${backup.id} (${storedBytes} bytes, extract)`);

    return { kind: 'committed', reason: undefined, bytes: storedBytes, movedBytes: storedBytes };
  };

  /** The state row is the truth: ids are recorded before the delete and a crash leaves the rest
   *  for the next sweep; listing the chain root would also name live generations. */
  const sweepOrphans = async (state: ChainState): Promise<void> => {
    const orphans = state.orphans ?? [];
    const retained = new Set([state.delta?.id, state.fallback?.delta?.id]);
    const mounts = await shell.readMounts();
    const heldDeltas: string[] = [];

    for (const id of state.retiredDeltas ?? []) {
      const key = deltaObjectKey(root, id);
      const source = mountedLayerPath(CHAIN_STORE_MOUNT, root, key);

      if (retained.has(id) || mounts.split('\n').some(line => line.split(' ')[0] === source)) heldDeltas.push(id);
      else await ports.deleteObjects([key]);
    }

    if (orphans.length === 0 && heldDeltas.length === (state.retiredDeltas?.length ?? 0)) return;

    for (const generation of orphans) {
      await ports.deleteObjects([
        baseObjectKey(root, generation),
        deltaObjectKey(root, generation),
        metadataObjectKey(root, generation),
      ]);
    }

    await ports.writeState({ ...state, orphans: undefined, retiredDeltas: heldDeltas }, state.rev);
    ports.log(`${orphans.length} superseded generation(s) deleted`);
  };

  /** The fenced `writeState(committed)` is the commit and the only step that may throw;
   *  cleanup after it must not throw: failures stamp the published revision; next sweep finishes. */
  const publish = async (
    previous: ChainState | null,
    committed: ChainState,
    cleanup?: () => Promise<void>,
  ): Promise<void> => {
    await ports.writeState(committed, previous?.rev ?? null);
    let reason: string;

    try {
      await cleanup?.();
      await sweepOrphans(committed);

      return;
    } catch (error) {
      reason = `chain ${committed.base.id} rev ${committed.rev} is committed and its `
        + `cleanup is not: ${describe({ cause: error })}`;
    }

    ports.log(`${DEVBOX_WORKDIR} ${reason}`);
    await stampFailure(stamps, committed, reason);
  };

  /** Quiesce only, after the record is durable: seats the base as sole lower, clears the upper
   *  so later deltas skip base files; clearing a live upper races writers. Failure refuses (D10). */
  const reseatAfterFirstBase = async (chainId: string): Promise<void> => {
    const startedAt = Date.now();
    const cwd = await ports.exec('pwd');
    ports.log(JSON.stringify({ event: 'devbox.checkpoint.reseat.enter', chainId, cwd: cwd.stdout.trim(), at: startedAt }));

    try {
      await shell.unmountPath(DEVBOX_WORKDIR);
      await shell.unmountPath(blockLower);
      await shell.releaseDeltaLayers();
      await shell.resetDirs([lowerBase, lowerDeltaRoot, upperDir, workDir]);
      await shell.mountLayer(baseObjectKey(root, chainId), lowerBase);
      await shell.overlayAttach(DEVBOX_WORKDIR, [lowerBase]);
      await assertOverlayLanded(`chain ${chainId}`);
      ports.log(JSON.stringify({ event: 'devbox.checkpoint.reseat.exit', chainId, ms: Date.now() - startedAt }));
    } catch (error) {
      ports.log(JSON.stringify({ event: 'devbox.checkpoint.reseat.failed', chainId, ms: Date.now() - startedAt, reason: describe({ cause: error }) }));
      throw new Error(`${DEVBOX_WORKDIR} base ${chainId} is committed, but reseating it failed: ${describe({ cause: error })}`, { cause: error });
    }
  };

  /** A rebase archives the merged work directory as a base under a new generation id;
   *  the old generation is deleted only after the new record is durable. */
  const commitChain = async (
    previous: ChainState | null,
    version: string,
    { rebasing = false, upperMark, kind }: ChainCommitOptions = {},
  ): Promise<CheckpointOutcome> => {
    const first = previous === null;
    const fresh = first || rebasing;
    const chainId = fresh ? crypto.randomUUID() : previous.base.id;

    // A box attaches the way it was checkpointed, so an unmountable chain is unreadable forever;
    // prove the mode by performing the mount, not by asking whether the platform could.
    let storeHeld = false;

    if (first) {
      try {
        await mountStoreOnce();
        storeHeld = true;
      } catch (error) {
        if (!ports.allowExtraction()) {
          throw new Error(
            'this box cannot serve a lazy layer chain and extraction is not permitted here, '
            + `so nothing has been archived: ${describe({ cause: error })}`,
            { cause: error },
          );
        }

        ports.log(
          'extraction is permitted and the lazy layer chain could not be served, so this '
          + `box archives whole trees from here: ${describe({ cause: error })}`,
        );

        return await commitExtract(previous, version);
      }
    }

    await shell.resetDirs([stageDir]);
    let layer: ChainLayer;
    const deltaId = fresh ? undefined : crypto.randomUUID();
    let deltaFormat: 'chunked' | undefined;
    let deltaFallback: DeltaFallback | undefined;

    if (fresh) {
      layer = await stageAndPut(
        baseObjectKey(root, chainId), DEVBOX_WORKDIR, ports.archiveExcludes(), storeHeld,
      );
    } else {
      // The mount line proves an overlay exists, so a changed set exists at all; the upper is
      // the path this strategy passed ({@link isOverlayMounted}).
      if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
        throw new Error(
          `${DEVBOX_WORKDIR} is not an overlay mount, so there is no changed set to archive. `
          + 'Refusing to checkpoint rather than silently archiving the whole tree.',
        );
      }

      // Delta and base share `archiveExcludes()` so `shouldRebase` compares commensurable sizes;
      // chunked first, else the whole upper (`stageChunkedDelta` returns the format decision).
      const mounted = deltaLayerServed(await shell.readMounts(), chainId);

      const retained = mounted && previous.deltaFormat === 'chunked'
        ? await readSidecarManifest(deltaLayerMountPoint(chainId), previous, async (_layer, thrown) => {
          throw new Error('retained delta is unreadable', thrown);
        }) : null;

      if (deltaId === undefined) throw new Error('delta publication has no identity');
      const chunked = await stageChunkedDelta(chainId, deltaId, storeHeld, retained ?? undefined);

      if (chunked.kind === 'chunked') {
        deltaFormat = 'chunked';
        layer = chunked.layer;
      } else {
        deltaFallback = chunked.fallback;
        layer = await stageAndPut(deltaObjectKey(root, deltaId), upperDir, ports.archiveExcludes(), storeHeld);
      }
    }

    // State first, cleanup second (header, "Ordering under crash"): a crash
    // leaves two generations and never zero.
    const committed: ChainState = {
      mode: 'chain',
      rev: (previous?.rev ?? 0) + 1,
      base: fresh ? { id: chainId, ...layer } : previous.base,
      delta: fresh ? undefined : { ...layer, id: deltaId },
      retiredDeltas: retirementAfter(previous),
      deltaFormat: fresh ? undefined : deltaFormat,
      deltaFallback,
      at: ports.now(),
      changeVersion: version,
      upperMark,
      // A rebase supersedes a generation; a delta commit stays inside its generation and
      // moves neither role.
      ...(rebasing && previous !== null
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };

    await publish(previous, committed, async () => {
      await ports.exec(`rm -rf ${shellPath(stageDir)}`);
    });
    ports.log(JSON.stringify({ event: 'devbox.checkpoint.published', chainId, deltaId, deltaFormat, deltaFallback }));

    // The upper now equals the just-published delta; the stamp tells the next attach so.
    // A base or rebase stamps nothing: no delta object, and the next attach resets the upper.
    if (!fresh && committed.delta !== undefined && !deltaLayerServed(await shell.readMounts(), chainId)) {
      await stampSeededUpper(chainId, committed.delta);
    }

    // Reseat a first base as the lower with an empty upper, or the next delta re-carries it.
    // Quiesce only: a rebase keeps its layers until the next wake proves them.
    if (first && kind === 'quiesce') {
      await reseatAfterFirstBase(chainId);
    }

    ports.log(
      `${DEVBOX_WORKDIR} ${commitWord(rebasing, first)} ${chainId} `
      + `(${layer.bytes} bytes)`,
    );

    return {
      kind: 'committed',
      reason: undefined,
      bytes: committed.base.bytes + (committed.delta?.bytes ?? 0),
      // This commit's own upload. Not derivable from `bytes`: a rebase
      // supersedes a generation, so held bytes can fall while this rises.
      movedBytes: layer.bytes,
    };
  };

  /** When the fence refused the commit, another writer advanced the record,
   *  so the failure stamp goes on the freshly read record, not the stale `state`. */
  const commitFailed = async (
    state: ChainState | null,
    thrown: { readonly cause: unknown },
  ): Promise<CheckpointOutcome> => await recordCheckpointFailure(
    stamps,
    thrown.cause instanceof ChainRecordAdvanced ? await ports.readState() : state,
    describe(thrown),
  );

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    const idle = { reason: undefined, bytes: undefined, movedBytes: 0 };

    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }

    const state = await ports.readState();

    // Attachment is checked before the change gate: without an overlay there is no changed set,
    // so a chain box must report failure rather than 'unchanged'.
    const procMounts = await shell.readMounts();
    const overlayMounted = isOverlayMounted(procMounts, DEVBOX_WORKDIR);

    if (state !== null && state.mode === 'chain' && !overlayMounted) {
      return await recordCheckpointFailure(
        stamps,
        state,
        `${DEVBOX_WORKDIR} is not an overlay mount, so chain ${state.base.id} has no changed `
        + 'set to archive. Refusing to report a checkpoint for a work directory that is not '
        + 'attached.',
      );
    }

    let change: ChangeStatus;
    let version: string;

    try {
      const checked = await ports.checkChanges(DEVBOX_WORKDIR, state?.changeVersion);
      change = checked.status;
      version = checked.version;
    } catch (error) {
      return await recordCheckpointFailure(stamps, state, `checkChanges failed: ${describe({ cause: error })}`);
    }

    // `checkChanges` with no `since` answers `unchanged` while establishing a baseline; skip on the
    // upper fingerprint instead, and an unreadable (empty) fingerprint never matches, so it commits.
    const mark = overlayMounted ? await shell.upperFingerprint() : '';

    if (overlayMounted) {
      // The layer's mount point names its generation, so `/proc/mounts` shows whether a delta
      // layer is served; this reuses the read the overlay gate above made.
      const layered = state !== null && deltaLayerServed(procMounts, state.base.id);

      if (mark !== '' && mark === state?.upperMark) {
        return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
      }

      // Every lower is already durable, and deletions (whiteouts) and metadata changes land in the
      // upper, so an empty upper proves nothing was written since the attach or the reseat.
      if ((await ports.countEntries(upperDir)) === 0) {
        return { kind: 'skipped', ...idle, reason: 'nothing has been written since the attach' };
      }

      if (kind === 'tick'
        && !shouldCheckpoint('changed', state?.at ?? 0, ports.now(), ports.checkpointIntervalMs())) {
        return { kind: 'skipped', ...idle, reason: 'within the minimum checkpoint interval' };
      }

      try {
        // COLLAPSE RATHER THAN APPEND while a delta is served as a layer
        // (header, "What the composition costs").
        return await commitChain(state, version, {
          rebasing: (layered && state.deltaFormat !== 'chunked') || shouldRebase(state, kind),
          upperMark: mark,
          kind,
        });
      } catch (error) {
        return await commitFailed(state, { cause: error });
      }
    }

    const comparable = state?.changeVersion !== undefined;
    const effective: ChangeStatus = comparable ? change : 'changed';

    if (comparable && change === 'unchanged') {
      // A failed watermark write only logs: an unadvanced watermark over-reports change (safe),
      // while `failed` would make `Devbox.quiesce` refuse to stop the box.
      try {
        await ports.writeState({ ...state, changeVersion: version }, state.rev);
      } catch (error) {
        ports.log(
          `${DEVBOX_WORKDIR} is unchanged and its change watermark could not be advanced, so `
          + `the next check asks about a wider window: ${describe({ cause: error })}`,
        );
      }

      return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
    }

    if (!comparable && (await ports.countEntries(DEVBOX_WORKDIR)) === 0) {
      return { kind: 'skipped', ...idle, reason: 'work directory is empty' };
    }

    // The interval is an efficiency rule, so only a periodic tick obeys it. A
    // quiesce is the last chance these bytes have.
    if (kind === 'tick'
      && !shouldCheckpoint(effective, state?.at ?? 0, ports.now(), ports.checkpointIntervalMs())) {
      return { kind: 'skipped', ...idle, reason: 'within the minimum checkpoint interval' };
    }

    try {
      // A box attaches the way it was checkpointed, so the mode comes from
      // the record; commitChain decides it for a box with no record.
      if (state?.mode === 'extract') return await commitExtract(state, version);

      return await commitChain(state, version, { rebasing: shouldRebase(state, kind), kind });
    } catch (error) {
      return await commitFailed(state, { cause: error });
    }
  };

  const discard = async (): Promise<void> => {
    const state = await ports.readState();

    if (state === null) return;
    // Objects before the pointer: reversed, a crash orphans both. Delete every generation the
    // record names (fallback and orphans too): `clearState` erases the only record naming them.
    await ports.deleteObjects([
      state.base.id,
      ...(state.fallback === undefined ? [] : [state.fallback.base.id]),
      ...(state.orphans ?? []),
    ].flatMap(
      (generation) => [
        baseObjectKey(root, generation),
        deltaObjectKey(root, generation),
        metadataObjectKey(root, generation),
      ],
    ));

    const deltas = [...new Set([state.delta?.id, state.fallback?.delta?.id, ...(state.retiredDeltas ?? [])])]
      .filter((id): id is string => id !== undefined).map(id => deltaObjectKey(root, id));

    if (deltas.length > 0) await ports.deleteObjects(deltas);
    await ports.clearState();
  };

  return { attach, checkpoint, discard };
}

function shellPaths(paths: readonly string[]): string {
  return paths.map(shellPath).join(' ');
}

/** One command: a spot container can be replaced between execs, so build and stat must share one.
 *  Patterns travel as base64 so none becomes shell syntax; `-ef` carries non-anchored lines. */
export function archiveCommand(input: {
  sourceDir: string;
  archivePath: string;
  excludeFile: string;
  excludes: readonly string[];
}): string {
  let bytes = '';

  for (const byte of new TextEncoder().encode(archiveExcludeFile(input.excludes))) {
    bytes += String.fromCharCode(byte);
  }

  const encoded = btoa(bytes);
  const parent = input.archivePath.slice(0, input.archivePath.lastIndexOf('/'));

  return `mkdir -p ${shellPath(parent)} && printf %s ${shellPath(encoded)} | base64 -d > ${shellPath(input.excludeFile)} `
    + `&& /usr/bin/mksquashfs ${shellPath(input.sourceDir)} ${shellPath(input.archivePath)} `
    + `-comp zstd -no-progress -wildcards -ef ${shellPath(input.excludeFile)} >/dev/null; `
    + `rc=$?; printf '%s %s' "$rc" `
    + `"$(stat -c %s ${shellPath(input.archivePath)} 2>/dev/null || echo 0)"`;
}

/** Publishes via the mount's egress host, not s3fs, which cannot PUT in one attempt (D15).
 *  The script's HEAD fails the command before the record names an unstored object. */
export function publishCommand(input: { archivePath: string; objectUrl: string }): string {
  const script = `${DEVBOX_RUNTIME_DIR}/devbox-publish.mjs`;

  return `mkdir -p ${shellPath(DEVBOX_RUNTIME_DIR)} && printf %s ${shellPath(PUBLISH_SCRIPT_B64)} | base64 -d > ${shellPath(script)}; `
    + `out=$(bun ${shellPath(script)} ${shellPath(input.archivePath)} ${shellPath(input.objectUrl)} ${String(PUBLISH_PART_BYTES)}); `
    + `rc=$?; printf '%s %s' "$rc" "$out"`;
}

// Must match the archive's excludes: the `*/` `-path` form covers every depth; `-prune` skips
// excluded trees. A failed walk prints 0 so a probe failure never refuses a checkpoint.
export function archiveSizeCommand(sourceDir: string, excludes: readonly string[]): string {
  const pruned: string[] = [];

  for (const pattern of excludes) {
    const normalized = normalizeArchiveExclude(pattern);

    if (normalized === null) continue;
    pruned.push(
      `-path ${shellPath(`${sourceDir}/${normalized}`)} -prune -o`,
      `-path ${shellPath(`${sourceDir}/*/${normalized}`)} -prune -o`,
    );
  }

  return `find ${shellPath(sourceDir)} ${pruned.join(' ')} -type f -printf '%s\\n' 2>/dev/null `
    + `| awk '{t+=$1} END {print t+0}'`;
}

/** Includes inode and ctime: a rewrite with restored mtime still moves ctime. O(entries).
 *  A failed walk yields no mark (undecidable); `pipefail` keeps `sort`/`sha256sum` from hiding it. */
export function upperFingerprintCommand(sourceDir: string): string {
  const walk = `find ${shellPath(sourceDir)} -mindepth 1 `
    + `-printf '%i\\0%y\\0%m\\0%s\\0%T@\\0%C@\\0%l\\0%p\\0' 2>/dev/null `
    + '| LC_ALL=C sort -z | sha256sum | cut -c1-64';

  return `bash -o pipefail -c ${shellPath(walk)}`;
}

