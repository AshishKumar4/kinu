/**
 * The devbox tools tarball (D65, D78): built on armada from cloudflare/debian-trixie by tools-setup.sh and
 * tools-build.sh, and pinned in packages/devbox/block-lower/upstream.json, the way the image is. A box reads it from its
 * environment's store bucket in parts of at most 256 MiB, `devbox-tools/<sha256>.tgz.0` first, and checks the whole
 * against the pin.
 *
 *   bun scripts/devbox-tools.ts build [<file>]     builds it, prints the `tools` record for upstream.json, and writes it
 *                                                   to <file> (for devbox-container-tier.ts --tools)
 *   bun scripts/devbox-tools.ts publish <bucket>   uploads the pinned tarball's parts, built again, unless the bucket holds them
 *   bun scripts/devbox-tools.ts check <bucket>     exits 1, naming the part, when the bucket lacks one
 *
 * deploy.sh builds nothing: it runs `check` on the store bucket it deploys, and refuses by name.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { AwsClient } from 'aws4fetch';
import { cmd, recipe } from 'armada';
import { deployedConfig } from './infra-manifest';
import { r2ObjectSize, wranglerSessionToken } from './cloudflare-rest';
import { trackedFiles } from './sources';

const BLOCK_LOWER = join(import.meta.dir, '..', 'packages/devbox/block-lower');

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const ToolsRecord = v.object({ sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), bytes: v.number() });

/** The pinned tarball's record, from upstream.json. */
function pinnedTools(): v.InferOutput<typeof ToolsRecord> {
  return v.parse(v.object({ tools: ToolsRecord }), JSON.parse(readFileSync(join(BLOCK_LOWER, 'upstream.json'), 'utf8'))).tools;
}

/** The object key a box reads the tarball's parts from, `.0` first: packages/devbox/src/golden.ts reads the same. */
const toolsKey = (sha256: string): string => `devbox-tools/${sha256}.tgz`;

/** Under the 300 MiB that `wrangler r2 object put` takes. */
const TOOLS_PART_BYTES = 256 * 1024 * 1024;

/** Seed an eval fixture from staging's distribution artifact without building any local image. */
export async function copyPinnedTools(bucket: string): Promise<void> {
  const tools = pinnedTools();
  const source = deployedConfig('staging').r2_buckets?.find(row => row.binding === 'BACKUP_BUCKET')?.bucket_name;
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  if (source === undefined || accessKeyId === undefined || secretAccessKey === undefined) throw new Error('copying the staging tools requires its R2 credentials');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });

  for (const part of partsOf(tools)) {
    const copied = await client.fetch(`https://${ACCOUNT}.r2.cloudflarestorage.com/${bucket}/${part.key}`, {
      method: 'PUT', headers: { 'x-amz-copy-source': `/${source}/${part.key}` },
    });

    const body = await copied.text();

    if (!copied.ok || body.includes('<Error>')) throw new Error(`the staging tools ${part.key} was not copied: ${String(copied.status)} ${body.slice(-300)}`);
  }
}

/** Each part's key and size, in the order a box reads them. */
function partsOf(tools: v.InferOutput<typeof ToolsRecord>): readonly { readonly key: string; readonly bytes: number }[] {
  return Array.from({ length: Math.ceil(tools.bytes / TOOLS_PART_BYTES) }, (_, part) => ({
    key: `${toolsKey(tools.sha256)}.${String(part)}`, bytes: Math.min(TOOLS_PART_BYTES, tools.bytes - part * TOOLS_PART_BYTES),
  }));
}

/** The first part the bucket lacks or holds at another size. */
async function missingPart(bucket: string, tools: v.InferOutput<typeof ToolsRecord>) {
  const token = wranglerSessionToken();

  for (const part of partsOf(tools)) {
    const size = await r2ObjectSize({ accountId: ACCOUNT, bucket, key: part.key, token });

    if (size !== part.bytes) return { ...part, size };
  }

  return undefined;
}

/** Where the recipe's install leaves the tarball, in the environment its tasks start from. */
const BUILD_DIR = '/home/ci/devbox-tools';

/** What one task hands back: armada keeps an output of 64 MiB and refuses one of 128 (measured, D78). */
const RETURN_PART_BYTES = 32 * 1024 * 1024;

/** More parts than the tarball's 336 MB fills; a task past its end hands back nothing. */
const RETURN_PARTS = 16;

/** The block lower's own sources, as release-config.test.ts's A8 pins them: the install unpacks them, so the
 *  environment's key covers them. */
function blockLowerSources(): readonly string[] {
  const under = 'packages/devbox/block-lower/';

  return trackedFiles().filter(file => file.startsWith(under)).map(file => file.slice(under.length))
    .filter(file => ['Cargo.toml', 'Cargo.lock'].includes(file) || /^src\/[^/]+\.rs$/u.test(file)).sort();
}

/**
 * How armada builds the tarball (D78): cloudflare/debian-trixie with every package from one day of the archive
 * (tools-setup.sh, as root, once per environment), then this tree's block lower compiled and everything packed
 * (tools-build.sh, as the user). `smoke` is the recipe's own check; another value keys another environment, which is
 * how a second build of the same inputs is had.
 */
export function toolsRecipe(smoke = 'true') {
  const unpack = blockLowerSources().map(file => `mkdir -p block-lower/${dirname(file)} && `
    + `printf %s ${readFileSync(join(BLOCK_LOWER, file)).toString('base64')} | base64 -d > block-lower/${file}`);

  return recipe({
    base: 'cloudflare/debian-trixie', size: 'medium', smoke,
    setup: readFileSync(join(BLOCK_LOWER, 'tools-setup.sh'), 'utf8'),
    install: ['set -eu', `rm -rf ${BUILD_DIR} && mkdir -p ${BUILD_DIR} && cd ${BUILD_DIR}`, ...unpack, readFileSync(join(BLOCK_LOWER, 'tools-build.sh'), 'utf8')].join('\n'),
  });
}

/** The tarball an environment of `built` holds, handed back in parts by one map over it. */
export async function buildTools(built = toolsRecipe()): Promise<{ readonly bytes: Buffer; readonly sha256: string; readonly job: string }> {
  const part = cmd(built, (index: number) => [
    'sh', '-c', `dd if=${BUILD_DIR}/tools.tgz of="$ARMADA_OUT" bs=${String(RETURN_PART_BYTES)} skip="$1" count=1 status=none`, 'part', String(index),
  ], { output: 'bytes', timeout: 900 });

  const job = part.map(Array.from({ length: RETURN_PARTS }, (_, index) => index), { pool: 4, label: 'devbox tools' });
  const parts = await job.values();
  // A part past the tarball's end is empty.
  const end = parts.findIndex(bytes => bytes.byteLength === 0);
  const bytes = Buffer.concat(end === -1 ? parts : parts.slice(0, end));

  if (bytes.byteLength >= RETURN_PARTS * RETURN_PART_BYTES) throw new Error(`the tarball fills all ${String(RETURN_PARTS)} parts: hand back more`);

  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), job: await job.id };
}

function wrangler(args: readonly string[]) {
  const ran = spawnSync(join(import.meta.dir, '..', 'node_modules/.bin/wrangler'), args, {
    encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  });

  return { ok: ran.status === 0, out: `${ran.stdout}${ran.stderr}` };
}

async function main(): Promise<number> {
  const [command, bucket] = process.argv.slice(2);

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

    const { bytes, sha256 } = await buildTools();

    if (sha256 !== pinned.sha256) throw new Error(`the tools stage built ${sha256}, not the pinned ${pinned.sha256}: build and pin again`);
    const dir = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-'));

    try {
      for (const [index, part] of partsOf(pinned).entries()) {
        const file = join(dir, `part-${String(index)}`);
        writeFileSync(file, bytes.subarray(index * TOOLS_PART_BYTES, index * TOOLS_PART_BYTES + part.bytes));
        const put = wrangler(['r2', 'object', 'put', `${bucket}/${part.key}`, '--file', file, '--content-type', 'application/octet-stream', '--remote']);

        if (!put.ok) throw new Error(`uploading ${bucket}/${part.key} failed:\n${put.out.slice(-1500)}`);
        rmSync(file);
        process.stdout.write(`${bucket}/${part.key} uploaded, ${String(part.bytes)} bytes\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    return 0;
  }

  process.stderr.write('usage: bun scripts/devbox-tools.ts build [<file>] | check <bucket> | publish <bucket>\n');

  return 2;
}

if (import.meta.main) process.exitCode = await main();
