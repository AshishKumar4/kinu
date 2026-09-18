/**
 * Reading the release artifact: gzip, then tar, then each member handed to the
 * caller as it comes out of the stream.
 *
 * WHY THIS IS HERE AND NOT A LIBRARY. The deploy Durable Object has to open a
 * `.tar.gz` and hand out its members, and the platform gives half of it —
 * `DecompressionStream('gzip')` — while the other half is a 512-byte header
 * format. A dependency for that would be a dependency the Worker bundle
 * carries for one call site.
 *
 * WHY IT IS A STREAM AND NOT AN INDEX. The object that installs a release is a
 * Durable Object, and a transient allocation near 128 MiB resets it
 * (`do.isolate.transient_alloc_reset` in `platform-catalog.ts`; measured
 * 2026-09-18, the reset lands about 1.7 s after the request already answered
 * 200). The release this tree publishes unpacks to 107.99 MiB, so an index
 * over the unpacked archive — which is what this file held until
 * 2026-09-18 — could not be built inside that object at all. One pass, one
 * member at a time, and the caller decides what it keeps.
 *
 * WHAT IS HELD, AND BY WHOM. `HeldBytes` is the run's one accountant: every
 * holder charges its own retention and releases it when it lets go, so the
 * peak is a measurement rather than an argument. This reader charges the
 * compressed buffer it was opened on. A caller that keeps a member's bytes —
 * the upload step keeps the module set, because a version upload is one
 * multipart request — charges those itself.
 */

const BLOCK = 512;

const NAME = { offset: 0, length: 100 } as const;

const SIZE = { offset: 124, length: 12 } as const;

const TYPE_FLAG = 156;

const PREFIX = { offset: 345, length: 155 } as const;

/**
 * What the run is holding out of the artifact, and the most it ever held.
 *
 * Not a debug counter: the Cloudflare door's whole shape is decided by this
 * number, the upload step records it as a fact on its ledger row, and
 * `packages/cf-backend/tests/workerd/deploy-ledger.test.ts` holds a release
 * shaped like the real one against it.
 */
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

  /** The high-water mark, in bytes. */
  peak(): number {
    return this.highest;
  }
}

/**
 * One file in the archive, while the stream is on it.
 *
 * A member is live only until the walk moves to the next one: `chunks` is the
 * stream itself, and `bytes` is the caller asking for the whole thing in
 * memory — which is the caller deciding to hold `size` bytes and charge them.
 */
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

/** Tar stores sizes in octal ASCII. GNU's base-256 form is not produced by the
 *  `tar` that writes this artifact and is refused rather than misread. */
function octal(bytes: Uint8Array, offset: number, length: number): number {
  const first = bytes[offset] ?? 0;

  if ((first & 0x80) !== 0) throw new Error('the artifact carries a base-256 tar size, which this reader refuses');
  const digits = text(bytes, offset, length);

  return digits === '' ? 0 : Number.parseInt(digits, 8);
}

/**
 * The decompressed archive, read forwards.
 *
 * `exact` is for the 512-byte headers, which have to be contiguous; `some`
 * hands back whatever the decompressor produced without copying it, which is
 * how a 21.5 MiB member reaches the caller in pieces instead of all at once.
 */
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

  /** The first `count` bytes of the queue's head, as a view onto the chunk the
   *  decompressor already allocated. */
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

  /** Whatever the caller did not read, stepped over, so the next header is
   *  where the walk expects it. */
  async drain(): Promise<void> {
    for await (const piece of this.chunks()) void piece;
  }
}

/**
 * The release artifact, walked once.
 *
 * The digest is checked before anything is read out of it (`channel.ts`), so
 * an artifact that does not match is not opened at all. WHAT THAT CHECK IS
 * WORTH: the channel's `<artifact>.sha256` is a plain static file beside the
 * artifact, so the comparison is integrity over the same TLS connection — it
 * catches a truncated or swapped object, not a channel that serves two
 * matching lies. The signature lives in `kinu-version.json`
 * (`http/release-signing.ts`), which the CLI launcher verifies against its
 * pinned key and `scripts/deploy.sh` holds this sidecar against at publish
 * time; nothing in this flow verifies it yet.
 *
 * ONE WALK. The compressed bytes are held for the length of the walk and
 * released at its end, so a second walk would have to decompress an archive
 * this object no longer accounts for; it is refused instead. Every door reads
 * the artifact once — the upload step and `kinu deploy local` both take each
 * member as it arrives.
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

  /**
   * Every file in the archive, in the order the archive carries them.
   *
   * Long-name entries (GNU `L` typeflag) carry the real path in their body and
   * apply to the next header; an artifact whose paths exceed 100 characters is
   * ordinary here, because the asset bundle's hashed filenames are long.
   */
  async *members(): AsyncIterable<ArtifactMember> {
    if (this.walked) throw new Error('the release artifact is read once, and this one has been read');

    this.walked = true;

    // NOT `new Blob([archive]).stream()`: a Blob copies, and a second copy of
    // the compressed artifact is 27 MiB of the object's allocation budget
    // spent on bytes nobody writes to.
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
