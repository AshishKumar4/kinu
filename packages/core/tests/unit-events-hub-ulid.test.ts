// Monotonic ULIDs: `ORDER BY id` must equal creation order within one millisecond.
import { describe, test, expect } from 'bun:test';
import { isUlid, ulid } from '../src/events/hub/ulid';

describe('ulid', () => {
  test('a same-millisecond burst stays strictly increasing', () => {
    const ids = Array.from({ length: 2000 }, () => ulid());
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

});

/** `isUlid` gates the signed webhook path before a DO is addressed, so what it refuses is
 *  the contract. */
describe('isUlid', () => {
  test('accepts what ulid() mints', () => {
    for (let i = 0; i < 100; i++) expect(isUlid(ulid())).toBe(true);
  });

  test('refuses anything else', () => {
    const minted = ulid();
    expect(isUlid('')).toBe(false);
    expect(isUlid(minted.slice(0, -1))).toBe(false);
    expect(isUlid(`${minted}0`)).toBe(false);
    expect(isUlid(minted.toLowerCase())).toBe(false);
    expect(isUlid(`${minted.slice(0, -1)}/`)).toBe(false);
    expect(isUlid(`${minted.slice(0, -1)}-`)).toBe(false);

    // The four letters Crockford base32 excludes.
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(isUlid(`${minted.slice(0, -1)}${excluded}`)).toBe(false);
    }
  });
});
