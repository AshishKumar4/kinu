/** Binary ⇄ base64 over the platform primitives every backend has (`btoa` /
 *  `atob` exist in Workers, Bun and Node ≥16). Chunked so a multi-megabyte
 *  buffer cannot blow the argument stack of `String.fromCharCode`. */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
