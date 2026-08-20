// Typed, expiring JSON records in Workers KV — one home for the two rules every
// KV caller here would otherwise restate.
//
// Bytes coming back out of KV were written by some earlier deployment of this
// Worker, so they are outside the type system: every read is parsed against the
// schema its writer used, and a record that does not parse is a real fault, not
// an absent key.
//
// KV refuses an `expirationTtl` below 60 seconds. Callers hold an absolute
// expiry, not a TTL, so the conversion lives here and floors at 60: a record
// with less than a minute left may outlive its own deadline by up to a minute,
// which is harmless because the deadline is inside the record and every reader
// checks it.

import * as v from 'valibot';

const MIN_TTL_SECONDS = 60;

/** The KV surface this Worker's expiring state actually uses. A `KVNamespace`
 *  binding satisfies it structurally, and a test double can satisfy it without
 *  impersonating forty overloads of a bulk-read API nothing here calls. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export async function readKvJson<Schema extends v.GenericSchema>(
  kv: KvStore,
  key: string,
  schema: Schema,
): Promise<v.InferOutput<Schema> | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  return v.parse(schema, JSON.parse(raw));
}

export async function writeKvJson<Value>(
  kv: KvStore,
  key: string,
  value: Value,
  expiresAtMs: number,
): Promise<void> {
  const ttl = Math.max(MIN_TTL_SECONDS, Math.ceil((expiresAtMs - Date.now()) / 1000));
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}
