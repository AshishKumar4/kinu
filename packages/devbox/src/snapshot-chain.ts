/**
 * Strategy one: an immutable base plus one cumulative delta, both squashfs
 * archives in an object store, attached as lazy FUSE layers.
 *
 * The shape and why it is this shape:
 *
 *   The first checkpoint archives the whole work directory as the BASE. It is
 *   written once and never rewritten. Every later checkpoint archives the
 *   overlay's upper directory — exactly the changed set, whiteouts included —
 *   into a single DELTA object that each checkpoint replaces atomically. So the
 *   chain is always at most two layers deep, no matter how many checkpoints
 *   have happened, and an attach mounts a fixed number of layers rather than a
 *   growing number.
 *
 *   An attach moves NO bytes in production. The store's own subtree for this
 *   chain is mounted read-only, `squashfuse` mounts the base (and the delta, if
 *   there is one) straight out of it, and `fuse-overlayfs` lays a fresh
 *   writable upper over them. Bytes arrive when something reads them. That is
 *   what makes an attach fit inside the container-start budget for a work
 *   directory of any size.
 *
 *   After an attach that had a delta, the delta's contents are copied into the
 *   fresh upper and the delta mount is released. From that moment the upper
 *   alone is the whole cumulative changed set, which is the property every
 *   later checkpoint relies on: archiving the upper archives everything since
 *   the base, so the delta object is freely replaceable.
 *
 * ORDERING UNDER CRASH. Two rules, both load-bearing:
 *
 *   1. The delta object is replaced by an atomic PUT, so a reader sees the old
 *      delta or the new one, never a mixture.
 *   2. The state record is written BEFORE any cleanup. A crash between the PUT
 *      and the state write leaves a complete delta the record does not yet
 *      mention, and an attach adopts it: the PUT was all-or-nothing and
 *      squashfs verifies its own superblock, so the mount is the validator. A
 *      crash the other way round — cleanup first — could delete the only copy.
 *
 * EXTRACTION IS LOCAL DEVELOPMENT ONLY, and it is stated rather than hidden.
 * A store mount needs container outbound interception, which does not exist
 * under a plain local `wrangler dev`. With no mount there is no lazy layer, so
 * the local path archives and extracts whole trees: it costs a full pass over
 * every byte on every attach, it does not scale, and it exists so that
 * development works at all. A chain that already HAS a base never degrades to
 * extraction — that would hand the caller an empty directory and call it a
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
  type StoredValue,
  recordCheckpointFailure,
} from './storage';

/** Where this chain's own object-store subtree is mounted read-only inside the
 *  container during an attach. Scoped to exactly this chain's UUID prefix, so
 *  the container can see its own layers and nothing else. */
export const CHAIN_STORE_MOUNT = '/backups';

class ContainerChangedDuringAttach extends Error {
  constructor() {
    super('the container generation changed while snapshot-chain attached its lower layers');
    this.name = 'ContainerChangedDuringAttach';
  }
}

/**
 * Archive lifetime for the EXTRACTION path, and nowhere else.
 *
 * The SDK's own backup API writes that archive and enforces this at restore
 * time, so the number has a reader. The chain path has none, and must not
 * acquire one: NEVER put a lifecycle rule on the chain's prefix. A rule deletes
 * by age since upload, the base is written once and never rewritten, and an
 * actively-used box would therefore lose its base on the rule's birthday and
 * refuse every attach afterwards with "archive object is missing". Chain
 * objects are reclaimed by the box's own `discard`, which is called when the
 * workspace is deleted; a box whose Durable Object is destroyed without that
 * call leaks its objects, and no sweep exists for that today.
 */
export const EXTRACT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Regenerable trees never travel.
 *
 * They are reproducible from a lockfile or a build, they dominate the byte
 * count, and every byte here is paid twice: once on upload and again on every
 * attach that reads it. LOCKFILES ARE NEVER EXCLUDED — they are what makes the
 * excluded trees regenerable, so `bun.lock`, `package-lock.json`,
 * `uv.lock`, `Cargo.lock` and their siblings are ordinary files that travel
 * with the base. The contract this creates with the agent is stated in the
 * sandbox tool doctrine: a restored workspace may need one `bun install`
 * before its dependencies are back.
 *
 * A box may replace this list — see `SnapshotChainPorts.archiveExcludes` — so a
 * workspace whose `target/` really is the work can keep it.
 *
 * Applied to whole-tree bases only: a changed set holds no derived tree that
 * was not written after the base.
 */
export const CHAIN_EXCLUDES = [
  'node_modules', '.git', '*.log', '.cache',
  '.bun', '__pycache__', '.venv', 'target', '.next', '.turbo', 'dist',
] as const;

/**
 * Rebase when the delta has outgrown the base by this factor.
 *
 * DERIVED, NOT MEASURED, and the derivation is the whole justification: a
 * checkpoint uploads the WHOLE cumulative delta every time, so once the delta
 * exceeds the base, every future checkpoint is moving more bytes than a fresh
 * full base would cost. One is therefore the break-even point, and anything
 * above it means the chain is paying to stay in a shape that is more expensive
 * than starting over. No production measurement of delta growth exists yet; if
 * one lands and disagrees, this is the one number to move.
 */
export const REBASE_DELTA_RATIO = 1;

/**
 * Should this checkpoint collapse the chain onto a fresh base?
 *
 * ONLY AT A QUIESCE, and that restriction is the design rather than caution. A
 * rebase replaces the base with an archive of the merged view, which only pays
 * for itself if the upper is then empty — and emptying a live upper races every
 * writer in the container, which is how a pivot loses the seconds of work it
 * was archiving. At a quiesce there are no writers: the box is stopping, and
 * the next attach mounts the new base under a fresh upper anyway. Every box
 * reaches a quiesce, so the collapse is reliable without ever being destructive.
 *
 * A tick therefore keeps appending to the delta however large it grows; the
 * cost of that is bounded by the next stop.
 */
export function shouldRebase(state: ChainState | null, kind: CheckpointKind): boolean {
  if (kind !== 'quiesce' || state === null || state.mode !== 'chain') return false;
  if (state.delta === undefined) return false;
  return state.delta.bytes > REBASE_DELTA_RATIO * state.base.bytes;
}

// ── identity and keys ───────────────────────────────────────────────────────

/**
 * A chain id is a UUID, full stop.
 *
 * Every object key is built from one, so anything that is not a UUID — `..`, a
 * path separator, another box's guess — has to die before it can become a key.
 * It dies here, loudly, at every call site that builds a key.
 */
const CHAIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChainId(id: string): boolean {
  return CHAIN_ID_RE.test(id);
}

/** Validate a chain id or refuse the operation, naming the refusal. */
export function assertChainId(id: string): string {
  if (!isChainId(id)) {
    throw new Error(
      `chain id ${JSON.stringify(id.slice(0, 64))} is not a UUID; refusing to build `
      + 'storage keys from it',
    );
  }
  return id;
}

/** The immutable full base layer. */
export function baseObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/data.sqsh`;
}

/** The cumulative changed set. ONE key, atomically replaced by every checkpoint
 *  after the base exists: supersession is a PUT, never a delete. */
export function deltaObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/delta.sqsh`;
}

/** The SDK's own metadata object, written only by its backup API. A chain
 *  records its sizes in the box's own state instead, so this key exists for
 *  extraction-mode handles and for discard to clean up after them. */
export function metadataObjectKey(chainId: string): string {
  assertChainId(chainId);
  return `backups/${chainId}/meta.json`;
}

// ── mount facts ─────────────────────────────────────────────────────────────

/**
 * Is `dir` an overlay mount?
 *
 * MECHANISM, NOT OPTIONS. The production image attaches with `fuse-overlayfs`,
 * and fuse-overlayfs does NOT publish `lowerdir`, `upperdir` or `workdir` in
 * `/proc/mounts`. Kernel overlay does, which is why an earlier version of this
 * file parsed them and why that version passed every local proof and then failed
 * on a deployed container with "produced an overlay whose upper directory
 * (unnamed) does not exist".
 *
 * So this asks only what the mount line can answer: is something mounted at
 * `dir`, and is it overlay-family. `fuse.fuse-overlayfs` and kernel `overlay`
 * both satisfy it. Anything that needs the upper directory uses the path this
 * strategy CHOSE and passed to the mount command, and verifies it with a direct
 * existence probe.
 */
export function isOverlayMounted(procMounts: string, dir: string): boolean {
  const line = findMount(procMounts, dir);
  return line !== undefined && line.fstype.includes('overlay');
}

// ── integrity ───────────────────────────────────────────────────────────────

/**
 * Why a stored layer must not be attached from, or null when it is sound.
 *
 * A PRE-attach probe. Objects can vanish under a lifecycle rule or a
 * half-finished delete, and attaching from one used to fail quietly. The size
 * recorded when the layer was written is compared against what the store holds
 * now, so a mismatch refuses the attach before the container-start budget is
 * spent on a transfer that cannot succeed.
 */
export function layerIntegrityFailure(input: {
  declaredBytes: number | undefined;
  storedBytes: number | undefined;
  label: string;
}): string | null {
  const { declaredBytes, storedBytes, label } = input;
  if (declaredBytes === undefined) return `${label} declares no size`;
  if (storedBytes === undefined) return `${label} archive object is missing from the store`;
  if (declaredBytes <= 0) return `${label} declares ${declaredBytes} bytes`;
  if (storedBytes !== declaredBytes) {
    return `${label} archive is ${storedBytes} bytes, state declares ${declaredBytes}`;
  }
  return null;
}

// ── the box's own chain record ──────────────────────────────────────────────

/** How a chain's bytes move. `chain` is the production lazy-mount path;
 *  `extract` is local development. Decided once and persisted: a box always
 *  attaches the way it was checkpointed. */
export type ChainMode = 'chain' | 'extract';

/** What the container's retained change state says about a directory since a
 *  previous check. Mirrors the SDK's `CheckChangesResult.status`. `resync`
 *  means that state was itself lost — it expired, or the container restarted —
 *  so the directory has to be treated as changed. */
export type ChangeStatus = 'unchanged' | 'changed' | 'resync';

/** Everything a box needs to know about its own chain. One record, one writer,
 *  replaced whole. */
export interface ChainState {
  readonly mode: ChainMode;
  /** Monotonic revision, bumped on every successful state write. */
  readonly rev: number;
  /** The full base. Its UUID keys the store prefix; `bytes` is what the store
   *  held when the layer was recorded. Immutable once written. */
  readonly base: { readonly id: string; readonly bytes: number };
  /** The cumulative changed set, or undefined until the first delta lands. */
  readonly delta: { readonly bytes: number } | undefined;
  /** Epoch ms the checkpoint completed. The interval gate reads this. */
  readonly at: number;
  /** The change version this checkpoint is relative to. Advanced when a
   *  checkpoint succeeds, and when the directory was reported unchanged.
   *  NEVER advanced after a change that was not archived: that would discard
   *  the change signal and the next tick would believe it was already saved. */
  readonly changeVersion: string | undefined;
  /**
   * Generations this box has superseded and not yet deleted.
   *
   * WRITTEN BEFORE THE DELETE, cleared after it, for the same reason the record
   * is written before any other cleanup: a crash between the rebase's state
   * flip and the old generation's deletion used to orphan that generation
   * forever, because nothing anywhere still named it. Chain objects live under
   * a GLOBAL `backups/<uuid>/` namespace shared by every box, so a sweep cannot
   * discover this box's own orphans by listing — it would see other boxes'
   * live generations. The box therefore remembers them, and the sweep is
   * re-runnable: a crash mid-sweep leaves the ids in place for the next one.
   */
  /** The changed set's fingerprint at the last successful commit. The skip gate
   *  compares against it; see `chainShell.upperFingerprint`. */
  readonly upperMark: string | undefined;
  readonly orphans: readonly string[] | undefined;
  /** The last attempt that failed. Kept because a thrown scheduled callback is
   *  reduced to a console line by the alarm loop, so durable state is the only
   *  way a repeatedly failing checkpoint stays visible. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/**
 * The stored record, as a schema.
 *
 * A durable row is untrusted input: it was written by some release of this
 * package, and the reader has to establish what it is rather than assume. A row
 * this code did not write reads as ABSENT, which makes a fresh box, rather than
 * as a chain whose base cannot be found, which makes a box that refuses to
 * start forever.
 */
const ChainStateSchema = v.object({
  mode: v.picklist(['chain', 'extract']),
  rev: v.number(),
  base: v.object({ id: v.pipe(v.string(), v.regex(CHAIN_ID_RE)), bytes: v.number() }),
  delta: v.optional(v.object({ bytes: v.number() })),
  at: v.number(),
  changeVersion: v.optional(v.string()),
  upperMark: v.optional(v.string()),
  orphans: v.optional(v.array(v.pipe(v.string(), v.regex(CHAIN_ID_RE)))),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

export function normalizeChainState(raw: StoredValue): ChainState | null {
  const parsed = v.safeParse(ChainStateSchema, raw);
  if (!parsed.success) return null;
  // Written out rather than spread, so the parse produces EXACTLY the contract.
  // The schema's optional fields become present-and-undefined here, which is
  // what the record declares and what every reader checks.
  const row = parsed.output;
  return {
    mode: row.mode,
    rev: row.rev,
    base: row.base,
    delta: row.delta,
    at: row.at,
    changeVersion: row.changeVersion,
    upperMark: row.upperMark,
    orphans: row.orphans,
    lastFailure: row.lastFailure,
  };
}

/** Commit only when the directory actually changed AND the period elapsed.
 *
 *  `unchanged` is the whole efficiency argument: a work directory is idle for
 *  most of its wall-clock life, and an unchanged tick costs no archive, no
 *  upload and no new object. */
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

/**
 * Everything the strategy needs from the world. The adapter implements it and
 * decides nothing; every entry maps to one public Sandbox SDK primitive, one
 * object-store binding call, or the box's own durable storage.
 */
export interface SnapshotChainPorts {
  /** Is the container up right now? A scheduled tick can outlive it, and waking
   *  a sleeping container to ask whether it changed would keep it alive
   *  forever. */
  containerRunning(): boolean;
  /**
   * May this box archive and extract whole trees instead of mounting layers?
   *
   * DECLARED BY THE HOST, never discovered. Extraction exists because a plain
   * local `wrangler dev` has no container outbound interception and therefore
   * no store mount. It costs a full pass over every byte on every attach, it
   * does not scale, and a deployed box that quietly took it is a box whose
   * changed set is never archived: `/workspace` is a plain directory, so there
   * is no overlay upper to capture, and every write after the base is lost on
   * the next restore.
   *
   * That is not hypothetical. It was measured on a deployed probe, where a
   * failed mount was converted into extraction and the loss only surfaced as
   * "delta content lost across restore" two phases later. So a mount failure
   * where extraction is not permitted is a FAILURE, and it carries the mount's
   * own reason to whoever is watching.
   */
  allowExtraction(): boolean;
  /** What a whole-tree base leaves behind, for THIS box. Defaults to
   *  {@link CHAIN_EXCLUDES}; a workspace whose regenerable-looking tree is
   *  really the work replaces it. */
  archiveExcludes(): readonly string[];
  readState(): Promise<ChainState | null>;
  writeState(state: ChainState): Promise<void>;
  clearState(): Promise<void>;
  /** Minimum gap between two commits. Supplied by the host's policy so one
   *  place decides the cadence for both the schedule and this gate. */
  checkpointIntervalMs(): number;
  /** Has the work directory changed since `since`, per the container's own
   *  retained change state? */
  checkChanges(dir: string, since: string | undefined):
    Promise<{ status: ChangeStatus; version: string }>;
  /**
   * Run one shell command container-side, and answer what it did.
   *
   * THE ONLY CONTAINER-SHELL PORT. The mount flags, the squashfs options, the
   * seeding copy and the mount probes are this strategy's own vocabulary, so it
   * builds them itself rather than taking eight command templates a host would
   * have to keep correct. A host supplies the ability to run a command; what to
   * run is not its business.
   */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Ephemeral generation id, when the host can observe one. */
  containerGeneration?(): Promise<string | undefined>;
  /** Wait until an object appears through the store mount, or report that the
   * container generation changed while the mount warmed. */
  waitForPath?(
    path: string,
    generation: string | undefined,
  ): Promise<'ready' | 'replaced'>;
  /** Mount this chain's store subtree read-only at `CHAIN_STORE_MOUNT`.
   *  Credentials never leave the Durable Object. */
  mountStore(chainId: string): Promise<void>;
  /**
   * Release the store mount THROUGH THE SDK, not through the kernel.
   *
   * The SDK keeps its own registry of the bucket mounts it made and refuses a
   * mount whose path it still believes is in use. Releasing one with a raw
   * `fusermount3` unmounts the filesystem and leaves that registry claiming the
   * path forever, so the NEXT attach is refused for a mount that no longer
   * exists. Deployed symptom: a chain that could be written and then never
   * attached again, with every operation refused because the attach failed.
   */
  unmountStore(): Promise<void>;
  /** Stream a container file out as binary, with no base64 framing. */
  readFileStream(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number }>;
  /** Put one object into the store. The visible object appears complete or not
   *  at all. */
  /** Put one object into the store and answer HOW MANY BYTES LANDED. The
   *  visible object appears complete or not at all. The returned count is
   *  what the record must carry: a size measured before the upload can
   *  disagree with the object, and the integrity probe compares the two. */
  putObject(key: string, stream: ReadableStream<Uint8Array>, size: number): Promise<number>;
  /** What the store currently holds for one object, or undefined. */
  objectBytes(key: string): Promise<number | undefined>;
  /** Delete objects. Used by discard, and to drop a superseded extraction
   *  archive after its replacement is durably recorded. */
  deleteObjects(keys: readonly string[]): Promise<void>;
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

/** Canonical archive options for the extraction path. The TTL is HERE and only
 *  here: the SDK enforces it at restore time on archives its own backup API
 *  wrote, which is exactly this path. See {@link EXTRACT_TTL_SECONDS}. */
export function chainBackupOptions(localBucket: boolean): BackupOptions {
  return {
    dir: DEVBOX_WORKDIR,
    localBucket,
    gitignore: true,
    excludes: [...CHAIN_EXCLUDES],
    ttl: EXTRACT_TTL_SECONDS,
    // zstd because every byte is paid twice: once on upload, again on every
    // attach that reads it.
    compression: { format: 'zstd' },
  };
}

// ── the layout inside the container ─────────────────────────────────────────
//
// Where the overlay's parts live. Module scope because the shell below builds
// commands from them and the strategy reasons about them: one declaration, one
// meaning, and no path spelled twice.

/** The overlay's writable upper. Everything the caller writes lands here, and
 *  archiving it archives the whole changed set since the base. */
const upperDir = `${DEVBOX_RUNTIME_DIR}/upper`;
/** fuse-overlayfs's own scratch directory. Not the upper, and not readable as
 *  content. */
const workDir = `${DEVBOX_RUNTIME_DIR}/work`;
/** Where an archive is built before it is streamed into the store. */
const stageDir = `${DEVBOX_RUNTIME_DIR}/stage`;
/** Mount point for the base layer while an attach is in progress. */
const lowerBase = `${DEVBOX_RUNTIME_DIR}/lower-base`;
/** Mount point for the delta layer while an attach is in progress. */
const lowerDelta = `${DEVBOX_RUNTIME_DIR}/lower-delta`;
/** The lower a box with no chain yet attaches over: an empty directory.
 *
 *  See {@link snapshotChainStorage}'s attach. It exists so that "this box is in
 *  chain mode" and "`/workspace` is a plain directory" can never both be true. */
const lowerEmpty = `${DEVBOX_RUNTIME_DIR}/lower-empty`;

// ── the container shell ─────────────────────────────────────────────────────
//
// Every command this strategy runs, in this file. The mount flags, the squashfs
// options and the seeding copy are the strategy's own vocabulary; they were
// eight templates in the host adapter, so a reader had to hold two files open
// to answer "what does an attach actually run", and a change to the overlay
// flags meant editing the layer that does not own them.

type ContainerExec = SnapshotChainPorts['exec'];

function chainShell(exec: ContainerExec) {
  /** Run a command and refuse on a non-zero exit, naming what was attempted.
   *  The container's own words are the diagnosis; this code has no better one. */
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
    /** Does this container path exist? The attach postcondition asks for the
     *  overlay's upper directory by name: a mount line without a usable upper
     *  is a box whose writes have nowhere to land. */
    pathExists: async (path: string): Promise<boolean> =>
      (await exec(`test -e ${shellPath(path)} && echo yes || echo no`)).stdout.trim() === 'yes',
    /** Release a FUSE mount this strategy made itself. Lazy, and tolerant of the
     *  mount being absent. The squashfuse layers only: the SDK did not create
     *  those and has no registry entry for them, and releasing a mount the SDK
     *  DID make this way leaves its registry claiming the path forever. */
    unmountPath: async (path: string): Promise<void> => {
      await exec(
        `/usr/bin/fusermount3 -u ${shellPath(path)} 2>/dev/null || true; `
          + `while grep -qs ${shellPath(` ${path} `)} /proc/mounts; do `
          + `/usr/bin/fusermount3 -u ${shellPath(path)} 2>/dev/null || true; sleep 0.1; done`,
      );
    },
    /**
     * Mount one squashfs layer read-only. squashfuse reads lazily THROUGH the
     * mounted store subtree: bytes arrive on demand over the intercepted
     * egress, never as a download.
     *
     * THE MOUNTPOINT IS CREATED IN THE SAME COMMAND THAT USES IT. The attach is
     * several RPCs apart, and a spot container can be replaced between two of
     * them — measured live at roughly once per phase under churn — leaving the
     * next command on a blank disk. A mountpoint prepared by an earlier exec
     * then does not exist, and fuse refuses with `bad mount point`. One
     * `mkdir -p &&` inside the command has no gap to lose. `nonempty` is safe
     * here because this private runtime directory is reset before every mount;
     * it tolerates kernel-delayed FUSE cleanup and never hides user files.
     */
    mountLayer: async (objectKey: string, mountPoint: string): Promise<void> => {
      const layerName = objectKey.split('/').pop() ?? objectKey;
      await must('squashfuse mount', `mkdir -p ${shellPath(mountPoint)} && /usr/bin/squashfuse `
        + `${shellPath(`${CHAIN_STORE_MOUNT}/${layerName}`)} ${shellPath(mountPoint)} `
        + '-o allow_other,ro,nonempty');
    },
    /** Attach `lowers` (first entry is newest) with a fresh writable upper. Its
     *  upper and work directories are created in the same command, for the same
     *  reason as {@link mountLayer}'s mount point. */
    overlayAttach: async (dir: string, lowers: readonly string[]): Promise<void> => {
      await must('fuse-overlayfs attach', `mkdir -p ${shellPath(upperDir)} `
        + `${shellPath(workDir)} && /usr/bin/fuse-overlayfs `
        + `-o lowerdir=${lowers.map(shellPath).join(':')}`
        + `,upperdir=${shellPath(upperDir)},workdir=${shellPath(workDir)} ${shellPath(dir)}`);
    },
    /** Copy a lower layer's contents into the upper directory. `cp -a` preserves
     *  whiteout device nodes and symlinks, which is what makes a seeded upper
     *  equivalent to the delta it came from. */
    seedUpper: async (lower: string, upper: string): Promise<void> => {
      await must('upper seeding',
        `cp -a ${shellPath(`${lower}/.`)} ${shellPath(`${upper}/`)} && sync ${shellPath(upper)}`);
    },
    /**
     * Build a squashfs of `sourceDir` at `archivePath` and answer its size.
     *
     * BUILD AND MEASURE IN ONE COMMAND. They were two execs, and a spot
     * container can be replaced between two RPCs: the build reported exit 0 on
     * one container and the stat found no file on the next, which surfaced as
     * "the archiver did not land" three times in one deployed run while
     * mksquashfs had in fact succeeded. One command cannot be split by a
     * replacement, so a missing archive after a successful build is no longer
     * representable.
     *
     * STDERR IS KEPT. It used to go to /dev/null, so the one run that needed
     * mksquashfs's own words to explain itself did not have them.
     */
    makeSquashfs: async (
      sourceDir: string, archivePath: string, excludes: readonly string[],
    ): Promise<number> => {
      const args = excludes.map(entry => `-e ${shellPath(entry)}`).join(' ');
      const result = await exec(`/usr/bin/mksquashfs ${shellPath(sourceDir)} `
        + `${shellPath(archivePath)} -comp zstd -no-progress ${args} >/dev/null; rc=$?; `
        + `printf '%s %s' "$rc" "$(stat -c %s ${shellPath(archivePath)} 2>/dev/null || echo 0)"`);
      const [code, size] = result.stdout.trim().split(/\s+/);
      if (code !== '0') {
        throw new Error(`mksquashfs failed (${code ?? '?'}): ${result.stderr.trim() || 'no output'}`);
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
    /**
     * Why there is not room to stage an archive of `sourceDir`, or null.
     *
     * `du` measures the tree MINUS the same exclusions the archive will skip,
     * so the requirement is the archive's true worst case (squashfs never
     * exceeds the uncompressed input) rather than a number anyone chose. `df`
     * reports what the staging filesystem has. Both in one command, so a
     * container replacement cannot land between the two readings and make them
     * describe different disks.
     */
    stagingShortfall: async (
      sourceDir: string,
      excludes: readonly string[],
    ): Promise<string | null> => {
      const pruned = excludes
        .map(entry => `-name ${shellPath(entry)} -prune -o`)
        .join(' ');
      const measured = await exec(
        `mkdir -p ${shellPath(stageDir)}; `
        + `need=$(find ${shellPath(sourceDir)} ${pruned} -type f -printf '%s\\n' 2>/dev/null `
        + `| awk '{t+=$1} END {print t+0}'); `
        + `free=$(df -Pk ${shellPath(stageDir)} | awk 'NR==2 {print $4*1024}'); `
        + `echo "$need $free"`,
      );
      const [need, free] = measured.stdout.trim().split(/\s+/).map(Number);
      // An unreadable answer is NOT a refusal: refusing every checkpoint because
      // a probe could not parse would lose more work than a full disk would.
      if (!Number.isFinite(need) || !Number.isFinite(free)) return null;
      if (free! >= need!) return null;
      return `staging ${sourceDir} needs up to ${need} bytes and ${stageDir} has ${free} free. `
        + 'Refusing to archive rather than filling the container disk and taking the box '
        + 'down mid-checkpoint.';
    },
    /**
     * A cheap fingerprint of the changed set: entry count, total bytes, newest
     * mtime. Empty string when it cannot be taken.
     *
     * THIS REPLACES ASKING THE MERGED MOUNT. The SDK's change check was asked
     * about `/workspace` while a delta archives `upperDir`, and on a deployed
     * run it answered `unchanged` five ticks running while npm wrote 400 MiB
     * into that upper — then the next workload's first tick committed 487 MiB
     * of it. A gate that can say "unchanged" about a workspace that changed is
     * a data-loss window, so the question is now asked of the bytes that would
     * be archived, and it walks metadata rather than content: O(entries), not
     * O(bytes).
     */
    upperFingerprint: async (): Promise<string> => {
      const measured = await exec(upperFingerprintCommand(upperDir));
      return measured.exitCode === 0 ? measured.stdout.trim() : '';
    },
    /** Byte length of a container file, or undefined when it does not exist. */
    statBytes: async (path: string): Promise<number | undefined> => {
      const raw = (await exec(`stat -c %s ${shellPath(path)} 2>/dev/null || echo ''`)).stdout.trim();
      return raw.length > 0 ? Number.parseInt(raw, 10) : undefined;
    },
    /** Reset a set of directories to empty, and make sure each exists.
     *  THROUGH must(): a failed reset used to pass silently — its exit code
     *  was discarded — so the attach then ran against whatever the container
     *  happened to still hold, one reorder away from serving a stale tree. */
    resetDirs: async (paths: readonly string[]): Promise<void> => {
      await must('resetting directories',
        `rm -rf ${shellPaths(paths)} && mkdir -p ${shellPaths(paths)}`);
    },
  };
}

// ── the strategy ────────────────────────────────────────────────────────────

export function snapshotChainStorage(ports: SnapshotChainPorts): DevboxStorage {
  const shell = chainShell(ports.exec);

  /** Is every layer the record names still backed by the store? Answered before
   *  the container-start budget is spent on an attach that cannot land. */
  /**
   * Why a stored layer must not be attached from, or null when it is sound.
   *
   * THE BASE AND THE DELTA ARE JUDGED DIFFERENTLY, and the asymmetry is the
   * design's own. A base is written ONCE and never rewritten, so a size that
   * disagrees with the record means the object is not the one the record
   * describes — genuinely unsound, refuse.
   *
   * A delta is REPLACED by an atomic PUT on every checkpoint, and this file's
   * header already states what a mismatch there means: "a crash between the PUT
   * and the state write leaves a complete delta the record does not yet
   * mention, and an attach adopts it — the PUT was all-or-nothing and squashfs
   * verifies its own superblock, so the mount is the validator."
   *
   * That adoption was unreachable. The probe refused on the byte count before
   * the mount could validate anything, and `fail()` then re-wrote the state
   * carrying the OLD size, so the disagreement was permanent: the object never
   * shrinks back to the declared number. Measured across two deployed runs as
   * `archive 506834944, state declares 506494976` and twice more, each
   * difference an exact multiple of 4096 because every squashfs archive is
   * padded to it — the signature of two DIFFERENT archives, not of one archive
   * measured twice. One occurrence cost an arm fourteen of its twenty segments.
   *
   * So a delta the store still holds is adopted and its size re-recorded. A
   * delta the record names and the store does NOT hold is still a refusal:
   * that is real content loss, not a stale number.
   */
  const probe = async (state: ChainState): Promise<
    { refusal: string } | { refusal: null; deltaBytes: number | undefined }
  > => {
    if (state.mode === 'extract') return { refusal: null, deltaBytes: undefined };
    const unsound = layerIntegrityFailure({
      declaredBytes: state.base.bytes,
      storedBytes: await ports.objectBytes(baseObjectKey(state.base.id)),
      label: 'base',
    });
    if (unsound !== null) return { refusal: unsound };
    if (state.delta === undefined) return { refusal: null, deltaBytes: undefined };
    const stored = await ports.objectBytes(deltaObjectKey(state.base.id));
    if (stored === undefined) {
      return {
        refusal: `delta archive is missing from the store, but the record names one of `
          + `${state.delta.bytes} bytes. Refusing rather than attaching a chain whose changed `
          + 'set is gone.',
      };
    }
    return { refusal: null, deltaBytes: stored };
  };

  const attachExtract = async (state: ChainState): Promise<AttachOutcome> => {
    const result = await ports.restoreExtract({
      id: state.base.id, dir: DEVBOX_WORKDIR, localBucket: true,
    });
    if (!result.success) {
      throw new Error(`extraction of ${DEVBOX_WORKDIR} reported failure.`);
    }
    if ((await ports.countEntries(DEVBOX_WORKDIR)) === 0) {
      throw new Error(
        `extraction of ${DEVBOX_WORKDIR} reported success, but the directory is empty.`,
      );
    }
    ports.log(`${DEVBOX_WORKDIR} extracted from ${state.base.id}`);
    return { kind: 'attached', detail: `extract ${state.base.id}` };
  };

  const attachChainOnce = async (state: ChainState): Promise<AttachOutcome> => {
    const generation = await ports.containerGeneration?.();
    // Release any mount the SDK still believes it holds at this path before
    // asking for a new one. A previous container generation's entry survives in
    // that registry, and it refuses the mount rather than replacing it.
    await ports.unmountStore();
    // A chain whose layers EXIST cannot be served by extraction, so a mount
    // failure here fails the start rather than degrading. Degrading would hand
    // the caller an empty tree and report success. The thrown reason travels as
    // it came: the platform's own words are the diagnosis, and this code has no
    // better one.
    try {
      await ports.mountStore(state.base.id);
    } catch (error) {
      throw new Error(
        `chain ${state.base.id} is stored as lazy layers and its store subtree could not `
        + `be mounted here: ${describe({ cause: error })}`,
        { cause: error },
      );
    }
    const mountedGeneration = await ports.containerGeneration?.();
    if (generation !== undefined && mountedGeneration !== generation) {
      throw new ContainerChangedDuringAttach();
    }
    const mountedBase = `${CHAIN_STORE_MOUNT}/data.sqsh`;
    const visible = ports.waitForPath === undefined
      ? (await shell.pathExists(mountedBase)) ? 'ready' : 'missing'
      : await ports.waitForPath(mountedBase, mountedGeneration);
    if (visible === 'replaced') throw new ContainerChangedDuringAttach();
    if (visible !== 'ready') {
      throw new Error(`chain ${state.base.id} store mount does not expose ${mountedBase}`);
    }
    await shell.unmountPath(DEVBOX_WORKDIR);
    await shell.unmountPath(lowerBase);
    await shell.unmountPath(lowerDelta);
    // CHAIN_STORE_MOUNT is deliberately NOT here. mountStore owns that
    // mountpoint, and it is already mounted read-only by the time this runs:
    // `rm -rf` on it exits non-zero, which used to short-circuit the `&&` so
    // NO directory was recreated — correctness hung on every later command
    // re-creating its own path. Worse, had the mount ever been read-write,
    // rm -rf would have deleted the chain's archives through it.
    await shell.resetDirs([lowerBase, lowerDelta, upperDir, workDir]);
    try {
      await shell.mountLayer(baseObjectKey(state.base.id), lowerBase);
    } catch (error) {
      const failedGeneration = await ports.containerGeneration?.();
      if (mountedGeneration !== undefined && failedGeneration !== mountedGeneration) {
        throw new ContainerChangedDuringAttach();
      }
      throw error;
    }

    // An unreferenced but complete delta — a previous run crashed between the
    // atomic PUT and the state write — is adopted. See this file's header.
    const haveDelta = state.delta !== undefined
      || (await ports.objectBytes(deltaObjectKey(state.base.id))) !== undefined;

    // SEED BEFORE THE OVERLAY LANDS, and this order is the whole correctness of
    // a re-driven attach.
    //
    // The overlay used to be mounted first and the delta copied into the upper
    // after it. A throw, an eviction or a container replacement in that window
    // left the overlay UP and the upper HALF-SEEDED — and the retry then asked
    // the container, saw an overlay, took the `already-attached` early return,
    // and never finished the copy. The box served a workspace missing part of
    // its own delta while reporting success, and the next checkpoint archived
    // that partial upper as the new delta, so the missing content left the
    // durable chain permanently.
    //
    // Copying first makes the bad state unrepresentable rather than merely
    // unlikely: the upper is an ordinary directory that the mount only takes as
    // a parameter, so nothing ever required the overlay to exist during the
    // copy. With this order a mounted overlay PROVES the seeding finished,
    // which is what the early return already assumed — and it needs no durable
    // marker, so idempotence is still asked of the container, not stored.
    if (haveDelta) {
      await shell.mountLayer(deltaObjectKey(state.base.id), lowerDelta);
      await shell.seedUpper(lowerDelta, upperDir);
      await shell.unmountPath(lowerDelta);
      // Only the DELTA's mount point is removable. `lowerBase` becomes an ACTIVE
      // lower of the overlay below, so removing it would be refused by the
      // kernel — and would break the overlay if it were not.
      await ports.exec(`rm -rf ${shellPath(lowerDelta)}`);
    }
    // ONE lower. The delta is already in the upper, which is what the header
    // means by "the upper alone is the whole cumulative changed set" — now true
    // from the instant the overlay exists rather than a step later.
    await shell.overlayAttach(DEVBOX_WORKDIR, [lowerBase]);
    await assertOverlayLanded(`chain ${state.base.id}`);
    await ports.unmountStore();

    const bytes = state.base.bytes + (state.delta?.bytes ?? 0);
    // One mounted layer, plus the delta if there was one — reported separately
    // because they are different things now: the layer is lazy and moves no
    // bytes, the seed is a copy that already happened.
    const restored = haveDelta ? 'base+seeded delta' : 'base';
    ports.log(
      `${DEVBOX_WORKDIR} attached from ${state.base.id} (chain, ${bytes} bytes, ${restored})`,
    );
    return {
      kind: 'attached',
      detail: `chain ${state.base.id} ${bytes}B ${restored}`,
    };
  };

  const attachChain = async (state: ChainState): Promise<AttachOutcome> => {
    for (;;) {
      try {
        return await attachChainOnce(state);
      } catch (error) {
        if (!(error instanceof ContainerChangedDuringAttach)) throw error;
        ports.log(`container changed while chain ${state.base.id} attached; retrying on its replacement`);
      }
    }
  };

  /**
   * A box with no chain yet still gets an overlay, over an empty lower.
   *
   * THE STATE THIS REMOVES: chain mode with a plain `/workspace`. A box used to
   * be born plain, and its first checkpoint wrote `mode:'chain'` without
   * attaching anything — so from that moment every later checkpoint and every
   * quiesce hit the "not an overlay mount" gate and refused, the box could not
   * stop gracefully, it filed a checkpoint incident every interval, and
   * everything written after the base was lost when the platform evicted the
   * container. Being born with the overlay makes that state unrepresentable:
   * the changed set has somewhere to accumulate from the first write.
   *
   * It also makes a re-run of the attach harmless. A Durable Object can be
   * evicted while its container keeps running; the next operation re-drives the
   * restoration, and on a plain first generation that used to mount the base
   * OVER the caller's live tree and hide every byte written since.
   *
   * A host with no fuse-overlayfs — a plain local `wrangler dev` — cannot do
   * this, and says so by failing. That is the same host extraction exists for,
   * so the box stays plain and the first checkpoint decides its mode as before.
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

  /** A successful call is not a landed mount. Both halves are read back from the
   *  container, and each asks the question its mechanism can answer: the mount
   *  line for the mount, a direct existence probe for the upper. A live
   *  container once reported every attach step as fine while /proc/mounts held
   *  no overlay line at all, so neither half is decoration. */
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

  const attach = async (): Promise<AttachOutcome> => {
    let state = await ports.readState();

    // Idempotence without a marker: ask the container. The container-start hook
    // fires at least once per start, and a stored "attached" marker is exactly
    // what latched the last time. An overlay that already landed is visible in
    // /proc/mounts, which is the fact rather than a note about the fact.
    if (isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);
      return {
        kind: 'already-attached',
        detail: state === null ? 'no chain recorded' : `chain ${state.base.id}`,
      };
    }
    if (state === null) return await attachFresh();

    const sound = await probe(state);
    if (sound.refusal !== null) {
      throw new Error(
        `Cannot attach ${DEVBOX_WORKDIR} from chain ${state.base.id}: ${sound.refusal}. Refusing `
        + 'to start the container rather than serve an empty work directory. Discard this '
        + "box's stored state to start fresh.",
      );
    }
    // ADOPT a delta whose recorded size went stale, and re-record it, so the
    // disagreement cannot outlive this attach. See `probe`.
    if (state.delta !== undefined && sound.deltaBytes !== undefined
      && sound.deltaBytes !== state.delta.bytes) {
      const drift = sound.deltaBytes - state.delta.bytes;
      ports.log(
        `delta record was stale by ${drift} bytes (${Math.abs(drift) / 4096} squashfs blocks); `
        + `adopting the stored archive of ${sound.deltaBytes} bytes`,
      );
      state = { ...state, delta: { bytes: sound.deltaBytes } };
      await ports.writeState(state);
    }
    // THE PERSISTED MODE IS THE CONTRACT. A chain-mode record must end as an
    // overlay or the attach throws; an extract-mode record is only legal where
    // extraction is permitted. A deployed box holding an extract record is a box
    // that took a silent fallback, and serving it would hide that a second time.
    if (state.mode === 'chain') return await attachChain(state);
    if (!ports.allowExtraction()) {
      throw new Error(
        `chain ${state.base.id} was archived by extraction, which is not permitted here. `
        + 'That record can only have come from a host that allowed it, so this box is '
        + 'refusing rather than serving a work directory whose changes are never archived.',
      );
    }
    return await attachExtract(state);
  };

  /**
   * Build a squashfs of `sourceDir`, push it to `key`, and return what the state
   * write records.
   *
   * NO CONTENT DIGEST. There was one: a `sha256sum` over the whole staged
   * archive, validated against a hex regex, with its own failure branch — and
   * nothing recorded it, nothing compared it, and `ChainState` has no field for
   * it. That is a full CPU pass over every byte of every checkpoint plus a
   * spurious way to fail, bought for nothing. The integrity gate that exists is
   * `layerIntegrityFailure`, which compares the size the store holds against the
   * size the record declares, before an attach spends the container-start budget
   * on a layer that cannot land.
   */
  const stageAndPut = async (
    key: string,
    sourceDir: string,
    excludes: readonly string[],
  ): Promise<{ bytes: number }> => {
    const archivePath = `${stageDir}/layer.sqsh`;
    // ROOM TO WRITE IT, ASKED BEFORE WRITING IT. An archiver that fills the
    // container's disk takes the whole box down with it, and a box that dies
    // mid-checkpoint is the one shape this package exists to prevent. The
    // budget is not a constant anyone guessed: the worst case for a squashfs is
    // the UNCOMPRESSED size of what it is archiving, so the tree measures its
    // own requirement and the container reports what it has. Refusing here is a
    // returned failure, which the caller turns into an incident; it is never a
    // crash.
    const short = await shell.stagingShortfall(sourceDir, excludes);
    if (short !== null) throw new Error(short);
    const staged = await shell.makeSquashfs(sourceDir, archivePath, excludes);
    const { stream } = await ports.readFileStream(archivePath);
    // THE RECORD DESCRIBES WHAT LANDED, not what was staged. These disagreed on
    // a deployed run — `delta archive is 702791680 bytes, state declares
    // 700387328` — and every wake then refused, because the integrity probe
    // compares the two. The staged size is measured before the bytes are read,
    // so a file still settling reads short; the upload counts what it actually
    // sent. One truth, captured after landing.
    const landed = await ports.putObject(key, stream, staged);
    return { bytes: landed };
  };

  const commitExtract = async (
    previous: ChainState | null,
    version: string,
  ): Promise<CheckpointOutcome> => {
    // LOCAL DEVELOPMENT ONLY. The SDK archives the whole tree and the binding
    // moves it. The superseded archive is deleted only AFTER its replacement is
    // durably recorded, so a crash leaves two archives and never zero.
    const backup = await ports.createExtractSnapshot(chainBackupOptions(true));
    const storedBytes = await ports.objectBytes(baseObjectKey(backup.id));
    if (storedBytes === undefined || storedBytes <= 0) {
      throw new Error(`archive ${backup.id} is not sound: the object is missing or empty`);
    }
    await ports.writeState({
      mode: 'extract',
      rev: (previous?.rev ?? 0) + 1,
      base: { id: backup.id, bytes: storedBytes },
      delta: undefined,
      at: ports.now(),
      changeVersion: version,
      upperMark: undefined,
      orphans: previous?.orphans,
      lastFailure: undefined,
    });
    if (previous !== null && previous.base.id !== backup.id) {
      await ports.deleteObjects([
        baseObjectKey(previous.base.id),
        deltaObjectKey(previous.base.id),
        metadataObjectKey(previous.base.id),
      ]);
    }
    ports.log(`${DEVBOX_WORKDIR} archived as ${backup.id} (${storedBytes} bytes, extract)`);
    return { kind: 'committed', reason: undefined, bytes: storedBytes, movedBytes: storedBytes };
  };

  /**
   * Commit a delta, a first base, or a REBASE onto a fresh generation.
   *
   * `rebasing` collapses the chain: the merged work directory is archived as a
   * new base under a NEW generation id, and the old generation's objects are
   * deleted only after the new record is durable. A generation is therefore a
   * prefix that is either wholly referenced or wholly garbage, which is what
   * makes an orphan sweep possible at all and why no lifecycle rule is needed
   * to bound growth.
   */
  /**
   * Delete every generation this box has superseded, then forget them.
   *
   * THE STATE ROW IS THE TRUTH, which is what makes this safe against the very
   * crash that created the orphan: the ids were recorded before the delete, the
   * referenced generation is never among them, and a crash mid-sweep simply
   * leaves the remainder for the next run. It cannot be done by listing —
   * `backups/<uuid>/` is a namespace shared by every box, so a sweep that
   * enumerated it would be looking at other boxes' live generations.
   */
  const sweepOrphans = async (state: ChainState): Promise<void> => {
    const orphans = state.orphans ?? [];
    if (orphans.length === 0) return;
    for (const generation of orphans) {
      await ports.deleteObjects([
        baseObjectKey(generation),
        deltaObjectKey(generation),
        metadataObjectKey(generation),
      ]);
    }
    await ports.writeState({ ...state, orphans: undefined });
    ports.log(`${orphans.length} superseded generation(s) deleted`);
  };

  const commitChain = async (
    previous: ChainState | null,
    version: string,
    rebasing = false,
    upperMark?: string,
  ): Promise<CheckpointOutcome> => {
    const first = previous === null;
    const fresh = first || rebasing;
    const chainId = fresh ? crypto.randomUUID() : previous.base.id;

    // PROVE IT BEFORE WRITING IT.
    //
    // A chain the platform cannot mount is worse than extraction: it is
    // written, recorded, and then unreadable for the rest of the box's life,
    // because a box attaches the way it was checkpointed. The mode is decided
    // once, here, at the only moment it becomes permanent — and it is decided by
    // performing the mount rather than by asking the platform whether it thinks
    // it could. A capability that reports itself present and then refuses is
    // exactly the shape that produced a silent no-op on a live container.
    //
    // One mount and one unmount, once per box.
    if (first) {
      try {
        await ports.mountStore(chainId);
        await ports.unmountStore();
      } catch (error) {
        // Where extraction is not permitted, a failed proof is a FAILED
        // CHECKPOINT carrying the platform's own reason. Converting it into
        // extraction is what hid a real mount failure on a deployed probe until
        // it resurfaced as lost data two phases later.
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
    let layer: { bytes: number };
    if (fresh) {
      layer = await stageAndPut(
        baseObjectKey(chainId), DEVBOX_WORKDIR, ports.archiveExcludes(),
      );
    } else {
      // The upper is the path THIS strategy passed to the mount command, not one
      // re-derived from mount options: fuse-overlayfs publishes no `upperdir`, so
      // re-deriving it would find nothing and refuse every delta on the
      // production image. The mount line is still what proves an overlay exists
      // to have a changed set at all.
      if (!isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR)) {
        throw new Error(
          `${DEVBOX_WORKDIR} is not an overlay mount, so there is no changed set to archive. `
          + 'Refusing to checkpoint rather than silently archiving the whole tree.',
        );
      }
      // THE SAME EXCLUDES AS THE BASE, and the reason is measured rather than
      // argued. This used to pass `[]`, on the reasoning that "an exclude here
      // would drop a file the caller really did write" — sound in isolation and
      // wrong in combination, because it left the policy applied to ONE side of
      // two comparisons.
      //
      // It delivered no saving: a base excludes `node_modules`, and the delta
      // then carried it again on EVERY tick, which is the archive that actually
      // repeats. The policy's whole promise was kept exactly once.
      //
      // And it cost, through the rebase trigger. `shouldRebase` asks
      // `delta > k * base`, so an excludes-applied base (small) against a
      // delta measured without them (large) satisfies it essentially always: a
      // full re-archive at every quiesce, which the unexcluded arm never
      // performs. Verdict-2 measured the excluded chain arm at 1.42x tick time
      // and 1.34x class-A of the plain one — the excludes were paying for
      // rebases, not for filtering.
      //
      // Applying them to both sides makes the two archives commensurable and
      // finally delivers the saving. It also makes durability HONEST: a tree
      // the base drops was already lost at the next rebase, so "durable in the
      // delta" was true only until one happened. A box whose `dist/` really is
      // the work overrides `archiveExcludes` and keeps it in both.
      layer = await stageAndPut(
        deltaObjectKey(chainId), upperDir, ports.archiveExcludes(),
      );
    }

    // State first, cleanup second. A delta's key was already replaced by the
    // atomic PUT above; a rebase wrote a whole new generation and leaves the old
    // one standing until the record naming its replacement is durable, so a
    // crash leaves two generations and never zero.
    const committed: ChainState = {
      mode: 'chain',
      rev: (previous?.rev ?? 0) + 1,
      base: fresh ? { id: chainId, bytes: layer.bytes } : previous.base,
      delta: fresh ? undefined : { bytes: layer.bytes },
      at: ports.now(),
      changeVersion: version,
      upperMark,
      orphans: rebasing && previous !== null
        ? [...(previous.orphans ?? []), previous.base.id]
        : previous?.orphans,
      lastFailure: undefined,
    };
    await ports.writeState(committed);
    // The superseded generation is NAMED in the record before it is deleted, so
    // a crash in the window that used to orphan it forever leaves an id the
    // next sweep can find. UNCONDITIONAL, not just on the rebase that created
    // the orphan: a crash between the flip and the delete is followed by
    // ordinary checkpoints, and a sweep that only ran on rebases would wait for
    // the next one to strand the bytes further. It costs nothing when the list
    // is empty. See `ChainState.orphans`.
    await sweepOrphans(committed);
    await ports.exec(`rm -rf ${shellPath(stageDir)}`);
    ports.log(
      `${DEVBOX_WORKDIR} ${rebasing ? 'rebase' : first ? 'base' : 'delta'} ${chainId} `
      + `(${layer.bytes} bytes)`,
    );
    return {
      kind: 'committed',
      reason: undefined,
      bytes: committed.base.bytes + (committed.delta?.bytes ?? 0),
      // The landed count from this commit's own upload, which the chain knows
      // exactly because it has a commit boundary. Not derivable from `bytes`:
      // a rebase supersedes a generation, so held bytes can fall while this
      // rises.
      movedBytes: layer.bytes,
    };
  };

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    const idle = { reason: undefined, bytes: undefined, movedBytes: 0 };
    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }
    const state = await ports.readState();

    // ATTACHMENT COMES FIRST, ahead of the change gate, and this order is the
    // point. A chain that already has a base keeps its changed set in the
    // overlay's upper directory; with no overlay there is no changed set, so
    // every later answer would be about the wrong thing. A live container
    // answered a forced checkpoint 'unchanged' while its work directory was not
    // attached at all — a broken box wearing a healthy answer. Asked here, that
    // box reports a failure, which is what it is.
    const overlayMounted = isOverlayMounted(await shell.readMounts(), DEVBOX_WORKDIR);
    if (state !== null && state.mode === 'chain' && !overlayMounted) {
      return await recordCheckpointFailure(
        ports,
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
      return await recordCheckpointFailure(ports, state, `checkChanges failed: ${describe({ cause: error })}`);
    }

    // THE CHANGE GATE NEEDS SOMETHING TO BE RELATIVE TO.
    //
    // `checkChanges` answers "has this path changed since the version you hold".
    // A box that has never checkpointed holds no version, and the SDK's answer
    // to a call with no `since` is `unchanged`: it is ESTABLISHING a baseline,
    // not reporting on one. Consulting the gate there is how a fresh box writes
    // files, stops, and saves nothing while every call reports success — which
    // is what a live container did, answering a forced checkpoint `unchanged`
    // seconds after a file was created.
    //
    // So with no baseline, content IS the change, and the only question left is
    // whether there is any content at all.
    // THE CHANGED SET IS THE UPPER, so that is what the skip gate asks about.
    //
    // A chain-mode box with an overlay archives `upperDir`, and the SDK's change
    // check was being asked about the merged `/workspace` instead. On a deployed
    // run it answered `unchanged` for five consecutive ticks while npm wrote 400
    // MiB into that upper, and the next workload's first tick then committed 487
    // MiB of it — five ticks of real work that only survived because a later
    // tick happened to catch it. A tick that CANNOT DECIDE must commit: an
    // unreadable fingerprint is empty, an empty fingerprint never matches, and
    // the gate falls through to archiving.
    const mark = overlayMounted ? await shell.upperFingerprint() : '';
    if (overlayMounted) {
      if (mark !== '' && mark === state?.upperMark) {
        return { kind: 'skipped', ...idle, reason: 'work directory is unchanged' };
      }
      if (kind === 'tick'
        && !shouldCheckpoint('changed', state?.at ?? 0, ports.now(), ports.checkpointIntervalMs())) {
        return { kind: 'skipped', ...idle, reason: 'within the minimum checkpoint interval' };
      }
      try {
        return await commitChain(state, version, shouldRebase(state, kind), mark);
      } catch (error) {
        return await recordCheckpointFailure(ports, state, describe({ cause: error }));
      }
    }
    const comparable = state?.changeVersion !== undefined;
    const effective: ChangeStatus = comparable ? change : 'changed';
    if (comparable && change === 'unchanged') {
      // Advance the watermark so the next check is relative to now. A change
      // this code DECLINED to archive must not advance it, or it is forgotten.
      await ports.writeState({ ...state, changeVersion: version });
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
      // A box attaches the way it was checkpointed, so the mode comes from the
      // record. A box with no record has its mode DECIDED by commitChain, which
      // proves the platform can serve a chain before writing one.
      if (state?.mode === 'extract') return await commitExtract(state, version);
      return await commitChain(state, version, shouldRebase(state, kind));
    } catch (error) {
      return await recordCheckpointFailure(ports, state, describe({ cause: error }));
    }
  };

  const discard = async (): Promise<void> => {
    const state = await ports.readState();
    if (state === null) return;
    // Objects first, then the pointer. Reversed, a crash orphans both: nothing
    // would name the objects and nothing would delete them.
    // Every generation the record still NAMES goes with it — the orphans a
    // rebase crash left behind included. clearState erases the only record
    // naming them, and `backups/<uuid>/` is shared by every box, so a leak
    // here was permanent by construction: no sweep may ever list them.
    await ports.deleteObjects([state.base.id, ...(state.orphans ?? [])].flatMap(
      (generation) => [
        baseObjectKey(generation),
        deltaObjectKey(generation),
        metadataObjectKey(generation),
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
 * The skip-gate fingerprint command over `sourceDir`.
 *
 * The prior count/bytes/newest-mtime summary could collide for distinct trees:
 * a rename preserved every field, and a same-path rewrite whose mtime was
 * restored preserved them too — both skipped forever while content changed.
 * This hashes a canonical per-path record of inode, type, mode, size,
 * sub-second mtime, sub-second CHANGE time, symlink target and path instead.
 * It stays O(entries), not O(bytes), while any of those moves changes the mark;
 * an mtime restoration cannot hide a write, because the write itself moved
 * ctime.
 *
 * A failed walk returns no mark. Callers must treat that as undecidable and
 * checkpoint; `pipefail` prevents `sort` or `sha256sum` from hiding `find`'s
 * failure.
 */
export function upperFingerprintCommand(sourceDir: string): string {
  const walk = `find ${shellPath(sourceDir)} -mindepth 1 `
    + `-printf '%i\\0%y\\0%m\\0%s\\0%T@\\0%C@\\0%l\\0%p\\0' 2>/dev/null `
    + '| LC_ALL=C sort -z | sha256sum | cut -c1-64';
  return `bash -o pipefail -c ${shellPath(walk)}`;
}
