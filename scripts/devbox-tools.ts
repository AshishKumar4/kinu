/**
 * The devbox tools tarball (D65): built by the `tools` stage of packages/devbox/block-lower/Dockerfile and
 * pinned in its upstream.json, the way the image is. A box reads it from its environment's store bucket at
 * `devbox-tools/<sha256>.tgz`.
 *
 *   bun scripts/devbox-tools.ts build              builds it and prints the `tools` record for upstream.json
 *   bun scripts/devbox-tools.ts publish <bucket>   uploads the pinned tarball, built again, unless the bucket holds it
 *   bun scripts/devbox-tools.ts check <bucket>     exits 1, naming the tarball, when the bucket lacks it
 *
 * deploy.sh builds nothing: it runs `check` on the store bucket it deploys, and refuses by name.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { r2ObjectSize } from './cloudflare-rest';

const BLOCK_LOWER = join(import.meta.dir, '..', 'packages/devbox/block-lower');

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const ToolsRecord = v.object({ sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), bytes: v.number() });

/** The pinned tarball's record, from upstream.json. */
function pinnedTools(): v.InferOutput<typeof ToolsRecord> {
  return v.parse(v.object({ tools: ToolsRecord }), JSON.parse(readFileSync(join(BLOCK_LOWER, 'upstream.json'), 'utf8'))).tools;
}

/** The object key a box reads the tarball from: packages/devbox/src/golden.ts reads the same. */
const toolsKey = (sha256: string): string => `devbox-tools/${sha256}.tgz`;

function build() {
  const out = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-'));

  try {
    const built = spawnSync('docker', ['build', '--network=host', '--target', 'tools', '--output', `type=local,dest=${out}`, BLOCK_LOWER], { encoding: 'utf8' });

    if (built.status !== 0) throw new Error(`the tools stage failed:\n${built.stderr.slice(-3000)}`);
    const bytes = readFileSync(join(out, 'tools.tgz'));

    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The deploy's own credential, the one `wrangler r2 object put` publishes with; an Access-only API token cannot read R2. */
function sessionToken(): string {
  const ran = spawnSync(join(import.meta.dir, '..', 'node_modules/.bin/wrangler'), ['auth', 'token', '--json'], { encoding: 'utf8' });

  if (ran.status !== 0) throw new Error(`\`wrangler auth token\` failed: ${ran.stderr.slice(-400)}`);

  return v.parse(v.object({ token: v.pipe(v.string(), v.minLength(1)) }), JSON.parse(ran.stdout)).token;
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
    const { bytes, sha256 } = build();
    process.stdout.write(`${JSON.stringify({ tools: { sha256, bytes: bytes.byteLength } }, null, 2)}\n`);

    return 0;
  }

  if (command === 'check' && bucket !== undefined) {
    const pinned = pinnedTools();
    const size = await r2ObjectSize({ accountId: ACCOUNT, bucket, key: toolsKey(pinned.sha256), token: sessionToken() });

    if (size === pinned.bytes) return 0;
    process.stderr.write(`${bucket} lacks the pinned devbox tools ${toolsKey(pinned.sha256)} (${size === undefined ? 'absent' : `${String(size)} bytes`}): `
      + `bun scripts/devbox-tools.ts publish ${bucket}\n`);

    return 1;
  }

  if (command === 'publish' && bucket !== undefined) {
    const pinned = pinnedTools();
    const key = `${bucket}/${toolsKey(pinned.sha256)}`;

    if (await r2ObjectSize({ accountId: ACCOUNT, bucket, key: toolsKey(pinned.sha256), token: sessionToken() }) === pinned.bytes) {
      process.stdout.write(`${key} is already there\n`);

      return 0;
    }

    const { bytes, sha256 } = build();

    if (sha256 !== pinned.sha256) throw new Error(`the tools stage built ${sha256}, not the pinned ${pinned.sha256}: build and pin again`);
    const dir = mkdtempSync(join(tmpdir(), 'kinu-devbox-tools-'));
    const file = join(dir, 'tools.tgz');
    writeFileSync(file, bytes);
    const put = wrangler(['r2', 'object', 'put', key, '--file', file, '--content-type', 'application/gzip', '--remote']);
    rmSync(dir, { recursive: true, force: true });

    if (!put.ok) throw new Error(`uploading ${key} failed:\n${put.out.slice(-1500)}`);
    process.stdout.write(`${key} uploaded, ${String(bytes.byteLength)} bytes\n`);

    return 0;
  }

  process.stderr.write('usage: bun scripts/devbox-tools.ts build | publish <bucket>\n');

  return 2;
}

if (import.meta.main) process.exitCode = await main();
