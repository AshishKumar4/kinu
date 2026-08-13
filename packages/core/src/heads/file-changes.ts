/**
 * What a head did to the filesystem — the per-head change set a parent reads
 * back out of a split.
 *
 * A fork writes into its parent's workspace, so a child's changes already land
 * where the parent can read them; what was missing was anyone saying which of
 * them were whose. Diffing the shared workspace once the split ends cannot
 * answer that: sibling heads run concurrently against the same files, so an
 * end-of-split diff smears every head's work into one pile and attributes all of
 * it to whoever is asked.
 *
 * So attribution happens where a head's own write lands, not where the work
 * ends. Each head reaches its parent through its OWN `parent` executor, and this
 * observer wraps THAT head's file view of it (`observeWrites`) — which is what
 * makes the attribution exact whatever a sibling is doing at the same moment.
 *
 * What it therefore covers, and what it does not: every write and delete a head
 * makes to the PARENT workspace — `parent.writeFile`, and the `file` tool when
 * pointed there. It does NOT cover files changed by a shell command the head ran
 * (`parent.exec 'sed -i …'`, `run laptop …`): that plane reports an exit code,
 * not a file list, and recovering one would mean diffing a directory siblings
 * are writing to at the same time — the smear this design exists to avoid. Those
 * changes are real, and they are left unattributed rather than attributed to a
 * guess; {@link HEAD_FILE_CHANGE_PROVENANCE} is the sentence that says so
 * wherever the set is rendered.
 *
 * The head's own workspace is not observed at all: it is private scratch that
 * dies with the head, so listing it would report noise as work.
 */

import { diffLines, type FileStatus } from '../vfs/diff.js';
import type { WriteEvent, WriteObserver } from '../vfs/observe.js';

/** One file a head changed, as a review would state it. */
export interface HeadFileChange {
  /** The parent workspace's own path — what the parent addresses the file by. */
  readonly path: string;
  readonly status: FileStatus;
  readonly added: number;
  readonly removed: number;
  /** Set when the content is not text, so lines are not a unit for it and the
   *  counts are omitted rather than fabricated from decoded bytes. */
  readonly binary?: boolean;
}

/** The one sentence that keeps a rendered change set from implying it is the
 *  whole story. See the module docstring for why the gap exists. */
export const HEAD_FILE_CHANGE_PROVENANCE =
  "Recorded at each head's file plane; files changed by shell commands a head ran are not attributed to a head.";

interface Touched {
  baseline: string | null;
  current: string | null;
  binary: boolean;
}

/**
 * One head's accumulated file changes. Wrapped around that head's view of the
 * parent workspace (`observeWrites`) and read once its report is assembled.
 *
 * Net, not per-write: a path is diffed against what it held when this head FIRST
 * touched it, so a head that rewrote a file five times reports the one change a
 * reviewer would see, and a head that wrote a file back to its original contents
 * reports nothing for it.
 */
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
    });
  }

  /** The change set, sorted by path. Files whose content came back to where it
   *  started are omitted — nothing changed there. */
  snapshot(): HeadFileChange[] {
    const out: HeadFileChange[] = [];
    for (const [path, t] of this.touched) {
      if (t.baseline === null && t.current === null) continue;
      const status: FileStatus = t.baseline === null ? 'added' : t.current === null ? 'removed' : 'changed';
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

/** A trailing newline ENDS the last line rather than starting a phantom empty
 *  one — the same convention the turn file ledger counts by, and the one that
 *  makes a new 3-line file read as +3 instead of +4. */
function withoutFinalNewline(content: string | null): string {
  if (content === null) return '';
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

/** Content as text, or the fact that it is not. A non-string payload is never
 *  decoded into lines: an image has no line count, and inventing one would put
 *  a number in a review that means nothing. */
function asText(value: string | Uint8Array | null): { text: string | null; binary: boolean } {
  if (value === null) return { text: null, binary: false };
  if (typeof value === 'string') return { text: value, binary: false };
  return { text: '', binary: true };
}

/** Render one head's change set the way a review states it. Empty in, empty
 *  out — a head that changed nothing contributes no lines. */
export function formatHeadFileChanges(changes: readonly HeadFileChange[]): string[] {
  const mark: Record<FileStatus, string> = { added: 'A', removed: 'D', changed: 'M' };
  return changes.map((c) => c.binary
    ? `  ${mark[c.status]}  ${c.path}  (binary)`
    : `  ${mark[c.status]}  ${c.path}  +${c.added} −${c.removed}`);
}
