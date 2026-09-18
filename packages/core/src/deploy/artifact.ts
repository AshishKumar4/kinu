/**
 * Reading the release artifact: gzip, then tar, then the file the step asked
 * for.
 *
 * WHY THIS IS HERE AND NOT A LIBRARY. The deploy Durable Object has to open a
 * `.tar.gz` and hand out its members, and the platform gives half of it —
 * `DecompressionStream('gzip')` — while the other half is a 512-byte header
 * format. A dependency for that would be a dependency the Worker bundle
 * carries for one call site.
 *
 * WHY IT READS ONCE AND KEEPS AN INDEX. The upload step reads the modules and
 * then whichever assets Cloudflare asks for; scanning the tar for each one
 * would be a full pass per file. The index is offsets into one buffer, so a
 * member costs a subarray.
 */

const BLOCK = 512;

const NAME = { offset: 0, length: 100 } as const;

const SIZE = { offset: 124, length: 12 } as const;

const TYPE_FLAG = 156;

const PREFIX = { offset: 345, length: 155 } as const;

interface Member {
  readonly start: number;
  readonly size: number;
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
 * The members of an uncompressed tar, by path.
 *
 * Long-name entries (GNU `L` typeflag) carry the real path in their body and
 * apply to the next header; an artifact whose paths exceed 100 characters is
 * ordinary here, because the asset bundle's hashed filenames are long.
 */
function readTarIndex(bytes: Uint8Array): ReadonlyMap<string, Member> {
  const members = new Map<string, Member>();
  let at = 0;
  let pendingName: string | null = null;

  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK);

    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, SIZE.offset, SIZE.length);
    const flag = String.fromCharCode(header[TYPE_FLAG] ?? 0);
    const body = at + BLOCK;
    const stride = BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 'L') {
      pendingName = new TextDecoder().decode(bytes.subarray(body, body + size)).replace(/\0+$/u, '');
      at += stride;
      continue;
    }

    const prefix = text(header, PREFIX.offset, PREFIX.length);
    const name = pendingName ?? (prefix === '' ? text(header, NAME.offset, NAME.length) : `${prefix}/${text(header, NAME.offset, NAME.length)}`);

    pendingName = null;

    if (flag === '0' || flag === '\0') members.set(name.replace(/^\.\//u, ''), { start: body, size });

    at += stride;
  }

  return members;
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The artifact's files, read out of one downloaded tarball.
 *
 * The digest is checked before anything is read out of it: the flow verifies
 * the artifact against the signed release the same way the CLI launcher does,
 * and an artifact that does not match is not opened at all.
 */
export class TarArtifact {
  private constructor(
    private readonly bytes: Uint8Array<ArrayBuffer>,
    private readonly index: ReadonlyMap<string, Member>,
  ) {}

  static async open(archive: Uint8Array<ArrayBuffer>): Promise<TarArtifact> {
    const plain = await gunzip(archive);

    return new TarArtifact(plain, readTarIndex(plain));
  }

  paths(): readonly string[] {
    return [...this.index.keys()];
  }

  async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const member = this.index.get(path);

    if (member === undefined) throw new Error(`the release artifact carries no ${path}`);

    return new Uint8Array(this.bytes.subarray(member.start, member.start + member.size));
  }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
