/**
 * The runtime catalog a deployment pins. A hosted workspace's `nimbus install` reads its toolchain catalog from the
 * NIMBUS_RUNTIME_CACHE bucket by the digest the deployment's NIMBUS_RUNTIME_CATALOG_SHA256 var names,
 * `catalog/sha256/<sha256>.json` (@nimbus-sh/worker dist/runtime/runtime-catalog.js), and refuses when it is absent.
 * Nimbus's publish writes `catalog/v1.json`; the digest-addressed copy is this one's to make.
 *
 *   bun scripts/runtime-catalog.ts ensure <bucket> <sha256>
 *
 * Leaves a `catalog/sha256/<sha256>.json` that hashes to its name in place; else copies `catalog/v1.json` there when its
 * bytes hash to the pin; else exits 1 naming both digests. deploy.sh runs it for the bucket and pin it deploys.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const LATEST = 'catalog/v1.json';

/** The bucket as this script needs it: an object's bytes, absent as undefined, and a write. */
export interface CatalogBucket {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
}

export type CatalogOutcome =
  | { readonly kind: 'present'; readonly key: string }
  | { readonly kind: 'copied'; readonly key: string }
  | { readonly kind: 'refused'; readonly reason: string };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** `catalog/sha256/<pinned>.json` present and true to its name, copying the latest catalog there when that is the pin. */
export async function ensureRuntimeCatalog(bucket: CatalogBucket, pinned: string): Promise<CatalogOutcome> {
  if (!/^[0-9a-f]{64}$/.test(pinned)) return { kind: 'refused', reason: `the pin ${JSON.stringify(pinned)} is not a SHA-256` };

  const key = `catalog/sha256/${pinned}.json`;
  const held = await bucket.read(key);

  if (held !== undefined) {
    const digest = sha256(held);

    return digest === pinned ? { kind: 'present', key } : { kind: 'refused', reason: `${key} hashes to ${digest}, not its name` };
  }

  const latest = await bucket.read(LATEST);

  if (latest === undefined) return { kind: 'refused', reason: `${key} and ${LATEST} are both absent` };
  const digest = sha256(latest);

  if (digest !== pinned) {
    return { kind: 'refused', reason: `${key} is absent and ${LATEST} hashes to ${digest}, not the pinned ${pinned}: pin NIMBUS_RUNTIME_CATALOG_SHA256 to the catalog it means` };
  }

  await bucket.write(key, latest);

  return { kind: 'copied', key };
}

function wrangler(args: readonly string[]) {
  const ran = spawnSync(join(import.meta.dir, '..', 'node_modules/.bin/wrangler'), args, {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, maxBuffer: 64 * 1024 * 1024,
  });

  return { ok: ran.status === 0, stdout: new Uint8Array(ran.stdout), out: `${ran.stdout.toString()}${ran.stderr.toString()}` };
}

/** `name`, read and written with wrangler against the remote bucket. */
function remoteBucket(name: string): CatalogBucket {
  return {
    read: async (key) => {
      const got = wrangler(['r2', 'object', 'get', `${name}/${key}`, '--remote', '--pipe']);

      if (got.ok) return got.stdout;

      if (/does not exist|not found|NoSuchKey/i.test(got.out)) return undefined;
      throw new Error(`reading ${name}/${key} failed:\n${got.out.slice(-1500)}`);
    },
    write: async (key, bytes) => {
      const dir = mkdtempSync(join(tmpdir(), 'kinu-runtime-catalog-'));

      try {
        const file = join(dir, 'catalog.json');

        writeFileSync(file, bytes);
        const put = wrangler(['r2', 'object', 'put', `${name}/${key}`, '--file', file, '--content-type', 'application/json', '--remote']);

        if (!put.ok) throw new Error(`writing ${name}/${key} failed:\n${put.out.slice(-1500)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function main(): Promise<number> {
  const [command, bucket, pinned] = process.argv.slice(2);

  if (command !== 'ensure' || bucket === undefined || pinned === undefined) {
    process.stderr.write('usage: bun scripts/runtime-catalog.ts ensure <bucket> <sha256>\n');

    return 2;
  }

  const outcome = await ensureRuntimeCatalog(remoteBucket(bucket), pinned);

  if (outcome.kind === 'refused') {
    process.stderr.write(`${bucket}: ${outcome.reason}\n`);

    return 1;
  }

  process.stdout.write(`${bucket}/${outcome.key} ${outcome.kind === 'copied' ? `copied from ${LATEST}` : 'is in place'}\n`);

  return 0;
}

if (import.meta.main) process.exitCode = await main();
