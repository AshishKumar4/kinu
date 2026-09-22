/**
 * Argument digest an approval binds and a resume verifies (agent-core SPEC §7.3/§1.4).
 * Must be SHA-256, not fnv1a: the threat is a crafted collision between approved and executed payloads.
 */

import { createHash } from 'node:crypto';
import { isJsonObject, type JsonValue } from '../utils/json';

/** Deterministic JSON serializer (object keys sorted). */
export function stableStringify(value: JsonValue): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';

  if (!isJsonObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();

  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

/** Hex SHA-256; `hexChars` truncates (omit for the full collision-resistant digest). */
export function sha256Hex(data: string | Uint8Array, hexChars?: number): string {
  const hex = createHash('sha256').update(data).digest('hex');

  return hexChars ? hex.slice(0, hexChars) : hex;
}

export function argumentDigest(args: JsonValue): string {
  return sha256Hex(stableStringify(args));
}
