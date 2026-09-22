import * as v from 'valibot';
/**
 * File checkpoints — the shadow-git snapshot seam (Hermes checkpoint_manager
 * pattern). Invisible infrastructure: backends snapshot a real working
 * directory into a hidden git store before the first mutating operation of
 * each agent turn, so any turn's file effects are cheaply reversible (/undo,
 * the web "restore files" affordance). The LLM never sees any of this.
 *
 * Implementations:
 *   - cli-backend `createHostCheckpoints` — shells out to git on the user's
 *     machine (local agents).
 *   - pc-agent daemon — the same store format in dependency-free JS; cloud
 *     agents reach it through the device tunnel (`checkpointList` /
 *     `checkpointPlan` / `checkpointRestore` RPCs, plus a per-frame
 *     `checkpoint` hint that triggers the pre-mutation snapshot).
 *
 * ## What this covers, and what it does not
 *
 * Exactly one plane: the **user's own device**. The snapshot hint is attached
 * only to `exec` and `writeFile` frames on the device transport
 * (`cf-backend/src/device-transport.ts`), so a turn that ran on the `workspace`
 * plane — the authoritative filesystem — or on `@sandbox` has no checkpoint and
 * can never have one. That is a real gap and callers must be able to tell it
 * apart from "this turn changed nothing", which is what
 * {@link FileCheckpointListing} exists for: an empty list is ambiguous and was
 * being read to the operator as a statement about his turn.
 *
 * The gap is not a property of the workspace filesystem. Nimbus's VFS is
 * content-addressed (`inodes(path, content_id)` over
 * `file_chunks(content_id, chunk_id, data)`, with a `content_lifecycle` GC
 * table), so a snapshot of that plane is a copy of the small inode index and no
 * blob copies at all. What it needs is content pinning — Nimbus reclaims
 * content no *inode* references, so checkpoint rows alone would not keep blobs
 * alive — and that is a Nimbus-side change, not an absence of structure.
 * Sandbox files are a third machine's and need the sandbox to snapshot.
 */

/** Bounded retention: checkpoints kept per working directory. One knob. */
export const DEFAULT_CHECKPOINT_KEEP = 50;

/** The honest degraded-mode message when git is not installed. */
export const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';

export interface CheckpointTurnMeta {
  turnId: string;
  sessionId: string;
}

/** `id` is the commit sha in the shadow store (a content-addressed snapshot
 *  id), `dir` the absolute path of the snapshotted working directory, `at` the
 *  snapshot time in ms epoch. */
export const FileCheckpointEntrySchema = v.object({
  id: v.string(), dir: v.string(), at: v.number(), turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()), reason: v.string(),
});

export type FileCheckpointEntry = v.InferOutput<typeof FileCheckpointEntrySchema>;

/**
 * What the operator's client needs in one round trip: whether the checkpoint
 * store is reachable at all, and what it holds.
 *
 * The two are separate because collapsing them is what produced
 * `No file checkpoint for this turn. It changed no device files.` on a turn that
 * had plainly written files. The list was empty because no device was linked, and
 * an empty list was read as a claim about the turn. A caller that has
 * `availability.available === false` can say the true thing — and `reason`
 * already carries it, e.g. `no device connected — connect one with
 * `kinu connect``.
 */
export interface FileCheckpointListing {
  availability: CheckpointAvailability;
  /** Newest first. Empty AND available means this turn changed no device files. */
  entries: FileCheckpointEntry[];
}

const FILE_RESTORE_KINDS = ['modify', 'create', 'delete'] as const;

export type FileRestoreKind = (typeof FILE_RESTORE_KINDS)[number];

/** One file the restore will touch, in restore direction: `create` re-creates
 *  a file deleted since the checkpoint, `delete` removes a file created since,
 *  `modify` rewrites changed content. */
const FileRestoreChangeSchema = v.object({ path: v.string(), kind: v.picklist(FILE_RESTORE_KINDS) });

export type FileRestoreChange = v.InferOutput<typeof FileRestoreChangeSchema>;

export const FileRestorePlanSchema = v.object({ dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema) });

export type FileRestorePlan = v.InferOutput<typeof FileRestorePlanSchema>;

/** `preRestoreId` is the safety snapshot taken just before restoring: the
 *  undo-the-undo handle. */
export const FileRestoreResultSchema = v.object({
  dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema), preRestoreId: v.nullable(v.string()),
});

export type FileRestoreResult = v.InferOutput<typeof FileRestoreResultSchema>;

export const CheckpointAvailabilitySchema = v.object({ available: v.boolean(), reason: v.optional(v.string()) });

export type CheckpointAvailability = v.InferOutput<typeof CheckpointAvailabilitySchema>;

/**
 * The checkpoint engine seam. `beginTurn` resets the per-turn dedup;
 * `ensureCheckpoint` snapshots a directory at most once per turn and never
 * throws (missing git or an un-snapshottable directory degrade to a no-op so
 * the mutation it precedes is never blocked).
 */
/** What a checkpoint store answers about itself: the reads every surface
 *  makes, on a cloud workspace over the owner's device and on a local session
 *  over its own git engine. */
export interface FileCheckpointReads {
  status(): Promise<CheckpointAvailability>;
  /**
   * Checkpoints for this agent across working directories, newest first.
   *
   * `turnId` FILTERS IN THE STORE, and that is the point rather than a
   * convenience: retention is per working directory (`DEFAULT_CHECKPOINT_KEEP`)
   * while `limit` is global across all of them, so a caller that reads a window
   * and filters by turn itself loses any turn whose checkpoint is older than
   * `limit` OTHER directories' checkpoints — while that checkpoint still exists
   * and is still restorable. The web client did exactly that with a limit of 200
   * and rendered the empty result as "This turn changed no files on your
   * machine". Filtering before truncating makes an empty answer mean what it
   * says: this turn has no checkpoint, not this reader could not reach it.
   */
  list(opts?: { limit?: number; turnId?: string }): Promise<FileCheckpointEntry[]>;
  /** What restoring to a checkpoint would change, relative to current state. */
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  /** Restore `dir` exactly to the checkpoint (content, deletions, additions).
   *  Takes a pre-restore safety snapshot first. */
  restore(dir: string, id: string): Promise<FileRestoreResult>;
}

/** The reason a session with no checkpoint store answers every read with. */
export const CHECKPOINTS_UNCONFIGURED = 'checkpoints are not configured for this session';

export function checkpointAvailability(reads: FileCheckpointReads | null): Promise<CheckpointAvailability> {
  return reads === null ? Promise.resolve({ available: false, reason: CHECKPOINTS_UNCONFIGURED }) : reads.status();
}

/** The store's reachability and what it holds, in one answer (see
 *  {@link FileCheckpointListing} for why the two are never collapsed). */
export async function fileCheckpointListing(
  reads: FileCheckpointReads | null, query: { limit?: number; turnId?: string },
): Promise<FileCheckpointListing> {
  const availability = await checkpointAvailability(reads);

  if (reads === null || !availability.available) return { availability, entries: [] };

  return { availability, entries: await reads.list(query) };
}

export interface FileCheckpoints extends FileCheckpointReads {
  beginTurn(meta: CheckpointTurnMeta): void;
  /** Snapshot `dir` if not already done this turn. Resolves the checkpoint id,
   *  or null when skipped (already snapshotted, unchanged, or unavailable). */
  ensureCheckpoint(dir: string, reason?: string): Promise<string | null>;
  /** Project root a file path belongs to (nearest marker dir), for snapshot
   *  targeting of direct file writes. */
  workdirForPath(path: string): string;
}

/**
 * The per-frame snapshot hint a cloud agent attaches to mutating device RPCs
 * (`exec` / `writeFile`). The daemon snapshots before performing the
 * operation, deduped on (agent, dir, turnId) — zero extra round-trips, no
 * consent interplay, invisible to the model.
 */
export interface DeviceCheckpointHint {
  agent: string;
  turnId: string | null;
  sessionId: string | null;
  /** Working directory to snapshot for `exec`; `writeFile` derives the
   *  project dir from the target path when this is null. */
  dir: string | null;
}

export function summarizeRestorePlan(files: ReadonlyArray<FileRestoreChange>) {
  let modified = 0, created = 0, deleted = 0;

  for (const f of files) {
    if (f.kind === 'modify') modified += 1;
    else if (f.kind === 'create') created += 1;
    else if (f.kind === 'delete') deleted += 1;
  }

  return { modified, created, deleted };
}
