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
 * The gap is not a property of the workspace filesystem. This file used to say
 * the workspace plane "stores current state only (no history/content-
 * addressing)", which was true of the hand-rolled `SqliteFS` that was deleted on
 * 2026-08-12 and is false of what replaced it: Nimbus's VFS is content-addressed
 * (`inodes(path, content_id)` over `file_chunks(content_id, chunk_id, data)`,
 * with a `content_lifecycle` GC table), so a snapshot of that plane is a copy of
 * the small inode index and no blob copies at all. What it needs is content
 * pinning — Nimbus reclaims content no *inode* references, so checkpoint rows
 * alone would not keep blobs alive — and that is a Nimbus-side change, not an
 * absence of structure. Sandbox files are a third machine's and need the sandbox
 * to snapshot.
 */

/** Bounded retention: checkpoints kept per working directory. One knob. */
export const DEFAULT_CHECKPOINT_KEEP = 50;

/** The honest degraded-mode message when git is not installed. */
export const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';

export interface CheckpointTurnMeta {
  turnId: string;
  sessionId: string;
}

export interface FileCheckpointEntry {
  /** Commit sha in the shadow store (content-addressed snapshot id). */
  id: string;
  /** Absolute path of the snapshotted working directory. */
  dir: string;
  /** Snapshot time (ms epoch). */
  at: number;
  turnId: string | null;
  sessionId: string | null;
  reason: string;
}

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
 * `proteus connect``.
 */
export interface FileCheckpointListing {
  availability: CheckpointAvailability;
  /** Newest first. Empty AND available means this turn changed no device files. */
  entries: FileCheckpointEntry[];
}

export type FileRestoreKind = 'modify' | 'create' | 'delete';

/** One file the restore will touch, in restore direction: `create` re-creates
 *  a file deleted since the checkpoint, `delete` removes a file created since,
 *  `modify` rewrites changed content. */
export interface FileRestoreChange {
  path: string;
  kind: FileRestoreKind;
}

export interface FileRestorePlan {
  dir: string;
  id: string;
  files: FileRestoreChange[];
}

export interface FileRestoreResult {
  dir: string;
  id: string;
  files: FileRestoreChange[];
  /** Safety snapshot taken just before restoring — undo-the-undo handle. */
  preRestoreId: string | null;
}

export interface CheckpointAvailability {
  available: boolean;
  reason?: string;
}

/**
 * The checkpoint engine seam. `beginTurn` resets the per-turn dedup;
 * `ensureCheckpoint` snapshots a directory at most once per turn and never
 * throws (missing git or an un-snapshottable directory degrade to a no-op so
 * the mutation it precedes is never blocked).
 */
export interface FileCheckpoints {
  beginTurn(meta: CheckpointTurnMeta): void;
  /** Snapshot `dir` if not already done this turn. Resolves the checkpoint id,
   *  or null when skipped (already snapshotted, unchanged, or unavailable). */
  ensureCheckpoint(dir: string, reason?: string): Promise<string | null>;
  /** All checkpoints for this agent across working directories, newest first. */
  list(limit?: number): Promise<FileCheckpointEntry[]>;
  /** What restoring to a checkpoint would change, relative to current state. */
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  /** Restore `dir` exactly to the checkpoint (content, deletions, additions).
   *  Takes a pre-restore safety snapshot first. */
  restore(dir: string, id: string): Promise<FileRestoreResult>;
  status(): Promise<CheckpointAvailability>;
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
    else deleted += 1;
  }
  return { modified, created, deleted };
}
