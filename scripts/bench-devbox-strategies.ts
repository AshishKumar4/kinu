#!/usr/bin/env bun
/**
 * Devbox storage strategies, measured against each other. Five arms, one per
 * `DevboxStrategyName`: `snapshot-chain`, `r2fs`, `overlay-cas`,
 * `bounded-layers` and `merkle-pack` (`FIXTURE_CLASS_BY_STRATEGY` below is the
 * list the driver actually dispatches).
 *
 * This is the decision the whole storage question turns on. The raw-layout
 * benchmark beside it (`scripts/bench-r2-workspace.ts`) answers "what does an R2
 * mount cost"; this answers "which strategy should a Devbox default to", by
 * driving the real product lifecycle — attach, checkpoint, stop, wake — through
 * `packages/devbox/bench`.
 *
 *   bun scripts/bench-devbox-strategies.ts --plan
 *
 * Five rules it inherits from the layout benchmark, each one bought with a
 * failed run:
 *
 *   LIFECYCLE PROOF FIRST, per arm. The normal short requests prove an attached
 *   durable workspace before timing workloads. An arm whose proof fails measured
 *   the container's own blank disk, and its numbers are refused rather than
 *   ranked.
 *
 *   ONE BOX PER ARM. `mountBucket` refuses a second mount of one binding at a
 *   different prefix or readOnly value, so arms cannot share an instance.
 *
 *   /ops/flush AT EVERY PHASE BOUNDARY. The tally batches in the proxy isolate;
 *   a settle-and-hope read undercounted PUTs by at least 590 on the layout
 *   benchmark's process path, while its teardown deleted the objects that proved
 *   it. A flush is a fact, a settle is a wish.
 *
 *   WAKE IS DEPLOYED-ONLY. After a stop, local workerd loses the container's
 *   networking sidecar and every later call hangs 30 s. A local wake number is
 *   not a slow measurement, it is not a measurement.
 *
 *   MINUTE-SCALE WORK RUNS AS A PROCESS. A blocking exec is bounded by a fixed
 *   platform ceiling no timeout option raises. The heavy groups are backgrounded
 *   and polled for a sentinel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, armSignalTeardown, containerAppIds, delay, deleteContainerApps,
  describeThrown, publishTeardown, runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import * as v from 'valibot';
import { AwsClient } from 'aws4fetch';
import { summarize, type Summary } from './fixtures/r2-bench/stats';
import { parseProbeRun, type ProbeRun } from './fixtures/r2-bench/report';
import {
  R2_CLASS_A_USD_PER_MILLION, R2_CLASS_B_USD_PER_MILLION, RULE_WORKLOADS, decide, opsAreBlind,
  sqliteFinding, totalsFor, type DecisionVerdict, type TickRecord,
} from './fixtures/r2-bench/decision';
import {
  R2_OP_VOCABULARY, cleanupEvidenceFromReport, evaluateRun, expectedCells, findCredentialLeaks,
  refusalText, requireAdmitted, type AccountingEvidence, type AdmissionVerdict, type ArmEvidence,
  type CellCompletion, type CleanupEvidence, type GateId, type RestoreClaim,
  type RestoreEvidence, type RunProvenance, type StorageRunRecord,
} from './fixtures/storage-matrix/admission';
import type { MeasuredCell, StageId } from './fixtures/storage-matrix/protocol';
import {
  checkCleanup, createManifest, recoverAbandonedRuns, replayTeardown, writeManifest,
  type CleanupProbes, type CleanupReport, type DeleteOutcome, type TeardownEntry,
  type TeardownManifest,
} from './fixtures/storage-matrix/cleanup';
import { parseJsonc } from './jsonc';
import { trackedFiles } from './sources';
/**
 * instrument now follows: a payload that disagreed with its contract used to
 * become a silent `undefined` and take a later segment down with it.
 */
/**
 * The chain's generation, as the fixture reports it.
 *
 * `base.id` is a fresh uuid after a rebase and `delta` goes absent, so comparing
 * this before and after the checkpoint ladder says DEFINITIVELY whether a rebase
 * fired there — rather than leaving it as a possibility a reader has to weigh.
 * `rev` is monotonic across both, which is what distinguishes a rebase from a
 * quiesce that wrote nothing.
 *
 * Absent for any arm that is not a chain, which is itself the point: overlay-cas
 * never rebases, so a chain that does is a structural difference between the two
 * that reproduces on every run with this ladder, not a coin flip between runs.
 */
interface ChainGeneration {
  readonly baseId: string | null;
  readonly hasDelta: boolean;
  readonly rev: number | null;
}

interface AttachOutcome { kind: string; detail: string }

interface StartupState {
  /** The box's own name for where its restoration stands. FIVE values, because
   *  two used to be conflated: `restoring` is an attempt IN FLIGHT (which
   *  `unstarted` used to be reported as, for its whole duration), and `repair`
   *  is attached-but-degraded (which `attached` used to be reported as). A
   *  driver that cannot tell those apart cannot attribute a ceiling. */
  restoration?: 'unstarted' | 'restoring' | 'attached' | 'repair' | 'unattached';
  /** Is the container up? A stopped container has NOTHING in flight for a
   * later poll to observe: `/state` re-arms a startup row and deliberately
   * never drives the restoration inline, while every real operation drives it
   * through `ensureReady()`. Declared because the driver reads it — an absent
   * field proves nothing and is treated as such. */
  running?: boolean;
  unready?: string;
  lastAttach?: AttachOutcome;
  /** The container generation that supplied this attach. The warm `/create`
   * probe must report the SAME id as the preceding wake; an `attached` kind
   * alone could describe a fresh restore that silently changed generations. */
  bootId?: string;
  chain?: {
    base?: { id?: string };
    delta?: unknown;
    mode?: string;
    rev?: number;
  } | null;
  /** What the box has already RECORDED about itself while a poll was calling
   *  it pending. A startup that keeps refusing admission files one of these per
   *  attempt, so a wait that ends with a non-zero count was never a wait: it was
   *  a box saying so in the one channel a driver can read. Measured on probe
   *  `wakeprobe09010650`, where a snapshot-chain box sat `running` and
   *  `unstarted` for its whole 300 s ceiling holding two undelivered
   *  incidents. */
  incidents?: { total?: number; undelivered?: number };
}

export interface StateReply {
  error?: string;
  extractionAllowed?: boolean;
  storePrefix?: string;
  state?: StartupState;
}

const StateReplySchema: v.GenericSchema<StateReply> = v.looseObject({
  error: v.optional(v.string()),
  extractionAllowed: v.optional(v.boolean()),
  storePrefix: v.optional(v.string()),
  state: v.optional(v.looseObject({
    restoration: v.optional(
      v.picklist(['unstarted', 'restoring', 'attached', 'repair', 'unattached']),
    ),
    running: v.optional(v.boolean()),
    unready: v.optional(v.string()),
    lastAttach: v.optional(v.looseObject({ kind: v.string(), detail: v.string() })),
    bootId: v.optional(v.string()),
    chain: v.optional(v.nullable(v.looseObject({
      base: v.optional(v.looseObject({ id: v.optional(v.string()) })),
      delta: v.optional(v.unknown()),
      mode: v.optional(v.string()),
      rev: v.optional(v.number()),
    }))),
    incidents: v.optional(v.looseObject({
      total: v.optional(v.number()),
      undelivered: v.optional(v.number()),
    })),
  })),
});

export type StartupPollVerdict =
  | { readonly kind: 'pending' }
  /** The container is DOWN and this generation never started a restoration:
   *  no scheduled work exists for a later poll to observe. */
  | { readonly kind: 'stopped'; readonly detail: string }
  | { readonly kind: 'attached'; readonly attach: AttachOutcome }
  /** Attached, and NAMING what did not come back. Its own verdict because an
   *  arm that reports this passed its attach and failed its restoration, and
   *  collapsing it into `attached` is how a box that publishes no working URL
   *  reads as a success. */
  | { readonly kind: 'repair'; readonly attach: AttachOutcome; readonly incomplete: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** The durable attach record belongs to a restoration only after that
 * restoration declares itself attached. This rejects the previous generation's
 * record while a fresh generation is still waiting for its scheduled callback.
 *
 * `pending` CLAIMS something is in flight, and there is exactly one reading
 * where that claim is false: a stopped container whose restoration is
 * `unstarted`. Nothing is running, nothing has started, and a `/state` poll
 * only re-arms a row it cannot execute — so every later reply is the same one,
 * which is the hour the startup redrive test records. That reading is
 * classified `stopped` so the driver can take it to the readiness boundary a
 * real operation goes through. A reply that does not report `running` proves
 * nothing about the container and stays `pending`. */
export function startupPollVerdict(reply: StateReply): StartupPollVerdict {
  const state = reply.state;
  if (state?.restoration === 'unattached') {
    return { kind: 'failed', reason: state.unready ?? 'the startup refused without a reason' };
  }
  if (state?.restoration === 'attached' && state.lastAttach !== undefined) {
    return { kind: 'attached', attach: state.lastAttach };
  }
  if (state?.restoration === 'repair' && state.lastAttach !== undefined) {
    return {
      kind: 'repair',
      attach: state.lastAttach,
      incomplete: state.unready ?? 'the box named no incompleteness',
    };
  }
  if (state?.running === false && state.restoration === 'unstarted') {
    return {
      kind: 'stopped',
      detail: state.unready ?? 'the container is stopped and no restoration has started for it',
    };
  }
  return { kind: 'pending' };
}

/**
 * The box's own reading, in the words a refusal has to carry.
 *
 * `pending` is a verdict about the DRIVER's knowledge, not about the box, and a
 * ceiling that reports only that is unattributable. The three fields below are
 * what separate the states a reader has to tell apart: a container the platform
 * never admitted, one that is up with a restoration nobody ran, and one that is
 * refusing. The incident count is the decisive one — a box that filed incidents
 * while a poll called it pending was never waiting, it was already failing, and
 * probe `wakeprobe09010650` spent its whole 300 s ceiling on exactly that
 * reading (`running` true, `unstarted`, two undelivered incidents).
 */
export function describeStartupState(reply: StateReply): string {
  const state = reply.state;
  if (state === undefined) return `no state in the reply${reply.error === undefined ? '' : `: ${reply.error}`}`;
  const incidents = state.incidents;
  return `running=${state.running === undefined ? 'unreported' : String(state.running)} `
    + `restoration=${state.restoration ?? 'unreported'}`
    + `${incidents?.total === undefined || incidents.total === 0
      ? ''
      : `, ${String(incidents.total)} incident(s) recorded (${String(incidents.undelivered ?? 0)} undelivered)`}`
    + `${state.unready === undefined ? '' : `, unready: ${state.unready}`}`;
}

async function chainGeneration(fixture: Fixture, box: string): Promise<ChainGeneration> {
  const reply = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
  const chain = reply.state?.chain ?? null;
  return {
    baseId: chain?.base?.id ?? null,
    hasDelta: chain?.delta !== undefined && chain?.delta !== null,
    rev: chain?.rev ?? null,
  };
}

interface DecisiveRun {
  readonly workload?: string;
  readonly segments?: readonly { readonly name: string; readonly bytesWritten: number; readonly pathsTouched: number; readonly wallMs: number }[];
  readonly treeBytes?: number;
  readonly error?: string;
}

const DecisiveRunSchema: v.GenericSchema<DecisiveRun> = v.looseObject({
  workload: v.optional(v.string()),
  segments: v.optional(v.array(v.looseObject({
    name: v.string(),
    bytesWritten: v.number(),
    pathsTouched: v.number(),
    wallMs: v.number(),
  }))),
  treeBytes: v.optional(v.number()),
  error: v.optional(v.string()),
});

function parseDecisiveRun(text: string, source: string): DecisiveRun {
  const parsed = v.safeParse(DecisiveRunSchema, JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${source} printed a payload that is not a decisive run: `
      + `${parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ')}`
      + ` — body: ${text.slice(0, 300)}`,
    );
  }
  return parsed.output;
}

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const BENCH_DIR = join(REPO_ROOT, 'packages/devbox/bench');
/** The account every devbox fixture is raised on. Exported so the deployed
 *  lifecycle suite names the same account rather than declaring a second copy
 *  of it — `gate:policy-drift`'s subject exactly. */
export const BENCH_ACCOUNT_ID = 'f44999d1ddda7012e9a87729eba250f1';
const FIXTURE_BASE = 'kinu-devbox-bench';
const FIXTURE_CLASS_BY_STRATEGY = {
  'snapshot-chain': 'SnapshotChainBox',
  r2fs: 'R2fsBox',
  'overlay-cas': 'OverlayCasBox',
  'bounded-layers': 'BoundedLayersBox',
  'merkle-pack': 'MerklePackBox',
} as const satisfies Record<Strategy, string>;
const FIXTURE_COUNTER_CLASS = 'BenchOpCounter';
/**
 * The container classes whose image is the candidate Dockerfile build.
 *
 * `OverlayCasBox` belongs here because `CAS_RUNNER_PATH`
 * (`packages/devbox/src/overlay-cas.ts`) resolves its runner at
 * `/opt/kinu/overlay-cas-runner.bundle.mjs`, and that path exists ONLY inside
 * this image — `candidateImageDockerfile` copies the bundle into it. Left out,
 * the arm ran on the plain sandbox image and every cold attach refused with
 * `Module not found "/opt/kinu/overlay-cas-runner.bundle.mjs"`: measured on the
 * 2026-08-29 01:26 and 02:42 runs, and the reason the 2026-08-26 overlay-cas
 * artifact was REFUSED. The image is built once per run regardless of which
 * arms selected it, so naming a class here costs nothing it did not already pay.
 */
export const CANDIDATE_CONTAINER_CLASSES: ReadonlySet<string> = new Set([
  'OverlayCasBox',
  'BoundedLayersBox',
  'MerklePackBox',
]);

export interface FixtureNames {
  readonly worker: string;
  readonly bucket: string;
  readonly containerApps: readonly string[];
}

/**
 * The digest of every input the candidate container image is built from.
 *
 * Recorded because these are what the arms actually RAN. A rebuilt runner
 * bundle or a changed daemon source produces different numbers from the same
 * commit, and a provenance row naming only the commit cannot tell the two runs
 * apart.
 */
interface FixtureImageDigests {
  readonly imageSha256: string;
  readonly dockerfileSha256: string;
  readonly candidateRunnerSha256: string;
  readonly overlayRunnerSha256: string;
  readonly journalDaemonSha256: string;
}

/**
 * One arm's own deployment: the Worker that serves it, the bucket it writes to,
 * the container application its class raises, and the generated config that
 * names all three. Nothing in here is shared with another arm.
 */
export interface ArmFixture extends FixtureNames {
  readonly strategy: Strategy;
  readonly configPath: string;
  /** The exact per-arm Wrangler config, retained while teardown owns its directory. */
  readonly config: string;
}

/**
 * Every arm's deployment, plus the one directory they were generated from.
 *
 * The runner bundles and the candidate Dockerfile are built ONCE and shared as
 * bytes by every arm's config: the image is the same image, so building it per
 * arm would add a container build to every deploy and change nothing about
 * what ran. The digests below are therefore the digests of every arm.
 */
export interface FixtureResources {
  readonly arms: readonly ArmFixture[];
  /** The teardown manifest for this run, written to disk before the first of
   *  these resources was created. Carried here so no caller can deploy a
   *  fixture whose resources nothing durable has recorded. */
  readonly manifest: TeardownManifest;
  readonly digests: FixtureImageDigests;
  readonly configDir: string;
  disposeConfig(): void;
}

const FixtureConfigSchema = v.looseObject({
  durable_objects: v.looseObject({
    bindings: v.array(v.looseObject({ class_name: v.string() })),
  }),
  migrations: v.array(v.looseObject({
    new_sqlite_classes: v.array(v.string()),
  })),
  containers: v.array(v.looseObject({
    class_name: v.string(),
    image: v.string(),
  })),
  r2_buckets: v.array(v.looseObject({
    bucket_name: v.string(),
  })),
  vars: v.optional(v.record(v.string(), v.string())),
});

function fixtureClasses(arms: readonly Strategy[]): readonly string[] {
  return arms.map((arm) => FIXTURE_CLASS_BY_STRATEGY[arm]);
}

/**
 * One arm's resource names — PER ARM, and the arm is in every one of them.
 *
 * WHY NOT PER RUN, WHICH IS WHAT THIS WAS. The arms are measured concurrently.
 * Two arms sharing a bucket would share a keyspace, a residue account and a
 * `/teardown` purge — which empties the WHOLE bucket, `prefix: ''`,
 * `whole: true` — so the first arm to finish would drain the store out from
 * under every arm still measuring. Two arms sharing a Worker would share its
 * `BenchOpCounter`, whose tally one arm's `/ops/reset` zeroes, so the priced
 * operation column of a concurrent sibling would be whatever was left after
 * somebody else's reset. One Worker and one bucket per arm removes both, and
 * leaves teardown able to delete one arm's complete deployed set on its own.
 */
export function resourceNames(runId: string, arm: Strategy): FixtureNames {
  const worker = `${FIXTURE_BASE}-${runId}-${arm}`;
  return {
    worker,
    bucket: worker,
    containerApps: [`${worker}-${FIXTURE_CLASS_BY_STRATEGY[arm].toLowerCase()}`],
  };
}

/**
 * The box one arm measures in, named once.
 *
 * The formula was written out five times in this file, and the teardown
 * manifest names the box as a durable-state resource, so a sixth copy in the
 * manifest builder would be a copy that can drift from the box the run
 * actually raised — a manifest naming durable state nobody created, and real
 * durable state nobody deletes.
 */
export function boxName(runId: string, arm: Strategy): string {
  return `ab-${arm}-${runId}`;
}

/**
 * The candidate image: the stock sandbox plus the two runner bundles and the
 * mutation-journal daemon the candidate arms capture through.
 *
 * The daemon's build recipe is not restated here. It is the daemon's own
 * Dockerfile, re-used verbatim as a builder stage, so a change to libfuse or to
 * the compile flags cannot leave the benchmark image building a different
 * binary from the one its tests prove. Only the runtime libraries the compiled
 * daemon links against travel to the final stage; the toolchain does not.
 */
function candidateImageDockerfile(): string {
  const recipe = readFileSync(JOURNAL_DAEMON_DOCKERFILE, 'utf8');
  // The checked-in daemon recipe deliberately stays readable as the versioned
  // tag humans recognize. The GENERATED benchmark image does not: a tag is a
  // mutable pointer, so the build starts from the manifest digest it resolved
  // to before this staging run. Reusing the recipe after its one FROM line
  // keeps libfuse flags and package steps owned by the daemon Dockerfile.
  const recipeBase = `FROM ${SANDBOX_IMAGE_TAG}\n`;
  const pinnedBase = `FROM ${SANDBOX_IMAGE}\n`;
  if (!recipe.startsWith(recipeBase)) {
    throw new Error(
      `journal daemon Dockerfile must start with ${recipeBase.trim()} to be re-used as a builder stage`,
    );
  }
  return `${pinnedBase.trimEnd()} AS journal-daemon\n${recipe.slice(recipeBase.length)}\n`
    + `FROM ${SANDBOX_IMAGE}\n`
    + 'COPY --from=journal-daemon /usr/local/bin/kinu-journal-daemon /usr/local/bin/kinu-journal-daemon\n'
    + 'COPY --from=journal-daemon /usr/local/lib /usr/local/lib\n'
    + 'RUN ldconfig\n'
    + 'COPY candidate-runner.bundle.mjs /opt/kinu/candidate-runner.bundle.mjs\n'
    + 'COPY overlay-cas-runner.bundle.mjs /opt/kinu/overlay-cas-runner.bundle.mjs\n';
}

/** One Worker, only the selected Durable Object classes, their container-app
 * set and the one bucket that Worker binds. Nothing is shared with another arm
 * or with an earlier run, and teardown can delete the complete deployed set. */
export function fixtureConfigForArms(
  template: string,
  names: FixtureNames,
  arms: readonly Strategy[],
  dockerfilePath: string,
): string {
  const config = parseJsonc(template, FixtureConfigSchema, 'benchmark config');
  const deployedClasses = [...fixtureClasses(arms), FIXTURE_COUNTER_CLASS];
  const matchingBuckets = config.r2_buckets.filter((bucket) => bucket.bucket_name === 'kinu-devbox-bench');
  if (matchingBuckets.length !== 1) {
    throw new Error('benchmark config must bind exactly one kinu-devbox-bench bucket');
  }
  return `${JSON.stringify({
    ...config,
    $schema: join(REPO_ROOT, 'node_modules/wrangler/config-schema.json'),
    name: names.worker,
    vars: { ...config.vars, BENCH_SELECTED_ARMS: arms.join(',') },
    main: join(BENCH_DIR, 'worker.ts'),
    durable_objects: {
      ...config.durable_objects,
      bindings: config.durable_objects.bindings.filter((binding) => deployedClasses.includes(binding.class_name)),
    },
    migrations: config.migrations
      .map((migration) => ({
        ...migration,
        new_sqlite_classes: migration.new_sqlite_classes.filter((className) => deployedClasses.includes(className)),
      }))
      .filter((migration) => migration.new_sqlite_classes.length > 0),
    containers: config.containers
      .filter((container) => deployedClasses.includes(container.class_name))
      .map((container) => CANDIDATE_CONTAINER_CLASSES.has(container.class_name)
        ? { ...container, image: dockerfilePath }
        : { ...container, image: SANDBOX_IMAGE }),
    r2_buckets: config.r2_buckets.map((bucket) => bucket.bucket_name === 'kinu-devbox-bench'
      ? { ...bucket, bucket_name: names.bucket }
      : bucket),
  }, null, 2)}\n`;
}

/**
 * Plan every resource this run will own, BEFORE any of them exists.
 *
 * Derived entirely from `runId` and the arms, which is what makes it possible
 * to write it first: nothing here needs a resource to have been created in
 * order to be named. ONE COMPLETE SET PER ARM, so an interrupted run deletes
 * each arm's Worker, container application and bucket on its own evidence
 * rather than as one shared lump.
 */
export function plannedTeardownManifest(
  runId: string,
  arms: readonly Strategy[],
  configDir: string,
): TeardownManifest {
  return createManifest(runId, [
    ...arms.flatMap((strategy) => {
      const names = resourceNames(runId, strategy);
      const box = boxName(runId, strategy);
      return [
        { kind: 'worker' as const, name: names.worker, detail: `${strategy} fixture Worker` },
        ...names.containerApps.map((name) => ({
          kind: 'container-app' as const, name, detail: `${strategy} container application`,
        })),
        { kind: 'r2-bucket' as const, name: names.bucket, detail: `dedicated ${strategy} bucket` },
        { kind: 'do-state' as const, name: box, detail: 'per-arm durable box state' },
        { kind: 'alarm' as const, name: box, detail: 'per-arm durable alarm' },
        { kind: 'mount' as const, name: box, detail: 'per-arm mounted workspace' },
      ];
    }),
    { kind: 'local-path', name: configDir, detail: 'generated Wrangler config directory' },
  ]);
}

export async function createFixtureResources(
  runId: string,
  arms: readonly Strategy[],
): Promise<FixtureResources> {
  // THE MANIFEST IS THE FIRST THING THAT EXISTS, before the config directory
  // and long before a deploy.
  //
  // WHAT THIS FIXES. The manifest used to be built by `main` from the fixtures
  // this function returns, so the window between "resources are named" and
  // "the list of them is durable" spanned two bundle builds, a Dockerfile
  // render and every per-arm config write. A driver killed inside that window
  // — or one that threw out of a failed bundle — left a temp directory and a
  // run id with no record anywhere that either had ever been planned.
  //
  // The build directory is DERIVED from the run id rather than `mkdtemp`'s
  // random suffix, because a name nobody can predict cannot be written down
  // before it is created, and an unnamed directory is one the next driver
  // cannot sweep.
  const dir = join(tmpdir(), `kinu-devbox-bench-${runId}`);
  const manifest = plannedTeardownManifest(runId, arms, dir);
  writeManifest(REPO_ROOT, manifest);
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, 'candidate-runner.bundle.mjs');
  const overlayBundlePath = join(dir, 'overlay-cas-runner.bundle.mjs');
  const dockerfilePath = join(dir, 'candidate-runner.Dockerfile');
  const [candidateBuilt, overlayBuilt] = await Promise.all([
    Bun.build({ entrypoints: [CANDIDATE_RUNNER_SOURCE], format: 'esm', target: 'bun' }),
    Bun.build({ entrypoints: [OVERLAY_RUNNER_SOURCE], format: 'esm', target: 'bun' }),
  ]);
  if (!candidateBuilt.success || !overlayBuilt.success) {
    rmSync(dir, { recursive: true, force: true });
    const logs = [...candidateBuilt.logs, ...overlayBuilt.logs].map((entry) => entry.message).join('; ');
    throw new Error(`candidate image bundle failed: ${logs}`);
  }
  const candidateBundle = candidateBuilt.outputs[0];
  const overlayBundle = overlayBuilt.outputs[0];
  if (candidateBundle === undefined || overlayBundle === undefined) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('candidate image bundle produced no output');
  }
  await Promise.all([
    Bun.write(bundlePath, candidateBundle),
    Bun.write(overlayBundlePath, overlayBundle),
  ]);
  copyFileSync(JOURNAL_DAEMON_SOURCE, join(dir, 'journal-daemon.c'));
  const dockerfile = candidateImageDockerfile();
  writeFileSync(dockerfilePath, dockerfile);
  const template = readFileSync(join(BENCH_DIR, 'wrangler.jsonc'), 'utf8');
  // ONE CONFIG PER ARM, all in the one build directory: each names its own
  // Worker, binds its own bucket and deploys only its own class, and all of
  // them point at the same generated Dockerfile so the image is built once.
  const armFixtures = arms.map((strategy): ArmFixture => {
    const names = resourceNames(runId, strategy);
    const configPath = join(dir, `wrangler-${strategy}.jsonc`);
    const config = fixtureConfigForArms(template, names, [strategy], dockerfilePath);
    writeFileSync(configPath, config);
    return { ...names, strategy, configPath, config };
  });
  // DIGESTED FROM THE BYTES THAT WERE WRITTEN, not from the sources they came
  // from: the bundles are built here, so only these bytes describe what the
  // containers will actually load.
  const digest = (bytes: string | Uint8Array): string =>
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    arms: armFixtures,
    manifest,
    configDir: dir,
    digests: {
      imageSha256: SANDBOX_IMAGE_DIGEST,
      dockerfileSha256: digest(dockerfile),
      candidateRunnerSha256: digest(new Uint8Array(await Bun.file(bundlePath).arrayBuffer())),
      overlayRunnerSha256: digest(new Uint8Array(await Bun.file(overlayBundlePath).arrayBuffer())),
      journalDaemonSha256: digest(readFileSync(JOURNAL_DAEMON_SOURCE, 'utf8')),
    },
    disposeConfig: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}
const HARNESS = '/workspace/.devbox-bench';
const CANDIDATE_RUNNER_SOURCE = join(REPO_ROOT, 'packages/devbox/bench/candidate-runner.ts');
const OVERLAY_RUNNER_SOURCE = join(REPO_ROOT, 'packages/devbox/src/cas/overlay-runner.ts');
const PROBE_FILES = ['stats.ts', 'probe.ts', 'decisive.ts'] as const;
const JOURNAL_DAEMON_DIR = join(REPO_ROOT, 'packages/devbox/bench/journal-daemon');
const JOURNAL_DAEMON_SOURCE = join(JOURNAL_DAEMON_DIR, 'journal-daemon.c');
const JOURNAL_DAEMON_DOCKERFILE = join(JOURNAL_DAEMON_DIR, 'Dockerfile');
/** The mutable version tag written in the checked-in daemon recipe. */
const SANDBOX_IMAGE_TAG = 'docker.io/cloudflare/sandbox:0.12.8';
/** The manifest digest that tag resolved to on 2026-08-27. */
export const SANDBOX_IMAGE_DIGEST = 'sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f';
/** Every generated fixture config and generated candidate Dockerfile uses this
 * immutable reference, so the image provenance row identifies the bytes that
 * ran rather than a tag another publisher can repoint. */
export const SANDBOX_IMAGE = `docker.io/cloudflare/sandbox@${SANDBOX_IMAGE_DIGEST}`;
/**
 * The decisive experiment's arms, from the adopted research spec.
 *
 * `npm` runs TWICE — with and without the excludes policy — because excludes are
 * the one lever that changes the changed-set without changing the work, so the
 * pair isolates what the policy is worth. `git` is the arm the 10x bar is set
 * on; `sqlite` decides a separate question and never the default.
 */
const DECISIVE_WORKLOADS = [
  { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
  { id: 'npm-excluded', workload: 'npm', excludes: true, args: '--target-mib 400 --segments 4' },
  { id: 'git', workload: 'git', excludes: false, args: '--files 2000 --commits 200 --touch-percent 5 --segments 4' },
  { id: 'sqlite', workload: 'sqlite', excludes: false, args: '--size-mib 64 --segments 4' },
] as const;

/** Segments per decisive workload. Index 0 seeds; 1..N are the incremental ones
 *  the experiment actually measures. */
const SEGMENTS_PER_WORKLOAD = 4;

/**
 * How long to wait before a tick so the strategy's minimum-interval guard does
 * not suppress it. Measured, not chosen: without this every tick after the first
 * answered `skipped (within the minimum checkpoint interval)`. Read from the
 * bench fixture's OWN policy override rather than from the shipped default: the
 * fixture sets `checkpointIntervalMs: 2_000`, so the guard needs three seconds,
 * and reading the shipped 5-minute value would idle this driver a hundredfold
 * longer than the guard requires.
 */
const MIN_CHECKPOINT_INTERVAL_MS = 3_000;

/**
 * Groups a blocking exec cannot reach; backgrounded and polled instead.
 *
 * `archive` earns its place by measurement, not by size: on an R2-backed plane
 * every read it makes crosses the object store, so its duration tracks remote
 * latency rather than the tree. It completed inside one request on the
 * 2026-08-29 01:26 run and exceeded the 180 s call deadline twice on the
 * 02:28 run over the same tree — a phase whose cost is set by a remote service
 * cannot be held open in a single request, whatever the deadline is set to.
 */
const PROCESS_PHASES = new Set<string>([
  'npmlike', 'gitlike', 'small1k', 'small10k', 'seq100', 'archive',
]);
const PHASES = ['posix', 'seq1', 'seq10', 'rand', 'archive', 'small1k', 'npmlike'] as const;
/** Change sizes for the checkpoint ladder, in KiB of freshly written bytes. */
const CHANGE_SIZES_KIB = [64, 4_096, 65_536] as const;
const POLL_MS = 10_000;
const PROCESS_DEADLINE_MS = 1_500_000;

/**
 * The arms. `overlay-cas` is the promoted form of the overlay/sync concept that
 * the layout benchmark measured as the shape worth keeping: writes land on the
 * container disk and R2 receives content-addressed state, rather than every
 * write traversing FUSE.
 *
 * Every arm is measured by the same driver against the same workloads and the
 * same routes. Nothing below this line knows which arm it is running, which is
 * what makes a five-way comparison the same experiment as a two-way one.
 */
export type Strategy = 'snapshot-chain' | 'r2fs' | 'overlay-cas' | 'bounded-layers' | 'merkle-pack';
export const STRATEGIES: readonly Strategy[] = [
  'snapshot-chain',
  'r2fs',
  'overlay-cas',
  'bounded-layers',
  'merkle-pack',
];

/**
 * The arm production actually runs, and therefore the one every other strategy
 * has to beat in order to replace it.
 *
 * THE TAXONOMY THIS REPLACES. The instrument used to split the arms into
 * `CANDIDATE_STRATEGIES = {bounded-layers, merkle-pack}` and
 * `CONTROL_STRATEGIES = {snapshot-chain, r2fs, overlay-cas}`, and only a
 * candidate could be ranked: `devboxArmEvidence` marked the other three
 * rank-INELIGIBLE, and the decision pairs did not contain `r2fs` at all. A
 * shipped arm that beat both candidates on every workload therefore could not
 * be reported as the winner, and one arm could not be compared at all. That is
 * a conclusion written into the instrument rather than measured by it.
 *
 * The ruling this encodes instead: every strategy competes against the
 * incumbent, on the same admission gates and the same decisive workloads. A
 * strategy's preregistered defects are MEASURED COSTS carried beside its
 * numbers (see `PREREGISTERED_WITNESSES`), never a filter that removes it from
 * the ranking before its numbers are read.
 */
export const INCUMBENT = 'snapshot-chain' as const satisfies Strategy;

/** Every arm that must beat the incumbent to become the default. DERIVED from
 *  `STRATEGIES`, so an arm added above competes without this line being
 *  edited — a stale copy here is how `r2fs` came to be uncomparable. */
export const CHALLENGERS: readonly Strategy[] = STRATEGIES.filter((arm) => arm !== INCUMBENT);
const NonEmptyString = v.pipe(v.string(), v.minLength(1));

interface FrozenControlArtifact {
  readonly meta: {
    readonly date: string;
    readonly worker?: string;
    readonly bucket?: string;
    readonly image: string;
    readonly seed: string;
    readonly 'loop budget ms': string;
  };
  readonly arms: readonly {
    readonly strategy: string;
    readonly verifyPassed: boolean;
    /** The per-check lifecycle rows. Absent in every artifact written before
     *  this instrument recorded them. */
    readonly verifyChecks?: readonly { readonly name: string; readonly pass: boolean }[];
    /** The arm's own `/ops` tally. Absent, or present with no total, in an
     *  artifact whose run never reconciled its accounting. */
    readonly ops?: { readonly total?: number } | null;
  }[];
  /** The C1–C7 cleanup evidence the run wrote. An admission boolean alone
   * cannot reconstruct this: a frozen artifact must carry the raw cleanup
   * contract the current instrument evaluates. */
  readonly cleanup?: {
    readonly attempted?: boolean;
    readonly kept?: boolean;
    readonly workerAbsent?: boolean;
    readonly runtimeAbsent?: boolean;
    readonly bucketAndMultipartEmpty?: boolean;
    readonly boxDurableStateEmpty?: boolean;
    readonly localSecretsProcessesAbsent?: boolean;
    readonly countersReconciled?: boolean;
    readonly replayIdempotent?: boolean;
    readonly multipartResidue?: number;
    readonly errors?: readonly string[];
  };
  /** The G0–G9 decision the run took. Absent in every pre-admission artifact. */
  readonly admission?: { readonly admitted: boolean };
}

const FrozenControlArtifactSchema: v.GenericSchema<FrozenControlArtifact> = v.looseObject({
  meta: v.looseObject({
    date: v.pipe(NonEmptyString, v.regex(/^\d{4}-\d{2}-\d{2}$/)),
    worker: v.optional(NonEmptyString),
    bucket: v.optional(NonEmptyString),
    image: NonEmptyString,
    seed: NonEmptyString,
    'loop budget ms': NonEmptyString,
  }),
  arms: v.array(v.looseObject({
    strategy: NonEmptyString,
    verifyPassed: v.boolean(),
    verifyChecks: v.optional(v.array(v.looseObject({
      name: NonEmptyString,
      pass: v.boolean(),
    }))),
    ops: v.optional(v.nullable(v.looseObject({ total: v.optional(v.number()) }))),
  })),
  cleanup: v.optional(v.looseObject({
    attempted: v.optional(v.boolean()),
    kept: v.optional(v.boolean()),
    workerAbsent: v.optional(v.boolean()),
    runtimeAbsent: v.optional(v.boolean()),
    bucketAndMultipartEmpty: v.optional(v.boolean()),
    boxDurableStateEmpty: v.optional(v.boolean()),
    localSecretsProcessesAbsent: v.optional(v.boolean()),
    countersReconciled: v.optional(v.boolean()),
    replayIdempotent: v.optional(v.boolean()),
    multipartResidue: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
  })),
  admission: v.optional(v.looseObject({ admitted: v.boolean() })),
});

/**
 * What a supplied control artifact PROVES, which is not what its
 * `verifyPassed` boolean says.
 *
 * MEASURED DEFECT THIS REPAIRS. The status column read
 * `control.verifyPassed ? 'VERIFIED' : '**REFUSED**'`, so any artifact
 * carrying `verifyPassed: true` for the named arm printed as VERIFIED —
 * including the 2026-08-26 artifacts, whose runs had no per-check lifecycle
 * rows, no per-arm operation tally and no G0–G9 admission decision at all.
 * That boolean was set by an instrument that did not test what this one tests,
 * and printing VERIFIED beside it launders a legacy pass into current
 * evidence.
 *
 * `legacy-contract` is therefore its own status and NEVER a pass: a missing
 * contract cannot be satisfied retroactively, and no shim maps it onto
 * VERIFIED.
 */
export type FrozenControlStatus = 'verified' | 'refused' | 'legacy-contract';

export const FROZEN_CONTROL_LABEL = {
  verified: 'VERIFIED',
  refused: '**REFUSED**',
  'legacy-contract': '**UNUSABLE (legacy contract)**',
} as const satisfies Record<FrozenControlStatus, string>;

export interface FrozenControl {
  readonly strategy: Strategy;
  readonly artifact: string;
  readonly sha256: string;
  readonly date: string;
  readonly worker?: string;
  readonly bucket?: string;
  readonly image: string;
  readonly seed: string;
  readonly budgetMs: string;
  readonly verifyPassed: boolean;
  readonly status: FrozenControlStatus;
  /** Why the status is what it is, printed beside it. */
  readonly statusDetail: string;
}

/** The status a frozen control artifact earned from the evidence it carries. */
export interface FrozenControlJudgement {
  readonly status: FrozenControlStatus;
  readonly statusDetail: string;
}

export function frozenControlStatus(
  arm: FrozenControlArtifact['arms'][number],
  cleanup: FrozenControlArtifact['cleanup'],
  admission: FrozenControlArtifact['admission'],
): FrozenControlJudgement {
  const missing: string[] = [];
  if (arm.verifyChecks === undefined || arm.verifyChecks.length === 0) {
    missing.push('per-check lifecycle rows');
  }
  if (arm.ops === undefined || arm.ops === null || arm.ops.total === undefined) {
    missing.push('a per-arm operation tally');
  }
  const cleanupComplete = cleanup !== undefined
    && cleanup.attempted !== undefined
    && cleanup.kept !== undefined
    && cleanup.workerAbsent !== undefined
    && cleanup.runtimeAbsent !== undefined
    && cleanup.bucketAndMultipartEmpty !== undefined
    && cleanup.boxDurableStateEmpty !== undefined
    && cleanup.localSecretsProcessesAbsent !== undefined
    && cleanup.countersReconciled !== undefined
    && cleanup.replayIdempotent !== undefined
    && cleanup.multipartResidue !== undefined
    && cleanup.errors !== undefined;
  if (!cleanupComplete) missing.push('the complete C1–C7 cleanup evidence');
  if (admission === undefined) missing.push('a G0–G9 admission decision');
  if (missing.length > 0) {
    return {
      status: 'legacy-contract',
      statusDetail: `predates the current contract: it carries no ${missing.join(', no ')}`,
    };
  }
  const failed = (arm.verifyChecks ?? []).filter((check) => !check.pass).map((check) => check.name);
  if (!arm.verifyPassed || failed.length > 0) {
    return {
      status: 'refused',
      statusDetail: failed.length > 0
        ? `its lifecycle proof failed: ${failed.slice(0, 3).join(', ')}`
        : 'its run recorded a failed lifecycle proof',
    };
  }
  if (
    cleanup?.attempted !== true
    || cleanup.kept !== false
    || cleanup.workerAbsent !== true
    || cleanup.runtimeAbsent !== true
    || cleanup.bucketAndMultipartEmpty !== true
    || cleanup.boxDurableStateEmpty !== true
    || cleanup.localSecretsProcessesAbsent !== true
    || cleanup.countersReconciled !== true
    || cleanup.replayIdempotent !== true
    || cleanup.multipartResidue !== 0
    || (cleanup.errors?.length ?? 0) !== 0
  ) {
    return { status: 'refused', statusDetail: 'its C1–C7 cleanup contract did not complete cleanly' };
  }
  if (admission?.admitted !== true) {
    return { status: 'refused', statusDetail: 'its run was not admitted by its own G0–G9 gates' };
  }
  return {
    status: 'verified',
    statusDetail: 'lifecycle, accounting, cleanup and admission all present and passing',
  };
}

/** Decode one supplied historical artifact as context. The source artifact
 * establishes the provenance and digest recorded in the new report. ANY
 * strategy may be supplied frozen: "frozen" describes where the numbers came
 * from — a previous run, not this one — and never which arms may win. */
export function parseFrozenControlArtifact(
  strategy: Strategy,
  path: string,
  text: string,
): FrozenControl {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `control artifact ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = v.safeParse(FrozenControlArtifactSchema, decoded);
  if (!parsed.success) {
    throw new Error(
      `control artifact ${path} does not match the control contract: ${issueText(parsed.issues)}`,
    );
  }
  const arms = parsed.output.arms.filter((arm) => arm.strategy === strategy);
  if (arms.length !== 1) {
    throw new Error(
      `control artifact ${path} must contain exactly one requested ${strategy} arm; found ${arms.length}`,
    );
  }
  const arm = arms[0]!;
  const judged = frozenControlStatus(arm, parsed.output.cleanup, parsed.output.admission);
  return {
    strategy,
    artifact: path,
    sha256: createHash('sha256').update(text).digest('hex'),
    date: parsed.output.meta.date,
    worker: parsed.output.meta.worker,
    bucket: parsed.output.meta.bucket,
    image: parsed.output.meta.image,
    seed: parsed.output.meta.seed,
    budgetMs: parsed.output.meta['loop budget ms'],
    verifyPassed: arm.verifyPassed,
    status: judged.status,
    statusDetail: judged.statusDetail,
  };
}

export interface ControlOption {
  readonly strategy: Strategy;
  readonly path: string;
}

function frozenControlArtifacts(controls: readonly ControlOption[]): readonly FrozenControl[] {
  return controls.map(({ strategy, path }) =>
    parseFrozenControlArtifact(strategy, path, readFileSync(path, 'utf8')));
}

export interface Options {
  seed: number;
  budgetMs: number;
  /** Run the decisive experiment's three workloads and apply its decision rule.
   *  Off by default because it writes hundreds of megabytes per arm. */
  decisive: boolean;
  /** Run durability verification and cleanup, without performance workloads. */
  verifyOnly: boolean;
  plan: boolean;
  /** Schema-validated historical context from previous runs. These paths never
   *  affect current-arm ranking. */
  controls: readonly ControlOption[];
  /** Arms to run, from `--arms a,b`. Defaults to all five; an unknown name
   *  refuses rather than measuring an empty run. */
  arms: readonly Strategy[];
  /** Leave every external resource in place for inspection. Deliberate, but
   *  it means cleanup did not complete, so the run cannot recommend. */
  keep: boolean;
  /**
   * How many times each DECIDING cell is measured per arm.
   *
   * A deciding cell is the decisive workloads and the phase that carries
   * {@link DECIDING_METRIC}; G9 scores the dispersion of those repetitions and
   * censors a cell that has fewer than two, so a run with one measured nothing
   * a statistical claim can rest on. Two under `--decisive`, one otherwise —
   * an ordinary run is a smoke check and pays for no repetition it will not
   * use — and never less than one.
   */
  repetitions: number;
  /** Unique Durable Object suffix. A Worker redeploy does not delete DO
   * storage, so fixed box names contaminate a later run with prior state. */
  runId: string;
  out: string;
}

/**
 * The arm whose pipeline the current async context belongs to.
 *
 * WHY A CONTEXT RATHER THAN A LOGGER PARAMETER. Every arm writes to one stderr
 * and the arms now run at once, so a line without its arm on it belongs to
 * nobody. Most of those lines come from the shared transport — `call`'s
 * transport-loss retry, `pollForAttach`'s state poll, `awaitArmedOperation`'s
 * outcome poll, `runPhase`'s harness reinstall — none of which take an arm and
 * none of which should. Threading a logger through those fifteen signatures
 * would attribute the call sites somebody remembered to change and silently
 * lose the rest, which is the exact failure this exists to prevent.
 */
const armLogContext = new AsyncLocalStorage<Strategy>();

/** How much of an arm's own log a durable artifact carries. Bounded, because
 *  the artifact is a diagnosis aid, not a log archive: the last lines before a
 *  wedge are the ones that name it, and everything before them is noise a
 *  reader would page past anyway. */
const ARM_LOG_TAIL_LINES = 80;

const armLogTails = new Map<Strategy, string[]>();

const log = (message: string): void => {
  const arm = armLogContext.getStore();
  process.stderr.write(`[devbox-bench${arm === undefined ? '' : `:${arm}`}] ${message}\n`);
  if (arm === undefined) return;
  const tail = armLogTails.get(arm) ?? [];
  tail.push(message);
  if (tail.length > ARM_LOG_TAIL_LINES) tail.splice(0, tail.length - ARM_LOG_TAIL_LINES);
  armLogTails.set(arm, tail);
};

/** This arm's own log tail, as a durable artifact records it. */
export const armLogTail = (arm: Strategy): readonly string[] => [...(armLogTails.get(arm) ?? [])];

/** Everything the driver said about every arm, reset for the next run. */
export const resetArmLogs = (): void => { armLogTails.clear(); };

/** Run `work` in one arm's log context, so everything the shared transport says
 *  inside it is attributed — and mirrored — to that arm. Exported because the
 *  lifecycle suite drives arms through its own lanes rather than through
 *  `runArmsInFlight`, and an arm whose lines nobody attributes has no tail for
 *  its durable artifact to carry. */
export function underArmLog<T>(arm: Strategy, work: () => T): T {
  return armLogContext.run(arm, work);
}


/** Valibot's own field-level words for a payload that missed its contract. What
 *  the fixture sent is the only authority on what is wrong with it. */
const issueText = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ');

armSignalTeardown(log);

const wrangler = (args: readonly string[], options: { allowFailure?: boolean } = {}): string =>
  runWrangler(REPO_ROOT, args, options);

/**
 * The R2 residue plane an interrupted run leaves: ordinary objects written
 * before an arm's prefix drain ran, and open multipart uploads. The uploads
 * are invisible to `bucket info` and to the REST object list — S3
 * ListMultipartUploads is the ONE window — and either residue class blocks
 * `bucket delete` (error 10008; measured 2026-08-31, twice, after aborted
 * runs left 22 open uploads behind an "empty" listing).
 */
export interface R2ResiduePlane {
  listObjects(bucket: string): Promise<readonly string[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  listUploads(bucket: string): Promise<readonly { key: string; uploadId: string }[]>;
  abortUpload(bucket: string, key: string, uploadId: string): Promise<void>;
  /** Whether the bucket exists at all — S3 answers NoSuchBucket distinctly. */
  bucketExists(bucket: string): Promise<boolean>;
}


export function r2ResiduePlane(deps: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}): R2ResiduePlane {
  const client = new AwsClient({
    accessKeyId: deps.accessKeyId, secretAccessKey: deps.secretAccessKey, service: 's3', region: 'auto',
  });
  const origin = `https://${deps.accountId}.r2.cloudflarestorage.com`;
  const ask = async (path: string, method = 'GET'): Promise<{ status: number; body: string }> => {
    const answer = await client.fetch(`${origin}${path}`, { method });
    return { status: answer.status, body: await answer.text() };
  };
  const missing = (status: number, body: string): boolean =>
    status === 404 && body.includes('NoSuchBucket');
  return {
    bucketExists: async (bucket) => {
      const { status, body } = await ask(`/${bucket}?list-type=2&max-keys=1`);
      if (missing(status, body)) return false;
      if (status !== 200) throw new Error(`ListObjectsV2 on ${bucket} answered ${String(status)}`);
      return true;
    },
    listObjects: async (bucket) => {
      const keys: string[] = [];
      let token: string | null = null;
      do {
        const cursor: string = token === null ? '' : `&continuation-token=${encodeURIComponent(token)}`;
        const { status, body } = await ask(`/${bucket}?list-type=2&max-keys=1000${cursor}`);
        if (status !== 200) throw new Error(`ListObjectsV2 on ${bucket} answered ${String(status)}`);
        for (const block of body.split('<Contents>').slice(1)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
          if (key !== undefined) keys.push(key);
        }
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? null;
      } while (token !== null);
      return keys;
    },
    deleteObject: async (bucket, key) => {
      const { status } = await ask(`/${bucket}/${encodeURIComponent(key)}`, 'DELETE');
      if (status !== 204 && status !== 404) {
        throw new Error(`DeleteObject ${bucket}/${key} answered ${String(status)}`);
      }
    },
    listUploads: async (bucket) => {
      const { status, body } = await ask(`/${bucket}?uploads=`);
      if (status !== 200) throw new Error(`ListMultipartUploads on ${bucket} answered ${String(status)}`);
      const uploads: { key: string; uploadId: string }[] = [];
      for (const block of body.split('<Upload>').slice(1)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
        const uploadId = /<UploadId>([^<]*)<\/UploadId>/.exec(block)?.[1];
        if (key !== undefined && uploadId !== undefined) uploads.push({ key, uploadId });
      }
      return uploads;
    },
    abortUpload: async (bucket, key, uploadId) => {
      const { status } = await ask(
        `/${bucket}/${encodeURIComponent(key)}?uploadId=${encodeURIComponent(uploadId)}`, 'DELETE',
      );
      if (status !== 204 && status !== 404) {
        throw new Error(`AbortMultipartUpload ${bucket}/${key} answered ${String(status)}`);
      }
    },
  };
}

/** Drain BOTH residue classes so `bucket delete` can succeed on a bucket an
 *  interrupted run left dirty. Answers what it removed, for the teardown log. */
export async function drainBucketResidue(
  plane: R2ResiduePlane, bucket: string,
): Promise<{ objects: number; uploads: number }> {
  let objects = 0;
  for (const key of await plane.listObjects(bucket)) {
    await plane.deleteObject(bucket, key);
    objects += 1;
  }
  const uploads = await plane.listUploads(bucket);
  for (const upload of uploads) await plane.abortUpload(bucket, upload.key, upload.uploadId);
  return { objects, uploads: uploads.length };
}

/**
 * The C1/C3 verifiers, OBSERVING only. The teardown replay is the sole
 * deleter: a checker that deletes cannot tell "teardown worked" from "the
 * checker mopped up", and its evidence is then worth nothing — the shape this
 * replaces force-deleted the Worker and the bucket as its "absence check" and
 * hardcoded the multipart count to zero.
 */
export function cleanupObservationProbes(deps: {
  wrangler: (args: readonly string[], options?: { allowFailure?: boolean }) => string;
  residue: R2ResiduePlane | null;
}): Pick<CleanupProbes, 'workerAbsent' | 'bucketState'> {
  return {
    workerAbsent: async (name) => {
      const listed = deps.wrangler(['deployments', 'list', '--name', name], { allowFailure: true });
      if (!listed.startsWith(WRANGLER_FAILED)) return false;
      if (/not found|does not exist|10007/i.test(listed)) return true;
      throw new Error(`deployments list on ${name} failed: ${listed.slice(0, 240)}`);
    },
    bucketState: async (name) => {
      if (deps.residue !== null) {
        if (!(await deps.residue.bucketExists(name))) return { absent: true, objects: 0, multipartResidue: 0 };
        return {
          absent: false,
          objects: (await deps.residue.listObjects(name)).length,
          multipartResidue: (await deps.residue.listUploads(name)).length,
        };
      }
      // Without S3 keys only ABSENCE is provable: R2 refuses to delete a
      // bucket holding objects or open uploads, so a bucket that is gone held
      // nothing. A bucket still present has an unmeasurable multipart count,
      // and an unmeasured count is not zero.
      const info = deps.wrangler(['r2', 'bucket', 'info', name], { allowFailure: true });
      if (info.startsWith(WRANGLER_FAILED) && /not found|does not exist|10006/i.test(info)) {
        return { absent: true, objects: 0, multipartResidue: 0 };
      }
      throw new Error(
        `${name} still exists and R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are absent — `
        + 'multipart residue cannot be measured, and an unmeasured count is not zero',
      );
    },
  };
}

/** The two S3 credentials cleanup verification reads a bucket through, and the
 *  file a developer box keeps them in. Named here, and NEVER read here: the
 *  values travel from the environment straight into `r2ResiduePlane`, and
 *  nothing in this driver prints either one. */
export const R2_CLEANUP_KEY_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
export const R2_CLEANUP_KEY_FILE = '.dev.vars';

/**
 * Why this run must not start, or null when its cleanup can be verified.
 *
 * MEASURED DEFECT THIS REFUSES. Run 20260902154130 deployed two arms, measured
 * one of them for thirteen minutes, and then could not verify its own cleanup:
 * `bucketState` above throws for a bucket that still exists when no S3 keys are
 * present, `checkCleanup` therefore produced no report, and `main` wrote C1–C7
 * all false over a verification that never ran. One bucket was left behind and
 * had to be drained by hand afterwards. The keys were absent from that run's
 * environment the whole time, and nothing asked for them until the teardown.
 *
 * So a run that will verify its own cleanup asks BEFORE it creates anything. A
 * `--keep` run deletes nothing and verifies nothing, and needs no keys.
 *
 * PRESENCE ONLY, and that is a property rather than a style: this takes two
 * booleans, so it cannot read a credential and therefore cannot leak one into
 * the refusal it writes.
 */
export function r2CleanupKeyRefusal(input: {
  /** Will this run tear its resources down and verify that teardown? */
  readonly verifiesCleanup: boolean;
  readonly accessKeyIdPresent: boolean;
  readonly secretAccessKeyPresent: boolean;
}): string | null {
  if (!input.verifiesCleanup) return null;
  const absent = [
    ...(input.accessKeyIdPresent ? [] : [R2_CLEANUP_KEY_VARS[0]]),
    ...(input.secretAccessKeyPresent ? [] : [R2_CLEANUP_KEY_VARS[1]]),
  ];
  if (absent.length === 0) return null;
  return `${absent.join(' and ')} ${absent.length === 1 ? 'is' : 'are'} absent, and this run `
    + 'verifies its own cleanup: G8 reads every bucket through S3, so a bucket that still exists '
    + 'has an unmeasurable multipart count and C1-C7 would be written false over a check that '
    + `never ran. Export ${R2_CLEANUP_KEY_VARS.join(' and ')} — they live in ${R2_CLEANUP_KEY_FILE} `
    + 'in the repository root — or pass --keep to retain every resource and verify nothing. '
    + 'Nothing has been created.';
}

/** One deployed arm's addressable fixture: where it answers and what it
 *  accepts. Exported because the deployed lifecycle suite drives the same
 *  routes through these seams rather than opening a second HTTP client. */
export interface Fixture { origin: string; token: string }

/** Every field the driver ever sends. The fixture parses the same closed set at
 *  its edge, so a key nobody declares here cannot reach a route. */
interface DriverRequest {
  readonly strategy?: Strategy;
  readonly command?: string;
  readonly path?: string;
  readonly content?: string;
  readonly kind?: 'tick' | 'quiesce';
  /** One semantic operation's id, carried by the two armed routes. Reused
   *  across every retry of that operation, which is what stops a re-posted
   *  request from arming a second publication. */
  readonly op?: string;
  readonly purge?: boolean;
  readonly prefix?: string;
  readonly whole?: boolean;
}

export interface AddressedArmRequest {
  readonly path: string;
  readonly body?: DriverRequest;
}

/** Bind every box-addressed request to its arm. GET carries it in the query;
 * POST carries it in JSON. A GET body is invalid in fetch and caused run 9 to
 * fail before the first arm. */
export function addressArmRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: DriverRequest,
): AddressedArmRequest {
  const url = new URL(path, 'https://bench.invalid');
  const box = url.searchParams.get('box');
  const inferred = STRATEGIES.find((strategy) => {
    const base = `ab-${strategy}`;
    return box === base || box?.startsWith(`${base}-`) === true;
  });
  const strategy = body?.strategy ?? inferred;
  if (method === 'GET') {
    if (strategy !== undefined) url.searchParams.set('strategy', strategy);
    return { path: `${url.pathname}${url.search}` };
  }
  if (strategy === undefined) {
    return body === undefined ? { path } : { path, body };
  }
  return { path, body: { ...body, strategy } };
}

/**
 * One driver call, decoded through the schema its route answers with.
 *
 * The schema is a parameter rather than a caller-chosen type argument, because a
 * type argument asserts a shape over bytes nobody checked and every reply here
 * arrives over a network this run cannot see. A reply that disagrees with its
 * contract fails carrying the wire's own words — the JSON syntax error or
 * valibot's field-level message, plus a prefix of the text — because a benchmark
 * that defaults a missing number goes on to publish it.
 */
const STATE_POLL_REQUEST_TIMEOUT_MS = 15_000;

/** What a thrown value carries once parsed at this boundary. A fetch deadline
 *  arrives as a DOMException named TimeoutError — no Error subclass, often an
 *  empty stack — which is how four runs died unattributed. */
const ThrownFailureSchema = v.object({
  name: v.optional(v.string()),
  message: v.optional(v.string()),
  stack: v.optional(v.string()),
  cause: v.optional(v.unknown()),
});

function parseThrown({ cause }: { readonly cause: unknown }): v.InferOutput<typeof ThrownFailureSchema> {
  const parsed = v.safeParse(ThrownFailureSchema, cause);
  return parsed.success ? parsed.output : {};
}

/** Transport loss: the request itself never completed. Takes the PARSED shape;
 *  the catch that owns the raw thrown value parses it first. */
function isTransportLoss(thrown: v.InferOutput<typeof ThrownFailureSchema>): boolean {
  return /TimeoutError|AbortError/.test(thrown.name ?? '')
    || /timed out|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(thrown.message ?? '');
}

/** Every fixture request is finite and, on transport loss, asked again.
 *
 *  THE ONE TRANSPORT SEAM. Every endpoint is an idempotent probe against a
 *  durable schedule, and every measured number is the SERVER's own `ms`, so a
 *  re-asked request never blends a measurement. Without an explicit deadline a
 *  bare fetch inherits the runtime's idle timeout and dies mid-run as a
 *  stackless DOMException — so the deadline is always explicit here, and no
 *  call site carries its own transport policy. Reply-LEVEL churn (`error`
 *  strings from a replaced container) stays where it was: `retryTransient`.
 */
const CALL_DEADLINE_MS = 180_000;
const CALL_ATTEMPTS = 3;

async function call<TSchema extends v.GenericSchema>(
  fixture: Fixture,
  method: 'GET' | 'POST',
  path: string,
  schema: TSchema,
  body?: DriverRequest,
  timeoutMs?: number,
): Promise<v.InferOutput<TSchema>> {
  const addressed = addressArmRequest(method, path, body);
  const headers = new Headers({ authorization: `Bearer ${fixture.token}` });
  if (addressed.body !== undefined) headers.set('content-type', 'application/json');
  for (let attempt = 1; ; attempt += 1) {
    const init: RequestInit = { method, headers };
    if (addressed.body !== undefined) init.body = JSON.stringify(addressed.body);
    init.signal = AbortSignal.timeout(timeoutMs ?? CALL_DEADLINE_MS);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${fixture.origin}${addressed.path}`, init);
      text = await response.text();
    } catch (error) {
      if (attempt >= CALL_ATTEMPTS || !isTransportLoss(parseThrown({ cause: error }))) throw error;
      log(`${method} ${path}: transport loss on attempt ${attempt}; asking again`);
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${method} ${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
        { cause: error },
      );
    }
    const parsed = v.safeParse(schema, decoded);
    if (!parsed.success) {
      throw new Error(
        `${method} ${path} (${response.status}) does not match its reply contract: `
        + `${issueText(parsed.issues)}\n${text.slice(0, 300)}`,
      );
    }
    return parsed.output;
  }
}
/**
 * Every reply below is a LOOSE object: the declared fields are validated, and a
 * field nobody declared is preserved rather than deleted.
 *
 * Stripping is silent data loss at a boundary whose payload is archived, and it
 * has already cost this benchmark family a field: the probe emitted a top-level
 * `loopBudgetMs` that no interface declared, and a stripping schema would have
 * dropped it out of the run artifact instead of carrying it. `/ops` and
 * `/teardown` are written into that artifact whole, which is what a human reads
 * months later, so a new field has to survive a driver that has not heard of it.
 */

/** A call the driver only needs to have happened: `/write` at harness install,
 *  and the two `/ops` maintenance routes. Nothing reads the rest of the reply. */
interface AckReply { ok?: boolean; error?: string }

const AckReplySchema: v.GenericSchema<AckReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

export interface ExecReply { ok?: boolean; exitCode?: number; stdout?: string; stderr?: string; ms?: number; error?: string }

const ExecReplySchema: v.GenericSchema<ExecReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  exitCode: v.optional(v.number()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

/** One command inside the box, through the fixture's own `/exec` route.
 *
 *  `timeoutMs` is per attempt and defaults to the shared transport deadline. A
 *  caller whose own window is smaller than that — the startup readiness drive,
 *  bounded by the ceiling it is helping to decide — supplies it, because
 *  `/exec` waits on `ensureReady()` and a slow restoration otherwise holds the
 *  request open for the whole default budget. */
export async function execInBox(
  fixture: Fixture, box: string, command: string, timeoutMs?: number,
): Promise<ExecReply> {
  return await call(fixture, 'POST', `/exec?box=${box}`, ExecReplySchema, { command }, timeoutMs);
}

/** One file into the box, through the fixture's own `/write` route. Re-callable
 *  on purpose: nothing on a container's disk survives a recycle, so a caller
 *  that finds its own harness gone writes it again. */
export async function writeFileInBox(
  fixture: Fixture, box: string, path: string, content: string,
): Promise<void> {
  await call(fixture, 'POST', `/write?box=${box}`, AckReplySchema, { path, content });
}

const TRANSIENT_REPLACEMENT = /OperationInterrupted|runtime connection was closing|broken\.constructorFailed|container.*(?:replac|restart)/i;

/** Retry only the interrupted edge operation. There is no elapsed deadline and
 * no retry of a completed lifecycle. */
export async function retryTransient<T extends { error?: string }>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const reply = await run();
      if (!TRANSIENT_REPLACEMENT.test(reply.error ?? '') || attempt === 3) return reply;
      log(`${operation}: transient replacement on attempt ${attempt}; retrying that request`);
    } catch (error) {
      const detail = describeThrown({ cause: error });
      if (!TRANSIENT_REPLACEMENT.test(detail) || attempt === 3) throw error;
      log(`${operation}: transient replacement on attempt ${attempt}; retrying that request`);
    }
  }
  throw new Error(`${operation}: retry loop ended without a reply`);
}


// ── lifecycle ───────────────────────────────────────────────────────────────

/** Delete ONE arm's Worker and the container application its class raised.
 *  Every arm owns both alone, so this is the whole of that arm's deployed
 *  compute and it can run while a sibling is still measuring. */
function deleteFixtureResources(fixture: ArmFixture): readonly string[] {
  let deleted = wrangler([
    'delete', '--config', fixture.configPath, '--force',
  ], { allowFailure: true });
  if (deleted.startsWith(WRANGLER_FAILED)) {
    deleted = wrangler(['delete', '--name', fixture.worker, '--force'], { allowFailure: true });
  }
  const workerResult = deleted.startsWith(WRANGLER_FAILED)
    && !/not found|does not exist/i.test(deleted)
    ? `worker: FAILED ${deleted.slice(0, 160)}`
    : 'worker: deleted or absent';
  return [
    workerResult,
    ...deleteContainerApps(REPO_ROOT, fixture.containerApps, log),
  ];
}

export async function deployFixture(
  token: string,
  fixture: ArmFixture,
): Promise<{ fixture: Fixture; workerVersion: string; stop: () => readonly string[] }> {
  const output = wrangler([
    'deploy', '--config', fixture.configPath, '--var', `BENCH_TOKEN:${token}`,
  ]);
  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  if (origin === undefined) throw new Error(`deploy printed no workers.dev origin:\n${output.slice(-2500)}`);
  // WHICH DEPLOYED CODE SERVED THE ARMS. Two runs from one commit can be served
  // by different Worker versions — a `--var` change alone publishes a new one —
  // and the version id is the only thing that distinguishes them.
  const workerVersion = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(output)?.[1];
  if (workerVersion === undefined) {
    throw new Error(`deploy printed no Worker version id:\n${output.slice(-2500)}`);
  }
  log(`deployed ${origin} at version ${workerVersion}`);

  let unauth = 0;
  try {
    unauth = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) })).status;
  } catch (cause) {
    log(`the unauthenticated probe did not answer: ${describeThrown({ cause })}`);
  }
  if (unauth === 200) {
    throw new Error('the bench app answered an unauthenticated request; refusing to run');
  }

  const deadline = Date.now() + 180_000;
  for (;;) {
    let authed = 0;
    try {
      authed = (await fetch(`${origin}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })).status;
    } catch (cause) {
      log(`the readiness probe did not answer: ${describeThrown({ cause })}`);
    }
    if (authed === 200) break;
    if (Date.now() > deadline) {
      throw new Error(
        `the deployment never accepted this run's token at ${origin} (last status ${authed})`,
      );
    }
    await delay(3_000);
  }

  return {
    fixture: { origin, token },
    workerVersion,
    stop: () => deleteFixtureResources(fixture),
  };
}

// ── measurement ─────────────────────────────────────────────────────────────

/** The R2 operation tally as `/ops` answers it, and what the report's cost
 *  columns read. Written into the artifact whole; the reply-contract note above
 *  says why an undeclared key survives. */
interface OpTally { calls?: Record<string, number>; classA?: number; classB?: number; classFree?: number; total?: number }

const OpTallySchema: v.GenericSchema<OpTally> = v.looseObject({
  calls: v.optional(v.record(v.string(), v.number())),
  classA: v.optional(v.number()),
  classB: v.optional(v.number()),
  classFree: v.optional(v.number()),
  total: v.optional(v.number()),
});

/** One lifecycle assertion. The driver retains every failed row in the
 * artifact, then excludes its arm from ranking. */
interface VerifyCheck { name: string; pass: boolean; detail: string }

export interface HeadReply {
  ok?: boolean;
  key?: string;
  exists?: boolean;
  size?: number;
  /** The store's own name for the bytes at this key. A size cannot answer
   *  "does this key hold different bytes than before" — two archives of one
   *  length are the same size — and that question is the whole of the
   *  `mutable-delta` witness cell. */
  etag?: string;
  error?: string;
}

const HeadReplySchema: v.GenericSchema<HeadReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  key: v.optional(v.string()),
  exists: v.optional(v.boolean()),
  size: v.optional(v.number()),
  etag: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** What the box says about itself, through the fixture's own `/state` route.
 *  The startup poll reads the same reply; a caller that needs the arm's store
 *  prefix or its durable chain record asks here rather than deriving either. */
export async function boxState(fixture: Fixture, box: string): Promise<StateReply> {
  return await call(
    fixture, 'GET', `/state?box=${box}`, StateReplySchema, undefined, STATE_POLL_REQUEST_TIMEOUT_MS,
  );
}

/** What the STORE holds under one key, through the fixture's own `/head` route.
 *  The only fact about durable bytes no container command can answer. */
export async function headObject(fixture: Fixture, box: string, key: string): Promise<HeadReply> {
  return await call(
    fixture, 'GET', `/head?box=${box}&key=${encodeURIComponent(key)}`, HeadReplySchema,
  );
}

// ── the candidate lifecycle contract ───────────────────────────────────────
//
// MEASURED DEFECT THIS REPAIRS. The mount branch below used to read
//
//     if (strategy === 'r2fs' || strategy === 'overlay-cas' || mode === 'chain')
//
// so a candidate arm took the CHAIN's checks whenever the box happened to
// report `mode: 'chain'`, and otherwise fell through to the extraction branch —
// which asks only that `/workspace` is a plain directory and that
// `ALLOW_EXTRACTION` is set. A container that never attached a candidate store
// at all satisfies the second one completely. Both candidate arms could
// therefore pass a lifecycle proof having proven nothing whatsoever about their
// own strategy, and their latency rows would then be ranked.
//
// A candidate attachment is neither a chain nor an extraction, and the three
// things it must prove have no counterpart in either:
//
//   the workload writes THROUGH a journal daemon's FUSE mount over the work
//     directory, with the daemon alive and its control socket outside both the
//     journal mount and the payload mount — or the capture reads through the
//     mount it is capturing;
//   the control envelope is the single immutable published head, addressed by
//     its own digest, stamped with this arm's format and box, and living
//     OUTSIDE the payload subtree a container replacement owns;
//   the payload closure that envelope names is completely present, at the
//     declared byte length of every object in it.

interface CandidateEnvelopeFact {
  key?: string;
  rootEnvelopeId?: string;
  sha256?: string;
  format?: string;
  boxId?: string;
  generation?: string;
  cut?: string;
  closureCount?: number;
}

const CandidateEnvelopeFactSchema: v.GenericSchema<CandidateEnvelopeFact> = v.looseObject({
  key: v.optional(v.string()),
  rootEnvelopeId: v.optional(v.string()),
  sha256: v.optional(v.string()),
  format: v.optional(v.string()),
  boxId: v.optional(v.string()),
  generation: v.optional(v.string()),
  cut: v.optional(v.string()),
  closureCount: v.optional(v.number()),
});

interface CandidateClosureFact {
  key?: string;
  declaredBytes?: string;
  storedBytes?: number | null;
}

const CandidateClosureFactSchema: v.GenericSchema<CandidateClosureFact> = v.looseObject({
  key: v.optional(v.string()),
  declaredBytes: v.optional(v.string()),
  storedBytes: v.optional(v.nullable(v.number())),
});

interface CandidateStoreFact {
  payloadPrefix?: string;
  envelopePrefix?: string;
  expectedBoxId?: string;
  expectedFormat?: string;
  envelopes?: CandidateEnvelopeFact[];
  head?: CandidateEnvelopeFact | null;
  forkedHeads?: string[];
  closure?: CandidateClosureFact[];
  unreadable?: string[];
}

interface CandidateContainerFact {
  expectedWorkdirMount?: string;
  expectedStoreMount?: string;
  expectedJournalRoot?: string;
  expectedJournalSocket?: string;
  expectedJournalBinary?: string;
  mounts?: string;
  journalRootPresent?: boolean;
  journalSocketPresent?: boolean;
  journalDaemonCommand?: string;
}

export interface CandidateFactsReply {
  ok?: boolean;
  error?: string;
  store?: CandidateStoreFact;
  container?: CandidateContainerFact;
}

const CandidateFactsReplySchema: v.GenericSchema<CandidateFactsReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
  store: v.optional(v.looseObject({
    payloadPrefix: v.optional(v.string()),
    envelopePrefix: v.optional(v.string()),
    expectedBoxId: v.optional(v.string()),
    expectedFormat: v.optional(v.string()),
    envelopes: v.optional(v.array(CandidateEnvelopeFactSchema)),
    head: v.optional(v.nullable(CandidateEnvelopeFactSchema)),
    forkedHeads: v.optional(v.array(v.string())),
    closure: v.optional(v.array(CandidateClosureFactSchema)),
    unreadable: v.optional(v.array(v.string())),
  })),
  container: v.optional(v.looseObject({
    expectedWorkdirMount: v.optional(v.string()),
    expectedStoreMount: v.optional(v.string()),
    expectedJournalRoot: v.optional(v.string()),
    expectedJournalSocket: v.optional(v.string()),
    expectedJournalBinary: v.optional(v.string()),
    mounts: v.optional(v.string()),
    journalRootPresent: v.optional(v.boolean()),
    journalSocketPresent: v.optional(v.boolean()),
    journalDaemonCommand: v.optional(v.string()),
  })),
});

/** One mountpoint's row in `/proc/mounts`, whose fields are
 *  `device mountpoint fstype options dump pass`. Naming that layout once is
 *  what keeps a caller from indexing field 2 and calling it a filesystem. */
function mountAt(mounts: string, mountpoint: string): { line: string; fstype: string } | null {
  for (const raw of mounts.split('\n')) {
    const line = raw.trim();
    const fields = line.split(' ');
    const fstype = fields[2];
    if (fields[1] === mountpoint && fstype !== undefined) return { line, fstype };
  }
  return null;
}

/**
 * One candidate arm's lifecycle rows, derived from the fixture's raw facts.
 *
 * Pure, and exported, so the contract is provable against hand-built facts:
 * the red tests drive every direction of it without a deployment, which is the
 * only way a fallthrough like the one above gets caught before a 70-minute run
 * ranks an arm that measured nothing.
 */
export function candidateLifecycleChecks(
  strategy: 'bounded-layers' | 'merkle-pack',
  reply: CandidateFactsReply,
): VerifyCheck[] {
  const store = reply.store;
  const container = reply.container;
  if (reply.ok !== true || store === undefined || container === undefined) {
    return [{
      name: `the fixture answered the ${strategy} candidate contract`,
      pass: false,
      detail: reply.error ?? `ok=${String(reply.ok)} store=${store === undefined ? 'absent' : 'present'} `
        + `container=${container === undefined ? 'absent' : 'present'}`,
    }];
  }

  const checks: VerifyCheck[] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  const workdirMountpoint = container.expectedWorkdirMount ?? '';
  const storeMountpoint = container.expectedStoreMount ?? '';
  const mounts = container.mounts ?? '';
  const workdir = workdirMountpoint === '' ? null : mountAt(mounts, workdirMountpoint);
  const storeMount = storeMountpoint === '' ? null : mountAt(mounts, storeMountpoint);

  // A FUSE fstype is `fuse`, `fuse.<name>` or `fuseblk`. Prefix-matching the
  // field rather than searching the whole line keeps an unrelated mount whose
  // DEVICE name contains "fuse" from answering for the work directory.
  add(
    'the work directory is the journal daemon\'s FUSE mount',
    workdir !== null && /^fuse(?:\.|blk$|$)/.test(workdir.fstype),
    workdir === null
      ? `${workdirMountpoint || '(no expected mountpoint)'} is not mounted`
      : `${workdirMountpoint} -> ${workdir.fstype}`,
  );

  const daemonCommand = container.journalDaemonCommand ?? '';
  const daemonBinary = container.expectedJournalBinary ?? '';
  const journalRoot = container.expectedJournalRoot ?? '';
  const journalSocket = container.expectedJournalSocket ?? '';
  const daemonNames = [daemonBinary, journalRoot, workdirMountpoint, journalSocket];
  add(
    'the journal daemon is alive and serving this arm\'s root, mount and socket',
    daemonBinary !== '' && daemonNames.every((part) => part !== '' && daemonCommand.includes(part)),
    daemonCommand === ''
      ? 'no journal daemon process is alive in the container'
      : `argv is missing ${daemonNames.filter((part) => part === '' || !daemonCommand.includes(part)).join(', ') || 'nothing'}`,
  );

  add(
    'the journal root is materialized beneath the mount',
    container.journalRootPresent === true,
    `${journalRoot || '(no expected root)'} -> ${container.journalRootPresent === true ? 'present' : 'absent'}`,
  );

  // OUTSIDE BOTH MOUNTS. The daemon's control socket and sealed stage are what
  // a capture reads; holding them under the journal mount would make the
  // capture read through the mount it captures, and under the store mount would
  // publish them as payload.
  const socketInsideMount = journalSocket !== ''
    && [workdirMountpoint, storeMountpoint]
      .filter((mount) => mount !== '')
      .some((mount) => journalSocket === mount || journalSocket.startsWith(`${mount}/`));
  add(
    'the journal control socket is present outside both mounts',
    container.journalSocketPresent === true && journalSocket !== '' && !socketInsideMount,
    container.journalSocketPresent === true
      ? socketInsideMount
        ? `${journalSocket} is inside a mount this arm captures`
        : `${journalSocket} is present outside both mounts`
      : `${journalSocket || '(no expected socket)'} is not a socket`,
  );

  add(
    'the payload store is an s3fs mount at the candidate prefix',
    storeMount !== null && storeMount.fstype.includes('s3fs'),
    storeMount === null
      ? `${storeMountpoint || '(no expected mountpoint)'} is not mounted`
      : `${storeMountpoint} -> ${storeMount.fstype}`,
  );

  const head = store.head ?? null;
  const forked = store.forkedHeads ?? [];
  const unreadable = store.unreadable ?? [];
  add(
    'the control envelope is the single published head',
    head !== null && forked.length === 0 && unreadable.length === 0,
    head === null
      ? forked.length > 0
        ? `${forked.length} envelopes share the newest generation: ${forked.join(', ')}`
        : `no readable root envelope under ${store.envelopePrefix ?? '(no envelope prefix)'}`
      : unreadable.length > 0
        ? `head present but ${unreadable.length} envelope(s) are unreadable: ${unreadable.join('; ')}`
        : `generation ${head.generation ?? '?'} at cut ${head.cut ?? '?'}`,
  );

  add(
    'the control envelope is the immutable object its own key names',
    head !== null && head.sha256 !== undefined && head.sha256 === head.rootEnvelopeId,
    head === null
      ? '(no head envelope)'
      : `key names ${head.rootEnvelopeId ?? '?'}, bytes hash to ${head.sha256 ?? '?'}`,
  );

  add(
    'the control envelope carries this arm\'s format and box',
    head !== null
      && head.format === store.expectedFormat && store.expectedFormat !== undefined
      && head.boxId === store.expectedBoxId && store.expectedBoxId !== undefined,
    head === null
      ? '(no head envelope)'
      : `format ${head.format ?? '?'} (want ${store.expectedFormat ?? '?'}), `
        + `box ${head.boxId ?? '?'} (want ${store.expectedBoxId ?? '?'})`,
  );

  const envelopePrefix = store.envelopePrefix ?? '';
  const payloadPrefix = store.payloadPrefix ?? '';
  add(
    'the control envelope prefix is outside the payload mount',
    envelopePrefix !== '' && payloadPrefix !== ''
      && !envelopePrefix.startsWith(payloadPrefix) && !payloadPrefix.startsWith(envelopePrefix),
    `envelopes at ${envelopePrefix || '(none)'}, payload at ${payloadPrefix || '(none)'}`,
  );

  // NOT `length > 0` ALONE. An object the envelope declares at 4 MiB and the
  // store holds at 0 B resolves, so an existence check would pass a closure
  // that cannot be read back. Its objects must also sit below THIS arm's
  // payload prefix; a complete closure borrowed from another arm is not this
  // candidate's durable payload.
  const closure = store.closure ?? [];
  const absent = closure.filter((row) => row.storedBytes === null || row.storedBytes === undefined);
  const short = closure.filter((row) =>
    row.storedBytes !== null && row.storedBytes !== undefined
    && Number(row.declaredBytes ?? '-1') !== row.storedBytes);
  const outsidePayload = closure.filter((row) =>
    payloadPrefix === '' || row.key === undefined || !row.key.startsWith(payloadPrefix));
  add(
    'the payload closure is completely present at its declared lengths',
    head !== null && closure.length > 0 && absent.length === 0 && short.length === 0 && outsidePayload.length === 0,
    head === null
      ? '(no head envelope, so no closure to resolve)'
      : closure.length === 0
        ? 'the head envelope names no payload objects at all'
        : `${closure.length} object(s): ${absent.length} absent, ${short.length} at the wrong length, `
          + `${outsidePayload.length} outside this arm's payload prefix`
          + `${absent.length + short.length + outsidePayload.length === 0 ? '' : ` (${[...absent, ...short, ...outsidePayload].map((row) => row.key ?? '?').slice(0, 4).join(', ')})`}`,
  );

  return checks;
}

const MAX_HTTPS_RESPONSE_BYTES = 1_048_576;

interface HttpsResponse {
  readonly statusCode?: number;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): HttpsResponse;
  once(event: 'end' | 'close', listener: () => void): HttpsResponse;
  once(event: 'error', listener: (error: Error) => void): HttpsResponse;
  destroy(error?: Error): void;
}

interface HttpsRequest {
  once(event: 'error', listener: (error: Error) => void): HttpsRequest;
  end(body: string): void;
  destroy(error?: Error): void;
}

export type HttpsRequester = (
  url: URL,
  options: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
  },
  respond: (response: HttpsResponse) => void,
) => HttpsRequest;

export type VerifyHttpsRequester = HttpsRequester;
export type LiveTeardownHttpsRequester = HttpsRequester;

const requestOverHttps: HttpsRequester = (url, options, respond) =>
  httpsRequest(url, options, respond);

/**
 * Live teardown can outlast a cold-container window. Node's HTTPS client has
 * no elapsed request timeout unless one is set explicitly. Retain only a
 * bounded reply, and reject a connection that closes before it finishes.
 *
 * `timeoutMs` IS THE ELAPSED BOUND, and its absence still means unbounded: the
 * benchmark's teardown is allowed to take as long as a purge takes. A caller
 * that judges teardown by a CEILING passes one, because the reply-size bound
 * this function already had does nothing for a box that never answers — the
 * calibration run's `r2fs` and `overlay-cas` teardowns each burned a 900,000 ms
 * ceiling on one such request, and probe `wakeprobe09010702` reproduced it
 * against a box wedged in its own attach loop. The purge is idempotent and
 * `teardownLiveArms` posts a second pass, so an abandoned request costs a retry
 * rather than the work.
 */
async function postBoundedHttps(
  fixture: Fixture,
  path: string,
  body: DriverRequest,
  requester: HttpsRequester,
  timeoutMs?: number,
): Promise<string> {
  const addressed = addressArmRequest('POST', path, body);
  const endpoint = new URL(path, 'https://bench.invalid').pathname;
  const payload = JSON.stringify(addressed.body);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let elapsed: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(elapsed);
      reject(error);
    };
    const request = requester(
      new URL(`${fixture.origin}${addressed.path}`),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          const responseChunk = Buffer.from(chunk);
          if (bytes + responseChunk.byteLength > MAX_HTTPS_RESPONSE_BYTES) {
            const error = new Error(`${endpoint} response exceeds ${MAX_HTTPS_RESPONSE_BYTES} bytes`);
            response.destroy(error);
            fail(error);
            return;
          }
          bytes += responseChunk.byteLength;
          chunks.push(responseChunk);
        });
        response.once('error', fail);
        response.once('close', () => fail(new Error(`${endpoint} response closed before end`)));
        response.once('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(elapsed);
          resolve(Buffer.concat(chunks, bytes).toString('utf8'));
        });
      },
    );
    request.once('error', fail);
    if (timeoutMs !== undefined) {
      elapsed = setTimeout(() => {
        const expiry = new Error(`${endpoint} did not answer inside ${String(timeoutMs)} ms`);
        request.destroy(expiry);
        fail(expiry);
      }, timeoutMs);
    }
    request.end(payload);
  });
}


/** A startup kick arms durable work and returns before the attach finishes. */
interface KickReply { ok?: boolean; ms?: number; error?: string }

const KickReplySchema: v.GenericSchema<KickReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

const STARTUP_POLL_INTERVAL_MS = 250;

export interface StartupPoll {
  readonly attach: AttachOutcome;
  readonly state: StateReply;
  /** How many times this poll had to drive the readiness boundary itself. It
   *  travels with the measurement because a startup the DRIVER completed is not
   *  the same quantity as one the fixture's own schedule completed, and a
   *  number nobody can attribute is worse than an absent one. */
  readonly redrives: number;
}

export interface StartupCompletion extends StartupPoll {
  readonly ms: number;
}

/**
 * The command a readiness drive runs, and the reason it is this command.
 *
 * `true` reads nothing, writes nothing, touches no measured path and moves no
 * bytes a checkpoint would price, so driving twice cannot double-apply an
 * effect or contaminate a phase. Everything that makes the drive work is in the
 * REQUEST rather than the command: `/exec` is the ordinary operation path, and
 * an ordinary operation waits on `ensureReady()`.
 */
const READINESS_DRIVE_COMMAND = 'true';

/** What one readiness drive settled as.
 *
 *  A REFUSAL IS THE BOUNDARY'S OWN ANSWER and ends the startup. Everything else
 *  is a drive that has not answered, which proves nothing either way: the drive
 *  is a KICK, not a measurement, and `/state` stays the oracle. */
type ReadinessDrive =
  | { readonly kind: 'drove' }
  | { readonly kind: 'unanswered'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string };

/**
 * Take this startup through the boundary a real operation goes through.
 *
 * `/state` does not drive a restoration inline — it re-arms the startup row and
 * reports what the last generation left behind — while `ensureReady()` starts a
 * stopped container and finishes the attach inside the caller's own request. A
 * driver holding only `/state` is therefore waiting on a callback that a
 * consumed row will never deliver, and one authenticated no-op exec is the
 * entire repair.
 *
 * WHY A LOST REPLY IS NOT A REFUSAL, MEASURED. `/exec` waits on `ensureReady()`,
 * so a drive posted against a slow restoration stays open for as long as the
 * attach takes, and `call` gives up after `CALL_ATTEMPTS` x `CALL_DEADLINE_MS`
 * = 540 s with a stackless `TimeoutError: The operation timed out.`. Both
 * deployed drivers reported exactly that number as the startup's own verdict —
 * `snapshot-chain` wake, 540,050 ms in devbox-e2e-e2ecal0901002202, and the same
 * arm in the decisive run 20260831233915 after two logged transport losses on
 * `POST /exec` — while nothing had been asked of `/state` for nine minutes. The
 * container-side restoration is unaffected by a client abort, so a drive whose
 * reply was lost is reported and the poll goes back to reading state.
 *
 * AND A BOX THAT SAYS "ASK AGAIN" HAS NOT REFUSED EITHER. `ensureReady()` has
 * three answers and only one of them is a verdict: a terminal recovery class
 * says so and names `attachNow()`, while both "a startup is armed, so ask
 * again" and "a retry is already under way" mean the drive found the box
 * mid-startup. Reading either as the boundary's verdict ended a deployed cold
 * attach at 12,810 ms on a container that was still coming up (2026-09-01,
 * snapshot-chain, both sides of the byte-plane change), so the startup was
 * recorded as refused while the box was doing exactly what it said. The wait
 * stays bounded by the caller's own ceiling; only the classification changes.
 */
async function driveReadiness(
  fixture: Fixture,
  box: string,
  operation: string,
  timeoutMs?: number,
): Promise<ReadinessDrive> {
  let driven: ExecReply;
  try {
    driven = await retryTransient(`${operation} readiness drive`, async () =>
      await execInBox(fixture, box, READINESS_DRIVE_COMMAND, timeoutMs),
    );
  } catch (error) {
    return { kind: 'unanswered', detail: describeThrown({ cause: error }) };
  }
  if (driven.ok === true) return { kind: 'drove' };
  const detail = driven.error ?? `the readiness probe exited ${driven.exitCode ?? -1}`;
  return isTransientContainerCreateError(detail) || isRearmableStartupRefusal(detail)
    ? { kind: 'unanswered', detail }
    : { kind: 'refused', detail };
}

/**
 * Wait for THIS startup's attach, and drive it when the state proves nobody
 * else will.
 *
 * The classification is `startupPollVerdict`'s and every arm of it is honoured
 * here: an attach of an unexpected kind and a definitive refusal both still
 * throw. The one addition is the `stopped` reading, which is not a wait at all
 * — see the startup redrive test for the deployed run that waited on it for an
 * hour while repeated `/create` kicks kept answering `{ ok: true }`.
 *
 * THE DRIVE RUNS BESIDE THE POLL, NEVER IN FRONT OF IT. One drive is in flight
 * at a time and the loop does not wait for its reply, because the drive only
 * pushes the box through the readiness gate while the ANSWER is the next
 * `/state` reading. Awaiting it made a slow restoration indistinguishable from a
 * dead one: the poll went blind for the drive's whole 540 s transport budget and
 * then reported the transport's timeout as the box's verdict, so an attach that
 * completed inside the caller's ceiling would have been recorded as a startup
 * that never happened.
 */
export async function pollForAttach(
  fixture: Fixture,
  box: string,
  operation: string,
  allowedKinds: readonly string[],
  bounds: StartupBounds = {},
): Promise<StartupPoll> {
  // UNBOUNDED BY DEFAULT, because the benchmark's own budget is the container
  // start budget and a poll that gave up early would report a refusal the box
  // never made. A caller whose SUBJECT is the wait — the deployed lifecycle
  // suite, whose oracle is a settle ceiling — supplies its own deadline and
  // gets a refusal naming the last reading instead of a poll nobody stops.
  const deadline = bounds.deadlineMs === undefined ? null : Date.now() + bounds.deadlineMs;
  let redrives = 0;
  let lastReading = 'no /state reply has been decoded yet';
  /** The one drive in flight, HELD rather than floated: the loop that started
   *  it owns it, and its rejection can never reach the process unhandled. */
  let driving: { readonly since: number; readonly settled: Promise<void> } | null = null;
  let refusal: string | null = null;
  for (;;) {
    // The boundary's refusal, collected from whichever drive carried it. It is
    // read here rather than thrown from the drive so that one lane's refusal
    // still travels through this loop's own accounting.
    if (refusal !== null) throw new Error(`${operation} refused: ${refusal}`);
    if (deadline !== null && Date.now() > deadline) {
      throw new Error(
        `${operation} did not attach within its ${String(bounds.deadlineMs)} ms ceiling `
        + `(last reading: ${lastReading}`
        + `${driving === null ? '' : `; a readiness drive posted ${String(Date.now() - driving.since)} ms ago has not answered`})`,
      );
    }
    let reply: StateReply;
    try {
      reply = await boxState(fixture, box);
    } catch (error) {
      log(`${operation}: state poll retrying: ${describeThrown({ cause: error })}`);
      await delay(STARTUP_POLL_INTERVAL_MS);
      continue;
    }
    const verdict = startupPollVerdict(reply);
    lastReading = `${verdict.kind}${'detail' in verdict ? `: ${verdict.detail}` : ''}`
      + `${'reason' in verdict ? `: ${verdict.reason}` : ''} — ${describeStartupState(reply)}`;
    if (verdict.kind === 'attached') {
      if (allowedKinds.includes(verdict.attach.kind)) {
        return { attach: verdict.attach, state: reply, redrives };
      }
      throw new Error(`${operation} restored ${verdict.attach.kind}, expected ${allowedKinds.join(' or ')}`);
    }
    if (verdict.kind === 'failed') throw new Error(`${operation} refused: ${verdict.reason}`);
    if (verdict.kind === 'stopped' && driving === null) {
      redrives += 1;
      log(`${operation}: ${verdict.detail}; driving readiness through one no-op exec (drive ${redrives})`);
      // Bounded by what is left of the caller's own window, so a drive cannot
      // outlive the verdict it was meant to help produce. Aborting the request
      // does not abort the restoration: the container-side attach runs to its
      // own budget either way, and the next `/state` reading is what sees it.
      const remaining = deadline === null ? undefined : Math.max(1_000, deadline - Date.now());
      const since = Date.now();
      driving = {
        since,
        settled: (async (): Promise<void> => {
          try {
            const drive = await driveReadiness(fixture, box, operation, remaining);
            if (drive.kind === 'refused') refusal = drive.detail;
            else if (drive.kind === 'unanswered') {
              log(`${operation}: the readiness drive did not answer (${drive.detail}); the state poll keeps the verdict`);
            }
          } catch (error) {
            // `driveReadiness` ANSWERS rather than throws, so this is reachable
            // only if that contract breaks. It is still handled here: a drive
            // nobody awaits must never end a run that already has its verdict.
            log(`${operation}: the readiness drive threw instead of answering: ${describeThrown({ cause: error })}`);
          } finally {
            driving = null;
          }
        })(),
      };
    } else if (reply.error !== undefined) {
      log(`${operation}: state poll retrying: ${reply.error}`);
    }
    // ONE cadence for every unsettled reading, a drive included: the next poll
    // is what accepts the attach, and only one drive is ever in flight, so
    // nothing here can spin or stack requests on a box that is already starting.
    await delay(STARTUP_POLL_INTERVAL_MS);
  }
}

/** How long a startup may take before the caller reads the wait itself as the
 *  failure. Absent means unbounded — see `pollForAttach`. */
export interface StartupBounds {
  readonly deadlineMs?: number;
}

/** Kick one startup and wait for THIS generation's attach, measured end to end
 *  from the kick. The two startup routes are the same operation to a caller;
 *  which one it is decides only what the container is allowed to restore. */
export async function startupOperation(
  fixture: Fixture,
  box: string,
  path: '/create' | '/wake',
  operation: string,
  allowedKinds: readonly string[],
  bounds: StartupBounds = {},
): Promise<StartupCompletion> {
  const started = Date.now();
  // THE CALLER'S CEILING COVERS THE KICK TOO. The capacity retry below is
  // unbounded by design for the benchmark, and a bounded caller that inherited
  // it spent its whole window re-kicking a box that never admitted a container
  // and then reported the ceiling with nothing named. `bounds` now ends that
  // loop with the last kick's own words.
  const deadline = bounds.deadlineMs === undefined ? null : started + bounds.deadlineMs;
  for (let attempt = 1; ; attempt += 1) {
    let transient: string;
    try {
      const kicked = await call(fixture, 'POST', `${path}?box=${box}`, KickReplySchema, {});
      if (kicked.ok === true) break;
      const detail = kicked.error ?? 'the startup kick did not confirm';
      if (!isTransientContainerCreateError(detail)) throw new Error(`${operation} failed: ${detail}`);
      transient = detail;
    } catch (error) {
      const detail = describeThrown({ cause: error });
      if (!isTransientContainerCreateError(detail)) throw error;
      transient = detail;
    }
    log(`${operation}: transient container capacity on attempt ${attempt}; retrying the same box`);
    if (deadline !== null && Date.now() + 15_000 > deadline) {
      throw new Error(
        `${operation} was still being admitted at its ${String(bounds.deadlineMs)} ms ceiling `
        + `after ${String(attempt)} kick(s) (last kick: ${transient})`,
      );
    }
    await delay(15_000);
  }
  const attached = await pollForAttach(fixture, box, operation, allowedKinds, bounds);
  return { ...attached, ms: Date.now() - started };
}

/** What one settled checkpoint reports. Its wire form is the poll reply below:
 *  the fixture answers a checkpoint's outcome by token, never inside the
 *  request that asked for it. */
export interface CheckpointReply {
  ok?: boolean;
  outcome?: { kind: string; reason?: string; bytes?: number; movedBytes?: number };
  ms?: number;
  error?: string;
}

export interface StopReply { ok?: boolean; ms?: number; error?: string }

// ── the async operation protocol ────────────────────────────────────────────
//
// THE DRIVER'S OWN DOCTRINE, APPLIED TO THE TWO ROUTES THAT BROKE IT.
// `runPhase` already backgrounds anything minute-scale and polls a sentinel
// "because the blocking path is bounded by a ceiling that no timeout option
// raises". `POST /checkpoint` and `POST /stop` were posted as BLOCKING requests
// anyway, and both deployed decisive runs lost `bounded-layers` and
// `merkle-pack` to exactly that ceiling: `AbortSignal.timeout(180_000)` fired
// mid-publication, `call` re-posted the same checkpoint, the fixture's
// checkpoint lane serialised the two, and the retry ran a SECOND full
// publication against a box already saturated — the container 502s in those
// artifacts. Raising the deadline moves the wall to the next tree size, so the
// fixture arms a durable one-shot and the driver polls it here.
//
// ONE `op` PER SEMANTIC OPERATION, generated by the CALLER and reused across
// every retry of it. That is what makes a re-posted request structurally unable
// to start a second publication: arming is idempotent by `op`, and a poll is the
// only other request in the protocol.

/** What an arming request answers: a token to poll, never an outcome. */
interface OperationArmedReply {
  ok?: boolean;
  token?: string;
  state?: string;
  error?: string;
}

const OperationArmedReplySchema: v.GenericSchema<OperationArmedReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  token: v.optional(v.string()),
  state: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** One poll of an armed operation. `state` is the whole protocol; `outcome` and
 *  `ms` are the fixture's own, so a poll cadence never enters a measurement. */
interface OperationPollReply extends CheckpointReply {
  state?: string;
  token?: string;
}

const OperationPollReplySchema: v.GenericSchema<OperationPollReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  state: v.optional(v.string()),
  token: v.optional(v.string()),
  outcome: v.optional(v.looseObject({
    kind: v.string(),
    // Bytes THIS tick moved, reported by the strategy rather than derived.
    //
    // The alternative was differencing consecutive `bytes` readings, and that is
    // invalid by construction: `bytes` is durable bytes HELD, so a fold or rebase
    // supersedes a generation and held bytes legitimately FALL while the tick
    // moved a large archive. Two ticks in the verdict run went negative for
    // exactly that reason, and a retracted amplification claim came from reading
    // the cumulative field as a per-tick one.
    //
    // `undefined` is a truthful "not measurable here" and NOT zero: r2fs uploads
    // when the last handle closes, so no bytes attribute to a sync. Zero would
    // read as "moved nothing", which is a different claim.
    movedBytes: v.optional(v.number()),
    reason: v.optional(v.string()),
    bytes: v.optional(v.number()),
  })),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

/**
 * How long an armed operation may take, and how often it is asked.
 *
 * The deadline is `PROCESS_DEADLINE_MS`, deliberately the same number the
 * backgrounded workload phases already use: both bound work whose duration is
 * set by a remote service rather than by this driver, and a second number for
 * the same class of wait would drift from it.
 *
 * THE CADENCE BACKS OFF because the two operations differ by two orders of
 * magnitude. A ladder tick settles in a second or two and a candidate barrier
 * takes minutes: one fixed interval either adds itself to every small
 * checkpoint's wall time or asks a five-minute publication three hundred times.
 * So the first ask is prompt and each later one waits half again as long, up to
 * a ceiling. Nothing a poll costs enters a measurement — the fixture reports the
 * operation's own duration — but the run's own clock is real.
 */
const OPERATION_DEADLINE_MS = PROCESS_DEADLINE_MS;
const OPERATION_FIRST_POLL_MS = 250;
const OPERATION_POLL_CEILING_MS = 5_000;
const OPERATION_POLL_GROWTH = 1.5;

/**
 * Arm one operation and wait for its own outcome, bounded by a deadline.
 *
 * The POST is re-asked on transport loss with the SAME `op`, because a lost
 * reply leaves the caller unable to tell whether the arm landed — and under an
 * idempotent arm that question stops mattering. Every later request is a poll,
 * so nothing here can publish twice however often it is retried.
 */
async function awaitArmedOperation(
  fixture: Fixture,
  box: string,
  route: '/checkpoint' | '/stop',
  body: DriverRequest & { readonly op: string },
  bounds: { readonly pollMs?: number; readonly deadlineMs?: number } = {},
): Promise<OperationPollReply> {
  // An explicit cadence is FIXED at that value, so a test asking for a 1 ms
  // cadence gets one instead of a backoff it then has to wait out.
  const firstPollMs = bounds.pollMs ?? OPERATION_FIRST_POLL_MS;
  const pollCeilingMs = bounds.pollMs ?? OPERATION_POLL_CEILING_MS;
  const deadline = Date.now() + (bounds.deadlineMs ?? OPERATION_DEADLINE_MS);
  let armed: OperationArmedReply | null = null;
  for (let attempt = 1; armed === null; attempt += 1) {
    try {
      armed = await call(
        fixture, 'POST', `${route}?box=${box}`, OperationArmedReplySchema, body, STATE_POLL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (!isTransportLoss(parseThrown({ cause: error })) || Date.now() > deadline) throw error;
      log(`${route}: arming lost its reply on attempt ${attempt}; asking again under the same op`);
      await delay(firstPollMs);
    }
  }
  const token = armed.token;
  if (armed.ok !== true || token === undefined || token.length === 0) {
    // A refusal from the arming edge is the operation's own answer: it names a
    // route that will not run, so there is nothing to poll for.
    return { ok: false, error: armed.error ?? `${route} did not arm an operation` };
  }
  let pollMs = firstPollMs;
  for (;;) {
    await delay(pollMs);
    pollMs = Math.min(pollCeilingMs, pollMs * OPERATION_POLL_GROWTH);
    let poll: OperationPollReply;
    try {
      poll = await call(
        fixture,
        'GET',
        `/operation?box=${box}&token=${encodeURIComponent(token)}`,
        OperationPollReplySchema,
        undefined,
        STATE_POLL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // A poll that could not be asked proves nothing about the operation. It
      // is re-asked until the deadline, exactly as the startup poll re-asks
      // `/state`, because the work continues whether or not this request landed.
      const detail = describeThrown({ cause: error });
      if (Date.now() > deadline) {
        throw new Error(
          `${route} outcome could not be read before its deadline: ${detail}`,
          { cause: error },
        );
      }
      log(`${route}: outcome poll retrying: ${detail}`);
      continue;
    }
    if (poll.state === 'done' || poll.state === 'failed') return poll;
    if (poll.state !== 'pending') {
      throw new Error(`${route} answered state "${poll.state ?? 'none'}": ${poll.error ?? 'no reason given'}`);
    }
    if (Date.now() > deadline) {
      // The EFFECTIVE bound, not the default one. This named the module
      // constant while honouring `bounds.deadlineMs`, so a caller that bounded
      // an operation at 30 s was told it had waited 1,500,000 ms — the one
      // number a reader of a settle failure needs, reported wrong.
      throw new Error(
        `${route} did not settle within the ${String(bounds.deadlineMs ?? OPERATION_DEADLINE_MS)} ms `
        + `operation deadline (token ${token} still pending)`,
      );
    }
  }
}

/** How long one armed operation may take and how often to ask, overridable so
 *  the protocol's own tests do not wait out a production cadence. */
export interface OperationBounds {
  readonly pollMs?: number;
  readonly deadlineMs?: number;
}

/** One measured checkpoint, through the async protocol. `op` is generated here
 *  so a caller's own retry of THIS call re-asks one operation rather than
 *  starting another. */
export async function checkpointOperation(
  fixture: Fixture,
  box: string,
  kind: 'tick' | 'quiesce',
  what: string,
  bounds: OperationBounds = {},
): Promise<CheckpointReply> {
  const op = `${what}-${crypto.randomUUID()}`;
  return await retryTransient(what, async () =>
    await awaitArmedOperation(fixture, box, '/checkpoint', { kind, op }, bounds),
  );
}

/** One stop, through the same protocol. A stop's final checkpoint is the
 *  largest publication an arm takes, which is why it is armed too. */
export async function stopOperation(
  fixture: Fixture,
  box: string,
  what: string,
  bounds: OperationBounds = {},
): Promise<StopReply> {
  const op = `${what}-${crypto.randomUUID()}`;
  const settled = await retryTransient(what, async () =>
    await awaitArmedOperation(fixture, box, '/stop', { op }, bounds),
  );
  return {
    ok: settled.state === 'done' && settled.outcome?.kind !== 'failed',
    ms: settled.ms,
    error: settled.error ?? settled.outcome?.reason,
  };
}

/** What `/teardown` discarded and purged. The report prints this row whole and
 *  the artifact keeps it, so nothing here is read by name. */
interface TeardownReply {
  ok?: boolean;
  discarded?: boolean;
  purged?: number;
  emptyBucketGuaranteed?: boolean;
  ms?: number;
  error?: string;
}

const TeardownReplySchema: v.GenericSchema<TeardownReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  discarded: v.optional(v.boolean()),
  purged: v.optional(v.number()),
  emptyBucketGuaranteed: v.optional(v.boolean()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

export type TeardownPurgePayload = Readonly<Pick<DriverRequest, 'purge' | 'prefix' | 'whole'>>;

const TEARDOWN_PURGE_PAYLOAD: TeardownPurgePayload = { purge: true, prefix: '', whole: true };

type LiveTeardownSender = (
  fixture: Fixture,
  box: string,
  payload: TeardownPurgePayload,
  /** The elapsed bound one pass may take, or undefined for the benchmark's own
   *  unbounded purge. */
  timeoutMs?: number,
) => Promise<void>;

export async function postLiveTeardown(
  fixture: Fixture,
  box: string,
  requester: LiveTeardownHttpsRequester = requestOverHttps,
  timeoutMs?: number,
): Promise<void> {
  const responseText = await postBoundedHttps(
    fixture,
    `/teardown?box=${box}`,
    TEARDOWN_PURGE_PAYLOAD,
    requester,
    timeoutMs,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`/teardown returned non-JSON: ${responseText.slice(0, 300)}`, { cause: error });
  }
  const parsed = v.safeParse(TeardownReplySchema, decoded);
  if (!parsed.success) {
    throw new Error(
      `/teardown does not match its reply contract: ${issueText(parsed.issues)}\n${responseText.slice(0, 300)}`,
    );
  }
  if (parsed.output.ok !== true) {
    throw new Error(parsed.output.error ?? 'teardown did not confirm');
  }
}

const sendLiveTeardown: LiveTeardownSender = async (fixture, box, _payload, timeoutMs): Promise<void> => {
  await postLiveTeardown(fixture, box, requestOverHttps, timeoutMs);
};

/** Purge each possible arm twice before deleting shared fixture resources. A
 * failed first pass is recorded, never allowed to skip a sibling or the
 * idempotence pass.
 *
 * `timeoutMs` BOUNDS ONE PASS, not the sweep, and only for a caller that has a
 * ceiling to answer to: both passes are the same idempotent purge, so a pass
 * abandoned at its bound is retried by the next one rather than lost. The
 * benchmark passes nothing and keeps the unbounded purge it has always had. */
export async function teardownLiveArms(
  fixture: Fixture,
  boxes: Iterable<string>,
  send: LiveTeardownSender = sendLiveTeardown,
  timeoutMs?: number,
): Promise<readonly string[]> {
  const errors: string[] = [];
  const uniqueBoxes = [...new Set(boxes)];
  for (const pass of [1, 2]) {
    for (const box of uniqueBoxes) {
      try {
        await send(fixture, box, TEARDOWN_PURGE_PAYLOAD, timeoutMs);
      } catch (error) {
        errors.push(`live teardown pass ${pass} ${box}: ${describeThrown({ cause: error })}`);
      }
    }
  }
  return errors;
}

interface CheckpointRow {
  changeKiB: number;
  kind: 'tick' | 'quiesce';
  ms: number;
  bytes: number;
  outcome: string;
}

export interface ArmResult {
  strategy: Strategy;
  box: string;
  verifyPassed: boolean;
  verifyChecks: VerifyCheck[];
  attachColdMs: number | null;
  attachColdKind: string;
  /** Container generation the initial cold attach observed. */
  attachColdBootId: string | null;
  attachWarmMs: number | null;
  attachWarmKind: string;
  /** Generation the wake restored and the immediate second attach observed.
   * Equal, non-empty values prove the warm probe did not hide a replacement. */
  wakeBootId: string | null;
  attachWarmBootId: string | null;
  checkpoints: CheckpointRow[];
  stopMs: number | null;
  wakeMs: number | null;
  wakeKind: string;
  phases: ProbeRun[];
  /** Per-checkpoint rows from the decisive experiment, priced against R2. */
  decisiveTicks: TickRecord[];
  /**
   * Quiesces this arm took, split by whether they fell before or inside the
   * decisive window.
   *
   * WHY IT IS RECORDED. The chain rebases only at a QUIESCE, and a rebase moves
   * a full-tree archive, so a rebase landing inside a measurement window inflates
   * that arm's tick sum for a reason that has nothing to do with the strategy —
   * two runs of identical workloads with different stop counts would disagree.
   * This driver issues only ticks inside the decisive window, so the confound is
   * structurally absent rather than merely small, and these counters are how a
   * reader checks that claim instead of taking it.
   */
  quiescesBeforeDecisive: number;
  decisiveQuiesces: number;
  generationBeforeLadder: ChainGeneration | null;
  generationAfterLadder: ChainGeneration | null;
  treeBytes: Record<string, number>;
  ops: OpTally | null;
  teardown: TeardownReply | null;
  /**
   * What this arm's preregistered red witnesses DID, cell by cell.
   *
   * Empty for a candidate, which preregisters none. For a control it is the
   * whole of G2's evidence: `observed` true is the defect the control exists to
   * catch, showing up where it was predicted, and `observed` false is either a
   * cell that could not run or a defect that has silently vanished — both of
   * which refuse the run rather than passing quietly.
   */
  witnessChecks: WitnessCheck[];
  notes: string[];
}

/** Keep failed lifecycle arms out of a decision even if they produced ticks. */
export function rankableTicks<T extends TickRecord>(
  arms: readonly { readonly strategy: string; readonly verifyPassed: boolean }[],
  ticks: readonly T[],
): T[] {
  const ranked = new Set(arms.filter((arm) => arm.verifyPassed).map((arm) => arm.strategy));
  return ticks.filter((tick) => ranked.has(tick.arm));
}

async function installHarness(fixture: Fixture, box: string): Promise<void> {
  await execInBox(fixture, box, `mkdir -p ${HARNESS}`);
  for (const file of PROBE_FILES) {
    await writeFileInBox(
      fixture, box, `${HARNESS}/${file}`,
      readFileSync(join(REPO_ROOT, 'scripts/fixtures/r2-bench', file), 'utf8'),
    );
  }
}

/**
 * One metric group. Blocking exec for the cheap ones; backgrounded with a polled
 * sentinel for anything minute-scale, because the blocking path is bounded by a
 * ceiling that no timeout option raises.
 */
async function runPhase(
  fixture: Fixture, box: string, root: string, phase: string, seed: number, budgetMs: number,
): Promise<ProbeRun> {
  const base = `bun ${HARNESS}/probe.ts --root ${root} --phase ${phase} --seed ${seed} --budget-ms ${budgetMs}`;
  if (!PROCESS_PHASES.has(phase)) {
    // Reinstall once on a missing harness. NOTHING in the container survives a
    // recycle — `/` and `/workspace` are the same ext4 on `/dev/vdc` — and the
    // platform can recycle between two RPCs, so `cd: no such file or directory`
    // is a container event rather than a measurement. The layout benchmark
    // already recovers from exactly this; run 6 lost five phases to it here
    // because this driver did not.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await execInBox(fixture, box, `cd ${HARNESS} && ${base}`);
      const start = (reply.stdout ?? '').indexOf('{');
      if (start !== -1) {
        return parseProbeRun((reply.stdout ?? '').slice(start), `${phase}: blocking exec stdout, attempt ${attempt}`);
      }
      const detail = (reply.error ?? reply.stderr ?? '').slice(0, 200);
      const lost = /No such file or directory/.test(detail);
      if (!lost || attempt === 2) {
        throw new Error(`${phase}: no JSON (exit ${reply.exitCode}) ${detail}`);
      }
      log(`${phase}: the harness was gone; reinstalling and retrying once`);
      await installHarness(fixture, box);
    }
  }

  const out = `${HARNESS}/out-${phase}-${seed}.json`;
  // Same recycle hazard, checked before spawning rather than discovered by a
  // sentinel that never appears: a detached process cannot report that its own
  // interpreter was missing.
  const present = await execInBox(fixture, box, `test -f ${HARNESS}/probe.ts && echo YES || echo NO`);
  if ((present.stdout ?? '').includes('NO')) {
    log(`${phase}: the harness was gone; reinstalling before spawning`);
    await installHarness(fixture, box);
  }
  await execInBox(fixture, box, `rm -f ${out} ${out}.done`);
  await execInBox(fixture, box, `cd ${HARNESS} && nohup ${base} --out ${out} >/dev/null 2>&1 & echo spawned`);
  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (;;) {
    await delay(POLL_MS);
    const poll = await execInBox(fixture, box, `test -f ${out}.done && echo DONE || echo WAIT`);
    if ((poll.stdout ?? '').includes('DONE')) break;
    if (Date.now() > deadline) throw new Error(`${phase} did not finish within the process deadline`);
  }
  const read = await execInBox(fixture, box, `cat ${out}`);
  const start = (read.stdout ?? '').indexOf('{');
  if (start === -1) throw new Error(`${phase}: result file unreadable`);
  return parseProbeRun((read.stdout ?? '').slice(start), `${phase}: ${out} read back after the process run`);
}

/**
 * Run one decisive workload and price every checkpoint it triggers.
 *
 * The measurement that matters is the TICK, not the workload: the workload only
 * exists to put a known amount of pending change in front of a checkpoint. So
 * each segment runs, then a tick is taken, and the tick is charged with an op
 * diff taken across it — flush first so the window is closed, flush again after
 * so nothing the tick issued is still batched in an isolate.
 *
 * `unitsMoved` is whatever the strategy itself claims it moved. A chain reports
 * delta bytes; a content-addressed arm reports journal entries. Reported as null
 * with its label rather than 0 when the checkpoint said neither, because a
 * strategy that does not account for its own work is a finding.
 */
async function runDecisive(
  fixture: Fixture,
  box: string,
  arm: string,
  spec: (typeof DECISIVE_WORKLOADS)[number],
  seed: number,
  /** Which repetition of this cell is running, counting from one. Stamped on
   *  every tick, so the artifact keeps the per-repetition rows apart. */
  repetition: number,
): Promise<{ ticks: TickRecord[]; treeBytes: number; notes: string[] }> {
  const notes: string[] = [];
  const ticks: TickRecord[] = [];
  const root = `/workspace/decisive-${spec.id}`;

  // The excludes arm differs ONLY by the policy file, so the pair isolates the
  // policy rather than the workload.
  if (spec.excludes) {
    await call(fixture, 'POST', `/write?box=${box}`, AckReplySchema, {
      path: `${root}/.devboxignore`,
      content: 'node_modules/**/dist/**\n**/*.map\n.git/objects/**\n',
    });
  }

  // INTERLEAVED, one invocation per segment.
  //
  // MEASURED: running the whole workload and then taking N checkpoints produced
  // ONE tick carrying a 510 MiB cold archive and four reporting
  // `skipped (work directory is unchanged)` — because by then nothing had
  // changed since the first. Σticks was a single full-tree archive, which is the
  // exact quantity the O(p)-versus-O(c) question is NOT about. The workload is
  // now resumable by segment index so a checkpoint falls BETWEEN segments, which
  // is what makes the second and later ticks the incremental cost.
  let treeBytes = -1;
  for (let segment = 0; segment <= SEGMENTS_PER_WORKLOAD; segment++) {
    const command = `bun ${HARNESS}/decisive.ts --root ${root} --workload ${spec.workload} `
      + `--seed ${seed} --segment ${segment} ${spec.args}`;
    const reply = await execInBox(fixture, box, command);
    const start = (reply.stdout ?? '').indexOf('{');
    if (start === -1) {
      notes.push(`${spec.id} segment ${segment}: no JSON: ${(reply.error ?? reply.stderr ?? '').slice(0, 200)}`);
      continue;
    }
    const run = parseDecisiveRun((reply.stdout ?? '').slice(start), `${arm}/${spec.id}#${segment}`);
    if (run.error !== undefined) {
      notes.push(`${spec.id} segment ${segment}: ${run.error}`);
      continue;
    }
    if (run.treeBytes !== undefined && run.treeBytes > treeBytes) treeBytes = run.treeBytes;
    const segmentName = run.segments?.[0]?.name;
    if (segmentName === undefined) continue;

    // RESPECT THE MINIMUM CHECKPOINT INTERVAL, rather than measuring it.
    //
    // MEASURED: ticking immediately produced five consecutive
    // `skipped (within the minimum checkpoint interval)` outcomes on one arm, so
    // the whole workload recorded no work at all. The guard is correct product
    // behaviour; a driver that trips it is measuring the rate limiter.
    await delay(MIN_CHECKPOINT_INTERVAL_MS);

    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
    const before = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);
    const cp = await checkpointOperation(fixture, box, 'tick', `${spec.id} tick ${segmentName}`);
    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
    const after = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);

    // HELD versus MOVED are different quantities and the report keeps them apart.
    // `bytes` is the cumulative durable total; `movedBytes` is what this tick
    // actually uploaded. Absent `movedBytes` stays absent rather than becoming 0.
    const bytes = cp.outcome?.bytes;
    const moved = cp.outcome?.movedBytes;
    ticks.push({
      arm,
      workload: spec.id,
      repetition,
      segment: segmentName,
      wallMs: cp.ms ?? -1,
      classA: (after.classA ?? 0) - (before.classA ?? 0),
      classB: (after.classB ?? 0) - (before.classB ?? 0),
      classFree: (after.classFree ?? 0) - (before.classFree ?? 0),
      // NOT `?? 0`: a failed tick may have landed blobs before throwing, and
      // r2fs cannot attribute bytes to a commit boundary at all. Both answer
      // `null`, which is a different fact from a skip's honest zero.
      bytesPut: moved ?? null,
      heldBytes: bytes ?? null,
      movedReported: moved !== undefined,
      // Kept for the report's own arithmetic check.
      unitsMoved: moved ?? null,
      unitLabel: arm === 'overlay-cas' ? 'journal entries / CAS bytes' : 'delta bytes',
      outcome: cp.error !== undefined
        ? `error: ${cp.error}`
        : `${cp.outcome?.kind ?? 'unknown'}${cp.outcome?.reason !== undefined ? ` (${cp.outcome.reason})` : ''}`,
    });
  }
  return { ticks, treeBytes, notes };
}

// ── the preregistered witness cells ─────────────────────────────────────────
//
// Three of the arms ship today and each has documented defects. Each of those
// arms preregisters the red witnesses its defects must produce, and G2 refuses
// a run on either drift: a witness nobody observed (the defect went away, or
// the cell could not run) and an observed failure nobody predicted.
//
// A WITNESS PRICES AN ARM; IT DOES NOT DISQUALIFY ONE. The header here used to
// read "MANDATORY HISTORICAL CONTROLS, never production winners", and the rest
// of the instrument believed it: those three arms were marked rank-ineligible
// and could not be recommended whatever they measured. They compete now, and
// what these cells buy is a measured cost to weigh against their numbers.
//
// WHY THESE CELLS EXIST AT ALL. `observedRedChecks` was hardcoded `[]`, so every
// run carrying a control was refused for eight witnesses that nothing had ever
// tried to observe — the G2 block in both 2026-08-31 artifacts. The expectations
// were right and the observation was missing, so this is where the observing
// happens: one cell per witness, each probing the defect through the ordinary
// routes, each recording RAW facts that `controlWitnessChecks` — and nothing
// else — turns into a verdict.
//
// WHERE THEY RUN, AND WHY IT MATTERS. After the arm's own `/ops` tally is read.
// A cell writes files and takes checkpoints of its own, and an arm's operation
// count is a priced column: cells inside the measured window would bill this
// arm for operations the comparison is not about. The one exception is the
// r2fs open-write holder, which must exist BEFORE the recycle it survives.

/** One preregistered witness cell's result. `observed` is the DEFECT showing
 *  up where it was predicted — the arm is REQUIRED to produce it — never a
 *  test passing. */
export interface WitnessCheck {
  readonly name: string;
  readonly observed: boolean;
  readonly detail: string;
}

/**
 * The red witnesses each arm must produce, preregistered before the run.
 *
 * Every name is a defect its own strategy's header states in prose:
 *
 *   `mutable-delta` — "a single DELTA object that each checkpoint replaces
 *     atomically": the durable archive is a mutable object rewritten in place,
 *     not an immutable generation.
 *   `delta-layer-collapse` — a wake with a delta SERVES that delta as a lower
 *     layer, so the cumulative changed set is spread across two layers and the
 *     next checkpoint pays for a full merged archive to get back to a shape
 *     whose upper is its changed set. Both halves are stated by
 *     `packages/devbox/src/snapshot-chain.ts` and read from it rather than from
 *     memory: the attach empties the upper and mounts the delta at
 *     `deltaLayerMountPoint(<generation>)` under `lowerDeltaRoot`
 *     (`/var/tmp/devbox/lower-delta/<generation>`), newest lower first
 *     ("THE DELTA IS A LAYER, NOT A COPY", `attachChainOnce`); and `checkpoint`
 *     reads that mount back through `deltaLayerServed` and passes `layered` as
 *     `commitChain`'s `rebasing`, which mints a fresh generation id and records
 *     `delta: undefined` ("COLLAPSE RATHER THAN APPEND while a delta is served
 *     as a layer").
 *   `unbounded-pending-replay` — "replay the journal entries newer than the
 *     folded cursor": recovery is O(pending change) with no bound on pending,
 *     which is the `unbounded` restore class this arm CLAIMS.
 *   `O(u)-scan` — "scan the upper" on every tick, so an unchanged checkpoint
 *     still costs the whole writable layer.
 *   `open-write-loss` — "a file still open when the container stops loses
 *     whatever had not been closed".
 *   `non-atomic-rename` — "rename is a copy followed by a delete. It is not
 *     atomic and it costs the object's bytes".
 *   `POSIX-gap` — "there is no flush-to-store primitive": `sync` reaches s3fs
 *     and s3fs uploads on close, so a synced file is not yet durable.
 *
 * A witness is a MEASURED COST, never an eligibility filter. An arm carrying
 * one of these defects still competes and can still win: the defect is priced
 * beside its numbers and the reader weighs it. What the preregistration buys
 * is drift detection — a predicted defect that stops reproducing means the
 * instrument, the arm, or the prediction changed, and the run is refused until
 * somebody says which.
 *
 * WHY `delta-layer-collapse` REPLACED `cumulative-delta-seed`, and why the
 * witness was re-pointed rather than retired. The old name preregistered the
 * SEEDING COPY — "after an attach that had a delta, the delta's contents are
 * copied into the fresh upper" — and the wake fix deleted that copy: no live
 * path in `snapshot-chain.ts` writes a delta's bytes into the upper any more,
 * and the only thing that can leave a delta IN an upper is the upper the
 * publication itself archived (`held`, proven by the seed stamp), which is a
 * survival rather than a copy. Run 20260902154130 measured the consequence:
 * delta 244,723,712 B present, the marker NOT in the fresh upper, a seed stamp
 * naming the generation — the reading a SERVED delta produces, recorded as
 * witness drift and refusing the run under G2. The surviving code still holds a
 * cost worth pricing, so the witness names that one: serve-not-copy, and the
 * collapse the serve forces.
 */
const PREREGISTERED_WITNESSES = {
  'snapshot-chain': ['mutable-delta', 'delta-layer-collapse'],
  'overlay-cas': ['unbounded-pending-replay', 'O(u)-scan'],
  r2fs: ['open-write-loss', 'non-atomic-rename', 'POSIX-gap'],
  'bounded-layers': [],
  'merkle-pack': [],
} as const satisfies Record<Strategy, readonly string[]>;

/**
 * What the cells OBSERVED, as raw facts, one group per witness.
 *
 * A group is absent when its cell could not run, and absence is never a pass:
 * the classifier reports the witness unobserved and G2 refuses. Nothing here is
 * a verdict, so a reader can disagree with the classification while still
 * holding the measurement.
 */
export interface ControlWitnessFacts {
  readonly deltaLayerCollapse?: {
    /** The generation the wake had to serve. */
    readonly chainId: string;
    /** Bytes the store holds for that generation's delta. A wake with no delta
     *  proves nothing about how a delta is served. */
    readonly deltaBytes: number;
    /** What the wake's own attach reported, in the strategy's words:
     *  `base+delta layered` is the served shape, `base+delta already in this
     *  upper` is a container that came back with the upper its own publication
     *  archived, and that wake never had to serve the delta at all. */
    readonly attachDetail: string;
    /** Is the delta mounted as a lower layer under the overlay — the fact
     *  `deltaLayerServed` reads and the collapse below keys off? */
    readonly deltaLayerMounted: boolean;
    /** The marker this cell committed INTO the delta, read back through the
     *  merged work directory after the wake. */
    readonly markerInMergedView: boolean;
    /** The same marker looked for in the FRESH upper. A serve leaves it in the
     *  delta layer; the copy this witness used to preregister put it here. */
    readonly markerInUpper: boolean;
    /** The generation the record names after the next checkpoint. A collapse
     *  archives the merged view as a fresh base under a NEW id. */
    readonly collapsedChainId: string;
    /** Whether that record still names a delta. A collapse records none. */
    readonly collapsedNamesDelta: boolean;
  };
  readonly mutableDelta?: {
    readonly key: string;
    readonly etagBefore: string;
    readonly etagAfter: string;
    readonly bytesBefore: number;
    readonly bytesAfter: number;
  };
  readonly unboundedPendingReplay?: {
    readonly smallPending: number;
    readonly smallReplayed: number;
    readonly largePending: number;
    readonly largeReplayed: number;
  };
  readonly upperScan?: {
    readonly smallEntries: number;
    readonly smallMs: number;
    readonly largeEntries: number;
    readonly largeMs: number;
  };
  readonly openWriteLoss?: {
    readonly wroteBytes: number;
    /** Bytes readable after the recycle, or null when the path is gone. */
    readonly survivedBytes: number | null;
  };
  readonly nonAtomicRename?: {
    readonly fileBytes: number;
    /** Store operations the rename itself cost, across a flushed window. */
    readonly storeOps: number;
    readonly sourcePresent: boolean;
    readonly destinationBytes: number | null;
  };
  readonly posixGap?: {
    /** Whether the store holds the object for a path whose only writer has
     *  written and `sync`ed it and not yet closed it. */
    readonly syncedKeyPresent: boolean;
    readonly key: string;
  };
}

/** How much bigger the large scan cell's layer must be before its duration is
 *  read as scaling, and how much slower the unchanged tick over it must be. A
 *  tick proportional to the CHANGE — which is zero in both cells — would be
 *  flat, so the growth is the whole signal. */
const SCAN_ENTRY_GROWTH = 4;
const SCAN_COST_GROWTH = 2;

/**
 * Turn the cells' raw facts into this arm's witness verdicts.
 *
 * Pure and exported, so every direction is provable against hand-built facts:
 * the defect observed, the defect vanished, and the cell that never ran. The
 * order and the names come from `PREREGISTERED_WITNESSES`, so a witness can
 * never be answered by a cell that was not preregistered for this arm.
 */
export function controlWitnessChecks(
  strategy: Strategy,
  facts: ControlWitnessFacts,
): WitnessCheck[] {
  return PREREGISTERED_WITNESSES[strategy].map((name): WitnessCheck => {
    switch (name) {
      case 'delta-layer-collapse': {
        const cell = facts.deltaLayerCollapse;
        if (cell === undefined) return absentCell(name);
        // SERVED, NOT COPIED. The delta's bytes reach the merged view through a
        // layer of their own, so the marker committed into that delta is
        // readable at the work directory and absent from the writable layer the
        // attach just emptied. A copy — the behaviour this witness used to
        // preregister — puts the same marker in the upper and mounts no layer.
        const served = cell.deltaBytes > 0
          && cell.deltaLayerMounted
          && cell.markerInMergedView
          && !cell.markerInUpper;
        // AND THE SERVE IS WHAT FORCES THE COLLAPSE: a fresh generation id, and
        // a record that names no delta. Same id, or a delta still named, is an
        // ordinary append — which is what a copied delta produces.
        const collapsed = cell.collapsedChainId.length > 0
          && cell.collapsedChainId !== cell.chainId
          && !cell.collapsedNamesDelta;
        return {
          name,
          observed: served && collapsed,
          detail: `delta ${cell.deltaBytes}B, `
            + `${cell.deltaLayerMounted ? 'mounted as a lower layer' : 'NOT mounted as a layer'}; `
            + `the merged view ${cell.markerInMergedView ? 'holds' : 'does NOT hold'} the marker and `
            + `the fresh upper ${cell.markerInUpper ? 'HOLDS it, so the attach copied the delta' : 'does not, so the delta is served'}`
            + ` (attach: ${cell.attachDetail || '(none)'}); the next checkpoint `
            + `${collapsed
              ? `collapsed onto fresh base ${cell.collapsedChainId} naming no delta`
              : `did NOT collapse: the record names generation ${cell.collapsedChainId || '(none)'}`
                + ` ${cell.collapsedNamesDelta ? 'and still names a delta' : 'and no delta'}`}`,
        };
      }
      case 'mutable-delta': {
        const cell = facts.mutableDelta;
        if (cell === undefined) return absentCell(name);
        const rewritten = cell.etagBefore.length > 0
          && cell.etagAfter.length > 0
          && cell.etagBefore !== cell.etagAfter;
        return {
          name,
          observed: cell.key.length > 0 && rewritten,
          detail: `${cell.key}: ${cell.bytesBefore}B etag ${cell.etagBefore || '(none)'} then `
            + `${cell.bytesAfter}B etag ${cell.etagAfter || '(none)'} — one key, `
            + `${rewritten ? 'rewritten in place' : 'NOT rewritten'}`,
        };
      }
      case 'unbounded-pending-replay': {
        const cell = facts.unboundedPendingReplay;
        if (cell === undefined) return absentCell(name);
        // UNBOUNDED means the replay follows the pending set rather than a
        // constant: more pending, strictly more replayed.
        const grew = cell.largePending > cell.smallPending
          && cell.largeReplayed > cell.smallReplayed
          && cell.smallReplayed > 0;
        return {
          name,
          observed: grew,
          detail: `${cell.smallPending} pending replayed ${cell.smallReplayed} entries, `
            + `${cell.largePending} pending replayed ${cell.largeReplayed} — `
            + `${grew ? 'the replay follows the pending set' : 'the replay did NOT follow the pending set'}`,
        };
      }
      case 'O(u)-scan': {
        const cell = facts.upperScan;
        if (cell === undefined) return absentCell(name);
        const layerGrew = cell.largeEntries >= cell.smallEntries * SCAN_ENTRY_GROWTH;
        const costGrew = cell.largeMs >= cell.smallMs * SCAN_COST_GROWTH;
        return {
          name,
          observed: layerGrew && costGrew && cell.smallMs > 0,
          detail: `an unchanged tick cost ${cell.smallMs}ms over ${cell.smallEntries} entries and `
            + `${cell.largeMs}ms over ${cell.largeEntries} — layer ${layerGrew ? 'grew' : 'did NOT grow'} `
            + `${String(SCAN_ENTRY_GROWTH)}x, cost ${costGrew ? 'grew' : 'did NOT grow'} with it`,
        };
      }
      case 'open-write-loss': {
        const cell = facts.openWriteLoss;
        if (cell === undefined) return absentCell(name);
        const lost = cell.wroteBytes > 0
          && (cell.survivedBytes === null || cell.survivedBytes < cell.wroteBytes);
        return {
          name,
          observed: lost,
          detail: `${cell.wroteBytes}B written through a handle held open across the stop; `
            + `${cell.survivedBytes === null ? 'the path is gone after the wake' : `${cell.survivedBytes}B survived`}`,
        };
      }
      case 'non-atomic-rename': {
        const cell = facts.nonAtomicRename;
        if (cell === undefined) return absentCell(name);
        // A rename that costs the store anything is a copy: the object arrives
        // under a new key and the old key is deleted, which is not an atomic
        // metadata move however fast it is.
        const copied = cell.storeOps > 0
          && !cell.sourcePresent
          && cell.destinationBytes !== null
          && cell.destinationBytes > 0;
        return {
          name,
          observed: copied,
          detail: `renaming ${cell.fileBytes}B cost ${cell.storeOps} store operation(s); source `
            + `${cell.sourcePresent ? 'still present' : 'deleted'}, destination `
            + `${cell.destinationBytes === null ? 'absent' : `${cell.destinationBytes}B`}`,
        };
      }
      case 'POSIX-gap': {
        const cell = facts.posixGap;
        if (cell === undefined) return absentCell(name);
        return {
          name,
          observed: !cell.syncedKeyPresent,
          detail: `${cell.key} was written and \`sync\`ed with its handle still open and the store `
            + `${cell.syncedKeyPresent ? 'HOLDS it, so a flush-to-store primitive exists' : 'holds nothing: there is no flush-to-store primitive'}`,
        };
      }
      default:
        return absentCell(name);
    }
  });
}

/** A cell that produced no facts proves nothing, so its witness is unobserved
 *  and G2 refuses. Named rather than inlined at eight sites so the reason a
 *  refusal gives is one sentence rather than eight. */
function absentCell(name: string): WitnessCheck {
  return {
    name,
    observed: false,
    detail: 'this witness cell produced no observation, so nothing was witnessed',
  };
}

/** Paths the cells read INSIDE the container. Each is the constant its own
 *  strategy publishes (`DEVBOX_WORKDIR` and `DEVBOX_RUNTIME_DIR` in
 *  `packages/devbox/src/storage.ts`; `upperDir` and `lowerDeltaRoot` in
 *  `packages/devbox/src/snapshot-chain.ts`), restated here for the same reason
 *  the lifecycle checks above restate `/var/tmp/devbox/upper`: this driver
 *  reads a deployed container over HTTP and imports nothing from the box it
 *  measures. */
const DEVBOX_WORK_DIR = '/workspace';
const CHAIN_UPPER_DIR = '/var/tmp/devbox/upper';
/** One directory per served generation, named after it: `deltaLayerMountPoint`
 *  is `${lowerDeltaRoot}/<generation>`, and its presence in `/proc/mounts` is
 *  the same fact `deltaLayerServed` reads to decide the collapse. */
const CHAIN_DELTA_LAYER_ROOT = '/var/tmp/devbox/lower-delta';

/** Entry counts the two scan cells run at, and pending sizes the two replay
 *  cells leave. Small enough to cost seconds, far enough apart that a cost
 *  following the layer is unmistakable. */
const SCAN_CELL_ENTRIES = [200, 2_000] as const;
const PENDING_CELL_ENTRIES = [50, 500] as const;
/** A rename big enough that a copy is not free and small enough to be quick. */
const RENAME_CELL_KIB = 1_024;

/** The holder an r2fs arm leaves running across its recycle, and what the store
 *  already said about the path it holds. Named because two cells consume it. */
interface OpenWriteHolder {
  readonly path: string;
  readonly wroteBytes: number;
  /** Whether the store held the object while the writer's handle was open and
   *  its bytes had been `sync`ed — the `POSIX-gap` observation. */
  readonly syncedKeyPresent: boolean;
  readonly key: string;
  readonly notes: readonly string[];
}

/**
 * What an r2fs arm must have in place BEFORE the recycle it is measured across.
 *
 * A detached writer holds a handle open over bytes it has written and `sync`ed,
 * which is the state both r2fs semantic witnesses are about: the store holds
 * nothing for that path while the handle is open (`POSIX-gap`), and the bytes do
 * not survive the container that dies holding it (`open-write-loss`). It must be
 * spawned before the stop, so it is the one cell that cannot wait until the
 * arm's tally has been read.
 */
async function armOpenWriteHolder(
  fixture: Fixture,
  box: string,
): Promise<OpenWriteHolder> {
  const notes: string[] = [];
  const path = '/workspace/witness-open-write.bin';
  const payload = `witness-open-write-${crypto.randomUUID()}`;
  // ONE detached shell, holding fd 9 open for longer than the arm's remaining
  // lifetime: `printf` writes, `sync` pushes the kernel's dirty pages into
  // s3fs, and the handle is never closed. `nohup … &` because `/exec` waits for
  // the command it runs.
  await execInBox(
    fixture,
    box,
    `nohup sh -c 'exec 9>${path}; printf %s ${payload} >&9; sync; sleep 1800' >/dev/null 2>&1 & echo spawned`,
  );
  // Long enough for the write and the sync to have happened, short enough that
  // nothing in the arm waits on it. The claim under test is that neither makes
  // the bytes durable, so a delay cannot manufacture the observation.
  await delay(3_000);
  const state = await boxState(fixture, box);
  const prefix = state.storePrefix ?? '';
  const key = prefix.length === 0 ? '' : `${prefix}witness-open-write.bin`;
  let syncedKeyPresent = false;
  if (key.length === 0) {
    notes.push('the POSIX-gap cell could not run: /state reported no store prefix for this arm');
  } else {
    const head = await headObject(fixture, box, key);
    syncedKeyPresent = head.exists === true && (head.size ?? 0) >= payload.length;
  }
  return { path, wroteBytes: payload.length, syncedKeyPresent, key, notes };
}

/** The pending entries an overlay-cas attach replayed, as the strategy's own
 *  attach detail publishes them (`overlay-cas folded <cursor> <pending>P`).
 *  Parsed rather than inferred: the count is the restore receipt's, and a detail
 *  this driver cannot read is a cell that did not run rather than a zero. */
function replayedEntries(detail: string): number | null {
  const matched = /folded \d+ (\d+)P/.exec(detail);
  return matched === null ? null : Number.parseInt(matched[1]!, 10);
}

/**
 * One pending-replay point: write `entries` files, journal them WITHOUT folding,
 * kill the container, and read what the healing attach replayed.
 *
 * A tick journals and does not fold; only a quiesce folds. So a kill after a
 * tick leaves exactly the state a platform replacement leaves — staged entries,
 * an unadvanced cursor, no boot marker — and the next commit heals the box,
 * which is the attach whose replay is being counted.
 */
async function pendingReplayPoint(
  fixture: Fixture,
  box: string,
  entries: number,
): Promise<{ replayed: number | null; detail: string }> {
  const root = `/workspace/witness-pending-${String(entries)}`;
  await execInBox(
    fixture,
    box,
    `mkdir -p ${root} && i=1; while [ $i -le ${String(entries)} ]; do `
    + `printf %s pending-$i > ${root}/f$i.txt; i=$((i+1)); done; sync`,
  );
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  await checkpointOperation(fixture, box, 'tick', `pending cell ${String(entries)} journal`);
  await call(fixture, 'POST', `/kill?box=${box}`, AckReplySchema, {});
  // The commit is what heals a replaced container, and healing is what runs the
  // attach whose replay this cell counts.
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  await checkpointOperation(fixture, box, 'tick', `pending cell ${String(entries)} heal`);
  const state = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
  const detail = state.state?.lastAttach?.detail ?? '';
  return { replayed: replayedEntries(detail), detail };
}

/**
 * One scan point: bring the writable layer to `entries` files, commit them, then
 * time a tick that changes NOTHING.
 *
 * An unchanged tick is the whole cell: overlay-cas decides "unchanged" BY
 * scanning the upper, so what it costs is the scan and nothing else. The
 * duration is the fixture's own measurement of that checkpoint.
 */
async function upperScanPoint(
  fixture: Fixture,
  box: string,
  entries: number,
): Promise<{ entries: number; ms: number }> {
  const root = '/workspace/witness-scan';
  await execInBox(
    fixture,
    box,
    `mkdir -p ${root} && i=1; while [ $i -le ${String(entries)} ]; do `
    + `printf %s scan-$i > ${root}/f$i.txt; i=$((i+1)); done; sync`,
  );
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  await checkpointOperation(fixture, box, 'tick', `scan cell ${String(entries)} commit`);
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  const unchanged = await checkpointOperation(fixture, box, 'tick', `scan cell ${String(entries)} unchanged`);
  const counted = await execInBox(fixture, box, 'find /workspace -type f | wc -l');
  return {
    entries: Number.parseInt((counted.stdout ?? '0').trim(), 10) || 0,
    ms: unchanged.ms ?? -1,
  };
}

/**
 * Run this arm's preregistered witness cells and answer what they observed.
 *
 * Every cell is bounded and independent: one that throws records its reason and
 * leaves its own facts absent, which the classifier reads as an unobserved
 * witness and G2 refuses. A cell is never allowed to take the arm down with it —
 * the rows this arm already measured are worth more than the cell.
 *
 * An arm with no preregistered witness runs no cells and answers no facts; it
 * is not a special case here, just an empty list in `PREREGISTERED_WITNESSES`.
 */
async function runControlWitnessCells(
  fixture: Fixture,
  box: string,
  strategy: Strategy,
  input: {
    /** The holder the pre-stop hook left behind, for the two r2fs cells that
     *  are about a handle held open across a container's death. */
    readonly openWrite: OpenWriteHolder | null;
  },
): Promise<{ facts: ControlWitnessFacts; notes: string[] }> {
  const notes: string[] = [...(input.openWrite?.notes ?? [])];
  const facts: {
    -readonly [Key in keyof ControlWitnessFacts]: ControlWitnessFacts[Key];
  } = {};
  const cell = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      notes.push(`the ${name} witness cell did not complete: ${describeThrown({ cause: error }).slice(0, 240)}`);
    }
  };
  const headKey = async (key: string): Promise<HeadReply> =>
    await call(fixture, 'GET', `/head?box=${box}&key=${encodeURIComponent(key)}`, HeadReplySchema);

  if (strategy === 'snapshot-chain') {
    // MUTABLE-DELTA FIRST, and the order is load-bearing: the collapse cell
    // below drops this arm's measured trees and recycles the box, so running it
    // first would leave this cell comparing two heads of a generation that had
    // just been superseded.
    await cell('mutable-delta', async () => {
      const before = await deltaAfterOneChange(fixture, box, 'a');
      const after = await deltaAfterOneChange(fixture, box, 'b');
      if (before.chainId !== after.chainId) {
        throw new Error(
          `the chain rebased between the two heads (${before.chainId} then ${after.chainId}), so the `
          + 'cell compared two generations rather than one key',
        );
      }
      facts.mutableDelta = {
        key: after.key,
        etagBefore: before.etag,
        etagAfter: after.etag,
        bytesBefore: before.bytes,
        bytesAfter: after.bytes,
      };
    });
    // THE WAKE THIS CELL NEEDS IS ITS OWN.
    //
    // The claim is about a wake WITH A DELTA, and the arm's own recycle cannot
    // witness it: that wake ran before the workload phases, and by the time the
    // cells run the record has moved on several generations. So the cell commits
    // a marker INTO a delta, recycles the box, and reads both halves back.
    //
    // THE MEASURED TREES GO FIRST, which is what keeps the cell cheap AND keeps
    // its premise true. Every number this arm produced is already settled to its
    // own artifact. Dropping the trees leaves a delta of whiteouts plus one
    // marker, so the stop's own quiesce cannot rebase — `shouldRebase` asks
    // `delta > base` — and the collapse below archives a merged view of
    // kilobytes instead of the gigabyte the decisive workloads leave.
    await cell('delta-layer-collapse', async () => {
      const marker = `delta-layer-${crypto.randomUUID()}`;
      const markerFile = 'witness-delta-layer.txt';
      const harness = basename(HARNESS);
      await execInBox(
        fixture,
        box,
        `find ${DEVBOX_WORK_DIR} -mindepth 1 -maxdepth 1 ! -name ${harness} -exec rm -rf {} + `
        + `&& printf %s ${marker} > ${DEVBOX_WORK_DIR}/${markerFile} && sync`,
      );
      await delay(MIN_CHECKPOINT_INTERVAL_MS);
      // A TICK, NOT A QUIESCE: a quiesce over the delta the decisive window
      // left would rebase, and the wake would then have a bare base to attach
      // and nothing to serve as a layer.
      const seeded = await checkpointOperation(
        fixture, box, 'tick', 'delta-layer-collapse marker commit',
      );
      if (seeded.outcome?.kind !== 'committed') {
        throw new Error(
          `the marker commit did not publish a delta to serve: `
          + `${seeded.outcome?.kind ?? 'unknown'}${seeded.outcome?.reason === undefined ? '' : ` (${seeded.outcome.reason})`}`,
        );
      }
      const stopped = await stopOperation(fixture, box, 'delta-layer-collapse stop');
      if (stopped.ok !== true) {
        throw new Error(`the box did not stop: ${stopped.error ?? 'the stop did not confirm'}`);
      }
      const woke = await startupOperation(
        fixture, box, '/wake', 'delta-layer-collapse wake', ['attached'],
      );
      // THE SERVED GENERATION IS THE ONE THE RECORD NAMES AFTER THE WAKE, never
      // the one named before it: an attach that fell back to its retained
      // fallback serves a different generation, and reading the pre-stop id
      // would describe a generation nothing is mounted from.
      const served = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
      const chainId = served.state?.chain?.base?.id ?? '';
      if (chainId.length === 0) throw new Error('/state reported no chain generation after the wake');
      const delta = await headKey(`${served.storePrefix ?? ''}backups/${chainId}/delta.sqsh`);
      const mounts = await execInBox(fixture, box, 'cat /proc/mounts');
      const inMergedView = await execInBox(
        fixture, box, `test -f ${DEVBOX_WORK_DIR}/${markerFile} && echo yes || echo no`,
      );
      const inUpper = await execInBox(
        fixture, box, `test -f ${CHAIN_UPPER_DIR}/${markerFile} && echo yes || echo no`,
      );
      // THE NEXT CHECKPOINT, with something to say: a box that woke and wrote
      // nothing is skipped with `nothing has been written since the attach`, so
      // the collapse would never be reached.
      await execInBox(
        fixture, box, `printf %s ${marker}-after > ${DEVBOX_WORK_DIR}/witness-collapse.txt && sync`,
      );
      await delay(MIN_CHECKPOINT_INTERVAL_MS);
      await checkpointOperation(fixture, box, 'tick', 'delta-layer-collapse next checkpoint');
      const collapsed = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
      const collapsedChain = collapsed.state?.chain;
      facts.deltaLayerCollapse = {
        chainId,
        deltaBytes: delta.exists === true ? delta.size ?? 0 : 0,
        attachDetail: woke.attach.detail,
        deltaLayerMounted: mountAt(mounts.stdout ?? '', `${CHAIN_DELTA_LAYER_ROOT}/${chainId}`) !== null,
        markerInMergedView: (inMergedView.stdout ?? '').trim() === 'yes',
        markerInUpper: (inUpper.stdout ?? '').trim() === 'yes',
        collapsedChainId: collapsedChain?.base?.id ?? '',
        collapsedNamesDelta: collapsedChain?.delta !== undefined && collapsedChain?.delta !== null,
      };
    });
  }

  if (strategy === 'overlay-cas') {
    await cell('O(u)-scan', async () => {
      const small = await upperScanPoint(fixture, box, SCAN_CELL_ENTRIES[0]);
      const large = await upperScanPoint(fixture, box, SCAN_CELL_ENTRIES[1]);
      facts.upperScan = {
        smallEntries: small.entries,
        smallMs: small.ms,
        largeEntries: large.entries,
        largeMs: large.ms,
      };
    });
    await cell('unbounded-pending-replay', async () => {
      const small = await pendingReplayPoint(fixture, box, PENDING_CELL_ENTRIES[0]);
      const large = await pendingReplayPoint(fixture, box, PENDING_CELL_ENTRIES[1]);
      if (small.replayed === null || large.replayed === null) {
        throw new Error(
          `the healing attach published no replay count (details: "${small.detail}", "${large.detail}")`,
        );
      }
      facts.unboundedPendingReplay = {
        smallPending: PENDING_CELL_ENTRIES[0],
        smallReplayed: small.replayed,
        largePending: PENDING_CELL_ENTRIES[1],
        largeReplayed: large.replayed,
      };
    });
  }

  if (strategy === 'r2fs') {
    await cell('open-write-loss', async () => {
      const holder = input.openWrite;
      if (holder === null) throw new Error('no open-write holder was armed before the stop');
      const read = await execInBox(fixture, box, `wc -c < ${holder.path} 2>/dev/null || echo MISSING`);
      const text = (read.stdout ?? '').trim();
      facts.openWriteLoss = {
        wroteBytes: holder.wroteBytes,
        survivedBytes: text === 'MISSING' || text.length === 0 ? null : Number.parseInt(text, 10),
      };
    });
    await cell('POSIX-gap', async () => {
      const holder = input.openWrite;
      if (holder === null) throw new Error('no open-write holder was armed before the stop');
      if (holder.key.length === 0) throw new Error('the arm published no store prefix to head');
      facts.posixGap = { syncedKeyPresent: holder.syncedKeyPresent, key: holder.key };
    });
    await cell('non-atomic-rename', async () => {
      const state = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
      const prefix = state.storePrefix ?? '';
      if (prefix.length === 0) throw new Error('/state reported no store prefix for this arm');
      const source = 'witness-rename-src.bin';
      const destination = 'witness-rename-dst.bin';
      await execInBox(
        fixture,
        box,
        `dd if=/dev/urandom of=/workspace/${source} bs=1024 count=${String(RENAME_CELL_KIB)} 2>/dev/null && sync`,
      );
      // A FLUSHED WINDOW AROUND THE RENAME ALONE. The tally batches in the
      // proxy isolate, so an unflushed boundary would price the write before it
      // against the rename.
      await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
      const before = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);
      await execInBox(fixture, box, `mv /workspace/${source} /workspace/${destination} && sync`);
      await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
      const after = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);
      const sourceHead = await headKey(`${prefix}${source}`);
      const destinationHead = await headKey(`${prefix}${destination}`);
      facts.nonAtomicRename = {
        fileBytes: RENAME_CELL_KIB * 1024,
        storeOps: (after.total ?? 0) - (before.total ?? 0),
        sourcePresent: sourceHead.exists === true,
        destinationBytes: destinationHead.exists === true ? destinationHead.size ?? 0 : null,
      };
    });
  }

  return { facts, notes };
}

/** One change, one tick, and the delta object's identity afterwards. Two of
 *  these either side of a change are what the `mutable-delta` cell compares. */
async function deltaAfterOneChange(
  fixture: Fixture,
  box: string,
  label: string,
): Promise<{ chainId: string; key: string; etag: string; bytes: number }> {
  await execInBox(fixture, box, `printf %s mutable-delta-${label} > /workspace/witness-delta-${label}.txt && sync`);
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  await checkpointOperation(fixture, box, 'tick', `mutable-delta cell ${label}`);
  const state = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
  const chainId = state.state?.chain?.base?.id ?? '';
  if (chainId.length === 0) throw new Error('/state reported no chain generation');
  const key = `${state.storePrefix ?? ''}backups/${chainId}/delta.sqsh`;
  const head = await call(
    fixture, 'GET', `/head?box=${box}&key=${encodeURIComponent(key)}`, HeadReplySchema,
  );
  return { chainId, key, etag: head.etag ?? '', bytes: head.size ?? 0 };
}

/**
 * What the store must hold for the generation a chain record names — and what it
 * must NOT hold.
 *
 * MEASURED INSTRUMENT DEFECT THIS REPAIRS. The chain arm's post-wake check asked
 * for `backups/<generation>/delta.sqsh` whatever the record said, so a record
 * with no delta failed it. That is not an exotic state: `shouldRebase` collapses
 * the chain onto a fresh base as soon as the delta outgrows the base, and the
 * ladder's own 64 MiB rung does exactly that — run 20260831184750 published a
 * bare base of 71,389,184 bytes as its last commit, which is the whole tree and
 * not a base plus a delta. The arm then reported a failed verify for holding the
 * shape its strategy documents, and G1 refused it.
 *
 * BOTH DIRECTIONS, because "the object the record names is there" is only half
 * of the contract. A delta object under a generation whose record names none is
 * an archive nothing points at: either a publication that lost its record or a
 * sweep that never ran, and both are findings rather than noise.
 */
export interface ChainArchiveExpectation {
  readonly name: string;
  readonly key: string;
  /** Must the store hold this object, or must it not? */
  readonly present: boolean;
}

export function chainArchiveExpectations(
  chainId: string | undefined,
  recordNamesDelta: boolean,
  /** The box's own store prefix, as `/state` reports it (`boxes/<id>/`). Chain
   *  generations live under it — one prefix per box rather than a namespace
   *  shared by every box — so a key built without it names nothing. */
  storePrefix = '',
): ChainArchiveExpectation[] {
  if (chainId === undefined || chainId.length === 0) return [];
  const root = `${storePrefix}backups/${chainId}`;
  return [
    {
      name: 'the base object the record names exists in the store with non-zero size',
      key: `${root}/data.sqsh`,
      present: true,
    },
    recordNamesDelta
      ? {
          name: 'the delta object the record names exists in the store with non-zero size',
          key: `${root}/delta.sqsh`,
          present: true,
        }
      : {
          name: 'the store holds no delta for a generation whose record names none',
          key: `${root}/delta.sqsh`,
          present: false,
        },
  ];
}

export function isTransientContainerCreateError(error: string | undefined): boolean {
  return /no container instance|container service is unreachable|try again later|ContainerUnavailable|OperationInterrupted/i
    .test(error ?? '');
}

/**
 * A refusal the BOX itself says to retry, in the box's own words.
 *
 * `Devbox.ensureReady()` writes three sentences and only the terminal one is a
 * verdict: it names `attachNow()`. The other two — a startup armed and a retry
 * under way — say the operation arrived while the box was starting, which is
 * the ordinary state of a container that was created a moment ago. Matching
 * the product's own phrases keeps the two readings in one place; a driver that
 * inferred re-armability from a phase code would be reading a field the reply
 * does not carry.
 */
export function isRearmableStartupRefusal(error: string | undefined): boolean {
  return /a startup is armed, so ask again|a retry is already under way/i.test(error ?? '');
}

/**
 * One arm's result before anything is measured: every number absent, nothing
 * proven. Shared with the run loop, which records exactly this shape plus the
 * reason when an arm dies mid-measurement — a second copy of the literal there
 * would drift from this one field by field.
 */
function unmeasuredArm(strategy: Strategy, box: string, notes: string[]): ArmResult {
  return {
    strategy, box, verifyPassed: false, verifyChecks: [],
    attachColdMs: null, attachColdKind: '', attachColdBootId: null,
    attachWarmMs: null, attachWarmKind: '', wakeBootId: null, attachWarmBootId: null,
    checkpoints: [], stopMs: null, wakeMs: null, wakeKind: '',
    phases: [], decisiveTicks: [], quiescesBeforeDecisive: 0, decisiveQuiesces: 0,
    generationBeforeLadder: null, generationAfterLadder: null,
    treeBytes: {}, ops: null, teardown: null, witnessChecks: [], notes,
  };
}

async function measureArm(
  fixture: Fixture,
  strategy: Strategy,
  options: Options,
  noteLiveBox: (box: string) => void,
  /** Hand the arm's own row to the caller BEFORE anything is measured into it.
   *
   *  MEASURED DEFECT THIS REPAIRS. A refusal at the wake or the warm attach
   *  threw out of here, and the run loop's catch then replaced the whole arm
   *  with `unmeasuredArm` — so both 2026-08-31 artifacts carry five arms of
   *  nulls and one note each, while the cold attach, the checkpoint ladder and
   *  the workload phases those runs really measured were discarded with the
   *  exception. The row is a single mutable object filled in as the arm
   *  proceeds, so a caller holding it keeps every step that completed. */
  observe: (row: ArmResult) => void = () => {},
): Promise<ArmResult> {
  // ONE BOX PER ARM: mountBucket refuses a second mount of one binding at a
  // different prefix or readOnly value, so the arms cannot share an instance.
  const boxBase = `ab-${strategy}-${options.runId}`;
  let box = boxBase;
  const notes: string[] = [];
  const result = unmeasuredArm(strategy, box, notes);
  observe(result);
  noteLiveBox(box);

  /** Write this arm's row to its own durable file at every phase boundary.
   *
   *  The row is one mutable object the whole pipeline fills in, so what this
   *  writes is exactly what the arm has settled so far — never a copy that can
   *  disagree with the row the run-level assembly will read. A write that
   *  itself throws is logged and swallowed: the artifact is a safety net, and
   *  a net that trips the measurement it was catching has stopped being one.
   *  Failures here are visible in the log and in `readArmArtifact`'s verdict
   *  when the run-level assembly reads the file back. */
  const settle = (what: string): void => {
    try {
      writeArmArtifact(REPO_ROOT, options.runId, strategy, result);
    } catch (error) {
      log(`the durable arm artifact could not be written after ${what}: ${describeThrown({ cause: error })}`);
    }
  };
  settle('the arm started');
  const teardown = async (): Promise<ArmResult> => {
    if (result.teardown === null) {
      result.teardown = await call(
        fixture,
        'POST',
        `/teardown?box=${box}`,
        TeardownReplySchema,
        { purge: true, prefix: '', whole: true },
      );
    }
    return result;
  };

  /** Every startup this arm measures, with the driver's own contribution to the
   *  number recorded beside it. A startup the driver had to drive is a real
   *  startup cost and stays in the row, but a reader has to be able to see that
   *  the fixture's schedule was not what completed it. */
  const startup = async (
    path: '/create' | '/wake',
    operation: string,
    allowedKinds: readonly string[],
  ): Promise<StartupCompletion> => {
    const completed = await startupOperation(fixture, box, path, operation, allowedKinds);
    if (completed.redrives > 0) {
      notes.push(
        `${operation}: the driver drove readiness ${completed.redrives}x through a no-op exec `
        + 'because /state reported the container stopped with no restoration started',
      );
    }
    return completed;
  };

  log('create (cold attach)');
  let cold: StartupCompletion;
  try {
    cold = await startup('/create', 'cold attach', ['empty', 'attached']);
  } catch (error) {
    // Logged as well as noted. A create failure ends this arm and the run
    // continues to the next one, so an operator watching the log otherwise sees
    // the arm's banner followed by the NEXT arm's and no reason at all —
    // overlay-cas failed here twice in a row and said why only inside the
    // artifact.
    const note = `create failed: ${describeThrown({ cause: error })}`;
    log(note);
    notes.push(note);
    settle('a refused create');
    return result;
  }
  result.attachColdMs = cold.ms;
  result.attachColdKind = cold.attach.kind;
  result.attachColdBootId = cold.state.state?.bootId ?? null;
  settle('the cold attach');
  log('install harness');
  await installHarness(fixture, box);

  const verify = (name: string, pass: boolean, detail: string): void => {
    result.verifyChecks.push({ name, pass, detail });
  };
  const markerFile = '.devbox-verify-marker.txt';
  const marker = `devbox-verify-${crypto.randomUUID()}`;
  const markerWrite = await retryTransient('marker write', async () =>
    await execInBox(fixture, box, `printf %s ${marker} > ./${markerFile} && cat ./${markerFile}`),
  );
  verify(
    'default cwd is the durable work directory',
    markerWrite.exitCode === 0 && (markerWrite.stdout ?? '').includes(marker),
    `exit ${markerWrite.exitCode ?? 'unknown'}, cwd default /workspace${markerWrite.error === undefined ? '' : `: ${markerWrite.error}`}`,
  );

  // The checkpoint ladder is the verification commit. Its first forced quiesce
  // carries the marker and its normal rows remain the measurement rows.
  log('ops reset and ladder');
  await call(fixture, 'POST', `/ops/reset?box=${box}`, AckReplySchema);

  // The checkpoint ladder writes known bytes, then records each commit.
  result.generationBeforeLadder = await chainGeneration(fixture, box);
  for (const kib of CHANGE_SIZES_KIB) {
    await retryTransient(`ladder ${kib}KiB write`, async () =>
      await execInBox(fixture, box, `mkdir -p /workspace/ladder && dd if=/dev/urandom of=/workspace/ladder/c${kib}.bin bs=1024 count=${kib} 2>/dev/null && sync`),
    );
    for (const kind of ['quiesce', 'tick'] as const) {
      if (kind === 'quiesce') result.quiescesBeforeDecisive++;
      const cp = await checkpointOperation(fixture, box, kind, `ladder ${kib}KiB ${kind}`);
      result.checkpoints.push({
        changeKiB: kib,
        kind,
        ms: cp.ms ?? -1,
        bytes: cp.outcome?.bytes ?? -1,
        outcome: cp.error !== undefined ? `error: ${cp.error}` : `${cp.outcome?.kind ?? 'unknown'}${cp.outcome?.reason !== undefined ? ` (${cp.outcome.reason})` : ''}`,
      });
      if (kib === CHANGE_SIZES_KIB[0] && kind === 'quiesce') {
        verify(
          'the first checkpoint MOVED bytes into the store',
          cp.outcome?.kind === 'committed'
            && (cp.outcome.movedBytes === undefined || cp.outcome.movedBytes > 0),
          `${cp.outcome?.kind ?? 'unknown'} moved=${cp.outcome?.movedBytes ?? 'n/a'} held=${cp.outcome?.bytes ?? 0}B ${cp.error ?? cp.outcome?.reason ?? ''}`.trim(),
        );
      }
    }
  }
  // THE ONE CELL THAT CANNOT WAIT. `open-write-loss` and `POSIX-gap` are both
  // about a handle held open across a container's death, so the holder has to
  // exist before the stop that kills it. Everything else this arm witnesses
  // runs after its operation tally is read — see `runControlWitnessCells`.
  let openWrite: OpenWriteHolder | null = null;
  if (strategy === 'r2fs') {
    try {
      openWrite = await armOpenWriteHolder(fixture, box);
    } catch (error) {
      notes.push(`the r2fs open-write holder was not armed: ${describeThrown({ cause: error }).slice(0, 240)}`);
    }
  }

  // The normal recycle follows the normal ladder. Each request is independently
  // retryable if a replacement interrupts it; nothing reruns the whole proof.
  log('stop then wake');
  const stopped = await stopOperation(fixture, box, 'stop');
  result.stopMs = stopped.ms ?? null;
  const woke = await startup('/wake', 'wake', ['attached']);
  result.wakeMs = woke.ms;
  result.wakeKind = woke.attach.kind;
  result.wakeBootId = woke.state.state?.bootId ?? null;
  settle('the wake');
  verify(
    'the wake attached durable bytes',
    result.wakeKind === 'attached',
    result.wakeKind || 'no attach recorded',
  );

  const afterWake = woke.state;
  const mode = afterWake.state?.chain?.mode;
  const mounts = await retryTransient('work-directory mount read', async () =>
    await execInBox(fixture, box, 'cat /proc/mounts'),
  );
  const mountText = mounts.stdout ?? '';
  // The row for the work directory itself, matched on the MOUNTPOINT field.
  // The previous `grep -F /workspace` also matched a device name or an option
  // containing that text, and took whichever line came first.
  const workdirMount = mountAt(mountText, '/workspace');
  const mountLine = workdirMount?.line ?? '';

  const survived = await retryTransient('marker read after wake', async () =>
    await execInBox(fixture, box, `cat ./${markerFile} 2>/dev/null || echo MISSING`),
  );
  verify(
    'the pre-stop write survived the recycle',
    (survived.stdout ?? '').includes(marker),
    (survived.stdout ?? survived.error ?? '').trim().slice(0, 80),
  );

  const head = async (name: string, key: string | undefined): Promise<void> => {
    if (key === undefined) {
      verify(name, false, '(no durable object key recorded)');
      return;
    }
    const found = await retryTransient(`${name} head`, async () =>
      await headObject(fixture, box, key),
    );
    verify(
      name,
      found.exists === true && (found.size ?? 0) > 0,
      found.error ?? `${key} -> ${found.exists === true ? `${found.size ?? 0}B` : 'missing'}`,
    );
  };

  /** One expectation about the store, in whichever direction the record set. */
  const archive = async (expectation: ChainArchiveExpectation): Promise<void> => {
    if (expectation.present) {
      await head(expectation.name, expectation.key);
      return;
    }
    const found = await retryTransient(`${expectation.name} head`, async () =>
      await headObject(fixture, box, expectation.key),
    );
    verify(
      expectation.name,
      found.exists !== true,
      `${expectation.key} -> ${found.exists === true ? `${found.size ?? 0}B, which the record does not name` : 'absent'}`,
    );
  };

  // ONE BRANCH PER ARM, dispatched on the STRATEGY the driver asked for and
  // never on a mode the box happened to report. Every arm's surface is proven
  // against its own contract; there is no branch a strategy can fall into by
  // resembling another one.
  const writableLayer = async (path: string): Promise<void> => {
    const exists = await retryTransient('writable-layer read', async () =>
      await execInBox(fixture, box, `test -d ${path} && echo yes || echo no`),
    );
    verify('the writable layer exists', (exists.stdout ?? '').trim() === 'yes', `${path} -> ${(exists.stdout ?? '').trim()}`);
  };
  const lowerLayer = async (name: string, path: string): Promise<void> => {
    const lower = await retryTransient(`${name} read`, async () =>
      await execInBox(fixture, box, `test -d ${path} && grep -qs " ${path} " /proc/mounts && echo yes || echo no`),
    );
    verify(name, (lower.stdout ?? '').trim() === 'yes', `${path} -> ${(lower.stdout ?? '').trim()}`);
  };

  if (strategy === 'bounded-layers' || strategy === 'merkle-pack') {
    const facts = await retryTransient('candidate lifecycle facts', async () =>
      await call(fixture, 'GET', `/candidate?box=${box}`, CandidateFactsReplySchema),
    );
    for (const check of candidateLifecycleChecks(strategy, facts)) {
      verify(check.name, check.pass, check.detail);
    }
  } else if (strategy === 'r2fs') {
    verify(
      '/workspace is really a s3fs mount',
      workdirMount?.fstype.includes('s3fs') === true,
      mountLine.length > 0 ? mountLine : '(no mount line)',
    );
    await writableLayer('/var/tmp/devbox/r2fs-cache');
    await head('the store holds the committed marker', afterWake.storePrefix === undefined
      ? undefined
      : `${afterWake.storePrefix}${markerFile}`);
  } else if (strategy === 'overlay-cas') {
    verify(
      '/workspace is really a overlay mount',
      workdirMount?.fstype.includes('overlay') === true,
      mountLine.length > 0 ? mountLine : '(no mount line)',
    );
    await writableLayer('/var/tmp/devbox/cas-upper');
    await lowerLayer('the tree lower is present and mounted at its lower path', '/var/tmp/devbox/cas-lower');
    await head('the folded tree holds the committed marker', afterWake.storePrefix === undefined
      ? undefined
      : `${afterWake.storePrefix}tree/${markerFile}`);
    await head('the fold advanced the durable cursor', afterWake.storePrefix === undefined
      ? undefined
      : `${afterWake.storePrefix}cursor.json`);
  } else if (mode === 'chain') {
    verify(
      '/workspace is really a overlay mount',
      workdirMount?.fstype.includes('overlay') === true,
      mountLine.length > 0 ? mountLine : '(no mount line)',
    );
    await writableLayer('/var/tmp/devbox/upper');
    await lowerLayer('the base layer is present and mounted at its lower path', '/var/tmp/devbox/lower-base');
    // WHAT THE RECORD NAMES, IN BOTH DIRECTIONS. This asked for `delta.sqsh`
    // unconditionally, and a chain that has just collapsed onto a fresh base
    // names no delta and has no such object — so the arm failed its own verify
    // for holding exactly the shape its strategy documents. `shouldRebase`
    // makes that the ORDINARY end of a ladder whose delta outgrows its base,
    // and it is what the last quiesce of run 20260831184750 published.
    const chain = afterWake.state?.chain;
    const expectations = chainArchiveExpectations(
      chain?.base?.id,
      chain?.delta !== undefined && chain?.delta !== null,
      afterWake.storePrefix ?? '',
    );
    if (expectations.length === 0) {
      verify('the record names a generation to check the store against', false, '(no chain generation recorded)');
    }
    for (const expectation of expectations) await archive(expectation);
  } else {
    // The chain in EXTRACTION mode, which is the only arm this branch can now
    // hold: r2fs, overlay-cas and both candidates are dispatched above.
    verify(
      '/workspace is a plain directory, as extraction mode requires',
      mountLine.length === 0,
      mountLine.length === 0 ? `mode ${mode ?? 'none'}: no mount expected` : `mode ${mode ?? 'none'} but mounted: ${mountLine}`,
    );
    verify(
      'extraction is permitted on this host',
      afterWake.extractionAllowed === true,
      `ALLOW_EXTRACTION=${afterWake.extractionAllowed === true ? '1' : '(unset)'}`,
    );
    const chainId = afterWake.state?.chain?.base?.id;
    await head(
      mode === 'extract'
        ? 'the archive object exists in the store with non-zero size'
        : 'the delta object exists in the store with non-zero size',
      chainId === undefined
        ? undefined
        : `${afterWake.storePrefix ?? ''}backups/${chainId}/${mode === 'extract' ? 'data.sqsh' : 'delta.sqsh'}`,
    );
  }
  result.verifyPassed = result.verifyChecks.every((check) => check.pass);
  settle('the lifecycle proof');
  if (!result.verifyPassed) {
    notes.push('LIFECYCLE VERIFY FAILED: this arm measured a blank disk and is not ranked');
    notes.push(...result.verifyChecks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`).slice(0, 6));
  }

  /** One phase run, appended to the arm's rows whatever it answers. A phase
   *  that throws records its reason and leaves the row absent, which G9 then
   *  counts as one repetition fewer rather than as a silent success. */
  const measurePhase = async (phase: string, what: string): Promise<void> => {
    try {
      result.phases.push(await runPhase(fixture, box, `/workspace/ab-${strategy}`, phase, options.seed, options.budgetMs));
    } catch (error) {
      const reason = describeThrown({ cause: error });
      log(`phase ${what} failed: ${reason.slice(0, 160)}`);
      notes.push(`phase ${what} did not complete: ${reason.slice(0, 240)}`);
    }
    // FLUSH AT THE PHASE BOUNDARY, not a settle-and-hope.
    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
  };

  log('workload phases');
  for (const phase of PHASES) await measurePhase(phase, phase);

  // THE DECIDING PHASE, REPEATED. G9 scores the DISPERSION of the deciding
  // metric's repetitions and censors a cell that has fewer than two, so a run
  // measuring it once produced no statistical claim at all — the refusal every
  // arm of run 20260902154130 carried. Which phase to repeat is read back from
  // what the first pass MEASURED rather than named here, so the deciding metric
  // can move between phases without this loop repeating the wrong one.
  const decidingPhases = phasesMeasuring(result.phases, DECIDING_METRIC);
  if (decidingPhases.length === 0 && options.repetitions > 1) {
    notes.push(
      `no phase measured the deciding metric \`${DECIDING_METRIC}\`, so its `
      + `${options.repetitions} repetitions could not be run`,
    );
  }
  for (let repetition = 2; repetition <= options.repetitions; repetition += 1) {
    for (const phase of decidingPhases) {
      log(`deciding phase ${phase}, repetition ${repetition} of ${options.repetitions}`);
      await measurePhase(phase, `${phase} repetition ${repetition}`);
    }
  }
  log(
    `the deciding metric \`${DECIDING_METRIC}\` was measured `
    + `${metricRows(result, DECIDING_METRIC).length} time(s) over phase(s) `
    + `${decidingPhases.length === 0 ? '(none)' : decidingPhases.join(', ')}`,
  );

  result.generationAfterLadder = await chainGeneration(fixture, box);
  settle('the workload phases');

  // THE DECISIVE EXPERIMENT. Placed after the workload phases and BEFORE
  // stop/wake, deliberately: these workloads leave hundreds of megabytes behind,
  // and a wake measured across that tree would be measuring the tree rather than
  // rows and nothing else.
  //
  // EVERY WORKLOAD n TIMES, one repetition after another, and each tick carries
  // the repetition it belongs to: the artifact keeps the per-repetition rows so
  // a reader can see the spread rather than only the pooled sum the report
  // prices.
  if (options.decisive) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const spec of DECISIVE_WORKLOADS) {
        log(`decisive ${spec.id}, repetition ${repetition} of ${options.repetitions}`);
        try {
          // A timed-out container operation can stop the spot container and lose
          // the harness with it. Reinstall through the box before each workload;
          // this is also the attach/replay probe for the replacement generation.
          await installHarness(fixture, box);
          const run = await runDecisive(fixture, box, strategy, spec, options.seed, repetition);
          result.decisiveTicks.push(...run.ticks);
          // THE LARGEST TREE ANY REPETITION MEASURED. The workload is resumable
          // by segment, so a later repetition re-runs the same segments over the
          // tree the previous one left: taking the maximum keeps the recorded
          // size the one the ticks ran against instead of the last reading.
          result.treeBytes[spec.id] = Math.max(result.treeBytes[spec.id] ?? -1, run.treeBytes);
          notes.push(...run.notes);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          log(`decisive ${spec.id} repetition ${repetition} failed: ${reason.slice(0, 160)}`);
          notes.push(
            `decisive ${spec.id} repetition ${repetition} did not complete: ${reason.slice(0, 240)}`,
          );
        }
      }
    }
  }


  // Warm attach: a second kick observes the already attached generation.
  const warm = await startup('/create', 'warm attach', ['attached']);
  result.attachWarmMs = warm.ms;
  result.attachWarmKind = warm.attach.kind;
  result.attachWarmBootId = warm.state.state?.bootId ?? null;
  settle('the warm attach');

  log('ops accounting and teardown');
  await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
  result.ops = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);

  // THE WITNESS CELLS, after the tally and before the teardown.
  //
  // An arm with preregistered defects is here to prove the instrument can still
  // SEE them; G2 refuses a run whose arm produced none of the ones it promised.
  // The cells write their own files and take their own checkpoints, so they run
  // past the priced window on purpose: an arm billed for its witness cells
  // would report a cost the comparison is not about.
  //
  // DERIVED from the preregistration, never a second copy of its membership.
  // The hardcoded `snapshot-chain || r2fs || overlay-cas` this replaces was the
  // same three-arm taxonomy that kept those arms out of the ranking, and a
  // fourth arm given a witness would have silently never run its cells.
  if (PREREGISTERED_WITNESSES[strategy].length > 0) {
    log('witness cells');
    const witnessed = await runControlWitnessCells(fixture, box, strategy, { openWrite });
    result.witnessChecks = controlWitnessChecks(strategy, witnessed.facts);
    notes.push(...witnessed.notes);
    const unobserved = result.witnessChecks.filter((witness) => !witness.observed);
    if (unobserved.length > 0) {
      notes.push(
        `WITNESS DRIFT: ${unobserved.map((witness) => `${witness.name} (${witness.detail})`).join('; ')}`,
      );
    }
  }

  settle('the witness cells');

  // Everything below is CLEANUP, and a cleanup failure is not a measurement
  // failure. The 2026-08-29 02:42 run lost a fully measured `bounded-layers`
  // arm and never started `merkle-pack` because the release below timed out and
  // threw out of here, 70 minutes in: the numbers were already collected and
  // were discarded with the exception. So a step here records its reason and
  // the arm still returns what it measured. Nothing is hidden by that —
  // `teardownLiveArms` still sweeps the box and still reports under G8.
  const cleanupStep = async (what: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      const note = `${what} failed after the arm was measured: ${describeThrown({ cause: error })}`;
      log(note);
      notes.push(note);
    }
  };

  await cleanupStep('teardown', async () => { await teardown(); });

  // RELEASE THE CONTAINER before the next arm starts.
  //
  // MEASURED: run 7's second arm failed EVERY phase with `Maximum number of
  // the first arm's box was still up — its own stop→wake measurement had
  // deliberately woken it and the warm-attach check kept it there — so the
  // second arm could never get an instance. One box per arm is required for
  // correctness, because mountBucket refuses a second mount of one binding at a
  // different prefix or readOnly value; the consequence is that each arm must
  // hand its instance BACK rather than merely stop using it. A release that
  // fails therefore costs the NEXT arm its instance, which that arm reports as
  // its own create refusal — a localized, named failure instead of a dead run.
  await cleanupStep('box release', async () => {
    const released = await stopOperation(fixture, box, 'box release');
    if (released.ok !== true) {
      notes.push(`the box was not released after the arm: ${released.error ?? 'stop did not confirm'}`);
    }
  });
  settle('the arm finished');
  return result;
}

/** How long a release is given after an arm already failed. Short on purpose:
 *  the box is being handed back so the NEXT arm can have an instance, and a
 *  stop that cannot settle must not spend the run's remaining time proving it. */
const FAILED_ARM_RELEASE_DEADLINE_MS = 120_000;

/**
 * A failed arm keeps every row it measured, and ranks nothing.
 *
 * The refusal is written down TWICE, in the two places that read for different
 * reasons: a note, which the report prints under "What did not hold", and a
 * failed verify row, which is what `verifyPassed` — and therefore ranking,
 * `armCompletedTheCell` and G1 — is derived from. Setting the flag without the
 * row would leave a reader with a false arm and no failing check to point at.
 */
export function refuseFailedArm(arm: ArmResult, reason: string): ArmResult {
  arm.notes.push(reason);
  arm.verifyChecks.push({ name: 'the arm completed every measured step', pass: false, detail: reason });
  arm.verifyPassed = false;
  return arm;
}

// ── durable per-arm artifacts ───────────────────────────────────────────────
//
// MEASURED DEFECT THIS REPAIRS: the 20260831233915 decisive run and the
// devbox-e2e-e2ecal0901002202 calibration both spent hours measuring arms whose
// rows existed only inside the process that measured them. The run-level
// artifact is written once, at the end, by the same process — so a wedged
// sibling, a killed driver or a run that never reached its own assembly left
// NOTHING but a log. An arm's settled measurements are the one thing the run
// cannot afford to lose to a process it does not control, so every arm writes
// its own row to disk the moment it settles, and the final assembly reads those
// files rather than trusting its own memory.

/** Where one run's per-arm artifacts live: under `bench-artifacts`, one
 *  directory per run, one file per arm. The run id — not the `--out` basename —
 *  is the directory, so two runs sharing a `--out` path never collide and one
 *  run's directory holds exactly the arms that run requested. */
export function armArtifactDir(repoRoot: string, runId: string): string {
  return join(repoRoot, 'bench-artifacts', runId);
}

export function armArtifactPath(repoRoot: string, runId: string, arm: Strategy): string {
  return join(armArtifactDir(repoRoot, runId), `${arm}.json`);
}

/** What one arm's own artifact holds: the row, and the log tail.
 *
 *  The row is the same `ArmResult` the run-level artifact assembles from, so
 *  there is no second shape to keep in agreement. The log tail is the driver's
 *  own last words about the arm — bounded by `ARM_LOG_TAIL_LINES` — which is
 *  all an arm that never settled can offer. `settledAt` dates the write, so a
 *  reader comparing this file against a run-level artifact that never landed can
 *  see WHICH of the two is missing rather than guessing. */
export interface ArmArtifact<Row = ArmResult> {
  readonly schema: 'devbox-arm-artifact/1';
  readonly arm: Strategy;
  readonly runId: string;
  readonly settledAt: string;
  readonly logTail: readonly string[];
  readonly row: Row;
}

/** The file's contract, parsed at the boundary like every wire reply here. The
 *  ROW is left unparsed on purpose: two drivers write two row shapes through
 *  this one writer, and the envelope — schema, arm, run — is what a reader has
 *  to be able to trust before it reads either. */
const ArmArtifactSchema: v.GenericSchema<ArmArtifact<unknown>> = v.looseObject({
  schema: v.literal('devbox-arm-artifact/1'),
  arm: v.picklist(STRATEGIES),
  runId: v.string(),
  settledAt: v.string(),
  logTail: v.array(v.string()),
  row: v.unknown(),
});

/**
 * Write one arm's row to its own file, atomically, the moment it settles.
 *
 *  ATOMICALLY (tmp + rename, the repo's own `writeLedger` pattern): the reader
 *  of this file is a process that has already lost its sibling, and a file cut
 *  off mid-write by that same death would be a second wedge sitting on the
 *  first. `rename` within one filesystem is the one write a reader either sees
 *  whole or does not see at all.
 *
 *  THE MOMENT IT SETTLES, not once at the end: called at every phase boundary
 *  with whatever the row holds, so the file is monotone — a cold attach, a
 *  ladder, a wake each overwrite the last partial row — and a kill between
 *  boundaries costs at most the phase in flight, never a number that already
 *  landed. Success and refusal both write, because a refusal IS the arm's
 *  settled answer.
 */
export function writeArmArtifact<Row>(
  repoRoot: string,
  runId: string,
  arm: Strategy,
  row: Row,
): ArmArtifact<Row> {
  const artifact: ArmArtifact<Row> = {
    schema: 'devbox-arm-artifact/1',
    arm,
    runId,
    settledAt: new Date().toISOString(),
    logTail: armLogTail(arm),
    row,
  };
  const path = armArtifactPath(repoRoot, runId, arm);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
  renameSync(temporary, path);
  return artifact;
}

/** What one arm's settled artifact read back as. `error` is set only when a
 *  file EXISTS and cannot be used — an absent file is a verdict of its own
 *  (externally-aborted), not a read failure, and conflating the two would hide
 *  a wedged arm behind a missing one. */
export interface ReadArmArtifact {
  readonly artifact: ArmArtifact | null;
  readonly error: string | null;
}

/**
 * Read one arm's settled artifact back from disk.
 *
 *  The run-level assembly reads THESE FILES rather than the rows it still holds
 *  in memory, which is the whole point: a wedged arm's siblings settled on disk
 *  before the wedge, and the assembly must not depend on having watched them
 *  settle. A file that cannot be used is reported rather than skipped — an
 *  `externally-aborted` row carrying the read failure is a finding, while an
 *  unreadable file read as "never measured" would be one more silent loss.
 */
export function readArmArtifact(repoRoot: string, runId: string, arm: Strategy): ReadArmArtifact {
  const path = armArtifactPath(repoRoot, runId, arm);
  if (!existsSync(path)) return { artifact: null, error: null };
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    return { artifact: null, error: `unreadable (${path}): ${describeThrown({ cause })}` };
  }
  const parsed = v.safeParse(ArmArtifactSchema, decoded);
  if (!parsed.success) {
    return {
      artifact: null,
      error: `not an arm artifact (${path}): ${issueText(parsed.issues)}`,
    };
  }
  // SAFETY: the envelope is parsed above; the row is whatever THIS run's own
  // lane wrote through `writeArmArtifact` minutes earlier, and the decisive
  // assembly is the only reader of the `ArmResult` shape it wrote itself. A
  // cross-driver read would need its own row parse and has no caller.
  return { artifact: parsed.output as ArmArtifact, error: null };
}

/**
 * The row for an arm this process never saw settle.
 *
 *  `reason` names what happened to the run rather than to the arm — the arm's
 *  own answer lives in its durable file when it has one, and the two must not
 *  wear each other's words. The log tail rides along as `log:` notes because
 *  that is the shape the report already prints for a failed arm.
 */
export function externallyAbortedArm(arm: Strategy, box: string, reason: string): ArmResult {
  // The tail first, the verdict last: `refuseFailedArm` appends the reason as
  // the closing note and as the failed lifecycle check, so writing it here too
  // would print it twice in a report whose whole job is to be read.
  const notes = armLogTail(arm).map((line) => `log: ${line}`);
  return refuseFailedArm(unmeasuredArm(arm, box, notes), `externally-aborted: ${reason}`);
}

/**
 * Measure one arm, and keep what it measured when it fails.
 *
 * TWO THINGS A MID-MEASUREMENT FAILURE USED TO COST, and this is where both are
 * paid back. The rows: the run loop replaced the arm with `unmeasuredArm`, so
 * every measured number was nulled and one note survived — the shape of every
 * arm in both 2026-08-31 artifacts. The instance: nothing released the box, so
 * the failed arm kept the class's only container instance and the NEXT arm's
 * create refused with `Maximum number of instances`, which is how one arm's
 * death took the arms behind it.
 */
export async function runArm(
  fixture: Fixture,
  strategy: Strategy,
  options: Options,
  noteLiveBox: (box: string) => void,
): Promise<ArmResult> {
  let partial: ArmResult | null = null;
  try {
    return await measureArm(fixture, strategy, options, noteLiveBox, (row) => { partial = row; });
  } catch (error) {
    const reason = `arm failed mid-measurement: ${describeThrown({ cause: error })}`;
    log(reason);
    const measured = partial ?? unmeasuredArm(strategy, `ab-${strategy}-${options.runId}`, []);
    try {
      const released = await stopOperation(fixture, measured.box, 'release after failure', {
        deadlineMs: FAILED_ARM_RELEASE_DEADLINE_MS,
      });
      if (released.ok !== true) {
        measured.notes.push(
          `the failed arm's box was not released: ${released.error ?? 'stop did not confirm'}`,
        );
      }
    } catch (releaseError) {
      measured.notes.push(
        `the failed arm's box could not be released: ${describeThrown({ cause: releaseError })}`,
      );
    }
    // The refusal is the arm's settled answer, and it goes to disk like every
    // other settled one — a killed run must not be able to lose the reason an
    // arm died, which is the one fact the next reader of that arm needs.
    const refused = refuseFailedArm(measured, reason);
    try {
      writeArmArtifact(REPO_ROOT, options.runId, strategy, refused);
    } catch (writeError) {
      log(`the durable arm artifact could not be written after the failure: ${describeThrown({ cause: writeError })}`);
    }
    return refused;
  }
}

/** One arm's whole measured pipeline, from its first request to its last. */
export type ArmLane = (strategy: Strategy) => Promise<ArmResult>;

/**
 * Every arm's lane, in flight at once, and every arm's failure its own.
 *
 * WHY CONCURRENCY DOES NOT MOVE A MEASUREMENT. An arm is measured inside its
 * OWN container: each arm has its own Worker, its own Durable Object class and
 * therefore its own container application, and `instance_type` reserves that
 * container's vCPU, memory and disk. Two arms never share a container, so no
 * measured operation shares CPU with another arm's — running five arms at once
 * is five separate instances doing the same work they would do alone, not five
 * workloads dividing one machine. What the arms do share is THIS process, and
 * everything it does inside this window is I/O: HTTPS requests to the fixture
 * and the poll loops that wait on them. Every duration inside an arm is either
 * the fixture's own `ms`, measured in the container, or a poll loop whose time
 * is spent waiting on the network.
 *
 * WHAT THEREFORE MAY NOT RUN HERE, and why the caller deploys and deletes
 * outside this window: `runWrangler` is `execFileSync`. A wrangler call does
 * not wait on I/O from this loop's point of view — it STOPS the loop, so no
 * sibling can poll for its duration, and a cold attach is a driver-side wall
 * clock held to a 25s admission ceiling. One arm's deploy or delete inside
 * this window would be charged to another arm's attach.
 *
 * PER-ARM FAILURE ISOLATION. A lane that throws is recorded as ITS OWN arm's
 * refusal and nothing more. `Promise.all` rejects on the first throw, so
 * without this catch one arm's death would abandon every sibling still in
 * flight — unreported, unranked and with nothing having released their boxes —
 * which is exactly the failure the sequential loop's per-arm await was there to
 * prevent. The refused row keeps the shape a reader already knows: a note, a
 * failed lifecycle check, and nothing ranked.
 */
export async function runArmsInFlight(
  arms: readonly Strategy[],
  runId: string,
  lane: ArmLane,
): Promise<ArmResult[]> {
  // `Promise.all` answers in the order it was given, which is the order the
  // report, the admission record and the decision pair read the arms in.
  return await Promise.all(arms.map(async (strategy): Promise<ArmResult> =>
    await armLogContext.run(strategy, async (): Promise<ArmResult> => {
      try {
        return await lane(strategy);
      } catch (error) {
        const reason = `arm lane failed: ${describeThrown({ cause: error })}`;
        log(reason);
        // A lane that never reached `measureArm` owns no `settle` boundary, so
        // the refusal is written here — the artifact for this arm must exist
        // whatever shape the failure took, or the run-level assembly would read
        // its absence as an external abort. The row is a REFUSED one carrying
        // the log tail, because a lane failure is this run's own answer about
        // the arm, not something external that happened to the run.
        const refused = refuseFailedArm(unmeasuredArm(
          strategy,
          `ab-${strategy}-${runId}`,
          armLogTail(strategy).map((line) => `log: ${line}`),
        ), reason);
        try {
          writeArmArtifact(REPO_ROOT, runId, strategy, refused);
        } catch (writeError) {
          log(`the durable arm artifact could not be written after the lane failure: ${describeThrown({ cause: writeError })}`);
        }
        return refused;
      }
    })));
}

// ── report ──────────────────────────────────────────────────────────────────

/**
 * One row per probe run that measured `name`: its median and its own wall time.
 *
 * The RAW repetitions, kept rather than summarized here, because two different
 * consumers need different things from them — the report wants a central value
 * and G9 wants the dispersion of the repetitions themselves. Deriving both from
 * one collection is what stops the gate from judging a number the table never
 * showed.
 */
function metricRows(arm: ArmResult, name: string): { p50: number; wallMs: number }[] {
  const rows: { p50: number; wallMs: number }[] = [];
  for (const run of arm.phases) {
    for (const phase of run.phases) {
      for (const metric of phase.metrics) {
        if (metric.name === name) rows.push({ p50: metric.summary.p50, wallMs: metric.wallMs });
      }
    }
  }
  return rows;
}

/**
 * Which phases actually produced `metric`, as THIS run measured it.
 *
 * DERIVED FROM THE MEASUREMENT, never declared beside it. The repetition loop
 * has to know which phase to run again, and a hardcoded `small1k` would be a
 * second copy of a mapping that lives in the probe fixture: move the deciding
 * metric to another phase and the loop would faithfully repeat a phase that no
 * longer measures it, leaving G9 with one repetition and no way to see why.
 * Exported so the repetition contract is provable against hand-built rows.
 */
export function phasesMeasuring(runs: readonly ProbeRun[], metric: string): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const phase of run.phases) {
      if (phase.metrics.some((row) => row.name === metric)) names.add(phase.phase);
    }
  }
  return [...names];
}

function metricSummary(arm: ArmResult, name: string): Summary | null {
  const rows = metricRows(arm, name);
  return rows.length === 0 ? null : summarize(rows.map((row) => row.p50));
}

const num = (value: number | null, digits = 2): string => {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(digits);
};

const HEADLINE = [
  'write-10MiB', 'read-10MiB', 'reread-10MiB', 'random-read-4KiB',
  'small-create-1k', 'small-stat-1k', 'small-read-1k', 'small-delete-1k',
  'archive-extract-300-files', 'npmlike-install-write', 'npmlike-resolve-probe',
  'rename-file', 'rename-file-4MiB',
] as const;

/** The artifact's header, printed as-is above the tables. `INCOMPLETE` is how a
 *  run that stopped early says so rather than looking whole. */
export interface RunMeta {
  date: string;
  /** The run itself, which is the one name every arm's resources are derived
   *  from. The rows below name a Worker and a bucket PER ARM, so neither of
   *  them identifies the run on its own. */
  run: string;
  worker: string;
  bucket: string;
  image: string;
  seed: string;
  'loop budget ms': string;
  /** Repetitions of each deciding cell the run asked for, so the header states
   *  the intent the per-arm counts below are read against. */
  'deciding repetitions': string;
  'frozen controls provenance'?: string;
  INCOMPLETE?: string;
}

/**
 * Every ratio this instrument may take: one challenger against the incumbent.
 *
 * DERIVED FROM `STRATEGIES`, never listed. The hand-written list this replaces
 * held two pairs — `bounded-layers` vs `merkle-pack` and `snapshot-chain` vs
 * `overlay-cas` — and its header said the shipped arms "can never be a
 * production winner". Both halves were instrument bugs. `r2fs` appeared in no
 * pair, so the one arm with a full set of preregistered semantic defects was
 * also the one arm whose cost was never compared to anything; and a
 * candidate-versus-candidate ratio decides which challenger is better without
 * ever asking whether either beats what production runs today.
 *
 * The ruling: every strategy competes against `INCUMBENT`. A challenger
 * replaces it by beating it on the decisive workloads under the same admission
 * gates — not by belonging to a set the instrument declared eligible.
 */
const DECISION_PAIRS: readonly {
  readonly baseline: Strategy;
  readonly candidate: Strategy;
  readonly purpose: string;
}[] = CHALLENGERS.map((challenger) => ({
  baseline: INCUMBENT,
  candidate: challenger,
  purpose: `whether \`${challenger}\` displaces the deployed \`${INCUMBENT}\``,
}));

export interface ComparedPair {
  readonly baseline: Strategy;
  readonly candidate: Strategy;
  readonly purpose: string;
}

export type DecisionPairs =
  | { readonly kind: 'pairs'; readonly pairs: readonly ComparedPair[] }
  | { readonly kind: 'absent'; readonly reason: string };

/**
 * Every incumbent-versus-challenger ratio this run can actually take, derived
 * from the arms it MEASURED rather than named beside the table.
 *
 * ALL of them, not the first that matches. The single-pair predecessor returned
 * the most specific pair it could find and the report printed exactly one
 * ratio, so a five-arm run — the shape this driver deploys by default — decided
 * the default on one comparison and silently discarded the other three.
 *
 * MEASURED DEFECT THIS REPAIRS. The caller before that one read
 *
 *     const candidate = STRATEGIES.find((id) => id === 'overlay-cas');
 *     if (candidate !== undefined) { decide(ticks, 'snapshot-chain', candidate); }
 *
 * over a frozen five-element constant, so the guard was true on every run and
 * the else-branch beside it was unreachable. A two-arm run therefore printed a
 * decision rule whose ratio was taken over `snapshot-chain` and `overlay-cas`:
 * two arms it never deployed, never measured, and could not have measured,
 * because their durable-object bindings are absent from the generated config.
 */
export function comparablePairs(arms: readonly { readonly strategy: string }[]): DecisionPairs {
  const present = new Set(arms.map((arm) => arm.strategy));
  const pairs = DECISION_PAIRS.filter(
    (pair) => present.has(pair.baseline) && present.has(pair.candidate),
  );
  if (pairs.length > 0) return { kind: 'pairs', pairs };
  const measured = arms.length === 0
    ? 'no arms'
    : arms.map((arm) => `\`${arm.strategy}\``).join(', ');
  return {
    kind: 'absent',
    reason: present.has(INCUMBENT)
      ? `This run measured ${measured}, so it carries the incumbent \`${INCUMBENT}\` and no challenger `
        + 'to compare against it.'
      : `This run measured ${measured}, and the incumbent \`${INCUMBENT}\` is not among them. Every ratio `
        + 'this instrument takes is a challenger against the incumbent, so a run without it can rank its '
        + 'arms against each other but cannot say whether any of them displaces what production runs.',
  };
}

export function renderFrozenControls(controls: readonly FrozenControl[]): string {
  const out = [
    '#### Frozen controls (not ranked)',
    '',
    'These schema-validated external rows provide context only. They come from a PREVIOUS run, so they '
    + 'never enter this run\'s ranking, which uses only arms this run measured.',
  ];
  if (controls.length === 0) {
    out.push('', 'Historical context is unavailable: no `--control <strategy>=<path>` was supplied.');
    return out.join('\n');
  }
  out.push('', '| control | status | why | provenance | date | worker | bucket | image | seed | loop budget ms |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const control of controls) {
    out.push(
      `| \`${control.strategy}\` | ${FROZEN_CONTROL_LABEL[control.status]} | ${control.statusDetail} `
      + `| \`${control.artifact}#sha256:${control.sha256}\` | ${control.date} `
      + `| ${control.worker ?? '—'} | ${control.bucket ?? '—'} | \`${control.image}\` `
      + `| ${control.seed} | ${control.budgetMs} |`,
    );
  }
  return out.join('\n');
}

function render(
  arms: readonly ArmResult[],
  meta: RunMeta,
  admission: AdmissionVerdict,
  frozenControls: readonly FrozenControl[] = [],
  renderControlContext = false,
): string {
  const out: string[] = [];
  const compared = arms.map((arm) => `\`${arm.strategy}\``).join(' vs ');
  out.push(`### Devbox storage strategies: ${compared}`);
  out.push('');
  for (const [key, value] of Object.entries(meta)) out.push(`- ${key}: \`${value}\``);
  out.push('');

  out.push('#### Lifecycle proof, first, per arm');
  if (renderControlContext || frozenControls.length > 0) {
    out.push(renderFrozenControls(frozenControls));
    out.push('');
  }
  out.push('');
  out.push('| arm | lifecycle proof | failing checks |');
  out.push('| --- | --- | --- |');
  for (const arm of arms) {
    const failing = arm.verifyChecks.filter((c) => !c.pass).map((c) => `\`${c.name}\``).join(', ');
    out.push(`| \`${arm.strategy}\` | ${arm.verifyPassed ? 'PASSED' : '**FAILED**'} | ${failing === '' ? '—' : failing} |`);
  }
  out.push('');
  out.push(
    'An arm whose lifecycle proof fails measured the container\'s own blank disk. Its rows below are '
    + 'recorded for diagnosis and are NOT ranked.',
  );
  out.push('');

  const ticks = arms.flatMap((arm) => arm.decisiveTicks);
  if (ticks.length > 0) {
    out.push('#### The decisive experiment');
    out.push('');
    out.push(
      'Three workloads, chosen because each makes PENDING CHANGE and CHANGED SET diverge, '
      + 'with a checkpoint between every segment. The measurement is the TICK; the workload only '
      + 'exists to put a known amount of pending change in front of one. Priced at R2 published '
      + `rates: $${R2_CLASS_A_USD_PER_MILLION.toFixed(2)}/M class A, `
      + `$${R2_CLASS_B_USD_PER_MILLION.toFixed(2)}/M class B.`,
    );
    out.push('');
    out.push(
      'NO NETWORK on these containers, so neither `npm install` nor `git clone` can run. Both are '
      + 'reproduced by their filesystem SHAPE — a generated dependency tree and a locally seeded '
      + 'repository with 200 real commits — which is what the storage layer sees either way. The '
      + 'git arm uses real `git`, so its index rewrites and object churn are genuine.',
    );
    out.push('');
    out.push(
      'One confound is structurally absent rather than argued away. The chain rebases only at a '
      + 'QUIESCE, and a rebase moves a full-tree archive, so a rebase inside a measurement window '
      + 'would inflate that arm\'s tick sum for a reason unrelated to the strategy — two runs of '
      + 'identical workloads with different stop counts would disagree. This driver issues ONLY '
      + 'ticks inside the decisive window, and the quiesce counts below are how a reader checks '
      + 'that rather than taking it.',
    );
    out.push('');
    out.push('| arm | quiesces before the window | quiesces inside it | rebased in the ladder |');
    out.push('| --- | --- | --- | --- |');
    for (const arm of arms) {
      const before = arm.generationBeforeLadder;
      const after = arm.generationAfterLadder;
      // OBSERVED, not weighed. A rebase writes a fresh base uuid and drops the
      // delta, so the pair answers it outright. `n/a` is a non-chain arm, which
      // is the interesting half: overlay-cas never rebases, so a chain that does
      // is a structural difference reproducing on every run with this ladder.
      const rebased = before === null || after === null
        ? 'not read'
        : before.baseId === null && after.baseId === null
          ? 'n/a (not a chain)'
          : before.baseId !== after.baseId
            ? `YES (${String(before.baseId).slice(0, 8)} -> ${String(after.baseId).slice(0, 8)})`
            : 'no';
      out.push(
        `| \`${arm.strategy}\` | ${arm.quiescesBeforeDecisive} | ${arm.decisiveQuiesces} `
        + `| ${rebased} |`,
      );
    }
    out.push('');
    out.push(
      'The ladder\'s quiesces DO precede the window, so a rebase there changes the base the '
      + 'decisive ticks are measured against. That is a state difference rather than a tick-cost '
      + 'confound, and the column above says whether it happened instead of leaving it as a '
      + 'possibility: a rebase writes a fresh base id and drops the delta, so the generation '
      + 'before and after the ladder answers it outright. The ladder\'s FIRST quiesce cannot '
      + 'rebase, because it creates the base and there is no delta to outgrow it.',
    );
    out.push('');
    out.push('| arm | workload | ticks | Σ tick ms | p50 | p95 | class A | class B | MiB moved | USD |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const arm of arms) {
      for (const spec of DECISIVE_WORKLOADS) {
        const totals = totalsFor(arm.decisiveTicks, spec.id);
        if (totals.ticks === 0) continue;
        const blind = opsAreBlind(arm.decisiveTicks, spec.id);
        const opsCell = blind ? 'unmeasured' : String(totals.classA);
        const bCell = blind ? 'unmeasured' : String(totals.classB);
        const usdCell = blind ? 'unmeasured' : `$${totals.usd.toFixed(6)}`;
        const movedCell = !totals.movedReported
          ? 'not measurable'
          : totals.unanswerable > 0
            ? `${(totals.bytesPut / 1024 / 1024).toFixed(1)} (${totals.unanswerable} tick(s) could not answer)`
            : (totals.bytesPut / 1024 / 1024).toFixed(1);
        out.push(
          `| \`${arm.strategy}\` | ${spec.id} | ${totals.ticks} | ${Math.round(totals.sumWallMs)} `
          + `| ${Math.round(totals.p50WallMs)} | ${Math.round(totals.p95WallMs)} | ${opsCell} `
          + `| ${bCell} | ${movedCell} | ${usdCell} |`,
        );
      }
    }
    out.push('');

    // The rule, applied to the rows above and to nothing else. Stated with its
    // thresholds so a reader can check the arithmetic rather than trust it.
    //
    // ONLY LIFECYCLE-PROVEN ARMS REACH THE RULE. `decide` only sees ticks, so
    // this gate prevents a blank-disk arm from supplying a plausible ratio.
    const eligibleTicks = rankableTicks(arms, ticks);
    const refused = arms.filter((arm) => !arm.verifyPassed).map((arm) => arm.strategy);
    if (refused.length > 0) {
      out.push(
        `REFUSED FROM RANKING: ${refused.map((id) => `\`${id}\``).join(', ')} failed the lifecycle proof, so `
        + 'their ticks measured a container\'s own blank disk and are excluded from the ratio '
        + 'below. Their rows remain in the table above for diagnosis.',
      );
      out.push('');
    }
    out.push('#### Decision rule');
    out.push('');
    const comparisons = comparablePairs(arms);
    if (comparisons.kind === 'absent') {
      out.push(
        `**NO RATIO IS DERIVABLE FROM THIS RUN.** ${comparisons.reason} A ratio needs the incumbent and at `
        + 'least one challenger, both MEASURED here; printing one over arms the run never requested '
        + 'would report a rule about a comparison nobody performed.',
      );
      out.push('');
    } else {
      out.push(
        `ratio(w) = Σ ticks(\`${INCUMBENT}\`, w) / Σ ticks(challenger, w), taken once per challenger this `
        + 'run measured. ratio(git) ≥ 10 AND ratio(npm) ≥ 3 ⇒ that challenger\'s O(p) shape wins outright. '
        + `Both < 3 ⇒ O(c) tick cost is not the bottleneck and \`${INCUMBENT}\` holds against it. `
        + 'Between them the rule is deliberately undecided, and says so.',
      );
      out.push('');
      out.push('| challenger | verdict | measured |');
      out.push('| --- | --- | --- |');
      for (const pair of comparisons.pairs) {
        const verdict: DecisionVerdict = decide(eligibleTicks, pair.baseline, pair.candidate);
        const label = verdict.kind === 'inconclusive'
          ? 'INCONCLUSIVE'
          : verdict.kind === 'o-p-wins'
            ? `**DISPLACES \`${INCUMBENT}\`**`
            : `\`${INCUMBENT}\` HOLDS`;
        const detail = verdict.kind === 'inconclusive' ? verdict.reason : verdict.detail;
        out.push(`| \`${pair.candidate}\` | ${label} | ${detail} |`);
      }
      out.push('');
      out.push(
        'Every challenger is judged against the same incumbent by the same rule, so the rows are '
        + 'comparable with each other. A challenger absent from this table is one whose arm this run '
        + 'did not measure.',
      );
      out.push('');
      out.push(
        'The 10x and 3x bars are CHOSEN thresholds from the research that set them, not measured '
        + 'constants. This experiment measures the ratio; it does not confirm the bar.',
      );
      out.push('');
    }
    if (frozenControls.length > 0) {
      out.push(
        'Only the current arms\' rows may be compared. The frozen controls above remain visible '
        + 'as historical context and never enter a ratio, rank, or recommendation.',
      );
      out.push('');
    }

    // The sqlite arm answers a different question and must not be read as a
    // vote on the default.
    out.push('#### The sqlite arm, which decides a separate question');
    out.push('');
    out.push(
      'A 64 MiB database rewritten in place through real SQLite. This decides whether '
      + 'extent-level in-place tracking is ever worth building, NOT which strategy is default. '
      + 'File-granularity re-shipping the whole database per tick is recorded here as a cost, '
      + 'never treated as disqualifying.',
    );
    out.push('');
    for (const arm of arms) {
      const dbBytes = arm.treeBytes['sqlite'] ?? -1;
      out.push(`- \`${arm.strategy}\`: ${sqliteFinding(arm.decisiveTicks, dbBytes)}`);
    }
    out.push('');
  }

  out.push('#### Lifecycle');
  out.push('');
  out.push('| arm | attach cold (ms) | attach warm (ms) | stop (ms) | wake (ms) | wake attach.kind |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    out.push(
      `| \`${arm.strategy}\` | ${num(arm.attachColdMs, 0)} | ${num(arm.attachWarmMs, 0)} `
      + `| ${num(arm.stopMs, 0)} | ${num(arm.wakeMs, 0)} `
      + `| ${arm.wakeKind === 'attached' ? 'attached' : `**${arm.wakeKind || 'unknown'}**`} |`,
    );
  }
  out.push('');
  out.push(
    'A wake whose `attach.kind` is not `attached` did not restore anything: the container never '
    + 'went down, so no durability conclusion may be drawn from that cycle.',
  );
  out.push('');

  out.push('#### Checkpoint ladder');
  out.push('');
  out.push('| arm | change | kind | ms | bytes committed | outcome |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    for (const row of arm.checkpoints) {
      out.push(
        `| \`${arm.strategy}\` | ${row.changeKiB >= 1024 ? `${row.changeKiB / 1024} MiB` : `${row.changeKiB} KiB`} `
        + `| ${row.kind} | ${num(row.ms, 0)} | ${num(row.bytes, 0)} | ${row.outcome} |`,
      );
    }
  }
  out.push('');

  out.push('#### Workload, per-operation p50 (ms)');
  out.push('');
  const header = ['metric', ...arms.map((a) => `\`${a.strategy}\``)];
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const metric of HEADLINE) {
    const cells = arms.map((arm) => {
      const found = metricSummary(arm, metric);
      return found === null ? '—' : num(found.p50);
    });
    if (cells.every((c) => c === '—')) continue;
    out.push(`| \`${metric}\` | ${cells.join(' | ')} |`);
  }
  out.push('');
  // HOW MANY REPETITIONS ACTUALLY RAN, per arm, beside the count the run asked
  // for. G9 scores the dispersion of exactly these, so a reader who can see
  // only the medians above cannot tell a scored cell from a censored one.
  out.push(
    `Repetitions of the deciding metric \`${DECIDING_METRIC}\`, which is what G9 scores: `
    + `${arms.map((arm) => `\`${arm.strategy}\` ${metricRows(arm, DECIDING_METRIC).length}`).join(', ')}`
    + `. The run asked for ${meta['deciding repetitions']} per arm, and G9 censors a cell below `
    + `${MIN_DECIDING_REPETITIONS}.`,
  );
  out.push('');

  out.push('#### R2 operations and teardown');
  out.push('');
  out.push('| arm | class A | class B | free | total | teardown |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    out.push(
      `| \`${arm.strategy}\` | ${num(arm.ops?.classA ?? null, 0)} | ${num(arm.ops?.classB ?? null, 0)} `
      + `| ${num(arm.ops?.classFree ?? null, 0)} | ${num(arm.ops?.total ?? null, 0)} `
      + `| ${JSON.stringify(arm.teardown ?? {})} |`,
    );
  }
  out.push('');

  const notes = arms.flatMap((arm) => arm.notes.map((note) => `\`${arm.strategy}\`: ${note}`));
  if (notes.length > 0) {
    out.push('#### What did not hold');
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
    out.push('');
  }

  out.push('#### Recommendation');
  out.push('');
  out.push(admission.admitted ? recommend(arms, admission) : refusalText(admission));
  out.push('');
  return out.join('\n');
}

/**
 * The ranking, over every arm this run measured, derived from the rows rather
 * than written beside them.
 *
 * WHAT THIS REPLACES. The predecessor scored on metadata latency alone and
 * named a best and a worst — and `devboxArmEvidence` had already marked three
 * of the five arms rank-INELIGIBLE before it ran, so the "recommendation" was a
 * two-name comparison whose outcome was fixed by taxonomy rather than by
 * measurement. Every arm that clears the one gate applying to all of them, the
 * lifecycle proof, is ranked here, on the workloads the decision rule reads.
 *
 * A PREREGISTERED DEFECT IS A COST, NOT A FILTER. An arm's observed witnesses
 * are priced in the last column and named beside the winner; they never remove
 * it from the table. `r2fs` losing on POSIX semantics is a fact a reader weighs
 * against its numbers, not a reason to withhold the numbers.
 *
 * DISPLACEMENT STILL NEEDS THE BAR. Ranking says which arm cost least; it does
 * not license changing the default. `INCUMBENT` keeps it unless a challenger
 * clears the preregistered 10x/3x bar `decide` applies, so the ranking and the
 * decision rule cannot disagree about what ships.
 */
export function recommend(arms: readonly ArmResult[], admission: AdmissionVerdict): string {
  requireAdmitted(admission);
  const proven = arms.filter((arm) => arm.verifyPassed);
  if (proven.length === 0) {
    return 'NO DEFAULT IS DERIVABLE FROM THIS RUN. No arm completed the lifecycle proof, which means every arm '
      + 'measured the container\'s own blank disk rather than its strategy. The lifecycle rows above '
      + 'say which checks failed; fix those before reading any latency from this table.';
  }
  const wakeNote = (arm: ArmResult): string => arm.wakeKind === 'attached'
    ? ''
    : ` Its wake was NOT verified (attach.kind '${arm.wakeKind}'), so the restore half of this `
      + 'recommendation rests on the checkpoint ladder rather than on an observed cold start.';
  const costCell = (costs: readonly string[]): string =>
    costs.length === 0 ? 'none preregistered' : costs.map((name) => `\`${name}\``).join(', ');

  const scored = proven.map((arm) => {
    const totals = RULE_WORKLOADS.map((workload) => totalsFor(arm.decisiveTicks, workload));
    return {
      arm,
      unmeasured: RULE_WORKLOADS.filter((_, index) => totals[index]!.ticks === 0),
      decisiveMs: totals.reduce((sum, row) => sum + row.sumWallMs, 0),
      statMs: metricSummary(arm, DECIDING_METRIC)?.p50 ?? null,
      costs: arm.witnessChecks.filter((witness) => witness.observed).map((witness) => witness.name),
    };
  });
  const rankable = scored
    .filter((row) => row.unmeasured.length === 0)
    .sort((a, b) => a.decisiveMs - b.decisiveMs);

  const out: string[] = [
    `RANKED ON THE DECISIVE WORKLOADS (${RULE_WORKLOADS.join(' + ')}), over every arm that completed the `
    + 'lifecycle proof, under the same gate. No arm is excluded by what kind of strategy it is.',
    '',
    '| rank | arm | Σ decisive tick ms | `' + DECIDING_METRIC + '` p50 (ms) | measured costs |',
    '| --- | --- | --- | --- | --- |',
  ];
  rankable.forEach((row, index) => {
    const name = `\`${row.arm.strategy}\`${row.arm.strategy === INCUMBENT ? ' (incumbent)' : ''}`;
    out.push(
      `| ${index + 1} | ${name} | ${Math.round(row.decisiveMs)} `
      + `| ${row.statMs === null ? '—' : row.statMs.toFixed(2)} | ${costCell(row.costs)} |`,
    );
  });
  for (const row of scored.filter((candidate) => candidate.unmeasured.length > 0)) {
    out.push(
      `| — | \`${row.arm.strategy}\` | unranked: no ticks on ${row.unmeasured.join(', ')} `
      + `| ${row.statMs === null ? '—' : row.statMs.toFixed(2)} | ${costCell(row.costs)} |`,
    );
  }
  out.push('');

  const best = rankable[0];
  if (best === undefined) {
    out.push(
      'NO DEFAULT IS DERIVABLE FROM THIS RUN. Every arm that completed the lifecycle proof is missing ticks '
      + `on at least one decisive workload, so none of them is comparable on the quantity the rule reads.`,
    );
    return out.join('\n');
  }
  const incumbent = rankable.find((row) => row.arm.strategy === INCUMBENT);
  if (incumbent === undefined) {
    out.push(
      `\`${best.arm.strategy}\` COSTS LEAST HERE, but the incumbent \`${INCUMBENT}\` is not in the ranking, so `
      + 'nothing in this run says whether it displaces the deployed default. Re-run with the incumbent among '
      + `the arms before treating this order as a change of default.${wakeNote(best.arm)}`,
    );
    return out.join('\n');
  }
  if (best.arm.strategy === INCUMBENT) {
    out.push(
      `\`${INCUMBENT}\` STAYS DEFAULT. It is the incumbent and it also costs least on the decisive workloads, `
      + 'so no challenger displaces it on this run.',
    );
    return out.join('\n');
  }

  const verdict = decide(proven.flatMap((arm) => arm.decisiveTicks), INCUMBENT, best.arm.strategy);
  const ratio = incumbent.decisiveMs / best.decisiveMs;
  out.push(verdict.kind === 'o-p-wins'
    ? `DEFAULT TO \`${best.arm.strategy}\`. It costs ${ratio.toFixed(1)}x less decisive tick time than the `
      + `incumbent \`${INCUMBENT}\` and it clears the preregistered bar — ${verdict.detail}.${wakeNote(best.arm)}`
    : `\`${INCUMBENT}\` STAYS DEFAULT. \`${best.arm.strategy}\` costs ${ratio.toFixed(1)}x less decisive tick `
      + 'time, but the default changes only when a challenger clears the preregistered bar, and this one does '
      + `not — ${verdict.kind === 'inconclusive' ? verdict.reason : verdict.detail}.`);
  if (best.costs.length > 0) {
    out.push('');
    out.push(
      `\`${best.arm.strategy}\` carries ${best.costs.length} preregistered defect(s) this run OBSERVED: `
      + `${costCell(best.costs)}. Those are a cost of adopting it, not a reason it was kept out of the `
      + 'ranking; the witness rows above say what each one did.',
    );
  }
  return out.join('\n');
}

/** The admission evidence one devbox arm contributes. Exported so the gate's
 *  red tests can prove a current-only run cannot recommend without a deploy.
 *
 *  EVERY ARM IS A COMPETITOR. This used to answer `kind: 'control'` and
 *  `rankEligible: false` for `snapshot-chain`, `r2fs` and `overlay-cas`, which
 *  made G2 refuse those arms a place in the ranking no matter what they
 *  measured — the taxonomy decided the outcome before the run started. A
 *  strategy's preregistered defects are carried below as observed witnesses and
 *  priced by `recommend`; they are costs, not eligibility.
 *
 *  The witnesses are preregistered in `PREREGISTERED_WITNESSES` and OBSERVED by
 *  the cells `runControlWitnessCells` runs; this only carries what those cells
 *  saw. A witness the cells did not observe is absent here, and G2 refuses the
 *  run — which is the correct answer both when a cell could not run and when
 *  the defect it exists to catch has silently gone away. */
export function devboxArmEvidence(
  arm: Pick<
    ArmResult,
    'strategy' | 'verifyPassed' | 'verifyChecks' | 'phases' | 'checkpoints' | 'decisiveTicks' | 'witnessChecks'
  >,
): ArmEvidence {
  return {
    arm: arm.strategy,
    kind: 'candidate',
    rankEligible: true,
    expectedRedChecks: [...PREREGISTERED_WITNESSES[arm.strategy]],
    // OBSERVED, not asserted: every name here comes from a cell that RAN
    // against the deployed arm and saw the defect. A witness the cells could
    // not observe is missing from this list on purpose, and `witnessProblems`
    // refuses the run for it.
    observedRedChecks: arm.witnessChecks.filter((witness) => witness.observed).map((witness) => witness.name),
    attachedVerified: arm.verifyPassed,
    semanticsPassed: arm.verifyPassed,
    failedChecks: arm.verifyChecks.filter((check) => !check.pass).map((check) => check.name),
    producedMeasurements: arm.phases.length > 0 || arm.checkpoints.length > 0 || arm.decisiveTicks.length > 0,
  };
}

/**
 * The cold-attach ceiling the admission contract holds every arm to.
 *
 * NOT the fixture's abandonment budget, which `packages/devbox/bench/worker.ts`
 * deliberately sets to 300 s so a slow attach is MEASURED instead of killed
 * mid-restore. That is a measurement decision about when to give up; it is not
 * a licence to admit a cold attach five minutes long. This is the contract's
 * own number and raising it is not an option available to a run that missed it.
 */
export const COLD_ATTACH_CEILING_MS = 25_000;

/** The staged stage this instrument declares. Its cells are the ones G6 must
 *  see completed, and an empty declaration is what made G6 vacuous. */
const DEVBOX_DECLARED_STAGES: readonly StageId[] = ['blank'];

/** The metric a recommendation is derived from — metadata latency over many
 *  small files — named once so the gate judges the same quantity the report
 *  prints and `recommend` ranks. */
export const DECIDING_METRIC = 'small-stat-1k';

/** Repetitions a deciding cell needs before a dispersion claim exists at all.
 *  `scoreCells` censors below two; naming it here lets the refusal say which
 *  arm produced how many instead of only that a cell was censored. */
const MIN_DECIDING_REPETITIONS = 2;

/** What `--decisive` asks for when nobody says otherwise: exactly the fewest
 *  repetitions G9 will score. DERIVED from the floor above, never written
 *  beside it — a default one short of the gate is a run that cannot be
 *  admitted however well it measures, which is the whole of G9's refusal in
 *  run 20260902154130. */
const DECISIVE_REPETITIONS = MIN_DECIDING_REPETITIONS;

/** Ladder rows one complete arm owes: a quiesce and a tick at every change
 *  size. Derived from the ladder itself, so changing the ladder cannot leave a
 *  completeness check asserting a stale count. */
export const EXPECTED_LADDER_ROWS = CHANGE_SIZES_KIB.length * 2;

/**
 * The restore class each arm CLAIMS, preregistered before the run.
 *
 * A claim is not a result. `overlay-cas` claims `unbounded` because that is its
 * preregistered red witness (`unbounded-pending-replay`), `bounded-layers`
 * claims `bounded-k` because `MAX_LAYERS` bounds one resolution to eight
 * consulted layers, `merkle-pack` claims `log-p` because a path resolves down
 * a digest-linked node tree, `snapshot-chain` claims `bounded-k` because a
 * restore replays base plus the deltas its rebase policy bounds, and `r2fs`
 * claims `strict-o1` because its restore is a mount with no replay at all.
 */
const RESTORE_CLAIMS = {
  'snapshot-chain': 'bounded-k',
  r2fs: 'strict-o1',
  'overlay-cas': 'unbounded',
  'bounded-layers': 'bounded-k',
  'merkle-pack': 'log-p',
} as const satisfies Record<Strategy, RestoreClaim>;

/**
 * What produced the numbers, as digests rather than as a date.
 *
 * MEASURED DEFECT THIS REPAIRS. The provenance this driver wrote carried
 * `git rev-parse HEAD` — which is identical for a clean tree and a tree with
 * uncommitted driver changes — plus `startedAt`/`finishedAt` synthesized as
 * `${meta.date}T00:00:00.000Z` and `...:01.000Z`: a one-second run that never
 * happened, on a date with no time in it. `versions` held the IMAGE under the
 * `@cloudflare/sandbox` key, so no dependency version was recorded either, and
 * `containerFacts` was a sentence built from the worker name, which is never
 * empty and therefore never refuses.
 *
 * Every field here is a G0 requirement, and each one identifies a different
 * thing that changes what the numbers mean: the source, whether that source
 * was actually the tree that ran, which deployed Worker version served the
 * arms, when the run really happened, and the exact image, runner bundles and
 * daemon source the containers were built from.
 */
export interface RunIdentity {
  readonly commit: string;
  /** sha256 over the tracked-file diff against HEAD, or `clean`. A dirty tree
   *  is a different instrument from its commit and no revision can say so. */
  readonly dirtyDigest: string;
  /** The Worker version id the deploy published. */
  readonly workerVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly image: string;
  /** OCI manifest digest for the exact sandbox image the generated config pins. */
  readonly imageSha256: string;
  readonly dockerfileSha256: string;
  readonly candidateRunnerSha256: string;
  readonly overlayRunnerSha256: string;
  readonly journalDaemonSha256: string;
}

/** Commit plus the digest that distinguishes its dirty source tree. */
export interface SourceRevision {
  readonly commit: string;
  readonly dirtyDigest: string;
}

/** The source revision AND whether the tree that ran was that revision. */
export function sourceRevision(): SourceRevision {
  const commit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  // `git diff --binary HEAD` carries both staged and unstaged tracked changes,
  // including mode and rename metadata. Untracked paths are not in a diff, so
  // identify them from porcelain status, then enumerate their bytes through the
  // repository's one authoritative corpus (`trackedFiles`). A private
  // `git ls-files` here would make this driver govern a different source set
  // from the project's own gates.
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  const untracked = new Set(
    status.split('\0')
      .filter((row) => row.startsWith('?? '))
      .map((row) => row.slice(3)),
  );
  if (diff.length === 0 && untracked.size === 0) return { commit, dirtyDigest: 'clean' };

  const hash = createHash('sha256').update(diff);
  for (const path of trackedFiles()) {
    if (!untracked.has(path)) continue;
    hash.update('\0untracked\0').update(path).update('\0');
    hash.update(readFileSync(join(REPO_ROOT, path))).update('\0');
  }
  return { commit, dirtyDigest: `sha256:${hash.digest('hex')}` };
}

/** Every identity field, keyed as the version row the artifact records. */
function identityVersions(identity: RunIdentity) {
  return {
    source: identity.commit,
    'source-tree': identity.dirtyDigest,
    'worker-version': identity.workerVersion,
    'container-image': identity.image,
    'container-image-digest': identity.imageSha256,
    'candidate-image-dockerfile': identity.dockerfileSha256,
    'candidate-runner-bundle': identity.candidateRunnerSha256,
    'overlay-cas-runner-bundle': identity.overlayRunnerSha256,
    'journal-daemon-source': identity.journalDaemonSha256,
  };
}

function devboxProvenance(identity: RunIdentity, meta: RunMeta): RunProvenance {
  return {
    runId: meta.run,
    commit: identity.commit,
    startedAt: identity.startedAt,
    finishedAt: identity.finishedAt,
    seed: meta.seed,
    image: identity.image,
    versions: identityVersions(identity),
    containerFacts: `one fixture Worker per arm (${meta.worker}) at ${identity.workerVersion} on ${identity.image} `
      + `(${identity.imageSha256}), built from Dockerfile ${identity.dockerfileSha256} with candidate runner `
      + `${identity.candidateRunnerSha256} and journal daemon source ${identity.journalDaemonSha256}`,
  };
}

/** G0 reasons for an identity that cannot attribute the run. Each field is
 *  required outright: a blank one is a refusal, never a default. */
function identityProblems(identity: RunIdentity): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(identityVersions(identity))) {
    if (value.trim() === '') problems.push(`the run recorded no ${name}`);
  }
  const digests = {
    'container-image-digest': identity.imageSha256,
    'candidate-image-dockerfile': identity.dockerfileSha256,
    'candidate-runner-bundle': identity.candidateRunnerSha256,
    'overlay-cas-runner-bundle': identity.overlayRunnerSha256,
    'journal-daemon-source': identity.journalDaemonSha256,
  };
  for (const [name, digest] of Object.entries(digests)) {
    if (digest !== '' && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      problems.push(`${name} "${digest}" is not a sha256 digest`);
    }
  }
  if (!identity.image.includes(`@${identity.imageSha256}`)) {
    problems.push(`container image "${identity.image}" is not pinned to ${identity.imageSha256 || 'its recorded digest'}`);
  }
  if (identity.dirtyDigest !== 'clean' && !/^sha256:[0-9a-f]{64}$/.test(identity.dirtyDigest)) {
    problems.push(`source-tree "${identity.dirtyDigest}" is neither \`clean\` nor a digest`);
  }
  if (identity.startedAt === identity.finishedAt) {
    problems.push('the run started and finished at the same instant, so no run was timed');
  }
  return problems;
}

export interface DevboxAdmissionInput {
  readonly arms: readonly ArmResult[];
  /** The arms the operator ASKED for. Admission compares the measured set
   *  against exactly this, so a run that silently lost an arm — or gained one
   *  nobody requested — cannot look complete. */
  readonly requested: readonly Strategy[];
  /**
   * Repetitions of each deciding cell the run ASKED for (`--repetitions`).
   *
   * G9 already refuses a cell below the dispersion floor. This is the other
   * direction: an arm that measured fewer repetitions than the run asked for
   * lost some, and a refusal that can say `asked for 2, measured 1` names the
   * loss instead of leaving a reader to assume the driver only ever tried once.
   */
  readonly repetitions: number;
  readonly meta: RunMeta;
  readonly identity: RunIdentity;
  readonly token: string;
  readonly cleanup: CleanupEvidence;
}

/**
 * The cell one arm owes this instrument.
 *
 * A cold attach inside the ceiling, the whole checkpoint ladder, a wake that
 * attached durable bytes, a second attach that observed the UNCHANGED
 * generation, and its own operation tally. Anything less is an incomplete
 * cell — never a faster one.
 */
function armCompletedTheCell(arm: ArmResult): boolean {
  return arm.verifyPassed
    && arm.attachColdMs !== null && arm.attachColdMs <= COLD_ATTACH_CEILING_MS
    && arm.wakeKind === 'attached'
    && arm.attachWarmKind === 'attached'
    && arm.wakeBootId !== null
    && arm.wakeBootId === arm.attachWarmBootId
    && arm.checkpoints.length === EXPECTED_LADDER_ROWS
    && arm.ops !== null;
}

/**
 * The record this run puts in front of the shared gates.
 *
 * MEASURED DEFECT THIS REPAIRS. `restore`, `declaredStages`, `cells` and
 * `deciding` were all `[]`. Every one of those gates then passed VACUOUSLY:
 * `restoreProblems` iterates `record.restore`, `completenessProblems` compares
 * against `expectedCells([])`, and `censorProblems` guards its only run-level
 * check behind `scored.length > 0`. Three of the ten gates could not fail, and
 * a run that measured nothing durable at all reported G5, G6 and G9 as held.
 */
function devboxRunRecord(input: DevboxAdmissionInput): StorageRunRecord {
  const armOf = (strategy: Strategy): ArmResult | undefined =>
    input.arms.find((row) => row.strategy === strategy);

  // ACCOUNTING IS PER-ARM AND COMPLETE, or absent. Summing the arms that
  // happened to report a tally prices the arms that did not as if they cost
  // nothing, and an under-reported cost column is worse than a missing one
  // because nobody re-derives a number that already has a value.
  const calls: Record<string, number> = {};
  let classA = 0;
  let classB = 0;
  let classFree = 0;
  let total = 0;
  for (const arm of input.arms) {
    if (arm.ops === null) continue;
    classA += arm.ops.classA ?? 0;
    classB += arm.ops.classB ?? 0;
    classFree += arm.ops.classFree ?? 0;
    total += arm.ops.total ?? 0;
    for (const [name, count] of Object.entries(arm.ops.calls ?? {})) calls[name] = (calls[name] ?? 0) + count;
  }
  const everyArmTallied = input.requested.length > 0
    && input.requested.every((strategy) => armOf(strategy)?.ops != null);
  const accounting: AccountingEvidence | null = everyArmTallied
    ? { source: 'fixture /ops tallies summed over every requested arm', calls, classA, classB, classFree, total }
    : null;

  const cells = expectedCells(DEVBOX_DECLARED_STAGES, null);
  const cellComplete = input.requested.length > 0
    && input.requested.every((strategy) => {
      const arm = armOf(strategy);
      return arm !== undefined && armCompletedTheCell(arm);
    });

  // ONE DECIDING ROW PER ARM PER CELL. The shared cell id carries no arm, so
  // each arm's repetitions ride on their own row: pooling two arms' values into
  // one row would make the CV measure the DIFFERENCE between the arms, which is
  // the effect this experiment exists to find rather than noise to censor for.
  const deciding: MeasuredCell[] = [];
  for (const strategy of input.requested) {
    const arm = armOf(strategy);
    if (arm === undefined) continue;
    const measured = metricRows(arm, DECIDING_METRIC);
    for (const cell of cells) {
      deciding.push({
        id: cell,
        values: measured.map((row) => row.p50),
        wallMs: measured.length === 0 ? null : measured.reduce((sum, row) => sum + row.wallMs, 0),
      });
    }
  }

  return {
    schema: 'storage-matrix/run@1',
    provenance: devboxProvenance(input.identity, input.meta),
    arms: input.arms.map(devboxArmEvidence),
    // This driver runs no fault-cut or security-cell instrumentation yet, so
    // every G3/G4 field carries its REFUSING default: missing evidence is a
    // refusal, never an implicit pass.
    publication: {
      readOnlyDeclared: false,
      readOnlyRefusedWrites: null,
      faultCutCompleted: false,
      allOldOrAllNew: null,
      barrierAckLoss: null,
      absentReferences: null,
      rollbackOrPhantomRoot: null,
    },
    security: {
      credentialLeaks: findCredentialLeaks(
        JSON.stringify({ meta: input.meta, arms: input.arms }),
        [input.token],
      ),
      securityCellsComplete: false,
      prefixEscapes: 0,
      capabilityEscapesOrReplays: 0,
      staleWriterAccepted: false,
      hostileMetadataAccepted: false,
    },
    // ONE ROW PER REQUESTED ARM, and `work` stays null: this driver observes a
    // wake, it does not COUNT the remote operations, replay units and cpu steps
    // a `RestoreWork` row asserts. Filling those with zeroes would be the same
    // vacuity in a different field, so the row says the restore was never
    // counted and G5 refuses on that.
    restore: input.requested.map((strategy): RestoreEvidence => ({
      arm: strategy,
      expected: true,
      work: null,
      claim: RESTORE_CLAIMS[strategy],
      mechanicalBoundVerified: false,
    })),
    declaredStages: [...DEVBOX_DECLARED_STAGES],
    cells: cells.map((cell): CellCompletion => ({ ...cell, completed: cellComplete })),
    confirmatoryPlan: null,
    accounting,
    cleanup: input.cleanup,
    deciding,
    decidingBudgetMs: Number(input.meta['loop budget ms']),
  };
}

/**
 * This instrument's own requirements, per gate.
 *
 * The shared gates judge a RECORD. They cannot know that a devbox run must
 * carry a tally for every arm it requested, that a cold attach has a contract
 * ceiling of its own, or that the measured arm set must be exactly the
 * requested one. Those reasons belong to the gate each one is about, so a
 * refusal names the missing evidence rather than only a gate id.
 */

function devboxRequirements(input: DevboxAdmissionInput) {
  const g0 = identityProblems(input.identity);
  const g5: string[] = [];
  const g6: string[] = [];
  const g7: string[] = [];
  const g9: string[] = [];

  // EXACTLY THE REQUESTED SET, on all three gates: a restore class, a complete
  // cell and a repetition count are each claims about the whole arm set, and
  // none of them survives an arm that vanished or one that appeared.
  const armSet: string[] = [];
  if (input.requested.length === 0) {
    armSet.push('the run requested no arms, so there is no expected arm set to complete');
  }
  for (const strategy of STRATEGIES) {
    const requestedCount = input.requested.filter((arm) => arm === strategy).length;
    const measuredCount = input.arms.filter((arm) => arm.strategy === strategy).length;
    if (requestedCount > 1) {
      armSet.push(`arm \`${strategy}\` was requested ${requestedCount} times; an expected arm set has no duplicates`);
    }
    if (measuredCount > requestedCount) {
      armSet.push(
        `arm \`${strategy}\` produced ${measuredCount} result rows but was requested ${requestedCount} time(s)`,
      );
    }
  }
  for (const strategy of input.requested) {
    if (!input.arms.some((arm) => arm.strategy === strategy)) {
      armSet.push(`arm \`${strategy}\` was requested but contributed no result row`);
    }
  }
  for (const arm of input.arms) {
    if (!input.requested.includes(arm.strategy)) {
      armSet.push(`arm \`${arm.strategy}\` produced a result row without being requested`);
    }
  }
  g5.push(...armSet);
  g6.push(...armSet);
  g9.push(...armSet);

  for (const strategy of input.requested) {
    const arm = input.arms.find((row) => row.strategy === strategy);
    if (arm === undefined) continue;

    // COLD AND UNCHANGED ATTACH EVIDENCE. A cell whose arm never cold-attached,
    // or whose second attach did not find the generation already there, did not
    // complete — whatever its latency rows say.
    if (arm.attachColdMs === null) {
      g6.push(`arm \`${strategy}\` recorded no cold attach, so its first attach was never timed`);
    } else if (arm.attachColdMs > COLD_ATTACH_CEILING_MS) {
      g6.push(
        `arm \`${strategy}\` cold attach took ${arm.attachColdMs} ms, past the `
        + `${COLD_ATTACH_CEILING_MS} ms admission ceiling`,
      );
    }
    if (arm.attachColdKind !== 'attached' && arm.attachColdKind !== 'empty') {
      g6.push(`arm \`${strategy}\` cold attach reported kind "${arm.attachColdKind || 'none'}"`);
    }
    if (arm.attachWarmKind !== 'attached') {
      g6.push(
        `arm \`${strategy}\` second attach did not observe the unchanged generation `
        + `(kind "${arm.attachWarmKind || 'none'}")`,
      );
    }
    if (arm.wakeBootId === null || arm.attachWarmBootId === null) {
      g6.push(
        `arm \`${strategy}\` did not record both wake and warm-attach generation ids, `
        + 'so unchanged attach was not evidenced',
      );
    } else if (arm.wakeBootId !== arm.attachWarmBootId) {
      g6.push(
        `arm \`${strategy}\` warm attach changed generation from \`${arm.wakeBootId}\` `
        + `to \`${arm.attachWarmBootId}\``,
      );
    }
    if (arm.wakeKind !== 'attached') {
      g6.push(`arm \`${strategy}\` wake did not attach durable bytes (kind "${arm.wakeKind || 'none'}")`);
    }
    if (arm.checkpoints.length !== EXPECTED_LADDER_ROWS) {
      g6.push(
        `arm \`${strategy}\` recorded ${arm.checkpoints.length} of ${EXPECTED_LADDER_ROWS} `
        + 'ladder checkpoints',
      );
    }

    // A TALLY PER ARM. `accounting` is one summed row, so an arm without a
    // tally disappears into a total that still adds up.
    if (arm.ops === null) {
      g7.push(`arm \`${strategy}\` recorded no \`/ops\` tally, so its operations are unpriced`);
    } else if (arm.ops.total === undefined) {
      g7.push(`arm \`${strategy}\` reported a tally carrying no total`);
    }

    const repetitions = metricRows(arm, DECIDING_METRIC).length;
    if (repetitions < MIN_DECIDING_REPETITIONS) {
      g9.push(
        `arm \`${strategy}\` measured the deciding metric \`${DECIDING_METRIC}\` ${repetitions} time(s); `
        + `${MIN_DECIDING_REPETITIONS} repetitions are the fewest a dispersion claim can rest on`,
      );
    }
    // AND WHAT THE RUN ASKED FOR, which is the other direction: a run that
    // requested more repetitions than an arm produced lost some, and a floor
    // check alone would report the survivors as the whole intent.
    if (repetitions < input.repetitions) {
      g9.push(
        `arm \`${strategy}\` measured the deciding metric \`${DECIDING_METRIC}\` ${repetitions} time(s) `
        + `where the run asked for ${input.repetitions}: repetition(s) were lost, so the dispersion `
        + 'is over fewer samples than the run intended',
      );
    }
  }

  if (input.requested.length === 0) {
    g5.push('the run recorded no restore evidence at all');
  }
  for (const strategy of input.requested) {
    g5.push(
      `arm \`${strategy}\` has no counted restore: this driver observes a wake but runs no `
      + `restore-complexity instrumentation, so its \`${RESTORE_CLAIMS[strategy]}\` claim is unverified`,
    );
  }

  return { G0: g0, G5: g5, G6: g6, G7: g7, G9: g9 };
}

/**
 * Merge this instrument's requirements into the shared verdict.
 *
 * `admitted` is recomputed from the merged reasons rather than carried over, so
 * a gate the shared record happened to satisfy cannot stay green while a devbox
 * requirement it knows nothing about is unmet.
 */
function withDevboxRequirements(
  verdict: AdmissionVerdict,
  extra: Partial<Record<GateId, string[]>>,
): AdmissionVerdict {
  const gates = verdict.gates.map((row) => {
    const added = extra[row.gate] ?? [];
    return added.length === 0 ? row : { ...row, ok: false, reasons: [...row.reasons, ...added] };
  });
  return { admitted: gates.every((row) => row.ok), gates };
}

export function devboxAdmission(input: DevboxAdmissionInput): AdmissionVerdict {
  return withDevboxRequirements(
    evaluateRun(devboxRunRecord(input)),
    devboxRequirements(input),
  );
}
export function benchmarkExitCode(failure: string | null, admission: AdmissionVerdict): number {
  return failure === null && admission.admitted ? 0 : 1;
}


// ── main ────────────────────────────────────────────────────────────────────

/**
 * What one arm's deployment is doing RIGHT NOW, as teardown has to see it.
 *
 * Written as each step completes rather than returned when the arm is done,
 * because teardown can run at any instant: the signal handler is armed before
 * the first deploy, and the arms are in flight together, so an interruption
 * finds some arms live, some never deployed and some already swept. Each field
 * is the answer to a question teardown asks about exactly one arm.
 */
interface ArmLaneState {
  readonly fixture: ArmFixture;
  /** The box this arm measures, and the manifest row for its durable state. */
  readonly box: string;
  /** Every box this arm raised, including any the run added after the first. */
  readonly boxes: Set<string>;
  /** The deployed origin and token, once this arm's Worker accepted them. */
  live: Fixture | null;
  stop: (() => readonly string[]) | null;
  workerStopped: boolean;
  workerVersion: string;
  /** Why this arm never reached its measured pipeline, if it did not. */
  refusal: string | null;
}

/**
 * Delete one entry of an ABANDONED run's manifest, from its name alone.
 *
 * The in-run executor reaches for lane state — the deploy's own stop closure,
 * the fixture's generated config, the temp directory handle. None of that
 * survives the process that made it, and a manifest recovered from disk is by
 * definition a manifest whose process is gone, so every deletion here goes
 * through the resource's name and nothing else.
 *
 * Idempotent in the same way the in-run path is: "already absent" is success,
 * because a recovery that cannot be run twice is a recovery that cannot be
 * interrupted.
 */
export function orphanTeardownExecutor(
  residue: R2ResiduePlane | null,
): (entry: TeardownEntry) => Promise<DeleteOutcome> {
  // Which Workers this recovery has already deleted. Durable state is only
  // reachable through its Worker, so an entry claiming a box is empty is
  // worthless until the Worker serving it is gone.
  const workersDeleted = new Set<string>();
  return async (entry: TeardownEntry): Promise<DeleteOutcome> => {
    if (entry.kind === 'worker') {
      const deleted = wrangler(['delete', '--name', entry.name, '--force'], { allowFailure: true });
      if (!deleted.startsWith(WRANGLER_FAILED)) {
        workersDeleted.add(entry.name);
        return { ok: true };
      }
      if (/not found|does not exist/i.test(deleted)) {
        workersDeleted.add(entry.name);
        return { ok: true, absent: true };
      }
      return { ok: false, error: deleted.slice(0, 240) };
    }
    if (entry.kind === 'container-app') {
      if (containerAppIds(REPO_ROOT, [entry.name], log).length === 0) return { ok: true, absent: true };
      const failed = deleteContainerApps(REPO_ROOT, [entry.name], log).find((status) => /failed/i.test(status));
      return failed === undefined ? { ok: true } : { ok: false, error: failed };
    }
    if (entry.kind === 'r2-bucket') {
      let deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });
      if (deleted.startsWith(WRANGLER_FAILED) && /not empty|10008/i.test(deleted) && residue !== null) {
        const drained = await drainBucketResidue(residue, entry.name);
        log(`${entry.name}: drained ${String(drained.objects)} object(s), aborted ${String(drained.uploads)} upload(s)`);
        deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });
      }
      if (!deleted.startsWith(WRANGLER_FAILED)) return { ok: true };
      if (/not found|does not exist/i.test(deleted)) return { ok: true, absent: true };
      return { ok: false, error: deleted.slice(0, 240) };
    }
    if (entry.kind === 'do-state' || entry.kind === 'alarm' || entry.kind === 'mount') {
      // The owning Worker is DERIVED from the box, so this asks about the one
      // Worker that could still be serving this state rather than about the
      // recovery as a whole: one arm's failed delete must not report another
      // arm's durable state as surviving.
      const owner = workerServingBox(entry.name);
      if (owner === null) return { ok: false, error: `no Worker name derives from box ${entry.name}` };
      return workersDeleted.has(owner)
        ? { ok: true }
        : { ok: false, error: `Worker ${owner} must be deleted before its durable state` };
    }
    if (entry.kind === 'local-path') {
      rmSync(entry.name, { recursive: true, force: true });
      return { ok: true };
    }
    return { ok: false, error: `unsupported teardown resource ${entry.kind}` };
  };
}

/**
 * The Worker that serves a box, read back out of the box's own name.
 *
 * `boxName` is `ab-<strategy>-<runId>` and `resourceNames` is
 * `<base>-<runId>-<strategy>`, so the pair round-trips: a recovered manifest
 * carries no lane state, and this is how a durable-state entry still knows
 * which Worker has to go first. Answers null for a name no strategy produces
 * rather than guessing, because a wrong guess would report state deleted that
 * a live Worker still serves.
 */
function workerServingBox(box: string): string | null {
  for (const strategy of STRATEGIES) {
    const prefix = `ab-${strategy}-`;
    if (!box.startsWith(prefix)) continue;
    const runId = box.slice(prefix.length);
    if (runId === '' || boxName(runId, strategy) !== box) continue;
    return resourceNames(runId, strategy).worker;
  }
  return null;
}

const HELP = `Usage: bun scripts/bench-devbox-strategies.ts [options]

Options:
  --arms <strategy,...>             Measure named strategies. Defaults to every arm:
                                    ${STRATEGIES.join(', ')}.
  --control <strategy>=<path>       Add frozen historical context for one strategy,
                                    from a previous run's artifact. Any of:
                                    ${STRATEGIES.join(', ')}.
  --plan                            Print the execution plan without deploying.
  --decisive                        Run decisive workloads.
  --repetitions <n>                 Measure every deciding cell n times per arm — the
                                    decisive workloads and the \`${DECIDING_METRIC}\` phase
                                    G9 scores. Default ${DECISIVE_REPETITIONS} with --decisive, 1 without;
                                    G9 censors a cell below ${MIN_DECIDING_REPETITIONS} repetitions. Refuses n < 1.
  --keep                            Retain external resources for inspection.
  --out <path>                      Write the result artifact.
  --help                            Show this help.
`;

export function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1]! : fallback;
  };
  const controls: ControlOption[] = [];
  const knownStrategies = STRATEGIES.join(', ');
  const seenControls = new Set<Strategy>();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--control') continue;
    const rawControl = argv[index + 1];
    if (rawControl === undefined || rawControl.startsWith('--')) {
      throw new Error('--control requires <strategy>=<path>');
    }
    const separator = rawControl.indexOf('=');
    if (separator === -1) {
      throw new Error(`--control requires <strategy>=<path>; got "${rawControl}"`);
    }
    const rawStrategy = rawControl.slice(0, separator);
    const path = rawControl.slice(separator + 1);
    const strategy = STRATEGIES.find((known) => known === rawStrategy);
    if (separator < 1 || strategy === undefined) {
      throw new Error(
        `--control strategy "${rawStrategy}" is not a known strategy; known strategies: ${knownStrategies}`,
      );
    }
    if (path === '') throw new Error('--control requires <strategy>=<path>');
    if (seenControls.has(strategy)) {
      throw new Error(`--control must not repeat strategy "${strategy}"`);
    }
    seenControls.add(strategy);
    controls.push({ strategy, path });
    index += 1;
  }
  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const requestedArms = value('arms', STRATEGIES.join(',')).split(',').map((raw): Strategy => {
    const arm = STRATEGIES.find((strategy) => strategy === raw.trim());
    if (arm === undefined) {
      throw new Error(`--arms names "${raw.trim()}"; known arms: ${STRATEGIES.join(', ')}`);
    }
    return arm;
  });
  const duplicate = requestedArms.find((arm, index) => requestedArms.indexOf(arm) !== index);
  if (duplicate !== undefined) {
    throw new Error(`--arms repeats "${duplicate}"; each requested arm must appear exactly once`);
  }
  // NO PRIVILEGED SUBSET. `--candidates-only` used to select
  // {bounded-layers, merkle-pack} behind the operator's back; every arm now
  // competes, so a subset is named outright with `--arms` or it is all of them.
  // REPETITIONS ARE THE ONLY THING G9 CAN SCORE, so the default follows the
  // gate rather than the operator's memory: a decisive run asks for the fewest
  // a dispersion claim can rest on, and an ordinary run — a smoke check that
  // ranks nothing — asks for one.
  const decisive = argv.includes('--decisive');
  const rawRepetitions = value('repetitions', String(decisive ? DECISIVE_REPETITIONS : 1));
  // THE WHOLE TEXT, not `parseInt`'s prefix of it: `parseInt('1.5')` is 1, so a
  // fractional count would silently become a single repetition and the run
  // would report a number nobody asked for.
  const repetitions = /^\d+$/.test(rawRepetitions.trim()) ? Number(rawRepetitions.trim()) : Number.NaN;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(
      `--repetitions must be a whole number of 1 or more; got "${rawRepetitions}". `
      + `G9 censors a deciding cell below ${MIN_DECIDING_REPETITIONS} repetitions.`,
    );
  }
  return {
    runId,
    seed: Number.parseInt(value('seed', '20260824'), 10),
    budgetMs: Number.parseInt(value('budget-ms', '8000'), 10),
    decisive: argv.includes('--decisive'),
    verifyOnly: argv.includes('--verify-only'),
    plan: argv.includes('--plan'),
    keep: argv.includes('--keep'),
    repetitions,
    controls,
    arms: requestedArms,
    out: value('out', join('bench-artifacts', `devbox-strategies-${runId}.json`)),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const options = parseOptions(argv);
  const frozenControls = frozenControlArtifacts(options.controls);
  const planned = options.arms.map((strategy) => resourceNames(options.runId, strategy));
  if (options.plan) {
    const controls = options.controls.length === 0
      ? 'none (optional)'
      : options.controls.map((control) => `${control.strategy}=${control.path}`).join(', ');
    process.stdout.write(
      `Devbox strategy A/B plan\n\narms          ${options.arms.join(', ')}\n`
      + `controls      ${controls}\n`
      + `phases        ${PHASES.join(',')}\n`
      + `process-driven ${[...PROCESS_PHASES].join(',')}\n`
      + `change sizes  ${CHANGE_SIZES_KIB.map((k) => (k >= 1024 ? `${k / 1024}MiB` : `${k}KiB`)).join(', ')}\n`
      + `repetitions   ${options.repetitions} per deciding cell (${DECIDING_METRIC} phase`
      + `${options.decisive ? ' and every decisive workload' : ''})\n`
      + `workers       ${planned.map((names) => names.worker).join(', ')}\n`
      + `buckets       ${planned.map((names) => names.bucket).join(', ')}\n`
      + `artifact      ${options.out}\n\nNothing has run. Drop --plan to execute.\n`,
    );
    return 0;
  }
  if (!existsSync(join(BENCH_DIR, 'worker.ts'))) {
    throw new Error(`the devbox bench app is not present at ${BENCH_DIR}`);
  }
  const r2AccessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const r2SecretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  // PREFLIGHT, AHEAD OF EVERY OTHER CHECK IN THIS FUNCTION. The cleanup keys
  // are a LOCAL prerequisite: asking for them costs nothing, and asking after
  // the deploy is what run 20260902154130 did — thirteen minutes of
  // measurement, then a teardown that could not verify itself.
  const keyRefusal = r2CleanupKeyRefusal({
    verifiesCleanup: !options.keep,
    accessKeyIdPresent: r2AccessKeyId !== undefined && r2AccessKeyId !== '',
    secretAccessKeyPresent: r2SecretAccessKey !== undefined && r2SecretAccessKey !== '',
  });
  if (keyRefusal !== null) {
    log(keyRefusal);
    return 1;
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = BENCH_ACCOUNT_ID;
  if (wrangler(['whoami'], { allowFailure: true }).startsWith(WRANGLER_FAILED)) {
    log('wrangler is not authenticated; nothing can be deployed');
    return 1;
  }

  // Capture source identity BEFORE bundling or deploying it. A revision read
  // after a long run could name edits made while the old source was already in
  // the deployed Worker, which is worse than an absent identity because it
  // attributes real numbers to the wrong driver.
  const revision = sourceRevision();
  const startedAt = new Date().toISOString();

  const residue = r2AccessKeyId !== undefined && r2SecretAccessKey !== undefined
    ? r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey })
    : null;

  // ABANDONED RUNS FIRST, BEFORE THIS RUN CREATES ANYTHING.
  //
  // A driver killed between its deploy and its teardown leaves a manifest
  // naming live Workers, container applications and buckets, and nothing ever
  // read it: recovery only happened inside the process that wrote it, which is
  // exactly the process that is gone. Every interrupted run therefore added a
  // permanent set of resources to the account, and the next run's own teardown
  // could not see them because they belong to a different run id.
  //
  // Deleting them here, before the deploy, also keeps this run's own accounting
  // honest: leftover buckets from a previous run are residue the C1–C7 checks
  // would otherwise have to explain away.
  const recovered = await recoverAbandonedRuns(
    REPO_ROOT,
    options.runId,
    orphanTeardownExecutor(residue),
    log,
  );
  const unswept = recovered.filter((run) => run.failures.length > 0 || !run.replayed);
  if (recovered.length === 0) {
    log('no abandoned benchmark resources from earlier runs');
  } else if (unswept.length > 0) {
    log(
      `${unswept.length} earlier run(s) still hold resources: `
      + `${unswept.map((run) => run.runId).join(', ')}`,
    );
  }

  const fixtures = await createFixtureResources(options.runId, options.arms);
  const teardownManifest = fixtures.manifest;
  const lanes = fixtures.arms.map((fixture): ArmLaneState => ({
    fixture,
    box: boxName(options.runId, fixture.strategy),
    boxes: new Set([boxName(options.runId, fixture.strategy)]),
    live: null,
    stop: null,
    workerStopped: false,
    workerVersion: '',
    refusal: null,
  }));
  const token = `devbox-${crypto.randomUUID()}`;
  const arms: ArmResult[] = [];
  let cleanupReport: CleanupReport | null = null;
  const cleanupErrors: string[] = [];
  let failure: string | null = null;
  publishTeardown(async (): Promise<void> => {
    if (options.keep) {
      teardownManifest.kept = true;
      writeManifest(REPO_ROOT, teardownManifest);
      log('--keep left the Worker, container applications, bucket, and generated config in place');
      return;
    }
    // EVERY LIVE ARM'S BOXES, THROUGH THAT ARM'S OWN WORKER. There is no one
    // fixture that can sweep them all: an arm answers only on its own
    // deployment, and an arm that never deployed has nothing to sweep.
    for (const lane of lanes) {
      if (lane.live === null) continue;
      const liveTeardownErrors = await teardownLiveArms(lane.live, lane.boxes);
      cleanupErrors.push(...liveTeardownErrors);
      if (liveTeardownErrors.length > 0) {
        failure ??= `live teardown failed: ${liveTeardownErrors.join('; ')}`;
      }
    }
    const replay = await replayTeardown(REPO_ROOT, teardownManifest, async (entry): Promise<DeleteOutcome> => {
      if (entry.kind === 'worker') {
        const lane = lanes.find((candidate) => candidate.fixture.worker === entry.name);
        if (lane === undefined) return { ok: false, error: `no arm owns Worker ${entry.name}` };
        const statuses = (lane.stop ?? (() => deleteFixtureResources(lane.fixture)))();
        if (statuses.length > 0) log(`${lane.fixture.strategy} fixture resources: ${statuses.join(', ')}`);
        const failed = statuses.find((status) => /failed/i.test(status));
        // OBSERVED, never assumed. This was set unconditionally, one line above
        // the check that reads the same statuses — so a Worker whose delete
        // FAILED still flipped the flag, and the box's `do-state`, `alarm` and
        // `mount` entries then answered `ok` on the strength of it. Those
        // entries were marked done and persisted, which puts them beyond the
        // startup sweep forever: it only revisits UNFINISHED entries. C4/C5
        // read the same flag, so the run also certified durable state absent
        // while the Worker serving it was still up.
        lane.workerStopped = failed === undefined;
        return failed === undefined ? { ok: true } : { ok: false, error: failed };
      }
      if (entry.kind === 'container-app') {
        if (containerAppIds(REPO_ROOT, [entry.name], log).length === 0) return { ok: true, absent: true };
        const statuses = deleteContainerApps(REPO_ROOT, [entry.name], log);
        const failed = statuses.find((status) => /failed/i.test(status));
        return failed === undefined ? { ok: true } : { ok: false, error: failed };
      }
      if (entry.kind === 'r2-bucket') {
        let deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });
        if (deleted.startsWith(WRANGLER_FAILED) && /not empty|10008/i.test(deleted) && residue !== null) {
          // An interrupted run leaves objects its arm never drained and open
          // multipart uploads no listing shows; drain both, then ask once more.
          const drained = await drainBucketResidue(residue, entry.name);
          log(`${entry.name}: drained ${String(drained.objects)} object(s), aborted ${String(drained.uploads)} upload(s)`);
          deleted = wrangler(['r2', 'bucket', 'delete', entry.name], { allowFailure: true });
        }
        if (!deleted.startsWith(WRANGLER_FAILED)) return { ok: true };
        if (/not found|does not exist/i.test(deleted)) return { ok: true, absent: true };
        return { ok: false, error: deleted.slice(0, 240) };
      }
      if (entry.kind === 'do-state' || entry.kind === 'alarm' || entry.kind === 'mount') {
        // Gated on THIS box's own Worker. An arm whose Worker is still up has
        // durable state nothing has proved gone, however many siblings are.
        const lane = lanes.find((candidate) => candidate.box === entry.name);
        return lane?.workerStopped === true
          ? { ok: true }
          : { ok: false, error: 'Worker must be deleted before its durable state' };
      }
      if (entry.kind === 'local-path') {
        fixtures.disposeConfig();
        return { ok: true };
      }
      return { ok: false, error: `unsupported teardown resource ${entry.kind}` };
    });
    if (replay.failures.length > 0) {
      cleanupErrors.push(...replay.failures);
      failure ??= `cleanup failed: ${replay.failures.join('; ')}`;
    }
    let cleanupCheck: CleanupReport | null = null;
    try {
      cleanupCheck = await checkCleanup(REPO_ROOT, teardownManifest, {
        ...cleanupObservationProbes({ wrangler, residue }),
        containerAppAbsent: async (name) => containerAppIds(REPO_ROOT, [name], log).length === 0,
        boxStateEmpty: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
        alarmAbsent: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
        mountAbsent: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
        localPathAbsent: async (path) => !existsSync(path),
        processAbsent: async () => true,
        counters: async () => ({ ...teardownManifest.counters }),
      }, R2_OP_VOCABULARY);
    } catch (cause) {
      // A verifier that could not OBSERVE proves nothing either way; the
      // artifact then carries no cleanup evidence and admission refuses it.
      cleanupErrors.push(`cleanup verification failed: ${describeThrown({ cause })}`);
      failure ??= 'cleanup verification failed';
    }
    cleanupReport = cleanupCheck;
    if (cleanupCheck !== null && !cleanupCheck.passed) {
      cleanupErrors.push(...cleanupCheck.checks.filter((row) => !row.ok).map((row) => `${row.gate}: ${row.detail}`));
      failure ??= 'cleanup admission checks failed';
    }
    if (!lanes.every((lane) => lane.workerStopped)) fixtures.disposeConfig();
  });

  try {
    // EVERY ARM'S OWN WORKER AND BUCKET, DEPLOYED BEFORE ANY ARM IS MEASURED.
    //
    // Deliberately not inside the in-flight window below, for a mechanical
    // reason: every wrangler call is `execFileSync`, which does not yield this
    // process's event loop. A deploy running beside a measuring sibling would
    // stop that sibling's polling for the length of a container image build,
    // and the first thing it would corrupt is the cold attach — a driver-side
    // wall clock the admission contract holds to a 25 s ceiling. The deletes
    // are kept out of that window for the same reason: they run from the
    // teardown replay, after the last arm has returned.
    //
    // ONE ARM'S DEPLOY IS ONE ARM'S FAILURE. A refusal here is recorded on the
    // lane and answered when that arm's turn to measure comes, so an arm that
    // could not be deployed refuses itself and its siblings still run.
    for (const lane of lanes) {
      await armLogContext.run(lane.fixture.strategy, async (): Promise<void> => {
        try {
          wrangler(['r2', 'bucket', 'create', lane.fixture.bucket]);
          const started = await deployFixture(token, lane.fixture);
          lane.stop = started.stop;
          lane.live = started.fixture;
          lane.workerVersion = started.workerVersion;
        } catch (error) {
          lane.refusal = `deploy failed: ${describeThrown({ cause: error })}`;
          log(lane.refusal);
        }
      });
    }

    // EVERY ARM AT ONCE. Each arm holds its own Worker, its own bucket and its
    // own container instance, so the only thing they share from here is this
    // driver's polling, which waits on the network rather than on a CPU.
    // `runArmsInFlight` keeps one arm's death off its siblings; `runArm` keeps
    // the rows an arm did measure and hands its container instance back.
    arms.push(...await runArmsInFlight(options.arms, options.runId, async (strategy) => {
      const lane = lanes.find((candidate) => candidate.fixture.strategy === strategy);
      if (lane === undefined) throw new Error(`no deployment was prepared for ${strategy}`);
      if (lane.live === null) throw new Error(lane.refusal ?? 'this arm was never deployed');
      const arm = await runArm(lane.live, strategy, options, (box) => lane.boxes.add(box));
      for (const [name, count] of Object.entries(arm.ops?.calls ?? {})) {
        teardownManifest.counters[name] = (teardownManifest.counters[name] ?? 0) + count;
      }
      writeManifest(REPO_ROOT, teardownManifest);
      return arm;
    }));
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // The stack is the diagnosis: three runs died as a bare `TimeoutError`
    // with no stage named, and each cost a 15-minute deployment to learn
    // nothing. A refused run must say which call refused it.
    log(`run failed: ${failure}`);
    const thrown = parseThrown({ cause: error });
    if (thrown.stack !== undefined && thrown.stack.length > 0) log(`run failure stack:\n${thrown.stack}`);
    if (thrown.cause !== undefined) log(`run failure cause: ${describeThrown({ cause: thrown.cause })}`);
  } finally {
    await runTeardownOnce();
  }

  // THE ASSEMBLY READS THE DURABLE FILES, NOT ITS OWN MEMORY. Every arm wrote
  // its row to bench-artifacts/<run>/<arm>.json at each phase boundary, so a
  // run whose in-flight window was interrupted by anything this catch already
  // survived still assembles exactly what its arms settled. An arm with no
  // file never settled in THIS process — recorded as externally-aborted with
  // the log tail, never as an unmeasured row that would misread a wedge as a
  // strategy that measured nothing.
  const settledArms = options.arms.map((strategy) => {
    const read = readArmArtifact(REPO_ROOT, options.runId, strategy);
    if (read.error !== null) {
      log(`the durable artifact for ${strategy} could not be read: ${read.error}`);
      failure ??= `the durable artifact for ${strategy} could not be read`;
    }
    if (read.artifact !== null) return read.artifact.row;
    const reason = read.error ?? failure ?? 'this arm never settled before the run ended';
    return externallyAbortedArm(strategy, `ab-${strategy}-${options.runId}`, reason);
  });
  arms.length = 0;
  arms.push(...settledArms);

  const meta: RunMeta = {
    date: new Date().toISOString().slice(0, 10),
    run: `${FIXTURE_BASE}-${options.runId}`,
    worker: lanes.map((lane) => lane.fixture.worker).join(', '),
    bucket: lanes.map((lane) => lane.fixture.bucket).join(', '),
    image: SANDBOX_IMAGE,
    seed: String(options.seed),
    'loop budget ms': String(options.budgetMs),
    'deciding repetitions': String(options.repetitions),
  };
  if (frozenControls.length > 0) {
    meta['frozen controls provenance'] = frozenControls
      .map((control) => `${control.artifact}#sha256:${control.sha256}`)
      .join(', ');
  }
  const multipartResidue = arms.some((arm) => arm.teardown?.emptyBucketGuaranteed === false) ? 1 : 0;
  const cleanup: CleanupEvidence = options.keep || cleanupReport === null
    ? {
        attempted: !options.keep,
        kept: options.keep,
        workerAbsent: false,
        runtimeAbsent: false,
        bucketAndMultipartEmpty: false,
        boxDurableStateEmpty: false,
        countersReconciled: false,
        replayIdempotent: false,
        localSecretsProcessesAbsent: false,
        multipartResidue,
        errors: cleanupErrors,
      }
    : (() => {
        const fromReport = cleanupEvidenceFromReport(cleanupReport);
        return { ...fromReport, errors: [...fromReport.errors, ...cleanupErrors] };
      })();
  const identity: RunIdentity = {
    commit: revision.commit,
    dirtyDigest: revision.dirtyDigest,
    // ONE VERSION PER DEPLOYED ARM, named by the arm it served. A run with five
    // Workers has five deployed versions, and a single id could only be one of
    // them; an arm that never deployed contributes nothing, so a run that
    // deployed nothing records nothing and G0 refuses it.
    workerVersion: lanes
      .filter((lane) => lane.workerVersion !== '')
      .map((lane) => `${lane.fixture.strategy}=${lane.workerVersion}`)
      .join(', '),
    startedAt,
    finishedAt: new Date().toISOString(),
    image: SANDBOX_IMAGE,
    ...fixtures.digests,
  };
  const admission = devboxAdmission({
    arms,
    requested: options.arms,
    repetitions: options.repetitions,
    meta,
    identity,
    token,
    cleanup,
  });
  mkdirSync(dirname(join(REPO_ROOT, options.out)), { recursive: true });
  writeFileSync(
    join(REPO_ROOT, options.out),
    `${JSON.stringify({ meta, identity, frozenControls, arms, cleanup, admission }, null, 2)}\n`,
  );
  // A PARTIAL RUN SAYS SO. When some arm was not measured, the frozen-control
  // section renders even if it is empty, so the report states outright whether
  // history covered the gap rather than leaving the absence unremarked.
  const partial = options.arms.length < STRATEGIES.length;
  process.stdout.write(`${render(arms, meta, admission, frozenControls, partial)}\n`);
  log(`artifact written to ${options.out}`);
  return benchmarkExitCode(failure, admission);
}

if (import.meta.main) process.exit(await main());
