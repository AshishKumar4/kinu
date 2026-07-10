// ULID monotonic mode — `ORDER BY id` must equal creation order even within
// one millisecond (the peer outbox's per-receiver ordering rides on this).
import { describe, test, expect } from 'bun:test';
import { ulid, ulidTime, ulidCompare } from '../src/events/hub/ulid.ts';

describe('ulid', () => {
  test('a same-millisecond burst stays strictly increasing', () => {
    const ids = Array.from({ length: 2000 }, () => ulid());
    for (let i = 1; i < ids.length; i++) {
      expect(ulidCompare(ids[i - 1], ids[i])).toBe(-1);
    }
  });

  test('encodes the creation timestamp', () => {
    const before = Date.now();
    const id = ulid();
    const after = Date.now();
    expect(ulidTime(id)).toBeGreaterThanOrEqual(before);
    expect(ulidTime(id)).toBeLessThanOrEqual(after);
  });
});
