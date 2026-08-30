/**
 * Strategy three: a content-addressed overlay.
 *
 * attach     mount this box's prefix read-write beside the container, replay
 *            the journal entries newer than the folded cursor onto a fresh
 *            upper, and only then lay fuse-overlayfs over the folded `tree/`.
 *            Recovery is O(pending change), not O(tree), and the unchanged case
 *            is FIXED: two remote operations — one cursor GET and one `journal/`
 *            LIST that names no batch — plus the two-mount stack, the store then
 *            the overlay. No prefix inventory, no payload byte. A million-object
 *            tree and a fresh prefix pay the same operation and mount counts and
 *            the same zero payload; they differ only in whether a cursor object
 *            exists to read, which is bytes in the log of the sequence.
 * checkpoint('tick')
 *            scan the upper, stage new chunk blobs, append ONE journal object
 *            per batch of 64 entries. Blob before journal. Does not fold.
 *            Class-A cost is (new chunk blobs) + ceil(p / 64), never one PUT
 *            per changed path: an npm-shaped tick touches thousands of paths
 *            and almost none of their bytes.
 * checkpoint('quiesce')
 *            the tick, then fold the journal into `tree/`, advance the cursor
 *            and reap the blobs nothing reaches any more.
 * discard    delete the prefix.
 *
 * WHERE THE BYTES MOVE, and the whole point of this file's shape: nowhere near
 * here. Every byte of a scan, a stage, a fold and a replay is handled by
 * `cas/overlay-runner.ts` running IN the container beside the mounted prefix.
 * This adapter mounts, invokes it once per operation, validates the receipt it
 * printed, and writes down what the box now knows. It holds no chunk, no
 * digest script and no shell template, because a Durable Object that streams a
 * tree through its own isolate is bounded by that isolate rather than by the
 * change.
 *
 * MEASURED LOCAL, 2026-08-24, labelled LOCAL. Docker + minio + kernel overlay
 * + local squashfs tools. No Worker, no Durable Object, no Container, no R2.
 * `wrangler dev --remote` cannot host those and is not a substitute. The
 * milliseconds do not travel; the shape does.
 *
 *   Recovery with pending held at ~20 files (prototype `.results/`):
 *     16 MiB tree  — overlay 8 ms, squashfs extract 13 ms, image 2.55 MiB
 *     78 MiB tree  — overlay 6 ms, squashfs extract 59 ms, image 12.8 MiB
 *     235 MiB tree — overlay 6 ms, squashfs extract 146 ms, image 38.3 MiB
 *   Tree grew 14.7×; recovery stayed flat.
 *
 *   LOCAL invariants: native 15 hold / 0 fail / 1 unsupported; s3fs 13 / 1 / 2.
 *   After fold, a restore replayed 0 entries and fetched 720 B, which that run
 *   spent on the cursor AND the manifest. A rename uploaded 0 content bytes
 *   (blob reuse).
 *
 *   THAT BYTE FIGURE IS SUPERSEDED and is kept only as the labelled record of
 *   what was measured. The manifest is no longer on this path: a restore reads
 *   `cursor.json` and lists `journal/`, and `tests/overlay-runner.test.ts`
 *   asserts that trace exactly, against prefixes differing 100× in object
 *   count. Nothing re-measured the LOCAL harness after the change, so the
 *   millisecond rows above stand as they were taken and the byte row does not
 *   describe this release.
 */

import * as v from 'valibot';

import { describeThrown as describe } from './lifecycle';
import { shouldCheckpoint } from './snapshot-chain';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  recordCheckpointFailure,
} from './storage';
import type { OverlayCasState } from './cas/state';
import type { OverlayRunnerReceipt } from './cas/overlay-runner';

/**
 * Where this box's whole prefix is mounted read-write inside the container.
 *
 * ONE mount, not two. It is the runner's `--store`, and the folded `tree/`
 * under it is the overlay's lower, so the bytes a fold writes and the bytes the
 * lower serves are the same objects reached through the same mount. Credentials
 * never leave the Durable Object.
 */
export const CAS_STORE_MOUNT = `${DEVBOX_RUNTIME_DIR}/cas-store`;

/** The materialized tree inside that mount: the overlay's read-only lower. */
export const CAS_TREE_MOUNT = `${CAS_STORE_MOUNT}/tree`;

/** The overlay upper. The runner scans it and replays into it; nothing else
 *  writes there. Only `/workspace` is supplied by the image — this path is ours
 *  and does not survive a container replacement. */
export const CAS_UPPER_DIR = `${DEVBOX_RUNTIME_DIR}/cas-upper`;

/** fuse-overlayfs's own scratch directory, which must share a filesystem with
 *  the upper for its renames to be atomic. */
export const CAS_WORK_DIR = `${DEVBOX_RUNTIME_DIR}/cas-work`;

/** Where the runner bundle is baked into the devbox image. One path, because
 *  there is one runner: it is `cas/overlay-runner.ts` bundled for Bun. */
export const CAS_RUNNER_PATH = '/opt/kinu/overlay-cas-runner.bundle.mjs';

/** What one runner invocation is asked to do. `fold` is a checkpoint plus the
 *  fold, the cursor advance and the reap, in that order. One list, so the type
 *  the ports take and the picklist the receipt is parsed against cannot drift. */
const OVERLAY_CAS_OPERATIONS = ['checkpoint', 'fold', 'restore'] as const;

export type OverlayCasOperation = (typeof OVERLAY_CAS_OPERATIONS)[number];

export interface OverlayCasPorts {
  containerRunning(): boolean;
  /**
   * Mount this box's prefix read-write at {@link CAS_STORE_MOUNT} and create
   * the directories the runner and the overlay need.
   *
   * Release through the SDK (`unmountBucket`), never a raw fusermount3: the SDK
   * keeps its own registry of the mounts it made and a kernel-level release
   * leaves it claiming the path forever.
   */
  mountStore(): Promise<void>;
  unmountStore(): Promise<void>;
  /** Lay fuse-overlayfs over {@link CAS_TREE_MOUNT} and {@link CAS_UPPER_DIR}
   *  at the work directory. Throws with the container's own words when the
   *  mount is refused. */
  mountOverlay(): Promise<void>;
  unmountOverlay(): Promise<void>;
  /**
   * Is the work directory an overlay mount on THIS container right now?
   *
   * Read from `/proc/mounts`, which is the fact rather than a note about the
   * fact: a spot container can be replaced between two calls, and a marker this
   * object kept would then describe a disk that no longer exists.
   */
  overlayMounted(): Promise<boolean>;
  /**
   * Run the bundled runner once, for one operation, and hand back exactly what
   * it printed. The receipt is parsed here, never by the host: what a valid
   * receipt is belongs to the strategy that acts on it.
   */
  invokeRunner(
    operation: OverlayCasOperation,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Objects and bytes this box's prefix holds right now. Read through the store
   * binding, not through the mount: the question is what is durable, and the
   * mount's answer would come from a cache.
   *
   * CHECKPOINT ONLY, AND ATTACH MUST NEVER CALL IT. This is a LIST over the
   * whole prefix, so its cost rises with the tree — and attach used to call it
   * twice, once to describe an already-mounted overlay and once to classify a
   * fresh one, which put an O(tree) term in the one operation whose whole claim
   * is that recovery is O(pending change). A checkpoint has already scanned the
   * upper and moved bytes when it asks, and `CheckpointOutcome.bytes` is the
   * cross-strategy figure that answer feeds; attach classifies from the restore
   * receipt instead.
   */
  inventory(): Promise<{ objects: number; bytes: number }>;
  /** Delete every object under this box's prefix. Returns how many went. */
  clearPrefix(): Promise<number>;
  readState(): Promise<OverlayCasState | null>;
  writeState(state: OverlayCasState): Promise<void>;
  clearState(): Promise<void>;
  checkpointIntervalMs(): number;
  now(): number;
  log(message: string): void;
}

const receiptCount = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** The receipt contract, restated where it is consumed rather than imported as
 *  a parser: these bytes crossed a process boundary, so they are untrusted
 *  input here even though one repository holds both ends. `strictObject` is the
 *  point — a receipt carrying a field this release does not know came from a
 *  runner this release cannot reason about. */
const ReceiptSchema = v.strictObject({
  operation: v.picklist(OVERLAY_CAS_OPERATIONS),
  entries: receiptCount,
  movedBytes: receiptCount,
  foldedEntries: receiptCount,
  sweptBlobs: receiptCount,
  foldedSeq: receiptCount,
});

/**
 * The runner's one line of stdout, or a refusal naming what was wrong with it.
 *
 * A receipt is the ONLY evidence this object gets that bytes moved, so an
 * unparseable one is a failed checkpoint, never an assumed-empty one. Reading
 * malformed stdout as "nothing changed" would report a skip for work that
 * either half-happened or never ran.
 */
function readReceipt(
  operation: OverlayCasOperation,
  result: { stdout: string; stderr: string; exitCode: number },
): OverlayRunnerReceipt {
  if (result.exitCode !== 0) {
    throw new Error(
      `the overlay-cas runner failed during ${operation} (exit ${result.exitCode}): `
      + `${result.stderr.trim() || result.stdout.trim() || 'no diagnostic'}`,
    );
  }
  // The runner prints its receipt as the last thing it writes, so anything
  // ahead of the first brace is container noise rather than a malformed row.
  const start = result.stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`the overlay-cas ${operation} produced no receipt: ${result.stdout.trim()}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout.slice(start));
  } catch (error) {
    throw new Error(
      `the overlay-cas ${operation} receipt is not JSON: ${describe({ cause: error })}`,
      { cause: error },
    );
  }
  const parsed = v.safeParse(ReceiptSchema, decoded);
  if (!parsed.success) {
    throw new Error(
      `the overlay-cas ${operation} receipt does not match its schema: `
      + parsed.issues.map(issue => `${issue.path?.map(step => String(step.key)).join('.') ?? ''} `
        + `${issue.message}`).join('; '),
    );
  }
  if (parsed.output.operation !== operation) {
    throw new Error(
      `the overlay-cas ${operation} returned a receipt for ${parsed.output.operation}, which is `
      + 'not evidence about the operation that was asked for',
    );
  }
  return parsed.output;
}

export function overlayCasStorage(ports: OverlayCasPorts): DevboxStorage {
  const runner = async (operation: OverlayCasOperation): Promise<OverlayRunnerReceipt> =>
    readReceipt(operation, await ports.invokeRunner(operation));

  /**
   * THE ORDERING INVARIANT: replay, then mount.
   *
   * The upper is an ordinary directory until fuse-overlayfs takes it as a
   * parameter, so nothing requires the overlay to exist before the replay. A
   * version that mounted FIRST left a half-replayed upper under a live overlay
   * whenever the replay threw, and the next attach saw a mounted overlay and
   * early-returned over it — a workspace silently missing changes the journal
   * had recorded, reporting an outcome that reads like success. Mounting LAST
   * makes "the overlay is mounted" imply "the replay finished", so the early
   * return below is correct by construction and needs no marker.
   *
   * THE COST INVARIANT: NOTHING HERE SCALES WITH THE TREE. An unchanged attach
   * is two remote operations — one cursor GET and one `journal/` LIST that
   * returns no batch — plus the fixed two-mount stack: zero payload bytes,
   * whether the prefix holds one object or a million. It was not: this body
   * called `inventory()` on both
   * of its paths, which is a LIST over the whole prefix, so the operation whose
   * headline is O(pending change) carried an O(tree) term that grew with every
   * fold. The classification those listings served now comes from the restore
   * receipt, which reports facts the replay had already read.
   */
  const attach = async (): Promise<AttachOutcome> => {
    if (await ports.overlayMounted()) {
      // NO STORE FACTS ON THIS PATH, deliberately. This attach did not run the
      // runner — re-replaying would undo the ordering invariant above — so it
      // holds no receipt, and the only way to describe the prefix would be the
      // prefix listing this operation must not pay for. What the caller needs is
      // that the workspace is attached, and that is exactly what it gets.
      ports.log(`${DEVBOX_WORKDIR} already attached — attach skipped`);
      return { kind: 'already-attached', detail: 'overlay-cas overlay already mounted' };
    }
    // A mount left by a previous container generation is released first. The
    // host swallows "not mounted", which is the ordinary case on a fresh spot
    // container, and reports anything else.
    await ports.unmountStore();
    await ports.mountStore();
    const restored = await runner('restore');
    await ports.mountOverlay();
    if (!await ports.overlayMounted()) {
      throw new Error(
        `attach of ${DEVBOX_WORKDIR} for overlay-cas reported success, but ${DEVBOX_WORKDIR} is `
        + 'not an overlay mount.',
      );
    }
    ports.log(
      `${DEVBOX_WORKDIR} attached (overlay-cas, folded through ${restored.foldedSeq}, `
      + `${restored.entries} pending replayed before the mount)`,
    );
    // FRESH IS A CURSOR AND A COUNT, not an object count. A store nothing has
    // folded has no cursor, and journal seqs start at one, so `foldedSeq === 0`
    // is exactly "never folded"; no pending entries on top of that is exactly
    // "nothing recorded here yet". Both facts were read by the replay that just
    // ran. Asking the prefix how many objects it holds answered the same
    // question at a cost that rose with the answer.
    if (restored.foldedSeq === 0 && restored.entries === 0) {
      return { kind: 'empty', detail: 'overlay-cas empty overlay attached' };
    }
    return {
      kind: 'attached',
      detail: `overlay-cas folded ${restored.foldedSeq} ${restored.entries}P`,
    };
  };

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }
    const previous = await ports.readState();
    if (!await ports.overlayMounted()) {
      // Through recordFailure like every other refusal, so the reason reaches
      // durable state. A repeatedly unattached box is exactly the one whose
      // failures have to stay visible after the object is evicted.
      return await recordCheckpointFailure(
        ports,
        previous,
        `${DEVBOX_WORKDIR} is not an overlay mount, so nothing written there reaches the `
        + 'journal. Refusing to report a checkpoint for a work directory that is not attached.',
      );
    }
    // THE INTERVAL GATE RUNS FIRST, because the scan and the byte work are now
    // one invocation. Asking the runner whether anything changed IS the tick,
    // so a tick inside the interval must decline before it pays for it.
    if (kind === 'tick'
      && !shouldCheckpoint('changed', previous?.lastCheckpointAt ?? 0, ports.now(),
        ports.checkpointIntervalMs())) {
      return {
        kind: 'skipped',
        reason: 'within the minimum checkpoint interval',
        bytes: undefined,
        movedBytes: 0,
      };
    }

    let receipt: OverlayRunnerReceipt;
    try {
      receipt = await runner(kind === 'quiesce' ? 'fold' : 'checkpoint');
    } catch (error) {
      return await recordCheckpointFailure(ports, previous, describe({ cause: error }));
    }

    const held = await ports.inventory();
    // Nothing changed is the more specific fact, so it is reported ahead of any
    // commit. `lastCheckpointAt` is deliberately NOT advanced here: a no-op
    // tick that moved the interval forward would delay the next real change by
    // a whole interval.
    //
    // A QUIESCE NEVER TAKES THIS BRANCH. It folded, advanced the cursor and
    // reaped, so reporting a skip would say nothing happened after the durable
    // state of the store had already changed — the verdict2 defect, where a
    // marker that had been journalled, folded and cursored came back as
    // `skipped 0B /workspace holds no objects yet` and was then lost.
    //
    // BOTH FACTS ARE REQUIRED, because `movedBytes` now measures the bytes the
    // run actually WROTE rather than the logical size of the journalled files. A skip
    // asserts it moved nothing — see CheckpointOutcome — and a run that
    // journalled no entry can still have written its scan cache: a redrive whose
    // journal batch already landed re-measures the upper, finds the pending
    // journal already holds it, and refreshes the rows so the next tick does not
    // re-digest the whole workspace. Reporting a skip for that would deny bytes
    // that are durable, on the strength of a counter that used to be blind to
    // them.
    if (kind === 'tick' && receipt.entries === 0 && receipt.movedBytes === 0) {
      return {
        kind: 'skipped',
        reason: held.objects === 0
          ? `${DEVBOX_WORKDIR} holds no objects yet`
          : 'work directory is unchanged',
        bytes: undefined,
        movedBytes: 0,
      };
    }

    ports.log(
      `${DEVBOX_WORKDIR} ${kind} checkpoint committed (overlay-cas, ${receipt.entries} entries, `
      + `${receipt.movedBytes}B written, cursor ${receipt.foldedSeq}; folded `
      + `${receipt.foldedEntries} entries; swept ${receipt.sweptBlobs} orphan blobs; store view `
      + `${held.objects} objects ${held.bytes}B)`,
    );
    // THE RECEIPT IS THE COMMIT, so this row cannot un-commit it. It is a
    // cursor and a cleared stamp — the runner has already folded, advanced its
    // own cursor and reaped, and this row names no object. A write that fails
    // therefore costs one early re-check on the next tick and a refusal that
    // stays visible one interval too long; answering `failed` instead would
    // deny bytes that are durable, and throwing would deny them AND lose the
    // classification.
    try {
      await ports.writeState({ lastCheckpointAt: ports.now(), lastFailure: undefined });
    } catch (error) {
      ports.log(
        `${DEVBOX_WORKDIR} that commit stands and its cursor could not be written: `
        + describe({ cause: error }),
      );
    }
    // THE ORACLE IS THE RECEIPT, not what inventory() counts. inventory()
    // answers about the prefix; a checkpoint's job is to say whether the store
    // now holds the change, and reading `objects === 0` as "nothing was
    // committed" is what let a box report a skip after the blob, the journal
    // batch, the fold and the cursor had all landed.
    //
    // `movedBytes` is the runner's own `bytesPut` delta, so it names every
    // object this operation wrote — chunk blobs, journal batches, the scan
    // cache, and on a quiesce the tree writes, the manifest and the cursor. It
    // was the sum of the journalled files' logical sizes, which billed a rename
    // for content it deduplicated away and billed nothing for the metadata
    // objects that really landed.
    return { kind: 'committed', reason: undefined, bytes: held.bytes, movedBytes: receipt.movedBytes };
  };

  const detach = async (): Promise<void> => {
    if (!ports.containerRunning()) return;
    if (await ports.overlayMounted()) await ports.unmountOverlay();
    await ports.unmountStore();
  };

  const discard = async (): Promise<void> => {
    await detach();
    const deleted = await ports.clearPrefix();
    await ports.clearState();
    ports.log(`${DEVBOX_WORKDIR} discarded (overlay-cas, ${deleted} objects deleted)`);
  };

  return { attach, checkpoint, detach, discard };
}

export {
  advanceCursor,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
} from './cas';
export {
  normalizeOverlayCasState,
  type OverlayCasState,
  type UpperSignature,
} from './cas/state';
