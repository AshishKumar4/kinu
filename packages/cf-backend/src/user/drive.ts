import { KinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  addSkill, ChunkedUpload, deleteDriveEntry, driveFailure, DriveUploadTargetSchema, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, listDrive, makeDriveFolder, markAsSkill, normalizeDrivePath, packDriveFolder, receiveDriveUpload, renameDriveEntry, SHARED_DRIVE_UNBOUND, SKILL_FOLDER_FILE, type DriveFailure, type DriveListing, type DriveUploadOutcome, type DriveUploadTarget, type MarkedSkill, type MossaicVfs, type UserCaller,
} from '@kinu.run/core';
import { deriveUserId } from '../auth/store';
import type { UserObjectHost } from './user-host';

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
  driveFor(tenant: string): MossaicVfs | null;
}

/** The account's Drive. */
export class UserDrive {
  constructor(private readonly host: UserDriveHost) {}

  private async drive(): Promise<MossaicVfs> {
    const row = this.host.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0];

    if (!row) throw new KinuError('missing', 'the Drive opens once the account has signed in');
    const files = this.host.driveFor(await deriveUserId(row.email));

    if (files === null) throw new KinuError('unavailable', SHARED_DRIVE_UNBOUND);

    return files;
  }

  private async driveOp<Value>(caller: UserCaller, op: (drive: MossaicVfs) => Promise<Value>): Promise<DriveAnswer<Value>> {
    await this.host.requireTier(caller, 'drive');

    try {
      return { ok: true, value: await op(await this.drive()) };
    } catch (cause) {
      return { ok: false, ...driveFailure({ cause }) };
    }
  }

  async drive_list(caller: UserCaller, path: string): Promise<DriveAnswer<DriveListing>> {
    return this.driveOp(caller, (drive) => listDrive(drive, path));
  }

  async drive_mkdir(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => makeDriveFolder(drive, path));
  }

  async drive_rename(caller: UserCaller, from: string, to: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => renameDriveEntry(drive, from, to));
  }

  async drive_delete(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => deleteDriveEntry(drive, path));
  }

  async drive_markAsSkill(caller: UserCaller, path: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.driveOp(caller, (drive) => markAsSkill(drive, path));
  }

  async drive_addSkill(caller: UserCaller, skillFile: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.driveOp(caller, (drive) => {
      const bytes = new TextEncoder().encode(skillFile);

      if (bytes.byteLength > DRIVE_PASTED_SKILL_MAX_BYTES) {
        throw new KinuError('budget', `a pasted SKILL.md is at most ${String(DRIVE_PASTED_SKILL_MAX_BYTES)} bytes`);
      }

      return addSkill(drive, [{ path: SKILL_FOLDER_FILE, bytes }], null);
    });
  }

  // Chunked transfers as in files-routes.ts: one transfer id per request, an `offset === 0` chunk
  // (re)starts it, and the first chunk fixes the target, checked on every later chunk.
  private readonly driveUploads = new Map<string, { readonly target: DriveUploadTarget; readonly upload: ChunkedUpload }>();

  private readonly driveDownloads = new Map<string, { readonly path: string; readonly bytes: Uint8Array }>();

  async drive_writeChunk(caller: UserCaller, write: DriveChunkWrite): Promise<DriveAnswer<DriveUploadOutcome>> {
    const { transferId, offset } = write;

    return this.driveOp(caller, async (drive) => {
      const target = v.parse(DriveUploadTargetSchema, write.target);

      if (!transferId) throw new KinuError('bad_input', 'upload transfer id required');
      let row = this.driveUploads.get(transferId);

      if (offset === 0) {
        row = { target, upload: new ChunkedUpload() };
        this.driveUploads.set(transferId, row);
      } else if (!row || JSON.stringify(row.target) !== JSON.stringify(target)) {
        throw new KinuError('bad_input', 'file transfer out of sync: no matching open upload');
      }

      const step = row.upload.chunk(offset, write.chunk, write.final);

      if (row.upload.done) this.driveUploads.delete(transferId);

      if ('error' in step) throw new KinuError('bad_input', step.error);

      if (!('assembled' in step)) return { ok: true };

      return receiveDriveUpload(drive, target, step.assembled);
    });
  }

  async drive_abortUpload(caller: UserCaller, transferId: string): Promise<void> {
    await this.host.requireTier(caller, 'drive');
    this.driveUploads.get(transferId)?.upload.abort();
    this.driveUploads.delete(transferId);
  }

  /** The snapshot is taken here, so later ranges cannot observe a newer write. */
  async drive_startDownload(caller: UserCaller, path: string, transferId: string): Promise<DriveAnswer<{ size: number; name: string }>> {
    return this.driveOp(caller, async (drive) => {
      if (!transferId) throw new KinuError('bad_input', 'download transfer id required');
      const clean = normalizeDrivePath(path);
      const stat = await drive.stat(clean);

      if (stat === null) throw new KinuError('missing', `no such entry: ${clean}`);
      const leaf = clean === '/' ? 'drive' : clean.slice(clean.lastIndexOf('/') + 1);

      if ((stat.type === 'directory')) {
        const bytes = await packDriveFolder(drive, clean, FILE_TRANSFER_MAX_BYTES);
        this.driveDownloads.set(transferId, { path: clean, bytes });

        return { size: bytes.byteLength, name: `${leaf}.zip` };
      }

      if (stat.size > FILE_TRANSFER_MAX_BYTES) {
        throw new KinuError('budget', `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`);
      }

      const raw = await drive.readFile(clean);
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
      this.driveDownloads.set(transferId, { path: clean, bytes });

      return { size: bytes.byteLength, name: leaf };
    });
  }

  async drive_readChunk(caller: UserCaller, transferId: string, offset: number, length: number): Promise<DriveAnswer<{ bytes: Uint8Array }>> {
    return this.driveOp(caller, async () => {
      const open = this.driveDownloads.get(transferId);

      if (!open) throw new KinuError('bad_input', 'file transfer out of sync: no matching open download');

      if (offset < 0 || length <= 0 || length > FILE_CHUNK_BYTES) throw new KinuError('bad_input', 'chunk range out of bounds');

      if (offset >= open.bytes.byteLength) throw new KinuError('bad_input', 'chunk offset past end of file');
      const bytes = open.bytes.subarray(offset, offset + length);

      if (offset + bytes.byteLength >= open.bytes.byteLength) this.driveDownloads.delete(transferId);

      return { bytes };
    });
  }

  async drive_abortDownload(caller: UserCaller, transferId: string): Promise<void> {
    await this.host.requireTier(caller, 'drive');
    this.driveDownloads.delete(transferId);
  }
}
