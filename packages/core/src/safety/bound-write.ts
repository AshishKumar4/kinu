import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { sha256Hex } from './argument-digest';

export interface BoundFileWrite {
  readonly path: string;
  readonly next: string;
  readonly current: string;
}

/** A write as its ask shows it: the file now (null: none there) and the bytes it would become. */
export interface WriteSubject {
  readonly path: string;
  readonly current: Uint8Array | null;
  readonly next: Uint8Array;
}

/** A parked write's bytes, one harness-private file per sha256. */
export interface ApprovalContent {
  retain(bytes: Uint8Array): Promise<void>;
  read(sha256: string): Promise<Uint8Array | null>;
  delete(sha256: string): Promise<void>;
}

const BOUND_WRITE = /^file write (.+) sha256:([0-9a-f]{64}) over sha256:([0-9a-f]{64})$/su;

/** The text an unanswered write parks under: it names the bytes, so an approval answers this write and no other. */
export function boundWriteCommand(write: WriteSubject): string {
  return `file write ${write.path} sha256:${sha256Hex(write.next)} over sha256:${sha256Hex(write.current ?? new Uint8Array())}`;
}

export function boundWriteOf(command: string): BoundFileWrite | null {
  const [, path, next, current] = BOUND_WRITE.exec(command) ?? [];

  return path === undefined || next === undefined || current === undefined ? null : { path, next, current };
}

export const asBytes = (data: string | Uint8Array): Uint8Array => (v.is(v.string(), data) ? new TextEncoder().encode(data) : data);

export async function currentBytes(plane: VFS, path: string): Promise<Uint8Array | null> {
  return await plane.exists(path) ? asBytes(await plane.readFile(path)) : null;
}

/** Only over the file asked about; no plane offers compare-and-write, so a change between the compare and the write
 *  goes unseen. The caller holds the bytes before the compare, so that gap is the plane's alone. */
export async function performBoundWrite(plane: VFS, write: BoundFileWrite, bytes: Uint8Array): Promise<'written' | 'changed'> {
  const current = await currentBytes(plane, write.path);

  if (current === null || sha256Hex(current) !== write.current) return 'changed';
  await plane.writeFile(write.path, bytes);

  return 'written';
}
