// A preview port's token is its only secret: each of its sixteen symbols must be as likely as any other. A byte taken
// modulo 36 made the first four (256 mod 36) a third more likely than the rest.
import { expect, test } from 'bun:test';
import { generatePortToken, PORT_TOKEN_LENGTH } from '../src/lifecycle';

test('every symbol of a port token is equally likely: a byte past the last whole multiple of the alphabet is drawn again', () => {
  // Each draw answers every byte value once, in order, wrapping, so a whole number of draws covers each value evenly.
  let next = 0;
  const counts = new Map<string, number>();

  const random = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => {
    const byte = next % 256;

    next += 1;

    return byte;
  });

  for (let token = 0; token < 252 * 16; token++) {
    for (const symbol of generatePortToken(random)) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }

  expect(new Set(counts.values()).size).toBe(1);
  expect(counts.size).toBe(36);
  expect(generatePortToken(random)).toHaveLength(PORT_TOKEN_LENGTH);
});
