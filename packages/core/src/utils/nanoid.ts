/** Tiny ID generator — no external dependencies. */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function nanoid(size = 21): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id;
}
