import { diffLines, fileDiff, type FileDiff, type FileStatus, type Omitted } from '../vfs/diff';
import { BODY_MAX_BYTES } from './workspace-diff';
import { sha256Hex } from '../safety/argument-digest';
import { currentBytes, type WriteSubject } from '../safety/bound-write';
import type { DeferredApprovalQueue } from '../safety/deferred-approval';
import type { VFS } from '../types/primitives';

export interface WritePreview {
  readonly path: string;
  /** Null: nothing is there, so the write creates the file. */
  readonly currentBytes: number | null;
  readonly nextBytes: number;
  readonly diff: FileDiff;
}

/** Lines when both sides are text within a stored row: a NUL byte makes a side binary, and one past a row is large. */
function writePreview(write: WriteSubject): WritePreview {
  const status: FileStatus = write.current === null ? 'added' : 'changed';
  const sides = write.current === null ? [write.next] : [write.current, write.next];
  let omitted: Omitted | null = null;

  if (sides.some((side) => side.includes(0))) omitted = 'binary';
  else if (sides.some((side) => side.byteLength > BODY_MAX_BYTES)) omitted = 'large';
  const decoder = new TextDecoder();

  const diff = omitted === null
    ? fileDiff(write.path, status, diffLines(write.current === null ? '' : decoder.decode(write.current), decoder.decode(write.next)))
    : { path: write.path, status, added: 0, removed: 0, lines: [], omitted };

  return { path: write.path, currentBytes: write.current?.byteLength ?? null, nextBytes: write.next.byteLength, diff };
}

export interface ParkedWriteReview extends WritePreview {
  /** The file changed after the agent asked, so approving writes nothing. */
  readonly changedSinceAsked: boolean;
}

export async function reviewParkedWrite(
  queue: Pick<DeferredApprovalQueue, 'parkedWrite'>, plane: VFS, id: string,
): Promise<ParkedWriteReview | null> {
  const parked = await queue.parkedWrite(id);

  if (parked === null) return null;
  const current = await currentBytes(plane, parked.write.path);

  return {
    ...writePreview({ path: parked.write.path, current, next: parked.bytes }),
    changedSinceAsked: current === null || sha256Hex(current) !== parked.write.current,
  };
}
