/** CRC-32/ISO-HDLC, the checksum ZIP entries and PNG chunks carry. */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;

  for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}
