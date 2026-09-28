import { sha256Hex } from './argument-digest';
import type { ApprovalContent } from './bound-write';

/** Under the kernel-owned /etc, so no agent's own files reach it. */
const PARKED_WRITES_ROOT = '/etc/kinu-parked-writes';

export interface ParkedWriteFileOps {
  exists(path: string): boolean;
  mkdir(path: string, options: { mode: number }): void;
  writeFile(path: string, bytes: Uint8Array, options: { mode: number }): void;
  readFileUncached(path: string): Uint8Array;
  unlink(path: string): void;
}

/** One harness-private file per sha256, written by the plane's own writeFile, which stages a large file in bounded
 *  transactions. Bytes that no longer hash to their name read as none. */
export class ParkedWriteFiles implements ApprovalContent {
  constructor(private readonly files: () => Promise<ParkedWriteFileOps>) {}

  async retain(bytes: Uint8Array): Promise<void> {
    const files = await this.files();
    const path = `${PARKED_WRITES_ROOT}/${sha256Hex(bytes)}`;

    if (!files.exists(PARKED_WRITES_ROOT)) files.mkdir(PARKED_WRITES_ROOT, { mode: 0o700 });

    if (!files.exists(path)) files.writeFile(path, bytes, { mode: 0o400 });
  }

  async read(sha256: string): Promise<Uint8Array | null> {
    const files = await this.files();
    const path = parkedPath(sha256);
    const bytes = path !== null && files.exists(path) ? files.readFileUncached(path) : null;

    return bytes !== null && sha256Hex(bytes) === sha256 ? bytes : null;
  }

  async delete(sha256: string): Promise<void> {
    const files = await this.files();
    const path = parkedPath(sha256);

    if (path !== null && files.exists(path)) files.unlink(path);
  }
}

/** Null for a name that is no sha256, which names no parked file: a path is never built from it. */
function parkedPath(sha256: string): string | null {
  return /^[0-9a-f]{64}$/u.test(sha256) ? `${PARKED_WRITES_ROOT}/${sha256}` : null;
}
