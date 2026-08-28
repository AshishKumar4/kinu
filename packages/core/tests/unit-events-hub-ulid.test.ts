// ULID monotonic mode — `ORDER BY id` must equal creation order even within
// one millisecond (`agent_log`'s id-ordered scans ride on this: the latest
// phase is `ORDER BY received_at DESC, id DESC LIMIT 1` and a step trace is
// `ORDER BY step_idx, id` — hub/log.ts:572,589).
import { describe, test, expect } from 'bun:test';
import { isUlid, ulid, ulidTime, ulidCompare } from '../src/events/hub/ulid';

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

/** `isUlid` gates a security decision — the signed webhook delivery path
 *  refuses a trigger segment it rejects before addressing a Durable Object
 *  (cf-backend/src/events/webhook-route.ts) — so what it REFUSES is the
 *  contract, not only what it accepts. */
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
    // The four letters Crockford base32 excludes, so a transcription error
    // cannot be mistaken for an id this process could have minted.
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(isUlid(`${minted.slice(0, -1)}${excluded}`)).toBe(false);
    }
  });
});
