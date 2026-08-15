/**
 * Argument digest — the collision-resistant binding an approval commits to.
 *
 * agent-core SPEC §7.3/§1.4: an Approval authorizes ONE described invocation,
 * identified by a `Digest` (SHA-256 or stronger) over the exact arguments. The
 * resume path recomputes the digest of what is about to execute and rejects a
 * mismatch — so a granted "yes to these arguments" cannot be redirected to
 * different arguments across the approve→execute gap (TOCTOU / injection).
 *
 * SHA-256 (not the fast non-cryptographic fnv1a used for prefix fingerprints)
 * is required: the threat model is an adversary crafting a benign-looking
 * approval payload that collides with a malicious execute payload.
 */

import { createHash } from 'node:crypto';
import { isJsonObject, type JsonValue } from '../utils/json.js';

/** Deterministic JSON serializer: object keys sorted, so structurally equal
 *  values always serialize identically regardless of key insertion order. */
export function stableStringify(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (!isJsonObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]!)).join(',') + '}';
}

/** Hex SHA-256 of a string. `hexChars` truncates the output (dedupe keys use a
 *  short prefix); omit it for the full collision-resistant digest. */
export function sha256Hex(text: string, hexChars?: number): string {
  const hex = createHash('sha256').update(text).digest('hex');
  return hexChars ? hex.slice(0, hexChars) : hex;
}

/** The full-strength argument digest an approval binds and a resume verifies:
 *  SHA-256 over the deterministic serialization of the action arguments. */
export function argumentDigest(args: JsonValue): string {
  return sha256Hex(stableStringify(args));
}
