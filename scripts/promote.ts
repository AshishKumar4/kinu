/**
 * Promotion: production gets the build staging verified, byte for byte.
 *
 * The Vite plugin fixes a Cloudflare environment into the build, so the build that staging ran cannot be redeployed
 * to production as it is. Promotion builds production's config at the same commit instead, and proves it is the same
 * artifact: every Worker module and client asset hashes as staging's did (`artifactDigest`). The downloads (the CLI
 * builds, the signed stamp, the release manifest) and the worker release tarball are not rebuilt at all: they are
 * copied from staging and checked against the signed stamp's own checksums, so what a user downloads is what staging's
 * tiers ran.
 *
 *   bun scripts/promote.ts digest                   the artifact digest of packages/cf-backend/dist
 *   bun scripts/promote.ts record <staging version> staging's deploy, after every post-deploy tier passed
 *   bun scripts/promote.ts check                    before promotion builds: HEAD is verified and staging serves it
 *   bun scripts/promote.ts adopt                    after the production build: downloads, digest, release tarball
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { why, wrangler } from './infra-cloudflare';
import { type InfraEnvironment, deriveInfrastructure } from './infra-manifest';

const REPO = new URL('..', import.meta.url).pathname;

const DIST = join(REPO, 'packages/cf-backend/dist');

/** The binding both environments publish the worker release tarball through. */
const RELEASES_BINDING = 'RELEASES_BUCKET';

/** The parts of a build that are the same artifact in every environment: all of it but the environment's flattened
 *  config and the downloads, which promotion copies rather than rebuilds. */
const ARTIFACT_PARTS: readonly (readonly [string, (path: string) => boolean])[] = [
  ['kinu', (path) => path === 'wrangler.json'],
  ['client', (path) => path === 'downloads' || path.startsWith('downloads/')],
];

function filesUnder(root: string, skip: (path: string) => boolean): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);

      if (skip(rel)) continue;

      if (statSync(path).isDirectory()) walk(path);
      else found.push(rel);
    }
  };

  walk(root);

  return found.sort();
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The artifact a build of `dist` is: every file of its Worker and client but the per-environment config and the
 * downloads, each named by its path and hashed. Two builds of one commit agree whichever environment they were built
 * for (measured 2026-09-25: two production builds and one staging build, 790 files, one digest).
 */
export function artifactDigest(dist: string): string {
  const hash = createHash('sha256');

  for (const [part, skip] of ARTIFACT_PARTS) {
    for (const path of filesUnder(join(dist, part), skip)) {
      hash.update(`${part}/${path}\0${sha256(readFileSync(join(dist, part, path)))}\n`);
    }
  }

  return hash.digest('hex');
}

/** Staging's word that a commit passed there: the artifact its build was, and the version that served it. */
export const VerifiedSchema = v.object({
  sha: v.string(),
  digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  stagingVersion: v.string(),
  recordedAt: v.string(),
});

export type Verified = v.InferOutput<typeof VerifiedSchema>;

export const verifiedKey = (sha: string): string => `verified/${sha}.json`;

/** The signed stamp's fields promotion reads: the build it names, and every download's checksum. */
const StampSchema = v.looseObject({ sha: v.string(), checksums: v.record(v.string(), v.string()) });

const WORKER_TARBALL = /^\/downloads\/(kinu-worker-.+\.tar\.gz)$/u;

/**
 * Staging's downloads for `sha`, fetched from `origin` and written into `dir`: the signed stamp, the release manifest,
 * every download the stamp signs and each one's `.sha256`, and the worker tarball's `.sha256`. Every signed file must
 * hash as the stamp says, or nothing is kept. Returns the worker tarball's name, which lives in R2 rather than here.
 */
export async function adoptDownloads(origin: string, sha: string, dir: string, fetcher: typeof fetch = fetch): Promise<string> {
  const read = async (name: string): Promise<Uint8Array> => {
    const answer = await fetcher(`${origin}/downloads/${name}`);

    if (!answer.ok) throw new Error(`${origin}/downloads/${name} answered ${String(answer.status)}`);

    return new Uint8Array(await answer.arrayBuffer());
  };

  const stampBytes = await read('kinu-version.json');
  const stamp = v.parse(StampSchema, JSON.parse(new TextDecoder().decode(stampBytes)));

  if (stamp.sha !== sha) throw new Error(`${origin} serves the downloads of ${stamp.sha}, not ${sha}`);

  const files = new Map<string, Uint8Array>([['kinu-version.json', stampBytes], ['release.json', await read('release.json')]]);
  let tarball: string | undefined;

  for (const [path, checksum] of Object.entries(stamp.checksums)) {
    const worker = WORKER_TARBALL.exec(path)?.[1];

    if (worker !== undefined) {
      tarball = worker;
      files.set(`${worker}.sha256`, await read(`${worker}.sha256`));
      continue;
    }

    const name = path.replace(/^\/downloads\//u, '');
    const bytes = await read(name);

    if (sha256(bytes) !== checksum) throw new Error(`${name} from ${origin} does not hash as the signed stamp says`);

    files.set(name, bytes);
    files.set(`${name}.sha256`, await read(`${name}.sha256`));
  }

  if (tarball === undefined) throw new Error(`the signed stamp at ${origin} names no worker release tarball`);

  mkdirSync(dir, { recursive: true });

  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);

  return tarball;
}

/** Where promotion reads and writes, from wrangler.jsonc. */
interface Targets {
  /** Staging's origin, which serves the verified build. */
  readonly origin: string;
  /** Each environment's release bucket. */
  readonly buckets: Readonly<Record<InfraEnvironment, string>>;
}

function targets(): Targets {
  const bucketOf = (environment: InfraEnvironment): string => {
    const bucket = deriveInfrastructure(environment).resources.find((resource) => resource.kind === 'r2' && resource.binding === RELEASES_BINDING);

    if (bucket === undefined) throw new Error(`${environment} binds no ${RELEASES_BINDING}`);

    return bucket.name;
  };

  const origin = deriveInfrastructure('staging').worker.vars.get('CLI_PUBLIC_ORIGIN');

  if (origin === undefined || origin === '') throw new Error('env.staging sets no CLI_PUBLIC_ORIGIN, so staging has no origin');

  return { origin, buckets: { production: bucketOf('production'), staging: bucketOf('staging') } };
}

function r2(argv: readonly string[]): string {
  const run = wrangler(['r2', 'object', ...argv, '--remote'], 600_000);

  if (!run.ok) throw new Error(`wrangler r2 object ${argv.slice(0, 2).join(' ')} failed: ${why(run)}`);

  return run.stdout;
}

function head(): string {
  const run = Bun.spawnSync(['git', '-C', REPO, 'rev-parse', '--short', 'HEAD']);

  return run.stdout.toString().trim();
}

/** The record staging wrote for `sha`; a commit staging never verified has none, and promotion refuses it. */
function verified(bucket: string, sha: string): Verified {
  return v.parse(VerifiedSchema, JSON.parse(r2(['get', `${bucket}/${verifiedKey(sha)}`, '--pipe'])));
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const sha = head();

  if (command === 'digest' && rest.length === 0) {
    console.log(artifactDigest(DIST));

    return 0;
  }

  const { origin, buckets } = targets();

  if (command === 'record' && rest.length === 1) {
    const record: Verified = { sha, digest: artifactDigest(DIST), stagingVersion: rest[0] ?? '', recordedAt: new Date().toISOString() };
    const scratch = mkdtempSync(join(tmpdir(), 'kinu-promote-'));

    try {
      writeFileSync(join(scratch, 'record.json'), JSON.stringify(record));
      r2(['put', `${buckets.staging}/${verifiedKey(sha)}`, '--file', join(scratch, 'record.json'), '--content-type', 'application/json']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    console.log(`promote: ${sha} verified on staging (${record.digest})`);

    return 0;
  }

  if (command === 'check' && rest.length === 0) {
    const record = verified(buckets.staging, sha);
    const served = v.parse(v.looseObject({ build: v.looseObject({ sha: v.string() }) }), await (await fetch(`${origin}/api/health`)).json());

    if (served.build.sha !== sha) throw new Error(`staging serves ${served.build.sha}, not ${sha}: promote what it verified`);

    console.log(`promote: ${sha} was verified on staging (version ${record.stagingVersion}) and staging serves it`);

    return 0;
  }

  if (command === 'adopt' && rest.length === 0) {
    const record = verified(buckets.staging, sha);
    const digest = artifactDigest(DIST);

    if (digest !== record.digest) throw new Error(`this build is ${digest}; staging verified ${record.digest}`);

    const tarball = await adoptDownloads(origin, sha, join(DIST, 'client', 'downloads'));
    const scratch = mkdtempSync(join(tmpdir(), 'kinu-promote-'));

    try {
      for (const name of [tarball, `${tarball}.sha256`]) {
        r2(['get', `${buckets.staging}/${name}`, '--file', join(scratch, name)]);
        r2(['put', `${buckets.production}/${name}`, '--file', join(scratch, name)]);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    console.log(`promote: the production build is staging's (${digest}); its downloads and ${tarball} are staging's`);

    return 0;
  }

  console.error('usage: bun scripts/promote.ts digest | record <staging version> | check | adopt');

  return 2;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`promote: REFUSED — ${renderThrownChain({ cause: error })}`);
    process.exit(1);
  }
}
