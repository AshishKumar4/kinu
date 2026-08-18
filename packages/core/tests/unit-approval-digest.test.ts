/**
 * Argument-digest binding (agent-core SPEC §7.3/§1.4). The digest is the
 * collision-resistant commitment an approval makes to its exact arguments;
 * a resume recomputes it and rejects any drift. These assert the primitive
 * is deterministic, full-strength SHA-256, and sensitive to every bound field.
 */

import { describe, expect, test } from 'bun:test';
import {
  argumentDigest, sha256Hex, stableStringify,
  deployApprovalDigest,
} from '../src/index';

describe('argumentDigest', () => {
  test('is deterministic and order-independent over object keys', () => {
    expect(argumentDigest({ a: 1, b: 2 })).toBe(argumentDigest({ b: 2, a: 1 }));
  });

  test('is a full-strength (64-hex / 256-bit) SHA-256, not a truncated fingerprint', () => {
    const d = argumentDigest({ cmd: 'deploy' });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(sha256Hex(stableStringify({ cmd: 'deploy' })));
  });

  test('a single-byte change in the arguments changes the digest', () => {
    expect(argumentDigest({ cmd: 'wrangler deploy' }))
      .not.toBe(argumentDigest({ cmd: 'wrangler deploy ' }));
  });
});

describe('deployApprovalDigest', () => {
  const base = { approvalType: 'deploy_production' as const, patch: 'diff X', command: 'bunx wrangler deploy' };

  test('stable for identical deploy identity', () => {
    expect(deployApprovalDigest(base)).toBe(deployApprovalDigest({ ...base }));
  });

  test('changes when the patch changes (artifact swap)', () => {
    expect(deployApprovalDigest(base)).not.toBe(deployApprovalDigest({ ...base, patch: 'diff X mutated' }));
  });

  test('changes when the command changes (argument swap)', () => {
    expect(deployApprovalDigest(base)).not.toBe(deployApprovalDigest({ ...base, command: 'bunx wrangler deploy --evil' }));
  });

  test('changes when the environment/approval type changes', () => {
    expect(deployApprovalDigest(base)).not.toBe(deployApprovalDigest({ ...base, approvalType: 'deploy_staging' }));
  });

  test('null command and null patch are bound distinctly (not conflated)', () => {
    expect(deployApprovalDigest({ approvalType: 'apply', patch: null, command: null }))
      .not.toBe(deployApprovalDigest({ approvalType: 'apply', patch: '', command: null }));
  });
});
