/**
 * Proofs that outlive their container. armada runs each CI row in a fresh container, so the ladder's cache
 * (`ladder-cache.ts`) died with it and every new commit ran every row. This mirrors the cache's entries to the R2
 * bucket {@link PROOFS_BUCKET}, so a row whose input closure an earlier commit already proved green carries that
 * proof instead of running again, and a small change runs only the rows its closure reaches.
 *
 * Nothing about soundness lives here: the key is still the closure hash `ladder-cache.ts` computes (the command,
 * every closure file's bytes, the hashed environment, the toolchain), and a lookup still reads the local store. This
 * only copies an entry into the local store before the lookup and out of it after a green record.
 *
 * Each object holds the entry and an HMAC-SHA256 over its key and its bytes, keyed by the R2 secret: an entry edited
 * in the bucket, or copied under another key, reads as absent, and so does one the bucket cannot answer for. Absent
 * is a run, never a pass. The bucket expires objects after 90 days; an expired proof is a run too.
 *
 * The credentials are armada secrets every CI task holds, under names of their own (KINU_PROOFS_ACCESS_KEY_ID,
 * KINU_PROOFS_SECRET_ACCESS_KEY). {@link fromEnvironment} reads them and deletes them from the environment before any
 * gate spawns, so no row sees them. `R2_*` is left alone: gate:devbox-e2e copies the staging tools with it, and on
 * 2026-10-08 (the f69a2671a staging deploy) the proof store deleting it failed that gate.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { S3Client } from 'bun';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { EntrySchema, type Store } from './ladder-cache';

export const PROOFS_BUCKET = 'kinu-ci-proofs';

/** The account the bucket lives in; scripts/deploy.sh and the devbox tools name the same one. */
const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

/** The names of the two secrets, removed from the environment once read. Never a gate's own names. */
export const PROOF_SECRET_NAMES = ['KINU_PROOFS_ACCESS_KEY_ID', 'KINU_PROOFS_SECRET_ACCESS_KEY'] as const;

/** The bucket as this module uses it: an object's text or null when there is none, and a write. */
export interface ProofBucket {
  read(key: string): Promise<string | null>;
  write(key: string, text: string): Promise<void>;
}

/** What a pull found: a verified entry copied into the store, none, one that is not a proof, or no answer. */
export type Pulled =
  | { readonly kind: 'pulled' | 'absent' | 'unverified' }
  | { readonly kind: 'unreachable'; readonly why: string };

export interface RemoteProofs {
  /** Copies the bucket's entry for `key` into `store`, when its HMAC checks. */
  pull(key: string, store: Store): Promise<Pulled>;
  /** Uploads the store's entries for `keys`; an upload that fails is named, never fatal: the proof is only lost. */
  push(keys: readonly string[], store: Store): Promise<string[]>;
}

const ObjectSchema = v.object({ entry: EntrySchema, mac: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)) });

function macOf(secret: string, key: string, entry: string): string {
  return createHmac('sha256', secret).update(`${key}\n${entry}`).digest('hex');
}

function verified(secret: string, key: string, text: string): v.InferOutput<typeof EntrySchema> | undefined {
  const parsed = v.safeParse(ObjectSchema, tolerate(() => JSON.parse(text), 'malformed-input'));

  if (!parsed.success) return undefined;
  const expected = Buffer.from(macOf(secret, key, JSON.stringify(parsed.output.entry)), 'hex');

  return timingSafeEqual(expected, Buffer.from(parsed.output.mac, 'hex')) ? parsed.output.entry : undefined;
}

export function remoteProofs(bucket: ProofBucket, secret: string): RemoteProofs {
  return {
    async pull(key, store) {
      let text: string | null;

      try {
        text = await bucket.read(key);
      } catch (cause) {
        return { kind: 'unreachable', why: cause instanceof Error ? cause.message : String(cause) };
      }

      if (text === null) return { kind: 'absent' };
      const entry = verified(secret, key, text);

      if (entry === undefined) return { kind: 'unverified' };
      store.record(key, entry);

      return { kind: 'pulled' };
    },
    async push(keys, store) {
      const lost: string[] = [];

      for (const key of keys) {
        const found = store.lookup(key);

        if (found.kind !== 'entry') continue;
        const entry = JSON.stringify(found.entry);

        try {
          await bucket.write(key, JSON.stringify({ entry: found.entry, mac: macOf(secret, key, entry) }));
        } catch (cause) {
          lost.push(`${key.slice(0, 12)}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      return lost;
    },
  };
}

/** The bucket over R2's S3 API. */
export function r2Bucket(accessKeyId: string, secretAccessKey: string): ProofBucket {
  const client = new S3Client({ accessKeyId, secretAccessKey, bucket: PROOFS_BUCKET, endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com` });

  return {
    async read(key) {
      const file = client.file(key);

      return await file.exists() ? await file.text() : null;
    },
    async write(key, text) {
      await client.write(key, text, { type: 'application/json' });
    },
  };
}

/**
 * The remote proofs these credentials reach, or undefined when the environment holds none. Either way both names are
 * deleted from `env`, so no gate this process spawns inherits them.
 */
export function fromEnvironment(env: Record<string, string | undefined>): RemoteProofs | undefined {
  const [accessKeyId, secretAccessKey] = PROOF_SECRET_NAMES.map((name) => env[name]?.trim() ?? '');

  for (const name of PROOF_SECRET_NAMES) Reflect.deleteProperty(env, name);

  if (accessKeyId === undefined || secretAccessKey === undefined || accessKeyId === '' || secretAccessKey === '') return undefined;

  return remoteProofs(r2Bucket(accessKeyId, secretAccessKey), secretAccessKey);
}
