import { PLATFORM_CATALOG } from '../platform-catalog';
import { renderThrownChain } from '../obs/index';

/**
 * Durability for a sandbox container's `/workspace`, as decisions rather than
 * plumbing.
 *
 * A sandbox Durable Object and its container do not share a lifecycle. The
 * object survives; the container sleeps after ~10 minutes idle and its
 * filesystem goes with it, and Cloudflare's own backup documentation is explicit
 * that a restore does not survive either — "the FUSE mount is lost when the
 * sandbox sleeps or restarts. Re-restore from the backup handle to recover."
 * Restoring is therefore a per-container-start obligation, not a bootstrap, and
 * the only hook that fires per container start is `Container.onStart`, which
 * `@cloudflare/containers` awaits inside `ctx.blockConcurrencyWhile`. Nothing can
 * observe the container while that gate is held; that is what makes it the only
 * correct place, and what makes an unbounded await there dangerous.
 *
 * Everything here is a decision over an injected port. The backend adapter
 * supplies the SDK calls, the container's own storage, and the R2 reads; it
 * makes no choices. Two consequences worth stating because they are the whole
 * point of the shape:
 *
 *  * The snapshot state is keyed to the CONTAINER, never to an agent. It used to
 *    live in an agent's `agent_config`, which is per-agent: a head or
 *    subordinate riding its parent's container read its own empty row, concluded
 *    there was nothing to restore, and latched that for the container's life.
 *  * Every failure that is not "nothing has ever been snapshotted" throws.
 *    Failing the container start is retryable and visible. Continuing against an
 *    empty workspace is neither, and it is what happened before.
 */

/** Options for the container's directory snapshot (subset of the SDK's
 *  BackupOptions — see @cloudflare/sandbox `BackupOptions`). */
export interface BackupOptions {
  /** Absolute directory to back up (e.g. '/workspace'). */
  dir: string;
  /** Move bytes via the BACKUP_BUCKET R2 binding instead of presigned URLs.
   *  The binding path restores by EXTRACTION (`unsquashfs`); the presigned path
   *  restores by MOUNTING the archive (`squashfuse` + `fuse-overlayfs`), which
   *  is the constant-work restore. See workspaceRestoreMode. */
  localBucket?: boolean;
  /** Honor .gitignore when archiving. */
  gitignore?: boolean;
  /** Wildcard excludes passed to mksquashfs (e.g. ['node_modules','*.log']). */
  excludes?: readonly string[];
  /** Backup lifetime in seconds (enforced on restore). */
  ttl?: number;
  /** Optional label. */
  name?: string;
  /** mksquashfs compressor. The SDK defaults to `lz4`, the fastest to write and
   *  the largest to move; every byte here is paid twice — once on upload, and
   *  again on every container start that restores it. */
  compression?: { format: 'gzip' | 'lz4' | 'zstd'; threads?: number };
}

/** Serializable snapshot handle — store it, pass it back to restore. */
export interface DirectoryBackup {
  readonly id: string;
  readonly dir: string;
  readonly localBucket?: boolean;
}

export const WORKSPACE_BACKUP_DIR = '/workspace';
/** Minimum wall-clock gap between two /workspace snapshots, and the period the
 *  container's scheduler ticks at. Both are this one number: a tick that fires
 *  early (a container restart re-arms the schedule) must not double-snapshot. */
export const BACKUP_MIN_INTERVAL_MS = 5 * 60_000;
/** Snapshot lifetime (R2). 30 days — pair with an R2 lifecycle GC rule.
 *  The SDK's own default is 3 days, enforced at RESTORE time only, so a
 *  workspace left alone over a long weekend comes back refusing to restore. */
export const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Derived files never travel: they are reproducible, they dominate the byte
 *  count, and they are the difference between a snapshot that restores inside
 *  the container-start gate and one that does not. */
const WORKSPACE_BACKUP_EXCLUDES = ['node_modules', '.git', '*.log', '.cache'] as const;

/** What the container's retained change state says about a directory since a
 *  previous check. Mirrors @cloudflare/sandbox `CheckChangesResult.status`;
 *  `resync` means that state was itself lost (expired, or the container
 *  restarted), so the directory must be treated as changed. */
export type WorkspaceChangeStatus = 'unchanged' | 'changed' | 'resync';

/** Snapshot only when the container says /workspace actually changed AND the
 *  period has elapsed. `unchanged` is the whole efficiency argument: an agent
 *  workspace is idle for most of its wall-clock life, and an unchanged tick
 *  costs no mksquashfs, no upload and no new R2 object. Pure → unit-testable. */
export function shouldBackupWorkspace(
  change: WorkspaceChangeStatus,
  lastBackupAt: number,
  now: number,
  minIntervalMs: number = BACKUP_MIN_INTERVAL_MS,
): boolean {
  if (change === 'unchanged') return false;
  return now - lastBackupAt >= minIntervalMs;
}

/** Canonical snapshot options for /workspace. */
export function workspaceBackupOptions(localBucket: boolean): BackupOptions {
  return {
    dir: WORKSPACE_BACKUP_DIR,
    localBucket,
    gitignore: true,
    excludes: WORKSPACE_BACKUP_EXCLUDES,
    ttl: BACKUP_TTL_SECONDS,
    compression: { format: 'zstd' },
  };
}

/** Which of the SDK's two restore implementations a handle will take.
 *  `mount` costs one squashfuse plus one fuse-overlayfs mount however large the
 *  archive is; `extract` runs `unsquashfs` over every byte and needs room for a
 *  second copy. The mode is a property of the HANDLE, not of the current
 *  configuration, because the SDK routes on `backup.localBucket`. */
export function workspaceRestoreMode(backup: DirectoryBackup): 'mount' | 'extract' {
  return backup.localBucket === true ? 'extract' : 'mount';
}

/** Budget for the whole restore, transfer included.
 *
 *  `onStart` runs inside `ctx.blockConcurrencyWhile`, and `do.block_concurrency.cancel_ms`
 *  is when the runtime stops waiting: it cancels the block and RESETS the object.
 *  Abandoning before that reports a failed container start — retried on the next
 *  start — instead of a reset, so the budget is derived from that entry rather
 *  than retyped beside it, and a correction to the catalog moves this with it.
 *  The 5 s margin is for our own teardown and logging inside the same gate. */
const RESTORE_DEADLINE_MARGIN_MS = 5_000;
export const WORKSPACE_RESTORE_DEADLINE_MS =
  PLATFORM_CATALOG['do.block_concurrency.cancel_ms'].limit.value - RESTORE_DEADLINE_MARGIN_MS;

/** True when `dir` is currently an overlay mount, read from /proc/mounts.
 *  A restore call returns `{ success: true }` from the DO side; that says the
 *  call did not throw, not that the container ended up with the archive
 *  mounted. This is the postcondition that tells those two apart. Field order
 *  is fstab's — source, mountpoint, fstype — and mountpoints octal-escape
 *  spaces. */
export function isDirectoryOverlayMounted(procMounts: string, dir: string): boolean {
  for (const line of procMounts.split('\n')) {
    const [, mountpoint, fstype] = line.trim().split(/\s+/);
    if (mountpoint === undefined || fstype === undefined) continue;
    if (mountpoint.replace(/\\040/g, ' ') !== dir) continue;
    if (fstype.includes('overlay')) return true;
  }
  return false;
}

/** R2 object layout the SDK writes a snapshot to, relative to the bucket root.
 *  Restated here because the SDK does not export it, and restated as a CHECK
 *  rather than as a write path: nothing here creates these keys, so a rename in
 *  a future SDK version makes the pre-restore probe report "archive object is
 *  missing" and fail the container start loudly. It cannot make it pass. */
export interface SnapshotObjectKeys {
  readonly archive: string;
  readonly metadata: string;
}

export function snapshotObjectKeys(backupId: string): SnapshotObjectKeys {
  return { archive: `backups/${backupId}/data.sqsh`, metadata: `backups/${backupId}/meta.json` };
}

/** Why a stored snapshot must not be restored from, or null when it is sound.
 *
 *  This is a PRE-restore probe, not a post-create one: the SDK already verifies
 *  its own upload against the size the container measured and deletes both
 *  objects if that check fails. What it cannot know is that the handle it handed
 *  back is still backed by anything days later — an R2 lifecycle rule, a manual
 *  bucket clean, or a half-deleted generation all leave a handle whose archive
 *  is gone. Restoring from one of those is what used to fail quietly. Two cheap
 *  reads answer it before the container-start gate spends its whole budget on a
 *  transfer that cannot succeed. */
export function snapshotIntegrityFailure(input: {
  declaredBytes: number | undefined;
  storedBytes: number | undefined;
}): string | null {
  const { declaredBytes, storedBytes } = input;
  if (declaredBytes === undefined) return 'metadata object is missing or has no sizeBytes';
  if (storedBytes === undefined) return 'archive object is missing from the bucket';
  if (declaredBytes <= 0) return `metadata declares ${declaredBytes} bytes`;
  if (storedBytes !== declaredBytes) {
    return `archive is ${storedBytes} bytes, metadata declares ${declaredBytes}`;
  }
  return null;
}

/** What the abandoned container-start work rejected with, if it ever settled.
 *  A rejection reason is whatever the thrower threw, so it stays unparsed and
 *  named rather than pretending to be an `Error`. */
export interface LateStartFailure {
  readonly reason: unknown;
}

/** Run the container-start hook's work under a hard budget.
 *
 *  A container's `onStart` is awaited inside `ctx.blockConcurrencyWhile`
 *  (@cloudflare/containers `Container.start`/`startAndWaitForPorts`), which is
 *  exactly what makes it the right place to restore a workspace — nothing can
 *  observe the container until it returns — and exactly what makes an unbounded
 *  await there dangerous: `do.block_concurrency.cancel_ms` is where the runtime
 *  cancels the block and RESETS the object. Detaching the work is not an option
 *  either; a promise left floating
 *  in a Durable Object is cancelled on eviction with its rejection swallowed by
 *  the runtime, so the restore would silently not happen.
 *
 *  So: bound it. Overrunning fails THIS container start, which the SDK surfaces
 *  as a retryable 503 and the next start retries. `onOverrun` receives the
 *  outcome of the abandoned work if it ever settles — abandoning a value is not
 *  the same as discarding an error, and the late error is the diagnostic. */
export async function withContainerStartDeadline<T>(
  label: string,
  budgetMs: number,
  work: () => Promise<T>,
  onOverrun: (failure: LateStartFailure) => void,
): Promise<T> {
  let overran = false;
  const started = work().catch((reason: LateStartFailure['reason']) => {
    if (!overran) throw reason;
    onOverrun({ reason });
    // The race has already rejected on the deadline, so this branch has no value
    // to produce; it exists only so the late failure is reported instead of
    // surfacing as an unhandled rejection.
    return Promise.withResolvers<T>().promise;
  });
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    overran = true;
    reject(new Error(
      `${label} exceeded its ${budgetMs}ms container-start budget. The hook runs inside `
      + 'blockConcurrencyWhile, which the runtime cancels by resetting the Durable '
      + 'Object, so this start is failed instead; it will be retried on the next start.',
    ));
  }, budgetMs);
  try {
    return await Promise.race([started, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── the container's own snapshot record ───────────────────────────────────

/** Everything a container needs to know about its own /workspace history.
 *  One record, one writer, replaced whole. */
export interface WorkspaceSnapshotState {
  /** Handle the SDK gave us for the newest sound snapshot. */
  readonly backup: DirectoryBackup;
  /** Epoch ms the snapshot completed — the period gate reads this. */
  readonly at: number;
  /** Archive size R2 held when the snapshot was recorded. */
  readonly sizeBytes: number;
  /** `checkChanges` version this snapshot is relative to. Advanced only when a
   *  snapshot succeeds or the directory was reported unchanged: advancing it
   *  after a change we declined to snapshot would discard the change signal. */
  readonly changeVersion: string | undefined;
  /** Last attempt that failed, kept because the container's alarm loop reduces a
   *  thrown scheduled callback to a `console.error` — durable state is the only
   *  way a failing periodic snapshot stays visible. */
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

/** Why a restore did not transfer anything, or that it did. Enumerated so the
 *  gate can assert every branch is exercised rather than assuming it. */
export const WORKSPACE_RESTORE_OUTCOMES = ['no-snapshot', 'already-restored', 'restored'] as const;
export type WorkspaceRestoreOutcomeKind = (typeof WORKSPACE_RESTORE_OUTCOMES)[number];

export interface WorkspaceRestoreOutcome {
  readonly kind: WorkspaceRestoreOutcomeKind;
  /** Present for every kind but `no-snapshot`. */
  readonly backupId: string | undefined;
  readonly mode: 'mount' | 'extract' | undefined;
  readonly bytes: number | undefined;
}

export const WORKSPACE_SNAPSHOT_OUTCOMES = [
  'not-running', 'unchanged', 'within-period', 'snapshotted', 'failed',
] as const;
export type WorkspaceSnapshotOutcomeKind = (typeof WORKSPACE_SNAPSHOT_OUTCOMES)[number];

export interface WorkspaceSnapshotOutcome {
  readonly kind: WorkspaceSnapshotOutcomeKind;
  readonly backupId: string | undefined;
  readonly bytes: number | undefined;
  /** Set for `failed`; the reason is also persisted on the state record. */
  readonly reason: string | undefined;
}

/** Everything the decisions need from the world. The adapter implements it and
 *  decides nothing. */
export interface WorkspaceSnapshotPorts {
  /** Is the container up right now? A scheduled tick can outlive it, and waking
   *  a sleeping container to ask whether it changed would keep it alive forever. */
  containerRunning(): boolean;
  /** Snapshots move through the R2 binding (extract restore) rather than a
   *  presigned URL (mount restore). Derived from configuration by the adapter. */
  bucketBinding(): boolean;
  readState(): Promise<WorkspaceSnapshotState | null>;
  writeState(state: WorkspaceSnapshotState): Promise<void>;
  createBackup(options: BackupOptions): Promise<DirectoryBackup>;
  restoreBackup(backup: DirectoryBackup): Promise<{ success: boolean }>;
  checkChanges(dir: string, since: string | undefined):
    Promise<{ status: WorkspaceChangeStatus; version: string }>;
  /** `/proc/mounts` as the container sees it. */
  readMounts(): Promise<string>;
  /** Entry count of the workspace directory — the extract-mode postcondition. */
  countWorkspaceEntries(): Promise<number>;
  /** Size R2 currently holds for the snapshot's archive object. */
  archiveBytes(backupId: string): Promise<number | undefined>;
  /** `sizeBytes` from the snapshot's metadata object. */
  declaredBytes(backupId: string): Promise<number | undefined>;
  deleteSnapshot(backupId: string): Promise<void>;
  now(): number;
  log(message: string): void;
}

export interface WorkspaceSnapshots {
  /** Bring /workspace back to the newest sound snapshot. Throws on anything but
   *  success or "nothing has ever been snapshotted". */
  restore(): Promise<WorkspaceRestoreOutcome>;
  /** One periodic tick: gate on `checkChanges` and the period, then snapshot. */
  snapshotIfDue(): Promise<WorkspaceSnapshotOutcome>;
}

export function createWorkspaceSnapshots(ports: WorkspaceSnapshotPorts): WorkspaceSnapshots {
  const workspaceIsMounted = async (): Promise<boolean> =>
    isDirectoryOverlayMounted(await ports.readMounts(), WORKSPACE_BACKUP_DIR);

  /** Is the stored snapshot still backed by R2? Answered before the
   *  container-start budget is spent on a transfer that cannot succeed. */
  const probe = async (state: WorkspaceSnapshotState): Promise<string | null> => {
    const storedBytes = await ports.archiveBytes(state.backup.id);
    if (storedBytes !== undefined && storedBytes === state.sizeBytes) return null;
    return snapshotIntegrityFailure({
      declaredBytes: await ports.declaredBytes(state.backup.id),
      storedBytes,
    }) ?? `archive is ${storedBytes} bytes, but this container recorded ${state.sizeBytes}`;
  };

  const restore = async (): Promise<WorkspaceRestoreOutcome> => {
    const state = await ports.readState();
    if (state === null) {
      return { kind: 'no-snapshot', backupId: undefined, mode: undefined, bytes: undefined };
    }
    const { backup } = state;
    const mode = workspaceRestoreMode(backup);

    // Idempotence without a marker: ask the container. `onStart` is
    // at-least-once per container start (both start paths in
    // @cloudflare/containers call it unconditionally after an already-running
    // fast path), and a stored "restored" marker is exactly what latched last
    // time. A mount that already landed is visible in /proc/mounts.
    if (mode === 'mount' && await workspaceIsMounted()) {
      ports.log(`/workspace already mounted from ${backup.id} — restore skipped`);
      return {
        kind: 'already-restored', backupId: backup.id, mode, bytes: state.sizeBytes,
      };
    }

    const unsound = await probe(state);
    if (unsound !== null) {
      throw new Error(
        `Cannot restore ${WORKSPACE_BACKUP_DIR} from snapshot ${backup.id}: ${unsound}. `
        + 'Refusing to start the container rather than run an agent against an empty '
        + 'workspace. Clear the snapshot record on this sandbox object to start fresh.',
      );
    }

    const result = await ports.restoreBackup(backup);
    if (!result.success) {
      throw new Error(
        `Restore of ${WORKSPACE_BACKUP_DIR} from snapshot ${backup.id} reported failure.`,
      );
    }

    // A successful call is not a landed restore. This is the difference between
    // observing the system and observing the observer.
    const landed = mode === 'mount'
      ? await workspaceIsMounted()
      : (await ports.countWorkspaceEntries()) > 0;
    if (!landed) {
      throw new Error(
        `Restore of ${WORKSPACE_BACKUP_DIR} from snapshot ${backup.id} reported success, but `
        + (mode === 'mount'
          ? `${WORKSPACE_BACKUP_DIR} is not an overlay mount.`
          : `${WORKSPACE_BACKUP_DIR} is empty.`),
      );
    }
    ports.log(`/workspace restored from ${backup.id} (${mode}, ${state.sizeBytes} bytes)`);
    return { kind: 'restored', backupId: backup.id, mode, bytes: state.sizeBytes };
  };

  const snapshot = async (
    previous: WorkspaceSnapshotState | null,
    version: string,
  ): Promise<WorkspaceSnapshotOutcome> => {
    const backup = await ports.createBackup(workspaceBackupOptions(ports.bucketBinding()));
    const storedBytes = await ports.archiveBytes(backup.id);
    const unsound = snapshotIntegrityFailure({
      declaredBytes: await ports.declaredBytes(backup.id),
      storedBytes,
    });
    if (unsound !== null || storedBytes === undefined) {
      await ports.deleteSnapshot(backup.id);
      throw new Error(`snapshot ${backup.id} is not sound: ${unsound ?? 'archive is missing'}`);
    }
    await ports.writeState({
      backup, sizeBytes: storedBytes, at: ports.now(), changeVersion: version,
      lastFailure: undefined,
    });
    ports.log(`/workspace snapshot ${backup.id} (${storedBytes} bytes)`);
    // Retention: exactly one live generation. The superseded archive is dropped
    // only after the replacement is durably recorded, so a crash between the two
    // leaves two archives and one handle — never zero.
    if (previous !== null) await ports.deleteSnapshot(previous.backup.id);
    return {
      kind: 'snapshotted', backupId: backup.id, bytes: storedBytes, reason: undefined,
    };
  };

  const snapshotIfDue = async (): Promise<WorkspaceSnapshotOutcome> => {
    const idle = { backupId: undefined, bytes: undefined, reason: undefined };
    if (!ports.containerRunning()) return { kind: 'not-running', ...idle };

    const state = await ports.readState();
    let change: WorkspaceChangeStatus;
    let version: string;
    try {
      const checked = await ports.checkChanges(WORKSPACE_BACKUP_DIR, state?.changeVersion);
      change = checked.status;
      version = checked.version;
    } catch (error) {
      return await fail(state, `checkChanges failed: ${renderThrownChain({ cause: error })}`);
    }

    if (!shouldBackupWorkspace(change, state?.at ?? 0, ports.now())) {
      if (change === 'unchanged') {
        // Advance the watermark so the next check is relative to now. A change
        // we declined to snapshot must NOT advance it, or it is forgotten.
        if (state !== null) await ports.writeState({ ...state, changeVersion: version });
        return { kind: 'unchanged', ...idle };
      }
      return { kind: 'within-period', ...idle };
    }

    try {
      return await snapshot(state, version);
    } catch (error) {
      return await fail(state, renderThrownChain({ cause: error }));
    }
  };

  const fail = async (
    state: WorkspaceSnapshotState | null,
    reason: string,
  ): Promise<WorkspaceSnapshotOutcome> => {
    if (state !== null) {
      await ports.writeState({ ...state, lastFailure: { at: ports.now(), reason } });
    }
    ports.log(`/workspace snapshot failed: ${reason}`);
    return { kind: 'failed', backupId: undefined, bytes: undefined, reason };
  };

  return { restore, snapshotIfDue };
}

