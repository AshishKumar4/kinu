import type { VfsDirentType } from '@nimbus-sh/core/vfs/vfs.js';

const KINDS: ReadonlyMap<string, VfsDirentType> = new Map([
  ['file', 'file'], ['directory', 'directory'], ['dir', 'directory'], ['symlink', 'symlink'],
  ['fifo', 'fifo'], ['socket', 'socket'], ['block', 'block'], ['blockDevice', 'block'],
  ['character', 'character'], ['characterDevice', 'character'],
]);

/** A listing's word for an entry's kind. `file` is a regular file only (Nimbus 0.15); a kind it cannot name, Nimbus stats. */
export function direntType(kind: string | undefined): VfsDirentType {
  return (kind === undefined ? undefined : KINDS.get(kind)) ?? 'unknown';
}
