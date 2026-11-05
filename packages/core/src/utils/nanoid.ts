const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** The largest multiple of the alphabet a byte reaches: a byte at or past it is drawn again, so no letter is likelier. */
const UNBIASED_BELOW = 256 - (256 % ALPHABET.length);

export function nanoid(size = 21): string {
  let id = '';

  while (id.length < size) {
    for (const byte of crypto.getRandomValues(new Uint8Array(size - id.length))) {
      if (byte < UNBIASED_BELOW) id += ALPHABET[byte % ALPHABET.length];
    }
  }

  return id;
}
