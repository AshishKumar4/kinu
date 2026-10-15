import type { VfsDirent, VfsDirentType, VfsStat } from '@nimbus-sh/core/vfs/vfs.js';

const KINDS: ReadonlyMap<string, VfsDirentType> = new Map([
  ['file', 'file'], ['directory', 'directory'], ['dir', 'directory'], ['symlink', 'symlink'],
  ['fifo', 'fifo'], ['socket', 'socket'], ['block', 'block'], ['blockDevice', 'block'],
  ['character', 'character'], ['characterDevice', 'character'],
]);

/** A listing's word for an entry's kind. `file` is a regular file only (Nimbus 0.15); a kind it cannot name, Nimbus stats. */
export function direntType(kind: string | undefined): VfsDirentType {
  return (kind === undefined ? undefined : KINDS.get(kind)) ?? 'unknown';
}

/** A directory read a window at a time from where it lives, so its size never sits whole in the reader: `next` is where
 *  the following window starts, null after the last. */
export interface DirectoryPages {
  readdirPage(path: string, window: { readonly offset: number; readonly limit: number }): Promise<{ readonly entries: VfsDirent[]; readonly next: number | null }>;
}

/** What a listing read beside an entry's name, as the stat it stands for: none where it read no size or age (an older
 *  sender, or an entry it could not stat) or the kind is not one a stat names. */
export function listedStat(type: VfsDirentType, size: number | undefined, mtimeMs: number | undefined): VfsStat | undefined {
  if (size === undefined || mtimeMs === undefined) return undefined;

  return type === 'file' || type === 'directory' || type === 'symlink' ? { type, size, mtimeMs } : undefined;
}
