// Typed, expiring JSON records in KV. A record that fails its schema is a fault, not an absent key.
// KV refuses an `expirationTtl` below 60 seconds, so TTLs floor at 60; readers check the in-record deadline.

import * as v from 'valibot';

const MIN_TTL_SECONDS = 60;

/** The KV surface used here; a `KVNamespace` binding satisfies it structurally. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

type KvJson = string | number | boolean | null | readonly KvJson[] | { readonly [key: string]: KvJson };

/** Always a record: every reader parses with a record schema. */
type KvRecord = { readonly [key: string]: KvJson };

export async function readKvJson<Schema extends v.GenericSchema>(
  kv: KvStore,
  key: string,
  schema: Schema,
): Promise<v.InferOutput<Schema> | null> {
  const raw = await kv.get(key);

  if (raw === null) return null;

  return v.parse(schema, JSON.parse(raw));
}

export async function writeKvJson(
  kv: KvStore,
  key: string,
  value: KvRecord,
  expiresAtMs: number,
): Promise<void> {
  const ttl = Math.max(MIN_TTL_SECONDS, Math.ceil((expiresAtMs - Date.now()) / 1000));
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}
