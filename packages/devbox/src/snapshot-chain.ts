/**
 * Strategy one: an immutable base plus one cumulative delta, both squashfs
 * archives in an object store, attached as lazy FUSE layers.
 *
 * THE SHAPE. The first checkpoint archives the whole work directory as the
 * BASE, written once. Every later checkpoint archives the overlay's upper
 * directory (the changed set, whiteouts included) into one DELTA object that
 * each checkpoint replaces atomically. The chain is at most two layers deep.
 *
 * AN ATTACH MOVES NO BYTES. The box's store subtree is mounted, `squashfuse`
 * mounts the base and the delta out of it, and `fuse-overlayfs` lays a fresh
 * upper over both: `lowerdir=<delta>:<base>`, newest first. Bytes arrive when
 * something reads them, so an attach of any size fits the container-start
 * budget. Copying the delta into the upper instead did not finish inside a
 * 300 s budget on the deployed benchmark at the size a ladder leaves behind.
 * A layer is equivalent: a delta's deletions travel as `0/0` character
 * devices and its emptied directories as an opaque xattr, and fuse-overlayfs
 * honours both in any layer.
 *
 * WHAT THE COMPOSITION COSTS. While a delta is served as a layer, the upper
 * holds only what was written since the attach, NOT the cumulative changed
 * set, so a delta commit may not archive it. The first commit with something
 * to say therefore COLLAPSES the chain onto a fresh base, an archive of the
 * merged view; the record then names no delta and delta commits resume.
 * Whether a delta is served as a layer is asked of `/proc/mounts`: the layer
 * is mounted at a path named after its generation.
 *
 * THE SAME-INSTANCE PATH is the cheapest one. A stop does not always take the
 * container with it. When the same instance comes back, its upper already
 * holds what the last publication archived, the seed stamp proves it, and the
 * attach mounts the base alone over the upper it kept.
 *
 * ORDERING UNDER CRASH. The delta is replaced by an atomic PUT, so a reader
 * sees the old delta or the new one. The state record is written BEFORE any
 * cleanup: a crash between the PUT and the state write leaves a complete
 * delta the record does not name yet, and an attach adopts it, because
 * squashfs verifies its own superblock and the mount is the validator.
 * Cleanup first could delete the only copy.
 *
 * TWO GENERATIONS, TWO ROLES. A box that holds one copy of itself refuses
 * every attach forever once that copy is missing or the wrong size. So the
 * record also names `fallback`: the newest generation an attach has PROVEN
 * it can serve, retained until a newer one passes the same proof. A restore
 * reads them newest first, verifies a candidate before serving it, stamps a
 * refused candidate on the record's failure field, and publishes which
 * generation recovered.
 *
 * EXTRACTION IS LOCAL DEVELOPMENT ONLY. A store mount needs container
 * outbound interception, which a plain local `wrangler dev` does not have, so
 * the local path archives and extracts whole trees: a full pass over every
 * byte on every attach. A chain that already HAS a base never degrades to
 * extraction, which would hand the caller an empty directory and call it a
 * success. Only a workspace with no base yet may fall back, once, with the
 * reason recorded.
 */

import type { BackupOptions, DirectoryBackup } from '@cloudflare/sandbox';
import * as v from 'valibot';

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

/**
 * Where this box's chain subtree is mounted inside the container: ONE mount,
 * one setting, held for the container's life. The SDK refuses one binding
 * mounted twice under different settings (`@cloudflare/sandbox`,
 * `dist/sandbox-CPj2jsbz.js:8058`; measured in runs e2e20260902032038 and
 * e2e20260902032318 as `R2 binding "BACKUP_BUCKET" is already mounted at
 * /backups with a different readOnly setting`), and squashfuse holds the
 * layer files under the attach's mount, so it cannot be released for a
 * writable one. The one mount is therefore writable, and the prefix is the
 * boundary. PRIVATE, like every path in this layout: the host is handed it as
 * an argument, and the suites that assert these paths fail on drift.
 */
const CHAIN_STORE_MOUNT = '/backups';

class ContainerChangedDuringAttach extends Error {
  constructor() {
    super('the container generation changed while snapshot-chain attached its lower layers');
    this.name = 'ContainerChangedDuringAttach';
  }
}

/** One of a generation's OWN archives would not mount, or would not read.
 *  TYPED, because the caller has a decision to make: the record may still
 *  name an older generation that can be served. Every other attach failure (a
 *  host with no FUSE, a store subtree that will not mount, a container
 *  replaced mid-attach) says nothing about a generation's bytes and must never
 *  cost the record a promotion. */
class LayerUnreadable extends Error {
  constructor(layer: string, generation: string, thrown: { readonly cause: unknown }) {
    super(`the ${layer} layer of generation ${generation} could not be read`, {
      cause: thrown.cause,
    });
    this.name = 'LayerUnreadable';
  }
}

/** Archive lifetime for the EXTRACTION path only: the SDK enforces it at
 *  restore time on archives its own backup API wrote. NEVER put a lifecycle
 *  rule on the chain's prefix: a rule deletes by age since upload, the base is
 *  written once, so an active box would lose its base on the rule's birthday.
 *  `discard` reclaims chain objects; a box whose Durable Object is destroyed
 *  without that call leaks them, and no sweep exists for that. */
export const EXTRACT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Regenerable trees never travel: they dominate the byte count, and every
 * byte is paid on upload and on every attach. LOCKFILES ARE NEVER EXCLUDED;
 * they are what makes the excluded trees regenerable, and the sandbox tool
 * doctrine tells the agent a restored workspace may need one `bun install`.
 *
 * `.git` IS NOT REGENERABLE: the only copy of every unpushed commit, plus the
 * index, config, hooks, reflog and refs, and for a linked worktree a FILE.
 * Measured: `mksquashfs -e '.git'` dropped both forms, so a restored tree had
 * the work and no history, and a worktree `git` no longer recognised.
 *
 * A box may replace this list through `SnapshotChainPorts.archiveExcludes`.
 * {@link archiveExcludeFile} states what a pattern matches.
 */
export const CHAIN_EXCLUDES = [
  'node_modules', '*.log', '.cache',
  '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist',
] as const;

/** One pattern, as mksquashfs and the SDK both read it, or null when it means
 *  nothing. This is the SDK's own normalisation (`@cloudflare/sandbox`
 *  `BackupService`), to the letter: a chain-mode archive that normalised
 *  differently would exclude a different set of files from the same policy. */
export function normalizeArchiveExclude(pattern: string): string | null {
  let normalized = pattern;
  while (normalized.startsWith('**/')) normalized = normalized.slice(3);
  while (normalized.includes('/**/')) normalized = normalized.replaceAll('/**/', '/');
  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3);
  if (normalized === '' || normalized === '**') return null;
  return normalized;
}

/** The exclude policy as an exclude FILE, TWO LINES PER PATTERN: mksquashfs
 *  anchors an exclude to the source directory unless the line is prefixed
 *  with `... `. Measured on the real archiver: anchored lines alone dropped
 *  `<source>/node_modules` and KEPT `<source>/sub/deep/node_modules`, and
 *  `*.log` matched nothing without `-wildcards`. Both lines plus `-wildcards`
 *  exclude every depth, as the SDK's own path does. {@link archiveCommand}
 *  carries the file into the container. */
export function archiveExcludeFile(patterns: readonly string[]): string {
  const lines: string[] = [];
  for (const pattern of patterns) {
    const normalized = normalizeArchiveExclude(pattern);
    if (normalized === null) continue;
    lines.push(normalized, `... ${normalized}`);
  }
  return lines.map(line => `${line}\n`).join('');
}

/** Rebase when the delta has outgrown the base by this factor. DERIVED, NOT
 *  MEASURED: a checkpoint uploads the WHOLE cumulative delta, so once it
 *  exceeds the base every checkpoint moves more bytes than a fresh base would
 *  cost. If a production measurement of delta growth disagrees, move this. */
export const REBASE_DELTA_RATIO = 1;

/** Should this checkpoint collapse the chain onto a fresh base? ONLY AT A
 *  QUIESCE: a rebase pays for itself only if the upper is then empty, and
 *  emptying a live upper races every writer in the container. At a quiesce
 *  there are no writers, and the next attach mounts the new base under a
 *  fresh upper anyway. A tick keeps appending however large the delta grows. */
export function shouldRebase(state: ChainState | null, kind: CheckpointKind): boolean {
  if (kind !== 'quiesce' || state === null || state.mode !== 'chain') return false;
  if (state.delta === undefined) return false;
  return state.delta.bytes > REBASE_DELTA_RATIO * state.base.bytes;
}

/**
 * The two generation roles after a publication supersedes the one the record
 * names. THE WHOLE RETENTION POLICY, and no number in it. An empty slot means
 * an attach has PROVEN the current generation ({@link ChainState.fallback}),
 * so the outgoing one is the newest proven and takes the slot. A full slot
 * means the outgoing generation was never proven: the proven occupant stays
 * and the outgoing one becomes an orphan, which loses no work, because the
 * superseding publication archived the same live work directory. The second
 * arm stops a run of publications with no restart between them from evicting
 * the only proven copy.
 */
export function supersedeGeneration(
  previous: ChainState,
): Pick<ChainState, 'fallback' | 'orphans'> {
  if (previous.fallback === undefined) {
    return {
      fallback: { base: previous.base, delta: previous.delta },
      orphans: previous.orphans,
    };
  }
  return {
    fallback: previous.fallback,
    orphans: [...(previous.orphans ?? []), previous.base.id],
  };
}

// ── identity and keys ───────────────────────────────────────────────────────

/** Every object key is built from a chain id, so anything that is not a UUID
 *  (`..`, a path separator, another box's guess) dies before it becomes a key. */
const CHAIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChainId(id: string): boolean {
  return CHAIN_ID_RE.test(id);
}

/** Validate a chain id or refuse the operation, naming the refusal. */
function assertChainId(id: string): string {
  if (!isChainId(id)) {
    throw new Error(
      `chain id ${JSON.stringify(id.slice(0, 64))} is not a UUID; refusing to build `
      + 'storage keys from it',
    );
  }
  return id;
}

/** Where THIS BOX's chains live. ONE MOUNT PER CONTAINER LIFE NEEDS ONE PREFIX
 *  PER BOX: the SDK admits a second mount of a binding only at the same prefix
 *  (`@cloudflare/sandbox`, `dist/sandbox-CPj2jsbz.js`, the r2-egress prefix
 *  check), and a prefix scoped to one GENERATION cannot survive a rebase,
 *  which mints a new generation while the old layers are still mounted as the
 *  live overlay's lowers. The box's own prefix absorbs every generation, and
 *  it is the convention every other strategy here uses (`boxes/<id>/…`). */
export function chainStoreRoot(boxPrefix: string): string {
  return `${boxPrefix}/backups`;
}

/** The immutable full base layer. */
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

// ── mount facts ─────────────────────────────────────────────────────────────

/** Is `dir` an overlay mount? MECHANISM, NOT OPTIONS: the production image
 *  attaches with `fuse-overlayfs`, which does NOT publish `lowerdir`,
 *  `upperdir` or `workdir` in `/proc/mounts` (kernel overlay does), and parsing
 *  them failed on a deployed container with "produced an overlay whose upper
 *  directory (unnamed) does not exist". So this asks only whether an
 *  overlay-family filesystem is mounted at `dir`; the upper is the path this
 *  strategy passed to the mount command, verified by an existence probe. */
export function isOverlayMounted(procMounts: string, dir: string): boolean {
  const line = findMount(procMounts, dir);
  return line !== undefined && line.fstype.includes('overlay');
}

// ── integrity ───────────────────────────────────────────────────────────────

/**
 * Why a stored layer must not be attached from, or null when it is sound.
 *
 * A SIZE IS NOT AN IDENTITY: two archives of one length pass every byte-count
 * check, and a valid squashfs of the wrong content mounts. So two identities
 * fail over for each other. `digest` is the SHA-256 of the stored bytes,
 * which the store confirms only for a single-request PUT it was handed a
 * checksum for. `objectVersion` is the store's OWN name for the upload: R2
 * mints one per upload, returns it from `put` and multipart `complete`, and
 * reports it from `head` forever after, so an archive the multipart API will
 * not checksum still has an identity, and a replacement written to look
 * identical is a different upload. Either may be absent on either side, and
 * absent means UNKNOWN: that comparison is skipped and the size check stands.
 */
export function layerIntegrityFailure(input: {
  /** What the record says this layer is, or undefined when it names none. */
  declared: ChainLayer | undefined;
  /** What the store answers for the object, or undefined when it holds none. */
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
  // THE DIGEST DECIDES WHEN BOTH SIDES HAVE ONE. A store version is minted per
  // UPLOAD, not per content: this chain can re-put byte-identical content (a
  // change under an excluded path moves the fingerprint while the archive
  // stays the same), and a crash that loses that commit's state write leaves
  // the record naming the old version. Refusing on version alone would burn
  // the fallback on a healthy object.
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

// ── the box's own chain record ──────────────────────────────────────────────

/** How a chain's bytes move. `chain` is the production lazy-mount path;
 *  `extract` is local development. Persisted: a box always attaches the way
 *  it was checkpointed. */
export type ChainMode = 'chain' | 'extract';

/** Mirrors the SDK's `CheckChangesResult.status`. `resync` means the retained
 *  change state was lost, so the directory counts as changed. */
export type ChangeStatus = 'unchanged' | 'changed' | 'resync';

/**
 * ONE LAYER, as the record declares it and as the store answers for it. One
 * type for both sides, so {@link layerIntegrityFailure} compares whole layers.
 *
 * `digest` and `objectVersion` mean UNKNOWN when absent, never "sound". A
 * record written before they existed carries neither, deployed boxes hold
 * such rows, and nothing backfills by re-reading an object: recovering a
 * digest means reading every byte back. Each delta commit records both; a
 * base's pair arrives with the next rebase.
 */
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

/** ONE GENERATION: the immutable base, and the cumulative changed set once one
 *  has landed. Both live under one `<box>/backups/<uuid>/` prefix, so a
 *  generation is either wholly referenced or wholly garbage. `ChainState` IS
 *  its current generation and `fallback` is the same shape, so promoting the
 *  fallback is a spread. */
export interface ChainGeneration {
  /** The full base. Immutable once written. */
  readonly base: ChainBaseLayer;
  /** The cumulative changed set, or undefined until the first delta lands. */
  readonly delta: ChainLayer | undefined;
}

/** Everything a box knows about its own chain. One record, one writer,
 *  replaced whole. */
export interface ChainState extends ChainGeneration {
  readonly mode: ChainMode;
  /** Monotonic revision. Every publication bumps it, and so does a restore
   *  that promotes the fallback. */
  readonly rev: number;
  /** Epoch ms the checkpoint completed. The interval gate reads this. */
  readonly at: number;
  /** The change version this checkpoint is relative to. Advanced when a
   *  checkpoint succeeds or the directory was reported unchanged. NEVER
   *  advanced after a change that was not archived: the next tick would
   *  believe it was already saved. */
  readonly changeVersion: string | undefined;
  /** The upper's fingerprint at the last successful commit; the skip gate
   *  compares against it. */
  readonly upperMark: string | undefined;
  /** The generation a restore falls back to, or undefined when the current one
   *  is proven. A publication that supersedes a generation fills the slot; the
   *  attach that PROVES the current generation moves the occupant to `orphans`
   *  and clears it ({@link supersedeGeneration}). Its sizes are here because
   *  a candidate the integrity probe cannot check is not a candidate. */
  readonly fallback: ChainGeneration | undefined;
  /** Generations this box has superseded and no longer retains. Named here
   *  BEFORE the delete and cleared after it, so a crash between a rebase's
   *  state flip and the deletion cannot orphan a generation nothing names. See
   *  `sweepOrphans` for why the ids are remembered rather than listed. */
  readonly orphans: readonly string[] | undefined;
  /** The last attempt that failed. The alarm loop reduces a thrown scheduled
   *  callback to a console line, so durable state is the only way a repeatedly
   *  failing checkpoint stays visible. A restore that refused a generation
   *  records it here too: nothing else would say what the box lost. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/** The stored record, as a schema. A durable row is untrusted input: a row this
 *  code did not write reads as ABSENT (a fresh box) rather than as a chain
 *  whose base cannot be found (a box that refuses to start forever). The
 *  generation's fields are spread in, so the schema and the types share one
 *  authority for a generation's shape. */
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
    bytes: v.number(),
    digest: DigestSchema,
    objectVersion: ObjectVersionSchema,
  })),
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
      bytes: row.delta.bytes,
      digest: row.delta.digest,
      objectVersion: row.delta.objectVersion,
    },
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
    lastFailure: row.lastFailure,
  };
}

/** Commit only when the directory changed AND the period elapsed. An
 *  unchanged tick costs no archive, no upload and no new object. */
export function shouldCheckpoint(
  change: ChangeStatus,
  lastCheckpointAt: number,
  now: number,
  minIntervalMs: number,
): boolean {
  if (change === 'unchanged') return false;
  return now - lastCheckpointAt >= minIntervalMs;
}

// ── ports ───────────────────────────────────────────────────────────────────

/** The record was advanced since this writer read it, so its write is refused. */
export class ChainRecordAdvanced extends Error {
  constructor(expectedRev: number | null, storedRev: number | null) {
    super(`another writer advanced the chain record to rev ${storedRev ?? 'none'} after this one read rev ${expectedRev ?? 'none'}`);
    this.name = 'ChainRecordAdvanced';
  }
}

/** Everything the strategy needs from the world. The adapter implements it and
 *  decides nothing: every entry maps to one public Sandbox SDK primitive, one
 *  object-store binding call, or the box's own durable storage. */
export interface SnapshotChainPorts {
  /** Is the container up right now? Waking a sleeping container to ask
   *  whether it changed would keep it alive forever. */
  containerRunning(): boolean;
  /** May this box archive and extract whole trees instead of mounting layers?
   *  DECLARED BY THE HOST, never discovered: a deployed box that quietly took
   *  extraction has a plain `/workspace`, no upper to capture, and loses every
   *  write after the base on the next restore. Measured on a deployed probe,
   *  where a failed mount was converted into extraction and the loss surfaced
   *  as "delta content lost across restore" two phases later. So a mount
   *  failure where extraction is not permitted is a FAILURE carrying the
   *  mount's own reason. */
  allowExtraction(): boolean;
  /** What a whole-tree base leaves behind, for THIS box. Defaults to
   *  {@link CHAIN_EXCLUDES}. */
  archiveExcludes(): readonly string[];
  readState(): Promise<ChainState | null>;
  /** Persist `state` while the stored record's `rev` is still `expectedRev`
   *  (`null`: no record), else throw {@link ChainRecordAdvanced}. Read,
   *  compare and put are ONE transaction, so two boots that read one record
   *  cannot both advance it. */
  writeState(state: ChainState, expectedRev: number | null): Promise<void>;
  clearState(): Promise<void>;
  /** Minimum gap between two commits, from the host's policy: one place
   *  decides the cadence for the schedule and this gate. */
  checkpointIntervalMs(): number;
  /** Has the work directory changed since `since`, per the container's own
   *  retained change state? */
  checkChanges(dir: string, since: string | undefined):
    Promise<{ status: ChangeStatus; version: string }>;
  /** Run one shell command container-side. THE ONLY CONTAINER-SHELL PORT: the
   *  mount flags, the squashfs options and the mount probes are this
   *  strategy's own vocabulary, so it builds every command itself. */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Ephemeral generation id, when the host can observe one. */
  containerGeneration?(): Promise<string | undefined>;
  /** This box's chain root in the store, see {@link chainStoreRoot}. A port
   *  because the box's identity is the host's. */
  storeRoot(): string;
  /** Mount THIS BOX's chain root at `at`, writable. ONE MOUNT, ONE SETTING, ONE
   *  PREFIX ({@link CHAIN_STORE_MOUNT}), so the host has no choice to make.
   *  CREDENTIALS NEVER LEAVE THE DURABLE OBJECT: the container's s3fs holds a
   *  dummy password file and a Worker entrypoint resolves its intercepted
   *  requests against the binding, so writable hands the container nothing it
   *  can read or replay. */
  mountStore(at: string): Promise<void>;
  /** Release the mount at `at` THROUGH THE SDK, not the kernel: a raw
   *  `fusermount3` leaves the SDK's registry claiming the path forever. Called
   *  only on a bare path, to drop the entry a replaced container's mount left
   *  (`mountStoreOnce`). A RELEASE IS NOT A FLUSH: a lazy unmount returns as
   *  the mount leaves the namespace, so `publishArchive` checks its own flush. */
  unmountStore(at: string): Promise<void>;
  /** What the store holds for one object, or undefined. `digest` and
   *  `objectVersion` are the store's OWN answers, either of which may be
   *  undefined ({@link layerIntegrityFailure}). One metadata read, and the only
   *  way a publication learns what landed: the container writes through a
   *  mount, so this side never sees the bytes. */
  objectFacts(key: string): Promise<ChainLayer | undefined>;
  /** Delete objects: discard, and the orphan sweep. */
  deleteObjects(keys: readonly string[]): Promise<void>;
  /** The seed stamp: which delta the upper on THIS container disk holds. Beside
   *  the upper, so no archive carries it, and on the container's own disk
   *  rather than in durable storage, because the fact it records dies with the
   *  disk: a replaced container has no stamp. */
  readSeedStamp(): Promise<string | undefined>;
  writeSeedStamp(stamp: string): Promise<void>;
  /** Entry count of the work directory. The extraction-mode postcondition. */
  countEntries(dir: string): Promise<number>;
  /** Extraction-mode attach, through the SDK's own local-store path. */
  restoreExtract(backup: DirectoryBackup): Promise<{ success: boolean }>;
  /** Extraction-mode checkpoint: the SDK archives a whole tree and moves it
   *  through the binding. LOCAL DEVELOPMENT ONLY. */
  createExtractSnapshot(options: BackupOptions): Promise<DirectoryBackup>;
  now(): number;
  log(message: string): void;
}

/** Canonical archive options for the extraction path. The TTL is HERE only:
 *  the SDK enforces it at restore time on archives its own backup API wrote.
 *  The excludes are the caller's, so a box that replaces the policy is obeyed
 *  in both modes, and they are passed RAW because the SDK normalises them
 *  exactly as {@link normalizeArchiveExclude} does. */
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

// ── the layout inside the container ─────────────────────────────────────────
//
// Module scope because the shell builds commands from these paths and the
// strategy reasons about them: no path spelled twice.

/** The overlay's writable upper: the whole changed set since the base. */
const upperDir = `${DEVBOX_RUNTIME_DIR}/upper`;
/** fuse-overlayfs's own scratch directory. Not readable as content. */
const workDir = `${DEVBOX_RUNTIME_DIR}/work`;
/** Where an archive is built before it is streamed into the store. */
const stageDir = `${DEVBOX_RUNTIME_DIR}/stage`;
/** Memory-backed staging for a checkpoint the disk cannot stage. tmpfs lives
 *  in memory rather than on the container disk, so an archive built here
 *  costs no disk quota. Used only when the disk gate refuses, never by
 *  default: memory is smaller than disk, and a large tree that fits on disk
 *  must not be forced through it. */
const tmpStageDir = `/dev/shm/devbox-stage`;
/** Mount point for the base layer: the overlay's bottom lower, mounted for
 *  as long as the overlay is. */
const lowerBase = `${DEVBOX_RUNTIME_DIR}/lower-base`;
/** Where delta layers are mounted, one directory per generation. */
const lowerDeltaRoot = `${DEVBOX_RUNTIME_DIR}/lower-delta`;
/** The lower a box with no chain yet attaches over: an empty directory, so
 *  that "chain mode" and "`/workspace` is a plain directory" can never both
 *  be true. See `attachFresh`. */
const lowerEmpty = `${DEVBOX_RUNTIME_DIR}/lower-empty`;

/** Where THIS generation's delta layer is mounted. NAMED AFTER THE GENERATION,
 *  because a later checkpoint reads the name to ask whether the changed set
 *  the record names is served as a layer. One fixed path could not tell that
 *  apart from a mount left by the generation a collapse superseded, and every
 *  commit afterwards would collapse again. */
function deltaLayerMountPoint(chainId: string): string {
  return `${lowerDeltaRoot}/${assertChainId(chainId)}`;
}

/** Where one generation's object appears under the store mount. The read
 *  path's `squashfuse` source and the write path's `dd` target are the same
 *  question, asked once so they cannot drift apart. */
function mountedLayerPath(mountPoint: string, root: string, objectKey: string): string {
  const relative = objectKey.startsWith(`${root}/`) ? objectKey.slice(root.length + 1) : objectKey;
  return `${mountPoint}/${relative}`;
}

/** Is `chainId`'s delta served as a layer under this container's overlay? True
 *  means the changed set is spread across the layer and the upper, so a commit
 *  must collapse rather than archive the upper (see the header). Asked of
 *  `/proc/mounts` because the mount is the fact, and a note about it can
 *  outlive the container that made it true. */
function deltaLayerServed(procMounts: string, chainId: string): boolean {
  return findMount(procMounts, deltaLayerMountPoint(chainId)) !== undefined;
}

/** How many times an attach asks the store mount for a layer it cannot see
 *  yet. A COUNT, NEVER A DEADLINE: the SDK proves the FUSE mount before
 *  returning, so only the store's first metadata answer for one key is
 *  outstanding, and that arrives promptly or comes from a negative cache.
 *  Neither improves by waiting against a budget that belongs to the whole
 *  restoration. */
const LAYER_VISIBILITY_PROBES = 20;

/** How many times a release is attempted before the mount is called stuck. A
 *  release either succeeds or is refused by something holding the mount, and
 *  more attempts do not fix a holder; an unbounded loop turned that into a
 *  hang with no diagnosis. */
const MOUNT_RELEASE_ATTEMPTS = 20;

// ── the container shell ─────────────────────────────────────────────────────
//
// Every command this strategy runs, in this file.

type ContainerExec = SnapshotChainPorts['exec'];

function chainShell(exec: ContainerExec, root: string) {
  /** Run a command and refuse on a non-zero exit. The container's own words
   *  are the diagnosis. */
  const must = async (doing: string, command: string): Promise<string> => {
    const result = await exec(command);
    if (result.exitCode !== 0) {
      throw new Error(`${doing} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };
  return {
    /** `/proc/mounts` as the container sees it. */
    readMounts: async (): Promise<string> => (await exec('cat /proc/mounts')).stdout,
    /** Does this container path exist? A mount line without a usable upper is
     *  a box whose writes have nowhere to land. */
    pathExists: async (path: string): Promise<boolean> =>
      (await exec(`test -e ${shellPath(path)} && echo yes || echo no`)).stdout.trim() === 'yes',
    /** Release a FUSE mount this strategy made itself, or say it is stuck.
     *
     *  The squashfuse layers only: the SDK has no registry entry for them, and
     *  releasing an SDK mount this way leaves its registry claiming the path.
     *  BOUNDED by {@link MOUNT_RELEASE_ATTEMPTS}: still mounted after the last
     *  attempt is a NAMED failure, because an attach that proceeds would mount
     *  on top of it. NOT ONE `exit`, see {@link awaitLayer}. */
    unmountPath: async (path: string): Promise<void> => {
      await must(`releasing the mount at ${path}`,
        `for _ in $(seq 1 ${String(MOUNT_RELEASE_ATTEMPTS)}); do `
          + `grep -qs ${shellPath(` ${path} `)} /proc/mounts || break; `
          + `/usr/bin/fusermount3 -u ${shellPath(path)} 2>/dev/null || true; sleep 0.1; done; `
          + `if grep -qs ${shellPath(` ${path} `)} /proc/mounts; then `
          + `echo "still mounted after ${String(MOUNT_RELEASE_ATTEMPTS)} release attempts" >&2; `
          + 'false; fi');
    },
    /** Release every delta layer this container still serves, whichever
     *  generation mounted it: a re-driven container can hold one this attach
     *  did not make. Deepest first. Reached only where `/workspace` is NOT an
     *  overlay, so nothing can still be reading them. EVERY stuck layer is
     *  named, not the first. */
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
    /**
     * Wait for one layer to become visible through the store mount, BY COUNT
     * ({@link LAYER_VISIBILITY_PROBES}), in ONE container command. Each probe
     * re-lists the subtree, because a listing repopulates a stat cache that
     * answered "no such object" once; when the layer never appears, the
     * answer is what the subtree DOES hold.
     *
     * IT MUST NEVER SAY `exit`. Every command runs in the SDK's PERSISTENT
     * shell session, and `exit 0` ended the shell: the attach died on its own
     * success as `SessionTerminatedError: Session 'sandbox-default' shell
     * exited (exit code: 0)`, 1,054 times in probe wakeprobe09010702.
     */
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
    /** Mount one squashfs layer read-only; squashfuse reads lazily THROUGH the
     *  store subtree. THE MOUNTPOINT IS CREATED IN THE SAME COMMAND: a spot
     *  container can be replaced between two RPCs (measured live at roughly
     *  once per phase under churn), and fuse refuses a mountpoint an earlier
     *  exec prepared with `bad mount point`. `nonempty` is safe because this
     *  private runtime directory is reset before every mount. */
    mountLayer: async (objectKey: string, mountPoint: string): Promise<void> => {
      await must('squashfuse mount', `mkdir -p ${shellPath(mountPoint)} && /usr/bin/squashfuse `
        + `${shellPath(mountedLayerPath(CHAIN_STORE_MOUNT, root, objectKey))} ${shellPath(mountPoint)} `
        + '-o allow_other,ro,nonempty');
    },
    /** Attach `lowers` (first entry is newest) with a fresh writable upper,
     *  created in the same command for the reason {@link mountLayer} states. */
    overlayAttach: async (dir: string, lowers: readonly string[]): Promise<void> => {
      await must('fuse-overlayfs attach', `mkdir -p ${shellPath(upperDir)} `
        + `${shellPath(workDir)} && /usr/bin/fuse-overlayfs `
        + `-o lowerdir=${lowers.map(shellPath).join(':')}`
        + `,upperdir=${shellPath(upperDir)},workdir=${shellPath(workDir)} ${shellPath(dir)}`);
    },
    /** Build a squashfs of `sourceDir` at `archivePath` and answer its size.
     *  {@link archiveCommand} states why build and measure are one command. */
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
    /** Move one staged archive into the store THROUGH THE MOUNT, and answer
     *  what the mount then holds. {@link publishCommand} states why the copy
     *  is a `dd` with `conv=fsync`. WRITTEN STRAIGHT TO THE FINAL NAME: a
     *  temporary name plus a rename is a server-side COPY of every byte on
     *  s3fs, and the object becomes visible only when s3fs completes the
     *  upload, so a reader never sees a partial. dd's transfer summary stays
     *  on stderr as this path's only throughput reading. */
    publishArchive: async (archivePath: string, mountedPath: string): Promise<number> => {
      const result = await exec(publishCommand({ archivePath, mountedPath }));
      const [code, size] = result.stdout.trim().split(/\s+/);
      if (code !== '0') {
        throw new Error(
          `publishing ${archivePath} through ${mountedPath} failed (${code ?? '?'}): `
          + `${result.stderr.trim() || 'no output'}`,
        );
      }
      const bytes = Number(size);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(
          `the store mount reports ${mountedPath} as ${size ?? 'absent'} after a publication `
          + `that reported success: ${result.stderr.trim() || 'no diagnostics'}`,
        );
      }
      return bytes;
    },
    /** Why there is not room to stage an archive of `sourceDir` on the disk, or
     *  null. THE ESTIMATE WALKS WHAT THE ARCHIVE WILL WALK: squashfs never
     *  exceeds its uncompressed input, and {@link archiveSizeCommand} and
     *  {@link archiveExcludeFile} come off one policy list. Both readings are
     *  in one command, so a container replacement cannot make them describe
     *  different disks. */
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
      if (free! >= need!) return null;
      return `staging ${sourceDir} needs up to ${need} bytes and ${stageDir} has ${free} free.`;
    },
    /** The skip-gate fingerprint of the upper, or empty when it cannot be
     *  taken. Walks metadata, not content: O(entries). The gate in
     *  `checkpoint` states why the SDK's change check is not the question. */
    upperFingerprint: async (): Promise<string> => {
      const measured = await exec(upperFingerprintCommand(upperDir));
      return measured.exitCode === 0 ? measured.stdout.trim() : '';
    },
    /** Byte length of a container file, or undefined when it does not exist. */
    statBytes: async (path: string): Promise<number | undefined> => {
      const raw = (await exec(`stat -c %s ${shellPath(path)} 2>/dev/null || echo ''`)).stdout.trim();
      return raw.length > 0 ? Number.parseInt(raw, 10) : undefined;
    },
    /** Reset a set of directories to empty. THROUGH must(): a reset that fails
     *  silently leaves the attach running against a stale tree. */
    resetDirs: async (paths: readonly string[]): Promise<void> => {
      await must('resetting directories',
        `rm -rf ${shellPaths(paths)} && mkdir -p ${shellPaths(paths)}`);
    },
  };
}

// ── the strategy ────────────────────────────────────────────────────────────

export function snapshotChainStorage(ports: SnapshotChainPorts): DevboxStorage {
  const shell = chainShell(ports.exec, ports.storeRoot());
  /** This box's chain root: every key below it, one mount over it. */
  const root = ports.storeRoot();
  /** The record's in-place writers: a stamp lands on the revision it read, or not at all. */
  const stamps: FailureStampDeps<ChainState> = {
    writeState: async (next) => await ports.writeState(next, next.rev),
    log: ports.log,
    now: ports.now,
  };

  /**
   * Why a stored generation must not be attached from, or null when sound.
   *
   * THE BASE AND THE DELTA ARE JUDGED DIFFERENTLY. A base is written ONCE, so
   * a size that disagrees is a different object: refuse. A delta is REPLACED
   * by an atomic PUT on every checkpoint, so a size that disagrees is the
   * crash-window delta the header describes: adopt it whole, size, digest and
   * version together. Measured across two deployed runs as `archive
   * 506834944, state declares 506494976` and twice more, each difference a
   * multiple of 4096 (the squashfs padding); refusing on it cost an arm
   * fourteen of its twenty segments. A delta the record names and the store
   * does NOT hold is content loss: refuse. A delta of EXACTLY the recorded
   * size whose digest or version differs is a different archive of the same
   * length: refuse, and the retained fallback makes that a recovery.
   */
  const probe = async (
    mode: ChainMode,
    generation: ChainGeneration,
  ): Promise<
    { refusal: string } | { refusal: null; delta: ChainLayer | undefined }
  > => {
    if (mode === 'extract') return { refusal: null, delta: undefined };
    const unsound = layerIntegrityFailure({
      declared: generation.base,
      stored: await ports.objectFacts(baseObjectKey(root, generation.base.id)),
      label: 'base',
    });
    if (unsound !== null) return { refusal: unsound };
    if (generation.delta === undefined) return { refusal: null, delta: undefined };
    const stored = await ports.objectFacts(deltaObjectKey(root, generation.base.id));
    if (stored === undefined) {
      return {
        refusal: `delta archive is missing from the store, but the record names one of `
          + `${generation.delta.bytes} bytes. Refusing rather than attaching a chain whose `
          + 'changed set is gone.',
      };
    }
    if (stored.bytes === generation.delta.bytes) {
      const corrupt = layerIntegrityFailure({
        declared: generation.delta,
        stored,
        label: 'delta',
      });
      if (corrupt !== null) return { refusal: corrupt };
    }
    return { refusal: null, delta: stored };
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

  /** The identity of the delta an upper holds: generation, size and the
   *  store's version of the object. All three are load-bearing: a generation
   *  alone matches after a rebase, a size alone matches a different archive of
   *  the same length, and only the version tells a replaced delta of identical
   *  size from its predecessor. THE DIGEST IS DELIBERATELY ABSENT: R2 reports
   *  no checksum for an archive written through the mount, so a stamp carrying
   *  one would never match. */
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

  /**
   * Take the chain's store mount, or adopt the one already standing. THE
   * CONTAINER IS THE AUTHORITY: the SDK's PATH registry refuses a second
   * mount at one path unconditionally (`activeMounts.has(mountPath)`,
   * `sandbox-CPj2jsbz.js:8369`; measured live as `Mount path "/backups" is
   * already in use by bucket "BACKUP_BUCKET"`, run e2e20260902060426), it
   * cannot be read, and it resets with the isolate, while `/proc/mounts` is
   * true across Durable Object resets. A bare-path unmount releases the entry a
   * replaced container's mount may have left — by the patched SDK
   * (patches/@cloudflare%2Fsandbox@0.12.8.patch), which checks `mountpoint -q`
   * before `fusermount -u`; unpatched, a failed fusermount rethrew with the
   * entry standing, and every attach after a container swap refused with
   * "already in use" (kinu.run, hardy-stone, 2026-09-03). Then mounts. Answers
   * the `/proc/mounts` it found the store standing in, or undefined after a new
   * mount.
   */
  const mountStoreOnce = async (): Promise<string | undefined> => {
    const mounts = await shell.readMounts();
    if (findMount(mounts, CHAIN_STORE_MOUNT) !== undefined) return mounts;
    await ports.unmountStore(CHAIN_STORE_MOUNT);
    await ports.mountStore(CHAIN_STORE_MOUNT);
    return undefined;
  };

  const attachChainOnce = async (generation: ChainGeneration): Promise<AttachOutcome> => {
    const containerGeneration = await ports.containerGeneration?.();
    // A chain whose layers EXIST cannot be served by extraction, so a mount
    // failure fails the start. The thrown reason travels as it came.
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
    if (containerGeneration !== undefined && mountedGeneration !== containerGeneration) {
      throw new ContainerChangedDuringAttach();
    }
    /** A layer that will not mount or read is THIS generation's failure,
     *  unless the container was replaced underneath: that is the attach's
     *  failure, retried on the replacement. */
    const layerFailed = async (
      layer: string,
      thrown: { readonly cause: unknown },
    ): Promise<never> => {
      const failedGeneration = await ports.containerGeneration?.();
      if (mountedGeneration !== undefined && failedGeneration !== mountedGeneration) {
        throw new ContainerChangedDuringAttach();
      }
      throw new LayerUnreadable(layer, generation.base.id, thrown);
    };
    const mountedBase = mountedLayerPath(CHAIN_STORE_MOUNT, root, baseObjectKey(root, generation.base.id));
    // Bounded, and a store subtree that never exposes the base says what it
    // holds instead: see {@link LAYER_VISIBILITY_PROBES}.
    const visible = await shell.awaitLayer(mountedBase);
    if (!visible.ready) {
      if ((await ports.containerGeneration?.()) !== mountedGeneration) {
        throw new ContainerChangedDuringAttach();
      }
      throw new Error(
        `chain ${generation.base.id} store mount does not expose ${mountedBase} after `
        + `${LAYER_VISIBILITY_PROBES} probes; ${CHAIN_STORE_MOUNT} holds: `
        + `${visible.holds.length === 0 ? '(nothing)' : visible.holds}`,
      );
    }
    // The delta as the STORE describes it, because the layer is mounted from
    // the stored object. An unreferenced but complete delta is adopted (header,
    // "Ordering under crash").
    const storedDelta = await ports.objectFacts(deltaObjectKey(root, generation.base.id));
    const haveDelta = generation.delta !== undefined || storedDelta !== undefined;

    // IS THIS UPPER ALREADY THIS DELTA? The stamp is written only by the
    // commit that archived this upper, and it names the delta object, so a
    // superseded delta never matches and a replaced container has no stamp.
    // The upper is asked for as well, because a stamp beside a missing upper
    // claims nothing. A match is the only way the upper survives an attach,
    // and the only shape in which the delta needs no layer of its own.
    const held = storedDelta !== undefined
      && (await ports.readSeedStamp()) === seedStampOf(generation.base.id, storedDelta)
      && (await shell.pathExists(upperDir));
    const composing = haveDelta && !held;

    // A base layer an earlier attach on this container mounted from THIS
    // archive is adopted with the store mount it reads through: a base is
    // written once, so a Durable Object reset mid-attach re-mounts nothing.
    const baseHeld = standing !== undefined && findMount(standing, lowerBase)?.source === mountedBase;

    await shell.unmountPath(DEVBOX_WORKDIR);
    if (!baseHeld) await shell.unmountPath(lowerBase);
    await shell.releaseDeltaLayers();
    // CHAIN_STORE_MOUNT is deliberately NOT here: `rm -rf` on it exits
    // non-zero, and a writable mount would lose the chain's archives through
    // it. THE UPPER IS EMPTIED before anything is mounted over it, so the
    // writable layer of a composed attach holds exactly what is written after
    // it, with ONE exception: an upper that holds this delta, which emptying
    // would throw away along with every change since the stamp.
    await shell.resetDirs([
      ...(baseHeld ? [] : [lowerBase]), lowerDeltaRoot, ...(held ? [] : [upperDir]), workDir,
    ]);
    if (!baseHeld) {
      try {
        await shell.mountLayer(baseObjectKey(root, generation.base.id), lowerBase);
      } catch (error) {
        await layerFailed('base', { cause: error });
      }
    }

    // The delta is mounted before the overlay, like the base: the overlay
    // takes its lowers as parameters, and a mounted overlay then proves the
    // whole composition landed, which the `already-attached` return relies on.
    const deltaLayer = deltaLayerMountPoint(generation.base.id);
    if (composing) {
      try {
        await shell.mountLayer(deltaObjectKey(root, generation.base.id), deltaLayer);
      } catch (error) {
        await layerFailed('delta', { cause: error });
      }
    }
    // NEWEST LOWER FIRST. fuse-overlayfs resolves `lowerdir` left to right, so
    // the delta precedes the base: it holds the newer version of every path it
    // names, and the whiteouts that hide what the base still has.
    await shell.overlayAttach(DEVBOX_WORKDIR, composing ? [deltaLayer, lowerBase] : [lowerBase]);
    await assertOverlayLanded(`chain ${generation.base.id}`);
    // THE STORE MOUNT STAYS: squashfuse reads each layer through it for as
    // long as the overlay serves the work directory, so a release here is
    // refused EBUSY. The publication writes through this same mount.

    const bytes = generation.base.bytes + (generation.delta?.bytes ?? 0);
    // The shape decides the next commit: `base+delta layered` means the first
    // commit with anything to say collapses the chain.
    const restored = !haveDelta
      ? 'base'
      : held ? 'base+delta already in this upper' : 'base+delta layered';
    ports.log(
      `${DEVBOX_WORKDIR} attached from ${generation.base.id} `
      + `(chain, ${bytes} bytes, ${restored})`,
    );
    return {
      kind: 'attached',
      detail: `chain ${generation.base.id} ${bytes}B ${restored}`,
    };
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

  /**
   * A box with no chain yet still gets an overlay, over an empty lower, so
   * chain mode with a plain `/workspace` is unrepresentable. A box born plain
   * whose first checkpoint wrote `mode:'chain'` hit the "not an overlay
   * mount" gate on every later checkpoint and quiesce, filed an incident
   * every interval, could not stop gracefully, and lost everything after the
   * base when the platform evicted the container. Born with the overlay, a
   * re-driven attach (a Durable Object can be evicted while its container
   * keeps running) also cannot mount the base OVER the caller's live tree.
   *
   * A host with no fuse-overlayfs (a plain local `wrangler dev`) says so by
   * failing; that is the host extraction exists for, so the box stays plain
   * and the first checkpoint decides its mode.
   */
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

  /** A successful call is not a landed mount: a live container once reported
   *  every attach step as fine while /proc/mounts held no overlay line. The
   *  mount line answers for the mount, an existence probe for the upper. */
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

  /** Serve one candidate generation, or answer why its own bytes cannot be
   *  served. A refusal is always about THIS generation ({@link LayerUnreadable});
   *  everything else travels as a throw, because trying an older generation
   *  against a broken host would fail twice and hide the reason. The probe and
   *  the mount are not a content digest: hashing every byte on every start is
   *  the cost this strategy exists to avoid. */
  const serve = async (
    mode: ChainMode,
    candidate: ChainGeneration,
  ): Promise<{ served: AttachOutcome; generation: ChainGeneration } | { refusal: string }> => {
    const sound = await probe(mode, candidate);
    if (sound.refusal !== null) return { refusal: sound.refusal };
    // ADOPT a delta whose recorded size went stale, digest included: a size
    // that disagrees is the crash-window delta. Same size with a different
    // digest never reaches here; `probe` refuses it as corruption.
    let generation = candidate;
    if (candidate.delta !== undefined && sound.delta !== undefined
      && sound.delta.bytes !== candidate.delta.bytes) {
      const drift = sound.delta.bytes - candidate.delta.bytes;
      ports.log(
        `delta record was stale by ${drift} bytes (${Math.abs(drift) / 4096} squashfs blocks); `
        + `adopting the stored archive of ${sound.delta.bytes} bytes`,
      );
      generation = { ...candidate, delta: sound.delta };
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

  /** The attach landed, so the generation the record names is PROVEN: the
   *  retained fallback becomes garbage, named before deleted, and the slot is
   *  cleared. One write, and only when there is something to write. BEST
   *  EFFORT: the workspace is mounted by the time this runs, so a failed write
   *  must not fail the start, and the ids are still named, so the next attach
   *  repeats it. */
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

  /**
   * Serve the newest generation this record can prove, and publish which one
   * it was. A refused generation is stamped on the record's failure field,
   * and the promotion is ONE state write that swaps the two roles. The
   * refused one takes the fallback slot rather than the bin: its objects have
   * exactly one name, and the sweep that removes it runs only after its
   * replacement is proven, the ordinary transition.
   *
   * PROMOTED BEFORE SERVED. Serving first leaves a window where a crash has
   * the box running on the fallback's bytes under a record that names the
   * refused generation, and the next checkpoint would write a delta into a
   * generation whose base is gone. When both refuse, the start fails carrying
   * both causes and NOTHING is deleted: two bad generations are two chances
   * for an operator.
   */
  const attachStored = async (state: ChainState): Promise<AttachOutcome> => {
    // THE PERSISTED MODE IS THE CONTRACT. A deployed box holding an extract
    // record took a silent fallback, and serving it would hide that twice.
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
      fallback: { base: state.base, delta: state.delta },
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

    // Idempotence without a marker: the container-start hook fires at least
    // once per start, and a stored "attached" marker is exactly what latched
    // last time. An overlay that landed is visible in /proc/mounts. It is NOT
    // a proof of the current generation: the overlay may serve the generation
    // a later rebase superseded, so the fallback stays until an attach mounts
    // what the record now names.
    if (isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);
      return {
        kind: 'already-attached',
        detail: state === null ? 'no chain recorded' : `chain ${state.base.id}`,
      };
    }
    if (state === null) return await attachFresh();
    return await attachStored(state);
  };

  /**
   * Build a squashfs of `sourceDir`, publish it as `key`, and return what the
   * store then holds for it.
   *
   * THE BYTES NEVER REACH THIS ISOLATE. The container stages the archive on
   * its own disk and copies it into the store through the writable mount.
   * Relaying it through this isolate (base64 SSE frames in, the R2 binding
   * out) measured 3.34 MiB/s at 64 MiB and 3.64 at 256 MiB on a live
   * container against a real store, against 23.22 and 39.00 MiB/s for the
   * same bytes moved by the container; the relay was the only arm that got
   * SLOWER as the archive grew.
   *
   * THE RECORD DESCRIBES WHAT THE STORE HOLDS, checked against the container's
   * reading of the same object after the flush: two independent measurements
   * of one upload, so a disagreement is a flush that lost bytes. The staged
   * count is NOT the comparison: it is taken before the copy, and a deployed
   * run recorded that drift as `delta archive is 702791680 bytes, state
   * declares 700387328`, after which every wake refused. NO CONTENT DIGEST
   * IS COMPUTED HERE: a `sha256sum` over the staged archive is a full CPU
   * pass over every byte of every checkpoint. The record carries the identity
   * the STORE has, which for a mount-written archive is its upload version.
   */
  const stageAndPut = async (
    key: string,
    sourceDir: string,
    excludes: readonly string[],
    /** The store mount is already held by THIS checkpoint (the first
     *  checkpoint's proof). The SDK's PATH registry refuses a second mount at
     *  one path, see {@link mountStoreOnce}. */
    storeHeld = false,
  ): Promise<ChainLayer> => {
    const archivePath = `${stageDir}/layer.sqsh`;
    // ROOM TO WRITE IT, ASKED BEFORE WRITING IT. An archiver that fills the
    // container's disk takes the box down mid-checkpoint. The requirement is
    // the tree's own worst case. A disk without that room stages in tmpfs,
    // which lives in memory and costs no disk quota, so a full disk keeps a
    // checkpoint rather than refusing it. The archive is staged on a
    // filesystem because mksquashfs seeks back to its superblock at the end,
    // which an object store's filesystem cannot do.
    const short = await shell.stagingShortfall(sourceDir, excludes);
    const staged = short === null ? archivePath : `${tmpStageDir}/layer.sqsh`;
    if (short !== null) ports.log(`${short} Staging ${sourceDir} in memory at ${tmpStageDir} instead.`);
    await shell.makeSquashfs(sourceDir, staged, excludes);
    if (!storeHeld) await mountStoreOnce();
    const published = await shell.publishArchive(staged, mountedLayerPath(CHAIN_STORE_MOUNT, root, key));
    const landed = await ports.objectFacts(key);
    if (short !== null) {
      // The archive is published; memory is returned whether or not the
      // record below is written. A failed removal is a console line, because
      // the layer is in the store and the record is what the caller owes.
      try {
        const removed = await ports.exec(`rm -rf ${shellPath(tmpStageDir)}`);
        if (removed.exitCode !== 0) ports.log(`${tmpStageDir} could not be cleared after publishing ${key}: ${removed.stderr.trim()}`);
      } catch (error) {
        ports.log(`${tmpStageDir} could not be cleared after publishing ${key}: ${describe({ cause: error })}`);
      }
    }
    if (landed === undefined) {
      throw new Error(
        `the container published ${key} through ${CHAIN_STORE_MOUNT} and the store holds no `
        + 'such object, so nothing has been recorded.',
      );
    }
    if (landed.bytes !== published) {
      throw new Error(
        `the store holds ${landed.bytes} bytes for ${key} where the container flushed `
        + `${published}. Refusing to record a layer whose upload did not carry every byte.`,
      );
    }
    return landed;
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
      // THE SDK WROTE THIS ARCHIVE, so its identity is whatever the store
      // reports: no digest when the SDK uploaded in parts, and absent means
      // unknown.
      base: { id: backup.id, ...stored },
      delta: undefined,
      at: ports.now(),
      changeVersion: version,
      upperMark: undefined,
      // The superseded archive is NAMED before anything deletes it, and
      // RETAINED as the fallback by the same policy the chain path uses.
      ...(previous !== null && previous.base.id !== backup.id
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };
    await publish(previous, committed);
    ports.log(`${DEVBOX_WORKDIR} archived as ${backup.id} (${storedBytes} bytes, extract)`);
    return { kind: 'committed', reason: undefined, bytes: storedBytes, movedBytes: storedBytes };
  };

  /** Delete every generation this box has superseded, then forget them. THE
   *  STATE ROW IS THE TRUTH: the ids were recorded before the delete, the
   *  referenced generation is never among them, and a crash mid-sweep leaves
   *  the remainder for the next run. A listing of the chain root would name
   *  the live generations too. */
  const sweepOrphans = async (state: ChainState): Promise<void> => {
    const orphans = state.orphans ?? [];
    if (orphans.length === 0) return;
    for (const generation of orphans) {
      await ports.deleteObjects([
        baseObjectKey(root, generation),
        deltaObjectKey(root, generation),
        metadataObjectKey(root, generation),
      ]);
    }
    await ports.writeState({ ...state, orphans: undefined }, state.rev);
    ports.log(`${orphans.length} superseded generation(s) deleted`);
  };

  /** Write the record, then delete everything the new record supersedes. THE
   *  POINTER IS THE COMMIT: the fenced `writeState(committed)` is the ONLY step
   *  that may throw, and the caller stamps that as a failure. Every step below
   *  it deletes bytes the committed record no longer names and NONE MAY THROW:
   *  after a rebase the pre-commit record names the generation the sweep began
   *  deleting, so a cleanup failure is stamped on the PUBLISHED revision, best
   *  effort, and the next commit's sweep finishes it. */
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

  /** Seat a first base as the overlay's sole lower with an empty upper, so the
   *  next delta archives only what was written since the base. A first base
   *  archives the merged view while the overlay still stands over an empty
   *  lower, so the upper holds the base files too and every later delta would
   *  carry them again. The reseat mounts the new base as the lower and clears
   *  the upper, which keeps the live view while making the changed set small.
   *  Quiesce only: clearing a live upper races writers, and a tick appends.
   *  After the record is durable, and without a second record write: the
   *  empty-upper skip in `checkpoint` covers the idle tick that follows, and
   *  the first write into the fresh upper moves the mark. A failure leaves the
   *  old overlay for the next wake, never a half-moved tree. */
  const reseatAfterFirstBase = async (chainId: string): Promise<void> => {
    try {
      await shell.unmountPath(DEVBOX_WORKDIR);
      await shell.releaseDeltaLayers();
      await shell.resetDirs([lowerBase, lowerDeltaRoot, upperDir, workDir]);
      await shell.mountLayer(baseObjectKey(root, chainId), lowerBase);
      await shell.overlayAttach(DEVBOX_WORKDIR, [lowerBase]);
      await assertOverlayLanded(`chain ${chainId}`);
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} base ${chainId} is committed and its overlay could not be reseated onto it, `
        + `so the next delta still archives the upper as it stands: ${describe({ cause: error })}`,
      );
    }
  };

  /** Commit a delta, a first base, or a REBASE onto a fresh generation: the
   *  merged work directory archived as a new base under a NEW generation id,
   *  the old generation deleted only after the new record is durable. */
  const commitChain = async (
    previous: ChainState | null,
    version: string,
    rebasing = false,
    upperMark?: string,
    kind?: CheckpointKind,
  ): Promise<CheckpointOutcome> => {
    const first = previous === null;
    const fresh = first || rebasing;
    const chainId = fresh ? crypto.randomUUID() : previous.base.id;

    // PROVE IT BEFORE WRITING IT. A chain the platform cannot mount is worse
    // than extraction: written, recorded, then unreadable for the rest of the
    // box's life, because a box attaches the way it was checkpointed. The mode
    // is decided once, here, by performing the mount rather than by asking
    // the platform whether it could: a capability that reported itself
    // present and then refused produced a silent no-op on a live container.
    // This is the ONLY mount call the checkpoint makes ({@link mountStoreOnce});
    // `storeHeld` carries it to the publication below.
    let storeHeld = false;
    if (first) {
      try {
        await mountStoreOnce();
        storeHeld = true;
      } catch (error) {
        // Where extraction is not permitted, a failed proof is a FAILED
        // CHECKPOINT carrying the platform's own reason
        // (`SnapshotChainPorts.allowExtraction`).
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
    if (fresh) {
      layer = await stageAndPut(
        baseObjectKey(root, chainId), DEVBOX_WORKDIR, ports.archiveExcludes(), storeHeld,
      );
    } else {
      // The mount line proves an overlay exists to have a changed set at all;
      // the upper is the path this strategy passed ({@link isOverlayMounted}).
      if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
        throw new Error(
          `${DEVBOX_WORKDIR} is not an overlay mount, so there is no changed set to archive. `
          + 'Refusing to checkpoint rather than silently archiving the whole tree.',
        );
      }
      // THE SAME EXCLUDES AS THE BASE, measured. Applied to the base only, the
      // delta carried `node_modules` again on EVERY tick, and `shouldRebase`
      // compared a small excluded base against a large unexcluded delta, so it
      // fired at nearly every quiesce: Verdict-2 measured that arm at 1.42x
      // tick time and 1.34x class-A of the plain one. Applied to both, the
      // archives are commensurable, and durability is HONEST: a tree the base
      // drops was only ever "durable in the delta" until the next rebase.
      layer = await stageAndPut(
        deltaObjectKey(root, chainId), upperDir, ports.archiveExcludes(), storeHeld,
      );
    }

    // State first, cleanup second (header, "Ordering under crash"): a crash
    // leaves two generations and never zero.
    const committed: ChainState = {
      mode: 'chain',
      rev: (previous?.rev ?? 0) + 1,
      base: fresh ? { id: chainId, ...layer } : previous.base,
      delta: fresh ? undefined : layer,
      at: ports.now(),
      changeVersion: version,
      upperMark,
      // A REBASE SUPERSEDES A GENERATION ({@link supersedeGeneration}); a
      // delta commit stays inside its generation and moves neither role.
      ...(rebasing && previous !== null
        ? supersedeGeneration(previous)
        : { fallback: previous?.fallback, orphans: previous?.orphans }),
      lastFailure: undefined,
    };
    await publish(previous, committed, async () => {
      await ports.exec(`rm -rf ${shellPath(stageDir)}`);
    });
    // THIS UPPER *IS* THE DELTA JUST PUBLISHED, so the stamp says so where the
    // next attach reads it. A base or a rebase stamps nothing: its generation
    // has no delta object, and the next attach resets the upper.
    if (!fresh && committed.delta !== undefined) {
      await stampSeededUpper(chainId, committed.delta);
    }
    // A first base leaves its files in the upper, so the next delta would carry
    // the base again. Seating the new base as the lower with an empty upper
    // keeps the live view while making that delta small. Quiesce only, and only
    // a first base: a rebase keeps its layers until the next wake proves them.
    if (first && kind === 'quiesce') {
      await reseatAfterFirstBase(chainId);
    }
    ports.log(
      `${DEVBOX_WORKDIR} ${rebasing ? 'rebase' : first ? 'base' : 'delta'} ${chainId} `
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

  /** A commit that did not commit, stamped. When the fence refused it,
   *  another writer advanced the record, so the stamp goes on the record as
   *  it stands. */
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

    // ATTACHMENT COMES FIRST, ahead of the change gate. With no overlay there
    // is no changed set, so every later answer would be about the wrong
    // thing: a live container answered a forced checkpoint 'unchanged' while
    // its work directory was not attached at all. Asked here, that box
    // reports a failure.
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

    // THE CHANGE GATE NEEDS SOMETHING TO BE RELATIVE TO. The SDK's answer to
    // `checkChanges` with no `since` is `unchanged`: it is ESTABLISHING a
    // baseline. Consulting it there is how a fresh box writes files, stops,
    // and saves nothing while every call reports success, which a live
    // container did. With no baseline, content IS the change.
    //
    // THE CHANGED SET IS THE UPPER, so the skip gate asks about it. The SDK's
    // change check, asked about the merged `/workspace`, answered `unchanged`
    // for five consecutive ticks on a deployed run while npm wrote 400 MiB
    // into the upper; the next workload's first tick committed 487 MiB of it.
    // A tick that CANNOT DECIDE must commit: an unreadable fingerprint is
    // empty, and an empty fingerprint never matches.
    const mark = overlayMounted ? await shell.upperFingerprint() : '';
    if (overlayMounted) {
      // Is the changed set spread across the layer and the upper? The layer's
      // mount point names its generation, so this is the same `/proc/mounts`
      // read the overlay gate above made.
      const layered = state !== null && deltaLayerServed(procMounts, state.base.id);
      if (mark !== '' && mark === state?.upperMark) {
        return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
      }
      // AN EMPTY UPPER IS NOTHING TO SAY. Every lower is durable already: the
      // base, the base plus its delta layer, or the empty lower a fresh box
      // attaches over. A deletion leaves a whiteout in the upper and a
      // metadata change copies its file up, so an empty upper proves that
      // nothing was written since the attach or the reseat.
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
        return await commitChain(state, version, layered || shouldRebase(state, kind), mark, kind);
      } catch (error) {
        return await commitFailed(state, { cause: error });
      }
    }
    const comparable = state?.changeVersion !== undefined;
    const effective: ChangeStatus = comparable ? change : 'changed';
    if (comparable && change === 'unchanged') {
      // ADVANCE THE WATERMARK, ADVISORY BY CONSTRUCTION: a change this code
      // DECLINED to archive must never advance it. A rejected write here is a
      // console line and the skip stands, because an unadvanced watermark
      // widens the next window, which can only over-report change, the safe
      // direction. Answering `failed` would be a false claim about work at
      // risk, and `Devbox.quiesce` declines to stop a box on a failed
      // checkpoint, so a flaky durable write would hold a box open.
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
      return await commitChain(state, version, shouldRebase(state, kind), undefined, kind);
    } catch (error) {
      return await commitFailed(state, { cause: error });
    }
  };

  const discard = async (): Promise<void> => {
    const state = await ports.readState();
    if (state === null) return;
    // Objects first, then the pointer: reversed, a crash orphans both. Every
    // generation the record NAMES goes, the retained fallback and the orphans
    // included, because clearState erases the only record naming them.
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
    await ports.clearState();
  };

  return { attach, checkpoint, discard };
}

function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function shellPaths(paths: readonly string[]): string {
  return paths.map(shellPath).join(' ');
}

/**
 * The archiver command: stage the exclude list, build the squashfs, and report
 * `<exit> <bytes>`.
 *
 * ONE COMMAND. A spot container can be replaced between two RPCs: as two
 * execs, the build reported exit 0 on one container and the stat found no
 * file on the next, "the archiver did not land" three times in one deployed
 * run while mksquashfs had succeeded. The exclude list is staged here for
 * the same reason. PATTERNS ARE DATA: the list travels as base64 and is
 * decoded container-side, so no quote, space or semicolon in a pattern can
 * become shell syntax. `-wildcards` makes a glob a glob, and `-ef` is the only
 * exclude form that carries the non-anchored lines {@link archiveExcludeFile}
 * writes. STDERR IS KEPT by the caller: it is mksquashfs's only explanation.
 */
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

/**
 * Copy a staged archive onto the store mount, flush it, and print
 * `<exit> <bytes>`. ONE COMMAND, for the reason {@link archiveCommand} states.
 *
 * `conv=fsync` IS THE CORRECTNESS. s3fs uploads on flush, a shell redirect
 * drops the close error, and an unmount can return before the upload
 * finishes. With the fsync inside the command, a store that did not take the
 * bytes is a non-zero exit HERE, before the record names the object. `bs=4M`
 * is large enough that s3fs sees whole multipart parts (its default part size
 * on an R2 mount is 5 MB) and small enough to be ordinary container memory.
 */
export function publishCommand(input: { archivePath: string; mountedPath: string }): string {
  // THE GENERATION'S DIRECTORY FIRST, in the same command: s3fs shows no
  // parent for a key nothing lives under yet, so `dd` refuses with `failed to
  // open …: No such file or directory` (measured live, run e2e20260902083130,
  // on the first checkpoint of a fresh box). `mkdir -p` writes the directory
  // marker the copy then opens through.
  const parent = input.mountedPath.slice(0, input.mountedPath.lastIndexOf('/'));
  return `mkdir -p ${shellPath(parent)}; `
    + `dd if=${shellPath(input.archivePath)} of=${shellPath(input.mountedPath)} `
    + 'bs=4M conv=fsync; '
    + `rc=$?; printf '%s %s' "$rc" `
    + `"$(stat -c %s ${shellPath(input.mountedPath)} 2>/dev/null || echo 0)"`;
}

/** The uncompressed size of what an archive of `sourceDir` would hold, as a
 *  command that prints one number. THE SAME MATCHER AS THE ARCHIVE, in `find`'s
 *  vocabulary: two `-path` predicates per pattern, one anchored at `<source>`
 *  and one under a wildcard segment, which crosses directory separators and so
 *  covers every depth as the exclude file does. `-prune` keeps the walk out of
 *  an excluded tree, which makes the number the archive's worst case. A failed
 *  walk prints 0, "no requirement": refusing every checkpoint because a probe
 *  could not walk would lose more than a full disk. */
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

/** The skip-gate fingerprint command over `sourceDir`: a hash of one record
 *  per path (inode, type, mode, size, sub-second mtime and CHANGE time, symlink
 *  target, path). A count/bytes/newest-mtime summary collided on a rename and
 *  on a rewrite with its mtime restored; the write itself moves ctime.
 *  O(entries), not O(bytes). A failed walk returns no mark, which callers
 *  treat as undecidable; `pipefail` stops `sort` or `sha256sum` hiding `find`'s
 *  failure. */
export function upperFingerprintCommand(sourceDir: string): string {
  const walk = `find ${shellPath(sourceDir)} -mindepth 1 `
    + `-printf '%i\\0%y\\0%m\\0%s\\0%T@\\0%C@\\0%l\\0%p\\0' 2>/dev/null `
    + '| LC_ALL=C sort -z | sha256sum | cut -c1-64';
  return `bash -o pipefail -c ${shellPath(walk)}`;
}
