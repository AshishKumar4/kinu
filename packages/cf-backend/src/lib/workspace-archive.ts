/**
 * A workspace's archive as the browser downloads it: the export RPC answers one bounded page at a time, so the page
 * walks the cursor and assembles the file (`kinu import <file>` restores it).
 */
import { Effect } from 'effect';
import { WORKSPACE_ARCHIVE_EXTENSION, type ArchiveCursor } from '@kinu.run/core';
import type { WorkspaceRpc } from './workspace-rpc';

/** Hands `blob` to the browser as a download named `name`. */
export function saveBlob(blob: Blob, name: string): Effect.Effect<void> {
  const url = URL.createObjectURL(blob);

  return Effect.ensuring(Effect.sync(() => {
    const link = document.createElement('a');

    link.href = url;
    link.download = name;
    link.click();
  }), Effect.sync(() => {
    URL.revokeObjectURL(url);
  }));
}

/** Downloads `workspace`'s archive, telling `progress` the records read so far; its record count. */
export function downloadWorkspaceArchive(rpc: WorkspaceRpc, workspace: string, progress: (records: number) => void): Effect.Effect<number> {
  return Effect.gen(function* () {
    const parts: string[] = [];
    let cursor: ArchiveCursor | null = null;
    let records = 0;

    do {
      const page = yield* Effect.promise(async () => rpc('exportWorkspaceArchive', [cursor]));

      parts.push(page.lines.map((line) => `${line}\n`).join(''));
      records += page.lines.length;
      cursor = page.next;
      progress(records);
    } while (cursor);

    yield* saveBlob(new Blob(parts, { type: 'application/x-ndjson' }), `${workspace}${WORKSPACE_ARCHIVE_EXTENSION}`);

    return records;
  });
}
