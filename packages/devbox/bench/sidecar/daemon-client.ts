/**
 * The sidecar's daemon port, over the one control-socket client.
 *
 * TWO LANES WROTE A CLIENT EACH for the same daemon wire; the production
 * client (`src/capture/journal/client.ts`) is the survivor, and this file is
 * what the sidecar keeps of its own: the adaptation of `JournalDaemonClient`
 * and `readJournalDelta` to the `SidecarDaemon` port, and the WAL tail the
 * seal cadence reads. The duplicated reply schemas, framing and stage reader
 * are gone — every safety property (the manifest proven the fence's own, a
 * staged read held to the digest the fence recorded) lives in the one client
 * now, and the modeled daemon in the tests implements the same port.
 */

import { open, stat } from 'node:fs/promises';

import { JournalDaemonClient } from '../../src/capture/journal/client';
import type { JournalDelta, JournalFence } from '../../src/capture/journal/client';
import type { BoundaryHandback } from '../../src/candidates/merkle-pack/delta';

import type { SidecarDaemon } from './core';

export class SidecarDaemonClient implements SidecarDaemon {
  readonly #client: JournalDaemonClient;

  constructor(socketPath: string) {
    this.#client = new JournalDaemonClient(socketPath);
  }

  fence(): Promise<JournalFence> {
    return this.#client.fence();
  }

  delta(fence: JournalFence): Promise<JournalDelta> {
    return readBoundDelta(fence);
  }

  async boundaries(handback: BoundaryHandback): Promise<number> {
    return await this.#client.boundaries(handback);
  }
}

/** The staged bytes the delta names, read beneath the manifest's stage root.
 *  A staged file is sparse: only the windows the fence copied are present,
 *  which is exactly the set the manifest's ranges name, so a read outside
 *  them is a defect rather than a hole to tolerate. The digest check and the
 *  boundary check are `readJournalDelta`'s; this names the seam. */
function readBoundDelta(fence: JournalFence): Promise<JournalDelta> {
  return readJournalDeltaBound(fence);
}

import { readJournalDelta as readJournalDeltaBound } from '../../src/capture/journal/client';

/**
 * The WAL tail, as the seal cadence reads it: how many bytes of writes the
 * daemon has recorded since the last seal. `W <ino> <path> <offset> <length>`
 * is one write, and the length is the byte count the trigger sums; every other
 * record is a metadata op and contributes nothing to the eight-MiB threshold.
 */
/** Node raises `Error` subclasses with an errno `code` on system-call
 *  failures; this narrows without an assertion. */
export interface WalProgress {
  readonly offset: number;
  readonly dirtyBytes: number;
}

export async function readWalProgress(walPath: string, fromOffset: number): Promise<WalProgress> {
  let facts: { readonly size: number } | null = null;
  try {
    facts = await stat(walPath);
  } catch (error) {
    // A WAL that does not exist yet holds no records: the daemon has not
    // written one since the mount. Anything else is a real stat failure.
    if (!(error instanceof Error && 'code' in error)) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  if (facts === null || facts.size <= fromOffset) return { offset: fromOffset, dirtyBytes: 0 };
  const handle = await open(walPath, 'r');
  try {
    const length = facts.size - fromOffset;
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, fromOffset);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    // A partial trailing line belongs to the next read, so the offset advances
    // only over the lines that are complete.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return { offset: fromOffset, dirtyBytes: 0 };
    let dirtyBytes = 0;
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const parts = line.split(' ');
      if (parts[0] !== 'W' || parts.length < 5) continue;
      const bytes = Number(parts[4]);
      if (Number.isSafeInteger(bytes) && bytes > 0) dirtyBytes += bytes;
    }
    return { offset: fromOffset + Buffer.byteLength(text.slice(0, lastNewline + 1)), dirtyBytes };
  } finally {
    await handle.close();
  }
}
