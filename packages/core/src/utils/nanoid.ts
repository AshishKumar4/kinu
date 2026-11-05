import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** The largest multiple of the alphabet a byte reaches: a byte at or past it is drawn again, so no letter is likelier. */
const UNBIASED_BELOW = 256 - (256 % ALPHABET.length);

export function nanoid(size = 21): string {
  // A fractional or negative size would draw nothing and loop for ever.
  if (!Number.isSafeInteger(size) || size < 0) return settleSync(Effect.fail(new KinuError('bad_input', `an id's size is a whole count, not ${String(size)}`)));
  let id = '';

  while (id.length < size) {
    for (const byte of crypto.getRandomValues(new Uint8Array(size - id.length))) {
      if (byte < UNBIASED_BELOW) id += ALPHABET[byte % ALPHABET.length];
    }
  }

  return id;
}
