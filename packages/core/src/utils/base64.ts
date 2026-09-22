/** `btoa`/`atob` exist on every backend; chunked so large buffers don't overflow `String.fromCharCode`'s argument stack. */

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
