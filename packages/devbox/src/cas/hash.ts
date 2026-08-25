/**
 * Content hashing and fixed-size chunking.
 *
 * `CHUNK_SIZE` matches @cloudflare/dofs (512 KiB) so chunk boundaries agree
 * with the upstream pattern this follows. Fixed-size chunking has a known cost:
 * inserting a byte near the start of a file shifts every later boundary. The
 * interface is a chunk list rather than a chunker so a content-defined split
 * can replace this without changing the journal.
 */

import { createHash } from 'node:crypto';

import type { ChunkRef, Sha256Hex } from './types';

export const CHUNK_SIZE = 512 * 1024;

export function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface FileDigest {
  readonly hash: Sha256Hex;
  readonly size: number;
  readonly chunks: readonly ChunkRef[];
}

/**
 * One pass over in-memory bytes. Memory stays at one chunk regardless of size
 * because each chunk is hashed and discarded as a view, not copied.
 */
export function digestBytes(bytes: Uint8Array): FileDigest {
  const whole = createHash('sha256');
  const chunks: ChunkRef[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const view = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.byteLength));
    whole.update(view);
    chunks.push({ hash: sha256Hex(view), size: view.byteLength });
  }
  return { hash: whole.digest('hex'), size: bytes.byteLength, chunks };
}
