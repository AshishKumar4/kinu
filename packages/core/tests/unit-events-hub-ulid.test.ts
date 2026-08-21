// ULID monotonic mode — `ORDER BY id` must equal creation order even within
// one millisecond (`agent_log`'s id-ordered scans ride on this: the latest
// phase is `ORDER BY received_at DESC, id DESC LIMIT 1` and a step trace is
// `ORDER BY step_idx, id` — hub/log.ts:572,589).
import { describe, test, expect } from 'bun:test';
import { ulid, ulidTime, ulidCompare } from '../src/events/hub/ulid';

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
