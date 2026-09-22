// Server-side trust boundary for screenshots. Workers have no image decoder, so this walks the chunk stream:
// CRC validation and metadata stripping are one lossless pass over a default-deny keep-list.

/** Closed so callers map it with an exhaustive switch instead of matching text. */
export type PngFault =
  | 'not-png'
  | 'truncated'
  | 'bad-crc'
  | 'bad-structure'
  | 'dimensions';

export interface SanitizedPng {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Dropped chunk types, in stream order. */
  stripped: string[];
}

export interface PngRejection {
  fault: PngFault;
  /** Safe to return to the reporter. */
  error: string;
}

/** Spec 5.2. */
const SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Pixel data and what is needed to render it. Deliberately absent: text chunks, eXIf, tIME, pHYs, APNG. */
const PIXEL_CHUNKS: Readonly<Record<string, true>> = Object.freeze({
  IHDR: true, PLTE: true, IDAT: true, IEND: true,
  tRNS: true, hIST: true, bKGD: true, sBIT: true,
  gAMA: true, cHRM: true, sRGB: true, iCCP: true,
});

/** Compressible PNGs expand enormously when decoded; this is above any real full-page screenshot. */
const MAX_PIXELS = 60_000_000;

/** Per-axis bound, so a thin strip is refused on its own terms. */
const MAX_AXIS = 32_768;

let table: Uint32Array | null = null;

/** CRC-32/ISO-HDLC (spec 5.5). */
function crcTable(): Uint32Array {
  if (table !== null) return table;
  const built = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    built[n] = c >>> 0;
  }

  table = built;

  return built;
}

function crc32(bytes: Uint8Array, from: number, to: number): number {
  const lookup = crcTable();
  let c = 0xffffffff;

  for (let i = from; i < to; i += 1) {
    c = lookup[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** Non-letters mean the stream is lost, not an unknown chunk: a structural fault. */
function readType(bytes: Uint8Array, at: number): string | null {
  let type = '';

  for (let i = at; i < at + 4; i += 1) {
    const code = bytes[i];
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

    if (!isLetter) return null;
    type += String.fromCharCode(code);
  }

  return type;
}

/** Never throws: every fault is a returned `PngRejection`. */
export function sanitizePng(bytes: Uint8Array): SanitizedPng | PngRejection {
  if (bytes.length < SIGNATURE.length + 12) {
    return { fault: 'not-png', error: 'not a PNG image (too short to hold a header)' };
  }

  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) {
      return { fault: 'not-png', error: 'not a PNG image (bad signature)' };
    }
  }

  const keep: { from: number; to: number }[] = [];
  const stripped: string[] = [];
  let at = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;

  while (at < bytes.length) {
    if (sawIend) {
      return { fault: 'bad-structure', error: 'trailing bytes after the end of the image' };
    }

    // length(4) + type(4) + data(length) + crc(4)
    if (at + 8 > bytes.length) {
      return { fault: 'truncated', error: 'image ends inside a chunk header' };
    }

    const length = readUint32(bytes, at);
    const type = readType(bytes, at + 4);

    if (type === null) {
      return { fault: 'bad-structure', error: 'chunk type is not four ASCII letters' };
    }

    // Checked before adding to `at`: `length` is a full uint32.
    if (length > bytes.length) {
      return { fault: 'truncated', error: `chunk ${type} declares more bytes than the image holds` };
    }

    const dataAt = at + 8;
    const crcAt = dataAt + length;

    if (crcAt + 4 > bytes.length) {
      return { fault: 'truncated', error: `chunk ${type} runs past the end of the image` };
    }

    if (crc32(bytes, at + 4, crcAt) !== readUint32(bytes, crcAt)) {
      return { fault: 'bad-crc', error: `chunk ${type} fails its checksum` };
    }

    if (!sawIhdr && type !== 'IHDR') {
      return { fault: 'bad-structure', error: 'first chunk is not IHDR' };
    }

    if (type === 'IHDR') {
      if (sawIhdr) return { fault: 'bad-structure', error: 'more than one IHDR' };

      if (length !== 13) return { fault: 'bad-structure', error: 'IHDR is not 13 bytes' };
      width = readUint32(bytes, dataAt);
      height = readUint32(bytes, dataAt + 4);

      if (width === 0 || height === 0) {
        return { fault: 'bad-structure', error: 'image has a zero dimension' };
      }

      if (width > MAX_AXIS || height > MAX_AXIS || width * height > MAX_PIXELS) {
        return {
          fault: 'dimensions',
          error: `image is ${String(width)}×${String(height)}, larger than this endpoint accepts`,
        };
      }

      sawIhdr = true;
    }

    if (type === 'IDAT') sawIdat = true;

    if (type === 'IEND') {
      if (length !== 0) return { fault: 'bad-structure', error: 'IEND carries data' };
      sawIend = true;
    }

    if (PIXEL_CHUNKS[type] === true) keep.push({ from: at, to: crcAt + 4 });
    else stripped.push(type);
    at = crcAt + 4;
  }

  if (!sawIdat) return { fault: 'bad-structure', error: 'image carries no pixel data' };

  if (!sawIend) return { fault: 'truncated', error: 'image has no end marker' };

  let size = SIGNATURE.length;

  for (const span of keep) size += span.to - span.from;
  const out = new Uint8Array(size);
  out.set(SIGNATURE, 0);
  let write = SIGNATURE.length;

  for (const span of keep) {
    out.set(bytes.subarray(span.from, span.to), write);
    write += span.to - span.from;
  }

  return { bytes: out, width, height, stripped };
}
