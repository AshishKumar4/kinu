// Streaming .tar.gz reader, one member at a time, as the download arrives: a DO transient allocation near 128 MiB
// resets it (`do.isolate.transient_alloc_reset`), so neither the archive nor its unpacked bytes are held whole.
// Every holder charges `HeldBytes` for what it retains.
import { createHash, type Hash } from 'node:crypto';
import type { ReleaseFile } from './manifest';

const BLOCK = 512;

const NAME = { offset: 0, length: 100 } as const;

const SIZE = { offset: 124, length: 12 } as const;

const TYPE_FLAG = 156;

const PREFIX = { offset: 345, length: 155 } as const;

export class HeldBytes {
  private current = 0;

  private highest = 0;

  hold(bytes: number): void {
    this.current += bytes;

    if (this.current > this.highest) this.highest = this.current;
  }

  release(bytes: number): void {
    this.current -= bytes;
  }

  peak(): number {
    return this.highest;
  }
}

/** Live only until the walk moves on. A caller calling `bytes` must charge `size`. */
export interface ArtifactMember {
  readonly path: string;
  readonly size: number;
  chunks(): AsyncIterable<Uint8Array>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);

  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

// GNU base-256 sizes are refused rather than misread.
function octal(bytes: Uint8Array, offset: number, length: number): number {
  const first = bytes[offset] ?? 0;

  if ((first & 0x80) !== 0) throw new Error('the artifact carries a base-256 tar size, which this reader refuses');
  const digits = text(bytes, offset, length);

  return digits === '' ? 0 : Number.parseInt(digits, 8);
}

// `exact` joins contiguous headers; `some` returns decompressor chunks without copying.
class Cursor {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  private queue: Uint8Array[] = [];

  private queued = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** Stops the download, as a walk that ends early leaves it. */
  async cancel(): Promise<void> {
    await this.reader.cancel();
  }

  async exact(count: number): Promise<Uint8Array | null> {
    while (this.queued < count) {
      const next = await this.reader.read();

      if (next.done) return null;

      this.queue.push(next.value);
      this.queued += next.value.length;
    }

    const first = this.queue[0];

    if (first !== undefined && first.length >= count) return this.shave(first, count);

    const joined = new Uint8Array(count);
    let at = 0;

    while (at < count) {
      const head = this.queue[0];

      if (head === undefined) break;
      const piece = this.shave(head, Math.min(head.length, count - at));

      joined.set(piece, at);
      at += piece.length;
    }

    return joined;
  }

  async some(count: number): Promise<Uint8Array | null> {
    while (this.queued === 0) {
      const next = await this.reader.read();

      if (next.done) return null;

      this.queue.push(next.value);
      this.queued += next.value.length;
    }

    const first = this.queue[0];

    if (first === undefined) return null;

    return this.shave(first, Math.min(first.length, count));
  }

  /** Reads past `count` bytes without keeping them; an archive that ends first ends the walk at its next header. */
  async skip(count: number): Promise<void> {
    for (let left = count; left > 0;) {
      const piece = await this.some(left);

      if (piece === null) return;
      left -= piece.length;
    }
  }

  private shave(head: Uint8Array, count: number): Uint8Array {
    if (head.length === count) this.queue.shift();
    else this.queue[0] = head.subarray(count);

    this.queued -= count;

    return head.subarray(0, count);
  }
}

class StreamMember implements ArtifactMember {
  private left: number;

  private readonly digest: Hash = createHash('sha256');

  constructor(
    readonly path: string,
    readonly size: number,
    private readonly sha256: string,
    private readonly cursor: Cursor,
  ) {
    this.left = size;
  }

  /** The last piece is handed on only once the member matches its digest, so no reader finishes a corrupted file. */
  async *chunks(): AsyncIterable<Uint8Array> {
    while (this.left > 0) {
      const piece = await this.next();

      this.digest.update(piece);

      if (this.left === 0 && this.digest.digest('hex') !== this.sha256) {
        throw new Error(`the release artifact's ${this.path} does not match the digest its manifest names`);
      }

      yield piece;
    }
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const whole = new Uint8Array(this.size);
    let at = 0;

    for await (const piece of this.chunks()) {
      whole.set(piece, at);
      at += piece.length;
    }

    return whole;
  }

  /** What no reader took is skipped unread: it reaches nothing, so it needs no digest. */
  async drain(): Promise<void> {
    while (this.left > 0) await this.next();
  }

  private async next(): Promise<Uint8Array> {
    const piece = await this.cursor.some(this.left);

    if (piece === null) throw new Error(`the release artifact ends inside ${this.path}`);

    this.left -= piece.length;

    return piece;
  }
}

/**
 * Walked once, as its download arrives. It hands on only the members its manifest names, each checked against the
 * manifest's size before it is read and against its digest before its last piece is handed on. The digests are
 * integrity only; the release signature is not verified here.
 */
export class TarArtifact {
  private walked = false;

  private readonly named: ReadonlyMap<string, ReleaseFile>;

  private constructor(private readonly archive: ReadableStream<Uint8Array>, files: readonly ReleaseFile[]) {
    this.named = new Map(files.map((file) => [file.path, file]));
  }

  static open(archive: ReadableStream<Uint8Array>, files: readonly ReleaseFile[]): TarArtifact {
    return new TarArtifact(archive, files);
  }

  /** GNU `L` long-name entries apply to the next header; hashed asset names exceed 100 chars. */
  async *members(): AsyncIterable<ArtifactMember> {
    if (this.walked) throw new Error('the release artifact is read once, and this one has been read');

    this.walked = true;

    const cursor = new Cursor(this.archive.pipeThrough(new DecompressionStream('gzip')));
    let pendingName: string | null = null;

    try {
      for (;;) {
        const header = await cursor.exact(BLOCK);

        if (header === null || header.every((byte) => byte === 0)) break;
        const size = octal(header, SIZE.offset, SIZE.length);
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        const flag = String.fromCharCode(header[TYPE_FLAG] ?? 0);

        if (flag === 'L') {
          const body = await cursor.exact(size);

          pendingName = body === null ? null : new TextDecoder().decode(body).replace(/\0+$/u, '');
          await cursor.exact(padding);
          continue;
        }

        const prefix = text(header, PREFIX.offset, PREFIX.length);
        const named = text(header, NAME.offset, NAME.length);
        const path = (pendingName ?? (prefix === '' ? named : `${prefix}/${named}`)).replace(/^\.\//u, '');

        pendingName = null;

        const file = this.named.get(path);

        if ((flag !== '0' && flag !== '\0') || file === undefined) {
          await cursor.skip(size + padding);
          continue;
        }

        if (size !== file.size) throw new Error(`the release artifact's ${path} is ${String(size)} bytes, and its manifest names ${String(file.size)}`);
        const member = new StreamMember(path, size, file.sha256, cursor);

        yield member;

        await member.drain();
        await cursor.exact(padding);
      }
    } finally {
      await cursor.cancel();
    }
  }
}
