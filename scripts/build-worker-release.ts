#!/usr/bin/env bun
/**
 * The worker release artifact: `kinu-worker-<version>.tar.gz` and `release.json`,
 * published beside the CLI tarballs the deploy already publishes.
 *
 * `bun scripts/build-worker-release.ts <version> <sha> [dist dir] [out dir]`
 * reads the build Vite and the Cloudflare plugin just produced — `dist/kinu`
 * (the Worker's modules and its generated wrangler config) and `dist/client`
 * (the static assets) — and lays them out as the flow reads them:
 *
 *   release.json      what this build IS (scripts/release-manifest.ts)
 *   worker/           the Worker's modules; `worker/index.js` is main
 *   client/           the static assets, exactly what `assets.directory` holds
 *
 * WHAT IS LEFT OUT, and why. Source maps: they exist so Cloudflare can remap
 * kinu.run's own stack traces, they are uploaded as separate parts by wrangler,
 * and carrying 40 MB of them into every self-hosted deployment buys that
 * deployment nothing. `client/downloads/`: the CLI tarballs and the signed
 * release stamp are kinu.run's publishing, and a deployment fetches them from
 * the channel origin the manifest names — putting 100 MB of CLI archives
 * through the deploy Durable Object's asset upload would be the largest thing
 * in the flow and it would be a copy of what kinu.run already serves.
 *
 * The artifact is written before `build-cli-dist.sh` signs the directory, so
 * the tarball's checksum lands in `kinu-version.json` with every other
 * artifact's and is verified the same way.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetDigest, buildReleaseManifest } from './release-manifest';
import { ReleaseManifestSchema } from '../packages/core/src/deploy/manifest';
import type { ReleaseFile } from '../packages/core/src/deploy/manifest';
import * as v from 'valibot';

const REPO = new URL('..', import.meta.url).pathname;

const [version, sha, distArg, outArg] = process.argv.slice(2);

if (version === undefined || sha === undefined) {
  console.error('usage: bun scripts/build-worker-release.ts <version> <sha> [dist dir] [out dir]');
  process.exit(2);
}

const dist = distArg ?? join(REPO, 'packages/cf-backend/dist');

const outDir = outArg ?? join(dist, 'client/downloads');

/** Every file under `root`, depth first, as paths relative to it. */
function walk(root: string, base = ''): readonly string[] {
  const found: string[] = [];

  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const path = base === '' ? entry.name : `${base}/${entry.name}`;

    if (entry.isDirectory()) found.push(...walk(root, path));
    else if (entry.isFile()) found.push(path);
  }

  return found;
}

const workerDir = join(dist, 'kinu');

const clientDir = join(dist, 'client');

for (const directory of [workerDir, clientDir]) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`build-worker-release: ${directory} is not a directory — run the client and worker build first`);
    process.exit(1);
  }
}

const staging = mkdtempSync(join(tmpdir(), 'kinu-worker-release-'));

const files: ReleaseFile[] = [];

const modules: string[] = [];

// Modules. `wrangler.json` is the plugin's generated deploy config for OUR
// account; the release carries the manifest instead, so it is not copied.
for (const path of walk(workerDir)) {
  if (path.endsWith('.map') || path === 'wrangler.json') continue;
  const bytes = readFileSync(join(workerDir, path));

  mkdirSync(join(staging, 'worker', path, '..'), { recursive: true });
  writeFileSync(join(staging, 'worker', path), bytes);
  files.push({
    path: `worker/${path}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    assetHash: null,
  });

  if (path === 'index.js') modules.unshift(path);
  else modules.push(path);
}

if (modules[0] !== 'index.js') {
  console.error(`build-worker-release: ${workerDir} carries no index.js entry module`);
  process.exit(1);
}

// Static assets.
for (const path of walk(clientDir)) {
  if (path.startsWith('downloads/')) continue;
  const bytes = readFileSync(join(clientDir, path));

  mkdirSync(join(staging, 'client', path, '..'), { recursive: true });
  writeFileSync(join(staging, 'client', path), bytes);
  files.push({
    path: `client/${path}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    assetHash: assetDigest(bytes, path),
  });
}

const manifest = v.parse(ReleaseManifestSchema, buildReleaseManifest({
  version,
  sha,
  builtAt: new Date().toISOString(),
  files,
  modules,
  // Published once per Nimbus release and referenced by digest. Nothing
  // publishes one yet, and a manifest that claimed one would send every
  // deployment at a URL that answers 404.
  seed: null,
}));

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

writeFileSync(join(staging, 'release.json'), manifestText);

mkdirSync(outDir, { recursive: true });

const artifact = `kinu-worker-${version}.tar.gz`;

const tar = Bun.spawnSync(['tar', '-czf', join(outDir, artifact), '-C', staging, 'release.json', 'worker', 'client']);

if (tar.exitCode !== 0) {
  console.error(`build-worker-release: tar failed — ${new TextDecoder().decode(tar.stderr)}`);
  process.exit(1);
}

const packed = readFileSync(join(outDir, artifact));

const digest = createHash('sha256').update(packed).digest('hex');

writeFileSync(join(outDir, `${artifact}.sha256`), `${digest}  ${artifact}\n`);

// Served beside the artifact: the flow reads the manifest before it downloads
// anything, and the Updates page reads it on every check.
writeFileSync(join(outDir, 'release.json'), manifestText);

rmSync(staging, { recursive: true, force: true });

const megabytes = (packed.length / 1_000_000).toFixed(1);

console.log(
  `build-worker-release: ${artifact} ${megabytes} MB — ${modules.length} module(s), `
  + `${files.length - modules.length} asset(s), sha256 ${digest.slice(0, 12)}`,
);
