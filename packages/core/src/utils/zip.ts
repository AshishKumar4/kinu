/**
 * Dependency-free zip read/write. Reads stored and deflated entries; writes stored only. Zip64, encryption
 * and other methods are `unsupported`; absolute or climbing entry names are `bad_input`.
 */
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { crc32 } from './crc32';

export interface ZipEntry {
  /** Forward-slashed, no leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;

const CENTRAL_HEADER = 0x02014b50;

const END_OF_CENTRAL = 0x06054b50;

const STORED = 0;

const DEFLATED = 8;

const ZIP64_MARK = 0xffffffff;

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === LOCAL_HEADER;
}

function entryNameProblem(name: string): string | null {
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) return 'is absolute';
  const segments = name.split('/');

  if (segments.some((segment) => segment === '..')) return 'climbs out of the archive';

  if (segments.some((segment) => /\p{Cc}/u.test(segment))) return 'holds a control character';

  return null;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy onto an owned ArrayBuffer: platform stream types reject views over possibly shared buffers.
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A random-access file: a browser File's slices, so an archive of any size is read a range at a time. */
export interface RangedSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Reads of a source this size at a time: a slice a browser holds without strain. */
export const ZIP_SLICE_BYTES = 4 * 1024 * 1024;

/** The end record and its longest comment: where the end-of-central-directory signature can be. */
const END_SEARCH_BYTES = 22 + 0xffff;

/**
 * The first entry `wanted` names, as a stream of its bytes, read through `source` a range at a time: an archive is
 * never held whole. Null when none is named.
 */
export function zipEntryStream(source: RangedSource, wanted: (path: string) => boolean): Effect.Effect<ReadableStream<Uint8Array> | null, KinuError> {
  return Effect.gen(function* () {
    const tailStart = Math.max(0, source.size - END_SEARCH_BYTES);
    const tail = yield* Effect.promise(() => source.read(tailStart, source.size - tailStart));
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const end = yield* endOfCentral(tailView);
    const count = tailView.getUint16(end + 10, true);
    const directoryBytes = tailView.getUint32(end + 12, true);
    const directoryOffset = tailView.getUint32(end + 16, true);

    if (directoryOffset === ZIP64_MARK || count === 0xffff) return yield* new KinuError('unsupported', 'zip64 archives are not supported');
    const directory = yield* Effect.promise(() => source.read(directoryOffset, directoryBytes));
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const decoder = new TextDecoder();
    let at = 0;

    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(at, true) !== CENTRAL_HEADER) return yield* new KinuError('bad_input', 'corrupt zip: central directory entry expected');
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const localOffset = view.getUint32(at + 42, true);
      const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));

      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);

      if (!wanted(name)) continue;

      if (compressedSize === ZIP64_MARK || localOffset === ZIP64_MARK) return yield* new KinuError('unsupported', 'zip64 archives are not supported');

      if (method !== STORED && method !== DEFLATED) return yield* new KinuError('unsupported', `zip entry ${JSON.stringify(name)} uses compression method ${String(method)}`);
      const local = yield* Effect.promise(() => source.read(localOffset, 30));
      const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);

      if (localView.getUint32(0, true) !== LOCAL_HEADER) return yield* new KinuError('bad_input', 'corrupt zip: local header expected');
      const start = localOffset + 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
      let read = 0;

      const raw = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (read >= compressedSize) {
            controller.close();

            return;
          }

          const length = Math.min(ZIP_SLICE_BYTES, compressedSize - read);
          const bytes = await source.read(start + read, length);
          // Owned, as the platform's stream types refuse a view over a buffer that may be shared.
          const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));

          owned.set(bytes);
          controller.enqueue(owned);
          read += length;
        },
      });

      return method === STORED ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'));
    }

    return null;
  });
}

/** End-of-central-directory offset: the last signature, since an archive comment may follow it. */
function endOfCentral(view: DataView): Effect.Effect<number, KinuError> {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL) return Effect.succeed(at);
  }

  return Effect.fail(new KinuError('bad_input', 'not a zip archive: no end-of-central-directory record'));
}

export async function unpackZip(archive: Uint8Array): Promise<ZipEntry[]> {
  return settle(unpacked(archive));
}

function unpacked(archive: Uint8Array): Effect.Effect<ZipEntry[], KinuError> {
  return Effect.gen(function* () {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const end = yield* endOfCentral(view);
    const count = view.getUint16(end + 10, true);
    const directoryOffset = view.getUint32(end + 16, true);

    if (directoryOffset === ZIP64_MARK) return yield* new KinuError('unsupported', 'zip64 archives are not supported');
    const decoder = new TextDecoder();
    const entries: ZipEntry[] = [];
    let at = directoryOffset;

    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(at, true) !== CENTRAL_HEADER) return yield* new KinuError('bad_input', 'corrupt zip: central directory entry expected');
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

      if ((flags & 0x1) !== 0) return yield* new KinuError('unsupported', `zip entry ${JSON.stringify(name)} is encrypted`);

      if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) {
        return yield* new KinuError('unsupported', 'zip64 archives are not supported');
      }

      if (name.endsWith('/')) continue;
      const problem = entryNameProblem(name);

      if (problem !== null) return yield* new KinuError('bad_input', `zip entry ${JSON.stringify(name)} ${problem}`);

      if (view.getUint32(localOffset, true) !== LOCAL_HEADER) return yield* new KinuError('bad_input', 'corrupt zip: local header expected');
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const raw = archive.subarray(dataStart, dataStart + compressedSize);

      if (method === STORED) entries.push({ path: name, bytes: raw });
      else if (method === DEFLATED) entries.push({ path: name, bytes: yield* Effect.promise(() => inflate(raw)) });
      else return yield* new KinuError('unsupported', `zip entry ${JSON.stringify(name)} uses compression method ${String(method)}`);
    }

    return entries;
  });
}

/** Stored entries, in the order given. */
export function packZip(files: readonly ZipEntry[]): Uint8Array {
  return settleSync(packed(files));
}

function packed(files: readonly ZipEntry[]): Effect.Effect<Uint8Array, KinuError> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const problem = entryNameProblem(file.path);

    if (problem !== null) return Effect.fail(new KinuError('bad_input', `zip entry ${JSON.stringify(file.path)} ${problem}`));
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

  return Effect.succeed(archive);
}
