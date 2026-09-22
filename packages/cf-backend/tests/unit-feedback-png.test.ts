// The screenshot trust boundary: claimed PNG bytes checked and stripped without a decoder.
// The CRC is deliberately independent of `png.ts`: a checksum verified by its own producer verifies nothing.
import { describe, test, expect } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { sanitizePng, type SanitizedPng } from '@kinu.run/core';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }

  return (c ^ 0xffffffff) >>> 0;
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: readonly number[] = []): number[] {
  const typed = [...new TextEncoder().encode(type)];
  const crc = crc32(new Uint8Array([...typed, ...data]));

  return [...be32(data.length), ...typed, ...data, ...be32(crc)];
}

function ihdr(width: number, height: number): number[] {
  return [...be32(width), ...be32(height), 8, 6, 0, 0, 0];
}

function png(...chunks: number[][]): Uint8Array {
  return new Uint8Array([...SIGNATURE, ...chunks.flat()]);
}

test('the fixture checksum answers the published CRC-32 check value', () => {
  // Anchors the independent CRC to an external answer (python3 binascii.crc32 of '123456789').
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
});

/** The sanitiser never decodes IDAT, so an opaque payload is what it sees. */
const PIXELS = chunk('IDAT', [0x78, 0x9c, 0x01, 0x02, 0x03]);

function accepted(result: SanitizedPng | { fault: string }): SanitizedPng {
  if ('fault' in result) throw new Error(`expected an accepted image, got fault ${result.fault}`);

  return result;
}

describe('sanitizePng — what it accepts', () => {
  test('a minimal well-formed image survives with its pixels intact', () => {
    const out = accepted(sanitizePng(png(chunk('IHDR', ihdr(4, 3)), PIXELS, chunk('IEND'))));
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    expect(out.stripped).toEqual([]);
    expect(out.bytes).toEqual(png(chunk('IHDR', ihdr(4, 3)), PIXELS, chunk('IEND')));
  });

  test('a spec-valid image with a real compressed pixel stream is accepted', () => {
    // Built, not pasted: 2x2 RGBA scanlines through real zlib, decodable by construction.
    const raw: number[] = [];

    for (let y = 0; y < 2; y += 1) {
      raw.push(0);

      for (let x = 0; x < 2; x += 1) raw.push(0xe0, 0xa4, 0x58, 0xff);
    }

    const real = png(
      chunk('IHDR', ihdr(2, 2)),
      chunk('IDAT', [...deflateSync(Buffer.from(raw))]),
      chunk('IEND'),
    );

    const out = accepted(sanitizePng(real));
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(out.bytes).toEqual(real);
  });

  test('colour-space chunks are kept — dropping them would shift the colours', () => {
    const out = accepted(sanitizePng(png(
      chunk('IHDR', ihdr(2, 2)), chunk('sRGB', [0]), chunk('gAMA', be32(45455)), PIXELS, chunk('IEND'),
    )));

    expect(out.stripped).toEqual([]);
  });
});

describe('sanitizePng — metadata never survives', () => {
  test('text, EXIF and timestamp chunks are dropped and the pixels are not', () => {
    const secret = [...new TextEncoder().encode('GPS: 51.5,-0.1')];

    const out = accepted(sanitizePng(png(
      chunk('IHDR', ihdr(2, 2)),
      chunk('tEXt', secret),
      chunk('eXIf', secret),
      chunk('tIME', [7, 0xea, 8, 24, 12, 0, 0]),
      chunk('pHYs', [...be32(2835), ...be32(2835), 1]),
      PIXELS,
      chunk('iTXt', secret),
      chunk('IEND'),
    )));

    expect(out.stripped).toEqual(['tEXt', 'eXIf', 'tIME', 'pHYs', 'iTXt']);
    expect(out.bytes).toEqual(png(chunk('IHDR', ihdr(2, 2)), PIXELS, chunk('IEND')));
    expect(Buffer.from(out.bytes).includes(Buffer.from(secret))).toBe(false);
  });

  test('an unknown chunk type is dropped by default, without naming it here', () => {
    // Default-deny: a metadata chunk invented later must not survive by missing a deny-list.
    const out = accepted(sanitizePng(png(
      chunk('IHDR', ihdr(1, 1)), chunk('zzZz', [1, 2, 3]), PIXELS, chunk('IEND'),
    )));

    expect(out.stripped).toEqual(['zzZz']);
  });
});

describe('sanitizePng — what it refuses', () => {
  test('bytes that are not a PNG, whatever they were declared to be', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, () => 0)]);
    expect(sanitizePng(jpeg)).toMatchObject({ fault: 'not-png' });
  });

  test('a PNG signature over filler bytes — the shape a forged upload takes', () => {
    // 0x41 filler declares a ~1.09 billion byte chunk: a valid signature alone buys nothing.
    const forged = new Uint8Array([...SIGNATURE, ...Array.from({ length: 32 }, () => 0x41)]);
    expect(sanitizePng(forged)).toMatchObject({ fault: 'truncated' });
  });

  test('a corrupted chunk body — the CRC is what catches it', () => {
    const bytes = png(chunk('IHDR', ihdr(4, 3)), PIXELS, chunk('IEND'));
    // First byte of IDAT data (8 + 25 + 8); lengths and signature stay valid, so only the CRC can notice.
    const at = 8 + 25 + 8;
    bytes[at] = bytes[at] ^ 0xff;
    expect(sanitizePng(bytes)).toMatchObject({ fault: 'bad-crc' });
  });

  test('a chunk that claims more bytes than the image holds', () => {
    const bytes = png(chunk('IHDR', ihdr(4, 3)), PIXELS, chunk('IEND'));
    bytes.set([0x7f, 0xff, 0xff, 0xff], 8);
    expect(sanitizePng(bytes)).toMatchObject({ fault: 'truncated' });
  });

  test('an image cut off before its end marker', () => {
    const whole = png(chunk('IHDR', ihdr(4, 3)), PIXELS, chunk('IEND'));
    expect(sanitizePng(whole.subarray(0, whole.length - 12))).toMatchObject({ fault: 'truncated' });
  });

  test('bytes appended after IEND — the shape a payload smuggled past a viewer takes', () => {
    const bytes = new Uint8Array([
      ...png(chunk('IHDR', ihdr(1, 1)), PIXELS, chunk('IEND')),
      ...new TextEncoder().encode('<?php echo 1;'),
    ]);

    expect(sanitizePng(bytes)).toMatchObject({ fault: 'bad-structure' });
  });

  test('a header that does not come first', () => {
    expect(sanitizePng(png(chunk('sRGB', [0]), chunk('IHDR', ihdr(1, 1)), PIXELS, chunk('IEND'))))
      .toMatchObject({ fault: 'bad-structure' });
  });

  test('an image with no pixel data at all', () => {
    expect(sanitizePng(png(chunk('IHDR', ihdr(1, 1)), chunk('IEND'))))
      .toMatchObject({ fault: 'bad-structure' });
  });

  const dimensionCases = [
    { name: 'a zero dimension', width: 0, height: 4, fault: 'bad-structure' },
    // 900 megapixels from a few hundred wire bytes, refused on the header before anything decodes.
    {
      name: 'a decompression bomb: small bytes declaring an enormous frame',
      width: 30_000, height: 30_000, fault: 'dimensions',
    },
    {
      name: 'a single axis past the per-axis bound is refused on its own terms',
      width: 1, height: 40_000, fault: 'dimensions',
    },
  ] as const;

  for (const { name, width, height, fault } of dimensionCases) {
    test(name, () => {
      expect(sanitizePng(png(chunk('IHDR', ihdr(width, height)), PIXELS, chunk('IEND'))))
        .toMatchObject({ fault });
    });
  }
});
