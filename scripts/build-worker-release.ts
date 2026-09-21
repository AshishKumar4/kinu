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

/** Where the small, publishable things go: `release.json` and the artifact's
 *  `.sha256`, both assets, both signed with the CLI's by `sign-release.ts`. */
const outDir = outArg ?? join(dist, 'client/downloads');

/** Where the tarball goes, and deliberately NOT the assets directory:
 *  this artifact is larger than Cloudflare's per-file static-asset limit, so a
 *  deploy that staged it beside the CLI tarballs would fail at asset upload.
 *  `scripts/deploy.sh` puts this file into the `kinu-releases` R2 bucket and
 *  the Worker streams it at the same public path it would have had as an
 *  asset. `scripts/deploy.test.ts` measures both halves. */
const artifactDir = join(dist, 'worker-release');

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

/** A worker member is what the runtime LOADS: an ES module or a compiled
 *  WebAssembly module. Everything else the Vite plugin writes beside them is
 *  scaffolding for OUR account and OUR checkout: `wrangler.json` (the deploy
 *  config), `*.map` (uploaded separately), `.vite/manifest.json` (the build's
 *  own index), and `.dev.vars` (this checkout's local-dev secrets, which the
 *  plugin copies in for preview). Measured 2026-09-21: release
 *  0.2.0+bd1872f73 shipped `.dev.vars` and `.vite/manifest.json` to the public
 *  bucket, and `kinu deploy local` exited on the first non-module member. The
 *  release carries the manifest instead of any of them. */
function isWorkerModule(path: string): boolean {
  if (path.split('/').some((segment) => segment.startsWith('.'))) return false;

  return path.endsWith('.js') || path.endsWith('.wasm');
}

// Modules, and only modules.
for (const path of walk(workerDir)) {
  if (!isWorkerModule(path)) continue;
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

// THE BUILD STAMP, so an instance installed from this release knows what it
// is. `/api/health` reads `/downloads/kinu-version.json` off the assets
// (`core/src/http/health-route.ts`) and answers `build: null` without it, which
// both doors read as an unstamped build and refuse. `client/downloads/` is
// otherwise left out (the CLI tarballs are not this release's), and the full
// stamp `build-cli-dist.sh` publishes at kinu.run is written after this one
// because it holds this artifact's own checksum; the three fields the health
// route needs are known now.
const builtAt = new Date().toISOString();

const stamp = Buffer.from(`${JSON.stringify({ version, sha, builtAt })}\n`);

mkdirSync(join(staging, 'client', 'downloads'), { recursive: true });

writeFileSync(join(staging, 'client', 'downloads', 'kinu-version.json'), stamp);

files.push({
  path: 'client/downloads/kinu-version.json',
  sha256: createHash('sha256').update(stamp).digest('hex'),
  size: stamp.length,
  assetHash: assetDigest(stamp, 'downloads/kinu-version.json'),
});

const manifest = v.parse(ReleaseManifestSchema, buildReleaseManifest({
  version,
  sha,
  builtAt,
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

mkdirSync(artifactDir, { recursive: true });

const artifact = `kinu-worker-${version}.tar.gz`;

// ASSETS BEFORE MODULES, and it is load-bearing. The Cloudflare door installs
// this artifact with one pass of the stream (`core/src/deploy/artifact.ts`),
// uploading each asset as it arrives and holding the module set to the end,
// because a version is one multipart request. In this order the compressed
// archive is let go of before the module set is held, and the peak inside the
// Durable Object is set by the largest member rather than by the release.
const tar = Bun.spawnSync(['tar', '-czf', join(artifactDir, artifact), '-C', staging, 'release.json', 'client', 'worker']);

if (tar.exitCode !== 0) {
  console.error(`build-worker-release: tar failed — ${new TextDecoder().decode(tar.stderr)}`);
  process.exit(1);
}

const packed = readFileSync(join(artifactDir, artifact));

const digest = createHash('sha256').update(packed).digest('hex');

writeFileSync(join(outDir, `${artifact}.sha256`), `${digest}  ${artifact}\n`);

// Served beside the artifact: the flow reads the manifest before it downloads
// anything, and the Updates page reads it on every check.
writeFileSync(join(outDir, 'release.json'), manifestText);

rmSync(staging, { recursive: true, force: true });

const megabytes = (packed.length / 1_000_000).toFixed(1);

console.log(
  `build-worker-release: ${join(artifactDir, artifact)} ${megabytes} MB — ${modules.length} module(s), `
  + `${files.length - modules.length} asset(s), sha256 ${digest.slice(0, 12)}`,
);
