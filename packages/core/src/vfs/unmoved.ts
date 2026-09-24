/** A file's size and last modification, as a manifest recorded them or as a stat reads them now. */
export interface SizeAndMtime {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Whether `now` is still the file recorded as `recorded` at `recordedAt`, judged from its stat alone: git's
 * racily-clean rule. A same-size rewrite in the recording's own millisecond keeps size and mtime both, so a record
 * whose mtime is not older than its recording is read again, never trusted. Blind to `touch -d` restoring the
 * recorded mtime at the same size.
 */
export function unmovedSince(recorded: SizeAndMtime, recordedAt: number, now: SizeAndMtime): boolean {
  return recorded.size === now.size && recorded.mtimeMs === now.mtimeMs && recorded.mtimeMs < recordedAt;
}
