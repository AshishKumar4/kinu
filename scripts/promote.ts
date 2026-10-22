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
 *   bun scripts/promote.ts withdraw                                 staging's deploy, when it ends red: not verified, built kept
 *   bun scripts/promote.ts record <staging version> [reset record]
 *                                                                   staging's deploy, when every phase passed
 *   bun scripts/promote.ts evals <verdict dir>                      store HEAD's completed armada evaluation beside its record
 *   bun scripts/promote.ts built <staging version> [reset record]   staging's deploy, once staging serves HEAD, whatever goes red
 *                                                                   after: the build, not a verdict on it
 *   bun scripts/promote.ts check                                    before promotion builds: HEAD is verified, staging serves it,
 *                                                                   and its evals verdict is green
 *   bun scripts/promote.ts override "<owner's words>"               before an owner's promotion of a build staging did not verify:
 *                                                                   HEAD's built record, staging's open reds and the words, kept
 *                                                                   as an UNVERIFIED override
 *   bun scripts/promote.ts adopt [override]                         after the production build: downloads, digest, release tarball
 *   bun scripts/promote.ts promoted [--override] <version> [reset record]
 *                                                                   production's deploy, after every post-deploy tier passed
 *   bun scripts/promote.ts rollback                                 production back to the build it took before the one it serves
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';
import { deployment, environmentArgs, r2Text, why, wrangler } from './infra-cloudflare';
import { REPORTS } from './deploy-report';
import { type InfraEnvironment, deriveInfrastructure } from './infra-manifest';
import { type Reset, ResetSchema, latestReset } from './reset';
import { DEFAULT_TRIALS } from '../evals/src/config';
import { compareEvalResults, evalGateVerdict, whyIncomplete } from '../evals/src/comparison';
import { COMMIT_QUESTIONS } from '../evals/scripts/git';
import { parsePlatformReport } from '../evals/src/platform';
import { parseResults, trials } from '../evals/src/results';
import { EvalRunSchema, readEvalRun } from './evals-artifacts';
import { isEvalTask, trackedFiles } from './sources';
import { REPO_ROOT as REPO } from './repo-root';
import { servedHealth } from './served-health';


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
  reset: v.optional(ResetSchema),
});

export type Verified = v.InferOutput<typeof VerifiedSchema>;

/** The verdict file `evals/scripts/compare.ts` writes, as `scripts/evals-map.ts` keeps it per run. */
const EvalVerdictSchema = v.object({ pass: v.boolean(), reason: v.string() });

export type EvalVerdict = v.InferOutput<typeof EvalVerdictSchema>;

/** A run `dir` holds, refused unless it is the full statistical matrix of this checkout's tasks, its trials run on its
 *  own definitions; with its candidate's report and every tracked task file. */
function fullMatrixRun(dir: string) {
  const run = readEvalRun(join(dir, 'run.json'));
  const all = trackedFiles().filter(isEvalTask).sort();

  if (run.pass || run.trials < DEFAULT_TRIALS || run.taskFiles.length !== all.length
    || [...run.taskFiles].sort().some((file, index) => file !== all[index])) {
    throw new Error('a promotion needs the full statistical matrix, never a pilot or a soak');
  }

  const candidate = readFileSync(join(dir, 'candidate', 'results.json'), 'utf8');

  return { run, all, candidate };
}

function definedBy(run: { readonly definitions: string }, text: string): void {
  if (trials(parseResults('promotion', text)).some((assertion) => assertion.meta.harness.run.session.metadata.evalCommit !== run.definitions)) {
    throw new Error('the trial definitions do not match this evaluation run');
  }
}

/** The evals verdict a directory of `scripts/evals-map.ts` output holds, with the armada jobs that ran it. */
export function readEvalsVerdict(dir: string, sha: string) {
  const { run, all, candidate } = fullMatrixRun(dir);

  if (!run.definitions.startsWith(sha) || !run.candidateBuild.startsWith(sha)) throw new Error(`these evals did not measure ${sha} with its own definitions`);
  const baseline = readFileSync(join(dir, 'baseline', 'results.json'), 'utf8');

  for (const text of [candidate, baseline]) definedBy(run, text);

  const comparison = compareEvalResults(baseline, candidate, {}, {
    baseline: parsePlatformReport(readFileSync(join(dir, 'baseline', 'platform.json'), 'utf8')),
    candidate: parsePlatformReport(readFileSync(join(dir, 'candidate', 'platform.json'), 'utf8')),
  });

  const verdict = evalGateVerdict(comparison, {
    candidate: whyIncomplete(candidate, { trials: run.trials, taskFiles: all, build: run.candidateBuild }),
    baseline: whyIncomplete(baseline, { trials: run.trials, taskFiles: all, build: run.baselineBuild }),
  });

  return { run, verdict };
}

/** A stored proof as promotion reads it: whose build it measured and the armada jobs that ran it. A proof is kept for its
 *  sha, so one written before a run's other fields changed is read the same. */
const EvalProofSchema = v.object({ run: v.pick(EvalRunSchema, ['candidateBuild', 'jobs']), verdict: EvalVerdictSchema });

export const evalsKey = (sha: string): string => `evals/${sha}.json`;

/** The latest daily eval verdict, replaced by each day's run (`daily`). */
export const DAILY_EVALS_KEY = 'evals/daily.json';

/** How old the latest daily verdict may be and still let a build through: a day, and two hours for the run's own length. */
export const DAILY_VERDICT_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/** Why no row of the day before's run compares with today's that means the suite moved, not the build: today's run is
 *  then the baseline (`readDailyVerdict`). */
const REBASELINING: ReadonlySet<string> = new Set(['eval definition changed', 'task version changed', 'only in candidate', 'only in baseline']);

/** How far ahead of this clock a measurement may read before it is no evidence of freshness. */
const DAILY_CLOCK_DRIFT_MS = 10 * 60 * 1000;

/** What a daily run found against the day before's: the comparison's own word, `baseline` for the first run, and
 *  `rebaselined` for one nothing of the day before's could be compared with (its definitions or task versions moved).
 *  `regressed` holds promotion as a P1, and `inconclusive` holds it as no evidence that nothing regressed. */
export const DailyOutcomeSchema = v.picklist(['improved', 'unchanged', 'inconclusive', 'regressed', 'baseline', 'rebaselined']);

/** A daily eval run's record: the build production served, the definitions it ran, the day before's build it was
 *  compared with (null for a baseline), what it found, when its trials ended, and when it was recorded. */
export const DailyVerdictSchema = v.pipe(
  v.object({
    measured: v.string(), definitions: v.string(), baseline: v.nullable(v.string()), jobs: v.array(v.string()),
    // The first daily run (2026-10-21, at ce6dee5fe) recorded neither: it was a baseline, recorded as its trials ended.
    outcome: v.optional(DailyOutcomeSchema), measuredAt: v.optional(v.string()),
    verdict: EvalVerdictSchema, recordedAt: v.string(),
  }),
  v.transform((read) => ({
    ...read, outcome: read.outcome ?? (read.verdict.pass ? 'baseline' as const : 'regressed' as const), measuredAt: read.measuredAt ?? read.recordedAt,
  })),
);

export type DailyVerdict = v.InferOutput<typeof DailyVerdictSchema>;

/**
 * The verdict of the daily run in `dir` (owner, 2026-10-21, "Daily gated release"): the build production serves,
 * measured once a day, against the run of the day before in `previous`, asking this checkout which definitions moved
 * between them as `compare.ts` does. With no day before, or nothing of it comparable, the run is the new baseline. Only a
 * regression holds promotion. A run that is not complete is no verdict, and the latest one stands.
 */
export function readDailyVerdict(dir: string, previous: string | undefined, checkout: string) {
  const { run, all, candidate } = fullMatrixRun(dir);

  if (run.daily !== true) throw new Error('this run is no daily run: its candidate is not the build production serves (evals-map --daily)');

  if (!run.definitions.startsWith(checkout)) throw new Error(`this daily run ran the definitions of ${run.definitions}, not this checkout's ${checkout}`);
  definedBy(run, candidate);
  const incomplete = whyIncomplete(candidate, { trials: run.trials, taskFiles: all, build: run.candidateBuild });

  if (incomplete !== null) throw new Error(`the daily run is not complete, so it is no verdict, and the latest one stands: ${incomplete}`);

  if (run.wallSeconds === undefined) throw new Error('the daily run never finished: its record has no wall time');
  const measuredAt = new Date(run.startedAt + run.wallSeconds * 1000).toISOString();
  const first = { run, measuredAt, baseline: null };

  if (previous === undefined) {
    return { ...first, outcome: 'baseline' as const, verdict: { pass: true, reason: 'The first daily verdict: a baseline, with no earlier day to regress against.' } };
  }

  const before = readEvalRun(join(previous, 'run.json'));
  const baseline = readFileSync(join(previous, 'candidate', 'results.json'), 'utf8');

  const comparison = compareEvalResults(baseline, candidate, COMMIT_QUESTIONS, {
    baseline: parsePlatformReport(readFileSync(join(previous, 'candidate', 'platform.json'), 'utf8')),
    candidate: parsePlatformReport(readFileSync(join(dir, 'candidate', 'platform.json'), 'utf8')),
  });

  // Only a moved suite starts a new baseline: a row blocked by infrastructure errors is no evidence either way.
  if (comparison.rows.every((row) => row.reason !== null && REBASELINING.has(row.reason))) {
    const moved = [...new Set(comparison.rows.map((row) => row.reason))].join(', ');

    return { ...first, outcome: 'rebaselined' as const, verdict: { pass: true, reason: `Nothing of ${before.candidateBuild.slice(0, 9)}'s run could be compared with this one (${moved}): this run is the new baseline.` } };
  }

  const verdict = evalGateVerdict(comparison, {
    candidate: null, baseline: whyIncomplete(baseline, { trials: before.trials, taskFiles: before.taskFiles, build: before.candidateBuild }),
  });

  // One word for the gate: a verdict that refuses short of a regression (an incomplete day before) is no evidence.
  const outcome = comparison.verdict === 'regressed' || verdict.pass ? comparison.verdict : 'inconclusive';

  return { run, measuredAt, baseline: before.candidateBuild, outcome, verdict };
}

/**
 * Why `sha` may not be promoted on the evals, or undefined when it may: the latest daily verdict, 26 hours old at most and
 * no regression; else a passing verdict on `sha` itself, as a fix's own run records it (`evals <dir>`), which is how
 * promotion resumes after a regression (a P1) or a lapse.
 */
export function evalGateRefusal(sha: string, daily: DailyVerdict | undefined, own: { readonly candidateBuild: string; readonly verdict: EvalVerdict } | undefined, now: number): string | undefined {
  if (own !== undefined && own.candidateBuild.startsWith(sha) && own.verdict.pass) return undefined;
  const fix = `a fix lands and its own run passes (bun scripts/evals-map.ts ${sha.slice(0, 9)} --record)`;

  if (daily === undefined) return `no eval verdict yet: no daily run has recorded one, and none names ${sha}; the daily run records the first`;
  const age = now - Date.parse(daily.measuredAt);
  const hours = age / 3_600_000;
  const measured = `measured ${daily.measured.slice(0, 9)}, its trials ending ${daily.measuredAt}`;

  if (daily.outcome === 'regressed') return `the latest daily eval verdict is a regression, a P1 (${measured}): ${daily.verdict.reason}; promotion holds until ${fix}`;

  if (daily.outcome === 'inconclusive') {
    return `the latest daily eval verdict is inconclusive, no evidence that nothing regressed (${measured}): ${daily.verdict.reason}; promotion holds until the next daily run, or ${fix}`;
  }

  // An unreadable time, or one ahead of this clock by more than its drift, is no fresher than an old one.
  if (!(age >= -DAILY_CLOCK_DRIFT_MS && age <= DAILY_VERDICT_MAX_AGE_MS)) {
    return `the latest daily eval verdict is ${hours.toFixed(1)} h old (${measured}), more than ${String(DAILY_VERDICT_MAX_AGE_MS / 3_600_000)} h; promotion holds until the daily run records one, or ${fix}`;
  }

  return undefined;
}

/** `sha`'s own eval verdict, as `evals <dir>` recorded it, or undefined. */
function ownVerdict(records: Records, sha: string): v.InferOutput<typeof EvalProofSchema> | undefined {
  const own = records.read(evalsKey(sha));

  return own === undefined ? undefined : v.parse(EvalProofSchema, JSON.parse(own));
}

/** Whether `sha`'s own run passed. */
function ownPass(records: Records, sha: string): boolean {
  const proof = ownVerdict(records, sha);

  return proof !== undefined && proof.run.candidateBuild.startsWith(sha) && proof.verdict.pass;
}

/** The comparison may finish before the deploy writes its verified record. Keep them independent. */
function assertEvalGate(sha: string, records: Records): void {
  const daily = records.read(DAILY_EVALS_KEY);
  const proof = ownVerdict(records, sha);

  const refused = evalGateRefusal(sha, daily === undefined ? undefined : v.parse(DailyVerdictSchema, JSON.parse(daily)),
    proof === undefined ? undefined : { candidateBuild: proof.run.candidateBuild, verdict: proof.verdict }, Date.now());

  if (refused !== undefined) throw new Error(`${sha} cannot be promoted: ${refused}`);
}


export const verifiedKey = (sha: string): string => `verified/${sha}.json`;

/** Staging's build of `sha` as it served it, written once it served it whatever went red after: never a verdict. */
export const builtKey = (sha: string): string => `built/${sha}.json`;

/** The owner's promotion of `sha` without staging's verification: kept apart from every verified record. */
export const overrideKey = (sha: string): string => `overrides/${sha}.json`;

/** An owner's word that production take a build staging did not verify: the build as staging served it (its digest and
 *  every download), marked unverified, with the owner's words and the reds staging's deploy of it left open. */
export const OverrideSchema = v.object({
  ...VerifiedSchema.entries,
  verdict: v.literal('UNVERIFIED'),
  words: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  reds: v.array(v.string()),
  overriddenAt: v.string(),
});

export type Override = v.InferOutput<typeof OverrideSchema>;

/** A staging bucket's records, by key: absent is undefined. */
export interface Records {
  read(key: string): string | undefined;
  write(key: string, text: string): void;
  delete(key: string): void;
}

/**
 * What a staging deploy takes back of `sha`'s records. `publishing`, before it replaces what staging serves: all three,
 * since nothing it publishes is verified, built or evaluated until it says so. `red`, when it ends red after publishing:
 * the verified record and the evals verdict, which would let a red build be promoted, but not the built record, which
 * says only that staging serves it, and is what an owner's override names (`writeOverride`).
 */
export function withdraw(records: Records, sha: string, moment: 'publishing' | 'red'): void {
  for (const key of moment === 'publishing' ? [verifiedKey(sha), builtKey(sha), evalsKey(sha)] : [verifiedKey(sha), evalsKey(sha)]) records.delete(key);
}

/**
 * The override record of `sha`, written under its own key and nowhere else: staging's built record of it, proven still
 * served (`served`), with the owner's words and staging's open reds.
 */
export async function writeOverride(
  staging: Records,
  sha: string,
  owner: { readonly words: string; readonly reds: readonly string[]; readonly at: string },
  served: (downloads: Downloads) => Promise<void>,
): Promise<Override> {
  const text = staging.read(builtKey(sha));

  if (text === undefined) throw new Error(`staging never served ${sha}: no deploy of it reached a serving build, so there is nothing to override with`);
  const built = v.parse(VerifiedSchema, JSON.parse(text));

  await served(built.downloads);
  const record = v.parse(OverrideSchema, { ...built, verdict: 'UNVERIFIED', words: owner.words, reds: owner.reds, overriddenAt: owner.at });

  staging.write(overrideKey(sha), JSON.stringify(record));

  return record;
}

/** The record a promotion of `sha` adopts: staging's verified one, or under `override` the owner's override, never the
 *  one in place of the other. */
export function adoptedRecord(staging: Records, sha: string, override: boolean): Verified | Override {
  const key = override ? overrideKey(sha) : verifiedKey(sha);
  const text = staging.read(key);

  if (text === undefined) {
    throw new Error(override ? `no owner override of ${sha} was recorded` : `staging has not verified ${sha}: ${key} holds no record`);
  }

  return override ? v.parse(OverrideSchema, JSON.parse(text)) : v.parse(VerifiedSchema, JSON.parse(text));
}

/** The reds the last staging deploy of `sha` reported here, from the environment's report index: an override names them. */
export function stagingReds(index: string, sha: string): readonly string[] {
  if (!existsSync(index)) throw new Error(`no staging deploy reported here (${index}), so ${sha}'s open reds are unknown`);

  const summary = readFileSync(index, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => v.parse(v.looseObject({ sha: v.string(), reds: v.array(v.string()) }), JSON.parse(line)))
    .filter((each) => each.sha === sha).at(-1);

  if (summary === undefined) throw new Error(`no staging deploy of ${sha} reported here, so its open reds are unknown`);

  return summary.reds;
}

/** A build production took: the version that served it, its commit, and every download it served. A build a
 *  rollback left is withdrawn, and no later rollback returns to it. */
export const PromotionSchema = v.object({
  sha: v.string(),
  version: v.string(),
  at: v.string(),
  downloads: DownloadsSchema,
  withdrawnAt: v.optional(v.string()),
  reset: v.optional(ResetSchema),
  /** A build the owner promoted without staging's verification: owner override, unverified. */
  override: v.optional(v.object({ verdict: v.literal('UNVERIFIED'), words: v.string(), reds: v.array(v.string()) })),
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
    const { status, build } = await servedHealth(origin, { query: `?rollback=${String(attempt)}`, fetcher });

    served = build?.sha ?? `an answer ${String(status)} without a build`;

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
  const run = wrangler(['r2', 'object', ...argv, '--remote'], { timeoutMs: 600_000 });

  if (!run.ok) throw new Error(`wrangler r2 object ${argv.slice(0, 2).join(' ')} failed: ${why(run)}`);

  return run.stdout;
}

/** One R2 bucket through wrangler, every transfer by way of a file in `scratch`. */
function bucketAt(bucket: string, scratch: string) {
  return {
    get(name: string): Uint8Array {
      const file = join(scratch, `get-${name}`);

      mkdirSync(dirname(file), { recursive: true });
      r2(['get', `${bucket}/${name}`, '--file', file]);

      return new Uint8Array(readFileSync(file));
    },
    put(name: string, bytes: Uint8Array | string, contentType: string): void {
      const file = join(scratch, `put-${name}`);

      mkdirSync(dirname(file), { recursive: true });
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

/** Production's history, oldest first: empty before the first promotion. */
function promotions(bucket: string): Promotion[] {
  const text = r2Text(bucket, HISTORY_KEY);

  return text === undefined ? [] : v.parse(v.array(PromotionSchema), JSON.parse(text));
}

/** Refused unless `origin` serves `sha` with this very signed stamp: a record or a history entry names what a
 *  deployment serves, never a build that exists only on this machine. */
async function servedAs(origin: string, sha: string, downloads: Downloads): Promise<void> {
  const served = (await servedHealth(origin)).build?.sha ?? 'no build';

  if (served !== sha) throw new Error(`${origin} serves ${served}, not ${sha}`);
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

/** What staging's deploy records of HEAD, from `record <staging version> [reset record]`; evals finish independently. */
function verifiedRecord(sha: string, [version = '', reset]: readonly string[]): Verified {
  const record: Verified = {
    sha, digest: artifactDigest(DIST), stagingVersion: version, recordedAt: new Date().toISOString(), downloads: downloadsIn(DOWNLOADS), ...resetIn(reset),
  };

  return record;
}

/** What every command but `digest` works on: HEAD, both environments' origins and release buckets, and staging's records. */
interface Context {
  readonly sha: string;
  readonly origins: Targets['origins'];
  readonly buckets: Targets['buckets'];
  readonly staging: ReturnType<typeof bucketAt>;
  readonly production: ReturnType<typeof bucketAt>;
  readonly records: Records;
}

/** Refused unless production names only the container images staging ran. */
function refuseImageDrift(): void {
  const drift = imagesStagingNeverRan(deriveInfrastructure('production').worker.images, deriveInfrastructure('staging').worker.images);

  if (drift.length > 0) throw new Error(`production names container images staging never ran: ${drift.join(', ')}`);
}

function forgetCommand({ sha, records }: Context): number {
  withdraw(records, sha, 'publishing');
  console.log(`promote: ${sha} is not verified on staging until this deploy's tiers pass`);

  return 0;
}

function withdrawCommand({ sha, records }: Context): number {
  withdraw(records, sha, 'red');
  console.log(`promote: ${sha} went red on staging: not verified, and promotable only by an owner's override of the build staging serves`);

  return 0;
}

async function recordCommand({ sha, origins, records }: Context, rest: readonly string[]): Promise<number> {
  const verified = verifiedRecord(sha, rest);

  await servedAs(origins.staging, sha, verified.downloads);
  records.write(verifiedKey(sha), JSON.stringify(verified));
  console.log(`promote: ${sha} verified on staging (${verified.digest}, ${String(Object.keys(verified.downloads).length)} downloads)`);

  return 0;
}

async function builtCommand({ sha, origins, records }: Context, rest: readonly string[]): Promise<number> {
  const build = verifiedRecord(sha, rest);

  await servedAs(origins.staging, sha, build.downloads);
  records.write(builtKey(sha), JSON.stringify(build));
  console.log(`promote: staging serves ${sha} (${build.digest}); this is its build, not a verdict on it`);

  return 0;
}

async function evalsCommand({ sha, records }: Context, [dir = '']: readonly string[]): Promise<number> {
  const proof = readEvalsVerdict(dir, sha);

  records.write(evalsKey(sha), JSON.stringify(proof));
  console.log(`promote: ${sha}'s eval verdict from armada ${proof.run.jobs.join(', ')}: ${proof.verdict.reason}`);

  return 0;
}

/** The daily run in `dir`, against the day before's in `previous`, recorded as the latest daily verdict. */
/** What a day that compares may find and replace a standing regression with. */
const CLEARS_REGRESSION: ReadonlySet<DailyVerdict['outcome']> = new Set(['unchanged', 'improved', 'regressed']);

/**
 * Why a daily run's verdict may not replace `standing`, or undefined when it may. A run replayed is never newer evidence
 * than the one recorded after it. Nothing but a day that compares and holds clears a regression (a baseline, a moved
 * suite or an inconclusive day does not), or production serving a build whose own run passed (`measuredPassed`).
 */
export function dailyReplacementRefusal(
  standing: DailyVerdict | undefined, next: { readonly outcome: DailyVerdict['outcome']; readonly measuredAt: string }, measuredPassed: boolean,
): string | undefined {
  if (standing === undefined) return undefined;

  if (Date.parse(standing.measuredAt) >= Date.parse(next.measuredAt)) {
    return `a daily verdict measured at ${standing.measuredAt} stands, no older than this run's ${next.measuredAt}`;
  }

  // Only a day compared with a green one, or a newer regression, replaces a regression.
  if (standing.outcome === 'regressed' && !CLEARS_REGRESSION.has(next.outcome) && !measuredPassed) {
    return `the regression measured at ${standing.measuredAt} stands: a day ${next.outcome} cannot clear it on a build with no passing run of its own`;
  }

  return undefined;
}

/** How `daily` exits on a held outcome, for the runner to say which (`daily-evals.sh`): any other is 0. */
const DAILY_EXITS: Partial<Record<DailyVerdict['outcome'], number>> = { regressed: 3, inconclusive: 4 };

async function dailyCommand({ sha, records }: Context, [dir = '', previous]: readonly string[]): Promise<number> {
  const { run, baseline, outcome, verdict, measuredAt } = readDailyVerdict(dir, previous, sha);
  const latest = records.read(DAILY_EVALS_KEY);
  const read = latest === undefined ? undefined : v.safeParse(DailyVerdictSchema, JSON.parse(latest));
  const standing = read?.success === true ? read.output : undefined;
  const refused = dailyReplacementRefusal(standing, { outcome, measuredAt }, ownPass(records, run.candidateBuild));

  if (refused !== undefined) {
    console.error(`promote: ${refused}`);

    return standing?.outcome === 'regressed' ? DAILY_EXITS.regressed ?? 1 : 1;
  }

  const daily: DailyVerdict = {
    measured: run.candidateBuild, definitions: run.definitions, baseline, jobs: run.jobs, outcome, verdict, measuredAt, recordedAt: new Date().toISOString(),
  };

  records.write(DAILY_EVALS_KEY, JSON.stringify(daily));
  console.log(`promote: the daily eval verdict on ${run.candidateBuild.slice(0, 9)}${baseline === null ? '' : ` against ${baseline.slice(0, 9)}`}, `
    + `from armada ${run.jobs.join(', ')}: ${outcome === 'regressed' ? 'A REGRESSION, a P1' : outcome}: ${verdict.reason}`);

  return DAILY_EXITS[outcome] ?? 0;
}

async function checkCommand({ sha, origins, records }: Context): Promise<number> {
  refuseImageDrift();
  const verified = adoptedRecord(records, sha, false);

  await servedAs(origins.staging, sha, verified.downloads);
  assertEvalGate(sha, records);
  console.log(`promote: ${sha} was verified on staging (version ${verified.stagingVersion}), staging serves that run's downloads, and the eval gate lets it through`);

  return 0;
}

async function overrideCommand({ sha, origins, records }: Context, [words = '']: readonly string[]): Promise<number> {
  refuseImageDrift();

  const owner = { words, reds: stagingReds(join(REPORTS, 'staging', 'index.jsonl'), sha), at: new Date().toISOString() };
  const written = await writeOverride(records, sha, owner, async (downloads) => { await servedAs(origins.staging, sha, downloads); });

  console.log(`promote: OWNER OVERRIDE, UNVERIFIED: ${sha} as staging served it (${written.digest}), with ${String(written.reds.length)} open red(s) there: ${written.reds.join('; ') || 'none reported'}`);

  return 0;
}

async function adoptCommand({ sha, origins, buckets, staging, production, records }: Context, rest: readonly string[]): Promise<number> {
  const adopted = adoptedRecord(records, sha, rest[0] === 'override');
  const digest = artifactDigest(DIST);

  if (digest !== adopted.digest) throw new Error(`this build is ${digest}; staging verified ${adopted.digest}`);
  const tarball = await adoptDownloads(origins.staging, adopted, DOWNLOADS);

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

async function promotedCommand({ sha, origins, buckets, production, records }: Context, rest: readonly string[]): Promise<number> {
  const overridden = rest[0] === '--override';
  const [version = '', reset] = overridden ? rest.slice(1) : rest;

  if (!/^[0-9a-f-]{36}$/u.test(version)) throw new Error(`'${version}' is not a Worker version id, so no rollback could return to it`);
  const owner = overridden ? v.parse(OverrideSchema, adoptedRecord(records, sha, true)) : undefined;
  const promotion: Promotion = { sha, version, at: new Date().toISOString(), downloads: downloadsIn(DOWNLOADS), ...resetIn(reset) };

  if (owner !== undefined) promotion.override = { verdict: owner.verdict, words: owner.words, reds: owner.reds };

  const serving = servingVersion();

  if (serving !== version) throw new Error(`production serves version ${serving}, not ${version}`);
  await servedAs(origins.production, sha, promotion.downloads);

  production.put(HISTORY_KEY, JSON.stringify([...promotions(buckets.production), promotion]), 'application/json');
  console.log(`promote: production took ${sha} as version ${version}${owner === undefined ? '' : ': owner override, unverified'}`);

  return 0;
}

async function rollbackCommand({ origins, buckets, production }: Context): Promise<number> {
  const serving = servingVersion();
  const plan = planRollback(promotions(buckets.production), serving, new Date().toISOString(), latestReset(buckets.production));

  if ('refused' in plan) throw new Error(plan.refused);
  const { target } = plan;

  const run = wrangler(['rollback', target.version, '--message', `Rollback to ${target.sha}`, '--yes', ...environmentArgs('production')], { timeoutMs: 600_000 });

  if (!run.ok) throw new Error(`wrangler rollback ${target.version} failed: ${why(run)}`);
  production.put(HISTORY_KEY, JSON.stringify(plan.history), 'application/json');
  await verifyServing(origins.production, target);
  console.log(`promote: production serves ${target.sha} again (version ${target.version}), its downloads byte for byte`);

  return 0;
}

/** A command, with the argument counts it takes. */
interface Command {
  readonly takes: readonly number[];
  readonly run: (context: Context, rest: readonly string[]) => number | Promise<number>;
}

const COMMANDS = new Map<string, Command>([
  ['forget', { takes: [0], run: forgetCommand }],
  ['withdraw', { takes: [0], run: withdrawCommand }],
  ['record', { takes: [1, 2], run: recordCommand }],
  ['built', { takes: [1, 2], run: builtCommand }],
  ['evals', { takes: [1], run: evalsCommand }],
  ['daily', { takes: [1, 2], run: dailyCommand }],
  ['check', { takes: [0], run: checkCommand }],
  ['override', { takes: [1], run: overrideCommand }],
  ['adopt', { takes: [0, 1], run: adoptCommand }],
  ['promoted', { takes: [1, 2, 3], run: promotedCommand }],
  ['rollback', { takes: [0], run: rollbackCommand }],
]);

const USAGE = 'usage: bun scripts/promote.ts digest | forget | withdraw | record <staging version> [reset record] | built <staging version> [reset record] '
  + '| evals <verdict dir> | daily <daily run dir> [previous daily run dir] | check | override "<owner\'s words>" | adopt [override] | promoted [--override] <version> [reset record] | rollback';

/** Whether `rest` is a shape the command takes beyond its count: adopt's one word is `override`, and promoted takes a
 *  version and a reset record after an optional `--override`. */
function wellFormed(command: string, rest: readonly string[]): boolean {
  if (command === 'adopt' && rest.length === 1) return rest[0] === 'override';

  if (command !== 'promoted') return true;
  const args = rest[0] === '--override' ? rest.slice(1) : rest;

  return args.length === 1 || args.length === 2;
}

async function main(argv: readonly string[], scratch: string): Promise<number> {
  const [command = '', ...rest] = argv;

  if (command === 'digest' && rest.length === 0) {
    console.log(artifactDigest(DIST));

    return 0;
  }

  const chosen = COMMANDS.get(command);

  if (chosen === undefined || !chosen.takes.includes(rest.length) || !wellFormed(command, rest)) {
    console.error(USAGE);

    return 2;
  }

  const { origins, buckets } = targets();
  const staging = bucketAt(buckets.staging, scratch);

  const records: Records = {
    read: (key) => r2Text(buckets.staging, key), write: (key, text) => { staging.put(key, text, 'application/json'); },
    delete: (key) => { r2(['delete', `${buckets.staging}/${key}`]); },
  };

  return await chosen.run({ sha: head(), origins, buckets, staging, production: bucketAt(buckets.production, scratch), records }, rest);
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
