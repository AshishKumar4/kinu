import * as v from 'valibot';
// Shadow-git snapshots of a working directory before each turn's first mutation, for /undo. Covers only
// the user's device plane: `workspace` and `@sandbox` turns have no checkpoint (see FileCheckpointListing).

/** Checkpoints kept per working directory. */
export const DEFAULT_CHECKPOINT_KEEP = 50;

export const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';

export const CHECKPOINTS_NO_DEVICE = 'no device connected — connect one with `kinu connect`';

export interface CheckpointTurnMeta {
  turnId: string;
  sessionId: string;
}

/** `id` is the shadow-store commit sha; `at` is ms epoch. */
export const FileCheckpointEntrySchema = v.object({
  id: v.string(), dir: v.string(), at: v.number(), turnId: v.nullable(v.string()),
  sessionId: v.nullable(v.string()), reason: v.string(),
});

export type FileCheckpointEntry = v.InferOutput<typeof FileCheckpointEntrySchema>;

/** Availability is separate from entries: an empty list with no reachable device is not "this turn
 *  changed nothing". */
export interface FileCheckpointListing {
  availability: CheckpointAvailability;
  /** Newest first. Empty AND available means this turn changed no device files. */
  entries: FileCheckpointEntry[];
}

const FILE_RESTORE_KINDS = ['modify', 'create', 'delete'] as const;

export type FileRestoreKind = (typeof FILE_RESTORE_KINDS)[number];

/** In restore direction: `create` re-creates a file deleted since the checkpoint, `delete` the reverse. */
const FileRestoreChangeSchema = v.object({ path: v.string(), kind: v.picklist(FILE_RESTORE_KINDS) });

export type FileRestoreChange = v.InferOutput<typeof FileRestoreChangeSchema>;

export const FileRestorePlanSchema = v.object({ dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema) });

export type FileRestorePlan = v.InferOutput<typeof FileRestorePlanSchema>;

/** `preRestoreId` is the safety snapshot taken just before restoring: the undo-the-undo handle. */
export const FileRestoreResultSchema = v.object({
  dir: v.string(), id: v.string(), files: v.array(FileRestoreChangeSchema), preRestoreId: v.nullable(v.string()),
});

export type FileRestoreResult = v.InferOutput<typeof FileRestoreResultSchema>;

export const CheckpointAvailabilitySchema = v.object({ available: v.boolean(), reason: v.optional(v.string()) });

export type CheckpointAvailability = v.InferOutput<typeof CheckpointAvailabilitySchema>;

/** Checkpoint store reads, over the owner's device (cloud) or the local git engine. */
export interface FileCheckpointReads {
  status(): Promise<CheckpointAvailability>;
  /** Newest first. `turnId` filters in the store before `limit` truncates: retention is per directory but
   *  `limit` is global, so client-side filtering loses still-restorable turns. */
  list(opts?: { limit?: number; turnId?: string }): Promise<FileCheckpointEntry[]>;
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  /** Takes a pre-restore safety snapshot first. */
  restore(dir: string, id: string): Promise<FileRestoreResult>;
}

export const CHECKPOINTS_UNCONFIGURED = 'checkpoints are not configured for this session';

export function checkpointAvailability(reads: FileCheckpointReads | null): Promise<CheckpointAvailability> {
  return reads === null ? Promise.resolve({ available: false, reason: CHECKPOINTS_UNCONFIGURED }) : reads.status();
}

export function deviceHistoryNote(listing: FileCheckpointListing): string | null {
  const { availability, entries } = listing;

  if (!availability.available) {
    if (availability.reason === CHECKPOINTS_NO_DEVICE) return null;

    return `Your device keeps no file history for this turn (${availability.reason ?? 'unavailable'}), so its files cannot be restored.`;
  }

  return entries.length === 0 ? 'This turn changed no files on your devices, so there is nothing to restore.' : null;
}

export async function fileCheckpointListing(
  reads: FileCheckpointReads | null, query: { limit?: number; turnId?: string },
): Promise<FileCheckpointListing> {
  const availability = await checkpointAvailability(reads);

  if (reads === null || !availability.available) return { availability, entries: [] };

  return { availability, entries: await reads.list(query) };
}

export interface FileCheckpoints extends FileCheckpointReads {
  beginTurn(meta: CheckpointTurnMeta): void;
  /** Snapshot `dir` once per turn; never throws. Null when skipped (already done, unchanged, unavailable). */
  ensureCheckpoint(dir: string, reason?: string): Promise<string | null>;
  /** Nearest marker dir, for snapshot targeting of direct file writes. */
  workdirForPath(path: string): string;
}

/** Per-frame hint on mutating device RPCs; the daemon snapshots first, deduped on (agent, dir, turnId). */
export interface DeviceCheckpointHint {
  agent: string;
  turnId: string | null;
  sessionId: string | null;
  /** Null for `writeFile` means derive the project dir from the target path. */
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
