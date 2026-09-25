import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { sha256Hex } from './argument-digest';

/** A parked write: its path, and the sha256 of its bytes and of the file they replace. */
export interface BoundFileWrite {
  readonly path: string;
  readonly next: string;
  readonly current: string;
}

/** A parked write's bytes, by sha256. */
export interface ApprovalContent {
  retain(bytes: Uint8Array): Promise<void>;
  read(sha256: string): Promise<Uint8Array>;
}

const BOUND_WRITE = /^file write (.+) sha256:([0-9a-f]{64}) over sha256:([0-9a-f]{64})$/su;

export function boundWriteOf(command: string): BoundFileWrite | null {
  const [, path, next, current] = BOUND_WRITE.exec(command) ?? [];

  return path === undefined || next === undefined || current === undefined ? null : { path, next, current };
}

const asBytes = (data: string | Uint8Array): Uint8Array => (v.is(v.string(), data) ? new TextEncoder().encode(data) : data);

export function parkWriteAs(
  path: string, bytes: string | Uint8Array, current: () => Promise<string | Uint8Array>, content: ApprovalContent,
): () => Promise<string> {
  return async () => {
    const next = asBytes(bytes);
    await content.retain(next);

    return `file write ${path} sha256:${sha256Hex(next)} over sha256:${sha256Hex(asBytes(await current()))}`;
  };
}

/** Only over the file asked about; no plane offers compare-and-write, so a change in between goes unseen. */
export async function performBoundWrite(plane: VFS, content: ApprovalContent, write: BoundFileWrite): Promise<'written' | 'changed'> {
  const current = await plane.exists(write.path) ? sha256Hex(asBytes(await plane.readFile(write.path))) : null;

  if (current !== write.current) return 'changed';
  await plane.writeFile(write.path, await content.read(write.next));

  return 'written';
}
