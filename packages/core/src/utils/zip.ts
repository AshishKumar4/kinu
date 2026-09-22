/**
 * The zip container, read and written without a dependency: the Drive takes a
 * folder as a zip from the browser and hands one back as a download, and the
 * platform's `DecompressionStream('deflate-raw')` inflates the one compression
 * method the format is used with. Stored and deflated entries are read; every
 * entry this module writes is stored, so a written archive round-trips through
 * `unpackZip` byte for byte and through any other reader.
 *
 * Zip64, encryption and every other method are refused as `unsupported`, and
 * an entry whose name climbs or is absolute is refused as `bad_input`: the
 * caller lands entries under a folder it chose, and a name that could leave it
 * is not an entry, it is an attack.
 */
import { KinuError } from '../obs/error';

export interface ZipEntry {
  /** The entry's name inside the archive, forward-slashed, no leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;

const CENTRAL_HEADER = 0x02014b50;

const END_OF_CENTRAL = 0x06054b50;

const STORED = 0;

const DEFLATED = 8;

const ZIP64_MARK = 0xffffffff;

/** Whether `bytes` begin the way every zip archive does. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === LOCAL_HEADER;
}

/** Why an archive entry may not land under a folder, or null when it may. */
function entryNameProblem(name: string): string | null {
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) return 'is absolute';
  const segments = name.split('/');

  if (segments.some((segment) => segment === '..')) return 'climbs out of the archive';

  if (segments.some((segment) => /\p{Cc}/u.test(segment))) return 'holds a control character';

  return null;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Onto its own buffer: the platform's stream types take an ArrayBuffer view,
  // never a view over a buffer that might be shared.
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Where the end-of-central-directory record starts: the last such signature,
 *  since a comment of up to 64 KiB may follow it. */
function endOfCentral(view: DataView): number {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL) return at;
  }

  throw new KinuError('bad_input', 'not a zip archive: no end-of-central-directory record');
}

/** Every file entry of `archive`, inflated, in central-directory order. */
export async function unpackZip(archive: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = endOfCentral(view);
  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);

  if (directoryOffset === ZIP64_MARK) throw new KinuError('unsupported', 'zip64 archives are not supported');
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_HEADER) throw new KinuError('bad_input', 'corrupt zip: central directory entry expected');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) throw new KinuError('unsupported', `zip entry ${JSON.stringify(name)} is encrypted`);

    if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw new KinuError('unsupported', 'zip64 archives are not supported');
    }

    if (name.endsWith('/')) continue;
    const problem = entryNameProblem(name);

    if (problem !== null) throw new KinuError('bad_input', `zip entry ${JSON.stringify(name)} ${problem}`);

    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) throw new KinuError('bad_input', 'corrupt zip: local header expected');
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);

    if (method === STORED) entries.push({ path: name, bytes: raw });
    else if (method === DEFLATED) entries.push({ path: name, bytes: await inflate(raw) });
    else throw new KinuError('unsupported', `zip entry ${JSON.stringify(name)} uses compression method ${String(method)}`);
  }

  return entries;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;

  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}

/** One archive holding `files` as stored entries, in the order given. */
export function packZip(files: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const problem = entryNameProblem(file.path);

    if (problem !== null) throw new KinuError('bad_input', `zip entry ${JSON.stringify(file.path)} ${problem}`);
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, STORED, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    locals.push(local, file.bytes);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, STORED, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength + file.bytes.byteLength;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + directorySize + 22);
  let at = 0;

  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, at);
    at += part.byteLength;
  }

  return archive;
}
