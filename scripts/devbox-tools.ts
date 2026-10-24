/**
 * The devbox tools tarball (D65, D78): built on armada by the `devbox-tools` task (armada/devbox-tools.ts) from
 * cloudflare/debian-trixie, tools-setup.sh and tools-build.sh, and pinned in packages/devbox/block-lower/upstream.json,
 * the way the image is. A box reads it from its environment's store bucket in parts of at most 256 MiB,
 * `devbox-tools/<sha256>.tgz.0` first, and checks the whole against the pin.
 *
 *   bun scripts/devbox-tools.ts build [<file>]     builds it, prints the `tools` record for upstream.json, and writes it
 *                                                   to <file> (for devbox-container-tier.ts --tools)
 *   bun scripts/devbox-tools.ts publish <bucket>   uploads the pinned tarball's parts, built again, unless the bucket holds them,
 *                                                   then each of its files by sha256 and its manifest, unless it holds those
 *   bun scripts/devbox-tools.ts check <bucket>     exits 1, naming the part, when the bucket lacks one; names a missing manifest
 *   bun scripts/devbox-tools.ts release <store> <releases>  copies the parts, files and manifest into the channel's releases
 *                                                   bucket, inside R2, unless it holds them: a self-deployment copies them
 *
 * A start whose box holds an older pin's manifest fetches only the files the pin's manifest names anew
 * (`devbox-tools/files/<sha256>.0`, against `devbox-tools/<pin>.sha256.0`: packages/devbox/src/golden.ts `refreshTools`);
 * a store without the manifest has every box install the tarball whole, which the box records as its reason.
 *
 * deploy.sh builds nothing: it runs `check` on the store bucket it deploys, and refuses by name.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { devboxTools } from '../armada/devbox-tools';
import { deployedConfig } from './infra-manifest';
import { r2ObjectSize } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import { requireCloudflareAccountId, wrangler } from './infra-cloudflare';
import { partsOf, pinnedTools, TOOLS_PART_BYTES, toolsKey, type Tools } from './devbox-tools-pin';
import { toolsFileKey, toolsManifestKey } from '../packages/devbox/src/tools';

/** R2's S3 API with the environment's R2 credentials, and an object's URL on it. */
function r2() {
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('the devbox tools store needs its R2 credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');

  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    url: (bucket: string, key: string) => `https://${requireCloudflareAccountId()}.r2.cloudflarestorage.com/${bucket}/${key}`,
  };
}

/** `key` copied from `source` into `bucket`, inside R2. */
async function copyObject(source: string, bucket: string, key: string): Promise<void> {
  const { client, url } = r2();
  const copied = await client.fetch(url(bucket, key), { method: 'PUT', headers: { 'x-amz-copy-source': `/${source}/${key}` } });
  const body = await copied.text();

  if (!copied.ok || body.includes('<Error>')) throw new Error(`the tools ${source}/${key} was not copied: ${String(copied.status)} ${body.slice(-300)}`);
}

/** An object's text, or null when `bucket` holds none. */
async function objectText(bucket: string, key: string): Promise<string | null> {
  const { client, url } = r2();
  const answer = await client.fetch(url(bucket, key));

  if (answer.status === 404) return null;

  if (!answer.ok) throw new Error(`reading ${bucket}/${key} answered ${String(answer.status)}`);

  return await answer.text();
}

/** The size of `key` in `bucket`, undefined when it holds none. */
async function heldBytes(bucket: string, key: string): Promise<number | undefined> {
  const { client, url } = r2();
  const answer = await client.fetch(url(bucket, key), { method: 'HEAD' });

  if (answer.status !== 404 && !answer.ok) throw new Error(`reading ${bucket}/${key} answered ${String(answer.status)}`);

  return answer.ok ? Number(answer.headers.get('content-length')) : undefined;
}

/** Whether `bucket` holds `key`: for an object named by its own sha256, the whole of it, as an R2 put is atomic. */
const holds = async (bucket: string, key: string): Promise<boolean> => await heldBytes(bucket, key) !== undefined;

/** R2 requests in flight at once over a manifest's ~400 files, so a deploy's copy takes seconds, not one round trip each. */
const IN_FLIGHT = 16;

/** `step` over each item, `IN_FLIGHT` at a time. */
async function inBatches<T>(items: readonly T[], step: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += IN_FLIGHT) await Promise.all(items.slice(at, at + IN_FLIGHT).map(step));
}

/** Each `sha256  usr/…` row of a manifest. */
const manifestRows = (manifest: string): { readonly sha256: string; readonly path: string }[] => manifest.split('\n').flatMap((row) => {
  const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(row);

  return match?.[1] === undefined || match[2] === undefined ? [] : [{ sha256: match[1], path: match[2] }];
});

/** Seed an eval fixture from staging's distribution artifact without building any local image; or, for a release, its
 *  channel's releases bucket from the store bucket the deploy checked, inside R2 (`deploy.sh`). The pin's files and
 *  manifest come along when the source holds the manifest, the manifest last, so a bucket holding it holds each file. */
export async function copyPinnedTools(bucket: string, from?: string): Promise<void> {
  const tools = pinnedTools();
  const source = from ?? deployedConfig('staging').r2_buckets?.find(row => row.binding === 'BACKUP_BUCKET')?.bucket_name;

  if (source === undefined) throw new Error('copying the staging tools needs its store bucket');

  // A part held at another size is copied again: `release` comes here for exactly that (`missingPart`).
  for (const part of partsOf(tools)) if (await heldBytes(bucket, part.key) !== part.bytes) await copyObject(source, bucket, part.key);
  const manifest = await objectText(source, `${toolsManifestKey(tools.sha256)}.0`);

  if (manifest === null) return;
  await inBatches([...new Set(manifestRows(manifest).map((row) => `${toolsFileKey(row.sha256)}.0`))], async (key) => {
    if (!await holds(bucket, key)) await copyObject(source, bucket, key);
  });
  await copyObject(source, bucket, `${toolsManifestKey(tools.sha256)}.0`);
}

/**
 * Each file of the pinned tarball into `bucket` by its sha256, then the pin's manifest, unless the bucket holds them:
 * what a start fetches when only some files changed. The tarball is `bytes`, or read back from the bucket's parts, and
 * checked against the pin either way. Files are shared across pins, so a re-pin uploads only what changed. Returns how
 * many files it uploaded.
 */
export async function publishToolsFiles(bucket: string, bytes?: Uint8Array): Promise<number> {
  const pinned = pinnedTools();
  const { client, url } = r2();

  if (await holds(bucket, `${toolsManifestKey(pinned.sha256)}.0`)) return 0;
  const tarball = bytes ?? Buffer.concat(await Promise.all(partsOf(pinned).map(async (part) => new Uint8Array(await (await client.fetch(url(bucket, part.key))).arrayBuffer()))));

  if (createHash('sha256').update(tarball).digest('hex') !== pinned.sha256) throw new Error(`${bucket}'s tools parts are not the pinned ${pinned.sha256}`);
  const dir = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-files-'));
  let uploaded = 0;

  try {
    execFileSync('tar', ['-C', dir, '-xzf', '-'], { input: tarball });
    const manifest = readFileSync(join(dir, 'usr/local/lib/devbox/tools.sha256'), 'utf8');

    await inBatches(manifestRows(manifest), async ({ sha256, path }) => {
      if (await holds(bucket, `${toolsFileKey(sha256)}.0`)) return;
      const put = await client.fetch(url(bucket, `${toolsFileKey(sha256)}.0`), { method: 'PUT', body: readFileSync(join(dir, path)) });

      if (!put.ok) throw new Error(`uploading ${bucket}/${toolsFileKey(sha256)}.0 (${path}) answered ${String(put.status)}: ${(await put.text()).slice(-300)}`);
      uploaded += 1;
    });

    const put = await client.fetch(url(bucket, `${toolsManifestKey(pinned.sha256)}.0`), { method: 'PUT', body: manifest });

    if (!put.ok) throw new Error(`uploading ${bucket}/${toolsManifestKey(pinned.sha256)}.0 answered ${String(put.status)}: ${(await put.text()).slice(-300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return uploaded;
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
    const manifest = `${toolsManifestKey(pinnedTools().sha256)}.0`;

    if (missing === undefined && await r2ObjectSize({ accountId: requireCloudflareAccountId(), bucket, key: manifest, token: restApiToken() }) === undefined) {
      process.stderr.write(`notice: ${bucket} lacks ${manifest}, so every box installs the tools whole: bun scripts/devbox-tools.ts publish ${bucket}\n`);
    }

    if (missing === undefined) return 0;
    process.stderr.write(`${bucket} lacks the pinned devbox tools ${missing.key} (${missing.size === undefined ? 'absent' : `${String(missing.size)} bytes`}): `
      + `bun scripts/devbox-tools.ts publish ${bucket}\n`);

    return 1;
  }

  if (command === 'publish' && bucket !== undefined) {
    const pinned = pinnedTools();

    let built: Uint8Array | undefined;

    if (await missingPart(bucket, pinned) === undefined) process.stdout.write(`${bucket}/${toolsKey(pinned.sha256)} is already there\n`);
    else {
      built = (await buildTools()).bytes;
      uploadPinnedTools(bucket, built, (key, bytes) => {
        process.stdout.write(`${bucket}/${key} uploaded, ${String(bytes)} bytes\n`);
      });
    }

    process.stdout.write(`${bucket}: ${String(await publishToolsFiles(bucket, built))} tools files uploaded; ${toolsManifestKey(pinned.sha256)}.0 is there\n`);

    return 0;
  }

  // A release's channel serves the tools a self-deployment copies (`ReleaseComputer`): from its releases bucket.
  if (command === 'release' && bucket !== undefined && into !== undefined) {
    if (await missingPart(into, pinnedTools()) === undefined && await holds(into, `${toolsManifestKey(pinnedTools().sha256)}.0`)) return 0;
    await copyPinnedTools(into, bucket);
    process.stdout.write(`${into}/${toolsKey(pinnedTools().sha256)} copied from ${bucket}\n`);

    return 0;
  }

  process.stderr.write('usage: bun scripts/devbox-tools.ts build [<file>] | check <bucket> | publish <bucket> | release <store> <releases>\n');

  return 2;
}

if (import.meta.main) process.exitCode = await main();
