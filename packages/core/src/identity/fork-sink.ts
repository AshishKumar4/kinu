/** Where a fork's files land on the target: Nimbus imports. */

import type { VfsExportChunk, VfsExportPage } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

export interface ForkFileSink {
  /** Stores chunks ahead of `dst`'s page, each re-hashed first; they are held until the import's last page. */
  importChunks(dst: string, chunks: readonly VfsExportChunk[]): Promise<void>;
  /**
   * One page of the import at `dst` (absolute), under a parent made if missing. A page replayed is harmless; one
   * naming chunks the target holds neither staged nor stored writes nothing and lists them in `want`.
   */
  importPage(dst: string, page: VfsExportPage): Promise<{ want: string[]; done: boolean }>;
  /** Recursive; a missing path is not an error. */
  remove(paths: readonly string[]): Promise<void>;
}
