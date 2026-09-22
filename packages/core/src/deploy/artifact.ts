// Streaming .tar.gz reader, one member at a time: a DO transient allocation near 128 MiB
// resets it (`do.isolate.transient_alloc_reset`), so the unpacked archive is never indexed.
// Every holder charges `HeldBytes` for what it retains.

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

  private shave(head: Uint8Array, count: number): Uint8Array {
    if (head.length === count) this.queue.shift();
    else this.queue[0] = head.subarray(count);

    this.queued -= count;

    return head.subarray(0, count);
  }
}

class StreamMember implements ArtifactMember {
  private left: number;

  constructor(
    readonly path: string,
    readonly size: number,
    private readonly cursor: Cursor,
  ) {
    this.left = size;
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    while (this.left > 0) {
      const piece = await this.cursor.some(this.left);

      if (piece === null) throw new Error(`the release artifact ends inside ${this.path}`);

      this.left -= piece.length;

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

  async drain(): Promise<void> {
    for await (const piece of this.chunks()) void piece;
  }
}

/**
 * Walked once; a second walk is refused because the held bytes are released at its end.
 * The `.sha256` check (`channel.ts`) is integrity only; the release signature is not verified here.
 */
export class TarArtifact {
  readonly held = new HeldBytes();

  private walked = false;

  private constructor(private readonly archive: Uint8Array<ArrayBuffer>) {
    this.held.hold(archive.length);
  }

  static open(archive: Uint8Array<ArrayBuffer>): TarArtifact {
    return new TarArtifact(archive);
  }

  /** GNU `L` long-name entries apply to the next header; hashed asset names exceed 100 chars. */
  async *members(): AsyncIterable<ArtifactMember> {
    if (this.walked) throw new Error('the release artifact is read once, and this one has been read');

    this.walked = true;

    // Not `new Blob([archive]).stream()`: a Blob copies the archive.
    const source = new ReadableStream<BufferSource>({
      start: (controller) => {
        controller.enqueue(this.archive);
        controller.close();
      },
    });

    const cursor = new Cursor(source.pipeThrough(new DecompressionStream('gzip')));
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

        if (flag !== '0' && flag !== '\0') {
          await cursor.exact(size + padding);
          continue;
        }

        const member = new StreamMember(path, size, cursor);

        yield member;

        await member.drain();
        await cursor.exact(padding);
      }
    } finally {
      this.held.release(this.archive.length);
    }
  }
}
