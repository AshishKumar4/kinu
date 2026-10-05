/** A raster image's type and size from its header bytes: what a provider prices and a model is shown. */

export interface RasterImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

/** Null for anything else, or a header too short to name a size. */
export function rasterImage(bytes: Uint8Array): RasterImage | null {
  const at = (index: number): number => bytes[index] ?? 0;
  const be16 = (index: number): number => (at(index) << 8) | at(index + 1);
  const le16 = (index: number): number => at(index) | (at(index + 1) << 8);
  const le24 = (index: number): number => le16(index) | (at(index + 2) << 16);

  const ascii = (index: number, text: string): boolean => {
    for (let offset = 0; offset < text.length; offset++) if (at(index + offset) !== text.charCodeAt(offset)) return false;

    return true;
  };

  const sized = (mediaType: RasterImage['mediaType'], width: number, height: number): RasterImage | null =>
    width > 0 && height > 0 ? { mediaType, width, height } : null;

  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 'PNG')) return sized('image/png', (be16(16) << 16) | be16(18), (be16(20) << 16) | be16(22));

  if (bytes.length >= 10 && ascii(0, 'GIF8')) return sized('image/gif', le16(6), le16(8));

  if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) return sized('image/webp', le16(26) & 0x3fff, le16(28) & 0x3fff);

    if (ascii(12, 'VP8L')) {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);

      return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }

    if (ascii(12, 'VP8X')) return sized('image/webp', le24(24) + 1, le24(27) + 1);

    return null;
  }

  return at(0) === 0xff && at(1) === 0xd8 ? jpegSize(bytes, be16) : null;
}

/** Start-of-frame markers carry the size; every other segment is skipped by its length. */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array, be16: (index: number) => number): RasterImage | null {
  let index = 2;

  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) return null;
    const marker = bytes[index + 1] ?? 0;

    if (marker === 0xff) {
      index += 1;
      continue;
    }

    if (JPEG_FRAMES.has(marker)) {
      const height = be16(index + 5);
      const width = be16(index + 7);

      return width > 0 && height > 0 ? { mediaType: 'image/jpeg', width, height } : null;
    }

    index += marker >= 0xd0 && marker <= 0xd9 ? 2 : 2 + be16(index + 2);
  }

  return null;
}
