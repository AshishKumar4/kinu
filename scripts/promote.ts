/**
 * Promotion: production gets the build staging verified, byte for byte, and can go back to the last one it took.
 *
 * The Vite plugin fixes a Cloudflare environment into the build, so the build that staging ran cannot be redeployed
 * to production as it is. Promotion builds production's config at the same commit instead, and proves it is the same
 * artifact: every Worker module and client asset hashes as staging's did (`artifactDigest`). The downloads (the CLI
 * builds, the signed stamp, the release manifest and every checksum) and the worker release tarball are not rebuilt
 * at all. They are copied from staging, each download checked by its hash against the record staging's green run
 * wrote, and the tarball against the signed stamp that record binds. A staging deploy withdraws its commit's record
 * before it builds, so nothing staging publishes while a deploy is under way or red is ever taken.
 *
 * Production keeps the builds it took, oldest first, in `promoted.json` in its releases bucket, each with the hash of
 * every download it served. The first promotion starts the list with the build production served before it.
 * `rollback` returns production to the newest build older than the one it serves, and proves it serves that build's
 * downloads byte for byte.
 *
 *   bun scripts/promote.ts digest                                   the artifact digest of packages/cf-backend/dist
 *   bun scripts/promote.ts forget                                   staging's deploy, before it builds: HEAD is not verified
 *   bun scripts/promote.ts record <staging version> <evals run | ''> [reset record]
 *                                                                   staging's deploy, when every phase passed
 *   bun scripts/promote.ts evals <evals run>                        HEAD's record names the evals run dispatched after it
 *   bun scripts/promote.ts check                                    before promotion builds: HEAD is verified, staging serves it,
 *                                                                   and its evals run's verdict is green
 *   bun scripts/promote.ts adopt                                    after the production build: downloads, digest, release tarball
 *   bun scripts/promote.ts promoted <version> [reset record]        production's deploy, after every post-deploy tier passed
 *   bun scripts/promote.ts rollback                                 production back to the build it took before the one it serves
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { deployment, environmentArgs, why, wrangler } from './infra-cloudflare';
import { type InfraEnvironment, deriveInfrastructure } from './infra-manifest';
import { type Reset, ResetSchema, latestReset } from './reset';

const REPO = new URL('..', import.meta.url).pathname;

const DIST = join(REPO, 'packages/cf-backend/dist');

/** What a deployment serves under /downloads: the directory the build stages them in. */
const DOWNLOADS = join(DIST, 'client', 'downloads');

/** The binding both environments publish the worker release tarball through. */
const RELEASES_BINDING = 'RELEASES_BUCKET';

/** The signed stamp: every artifact's checksum, the commit, and the signature over both. */
const STAMP = 'kinu-version.json';

/** Production's history, in its releases bucket. */
const HISTORY_KEY = 'promoted.json';

/** How often, 15 s apart, a rollback asks production which build it serves before calling it stuck: edge rollout
 *  takes about two minutes, and the deploy's own smoke test waits as long. */
const HEALTH_ATTEMPTS = 8;

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

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/** Every file a deployment serves under /downloads, by name, with its sha256. */
const DownloadsSchema = v.record(v.string(), Sha256Schema);

export type Downloads = v.InferOutput<typeof DownloadsSchema>;

/** Every file in `dir`, by name, with its sha256: what a deployment serves under /downloads when `dir` is its
 *  downloads directory. */
export function downloadsIn(dir: string): Downloads {
  return Object.fromEntries(filesUnder(dir, () => false).map((name) => [name, sha256(readFileSync(join(dir, name)))]));
}

/** Staging's word that a commit passed there: the artifact its build was, the version that served it, and every
 *  download that version served. */
export const VerifiedSchema = v.object({
  sha: v.string(),
  digest: Sha256Schema,
  stagingVersion: v.string(),
  recordedAt: v.string(),
  downloads: DownloadsSchema,
  /** The .github/workflows/evals.yml run dispatched against this build, by its deploy's `--evals` or by hand after it
   *  (`evals`), whose verdict a promotion waits for. Absent until one is. */
  evalsRun: v.optional(v.pipe(v.number(), v.integer())),
  reset: v.optional(ResetSchema),
});

export type Verified = v.InferOutput<typeof VerifiedSchema>;

/** A workflow run's jobs, as the GitHub API lists them. */
const RunJobsSchema = v.looseObject({
  jobs: v.array(v.looseObject({ name: v.string(), status: v.string(), conclusion: v.nullable(v.string()), html_url: v.string() })),
});

export type RunJob = v.InferOutput<typeof RunJobsSchema>['jobs'][number];

/** The evals workflow's job whose conclusion is the statistics' verdict: green only when a complete report was
 *  compared with a baseline and no cohort regressed. The run's own conclusion is not it: a run is green whenever it
 *  finished, trials failed or not. */
export const EVAL_VERDICT_JOB = 'Verdict';

/** Why the eval run `runUrl` does not let its build be promoted, or undefined when its verdict is green. */
export function evalVerdictRefusal(jobs: readonly RunJob[], runUrl: string): string | undefined {
  const verdict = jobs.find((job) => job.name === EVAL_VERDICT_JOB);

  if (verdict === undefined) return `no eval verdict yet: ${runUrl} has no ${EVAL_VERDICT_JOB} job`;

  if (verdict.status !== 'completed') return `the eval verdict is still ${verdict.status}: ${verdict.html_url}`;

  return verdict.conclusion === 'success' ? undefined : `the eval verdict is ${verdict.conclusion ?? 'no conclusion'}: ${verdict.html_url}`;
}

/** The id of the evals run a staging deploy dispatched, as `record` is handed it. */
function evalsRunOf(argument: string): number {
  const run = Number(argument);

  if (!Number.isInteger(run) || run <= 0) throw new Error(`${argument} is not the id of the evals run this deploy dispatched`);

  return run;
}

/** THE STATISTICS GATE PRODUCTION: the five-trial run dispatched against `sha` on staging, by its verdict job. */
function assertEvalVerdict(sha: string, record: Verified): void {
  if (record.evalsRun === undefined) {
    throw new Error(`${sha}'s record names no evals run: bun scripts/evals-dispatch.ts ${sha} on a quiet staging, then bun scripts/promote.ts evals <run>`);
  }

  const refusal = evalVerdictRefusal(runJobs(record.evalsRun), `evals run ${String(record.evalsRun)}`);

  if (refusal !== undefined) throw new Error(`${sha} cannot be promoted: ${refusal}`);
}

/** A GitHub API answer, read through the `gh` session of whoever promotes, and parsed by `schema`. */
function githubApi<Schema extends v.GenericSchema>(schema: Schema, path: string, what: string): v.InferOutput<Schema> {
  const answer = Bun.spawnSync(['gh', 'api', path], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });

  if (answer.exitCode !== 0) throw new Error(`reading ${what} failed: ${answer.stderr.toString().trim()}`);

  return v.parse(schema, JSON.parse(answer.stdout.toString()));
}

/** The jobs of eval run `run`. */
function runJobs(run: number): readonly RunJob[] {
  return githubApi(RunJobsSchema, `repos/{owner}/{repo}/actions/runs/${String(run)}/jobs?per_page=100`, `eval run ${String(run)}'s jobs`).jobs;
}

const WorkflowRunSchema = v.looseObject({ path: v.string(), created_at: v.string() });

/** When evals.yml run `run` started, in epoch ms; a run of another workflow is refused. */
function evalsRunStart(run: number): number {
  const { path, created_at: created } = githubApi(WorkflowRunSchema, `repos/{owner}/{repo}/actions/runs/${String(run)}`, `run ${String(run)}`);

  if (!path.startsWith('.github/workflows/evals.yml')) throw new Error(`run ${String(run)} is ${path}, not an evals.yml run`);

  return Date.parse(created);
}

export const verifiedKey = (sha: string): string => `verified/${sha}.json`;

/** A build production took: the version that served it, its commit, and every download it served. A build a
 *  rollback left is withdrawn, and no later rollback returns to it. */
export const PromotionSchema = v.object({
  sha: v.string(),
  version: v.string(),
  at: v.string(),
  downloads: DownloadsSchema,
  withdrawnAt: v.optional(v.string()),
  reset: v.optional(ResetSchema),
});

export type Promotion = v.InferOutput<typeof PromotionSchema>;

/** The signed stamp's fields promotion reads: the build it names, and every download's checksum. */
const StampSchema = v.looseObject({ sha: v.string(), checksums: v.record(v.string(), v.string()) });

const WORKER_TARBALL = /^kinu-worker-.+\.tar\.gz$/u;

/** The worker release tarball a signed stamp names, which lives in R2 rather than among the downloads. */
export interface SignedTarball {
  readonly name: string;
  readonly sha256: string;
}

/** Each of `downloads` from `origin`, refused unless every one hashes as listed. */
export async function readDownloads(
  origin: string,
  downloads: Downloads,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  for (const [name, expected] of Object.entries(downloads)) {
    const answer = await fetcher(`${origin}/downloads/${name}`);

    if (!answer.ok) throw new Error(`${origin}/downloads/${name} answered ${String(answer.status)}`);
    const bytes = new Uint8Array(await answer.arrayBuffer());

    if (sha256(bytes) !== expected) throw new Error(`${name} from ${origin} is not the file its green run published`);
    files.set(name, bytes);
  }

  return files;
}

/**
 * The worker release tarball the signed stamp among `files` names, once the stamp is proven to be `sha`'s and every
 * other artifact it signs is among `files` and hashes as signed.
 */
export function signedTarball(files: ReadonlyMap<string, Uint8Array>, sha: string): SignedTarball {
  const stampBytes = files.get(STAMP);

  if (stampBytes === undefined) throw new Error(`the downloads hold no ${STAMP}`);
  const stamp = v.parse(StampSchema, JSON.parse(new TextDecoder().decode(stampBytes)));

  if (stamp.sha !== sha) throw new Error(`the signed stamp is ${stamp.sha}'s, not ${sha}'s`);
  let tarball: SignedTarball | undefined;

  for (const [path, checksum] of Object.entries(stamp.checksums)) {
    const name = path.replace(/^\/downloads\//u, '');

    if (WORKER_TARBALL.test(name)) {
      tarball = { name, sha256: checksum };
      continue;
    }

    const bytes = files.get(name);

    if (bytes === undefined || sha256(bytes) !== checksum) throw new Error(`${name} does not hash as the signed stamp says`);
  }

  if (tarball === undefined) throw new Error('the signed stamp names no worker release tarball');

  return tarball;
}

/**
 * Staging's downloads, as the record its green run wrote lists them, fetched from `origin` and written into `dir`.
 * Every one must hash as the record says and the signed stamp must be the record's commit's, or nothing is kept.
 * Returns the worker release tarball the stamp signs.
 */
export async function adoptDownloads(origin: string, record: Verified, dir: string, fetcher: typeof fetch = fetch): Promise<SignedTarball> {
  const files = await readDownloads(origin, record.downloads, fetcher);
  const tarball = signedTarball(files, record.sha);

  mkdirSync(dir, { recursive: true });

  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);

  return tarball;
}

/**
 * The worker release tarball from staging's bucket into production's, only as the bytes the signed stamp names, with
 * the checksum staging published beside it.
 */
export async function adoptTarball(
  tarball: SignedTarball,
  checksum: Uint8Array,
  from: (name: string) => Promise<Uint8Array>,
  to: (name: string, bytes: Uint8Array, contentType: string) => Promise<void>,
): Promise<void> {
  const bytes = await from(tarball.name);

  if (sha256(bytes) !== tarball.sha256) throw new Error(`${tarball.name} in staging's bucket is not the tarball the signed stamp names`);
  await to(tarball.name, bytes, 'application/gzip');
  await to(`${tarball.name}.sha256`, checksum, 'text/plain');
}

/**
 * Where a rollback takes production, and the history after it: the newest build older than the one serving that no
 * rollback left, with the serving one withdrawn so no later rollback returns to it. A serving version the history
 * never took, a promotion that went red after its upload, returns to the newest build.
 *
 * Refused across a reset: one a later promotion carries, or `latest` if it came after the target was promoted (a
 * promotion red after its reset is in no history). The platform does not refuse it: a version binds its Durable Object
 * namespaces by id, so the old build serves every call as "Durable Object Namespace was deleted" (measured 2026-09-28).
 */
export function planRollback(
  history: readonly Promotion[],
  serving: string,
  at: string,
  latest: Reset | undefined,
): { readonly refused: string } | { readonly target: Promotion; readonly history: readonly Promotion[] } {
  const position = history.map((entry) => entry.version).lastIndexOf(serving);
  const older = position === -1 ? history : history.slice(0, position);
  const target = [...older].reverse().find((entry) => entry.withdrawnAt === undefined);

  if (target === undefined) return { refused: `production's history holds no build older than version ${serving} to return to` };
  const later = history.slice(history.indexOf(target) + 1).find((entry) => entry.reset !== undefined)?.reset;
  const crossed = later ?? (latest !== undefined && latest.at > target.at ? latest : undefined);

  if (crossed !== undefined) {
    return {
      refused: `${crossed.tag} (${crossed.at}) reset production after ${target.sha} was promoted; that build never ran on `
        + 'this storage, so no rollback crosses the reset. Deploy forward instead.',
    };
  }

  return { target, history: history.map((entry, index) => index === position ? { ...entry, withdrawnAt: at } : entry) };
}

const HealthSchema = v.looseObject({ build: v.looseObject({ sha: v.string() }) });

/** A health answer's body, which is the SPA shell rather than JSON while a route serves nothing yet. */
const HealthBodySchema = v.pipe(v.string(), v.parseJson(), HealthSchema);

/**
 * Proof that `origin` serves `promotion`: its health names the commit, asked again until the edge converges, and every
 * download, the worker release tarball among them, is byte for byte the one that build served.
 */
export async function verifyServing(
  origin: string,
  promotion: Promotion,
  fetcher: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = async (ms) => { await Bun.sleep(ms); },
): Promise<void> {
  let served = '';

  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    const answer = await fetcher(`${origin}/api/health?rollback=${String(attempt)}`);
    const health = v.safeParse(HealthBodySchema, await answer.text());

    served = answer.ok && health.success ? health.output.build.sha : `an answer ${String(answer.status)} without a build`;

    if (served === promotion.sha) break;

    if (attempt < HEALTH_ATTEMPTS) await pause(15_000);
  }

  if (served !== promotion.sha) throw new Error(`${origin} serves ${served}, not ${promotion.sha}`);
  const tarball = signedTarball(await readDownloads(origin, promotion.downloads, fetcher), promotion.sha);
  const answer = await fetcher(`${origin}/downloads/${tarball.name}`);

  if (!answer.ok || sha256(new Uint8Array(await answer.arrayBuffer())) !== tarball.sha256) {
    throw new Error(`${origin}/downloads/${tarball.name} is not the tarball the signed stamp names`);
  }
}

/**
 * The container classes whose image production would run and staging did not: the Worker and client are proven the
 * same artifact by digest, and a container's code is its image, which each environment names in its own section.
 */
export function imagesStagingNeverRan(
  production: ReadonlyMap<string, string>,
  staging: ReadonlyMap<string, string>,
): readonly string[] {
  return [...production].filter(([name, image]) => staging.get(name) !== image).map(([name, image]) => `${name} (${image})`);
}

/** Where promotion reads and writes, from wrangler.jsonc. */
interface Targets {
  /** Each environment's origin. */
  readonly origins: Readonly<Record<InfraEnvironment, string>>;
  /** Each environment's release bucket. */
  readonly buckets: Readonly<Record<InfraEnvironment, string>>;
}

function targets(): Targets {
  const of = (environment: InfraEnvironment) => {
    const infrastructure = deriveInfrastructure(environment);
    const bucket = infrastructure.resources.find((resource) => resource.kind === 'r2' && resource.binding === RELEASES_BINDING);
    const origin = infrastructure.worker.vars.get('CLI_PUBLIC_ORIGIN');

    if (bucket === undefined) throw new Error(`${environment} binds no ${RELEASES_BINDING}`);

    if (origin === undefined || origin === '') throw new Error(`${environment} sets no CLI_PUBLIC_ORIGIN, so it has no origin`);

    return { origin, bucket: bucket.name };
  };

  const [production, staging] = [of('production'), of('staging')];

  return {
    origins: { production: production.origin, staging: staging.origin },
    buckets: { production: production.bucket, staging: staging.bucket },
  };
}

function r2(argv: readonly string[]): string {
  const run = wrangler(['r2', 'object', ...argv, '--remote'], 600_000);

  if (!run.ok) throw new Error(`wrangler r2 object ${argv.slice(0, 2).join(' ')} failed: ${why(run)}`);

  return run.stdout;
}

/** One R2 bucket through wrangler, every transfer by way of a file in `scratch`. */
function bucketAt(bucket: string, scratch: string) {
  return {
    get(name: string): Uint8Array {
      const file = join(scratch, `get-${name}`);

      r2(['get', `${bucket}/${name}`, '--file', file]);

      return new Uint8Array(readFileSync(file));
    },
    put(name: string, bytes: Uint8Array | string, contentType: string): void {
      const file = join(scratch, `put-${name}`);

      writeFileSync(file, bytes);
      r2(['put', `${bucket}/${name}`, '--file', file, '--content-type', contentType]);
    },
  };
}

function head(): string {
  const run = Bun.spawnSync(['git', '-C', REPO, 'rev-parse', '--short', 'HEAD']);

  return run.stdout.toString().trim();
}

function resetIn(file: string | undefined): { readonly reset?: Reset } {
  return file === undefined ? {} : { reset: v.parse(ResetSchema, JSON.parse(readFileSync(file, 'utf8'))) };
}

/** The record staging wrote for `sha`; a commit staging never verified has none, and promotion refuses it. */
function verified(bucket: string, sha: string): Verified {
  return v.parse(VerifiedSchema, JSON.parse(r2(['get', `${bucket}/${verifiedKey(sha)}`, '--pipe'])));
}

/** Production's history, oldest first: empty before the first promotion. */
function promotions(bucket: string): Promotion[] {
  const run = wrangler(['r2', 'object', 'get', `${bucket}/${HISTORY_KEY}`, '--pipe', '--remote'], 600_000);

  if (run.ok) return v.parse(v.array(PromotionSchema), JSON.parse(run.stdout));

  // wrangler's own words for an object that does not exist; any other failure is no answer at all.
  if (`${run.stderr}\n${run.stdout}`.includes('The specified key does not exist.')) return [];

  throw new Error(`wrangler r2 object get ${bucket}/${HISTORY_KEY} failed: ${why(run)}`);
}

/** Refused unless `origin` serves `sha` with this very signed stamp: a record or a history entry names what a
 *  deployment serves, never a build that exists only on this machine. */
async function servedAs(origin: string, sha: string, downloads: Downloads): Promise<void> {
  const health = v.parse(HealthBodySchema, await (await fetch(`${origin}/api/health`)).text());

  if (health.build.sha !== sha) throw new Error(`${origin} serves ${health.build.sha}, not ${sha}`);
  const stamp = downloads[STAMP];

  if (stamp === undefined) throw new Error(`the downloads hold no ${STAMP}`);
  await readDownloads(origin, { [STAMP]: stamp });
}

/** The version production's Worker serves. */
function servingVersion(): string {
  const serving = deployment('production');

  if (serving.state !== 'deployed') {
    throw new Error(`production serves no version: ${serving.state === 'unknown' ? serving.reason : 'it has no deployment'}`);
  }

  return serving.versionId;
}

/**
 * The build `origin` serves, as its signed stamp names it, and every download it serves with its hash: the stamp, the
 * release manifest, each artifact the stamp signs and each one's checksum, the worker release tarball's checksum.
 */
export async function downloadsServed(origin: string, fetcher: typeof fetch = fetch): Promise<{ sha: string; downloads: Downloads }> {
  const read = async (name: string): Promise<Uint8Array> => {
    const answer = await fetcher(`${origin}/downloads/${name}`);

    if (!answer.ok) throw new Error(`${origin}/downloads/${name} answered ${String(answer.status)}`);

    return new Uint8Array(await answer.arrayBuffer());
  };

  const stampBytes = await read(STAMP);
  const stamp = v.parse(StampSchema, JSON.parse(new TextDecoder().decode(stampBytes)));

  const names = ['release.json', ...Object.keys(stamp.checksums).flatMap((path) => {
    const name = path.replace(/^\/downloads\//u, '');

    return WORKER_TARBALL.test(name) ? [`${name}.sha256`] : [name, `${name}.sha256`];
  })];

  const hashed = await Promise.all(names.map(async (name) => [name, sha256(await read(name))] as const));

  return { sha: stamp.sha, downloads: Object.fromEntries([[STAMP, sha256(stampBytes)], ...hashed]) };
}

/** What staging's deploy records of HEAD, from `record <staging version> <evals run or ''> [reset record]`. */
function verifiedRecord(sha: string, [version = '', run = '', reset]: readonly string[]): Verified {
  const record: Verified = {
    sha, digest: artifactDigest(DIST), stagingVersion: version, recordedAt: new Date().toISOString(), downloads: downloadsIn(DOWNLOADS), ...resetIn(reset),
  };

  // Empty when the deploy ran without `--evals`: `evals` names the run once one is dispatched.
  if (run !== '') record.evalsRun = evalsRunOf(run);

  return record;
}

/** `record` naming the evals run `[run]`, which started after it was written. */
function withEvalsRun(record: Verified, [run = '']: readonly string[]): Verified {
  const id = evalsRunOf(run);
  const started = evalsRunStart(id);

  if (started < Date.parse(record.recordedAt)) {
    throw new Error(`evals run ${run} started ${new Date(started).toISOString()}, before ${record.sha} was verified on staging at ${record.recordedAt}`);
  }

  return { ...record, evalsRun: id };
}

async function main(argv: readonly string[], scratch: string): Promise<number> {
  const [command, ...rest] = argv;
  const sha = head();

  if (command === 'digest' && rest.length === 0) {
    console.log(artifactDigest(DIST));

    return 0;
  }

  const { origins, buckets } = targets();
  const staging = bucketAt(buckets.staging, scratch);
  const production = bucketAt(buckets.production, scratch);

  if (command === 'forget' && rest.length === 0) {
    r2(['delete', `${buckets.staging}/${verifiedKey(sha)}`]);
    console.log(`promote: ${sha} is not verified on staging until this deploy's tiers pass`);

    return 0;
  }

  if (command === 'record' && (rest.length === 2 || rest.length === 3)) {
    const record = verifiedRecord(sha, rest);

    await servedAs(origins.staging, sha, record.downloads);
    staging.put(verifiedKey(sha), JSON.stringify(record), 'application/json');
    console.log(`promote: ${sha} verified on staging (${record.digest}, ${String(Object.keys(record.downloads).length)} downloads)`);

    return 0;
  }

  if (command === 'evals' && rest.length === 1) {
    const record = withEvalsRun(verified(buckets.staging, sha), rest);

    staging.put(verifiedKey(sha), JSON.stringify(record), 'application/json');
    console.log(`promote: ${sha}'s record names evals run ${String(record.evalsRun)}; a promotion waits for its Verdict`);

    return 0;
  }

  if (command === 'check' && rest.length === 0) {
    const drift = imagesStagingNeverRan(deriveInfrastructure('production').worker.images, deriveInfrastructure('staging').worker.images);

    if (drift.length > 0) throw new Error(`production names container images staging never ran: ${drift.join(', ')}`);
    const record = verified(buckets.staging, sha);

    await servedAs(origins.staging, sha, record.downloads);

    assertEvalVerdict(sha, record);
    console.log(`promote: ${sha} was verified on staging (version ${record.stagingVersion}), staging serves that run's downloads, and its evals verdict is green`);

    return 0;
  }

  if (command === 'adopt' && rest.length === 0) {
    const record = verified(buckets.staging, sha);
    const digest = artifactDigest(DIST);

    if (digest !== record.digest) throw new Error(`this build is ${digest}; staging verified ${record.digest}`);
    const tarball = await adoptDownloads(origins.staging, record, DOWNLOADS);

    await adoptTarball(
      tarball,
      readFileSync(join(DOWNLOADS, `${tarball.name}.sha256`)),
      async (name) => staging.get(name),
      async (name, bytes, contentType) => { production.put(name, bytes, contentType); },
    );

    // The first promotion starts production's history with the build it replaces, the one its rollback returns to.
    if (promotions(buckets.production).length === 0) {
      const before: Promotion = { ...await downloadsServed(origins.production), version: servingVersion(), at: new Date().toISOString() };

      production.put(HISTORY_KEY, JSON.stringify([before]), 'application/json');
      console.log(`promote: production's history starts with ${before.sha} (version ${before.version}), the build it serves now`);
    }

    console.log(`promote: the production build is staging's (${digest}); its downloads and ${tarball.name} are the ones staging verified`);

    return 0;
  }

  if (command === 'promoted' && (rest.length === 1 || rest.length === 2)) {
    const version = rest[0] ?? '';

    if (!/^[0-9a-f-]{36}$/u.test(version)) throw new Error(`'${version}' is not a Worker version id, so no rollback could return to it`);
    const promotion: Promotion = { sha, version, at: new Date().toISOString(), downloads: downloadsIn(DOWNLOADS), ...resetIn(rest[1]) };
    const serving = servingVersion();

    if (serving !== version) throw new Error(`production serves version ${serving}, not ${version}`);
    await servedAs(origins.production, sha, promotion.downloads);

    production.put(HISTORY_KEY, JSON.stringify([...promotions(buckets.production), promotion]), 'application/json');
    console.log(`promote: production took ${sha} as version ${version}`);

    return 0;
  }

  if (command === 'rollback' && rest.length === 0) {
    const serving = servingVersion();
    const plan = planRollback(promotions(buckets.production), serving, new Date().toISOString(), latestReset(buckets.production));

    if ('refused' in plan) throw new Error(plan.refused);
    const { target } = plan;

    const run = wrangler(['rollback', target.version, '--message', `Rollback to ${target.sha}`, '--yes', ...environmentArgs('production')], 600_000);

    if (!run.ok) throw new Error(`wrangler rollback ${target.version} failed: ${why(run)}`);
    production.put(HISTORY_KEY, JSON.stringify(plan.history), 'application/json');
    await verifyServing(origins.production, target);
    console.log(`promote: production serves ${target.sha} again (version ${target.version}), its downloads byte for byte`);

    return 0;
  }

  console.error('usage: bun scripts/promote.ts digest | forget | record <staging version> <evals run | \'\'> [reset record] | evals <evals run> | check | adopt '
    + '| promoted <version> [reset record] | rollback');

  return 2;
}

if (import.meta.main) {
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-promote-'));
  let code: number;

  try {
    code = await main(process.argv.slice(2), scratch);
  } catch (error) {
    console.error(`promote: REFUSED — ${renderThrownChain({ cause: error })}`);
    code = 1;
  }

  rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
