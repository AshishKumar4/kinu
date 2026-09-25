/** Argument-digest binding (agent-core SPEC §7.3/§1.4): deterministic, full SHA-256, every field bound. */

import { describe, expect, test } from 'bun:test';
import {
  argumentDigest, sha256Hex, stableStringify,
} from '../src/index';

describe('argumentDigest', () => {
  test('is deterministic and order-independent over object keys', () => {
    // Both spellings against one external pin, never each other: a self-comparison passes a constant.
    // printf '{"a":1,"b":2}' | sha256sum
    const KEYED_A1_B2 = '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777';
    expect(argumentDigest({ a: 1, b: 2 })).toBe(KEYED_A1_B2);
    expect(argumentDigest({ b: 2, a: 1 })).toBe(KEYED_A1_B2);
  });

  test('is a full-strength (64-hex / 256-bit) SHA-256, not a truncated fingerprint', () => {
    const d = argumentDigest({ cmd: 'deploy' });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(sha256Hex(stableStringify({ cmd: 'deploy' })));
    // Pinned against `printf '{"cmd":"deploy"}' | sha256sum`.
    expect(d).toBe('0cf3286509cd632a7cc63866f31b1f36660f23a9ef242f82a8080c7f8a23e2de');
  });

  test('a single-byte change in the arguments changes the digest', () => {
    expect(argumentDigest({ cmd: 'wrangler deploy' }))
      .not.toBe(argumentDigest({ cmd: 'wrangler deploy ' }));
  });
});
