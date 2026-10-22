/**
 * The devbox tools tarball (D65, D78): built on armada by the `devbox-tools` task (armada/devbox-tools.ts) from
 * cloudflare/debian-trixie, tools-setup.sh and tools-build.sh, and pinned in packages/devbox/block-lower/upstream.json,
 * the way the image is. A box reads it from its environment's store bucket in parts of at most 256 MiB,
 * `devbox-tools/<sha256>.tgz.0` first, and checks the whole against the pin.
 *
 *   bun scripts/devbox-tools.ts build [<file>]     builds it, prints the `tools` record for upstream.json, and writes it
 *                                                   to <file> (for devbox-container-tier.ts --tools)
 *   bun scripts/devbox-tools.ts publish <bucket>   uploads the pinned tarball's parts, built again, unless the bucket holds them
 *   bun scripts/devbox-tools.ts check <bucket>     exits 1, naming the part, when the bucket lacks one
 *   bun scripts/devbox-tools.ts release <store> <releases>  copies the parts into the channel's releases bucket, inside R2,
 *                                                   unless it holds them: a self-deployment copies them from the channel
 *
 * deploy.sh builds nothing: it runs `check` on the store bucket it deploys, and refuses by name.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { devboxTools } from '../armada/devbox-tools';
import { deployedConfig } from './infra-manifest';
import { r2ObjectSize } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import { requireCloudflareAccountId, wrangler } from './infra-cloudflare';
import { partsOf, pinnedTools, TOOLS_PART_BYTES, toolsKey, type Tools } from './devbox-tools-pin';

/** Seed an eval fixture from staging's distribution artifact without building any local image; or, for a release, its
 *  channel's releases bucket from the store bucket the deploy checked, inside R2 (`deploy.sh`). */
export async function copyPinnedTools(bucket: string, from?: string): Promise<void> {
  const tools = pinnedTools();
  const source = from ?? deployedConfig('staging').r2_buckets?.find(row => row.binding === 'BACKUP_BUCKET')?.bucket_name;
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  if (source === undefined || accessKeyId === undefined || secretAccessKey === undefined) throw new Error('copying the staging tools requires its R2 credentials');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });

  for (const part of partsOf(tools)) {
    const copied = await client.fetch(`https://${requireCloudflareAccountId()}.r2.cloudflarestorage.com/${bucket}/${part.key}`, {
      method: 'PUT', headers: { 'x-amz-copy-source': `/${source}/${part.key}` },
    });

    const body = await copied.text();

    if (!copied.ok || body.includes('<Error>')) throw new Error(`the tools ${source}/${part.key} was not copied: ${String(copied.status)} ${body.slice(-300)}`);
  }
}

/** The first part the bucket lacks or holds at another size. */
async function missingPart(bucket: string, tools: Tools) {
  const token = restApiToken();

  if (token === '') throw new Error('reading the store bucket needs the deploy\'s REST token (KINU_CLOUDFLARE_API_TOKEN)');

  for (const part of partsOf(tools)) {
    const size = await r2ObjectSize({ accountId: requireCloudflareAccountId(), bucket, key: part.key, token });

    if (size !== part.bytes) return { ...part, size };
  }

  return undefined;
}

/** The tarball the `devbox-tools` task builds, with the job that built it. */
export async function buildTools(): Promise<{ readonly bytes: Uint8Array; readonly sha256: string; readonly job: string }> {
  const job = devboxTools.stream([null], { label: 'devbox tools' });
  const [bytes] = await job.values();

  if (bytes === undefined) throw new Error('the devbox-tools job answered nothing');

  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), job: await job.id };
}

/** Uploads the pinned tarball's parts from `bytes`, refusing bytes that are not the pin. */
export function uploadPinnedTools(bucket: string, bytes: Uint8Array, progress: (key: string, bytes: number) => void = () => {}): void {
  const pinned = pinnedTools();
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (sha256 !== pinned.sha256 || bytes.byteLength !== pinned.bytes) {
    throw new Error(`the tools are ${sha256} (${String(bytes.byteLength)} bytes), not the pinned ${pinned.sha256} (${String(pinned.bytes)}): build and pin again`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-'));

  try {
    for (const [index, part] of partsOf(pinned).entries()) {
      const file = join(dir, `part-${String(index)}`);
      writeFileSync(file, bytes.subarray(index * TOOLS_PART_BYTES, index * TOOLS_PART_BYTES + part.bytes));
      const put = wrangler(['r2', 'object', 'put', `${bucket}/${part.key}`, '--file', file, '--content-type', 'application/octet-stream', '--remote'], { timeoutMs: null });

      if (!put.ok) throw new Error(`uploading ${bucket}/${part.key} failed:\n${`${put.stdout}${put.stderr}`.slice(-1500)}`);
      rmSync(file);
      progress(part.key, part.bytes);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [command, bucket, into] = process.argv.slice(2);

  if (command === 'build') {
    const { bytes, sha256, job } = await buildTools();

    if (bucket !== undefined) writeFileSync(bucket, bytes);
    process.stdout.write(`${JSON.stringify({ tools: { sha256, bytes: bytes.byteLength }, job }, null, 2)}\n`);

    return 0;
  }

  if (command === 'check' && bucket !== undefined) {
    const missing = await missingPart(bucket, pinnedTools());

    if (missing === undefined) return 0;
    process.stderr.write(`${bucket} lacks the pinned devbox tools ${missing.key} (${missing.size === undefined ? 'absent' : `${String(missing.size)} bytes`}): `
      + `bun scripts/devbox-tools.ts publish ${bucket}\n`);

    return 1;
  }

  if (command === 'publish' && bucket !== undefined) {
    const pinned = pinnedTools();

    if (await missingPart(bucket, pinned) === undefined) {
      process.stdout.write(`${bucket}/${toolsKey(pinned.sha256)} is already there\n`);

      return 0;
    }

    uploadPinnedTools(bucket, (await buildTools()).bytes, (key, bytes) => {
      process.stdout.write(`${bucket}/${key} uploaded, ${String(bytes)} bytes\n`);
    });

    return 0;
  }

  // A release's channel serves the tools a self-deployment copies (`ReleaseComputer`): from its releases bucket.
  if (command === 'release' && bucket !== undefined && into !== undefined) {
    if (await missingPart(into, pinnedTools()) === undefined) return 0;
    await copyPinnedTools(into, bucket);
    process.stdout.write(`${into}/${toolsKey(pinnedTools().sha256)} copied from ${bucket}\n`);

    return 0;
  }

  process.stderr.write('usage: bun scripts/devbox-tools.ts build [<file>] | check <bucket> | publish <bucket> | release <store> <releases>\n');

  return 2;
}

if (import.meta.main) process.exitCode = await main();
