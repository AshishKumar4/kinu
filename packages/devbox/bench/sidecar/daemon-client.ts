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

import { open, rm, stat } from 'node:fs/promises';

import { JournalDaemonClient } from '../../src/capture/journal/client';
import type { JournalDelta, JournalFence } from '../../src/capture/journal/client';
import type { BoundaryHandback } from '../../src/candidates/merkle-pack/delta';

import type { SidecarDaemon } from './core';
import { readNamespaceDelta } from '../../src/capture/journal/namespace';
import type { NamespaceImage, NamespaceSource } from '../../src/candidates/merkle-pack/namespace-map';
import { describeThrown } from '../../src/lifecycle';
import type { UnixSocketListener } from 'bun';

export class SidecarDaemonClient implements SidecarDaemon {
  readonly #client: JournalDaemonClient;
  readonly #pageSocket: string;
  #pages: NamespacePageServer | null = null;
  /** Pages the daemon fetched through this adapter, for the measurements. */
  pagesServed = 0;

  constructor(socketPath: string) {
    this.#client = new JournalDaemonClient(socketPath);
    this.#pageSocket = `${socketPath}.pages`;
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

  async namespace(fence: JournalFence): Promise<NamespaceImage> {
    const delta = await readNamespaceDelta(fence);
    return {
      byteLength: Number(delta.manifest.byteLength),
      pages: delta.manifest.pages,
      readPage: (number) => delta.readPage(number),
      close: () => delta.close(),
    };
  }

  /**
   * The page socket outlives this call: a daemon that adopted the image
   * fetches pages whenever a name first needs them, and after its own
   * restart. Each attach points the socket at the newest head, whose retained
   * pages are the same bytes the daemon adopted.
   */
  async attachNamespace(source: NamespaceSource | null): Promise<void> {
    if (source === null) {
      await this.#client.attachNamespace(null);
      return;
    }
    if (this.#pages === null) this.#pages = await NamespacePageServer.listen(this.#pageSocket, () => { this.pagesServed += 1; });
    this.#pages.serve(source);
    await this.#client.attachNamespace({ socket: this.#pageSocket, byteLength: source.byteLength });
  }

  close(): void {
    this.#pages?.close();
    this.#pages = null;
  }
}

/**
 * One line in, `ok` and one page out. The daemon's VFS speaks this from C
 * (`namespace-pages.c`, `fetch_page`): `page N` for a 4096-byte page of the
 * published image, answered with `ok\n` and the bytes, or `error <why>\n`.
 */
class NamespacePageServer {
  #source: NamespaceSource | null = null;

  private constructor(private readonly server: UnixSocketListener<Buffer>) {}

  static async listen(path: string, served: () => void): Promise<NamespacePageServer> {
    await rm(path, { force: true });
    let held: NamespacePageServer | null = null;
    const answer = async (socket: { write(data: string | Uint8Array): number }, line: string): Promise<void> => {
      const match = /^page ([1-9][0-9]{0,9})$/u.exec(line);
      const source = held === null ? null : held.#source;
      if (match === null || source === null) {
        socket.write(`error ${source === null ? 'no namespace is attached' : 'malformed request'}\n`);
        return;
      }
      const number = Number(match[1]);
      if (number * 4096 > source.byteLength) {
        socket.write(`error page ${number} is beyond the image\n`);
        return;
      }
      try {
        const bytes = await source.readPage(number);
        socket.write('ok\n');
        socket.write(bytes);
        served();
      } catch (error) {
        // One line, bounded: the daemon reads it into a fixed buffer.
        socket.write(`error ${describeThrown({ cause: error }).replaceAll('\n', ' ').slice(0, 400)}\n`);
      }
    };
    const server = Bun.listen<Buffer>({
      unix: path,
      socket: {
        open(socket) { socket.data = Buffer.alloc(0); },
        async data(socket, chunk) {
          socket.data = Buffer.concat([socket.data, chunk]);
          for (;;) {
            const newline = socket.data.indexOf(0x0a);
            if (newline < 0) return;
            const line = socket.data.subarray(0, newline).toString('utf8');
            socket.data = socket.data.subarray(newline + 1);
            await answer(socket, line);
          }
        },
      },
    });
    held = new NamespacePageServer(server);
    return held;
  }

  serve(source: NamespaceSource): void {
    this.#source = source;
  }

  close(): void {
    this.server.stop(true);
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
 * daemon has recorded since the last seal. One record is seven tab-separated
 * fields, `sequence kind op outcome generation path aux` (`format_record`,
 * `journal-daemon.c`); a write is kind `W` with aux `ino offset length nlink`
 * (`journal_write_record`, `journal-delta.c`). The length is the byte count
 * the trigger sums; every other record is a metadata op and contributes
 * nothing to the eight-MiB threshold.
 */
export interface WalProgress {
  readonly offset: number;
  readonly dirtyBytes: number;
}

/** The bytes one WAL line adds to the dirty count: a W record's length, else zero. */
export function walRecordDirtyBytes(line: string): number {
  const fields = line.split('\t');
  if (fields.length !== 7 || fields[1] !== 'W') return 0;
  const aux = fields[6].split(' ');
  if (aux.length !== 4) return 0;
  const bytes = Number(aux[2]);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
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
    for (const line of text.slice(0, lastNewline).split('\n')) dirtyBytes += walRecordDirtyBytes(line);
    return { offset: fromOffset + Buffer.byteLength(text.slice(0, lastNewline + 1)), dirtyBytes };
  } finally {
    await handle.close();
  }
}
