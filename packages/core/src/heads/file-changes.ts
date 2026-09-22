/**
 * Per-head file changes, attributed where the head's own write lands (`observeWrites`), so concurrent
 * siblings cannot smear into it. Covers VFS writes and deletes only, not shell-command changes: any
 * surface that renders this set must say so. Actor-private state under `.kinu` is not part of it.
 */

import { diffLines, type FileStatus } from '../vfs/diff';
import { textPayload, type WriteEvent, type WriteObserver } from '../vfs/observe';
import type { HeadFileChange } from '../types/heads';

export type { HeadFileChange } from '../types/heads';

interface Touched {
  baseline: string | null;
  current: string | null;
  binary: boolean;
  unread: 'directory' | 'unreadable' | null;
}

/** Net, not per-write: each path is diffed against what it held when this head first touched it. */
export class HeadFileChanges implements WriteObserver {
  private readonly touched = new Map<string, Touched>();

  needsBaseline(path: string): boolean {
    return !this.touched.has(path);
  }

  record(event: WriteEvent): void {
    const existing = this.touched.get(event.path);
    const after = asText(event.after);

    if (existing) {
      existing.current = after.text;
      existing.binary ||= after.binary;

      return;
    }

    const before = asText(event.before ?? null);
    this.touched.set(event.path, {
      baseline: before.text,
      current: after.text,
      binary: before.binary || after.binary,
      unread: event.unread ?? null,
    });
  }

  /** Sorted by path; files whose content returned to the start are omitted. */
  snapshot(): HeadFileChange[] {
    const out: HeadFileChange[] = [];

    for (const [path, t] of this.touched) {
      // An unknown baseline is always a change (the path was stat-ed), and its lines are not counted.
      if (t.unread !== null) {
        const status = t.current === null ? 'removed' : 'changed';
        out.push(t.unread === 'directory'
          ? { path, status, added: 0, removed: 0, directory: true }
          : { path, status, added: 0, removed: 0, unreadable: true });
        continue;
      }

      if (t.baseline === null && t.current === null) continue;
      const status = changeStatus(t);

      if (t.binary) {
        out.push({ path, status, added: 0, removed: 0, binary: true });
        continue;
      }

      if (t.baseline === t.current) continue;
      const d = diffLines(withoutFinalNewline(t.baseline), withoutFinalNewline(t.current));
      out.push({ path, status, added: d.added, removed: d.removed });
    }

    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function changeStatus(touched: Touched): FileStatus {
  if (touched.baseline === null) return 'added';

  if (touched.current === null) return 'removed';

  return 'changed';
}

/** A trailing newline ends the last line, matching the turn file ledger (a new 3-line file is +3). */
function withoutFinalNewline(content: string | null): string {
  if (content === null) return '';

  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

/** A non-string payload is never decoded into lines; `binary: true` with empty text makes the counts zero. */
function asText(value: string | Uint8Array | null) {
  const payload = textPayload(value);

  if (payload.kind === 'absent') return { text: null, binary: false };

  if (payload.kind === 'text') return { text: payload.text, binary: false };

  return { text: '', binary: true };
}
