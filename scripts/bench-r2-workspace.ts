#!/usr/bin/env bun
/**
 * R2-backed workspace layouts, measured against the container disk.
 *
 * The question: should an agent's `/workspace` live on R2, on the container's
 * own disk, or on a hybrid of the two — and if a hybrid, which one. It has been
 * answered by assertion until now, including by a comment in the product
 * (`kinu-sandbox.ts:210-211`) that is no longer true of the SDK it describes.
 * This is the instrument that answers it with numbers.
 *
 *   bun scripts/bench-r2-workspace.ts --plan          # print the plan, run nothing
 *   bun scripts/bench-r2-workspace.ts --reps 3        # the real thing
 *   bun scripts/bench-r2-workspace.ts --purge-bucket  # recovery after an abort
 *
 * Every reported number comes from an ephemeral DEPLOYED Worker. There is no
 * remote-dev mode: `wrangler dev --remote` cannot host a Container or a SQLite
 * Durable Object, and local `wrangler dev` has neither a real container nor a
 * real R2.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Publishes a benchmark-only Worker (`scripts/fixtures/r2-bench/`) as an
 * EPHEMERAL deployment, raises a real Cloudflare container through it, mounts
 * the same credential-less R2 binding the product would, and runs an identical
 * deterministic workload on four layouts: native disk, R2 with the SDK's default
 * s3fs options, R2 with a tuned option set, and a read-only-shaped R2 lower with
 * a native writable overlay plus an explicit sync.
 *
 * ── Three rules it holds itself to ──────────────────────────────────────────
 *
 *   DETERMINISM. Sizes, names, byte patterns and random offsets all derive from
 *   `--seed`. Two runs of this revision perform the same operations in the same
 *   order, so comparing arms compares layouts rather than workloads.
 *
 *   IT LEAVES NOTHING. Every object goes under `bench/<runId>/`, enforced by the
 *   mount prefix rather than by convention, and teardown deletes the prefix AND
 *   the ephemeral bucket in a `finally` that runs on every exit path. It refuses
 *   to start against a bucket that already has objects in it rather than
 *   deleting someone else's data.
 *
 *   GATE SAFETY. Nothing here runs without `--run`-equivalent intent: with no
 *   credentials, no bucket and no container it prints a plan and exits 0. The
 *   pure parts — the plan, the option sets, the statistics, the renderer — are
 *   pinned by `scripts/bench-r2-workspace.test.ts`, which needs no network.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, armSignalTeardown, deleteContainerApps, publishTeardown,
  runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import * as v from 'valibot';
import {
  NATIVE_ROOT, OVERLAY_LOWER_MOUNT, OVERLAY_MERGED, R2_MOUNT_PATH, S3FS_CACHE_DIR,
  TUNED_S3FS_OPTIONS, benchKeyPrefix, layoutsFor, mountPrefixFor, type LayoutSpec,
} from './fixtures/r2-bench/layouts';
import {
  parseProbeRun, renderMarkdown, syncMeasurements, type DurabilityVerdict, type LayoutResult,
  type OpTally, type ProbeRun, type RunArtifact, type SyncMeasurement, type SyncOutcome,
} from './fixtures/r2-bench/report';
import { evaluateRun, recordFromR2Artifact } from './fixtures/storage-matrix/admission';

const FIXTURE_DIR = join(dirname(new URL(import.meta.url).pathname), 'fixtures', 'r2-bench');
const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
/**
 * Where the probe and its helpers live inside the container.
 *
 * MEASURED, NOT ASSUMED: `/opt/r2-bench` did not survive. The first live run
 * installed the harness there, verified it with `cd … && bun --version`, and
 * then failed the very next exec with `cd: /opt/r2-bench: No such file or
 * directory`. Only `/workspace` is the container's persistent volume; anything
 * written elsewhere is gone the moment the container is recycled, which the
 * platform can do between two RPCs. Since this benchmark also restarts the
 * container ON PURPOSE to test durability, the harness has to live somewhere
 * that survives a restart, and the dotted name keeps it out of the arms' own
 * trees.
 */
const CONTAINER_HARNESS_DIR = '/workspace/.r2-bench';
const DEFAULT_BUCKET = 'kinu-bench-r2fs';
const STAGING_BUCKET = 'kinu-backups-staging';
/** Phases run per repetition, overridable with `--phases`. The durability pair
 *  is driven separately, around a container restart, so it is not in this list.
 *  Ordered cheapest-first so a run that has to be cut short still produced the
 *  comparisons that need the least container time. */
// ONE EXEC PER METRIC GROUP, cheapest first. Phase-level execs were still too
// coarse on a mounted arm: npmlike, gitlike and the bulk small-file phases each
// exceeded the platform per-exec ceiling, and every attempt paid the whole
// ceiling before failing, so three repetitions across three mounted arms became
// a run measured in hours of waiting to be told no. Splitting seq by size and
// small by count keeps every call far inside the ceiling and turns a lost arm
// into, at worst, one missing cell.
const PHASES = 'posix,seq1,seq10,rand,archive,npmlike,gitlike,small1k,seq100,small10k';
/**
 * Metric groups that exceed the platform's per-exec ceiling on a mounted arm and
 * are therefore driven as a PROCESS with polled output rather than a blocking
 * exec. Measured: with one exec per metric group and 8 s loop budgets, these
 * four still timed out on the untuned mount while posix/seq1/seq10/rand/archive
 * landed. A blocking exec is bounded by a ceiling no timeout option raises, so
 * it is the wrong instrument for a minute-scale workload — and a real workspace
 * workload runs as a process anyway.
 */
interface ProcessDrivenPhases {
  readonly [phase: string]: true | undefined;
}

const PROCESS_DRIVEN_PHASES: ProcessDrivenPhases = {
  npmlike: true, gitlike: true, small1k: true, small10k: true, seq100: true,
};
/** How long a process-driven group may run before the driver gives up on it. */
const PROCESS_DEADLINE_MS = 1_800_000;
/** Gap between sentinel polls. Each poll is a tiny exec, nowhere near the ceiling. */
const PROCESS_POLL_MS = 10_000;

interface Options {
  reps: number;
  seed: number;
  bucket: string;
  /** Only `deploy` exists: `wrangler dev --remote` refuses Durable Objects, and
   *  a local run has neither a real container nor a real R2. Kept as a field so
   *  the artifact records HOW the numbers were produced. */
  mode: 'deploy';
  layouts: string[];
  plan: boolean;
  keep: boolean;
  out: string;
  timeoutMs: number;
  /** Host directory holding a sibling sync implementation, uploaded and run
   *  instead of the built-in stand-in. Empty means use the stand-in. */
  syncCli: string;
  /** Per-loop time bound handed to the probe. */
  budgetMs: number;
  /** Phase list per repetition, so a calibration run can isolate one. */
  phases: string;
  /** Empty and delete the bucket, then exit. The recovery path for a run that
   *  aborted against a pre-existing bucket. */
  purgeBucket: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1]! : fallback;
  };
  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return {
    reps: Number.parseInt(value('reps', '3'), 10),
    seed: Number.parseInt(value('seed', '20260824'), 10),
    bucket: value('bucket', DEFAULT_BUCKET),
    mode: 'deploy',
    layouts: value('layouts', 'native,r2-uncached,r2-tuned,overlay').split(','),
    plan: argv.includes('--plan'),
    keep: argv.includes('--keep'),
    out: value('out', join('bench-artifacts', `r2-workspace-${runId}.json`)),
    timeoutMs: Number.parseInt(value('phase-timeout-ms', '900000'), 10),
    syncCli: '',
    budgetMs: Number.parseInt(value('budget-ms', '30000'), 10),
    phases: value('phases', PHASES),
    purgeBucket: argv.includes('--purge-bucket'),
  };
}

const log = (message: string): void => {
  process.stderr.write(`[r2-bench] ${message}\n`);
};

armSignalTeardown(log);

const wrangler = (args: readonly string[], options: { allowFailure?: boolean } = {}): string =>
  runWrangler(REPO_ROOT, args, options);

// ── the HTTP client the fixture answers ─────────────────────────────────────

interface Fixture {
  origin: string;
  token: string;
}

/**
 * How long the client waits on one fixture call.
 *
 * MEASURED, NOT ASSUMED: without an explicit signal the first full run died on
 * `TimeoutError: The operation timed out.` part-way through the first R2
 * repetition — the runtime's own default cut a request the Worker was still
 * happily serving. An HTTP-triggered Worker has NO wall-clock limit while the
 * caller stays connected (`worker.wall.http_unlimited`), so the bound that
 * matters is the caller's, and it has to exceed the phase budget rather than
 * merely match it.
 */
const CALL_TIMEOUT_MS = 3_600_000;

/**
 * What this driver asks the fixture to do: a flat object of scalars and string
 * lists, which is what the routes read out of a request body.
 */
type FixtureRequest = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/**
 * The fixture's own refusal. Its handler catches everything and answers the
 * reason at status 200, so a route's own fields are absent on that path — which
 * is what a container that went away mid-call looks like from here.
 *
 * A reply type below carries this as an arm when the driver has something to do
 * with a refusal: the probe's retry, and a mount refusal, which is itself a
 * result. Where there is nothing to do about it the route's schema requires its
 * own fields, so a refusal fails the parse and `call` throws carrying the
 * fixture's own words in the payload prefix.
 */
interface FixtureRefusal {
  readonly error: string;
  readonly stack?: string;
}

const FixtureRefusalSchema: v.GenericSchema<FixtureRefusal> = v.object({
  error: v.string(),
  stack: v.optional(v.string()),
});

/** A route called for its effect, whose reply this driver does not read. */
interface FixtureAck {
  readonly ok?: boolean;
  readonly error?: string;
}

const FixtureAckSchema: v.GenericSchema<FixtureAck> = v.object({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

async function call<TSchema extends v.GenericSchema>(
  fixture: Fixture,
  method: 'GET' | 'POST',
  path: string,
  schema: TSchema,
  body?: FixtureRequest,
): Promise<v.InferOutput<TSchema>> {
  const authorization = `Bearer ${fixture.token}`;
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: body === undefined
      ? { authorization }
      : { authorization, 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${fixture.origin}${path}`, init);
  const text = await response.text();
  if (!response.ok && response.status !== 200) {
    throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 400)}`, { cause: error });
  }
  const parsed = v.safeParse(schema, decoded);
  if (!parsed.success) {
    throw new Error(
      `${method} ${path} answered outside its contract: `
      + parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ')
      + `\n${text.slice(0, 400)}`,
    );
  }
  return parsed.output;
}

/** One exec, as the fixture answers it. `error` is declared absent on this arm
 *  so a reader that checks it narrows to the fields a completed exec carries. */
interface ExecCompleted {
  readonly error?: undefined;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
}

/** Either the exec completed, or the fixture refused it. The second arm is the
 *  container event the probe recovers from, so it belongs to the contract. */
type ExecReply = ExecCompleted | FixtureRefusal;

const ExecReplySchema: v.GenericSchema<ExecReply> = v.union([
  v.object({
    ok: v.boolean(),
    exitCode: v.number(),
    stdout: v.string(),
    stderr: v.string(),
    wallMs: v.number(),
  }),
  FixtureRefusalSchema,
]);

async function sh(fixture: Fixture, command: string, timeoutMs: number): Promise<ExecReply> {
  return await call(fixture, 'POST', '/exec', ExecReplySchema, { command, timeoutMs });
}

/** The exec's own answer, for a caller with no recovery path: a refusal there is
 *  a container event nothing local can fix, and reading a field the fixture
 *  never sent would say nothing about it. */
function execCompleted(reply: ExecReply, what: string): ExecCompleted {
  if (reply.error !== undefined) throw new Error(`exec refused (${what}): ${reply.error}`);
  return reply;
}

/** A shell command whose failure is a benchmark failure rather than a datum. */
async function shOrThrow(fixture: Fixture, command: string, timeoutMs: number): Promise<ExecCompleted> {
  const reply = await sh(fixture, command, timeoutMs);
  if (reply.error !== undefined) throw new Error(`exec refused: ${reply.error}`);
  if (!reply.ok) {
    throw new Error(
      `command failed (${reply.exitCode}): ${command}\n${reply.stderr.slice(0, 600)}`,
    );
  }
  return reply;
}

// ── the fixture's lifecycle ─────────────────────────────────────────────────

/**
 * The config `wrangler dev` is given. `wrangler dev` has no `--r2` flag, so a
 * bucket other than the committed default can only be expressed by a config
 * file. The common path uses the committed one untouched; an override writes one
 * derived file beside it, which teardown removes. Returned so the caller can
 * delete it.
 */
interface FixtureConfig {
  path: string;
  generated: boolean;
}

/**
 * The fixture's own wrangler config, as far as this driver reads it. LOOSE on
 * purpose: the override is this file with one bucket replaced, so every key the
 * driver does not read has to survive into the generated file. A schema that
 * dropped them would hand `wrangler dev` a different config than the committed
 * one describes.
 */
const FixtureWranglerSchema = v.looseObject({
  r2_buckets: v.optional(v.array(v.object({ binding: v.string(), bucket_name: v.string() }))),
});

function resolveConfig(bucket: string): FixtureConfig {
  const committed = join(FIXTURE_DIR, 'wrangler.jsonc');
  const text = readFileSync(committed, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${committed} is not JSON once its comments are stripped: `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = v.safeParse(FixtureWranglerSchema, decoded);
  if (!parsed.success) {
    throw new Error(
      `${committed} is not a config this driver can rewrite: `
      + parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; '),
    );
  }
  const source = parsed.output;
  const declared = source.r2_buckets?.[0]?.bucket_name;
  if (declared === bucket) return { path: committed, generated: false };

  const generated = join(FIXTURE_DIR, 'wrangler.run.json');
  writeFileSync(generated, `${JSON.stringify(
    { ...source, r2_buckets: [{ binding: 'BACKUP_BUCKET', bucket_name: bucket }] },
    null,
    2,
  )}\n`);
  log(`bucket override ${bucket}: generated ${generated}`);
  return { path: generated, generated: true };
}

/**
 * Publish the fixture and hand back its origin, plus the call that removes it.
 *
 * MEASURED, NOT ASSUMED: `wrangler dev --remote` cannot serve this fixture.
 * wrangler refuses it outright — "`wrangler dev --remote` is no longer supported
 * for Durable Objects. Use `wrangler dev` for local development." — and this
 * benchmark is worthless locally, because Miniflare has neither a real container
 * nor a real R2. So the only route to a real container is a real deployment, and
 * the price of that is having to delete it afterwards, which teardown does.
 *
 * The token goes through `--var` rather than into the config file: a per-run
 * secret written to disk is a secret that outlives a crash.
 */
async function deployFixture(
  configPath: string,
  token: string,
): Promise<{ fixture: Fixture; stop: () => void }> {
  // A crashed earlier run can leave the container application behind, and the
  // deploy then fails on the name. Removing it first is safe because the name is
  // derived from this fixture's own Worker name and belongs to nothing else.
  const stale = deleteContainerApps(REPO_ROOT, [FIXTURE_CONTAINER_APP], log).join(', ');
  if (stale !== 'absent') log(`cleared a stale container application: ${stale}`);

  const output = wrangler(['deploy', '--config', configPath, '--var', `BENCH_TOKEN:${token}`]);
  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  if (origin === undefined) {
    throw new Error(`wrangler deploy printed no workers.dev origin:\n${output.slice(-3000)}`);
  }
  log(`deployed ${origin}`);

  // Routing settles a moment after the upload returns. An unauthenticated probe
  // expecting 401 is the cheapest proof that the Worker is answering AND that
  // the token gate is armed — a 200 here would mean the fixture is open.
  const deadline = Date.now() + 120_000;
  for (;;) {
    let probe = 0;
    try {
      probe = (await fetch(`${origin}/shape`, { signal: AbortSignal.timeout(10_000) })).status;
    } catch (error) {
      // Routing has not settled, or the edge dropped the probe. Tolerated by
      // design — the deadline below ends it — but not silently.
      log(`fixture not answering yet: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (probe === 401) break;
    if (probe === 200) throw new Error('the fixture answered an unauthenticated request; refusing to run');
    if (Date.now() > deadline) throw new Error(`fixture never answered at ${origin} (last status ${probe})`);
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, 2_000);
    await settle.promise;
  }

  return {
    fixture: { origin, token },
    stop: () => {
      // Two routes, because the first one has failed in practice: `delete
      // --config` errored against /workers/services/kinu-r2-bench and left the
      // Worker live on workers.dev, while `delete --name` removed it on the
      // first try. A teardown with one route is a teardown that leaks whenever
      // that route is the one that breaks.
      let deleted = wrangler(['delete', '--config', configPath, '--force'], { allowFailure: true });
      if (deleted.startsWith(WRANGLER_FAILED)) {
        log(`delete --config failed, falling back to --name: ${deleted.slice(0, 160)}`);
        deleted = wrangler(['delete', '--name', FIXTURE_WORKER, '--force'], { allowFailure: true });
      }
      if (deleted.startsWith(WRANGLER_FAILED)) {
        log(`WARNING: the fixture Worker was NOT deleted. Remove it by hand: ${deleted.slice(0, 300)}`);
      } else {
        log('fixture Worker deleted');
      }
      // The Worker delete does NOT remove the container application, so this is
      // the second half of leaving nothing behind.
      const app = deleteContainerApps(REPO_ROOT, [FIXTURE_CONTAINER_APP], log).join(', ');
      log(`container application: ${app}`);
    },
  };
}

// ── bucket lifecycle, with the refusal Main asked for ───────────────────────

interface BucketLease {
  created: boolean;
  name: string;
}

function bucketExists(name: string): boolean {
  const listing = wrangler(['r2', 'bucket', 'list'], { allowFailure: true });
  return listing.includes(name);
}

/** The Worker this fixture publishes, and the container application the
 *  platform derives from it (`<worker>-<class_name lowercased>`). Both are
 *  deleted by teardown. */
const FIXTURE_WORKER = 'kinu-r2-bench';
const FIXTURE_CONTAINER_APP = `${FIXTURE_WORKER}-sandbox`;

/** The container's own description of itself. Both arms sit in one object
 *  because the caller retries on either: an answer without a description and a
 *  refusal are the same event from here, and both are logged per attempt. */
interface ContainerFactsReply {
  readonly ok?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

const ContainerFactsReplySchema: v.GenericSchema<ContainerFactsReply> = v.object({
  ok: v.optional(v.boolean()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  error: v.optional(v.string()),
});

/**
 * Get the container running, and report what it is.
 *
 * Retried, because a cold container start is genuinely flaky under account
 * capacity pressure rather than broken: the first live run of this benchmark
 * died on `OperationInterruptedError: The sandbox container stopped while the
 * operation was pending`, and a second attempt succeeded. Retrying a COLD START
 * is not the same thing as retrying a measurement — nothing has been measured
 * yet, so nothing is being papered over. Every attempt is logged, and the
 * attempt count reaches the report so a run that needed four tries does not
 * read like a run that needed one.
 */
async function bringContainerUp(fixture: Fixture): Promise<string> {
  const attempts = 4;
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const facts = await call(fixture, 'GET', '/shape', ContainerFactsReplySchema);
    if (facts.error === undefined && facts.stdout !== undefined) {
      return attempt === 1 ? facts.stdout : `${facts.stdout}\n(container start took ${attempt} attempts)`;
    }
    last = facts.error ?? 'the fixture answered without a shape or an error';
    log(`container start attempt ${attempt}/${attempts} failed: ${last}`);
    if (attempt < attempts) {
      const settle = Promise.withResolvers<void>();
      setTimeout(settle.resolve, attempt * 15_000);
      await settle.promise;
    }
  }
  throw new Error(`container never came up after ${attempts} attempts: ${last}`);
}

/**
 * Take the bucket. Creates it when absent; when present, REFUSES if it holds any
 * object rather than deleting data this benchmark did not write. That refusal is
 * the whole safety property of the teardown: everything else assumes the bucket
 * is ours.
 */
function acquireBucket(name: string): BucketLease {
  if (!bucketExists(name)) {
    log(`creating ephemeral bucket ${name}`);
    wrangler(['r2', 'bucket', 'create', name]);
    return { created: true, name };
  }
  if (name === STAGING_BUCKET) {
    log(
      'WARNING: running against the staging backup bucket. Objects outside '
      + 'bench/<runId>/ will NOT be removed by teardown, and any workspace-snapshot '
      + 'traffic in the same bucket will appear in these numbers.',
    );
    return { created: false, name };
  }
  const listing = wrangler(['r2', 'object', 'get', `${name}/`, '--pipe'], { allowFailure: true });
  if (!listing.startsWith(WRANGLER_FAILED)) {
    throw new Error(
      `bucket ${name} already exists and appears to hold objects. Refusing to run: this `
      + `benchmark deletes the bucket it uses during teardown, and it will not delete data it `
      + `did not create. Pass --bucket <other-name>, or empty this one deliberately first.`,
    );
  }
  log(`reusing existing empty bucket ${name}`);
  return { created: false, name };
}

// ── the harness inside the container ────────────────────────────────────────

async function installHarness(fixture: Fixture, syncCli: string): Promise<void> {
  await shOrThrow(fixture, `mkdir -p ${CONTAINER_HARNESS_DIR}`, 60_000);
  for (const file of ['stats.ts', 'probe.ts', 'sync.ts']) {
    const content = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    await call(fixture, 'POST', '/write', FixtureAckSchema, {
      path: `${CONTAINER_HARNESS_DIR}/${file}`, content,
    });
  }

  if (syncCli !== '') {
    const dir = `${CONTAINER_HARNESS_DIR}/sibling`;
    await shOrThrow(fixture, `mkdir -p ${dir}`, 60_000);
    // Tests are excluded deliberately: they are not needed to run the CLI and
    // one could reach for a fixture that does not exist in here. `tsconfig.json`
    // IS needed — bun reads it for the module settings the sources were written
    // against.
    const hostDir = join(REPO_ROOT, syncCli);
    const files = readdirSync(hostDir, { withFileTypes: true })
      .filter((item) => item.isFile()
        && ((item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) || item.name === 'tsconfig.json'))
      .map((item) => item.name);
    if (files.length === 0) throw new Error(`--sync-cli ${syncCli} holds no .ts files`);
    for (const file of files) {
      await call(fixture, 'POST', '/write', FixtureAckSchema, {
        path: `${dir}/${file}`,
        content: readFileSync(join(hostDir, file), 'utf8'),
      });
    }
    log(`uploaded ${files.length} sibling sync file(s) from ${syncCli}`);
  }

  // Prove the runtime the probe needs is actually present before spending an
  // arm's worth of container time discovering it is not.
  await shOrThrow(fixture, `cd ${CONTAINER_HARNESS_DIR} && bun --version`, 60_000);
}

async function runProbe(
  fixture: Fixture,
  root: string,
  phases: string,
  seed: number,
  options: Options,
  withFacts = false,
): Promise<ProbeRun> {
  const command =
    `cd ${CONTAINER_HARNESS_DIR} && bun probe.ts --root ${root} --phase ${phases} --seed ${seed}`
    + (withFacts ? ' --facts' : '');

  if (PROCESS_DRIVEN_PHASES[phases] === true) return await runProbeAsProcess(fixture, root, phases, seed, options);

  const attempts = 3;
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const reply = await sh(fixture, command, options.timeoutMs);

    // A CONTAINER EVENT, not a measurement failure. `status: 500`,
    // ContainerUnavailable and OperationInterrupted all mean the instance went
    // away underneath the call — the same platform behaviour that takes the
    // harness with it. A full 4-arm matrix issues dozens of execs, so treating
    // the first one of these as fatal loses every arm after it: this run died in
    // the THIRD repetition of the FIRST arm and reported no numbers at all.
    // Retrying a call that measured nothing is recovery; it is never a retry of
    // a result, because a reply that produced JSON returns immediately above.
    if (reply.error !== undefined) {
      const transient =
        /status: 5\d\d|ContainerUnavailable|OperationInterrupted|container stopped|not running/i.test(reply.error);
      if (!transient) throw new Error(`probe exec refused: ${reply.error}`);
      last = reply.error;
    } else {
      const start = reply.stdout.indexOf('{');
      if (start !== -1) return parseProbeRun(reply.stdout.slice(start), `probe ${phases} in ${root}`);
      const lost = /No such file or directory/.test(reply.stderr);
      last = `exit ${reply.exitCode}: ${reply.stderr.slice(0, 300)}`;
      if (!lost) {
        throw new Error(
          `probe printed no JSON (exit ${reply.exitCode}).\nstdout: ${reply.stdout.slice(0, 600)}`
          + `\nstderr: ${reply.stderr.slice(0, 600)}`,
        );
      }
    }
    if (attempt === attempts) break;
    log(`probe attempt ${attempt}/${attempts} hit a container event (${last.slice(0, 120)}); recovering`);
    // Give the instance time to come back before reinstalling into it.
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, attempt * 10_000);
    await settle.promise;
    await bringContainerUp(fixture);
    await installHarness(fixture, options.syncCli);
  }
  throw new Error(`probe never produced JSON after ${attempts} attempts: ${last}`);
}

/** What `/spawn` answers. Both arms sit in one object because the caller treats
 *  an unconfirmed process and a refusal identically: neither can be polled. */
interface SpawnReply {
  readonly ok?: boolean;
  readonly processId?: string;
  readonly error?: string;
}

const SpawnReplySchema: v.GenericSchema<SpawnReply> = v.object({
  ok: v.optional(v.boolean()),
  processId: v.optional(v.string()),
  error: v.optional(v.string()),
});

/**
 * Run one metric group as a detached process and poll for its result.
 *
 * The probe writes its JSON to a file and then a `.done` sentinel, in that
 * order, so a sentinel that exists always names a complete payload. The driver
 * holds no long request open: every poll is a `test -f` exec measured in
 * milliseconds, and the final read is one `cat` of a small file. This is the
 * instrument for anything whose wall time is minute-scale.
 */
async function runProbeAsProcess(
  fixture: Fixture,
  root: string,
  phase: string,
  seed: number,
  options: Options,
): Promise<ProbeRun> {
  const out = `${CONTAINER_HARNESS_DIR}/out-${phase}-${seed}.json`;
  await sh(fixture, `rm -f ${out} ${out}.done`, 60_000);
  const spawned = await call(
    fixture, 'POST', '/spawn', SpawnReplySchema,
    {
      command: `bun ${CONTAINER_HARNESS_DIR}/probe.ts --root ${root} --phase ${phase} `
        + `--seed ${seed} --budget-ms ${options.budgetMs} --out ${out}`,
      cwd: CONTAINER_HARNESS_DIR,
    },
  );
  if (spawned.error !== undefined || spawned.ok !== true) {
    throw new Error(`could not spawn ${phase}: ${spawned.error ?? 'the route did not confirm a process'}`);
  }

  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (;;) {
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, PROCESS_POLL_MS);
    await settle.promise;
    const poll = execCompleted(
      await sh(fixture, `test -f ${out}.done && echo DONE || echo WAIT`, 120_000),
      `${phase} sentinel poll`,
    );
    if (poll.stdout.includes('DONE')) break;
    if (Date.now() > deadline) {
      throw new Error(`${phase} did not finish within ${Math.round(PROCESS_DEADLINE_MS / 60_000)} minutes`);
    }
  }

  const read = execCompleted(await sh(fixture, `cat ${out}`, 300_000), `${phase} result read`);
  const start = read.stdout.indexOf('{');
  if (start === -1) throw new Error(`${phase} produced no readable result: ${read.stderr.slice(0, 300)}`);
  return parseProbeRun(read.stdout.slice(start), `probe ${phase} in ${root}`);
}

// ── layout setup ───────────────────────────────────────────────────────────

/** One mount attempt. `error` is declared absent on this arm so a reader that
 *  checks it narrows to the numbers a completed mount carries. */
interface MountCompleted {
  readonly error?: undefined;
  readonly ok: boolean;
  readonly mountMs: number;
  readonly mountpoint?: string;
}

/** A refusal here is a RESULT — which s3fs option set the platform rejects — so
 *  it is an arm of the contract rather than an exception. */
type MountReply = MountCompleted | FixtureRefusal;

const MountReplySchema: v.GenericSchema<MountReply> = v.union([
  v.object({ ok: v.boolean(), mountMs: v.number(), mountpoint: v.optional(v.string()) }),
  FixtureRefusalSchema,
]);

/** Clear a mount that may not be there. Every caller is making room for the next
 *  arm, so a refusal is tolerated — and logged, because a mount that would not
 *  go away is why the next arm's numbers would be wrong. */
async function clearMount(fixture: Fixture, mountPath: string): Promise<void> {
  try {
    await call(fixture, 'POST', '/unmount', FixtureAckSchema, { mountPath });
  } catch (error) {
    log(`unmount ${mountPath} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bring one arm up. The R2 arms mount; the overlay arm mounts and then stacks a
 * fuse-overlayfs whose lower is the mount and whose upper and work directories
 * are on the container disk.
 *
 * The overlay arm mounts WRITABLE even though the layout is described as a
 * read-only lower. overlayfs only ever reads its lower, so read-only is a
 * property of how the lower is used, and the sync needs somewhere on R2 to
 * write. A second, writable mount of the same binding is not available: the SDK
 * refuses a second mount of one binding at a different readOnly value. The
 * read-only claim is therefore verified separately, by
 * `verifyReadOnlyRefusesWrites`, which is a stronger check than mounting `ro`
 * and never testing it.
 */
async function bringUp(
  fixture: Fixture,
  spec: LayoutSpec,
  timeoutMs: number,
): Promise<{ coldMs: number | null; warmMs: number | null; error: string | null }> {
  if (spec.mount === undefined) {
    await shOrThrow(fixture, `mkdir -p ${spec.root}`, timeoutMs);
    return { coldMs: null, warmMs: null, error: null };
  }

  if (spec.id === 'overlay') {
    await shOrThrow(fixture, `mkdir -p ${S3FS_CACHE_DIR}`, timeoutMs);
  } else if (spec.mount.s3fsOptions.some((option) => option.startsWith('use_cache='))) {
    await shOrThrow(fixture, `mkdir -p ${S3FS_CACHE_DIR}`, timeoutMs);
  }

  const cold = await call(fixture, 'POST', '/mount', MountReplySchema, {
    mountPath: spec.mount.mountPath,
    prefix: spec.mount.prefix,
    readOnly: spec.id === 'overlay' ? false : spec.mount.readOnly,
    s3fsOptions: [...spec.mount.s3fsOptions],
  });
  if (cold.error !== undefined) return { coldMs: null, warmMs: null, error: cold.error };
  if (!cold.ok) {
    return { coldMs: null, warmMs: null, error: `mountpoint reported ${cold.mountpoint}` };
  }

  // Warm mount: unmount and mount again with identical options. The gap between
  // this and the cold number is what a container restart would pay.
  await call(fixture, 'POST', '/unmount', FixtureAckSchema, { mountPath: spec.mount.mountPath });
  const warm = await call(fixture, 'POST', '/mount', MountReplySchema, {
    mountPath: spec.mount.mountPath,
    prefix: spec.mount.prefix,
    readOnly: spec.id === 'overlay' ? false : spec.mount.readOnly,
    s3fsOptions: [...spec.mount.s3fsOptions],
  });

  if (spec.id === 'overlay') {
    const upper = `${NATIVE_ROOT}/overlay-upper`;
    const work = `${NATIVE_ROOT}/overlay-work`;
    const lower = `${OVERLAY_LOWER_MOUNT}/base`;
    await shOrThrow(
      fixture,
      `umount ${OVERLAY_MERGED} 2>/dev/null; rm -rf ${upper} ${work}; `
      + `mkdir -p ${upper} ${work} ${OVERLAY_MERGED} ${lower} && `
      + `fuse-overlayfs -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${OVERLAY_MERGED} && `
      + `mountpoint -q ${OVERLAY_MERGED} && echo OVERLAY_MOUNTED`,
      timeoutMs,
    );
  }

  await shOrThrow(fixture, `mkdir -p ${spec.root}`, timeoutMs);
  return {
    coldMs: cold.mountMs,
    warmMs: warm.error === undefined && warm.ok ? warm.mountMs : null,
    error: null,
  };
}

async function tearDownLayout(fixture: Fixture, spec: LayoutSpec, timeoutMs: number): Promise<void> {
  if (spec.id === 'overlay') {
    await sh(fixture, `umount ${OVERLAY_MERGED} 2>/dev/null || fusermount -u ${OVERLAY_MERGED} 2>/dev/null; true`, timeoutMs);
  }
  if (spec.mount !== undefined) {
    await clearMount(fixture, spec.mount.mountPath);
  }
}

/**
 * The read-only claim, tested rather than configured. Mounts the binding `ro`
 * and asserts a write is refused. Runs once, at the end, because it needs the
 * binding unmounted first.
 */
async function verifyReadOnlyRefusesWrites(
  fixture: Fixture,
  runId: string,
  timeoutMs: number,
): Promise<{ holds: boolean; detail: string }> {
  await clearMount(fixture, R2_MOUNT_PATH);
  const mounted = await call(fixture, 'POST', '/mount', MountReplySchema, {
    mountPath: R2_MOUNT_PATH,
    prefix: mountPrefixFor(runId),
    readOnly: true,
    s3fsOptions: [...TUNED_S3FS_OPTIONS],
  });
  if (mounted.error !== undefined) {
    return { holds: false, detail: `read-only mount failed: ${mounted.error}` };
  }
  if (!mounted.ok) return { holds: false, detail: 'read-only mount failed: unknown' };
  const attempt = execCompleted(
    await sh(fixture, `touch ${R2_MOUNT_PATH}/readonly-probe 2>&1; echo "exit=$?"`, timeoutMs),
    'read-only write probe',
  );
  await clearMount(fixture, R2_MOUNT_PATH);
  const refused = /exit=[^0]/.test(attempt.stdout) || /Read-only|Permission denied|Forbidden/i.test(attempt.stdout);
  return {
    holds: refused,
    detail: refused
      ? `write refused: ${attempt.stdout.trim().slice(0, 160)}`
      : `write SUCCEEDED against a readOnly mount: ${attempt.stdout.trim().slice(0, 160)}`,
  };
}

// ── the run ────────────────────────────────────────────────────────────────

function describePlan(options: Options, runId: string): string {
  const lines: string[] = [];
  lines.push('R2 workspace-layout benchmark — plan');
  lines.push('');
  lines.push(`run id            ${runId}`);
  lines.push(`repetitions       ${options.reps}`);
  lines.push(`seed              ${options.seed}`);
  lines.push(`bucket            ${options.bucket} (ephemeral unless it already exists)`);
  lines.push(`key prefix        ${benchKeyPrefix(runId)}`);
  lines.push(`mode              ${options.mode}`);
  lines.push(`phases per rep    ${options.phases}`);
  lines.push(`artifact          ${options.out}`);
  lines.push('');
  for (const spec of layoutsFor(runId)) {
    if (!options.layouts.includes(spec.id)) continue;
    lines.push(`arm ${spec.id}`);
    lines.push(`  root      ${spec.root}`);
    lines.push(`  question  ${spec.question}`);
    if (spec.mount !== undefined) {
      lines.push(`  mount     ${spec.mount.mountPath} prefix=${spec.mount.prefix} readOnly=${spec.mount.readOnly}`);
      lines.push(`  s3fs      ${spec.mount.s3fsOptions.length === 0 ? '(SDK defaults only)' : spec.mount.s3fsOptions.join(',')}`);
    } else {
      lines.push('  mount     none (control)');
    }
    lines.push('');
  }
  lines.push('Nothing has run. Drop --plan to execute.');
  return lines.join('\n');
}

/** What a purge removed. The refusal arm is carried because the artifact records
 *  a refused purge under `purgeError` rather than dropping it. */
interface PurgeCompleted {
  readonly error?: undefined;
  readonly deleted: number;
  readonly passes: number;
}

type PurgeReply = PurgeCompleted | FixtureRefusal;

const PurgeReplySchema: v.GenericSchema<PurgeReply> = v.union([
  v.object({ deleted: v.number(), passes: v.number() }),
  FixtureRefusalSchema,
]);

/** Objects and bytes under one prefix, as the fixture counted them. Required
 *  rather than optional: a count this driver did not receive is not a zero, and
 *  there is nothing it can do about a refusal, so the parse fails and says so. */
interface InventoryReply {
  readonly objects: number;
  readonly bytes: number;
}

const InventoryReplySchema: v.GenericSchema<InventoryReply> = v.object({
  objects: v.number(),
  bytes: v.number(),
});

/** The R2 op tally attributable to one arm. `OpTally` is declared in report.ts
 *  beside the renderer that reads it; its wire schema lives here because this is
 *  the boundary that decodes it. */
interface OpsReply {
  readonly tally: OpTally;
}

const OpsReplySchema: v.GenericSchema<OpsReply> = v.object({
  tally: v.object({
    calls: v.record(v.string(), v.number()),
    classA: v.number(),
    classB: v.number(),
    classFree: v.number(),
    total: v.number(),
  }),
});

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const runId = /[0-9]{14}/.exec(options.out)?.[0] ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const specs = layoutsFor(runId).filter((spec) => options.layouts.includes(spec.id));

  if (options.plan) {
    process.stdout.write(`${describePlan(options, runId)}\n`);
    return 0;
  }

  // Recovery path, and the reason it exists: a run against a bucket that already
  // existed empties only its own prefix, because emptying a bucket this
  // benchmark did not create is not its decision to make. An aborted run can
  // therefore leave objects that block the next `bucket delete` with "the bucket
  // you tried to delete is not empty". This is the deliberate way to say "that
  // bucket is mine, empty it": it stands the fixture up, drains the bucket
  // whole, deletes the bucket, and removes the fixture again.
  if (options.purgeBucket) {
    const token = `bench-${crypto.randomUUID()}`;
    const config = resolveConfig(options.bucket);
    const started = await deployFixture(config.path, token);
    try {
      const purged = await call(
        started.fixture, 'POST', '/purge', PurgeReplySchema, { prefix: '', whole: true },
      );
      log(purged.error === undefined
        ? `purged ${purged.deleted} object(s) in ${purged.passes} pass(es)`
        : `purge refused: ${purged.error}`);
    } finally {
      started.stop();
      if (config.generated) rmSync(config.path, { force: true });
    }
    const deleted = wrangler(['r2', 'bucket', 'delete', options.bucket], { allowFailure: true });
    log(deleted.startsWith(WRANGLER_FAILED) ? `bucket NOT deleted: ${deleted.slice(0, 300)}` : 'bucket deleted');
    return deleted.startsWith(WRANGLER_FAILED) ? 1 : 0;
  }

  const identity = wrangler(['whoami'], { allowFailure: true });
  if (identity.startsWith(WRANGLER_FAILED)) {
    log('wrangler is not authenticated, so no container can be raised. Printing the plan instead.');
    process.stdout.write(`${describePlan(options, runId)}\n`);
    return 0;
  }

  const token = `bench-${crypto.randomUUID()}`;
  const keyPrefix = benchKeyPrefix(runId);
  const startedAt = new Date().toISOString();
  // Both of these are taken INSIDE the guarded region below, so that a failure
  // between creating the bucket and starting the fixture is still cleaned up.
  // Taking them before the `try` is how a benchmark leaks the bucket it just
  // made.
  let lease: BucketLease = { created: false, name: options.bucket };
  let config: FixtureConfig = { path: '', generated: false };
  let stopFixture: (() => void) | null = null;
  let fixture: Fixture | null = null;
  const teardown: Record<string, number | string | boolean> = {};
  const conditions: string[] = [];
  const layouts: LayoutResult[] = [];
  let containerFacts = 'not collected';
  let failure: string | null = null;

  try {
    lease = acquireBucket(options.bucket);
    config = resolveConfig(lease.name);
    log(`starting fixture (${options.mode}) against ${lease.name}`);
    const started = await deployFixture(config.path, token);
    stopFixture = started.stop;
    fixture = started.fixture;

    containerFacts = await bringContainerUp(fixture);
    log('container up');

    await installHarness(fixture, options.syncCli);

    for (const spec of specs) {
      log(`arm ${spec.id}: bringing up`);
      // The reply is the tally being cleared, which nothing here reads.
      await call(fixture, 'POST', '/ops/reset', FixtureAckSchema);
      const mount = await bringUp(fixture, spec, options.timeoutMs);
      const reps: ProbeRun[] = [];
      const notes: string[] = [];

      if (mount.error !== null) {
        log(`arm ${spec.id}: refused — ${mount.error}`);
        layouts.push({
          id: spec.id, label: spec.label, question: spec.question, root: spec.root,
          s3fsOptions: spec.mount?.s3fsOptions ?? [], readOnly: spec.mount?.readOnly ?? null,
          mountColdMs: null, mountWarmMs: null, mountError: mount.error, reps: [],
          ops: null, objectsAfter: null, bytesAfter: null, sync: null, durability: null,
          notes: ['the arm never mounted, so nothing downstream of it was measured'],
        });
        continue;
      }

      for (let rep = 0; rep < options.reps; rep++) {
        log(`arm ${spec.id}: repetition ${rep + 1}/${options.reps}`);
        // A fresh subtree per repetition. Reusing one would let repetition two
        // read repetition one's caches and would report a warm number as a cold
        // one.
        const root = `${spec.root}/rep${rep}`;
        // ONE EXEC PER PHASE, not one per repetition.
        //
        // MEASURED, NOT ASSUMED: a single exec carrying all seven phases died
        // twice at `TimeoutError: The operation timed out.` about six minutes
        // into the first R2 repetition. The client signal is an hour, so the
        // ceiling is the platform's own on one container RPC — and no `timeout`
        // option raises it. Splitting the call keeps every exec far inside that
        // ceiling AND isolates failure: a phase that cannot finish on an arm now
        // costs that phase rather than the whole repetition, which is the
        // difference between a gap in a table and an empty column.
        const merged: ProbeRun[] = [];
        for (const phase of options.phases.split(',')) {
          const first = rep === 0 && merged.length === 0;
          try {
            merged.push(await runProbe(fixture, root, phase.trim(), options.seed + rep, options, first));
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log(`arm ${spec.id}: phase ${phase} failed: ${reason.slice(0, 200)}`);
            notes.push(`phase ${phase} did not complete on repetition ${rep + 1}: ${reason.slice(0, 300)}`);
          }
        }
        if (merged.length === 0) throw new Error(`every phase failed on arm ${spec.id}`);
        reps.push({
          ...merged[0]!,
          phases: merged.flatMap((run) => run.phases),
        });
      }

      // Explicit sync, for the arm that needs one.
      let sync: SyncOutcome | null = null;
      if (spec.needsSync) {
        const live = await runSync(fixture, runId, options);
        // Second sync with no intervening writes. A layout whose idle cost is
        // not zero is a layout that charges for doing nothing.
        const idle = await runSync(fixture, runId, options);
        const measurements: SyncMeasurement[] = [...live.measurements];
        if (idle.error !== null) measurements.push({ name: 'idle_error', kind: 'note', note: idle.error });
        for (const measurement of idle.measurements) {
          measurements.push(measurement.kind === 'count'
            ? { name: `idle_${measurement.name}`, kind: 'count', count: measurement.count }
            : { name: `idle_${measurement.name}`, kind: 'note', note: measurement.note });
        }
        sync = { implementation: live.implementation, error: live.error, measurements };
      }

      // Durability is ONE measurement among many and it deliberately restarts the
      // container, which is the most likely moment for a platform event. Letting
      // it throw killed a run that had already collected three repetitions of
      // real data, so it is contained here: a failed durability probe is a null
      // durability row, not a lost arm.
      let durability: LayoutResult['durability'] = null;
      try {
        durability = await measureDurability(fixture, spec, options, runId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`arm ${spec.id}: durability not measured: ${reason.slice(0, 200)}`);
        notes.push(`durability was not measured: ${reason.slice(0, 300)}`);
      }
      const ops = (await call(fixture, 'GET', '/ops', OpsReplySchema)).tally;
      const inv = await call(
        fixture, 'GET', `/inventory?prefix=${encodeURIComponent(keyPrefix)}`, InventoryReplySchema,
      );

      await tearDownLayout(fixture, spec, options.timeoutMs);
      layouts.push({
        id: spec.id, label: spec.label, question: spec.question, root: spec.root,
        s3fsOptions: spec.mount?.s3fsOptions ?? [], readOnly: spec.mount?.readOnly ?? null,
        mountColdMs: mount.coldMs, mountWarmMs: mount.warmMs, mountError: null,
        reps, ops: spec.mount === undefined ? null : ops,
        objectsAfter: spec.mount === undefined ? null : inv.objects,
        bytesAfter: spec.mount === undefined ? null : inv.bytes,
        sync, durability, notes,
      });
    }

    const readOnly = await verifyReadOnlyRefusesWrites(fixture, runId, options.timeoutMs);
    conditions.push(
      `readOnly mount refuses writes: ${readOnly.holds ? 'yes' : 'NO'} — ${readOnly.detail}`,
    );
    conditions.push(
      'node_modules is patched: patches/@cloudflare%2Fsandbox@0.12.8.patch rewrites the '
      + 'outbound-handler registry assignment from replace to merge. `bun scripts/patch-parity.ts` '
      + 'is what makes installed==patched checkable rather than assumed.',
    );
    conditions.push(
      'The fixture exports the UPSTREAM Sandbox class, so KinuSandbox\'s 5-minute snapshot tick '
      + 'is absent from these numbers. Kinu\'s own lifecycle needs a separate probe.',
    );

  } catch (error) {
    // A run that dies mid-arm still knows more than a run that never happened:
    // the arms already collected are written out with the failure recorded
    // beside them, so a partial measurement is inspectable instead of lost.
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`run failed: ${failure}`);
  } finally {
    // The hook is published here rather than inline so a SIGTERM can run exactly
    // the same teardown. `runTeardownOnce` guards against doing it twice when a
    // signal arrives while this path is already running.
    publishTeardown(async (): Promise<void> => {
    // Teardown runs on every exit path, including a throw mid-arm. An
    // interrupted benchmark that leaves a bucket behind has failed its own
    // acceptance criterion, so none of this is best-effort.
    //
    // Order matters: the purge goes through the fixture, which is the thing
    // holding the R2 binding, so it must happen BEFORE the process is stopped.
    if (fixture !== null) {
      try {
        // A bucket this run created holds nothing but this run's bytes, so the
        // whole bucket is ours to empty. A pre-existing one is emptied only
        // under the run's own prefix.
        const purge = await call(fixture, 'POST', '/purge', PurgeReplySchema, {
          prefix: lease.created ? '' : keyPrefix,
          whole: lease.created,
        });
        if (purge.error === undefined) {
          teardown['objectsDeleted'] = purge.deleted;
          teardown['purgePasses'] = purge.passes;
        } else {
          teardown['purgeError'] = purge.error;
        }
        const remaining = await call(
          fixture,
          'GET',
          `/inventory?prefix=${encodeURIComponent(lease.created ? '' : keyPrefix)}`,
          InventoryReplySchema,
        );
        teardown['objectsRemaining'] = remaining.objects;
        teardown['bytesRemaining'] = remaining.bytes;
      } catch (error) {
        teardown['purgeError'] = error instanceof Error ? error.message : String(error);
      }
    } else {
      teardown['objectsDeleted'] = 0;
      teardown['purgeNote'] = 'the fixture never came up, so nothing was written to purge';
    }

    if (stopFixture !== null) stopFixture();

    if (config.generated) {
      rmSync(config.path, { force: true });
      teardown['generatedConfigRemoved'] = true;
    }

    if (options.keep) {
      teardown['bucketDeleted'] = false;
      teardown['bucketDeleteDetail'] = '--keep was passed; the bucket and its objects were left in place';
    } else if (lease.created) {
      log(`deleting ephemeral bucket ${lease.name}`);
      const deleted = wrangler(['r2', 'bucket', 'delete', lease.name], { allowFailure: true });
      const failed = deleted.startsWith(WRANGLER_FAILED);
      teardown['bucketDeleted'] = !failed;
      teardown['bucketDeleteDetail'] = failed ? deleted.slice(0, 400) : 'ok';
    } else {
      teardown['bucketDeleted'] = false;
      teardown['bucketDeleteDetail'] =
        'the bucket pre-existed this run, so only the run prefix was removed';
    }
    });
    await runTeardownOnce();
  }

  if (failure !== null) {
    conditions.push(
      `RUN INCOMPLETE. It stopped at: ${failure}. Every arm below the failure point is absent, `
      + `and the arms above it are unaffected by it.`,
    );
  }

  const artifactDraft = {
    schema: 'r2-bench/run@1' as const,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    repetitions: options.reps,
    seed: options.seed,
    mode: options.mode,
    bucket: lease.name,
    keyPrefix,
    versions: collectVersions(),
    containerFacts,
    layouts,
    teardown,
    conditions,
  };
  // This driver observes only the bucket half of cleanup and the read-only
  // probe; every other C-gate and fault-cut field has no instrumentation here,
  // so it carries its REFUSING default rather than an assumed pass.
  const readOnlyRefusedWrites = conditions.some((row) => row.includes('readOnly mount refuses writes: yes'));
  const artifact: RunArtifact = {
    ...artifactDraft,
    admission: evaluateRun(recordFromR2Artifact(artifactDraft, {
      declaredStages: [],
      confirmatoryPlan: null,
      cleanup: {
        attempted: true,
        kept: options.keep,
        workerAbsent: false,
        runtimeAbsent: false,
        bucketAndMultipartEmpty: teardown.bucketDeleted === true
          && teardown.objectsRemaining === 0
          && teardown.purgeError === undefined
          && !options.keep,
        boxDurableStateEmpty: false,
        localSecretsProcessesAbsent: teardown.generatedConfigRemoved === true,
        countersReconciled: false,
        replayIdempotent: false,
        multipartResidue: 0,
        errors: teardown.purgeError === undefined ? [] : [String(teardown.purgeError)],
      },
      deciding: [],
      decidingBudgetMs: options.timeoutMs,
      publication: {
        readOnlyDeclared: true,
        readOnlyRefusedWrites,
        faultCutCompleted: false,
        allOldOrAllNew: null,
        barrierAckLoss: null,
        absentReferences: null,
        rollbackOrPhantomRoot: null,
      },
      security: {
        credentialLeaks: [],
        securityCellsComplete: false,
        prefixEscapes: 0,
        capabilityEscapesOrReplays: 0,
        staleWriterAccepted: false,
        hostileMetadataAccepted: false,
      },
      restore: [],
    })),
  };

  mkdirSync(dirname(join(REPO_ROOT, options.out)), { recursive: true });
  writeFileSync(join(REPO_ROOT, options.out), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${renderMarkdown(artifact)}\n`);
  log(`artifact written to ${options.out}`);
  return failure === null && (artifact.admission.admitted || options.keep) ? 0 : 1;
}

/** The provenance stamp on every number in the artifact: what produced them. */
type RunVersions = {
  readonly commit: string;
  readonly '@cloudflare/sandbox': string;
  readonly '@cloudflare/containers': string;
  readonly image: string;
};

/** Only the field this driver reads out of the product's manifest. */
const PackageDependenciesSchema = v.looseObject({
  dependencies: v.optional(v.record(v.string(), v.string())),
});

function collectVersions(): RunVersions {
  const manifest = join(REPO_ROOT, 'packages/cf-backend/package.json');
  const parsed = v.safeParse(PackageDependenciesSchema, JSON.parse(readFileSync(manifest, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `${manifest} does not declare dependencies this driver can stamp: `
      + parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; '),
    );
  }
  const packageJson = parsed.output;
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    commit = 'unknown (not a git checkout)';
    log(`no revision in the stamp: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    commit,
    '@cloudflare/sandbox': packageJson.dependencies?.['@cloudflare/sandbox'] ?? 'unknown',
    '@cloudflare/containers': packageJson.dependencies?.['@cloudflare/containers'] ?? 'unknown',
    image: 'docker.io/cloudflare/sandbox:0.12.8',
  };
}

/**
 * The overlay arm's explicit sync.
 *
 * Prefers a real implementation when `--sync-cli <dir>` names one: every
 * non-test `.ts` under that directory is uploaded into the container and the
 * sibling's documented argv is invoked (`scan` then `sync`, since scan is what
 * turns the upper layer into journal entries). Falls back to the built-in
 * content-addressed stand-in, and the report says WHICH ran — a sync number
 * attributed to the wrong implementation is worse than no sync number.
 */
async function runSync(
  fixture: Fixture,
  runId: string,
  options: Options,
): Promise<SyncOutcome> {
  const upper = `${NATIVE_ROOT}/overlay-upper`;
  const journal = `${NATIVE_ROOT}/overlay-journal`;
  const remote = `${OVERLAY_LOWER_MOUNT}/sync`;

  if (options.syncCli !== '') {
    const dir = `${CONTAINER_HARNESS_DIR}/sibling`;
    // `s3://` plus an absolute path, which is the sibling's documented form for
    // a live mount as opposed to a plain directory.
    const store = `s3://${OVERLAY_LOWER_MOUNT}/bench/${runId}/overlay`;
    const implementation = `sibling CLI from ${options.syncCli}`;
    const scan = await sh(
      fixture,
      `cd ${dir} && bun cli.ts scan --upper ${upper} --journal ${journal}`,
      options.timeoutMs,
    );
    // The scan's exit code is a datum, and a scan the fixture refused has no
    // exit code — so that reads as a note rather than as a number.
    const scanned: SyncMeasurement = scan.error === undefined
      ? { name: 'scanExit', kind: 'count', count: scan.exitCode }
      : { name: 'scanExit', kind: 'note', note: `the fixture refused the scan: ${scan.error}` };
    const reply = execCompleted(
      await sh(
        fixture,
        `cd ${dir} && bun cli.ts sync --upper ${upper} --journal ${journal} --remote ${store}`,
        options.timeoutMs,
      ),
      implementation,
    );
    const start = reply.stdout.indexOf('{');
    if (start === -1) {
      return {
        implementation,
        error: reply.stderr.slice(0, 400) || 'no JSON emitted',
        measurements: [scanned],
      };
    }
    return {
      implementation,
      error: null,
      measurements: [
        scanned,
        { name: 'syncExit', kind: 'count', count: reply.exitCode },
        ...syncMeasurements(reply.stdout.slice(start), implementation),
      ],
    };
  }

  const reply = execCompleted(
    await sh(
      fixture,
      `cd ${CONTAINER_HARNESS_DIR} && bun sync.ts --upper ${upper} --remote ${remote} --journal ${journal}`,
      options.timeoutMs,
    ),
    'built-in sync stand-in',
  );
  const start = reply.stdout.indexOf('{');
  if (start === -1) {
    return {
      implementation: 'built-in stand-in',
      error: reply.stderr.slice(0, 400) || 'no JSON emitted',
      measurements: [],
    };
  }
  const implementation = 'built-in content-addressed stand-in; no --sync-cli was supplied';
  return {
    implementation,
    error: null,
    measurements: syncMeasurements(reply.stdout.slice(start), implementation),
  };
}

/** What `/restart` answers. Both arms sit in one object because the verdict
 *  below reports an unconfirmed restart rather than assuming the round trip. */
interface RestartReply {
  readonly ok?: boolean;
  readonly restartMs?: number;
  readonly stopError?: string;
  readonly error?: string;
}

const RestartReplySchema: v.GenericSchema<RestartReply> = v.object({
  ok: v.optional(v.boolean()),
  restartMs: v.optional(v.number()),
  stopError: v.optional(v.string()),
  error: v.optional(v.string()),
});

async function measureDurability(
  fixture: Fixture,
  spec: LayoutSpec,
  options: Options,
  runId: string,
): Promise<DurabilityVerdict | null> {
  const root = `${spec.root}/durability`;
  await runProbe(fixture, root, 'seed-durability', options.seed, options);
  const restart = await call(fixture, 'POST', '/restart', RestartReplySchema);
  // The restart itself has to be VERIFIED, not assumed. A durability verdict
  // whose restart silently failed reads as "the bytes survived a restart" when
  // what it actually shows is "the bytes survived whatever happened" — the same
  // assertion hole that let a sibling's probe accept any stdout for an overlay
  // check. If the route did not confirm the round trip, the verdict says so.
  const restartConfirmed = restart.ok === true && restart.restartMs !== undefined;
  const restartNote = restartConfirmed
    ? ''
    : ` [RESTART UNVERIFIED: ${restart.error ?? restart.stopError ?? 'the route did not confirm a stop and a fresh exec'}]`;

  // A restart drops every FUSE mount with the container. Re-establish the arm
  // before asking whether its data survived, otherwise the answer measures the
  // absence of a mount rather than the durability of the bytes.
  if (spec.mount !== undefined) {
    const remount = await bringUp(fixture, spec, options.timeoutMs);
    if (remount.error !== null) {
      return {
        verdict: false,
        detail: `remount after restart failed: ${remount.error}${restartNote}`,
        restartMs: restart.restartMs ?? -1,
      };
    }
  }
  const verify = await runProbe(fixture, root, 'verify-durability', options.seed, options);
  const verdict = verify.phases
    .flatMap((phase) => phase.verdicts)
    .find((candidate) => candidate.name === 'durability-survived-restart');
  void runId;
  return {
    verdict: verdict?.holds ?? false,
    detail: `${verdict?.detail ?? 'the verify phase produced no verdict'}${restartNote}`,
    restartMs: restart.restartMs ?? -1,
  };
}

if (import.meta.main) process.exit(await main());
