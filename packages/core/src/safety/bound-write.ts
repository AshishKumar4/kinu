import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import * as v from 'valibot';

import { settle } from '../obs/effect';
import type { CheckpointFiles } from '../types/primitives';
import { FileRefusalError } from '../types/file-edits';
import { writeConditionally, type ObservedFile } from '../vfs/conditional-write';
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
  return await exists(plane, path) ? asBytes(await plane.readFile(path)) : null;
}

/**
 * Only over the file asked about: its bytes now must be the ones the ask showed, and the write is conditioned on that
 * read as the file tool's are (its revision where the plane versions files, else its digest, compared by the plane), so
 * a save between the compare and the write is refused as well.
 */
export function performBoundWrite(plane: VFS & CheckpointFiles, write: BoundFileWrite, bytes: Uint8Array): Promise<'written' | 'changed'> {
  return settle(Effect.gen(function* () {
    // The revision before the bytes: a write between the two is refused by the plane's own check.
    const revision = (yield* Effect.promise(async () => plane.stat(write.path)))?.revision;
    const current = yield* Effect.promise(async () => currentBytes(plane, write.path));

    if (current === null || sha256Hex(current) !== write.current) return 'changed' as const;
    const read: ObservedFile = revision === undefined ? { kind: 'read', bytes: current } : { kind: 'read', bytes: current, revision };

    return yield* Effect.tryPromise({ try: async () => writeConditionally(plane, write.path, bytes, read), catch: (cause) => cause }).pipe(
      Effect.as('written' as const),
      Effect.catchIf((cause) => cause instanceof FileRefusalError && cause.verdict === 'stale', () => Effect.succeed('changed' as const)),
      Effect.catch((cause) => Effect.die(cause)),
    );
  }));
}
