import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where every script keeps what it caches outside the tree: `$XDG_CACHE_HOME`, else `~/.cache`. One name moves them
 *  all, as a machine whose home disk is full moves them to another. */
export function cacheRoot(): string {
  const named = process.env.XDG_CACHE_HOME;

  return named === undefined || named === '' ? join(homedir(), '.cache') : named;
}

/** The ladder's store, and the resources its live rows measured: outside the tree, so no gate can read it as corpus and
 *  no checkout carries another's proofs. */
export function ladderCacheDirectory(): string {
  return join(cacheRoot(), 'kinu-ladder');
}
