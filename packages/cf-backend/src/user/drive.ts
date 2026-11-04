import { Cause, Effect } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  addSkill, ChunkedUpload, deleteDriveEntry, driveFailure, DriveUploadTargetSchema, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, listDrive, makeDriveFolder, markAsSkill, normalizeDrivePath, packDriveFolder, receiveDriveUpload, renameDriveEntry, SHARED_DRIVE_UNBOUND, SKILL_FOLDER_FILE, type DriveFailure, type DriveListing, type DriveUploadOutcome, type DriveUploadTarget, type MarkedSkill, type MossaicVfs, type UserCaller,
} from '@kinu.run/core';
import type { UserObjectHost } from './user-host';
import type { UserLimits } from './limits';

export type DriveAnswer<Value> = { readonly ok: true; readonly value: Value } | ({ readonly ok: false } & DriveFailure);

/** One bounded chunk of a Drive upload. `offset === 0` (re)starts the transfer
 *  and fixes its target; every later chunk is checked against that target. */
export interface DriveChunkWrite {
  target: DriveUploadTarget;
  transferId: string;
  offset: number;
  chunk: Uint8Array;
  final: boolean;
}

/** A pasted SKILL.md rides one RPC argument, so it stays far under the structured-clone ceiling. */
const DRIVE_PASTED_SKILL_MAX_BYTES = 256 * 1024;

export interface UserDriveHost extends Pick<UserObjectHost, 'requireTier' | 'sqlx'> {
  /** This account's own id, the name it is addressed by: the tenant its workspaces mount at `/shared`. */
  accountId(): string;
  driveFor(tenant: string): MossaicVfs | null;
  /** The account's limits: an upload's first chunk asks for new bytes; its last marks the Drive's size to be read again. */
  readonly limits: Pick<UserLimits, 'admitNewBytes' | 'storeChanged'>;
}

/** The account's Drive. */
export class UserDrive {
  constructor(private readonly host: UserDriveHost) {}

  private drive(): Effect.Effect<MossaicVfs, KinuError> {
    return Effect.suspend(() => {
      if (this.host.sqlx(`SELECT 1 FROM user_profile WHERE id = 1`).length === 0) {
        return Effect.fail(new KinuError('missing', 'the Drive opens once the account has signed in'));
      }

      const files = this.host.driveFor(this.host.accountId());

      return files === null ? Effect.fail(new KinuError('unavailable', SHARED_DRIVE_UNBOUND)) : Effect.succeed(files);
    });
  }

  /** `op` over the account's Drive, its answer or its failure in the Drive's own words: a file plane's errno is kept. */
  private driveOp<Value>(caller: UserCaller, op: (drive: MossaicVfs) => Effect.Effect<Value, KinuError>): Effect.Effect<DriveAnswer<Value>> {
    return Effect.flatMap(Effect.promise(() => this.host.requireTier(caller, 'drive')), () => Effect.catchCause(
      Effect.map(Effect.flatMap(this.drive(), op), (value): DriveAnswer<Value> => ({ ok: true, value })),
      (failed) => Effect.succeed<DriveAnswer<Value>>({ ok: false, ...driveFailure({ cause: Cause.squash(failed) }) }),
    ));
  }

  async drive_list(caller: UserCaller, path: string): Promise<DriveAnswer<DriveListing>> {
    return settle(this.driveOp(caller, (drive) => Effect.promise(() => listDrive(drive, path))));
  }

  async drive_mkdir(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return settle(this.driveOp(caller, (drive) => Effect.promise(() => makeDriveFolder(drive, path))));
  }

  async drive_rename(caller: UserCaller, from: string, to: string): Promise<DriveAnswer<void>> {
    return settle(this.driveOp(caller, (drive) => Effect.promise(() => renameDriveEntry(drive, from, to))));
  }

  async drive_delete(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return settle(this.driveOp(caller, (drive) => Effect.promise(() => deleteDriveEntry(drive, path))));
  }

  async drive_markAsSkill(caller: UserCaller, path: string): Promise<DriveAnswer<MarkedSkill>> {
    return settle(this.driveOp(caller, (drive) => Effect.promise(() => markAsSkill(drive, path))));
  }

  async drive_addSkill(caller: UserCaller, skillFile: string): Promise<DriveAnswer<MarkedSkill>> {
    return settle(this.driveOp(caller, (drive) => {
      const bytes = new TextEncoder().encode(skillFile);

      return bytes.byteLength > DRIVE_PASTED_SKILL_MAX_BYTES
        ? Effect.fail(new KinuError('budget', `a pasted SKILL.md is at most ${String(DRIVE_PASTED_SKILL_MAX_BYTES)} bytes`))
        : Effect.promise(() => addSkill(drive, [{ path: SKILL_FOLDER_FILE, bytes }], null));
    }));
  }

  // Chunked transfers as in files-routes.ts: one transfer id per request, an `offset === 0` chunk
  // (re)starts it, and the first chunk fixes the target, checked on every later chunk.
  private readonly driveUploads = new Map<string, { readonly target: DriveUploadTarget; readonly upload: ChunkedUpload }>();

  private readonly driveDownloads = new Map<string, { readonly path: string; readonly bytes: Uint8Array }>();

  async drive_writeChunk(caller: UserCaller, write: DriveChunkWrite): Promise<DriveAnswer<DriveUploadOutcome>> {
    const { transferId, offset } = write;
    const { driveUploads, host } = this;

    return settle(this.driveOp(caller, (drive) => Effect.gen(function* () {
      const target = v.parse(DriveUploadTargetSchema, write.target);

      if (!transferId) return yield* new KinuError('bad_input', 'upload transfer id required');
      let row = driveUploads.get(transferId);

      if (offset === 0) {
        // New bytes only: the Drive's files stay readable and removable at any limit.
        yield* Effect.promise(() => host.limits.admitNewBytes());
        row = { target, upload: new ChunkedUpload() };
        driveUploads.set(transferId, row);
      } else if (!row || JSON.stringify(row.target) !== JSON.stringify(target)) {
        return yield* new KinuError('bad_input', 'file transfer out of sync: no matching open upload');
      }

      const step = row.upload.chunk(offset, write.chunk, write.final);

      if (row.upload.done) driveUploads.delete(transferId);

      if ('error' in step) return yield* new KinuError('bad_input', step.error);

      if (!('assembled' in step)) return { ok: true } satisfies DriveUploadOutcome;
      const received = yield* Effect.promise(() => receiveDriveUpload(drive, target, step.assembled));

      host.limits.storeChanged('drive');

      return received;
    })));
  }

  async drive_abortUpload(caller: UserCaller, transferId: string): Promise<void> {
    await this.host.requireTier(caller, 'drive');
    this.driveUploads.get(transferId)?.upload.abort();
    this.driveUploads.delete(transferId);
  }

  /** The snapshot is taken here, so later ranges cannot observe a newer write. */
  async drive_startDownload(caller: UserCaller, path: string, transferId: string): Promise<DriveAnswer<{ size: number; name: string }>> {
    const { driveDownloads } = this;

    return settle(this.driveOp(caller, (drive) => Effect.gen(function* () {
      if (!transferId) return yield* new KinuError('bad_input', 'download transfer id required');
      const clean = normalizeDrivePath(path);
      const stat = yield* Effect.promise(async () => drive.stat(clean));

      if (stat === null) return yield* new KinuError('missing', `no such entry: ${clean}`);
      const leaf = clean === '/' ? 'drive' : clean.slice(clean.lastIndexOf('/') + 1);

      if ((stat.type === 'directory')) {
        const bytes = yield* Effect.promise(() => packDriveFolder(drive, clean, FILE_TRANSFER_MAX_BYTES));
        driveDownloads.set(transferId, { path: clean, bytes });

        return { size: bytes.byteLength, name: `${leaf}.zip` };
      }

      if (stat.size > FILE_TRANSFER_MAX_BYTES) {
        return yield* new KinuError('budget', `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`);
      }

      const raw = yield* Effect.promise(async () => drive.readFile(clean));
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
      driveDownloads.set(transferId, { path: clean, bytes });

      return { size: bytes.byteLength, name: leaf };
    })));
  }

  async drive_readChunk(caller: UserCaller, transferId: string, offset: number, length: number): Promise<DriveAnswer<{ bytes: Uint8Array }>> {
    return settle(this.driveOp(caller, () => {
      const open = this.driveDownloads.get(transferId);

      if (!open) return Effect.fail(new KinuError('bad_input', 'file transfer out of sync: no matching open download'));

      if (offset < 0 || length <= 0 || length > FILE_CHUNK_BYTES) return Effect.fail(new KinuError('bad_input', 'chunk range out of bounds'));

      if (offset >= open.bytes.byteLength) return Effect.fail(new KinuError('bad_input', 'chunk offset past end of file'));
      const bytes = open.bytes.subarray(offset, offset + length);

      if (offset + bytes.byteLength >= open.bytes.byteLength) this.driveDownloads.delete(transferId);

      return Effect.succeed({ bytes });
    }));
  }

  async drive_abortDownload(caller: UserCaller, transferId: string): Promise<void> {
    await this.host.requireTier(caller, 'drive');
    this.driveDownloads.delete(transferId);
  }
}
