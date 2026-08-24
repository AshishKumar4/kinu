/**
 * PNG validation and metadata removal, decoder-free.
 *
 * A feedback screenshot arrives as bytes from a browser we do not control, and
 * two things have to be true before it reaches storage: it really is a PNG, and
 * it carries no metadata. The client already re-encodes through a canvas, which
 * by construction emits pixels and nothing else — but that is the client's
 * claim about itself, and the trust boundary is here.
 *
 * A Worker has no image decoder, so re-encoding server-side is not available.
 * Rewriting the CHUNK STREAM is, and it is strictly better for this job: PNG is
 * a sequence of length-prefixed CRC-checked chunks, so to emit a filtered copy
 * you must walk every chunk and verify every CRC. Validation and stripping are
 * therefore the same pass, and the result is lossless — pixels are never
 * touched, only chunks that are not pixels.
 *
 * The keep-list is DEFAULT-DENY: a chunk survives only by being named as
 * carrying pixels or as required to interpret them. Anything else, including a
 * chunk type that does not exist yet, is dropped without a code change here.
 * That is the property that matters, because the metadata risk is open-ended
 * (`tEXt` holds arbitrary strings, `eXIf` holds GPS and device identity) while
 * the rendering requirement is a closed, specified list.
 */

/** What made a byte string unacceptable. Closed, so a caller maps it to a
 *  status and a metric with an exhaustive switch instead of matching text. */
export type PngFault =
  /** The 8-byte signature is absent — not a PNG at all, whatever it claimed. */
  | 'not-png'
  /** A chunk header or body runs past the end of the buffer. */
  | 'truncated'
  /** A chunk's CRC does not match its bytes. */
  | 'bad-crc'
  /** Chunk order, required chunks, or trailing bytes violate the format. */
  | 'bad-structure'
  /** Header declares an image too large to be a screenshot of anything. */
  | 'dimensions';

export interface SanitizedPng {
  /** The same image with every non-pixel chunk removed. */
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Chunk types dropped, in stream order — what the strip actually removed. */
  stripped: string[];
}

export interface PngRejection {
  fault: PngFault;
  /** Human-readable reason, safe to return to the reporter. */
  error: string;
}

/** PNG's fixed 8-byte signature (spec 5.2). */
const SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Chunks that carry pixels or are required to interpret them, and NOTHING else.
 *
 *   IHDR PLTE IDAT IEND  — the critical chunks; an image is not decodable without them
 *   tRNS                 — transparency, i.e. per-pixel alpha for palette/greyscale
 *   hIST bKGD sBIT       — how the palette and sample depth are rendered
 *   gAMA cHRM sRGB iCCP  — colour space, without which colours shift
 *
 * Deliberately absent, and each for its own reason:
 *   tEXt zTXt iTXt  arbitrary caller-supplied strings — the whole risk
 *   eXIf            EXIF, i.e. GPS, device model, capture time
 *   tIME            a wall-clock timestamp of the encode
 *   pHYs            physical resolution; a display hint, and a device hint
 *   acTL fcTL fdAT  APNG animation, which a screenshot is not
 */
const PIXEL_CHUNKS: Readonly<Record<string, true>> = Object.freeze({
  IHDR: true, PLTE: true, IDAT: true, IEND: true,
  tRNS: true, hIST: true, bKGD: true, sBIT: true,
  gAMA: true, cHRM: true, sRGB: true, iCCP: true,
});

/**
 * Pixel ceiling. The 8 MiB transfer cap bounds what crosses the wire, but a
 * highly compressible PNG expands enormously once decoded — 8 MiB of flat
 * colour can describe an image no viewer should be asked to open. 60 megapixels
 * is above any real full-page screenshot (a 2560-wide page would have to run
 * 23,000 CSS pixels tall at device-pixel-ratio 1) and bounds a decoded frame at
 * roughly 240 MB of RGBA rather than unbounded.
 */
const MAX_PIXELS = 60_000_000;
/** Per-axis bound, so a 1×60,000,000 strip is refused on its own terms. */
const MAX_AXIS = 32_768;

let table: Uint32Array | null = null;

/** CRC-32/ISO-HDLC, the one PNG specifies (spec 5.5). Table built once per
 *  isolate; a screenshot-sized buffer is one linear pass over 8 MiB. */
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

/** Big-endian uint32, the only integer encoding PNG uses. */
function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** A chunk type is four ASCII letters. Anything else means we have lost the
 *  stream, not that we met an unknown chunk — so it is a structural fault. */
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

/**
 * Validate `bytes` as a PNG and return a copy holding only pixel-bearing
 * chunks. Never throws: every fault is a returned `PngRejection`.
 *
 * The walk is the validation. A forged file — anything whose declared type says
 * PNG while its bytes say otherwise — fails here rather than at whatever opens
 * the object later, because a length prefix that does not match its CRC cannot
 * be reconstructed into a valid stream.
 */
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
    // Compared against the buffer BEFORE being added to `at`: `length` is a
    // full uint32, so a hostile value would otherwise be added first and only
    // then found impossible.
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
