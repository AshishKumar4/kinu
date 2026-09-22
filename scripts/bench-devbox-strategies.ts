#!/usr/bin/env bun
/** Benchmark driving the real Devbox lifecycle per storage strategy; an arm whose
 *  lifecycle proof fails measured a blank disk and is refused; wake runs deployed-only. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, armSignalTeardown, awaitApplicationRollout, containerAppIds, delay, deleteContainerApps,
  describeThrown, publishTeardown, runTeardownOnce, runWrangler, type ApplicationRollout,
} from './fixtures/r2-bench/deploy-substrate';
import * as v from 'valibot';
import {
  ExecReplySchema, CheckpointReplySchema, FileEvidenceSchema,
  StateReplySchema, KickReplySchema, DestroyReplySchema, TeardownReplySchema,
  type ExecReply, type CheckpointReply, type FileObservation,
  type AttachOutcome, type StateReply, type KickReply, type StartupPoll, type StartupCompletion,
  type StartupObservation, type StartupIncidents, type DestroyReply, type TeardownReply,
} from '../packages/devbox/bench/observation-schema';

export type { ExecReply, CheckpointReply, FileObservation, StateReply, StartupPoll, StartupCompletion, StartupObservation } from '../packages/devbox/bench/observation-schema';

import { CHAIN_SERVED_WORDS, DELTA_MANIFEST_NAME, DeltaManifestSchema, type DeltaManifest } from '../packages/devbox/src/chunked-delta';
import { BlockAttachMetricsSchema, evaluateLiveC3, type BlockAttachMetrics, type C3Identity, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import { PublicationWindowSchema, publicationTotals } from '../packages/devbox/bench/publication-meter';
import { C3_BYTES_BOUND, C3_WORKLOAD } from '../packages/devbox/bench/witness-files';
import { parseArgs } from 'node:util';
import { AwsClient } from 'aws4fetch';
import { summarize, type Summary } from './fixtures/r2-bench/stats';
import { parseProbeRun, type ProbeRun } from './fixtures/r2-bench/report';
import {
  RULE_WORKLOADS, opsAreBlind,
  sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';
import {
  R2_OP_VOCABULARY, cleanupEvidenceFromReport, evaluateRun, expectedCells,
  refusalText, requireAdmitted, type AccountingEvidence, type AdmissionVerdict, type ArmEvidence,
  type CellCompletion, type CleanupEvidence, type GateId, type PublicationEvidence,
  type RestoreClaim, type RestoreEvidence, type RunProvenance, type StorageRunRecord,
} from './fixtures/storage-matrix/admission';
import {
  RestorePhaseStampsSchema, type RestorePhaseStamps, type RestoreWork,
} from '@kinu.run/devbox/durability/contracts';
import {
  PublicationCutSchema, publicationWasCut, rendezvousPublicationCut, type PublicationCut,
} from '../packages/devbox/bench/publication-cut';
import type { MeasuredCell, StageId } from './fixtures/storage-matrix/protocol';
import {
  checkCleanup, createManifest, recoverAbandonedRuns, replayTeardown, writeManifest,
  type CleanupProbes, type CleanupReport, type DeleteOutcome, type TeardownEntry,
  type TeardownManifest,
} from './fixtures/storage-matrix/cleanup';
import { parseJsonc } from './jsonc';
import { trackedFiles } from './sources';
import blockImage from '../packages/devbox/block-lower/upstream.json';
import {
  runSecurityFaultCells,
  securityNonce,
  summarizeSecurity,
  type SecurityCellsObservation,
} from './fixtures/r2-bench/security/cells';

/** After a rebase `base.id` is a fresh uuid and `delta` is absent; `rev` is monotonic across
 *  both, which distinguishes a rebase from a quiesce that wrote nothing. */
interface ChainGeneration {
  readonly baseId: string | null;
  readonly deltaId?: string | null;
  readonly hasDelta: boolean;
  readonly rev: number | null;
}



export type StartupPollVerdict =
  | { readonly kind: 'pending' }
  /** The container is DOWN and this generation never started a restoration:
   *  no scheduled work exists for a later poll to observe. */
  | { readonly kind: 'stopped'; readonly detail: string }
  | { readonly kind: 'attached'; readonly attach: AttachOutcome }
  /** Attach passed but restoration failed; `incomplete` names what did not come back.
   *  Kept apart from `attached` so a box publishing no working URL never reads as success. */
  | { readonly kind: 'repair'; readonly attach: AttachOutcome; readonly incomplete: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** A settled attach counts only while the container is observed running; a stopped container
 *  re-enters readiness despite a leftover attach record. Terminal refusals are never re-driven. */
export function startupPollVerdict(reply: StateReply): StartupPollVerdict {
  const state = reply.state;

  if (state?.restoration === 'unattached') {
    return { kind: 'failed', reason: state.unready ?? 'the startup refused without a reason' };
  }

  if (state?.running === false) {
    return {
      kind: 'stopped',
      detail: state.unready ?? 'the container is stopped and no current restoration is running',
    };
  }

  if (state?.running !== true) return { kind: 'pending' };

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

  return { kind: 'pending' };
}

/** `pending` reflects only the driver's knowledge; these fields tell unadmitted, unrestored
 *  and refusing boxes apart. Incidents filed during a pending poll mean it is already failing. */
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
  const reply = await call({ fixture, method: 'GET', path: `/state?box=${box}`, schema: StateReplySchema });

  return chainGenerationFromState(reply);
}

function chainGenerationFromState(reply: StateReply): ChainGeneration {
  const chain = reply.state?.chain ?? null;

  return {
    baseId: chain?.base?.id ?? null,
    deltaId: chain?.delta?.id ?? null,
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

/** The account every devbox fixture is raised on; exported so the deployed lifecycle suite
 *  names this one rather than a second copy (`gate:policy-drift` checks this). */
export const BENCH_ACCOUNT_ID = 'f44999d1ddda7012e9a87729eba250f1';

const FIXTURE_BASE = 'kinu-devbox-bench';

const FIXTURE_CLASS_BY_STRATEGY = {
  'snapshot-chain': 'SnapshotChainBox',
} as const satisfies Record<Strategy, string>;

const FIXTURE_COUNTER_CLASS = 'BenchOpCounter';

export interface FixtureNames {
  readonly worker: string;
  readonly bucket: string;
  readonly containerApps: readonly string[];
}

/** Digest of the image the arms actually ran on: a provenance row naming only the commit
 *  cannot tell two runs on different images apart. */
interface FixtureImageDigests {
  readonly imageSha256: string;
}

/** One arm's own Worker, bucket, container application and config.
 *  Nothing in here is shared with another arm. */
export interface ArmFixture extends FixtureNames {
  readonly strategy: Strategy;
  readonly configPath: string;
  /** The exact per-arm Wrangler config, retained while teardown owns its directory. */
  readonly config: string;
}

export interface FixtureResources {
  readonly arms: readonly ArmFixture[];
  /** Written to disk before the first resource is created, so no caller can deploy a fixture
   *  whose resources nothing durable has recorded. */
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

/** Per arm, not per run: concurrent arms sharing a bucket would lose data to one arm's
 *  `/teardown` whole-bucket purge, and sharing a Worker lets `/ops/reset` zero a sibling's tally. */
export function resourceNames(runId: string, arm: Strategy): FixtureNames {
  const worker = `${FIXTURE_BASE}-${runId}-${arm}`;

  return {
    worker,
    bucket: worker,
    containerApps: [`${worker}-${FIXTURE_CLASS_BY_STRATEGY[arm].toLowerCase()}`],
  };
}

/** Single source for the box name: the teardown manifest names it as durable state, so
 *  a separate copy could drift and leave the real box undeleted. */
export function boxName(runId: string, arm: Strategy): string {
  return `ab-${arm}-${runId}`;
}

/** Deploys only the selected arms' classes, their containers and one bucket; nothing is shared
 *  with another arm or an earlier run, so teardown can delete the complete deployed set. */
export function fixtureConfigForArms(
  template: string,
  names: FixtureNames,
  arms: readonly Strategy[],
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
      .map((container) => ({ ...container, image: SANDBOX_IMAGE })),
    r2_buckets: config.r2_buckets.map((bucket) => bucket.bucket_name === 'kinu-devbox-bench'
      ? { ...bucket, bucket_name: names.bucket }
      : bucket),
  }, null, 2)}\n`;
}

/** Planned before any resource exists: names derive only from `runId` and the arms.
 *  One set per arm, so an interrupted run tears down each arm's resources on its own evidence. */
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

export function createFixtureResources(
  runId: string,
  arms: readonly Strategy[],
): FixtureResources {
  // The manifest is written before the build directory exists, so a killed driver leaves a record.
  // The directory name derives from the run id, not `mkdtemp`, so it can be recorded and swept.
  const dir = join(tmpdir(), `kinu-devbox-bench-${runId}`);
  const manifest = plannedTeardownManifest(runId, arms, dir);
  writeManifest(REPO_ROOT, manifest);
  mkdirSync(dir, { recursive: true });
  const template = readFileSync(join(BENCH_DIR, 'wrangler.jsonc'), 'utf8');

  const armFixtures = arms.map((strategy): ArmFixture => {
    const names = resourceNames(runId, strategy);
    const configPath = join(dir, `wrangler-${strategy}.jsonc`);
    const config = fixtureConfigForArms(template, names, [strategy]);
    writeFileSync(configPath, config);

    return { ...names, strategy, configPath, config };
  });

  return {
    arms: armFixtures,
    manifest,
    configDir: dir,
    digests: { imageSha256: SANDBOX_IMAGE_DIGEST },
    disposeConfig: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

const HARNESS = '/workspace/.devbox-bench';

const PROBE_FILES = ['stats.ts', 'probe.ts', 'decisive.ts'] as const;

export const SANDBOX_IMAGE_DIGEST = blockImage.digest;

/** Fixture configs pin this immutable reference so the provenance row names the bytes that ran,
 *  not a tag another publisher can repoint. */
export const SANDBOX_IMAGE = blockImage.image;

/** `npm` runs with and without excludes: excludes change the changed-set, not the work,
 *  so the pair isolates the policy's worth. `git` carries the 10x bar; `sqlite` is separate. */
const DECISIVE_WORKLOADS = [
  { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
  { id: 'npm-excluded', workload: 'npm', excludes: true, args: '--target-mib 400 --segments 4' },
  { id: 'git', workload: 'git', excludes: false, args: '--files 2000 --commits 200 --touch-percent 5 --segments 4' },
  { id: 'sqlite', workload: 'sqlite', excludes: false, args: '--size-mib 64 --segments 4' },
] as const;

/** Index 0 seeds; only segments 1..N, the incremental ones, are measured. */
const SEGMENTS_PER_WORKLOAD = 4;

/** Waits out the minimum-interval guard, which otherwise skips every tick after the first.
 *  Derived from the bench fixture's `checkpointIntervalMs: 2_000`, not the shipped default. */
const MIN_CHECKPOINT_INTERVAL_MS = 3_000;

/** Groups a blocking exec cannot reach; backgrounded and polled instead.
 *  `archive` reads cross R2, so its duration tracks remote latency and can exceed any deadline. */
const PROCESS_PHASES = new Set<string>([
  'npmlike', 'gitlike', 'small1k', 'small10k', 'seq100', 'archive',
]);

const PHASES = ['posix', 'seq1', 'seq10', 'rand', 'archive', 'small1k', 'npmlike'] as const;

/** Change sizes for the checkpoint ladder, in KiB of freshly written bytes. */
const CHANGE_SIZES_KIB = [64, 4_096, 65_536] as const;

const POLL_MS = 10_000;

const PROCESS_DEADLINE_MS = 1_500_000;

export type Strategy = 'snapshot-chain';

export const STRATEGIES: readonly Strategy[] = ['snapshot-chain'];

export const SHIPPED_STRATEGY = 'snapshot-chain' as const satisfies Strategy;

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
    /** Optional: frozen artifacts recorded before per-check lifecycle rows existed lack them. */
    readonly verifyChecks?: readonly { readonly name: string; readonly pass: boolean }[];
    /** The arm's own `/ops` tally. Absent, or present with no total, in an
     *  artifact whose run never reconciled its accounting. */
    readonly ops?: { readonly total?: number } | null;
  }[];
  /** C1–C7 cleanup evidence; the admission boolean alone cannot reconstruct it, so a frozen
   *  artifact carries the raw cleanup contract the current instrument evaluates. */
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

/** A control's status reflects the evidence it carries, not its `verifyPassed` boolean.
 *  `legacy-contract` is never a pass: a missing contract cannot be satisfied retroactively. */
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
  readonly statusDetail: string;
}

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

/** Any strategy may be supplied frozen: "frozen" means its numbers come from a previous run,
 *  never which arms may win. The source artifact supplies the recorded provenance and digest. */
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

  const arm = arms[0];
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
  /** Runs the decisive workloads and decision rule; off by default because it writes
   *  hundreds of megabytes per arm. */
  decisive: boolean;
  /** Durability verification and cleanup only: one arm's ladder, stop, wake, teardown, no workloads.
   *  Wins over `decisive` at parse time, so a probe scope never silently runs a decisive workload. */
  verifyOnly: boolean;
  plan: boolean;
  /** Enables the publication rendezvous in each Worker before its proxy boots. */
  faultCuts: boolean;
  /** Schema-validated historical context from previous runs. These paths never
   *  affect current-arm ranking. */
  controls: readonly ControlOption[];
  /** Arms to run, from `--arms a,b`; defaults to all five. An unknown name refuses
   *  rather than measuring an empty run. */
  arms: readonly Strategy[];
  /** Leave every external resource in place for inspection. Deliberate, but
   *  it means cleanup did not complete, so the run cannot recommend. */
  keep: boolean;
  /** Measurements per deciding cell per arm; G9 censors a cell with fewer than two repetitions.
   *  Two under `--decisive`, one otherwise (an ordinary run is a smoke check); never below one. */
  repetitions: number;
  /** Unique Durable Object suffix. A Worker redeploy does not delete DO
   * storage, so fixed box names contaminate a later run with prior state. */
  runId: string;
  out: string;
}

/** Arms run concurrently on one stderr; shared transport helpers take no arm, so attribution
 *  rides the async context rather than a logger parameter threaded through every signature. */
const armLogContext = new AsyncLocalStorage<Strategy>();

/** Bounded: the artifact is a diagnosis aid, not a log archive; the last lines before
 *  a wedge are the ones that name it. */
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

export const armLogTail = (arm: Strategy): readonly string[] => [...(armLogTails.get(arm) ?? [])];

export const resetArmLogs = (): void => { armLogTails.clear(); };

/** Attributes (and mirrors) shared-transport lines inside `work` to `arm`. Exported for the
 *  lifecycle suite, whose lanes bypass `runArmsInFlight`; unattributed arms get no tail. */
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

/** Open multipart uploads are invisible to `bucket info` and the REST object list; only S3
 *  ListMultipartUploads sees them, and they or leftover objects block `bucket delete` (10008). */
export interface R2ResiduePlane {
  listObjects(bucket: string): Promise<readonly string[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  listUploads(bucket: string): Promise<readonly { key: string; uploadId: string }[]>;
  abortUpload(bucket: string, key: string, uploadId: string): Promise<void>;
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

/** C1/C3 verifiers only observe; teardown replay is the sole deleter, since a checker that
 *  deletes cannot tell "teardown worked" from "the checker mopped up". */
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

      // Without S3 keys only absence is provable: R2 refuses to delete a bucket holding objects
      // or open uploads. A present bucket's multipart count is unmeasured, and unmeasured is not zero.
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

/** Named here, never read here: the values go from the environment straight into
 *  `r2ResiduePlane`, and nothing in this driver prints either one. */
export const R2_CLEANUP_KEY_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

export const R2_CLEANUP_KEY_FILE = '.dev.vars';

/** Refuses before anything is created: without S3 keys `bucketState` throws at teardown and
 *  C1–C7 would be written false. Takes presence booleans only, so it cannot leak a credential. */
export function r2CleanupKeyRefusal(input: {
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

/** Exported so the deployed lifecycle suite drives the same routes through these seams
 *  instead of opening a second HTTP client. */
export interface Fixture { origin: string; token: string; identity?: C3Identity }

/** Every field the driver ever sends. The fixture parses the same closed set at
 *  its edge, so a key nobody declares here cannot reach a route. */
interface DriverRequest {
  readonly strategy?: Strategy;
  readonly command?: string;
  readonly path?: string;
  readonly content?: string;
  readonly kind?: 'tick' | 'quiesce';
  /** Idempotency key for one semantic operation on the two armed routes; reused across retries
   *  so a re-posted request cannot arm a second publication. */
  readonly op?: string;
  readonly purge?: boolean;
  readonly prefix?: string;
  readonly whole?: boolean;
}

export interface AddressedArmRequest {
  readonly path: string;
  readonly body?: DriverRequest;
}

/** Binds every box-addressed request to its arm: GET carries it in the query, POST in JSON.
 *  fetch rejects a GET body, so GET must never carry the arm in a body. */
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

/** The schema is a parameter, not a type argument: every reply crosses an unseen network.
 *  A contract mismatch fails with the wire's own error; a defaulted number would get published. */
const STATE_POLL_REQUEST_TIMEOUT_MS = 15_000;

/** A fetch deadline arrives as a DOMException named TimeoutError, not an Error subclass,
 *  often with an empty stack; parse `name` rather than relying on `instanceof Error`. */
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

/** Takes the PARSED shape; the catch that owns the raw thrown value parses it first. */
function isTransportLoss(thrown: v.InferOutput<typeof ThrownFailureSchema>): boolean {
  return /TimeoutError|AbortError/.test(thrown.name ?? '')
    || /timed out|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(thrown.message ?? '');
}

/** Retrying is safe: endpoints are idempotent probes and measurements are the server's `ms`.
 *  Deadline is always explicit (bare fetch dies on idle timeout); reply-level churn: `retryTransient`. */
const CALL_DEADLINE_MS = 180_000;

const CALL_ATTEMPTS = 3;

interface Call<TSchema extends v.GenericSchema> {
  readonly fixture: Fixture;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly schema: TSchema;
  readonly body?: DriverRequest;
  readonly timeoutMs?: number;
}

async function call<TSchema extends v.GenericSchema>(
  { fixture, method, path, schema, body, timeoutMs }: Call<TSchema>,
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
/** Reply schemas are loose objects: undeclared fields are preserved, not stripped, because
 *  `/ops` and `/teardown` replies are archived whole and a new field must survive this driver. */

interface AckReply { ok?: boolean; error?: string }

const AckReplySchema: v.GenericSchema<AckReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

/** A boot-window refusal from `ensureReady()` means nothing reached the container, so retry is safe.
 *  `untilMs` is the startup observation ceiling, not a transport timeout; the last refusal is returned. */
export async function askWhileStarting<Reply extends { ok?: boolean; error?: string }>(
  operation: string,
  ask: () => Promise<Reply>,
  untilMs: number = CELL_STARTUP_MS,
): Promise<Reply> {
  const since = Date.now();
  let asked = 0;

  for (;;) {
    const reply = await ask();
    asked += 1;

    if (reply.ok === true || !isRearmableStartupRefusal(reply.error)) {
      if (asked > 1) log(`${operation}: answered on ask ${String(asked)}, ${String(Date.now() - since)} ms after the first`);

      return reply;
    }

    if (Date.now() - since >= untilMs) {
      log(`${operation}: still starting after ${String(asked)} ask(s) and ${String(Date.now() - since)} ms; the last refusal stands`);

      return reply;
    }

    if (asked === 1) log(`${operation}: the box is starting (${reply.error ?? 'no reason'}); asking again`);
    await delay(STARTUP_POLL_INTERVAL_MS);
  }
}

/** `timeoutMs` is per attempt; `/exec` waits on `ensureReady()`, so a caller with a smaller
 *  window passes it or a slow restoration holds the request for the whole default deadline. */
export async function execInBox(
  fixture: Fixture, box: string, command: string, timeoutMs?: number,
): Promise<ExecReply> {
  return await askWhileStarting(
    `exec ${command.length > 48 ? `${command.slice(0, 48)}…` : command}`,
    async () => await call({
      fixture,
      method: 'POST',
      path: `/exec?box=${box}`,
      schema: ExecReplySchema,
      body: { command },
      timeoutMs,
    }),
  );
}

export interface BarrierWitness {
  readonly path: string;
  readonly expectedDigest: string;
  readonly expectedSize: number;
}

export interface BarrierAcknowledgement {
  readonly witnesses: readonly BarrierWitness[];
  readonly checkpoint: CheckpointReply | null;
}

export function barrierAckLoss(
  acknowledgement: BarrierAcknowledgement | null,
  observations: readonly FileObservation[],
): number | null {
  if (acknowledgement?.checkpoint?.ok !== true
    || acknowledgement.checkpoint.outcome?.kind !== 'committed'
    || acknowledgement.witnesses.length === 0) return null;
  const paths = new Set<string>();
  let lost = 0;

  for (const witness of acknowledgement.witnesses) {
    if (paths.has(witness.path)) return null;
    paths.add(witness.path);
    const reads = observations.filter((row) => row.path === witness.path);

    if (reads.length !== 1) return null;
    const observed = reads[0];

    if (observed === undefined || observed.error !== null || observed.evidence === null
      || observed.reply?.ok !== true || observed.reply.exitCode !== 0) return null;
    const evidence = observed.evidence;

    if (evidence.kind === 'missing' || evidence.sha256 !== witness.expectedDigest
      || evidence.size !== witness.expectedSize) lost++;
  }

  return lost;
}

function witnessMatches(observation: FileObservation, expectedDigest: string): boolean | null {
  const evidence = observation.evidence;

  if (evidence === null || observation.error !== null || observation.reply?.ok !== true || observation.reply.exitCode !== 0) return null;

  return evidence.kind === 'file' && evidence.sha256 === expectedDigest;
}

export async function readBoxFile(fixture: Fixture, box: string, path: string, harness = HARNESS): Promise<FileObservation> {
  const observation = { path, reply: null, evidence: null, error: null };
  let reply: ExecReply;

  try {
    reply = await execInBox(fixture, box, `bun ${harness}/witness-files.ts read '${path.replaceAll("'", "'\\''")}'`);
  } catch (error) {
    return { ...observation, error: describeThrown({ cause: error }) };
  }

  if (reply.ok !== true || reply.exitCode !== 0 || reply.stdout === undefined) {
    return { ...observation, reply, error: reply.error ?? reply.stderr ?? 'the file observer did not complete' };
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(reply.stdout);
  } catch (error) {
    return { ...observation, reply, error: `file observer returned invalid JSON: ${describeThrown({ cause: error })}` };
  }

  const parsed = v.safeParse(FileEvidenceSchema, decoded);

  return parsed.success
    ? { path, reply, evidence: parsed.output, error: null }
    : { ...observation, reply, error: `file observer returned invalid evidence: ${issueText(parsed.issues)}` };
}

/** Re-callable on purpose: a recycle discards the container's disk (P1), so a caller that
 *  finds its harness gone writes it again. */
export async function writeFileInBox(
  fixture: Fixture, box: string, path: string, content: string,
): Promise<void> {
  const reply = await askWhileStarting(
    `write ${path}`,
    async () => await call({
      fixture,
      method: 'POST',
      path: `/write?box=${box}`,
      schema: AckReplySchema,
      body: { path, content },
    }),
  );

  // A refused write put no bytes; treating it as written makes a later read-back
  // report a false "bytes differ" for a file never written.
  if (reply.ok !== true) throw new Error(`write ${path} was refused: ${reply.error ?? 'the box did not acknowledge it'}`);
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


/** Each arm owns its Worker and container application alone, so this deletion
 *  is safe while a sibling arm is still measuring. */
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

export interface DeployedFixture {
  readonly fixture: Fixture;
  readonly workerVersion: string;
  /** The container application's rollout, waited out here so no cold attach
   *  contains it. One application per arm (`ArmFixture.containerApps`). */
  readonly rollouts: readonly ApplicationRollout[];
  readonly stop: () => readonly string[];
}

/** Holds until the Worker accepts this run's token AND its container application has a
 *  provisioned instance: `wrangler deploy` returns before that rollout completes. */
export async function deployFixture(
  token: string,
  fixture: ArmFixture,
  faultCuts = false,
): Promise<DeployedFixture> {
  const output = wrangler([
    'deploy', '--config', fixture.configPath, '--var', `BENCH_TOKEN:${token}`,
    '--var', `BENCH_PUBLICATION_CUT:${faultCuts ? '1' : '0'}`,
  ]);

  const deployedAt = Date.now();

  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];

  if (origin === undefined) throw new Error(`deploy printed no workers.dev origin:\n${output.slice(-2500)}`);
  // Two runs from one commit can be served by different Worker versions (a `--var` change
  // alone publishes one); the version id is the only thing that distinguishes them.
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

  const rollouts: ApplicationRollout[] = [];

  for (const application of fixture.containerApps) {
    rollouts.push(await awaitApplicationRollout({ repoRoot: REPO_ROOT, application, log, since: deployedAt }));
  }

  return {
    fixture: { origin, token },
    workerVersion,
    rollouts,
    stop: () => deleteFixtureResources(fixture),
  };
}

/** R2 op tally as `/ops` answers it; the report's cost columns read it. `bytes` counts
 *  what `get` served, keyed by what the key holds (`payload`, `metadata`). */
interface OpTally {
  calls?: Record<string, number>;
  classA?: number;
  classB?: number;
  classFree?: number;
  total?: number;
  bytes?: Record<string, number>;
}

const OpTallySchema: v.GenericSchema<OpTally> = v.looseObject({
  calls: v.optional(v.record(v.string(), v.number())),
  classA: v.optional(v.number()),
  classB: v.optional(v.number()),
  classFree: v.optional(v.number()),
  total: v.optional(v.number()),
  bytes: v.optional(v.record(v.string(), v.number())),
});

/** The driver keeps every failed row in the artifact and excludes its arm from ranking. */
interface VerifyCheck { name: string; pass: boolean; detail: string }

export interface HeadReply {
  ok?: boolean;
  key?: string;
  exists?: boolean;
  size?: number;
  /** The store's identity for the bytes at this key; size cannot detect a same-length rewrite,
   *  which is exactly what the `mutable-delta` witness cell must see. */
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

/** The startup poll reads this same reply; a caller needing the arm's store prefix or its
 *  durable chain record asks here rather than deriving either. */
export async function boxState(fixture: Fixture, box: string): Promise<StateReply> {
  return await call({
    fixture,
    method: 'GET',
    path: `/state?box=${box}`,
    schema: StateReplySchema,
    timeoutMs: STATE_POLL_REQUEST_TIMEOUT_MS,
  });
}

/** What the STORE holds under one key, through the fixture's own `/head` route.
 *  The only fact about durable bytes no container command can answer. */
export async function headObject(fixture: Fixture, box: string, key: string): Promise<HeadReply> {
  return await call({
    fixture,
    method: 'GET',
    path: `/head?box=${box}&key=${encodeURIComponent(key)}`,
    schema: HeadReplySchema,
  });
}

/** Mirrors `IncidentReasonRow` in `packages/devbox/src/devbox.ts`; the decision suite compares key sets literally.
 *  Rows arrive oldest first, which adjacent-to-publish quoting depends on. */
export interface IncidentReasonRow {
  stage?: string;
  reason?: string;
  at?: number;
  attempts?: number;
  delivered?: boolean;
}

const IncidentReasonRowSchema: v.GenericSchema<IncidentReasonRow> = v.looseObject({
  stage: v.optional(v.string()),
  reason: v.optional(v.string()),
  at: v.optional(v.number()),
  attempts: v.optional(v.number()),
  delivered: v.optional(v.boolean()),
});

const IncidentReasonsReplySchema = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
  incidents: v.optional(v.array(IncidentReasonRowSchema)),
});

export interface ContinuityObservation {
  readonly label: string;
  readonly at: number;
  state: StateReply | null;
  incidents: v.InferOutput<typeof IncidentReasonsReplySchema> | null;
  errors: string[];
}

export interface DecisiveSegmentObservation {
  readonly workload: string;
  readonly repetition: number;
  readonly segment: number;
  before: ContinuityObservation | null;
  after: ContinuityObservation | null;
  command: ExecReply | null;
  checkpoint: CheckpointReply | null;
  accounting: { before: OpTally | null; after: OpTally | null };
  segmentName: string | null;
  priced: boolean;
  error: string | null;
}

async function observeContinuity(fixture: Fixture, box: string, label: string): Promise<ContinuityObservation> {
  const row: ContinuityObservation = { label, at: Date.now(), state: null, incidents: null, errors: [] };

  try {
    row.state = await boxState(fixture, box);
  } catch (error) {
    row.errors.push(`state: ${describeThrown({ cause: error })}`);
  }

  try {
    row.incidents = await call({
      fixture,
      method: 'GET',
      path: `/incidents?box=${box}`,
      schema: IncidentReasonsReplySchema,
    });
  } catch (error) {
    row.errors.push(`incidents: ${describeThrown({ cause: error })}`);
  }

  return row;
}

/** The ledger as one line for a refusal message, newest last.
 *  An absent ledger says so rather than reading as an empty one. */
export function describeIncidentReasons(rows: readonly IncidentReasonRow[] | undefined): string {
  if (rows === undefined) return 'unread';

  if (rows.length === 0) return 'none filed';

  return rows.map((incident) =>
    `[${incident.stage ?? '?'}${incident.delivered === true ? '' : ', undelivered'}] ${incident.reason ?? '(no reason)'}`).join(' | ');
}

/** `/proc/mounts` fields are `device mountpoint fstype options dump pass`: index 2 is the
 *  fstype, index 0 is the device. */
function mountAt(mounts: string, mountpoint: string): { line: string; fstype: string } | null {
  for (const raw of mounts.split('\n')) {
    const line = raw.trim();
    const fields = line.split(' ');
    const fstype = fields[2];

    if (fields[1] === mountpoint && fstype !== undefined) return { line, fstype };
  }

  return null;
}

/** Every failure the box filed, oldest first, archived beside the dump whose window filed them.
 *  A missed read notes its gap: the totals alone cannot say what the box filed. */
export async function readIncidentReasons(
  fixture: Fixture,
  box: string,
  notes: string[],
): Promise<IncidentReasonRow[] | undefined> {
  try {
    const reply = await call({
      fixture,
      method: 'GET',
      path: `/incidents?box=${box}`,
      schema: IncidentReasonsReplySchema,
    });

    if (reply.ok !== true || reply.incidents === undefined) {
      notes.push(
        `the incident reasons did not arrive: ${reply.error ?? 'the route answered without its ledger'}`,
      );

      return undefined;
    }

    return reply.incidents;
  } catch (error) {
    notes.push(`the incident reasons did not arrive: ${describeThrown({ cause: error }).slice(0, 160)}`);

    return undefined;
  }
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

/** Node's HTTPS client has no elapsed timeout; absent `timeoutMs` teardown is unbounded.
 *  Abandoning is safe: the purge is idempotent and `teardownLiveArms` posts a second pass. */
interface BoundedPost {
  readonly fixture: Fixture;
  readonly path: string;
  readonly body: DriverRequest;
  readonly requester: HttpsRequester;
  readonly timeoutMs?: number;
}

async function postBoundedHttps(
  { fixture, path, body, requester, timeoutMs }: BoundedPost,
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




const STARTUP_POLL_INTERVAL_MS = 250;

/** Observer ceiling: it ends measurement, not the product's restore or container-start budget. */
export const CELL_STARTUP_MS = 55_000;



export interface StartupRecord {
  readonly operation: string;
  readonly path: string;
  completion: StartupCompletion | null;
  failure: ContinuityObservation | null;
  error: string | null;
  observations: StartupObservation[];
}



async function observeStartupReply<Reply extends KickReply | StateReply | ExecReply>(
  observations: StartupObservation[] | undefined,
  event: StartupObservation['event'],
  run: () => Promise<Reply>,
): Promise<Reply> {
  if (observations === undefined) return await run();
  const row: StartupObservation = { event, startedAt: Date.now(), finishedAt: null, reply: null, error: null };
  observations.push(row);

  try {
    const reply = await run();
    row.reply = reply;

    return reply;
  } catch (error) {
    row.error = describeThrown({ cause: error });
    throw error;
  } finally {
    row.finishedAt = Date.now();
  }
}

/** `true` has no effect and moves no bytes a checkpoint prices, so a repeated drive is safe;
 *  the drive works through the request: `/exec` is an ordinary operation awaiting `ensureReady()`. */
const READINESS_DRIVE_COMMAND = 'true';

/** A refusal is the boundary's own answer and ends the startup; an unanswered drive proves
 *  nothing: the drive is a kick, not a measurement, and `/state` stays the oracle. */
type ReadinessDrive =
  | { readonly kind: 'drove' }
  | { readonly kind: 'unanswered'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string };

/** `/state` only re-arms the startup row; one no-op exec drives `ensureReady()` so attach runs.
 *  A lost reply or an "ask again"/retry-underway answer is mid-startup, not a refusal. */
interface ReadinessRequest {
  readonly fixture: Fixture;
  readonly box: string;
  readonly operation: string;
  readonly timeoutMs?: number;
  readonly observations?: StartupObservation[];
}

async function driveReadiness(
  { fixture, box, operation, timeoutMs, observations }: ReadinessRequest,
): Promise<ReadinessDrive> {
  let driven: ExecReply;

  try {
    driven = await retryTransient(`${operation} readiness drive`, async () =>
      await observeStartupReply(observations, 'drive', async () => await execInBox(fixture, box, READINESS_DRIVE_COMMAND, timeoutMs)),
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

/** The drive runs beside the poll, never awaited: the answer is the next `/state` reading, so
 *  awaiting a drive would blind the poll for its whole transport budget. `stopped` is not a wait. */
export interface AttachPoll {
  readonly fixture: Fixture;
  readonly box: string;
  readonly operation: string;
  readonly allowedKinds: readonly string[];
  readonly bounds?: StartupBounds;
}

export async function pollForAttach(
  { fixture, box, operation, allowedKinds, bounds = {} }: AttachPoll,
): Promise<StartupPoll> {
  const limits = { deadlineMs: CELL_STARTUP_MS, ...bounds };
  const deadline = Date.now() + (limits.deadlineMs ?? CELL_STARTUP_MS);
  let redrives = 0;
  let lastReading = 'no /state reply has been decoded yet';
  /** The one drive in flight, HELD rather than floated: the loop that started
   *  it owns it, and its rejection can never reach the process unhandled. */
  let driving: { readonly since: number; readonly settled: Promise<void> } | null = null;
  let refusal: string | null = null;

  for (;;) {
    // A drive's refusal is collected here, not thrown from the drive, so it still passes
    // through this loop's own accounting.
    if (refusal !== null) {
      const refused: string = refusal;

      throw new Error(`${operation} refused: ${refused}`);
    }

    if (deadline !== null && Date.now() > deadline) {
      throw new Error(
        `${operation} did not attach within its ${String(limits.deadlineMs)} ms ceiling `
        + `(last reading: ${lastReading}`
        + `${driving === null ? '' : `; a readiness drive posted ${String(Date.now() - driving.since)} ms ago has not answered`})`,
      );
    }

    let reply: StateReply;

    try {
      reply = await observeStartupReply(limits.observations, 'state', async () => await boxState(fixture, box));
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
      // Bounded by the caller's remaining window so a drive cannot outlive its verdict.
      // Aborting the drive does not abort the container-side attach; the next `/state` sees it.
      const remaining = deadline === null ? undefined : Math.max(1_000, deadline - Date.now());
      const since = Date.now();
      driving = {
        since,
        settled: (async (): Promise<void> => {
          try {
            const drive = await driveReadiness({
              fixture,
              box,
              operation,
              timeoutMs: remaining,
              observations: limits.observations,
            });

            if (drive.kind === 'refused') refusal = drive.detail;
            else if (drive.kind === 'unanswered') {
              log(`${operation}: the readiness drive did not answer (${drive.detail}); the state poll keeps the verdict`);
            }
          } catch (error) {
            // Reachable only if `driveReadiness` throws instead of answering; an unawaited drive
            // must never end a run that already has its verdict.
            log(`${operation}: the readiness drive threw instead of answering: ${describeThrown({ cause: error })}`);
          } finally {
            driving = null;
          }
        })(),
      };
    } else if (reply.error !== undefined) {
      log(`${operation}: state poll retrying: ${reply.error}`);
    }

    // One cadence for every unsettled reading, a drive included: the next poll accepts the attach,
    // and only one drive is in flight, so nothing spins or stacks requests on a starting box.
    await delay(STARTUP_POLL_INTERVAL_MS);
  }
}

/** How long a startup may take before the caller reads the wait itself as the
 *  failure. Absent means unbounded — see `pollForAttach`. */
export interface StartupBounds {
  readonly deadlineMs?: number;
  readonly observations?: StartupObservation[];
}

/** Waits for THIS generation's attach, timed end to end from the kick. `/create` and `/wake`
 *  differ only in what the container is allowed to restore. */
export interface StartupRequest {
  readonly fixture: Fixture;
  readonly box: string;
  readonly path: '/create' | '/wake';
  readonly operation: string;
  readonly allowedKinds: readonly string[];
  readonly bounds?: StartupBounds;
}

export async function startupOperation(
  { fixture, box, path, operation, allowedKinds, bounds = {} }: StartupRequest,
): Promise<StartupCompletion> {
  const started = Date.now();
  const limits = { deadlineMs: CELL_STARTUP_MS, ...bounds };
  // The caller's `bounds` deadline also bounds the capacity-retry kick loop, which is otherwise
  // unbounded; on expiry it reports the last kick's own error.
  const deadline = limits.deadlineMs === undefined ? null : started + limits.deadlineMs;

  for (let attempt = 1; ; attempt += 1) {
    let transient: string;

    try {
      const kicked = await observeStartupReply(limits.observations, 'kick', async () =>
        await call({ fixture, method: 'POST', path: `${path}?box=${box}`, schema: KickReplySchema, body: {} }));

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
        `${operation} was still being admitted at its ${String(limits.deadlineMs)} ms ceiling `
        + `after ${String(attempt)} kick(s) (last kick: ${transient})`,
      );
    }

    await delay(15_000);
  }

  const attached = await pollForAttach({
    fixture,
    box,
    operation,
    allowedKinds,
    bounds: { ...limits, deadlineMs: Math.max(0, (deadline ?? started + CELL_STARTUP_MS) - Date.now()) },
  });

  return { ...attached, ms: Date.now() - started, startedAt: started };
}

/** One spelling of a checkpoint's outcome for ladder rows, tree-size rows and decisive notes,
 *  so every reader gets the box's reason beside the kind. */
export function checkpointOutcomeWords(cp: CheckpointReply): string {
  const kind = cp.outcome?.kind ?? 'unknown';
  const reason = cp.outcome?.reason;

  return reason === undefined ? kind : `${kind} (${reason})`;
}

export interface StopReply { ok?: boolean; ms?: number; error?: string }



export async function destroyBox(fixture: Fixture, box: string): Promise<DestroyReply> {
  const reply = await call({ fixture, method: 'POST', path: `/destroy?box=${box}`, schema: DestroyReplySchema });

  if (reply.ok !== true || reply.destroyed !== true) {
    throw new Error(`container destruction was not confirmed: ${JSON.stringify(reply)}`);
  }

  return reply;
}

// `/checkpoint` and `/stop` arm a durable one-shot polled here: a blocking POST hits a ceiling
// no timeout raises. One caller-made `op` per operation, reused on retry, keeps arming idempotent.

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
export interface OperationPollReply extends CheckpointReply {
  state?: string;
  token?: string;
}

const OperationPollReplySchema: v.GenericSchema<OperationPollReply> = v.looseObject({
  ...CheckpointReplySchema.entries,
  state: v.optional(v.string()),
  token: v.optional(v.string()),
});

/** Deadline reuses `PROCESS_DEADLINE_MS`: both bound remote-service work; a second number drifts.
 *  Cadence backs off: ladder ticks settle fast, barriers take minutes; polls never enter timings. */
const OPERATION_DEADLINE_MS = PROCESS_DEADLINE_MS;

const OPERATION_FIRST_POLL_MS = 250;

const OPERATION_POLL_CEILING_MS = 5_000;

const OPERATION_POLL_GROWTH = 1.5;

/** The POST is re-asked on transport loss with the SAME `op`: the arm is idempotent, so a lost
 *  reply is safe to retry, and every later request is a poll that cannot publish twice. */
interface ArmedOperation {
  readonly fixture: Fixture;
  readonly box: string;
  readonly route: '/checkpoint' | '/stop';
  readonly body: DriverRequest & { readonly op: string };
  readonly bounds?: { readonly pollMs?: number; readonly deadlineMs?: number };
}

async function awaitArmedOperation(
  { fixture, box, route, body, bounds = {} }: ArmedOperation,
): Promise<OperationPollReply> {
  // An explicit `pollMs` fixes the cadence (first poll and ceiling alike), so a caller
  // asking for a short cadence gets it rather than a backoff it must wait out.
  const firstPollMs = bounds.pollMs ?? OPERATION_FIRST_POLL_MS;
  const pollCeilingMs = bounds.pollMs ?? OPERATION_POLL_CEILING_MS;
  const deadline = Date.now() + (bounds.deadlineMs ?? OPERATION_DEADLINE_MS);
  let armed: OperationArmedReply | null = null;

  for (let attempt = 1; armed === null; attempt += 1) {
    try {
      armed = await call({
        fixture,
        method: 'POST',
        path: `${route}?box=${box}`,
        schema: OperationArmedReplySchema,
        body,
        timeoutMs: STATE_POLL_REQUEST_TIMEOUT_MS,
      });
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
      poll = await call({
        fixture,
        method: 'GET',
        path: `/operation?box=${box}&token=${encodeURIComponent(token)}`,
        schema: OperationPollReplySchema,
        timeoutMs: STATE_POLL_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      // A failed poll request proves nothing about the operation, which continues regardless;
      // re-ask until the deadline, as the startup poll re-asks `/state`.
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
      throw new Error(
        `${route} did not settle within the ${String(bounds.deadlineMs ?? OPERATION_DEADLINE_MS)} ms `
        + `operation deadline (token ${token} still pending)`,
      );
    }
  }
}

export interface OperationBounds {
  readonly pollMs?: number;
  readonly deadlineMs?: number;
}

/** Mint `op` inside the retried closure: a settled operation is answered from its row forever,
 *  so only a fresh `op` heals a replacement; the transport re-post keeps the attempt's `op`. */
export interface CheckpointRequest {
  readonly fixture: Fixture;
  readonly box: string;
  readonly kind: 'tick' | 'quiesce';
  readonly what: string;
  readonly bounds?: OperationBounds;
}

export async function checkpointOperation(
  { fixture, box, kind, what, bounds = {} }: CheckpointRequest,
): Promise<CheckpointReply> {
  return await retryTransient(what, async () =>
    await awaitArmedOperation({
      fixture,
      box,
      route: '/checkpoint',
      body: { kind, op: `${what}-${crypto.randomUUID()}` },
      bounds,
    }),
  );
}

/** Exported because the fault-cut cell kills the container while the token is pending,
 *  so the token must be held before any outcome exists. */
export interface ArmedCheckpoint {
  readonly op: string;
  readonly token: string;
}

/** Returns the token without waiting for the outcome. `op` is generated once, outside the retry,
 *  so a transport-loss retry re-arms the same operation instead of starting a second publication. */
export interface ArmCheckpointRequest {
  readonly fixture: Fixture;
  readonly box: string;
  readonly kind: 'tick' | 'quiesce';
  readonly what: string;
  readonly route?: '/checkpoint' | '/checkpoint-cut';
}

export async function armCheckpointOperation(
  { fixture, box, kind, what, route = '/checkpoint' }: ArmCheckpointRequest,
): Promise<ArmedCheckpoint> {
  const op = `${what}-${crypto.randomUUID()}`;

  const armed = await retryTransient(what, async () =>
    await call({
      fixture,
      method: 'POST',
      path: `${route}?box=${box}`,
      schema: OperationArmedReplySchema,
      body: { kind, op },
      timeoutMs: STATE_POLL_REQUEST_TIMEOUT_MS,
    }),
  );

  if (armed.ok !== true || armed.token === undefined || armed.token.length === 0) {
    throw new Error(`${what} did not arm: ${armed.error ?? 'the fixture answered without a token'}`);
  }

  return { op, token: armed.token };
}

/** Armed like a checkpoint: a stop's final checkpoint is the largest publication an arm takes.
 *  The `op` is minted per attempt for the reason `checkpointOperation` states. */
export async function stopOperation(
  fixture: Fixture,
  box: string,
  what: string,
  bounds: OperationBounds = {},
): Promise<StopReply> {
  const settled = await retryTransient(what, async () =>
    await awaitArmedOperation({
      fixture,
      box,
      route: '/stop',
      body: { op: `${what}-${crypto.randomUUID()}` },
      bounds,
    }),
  );

  return {
    ok: settled.state === 'done' && settled.outcome?.kind !== 'failed',
    ms: settled.ms,
    error: settled.error ?? settled.outcome?.reason,
  };
}

/** A wake proves a recycle only after stop confirms: a stop's final quiesce can fail early,
 *  and a wake against the still-running box would count its live attach as a restoration. */
function requireConfirmedStop(stopped: StopReply, failure: string): void {
  if (stopped.ok === true) return;
  throw new Error(`${failure}: ${stopped.error ?? 'stop did not confirm'}`);
}



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
  const responseText = await postBoundedHttps({
    fixture,
    path: `/teardown?box=${box}`,
    body: TEARDOWN_PURGE_PAYLOAD,
    requester,
    timeoutMs,
  });

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

/** Two idempotent purge passes per arm; a failed pass never skips a sibling or the second pass.
 *  `timeoutMs` bounds one pass, not the sweep; an abandoned pass is retried by the next. */
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

/** One tree-size measurement: a fixed 64 KiB backup plus a stop then wake at a rung's size.
 *  Kept out of `checkpoints`: `EXPECTED_LADDER_ROWS` and the completeness checks count it. */
export interface ComplexityRow {
  /** Ladder bytes written so far when this row was taken, the size axis. */
  readonly treeBytes: number;
  readonly kind: 'backup-64k' | 'restore';
  /** Wall ms, null when the operation never answered. */
  readonly ms: number | null;
  readonly outcome: string;
  /** Restores only: the attach kind the wake answered. */
  readonly attachKind?: string;
  /** Restores only: the flushed `/ops` window across the stop-to-wake, the receipt the wake
   *  reads into `wakeOps`. Null when the window never bracketed. */
  readonly wakeOps?: OpTally | null;
}

/** Cumulative ladder bytes per complexity rung, in rung order; the report reads this list,
 *  so a rung the arm never reached shows as a named gap rather than a missing line. */
export const COMPLEXITY_TREE_BYTES: readonly number[] = (() => {
  let total = 0;

  return CHANGE_SIZES_KIB.map((kib) => (total += kib * 1024));
})();

const ComplexityRowSchema: v.GenericSchema<ComplexityRow> = v.looseObject({
  treeBytes: v.number(),
  kind: v.picklist(['backup-64k', 'restore']),
  ms: v.nullable(v.number()),
  outcome: v.string(),
  attachKind: v.optional(v.string()),
  // The same receipt shape the wake reads: reusing the tally schema keeps one
  // definition of the `/ops` reply both sides trust.
  wakeOps: v.optional(v.nullable(OpTallySchema)),
});

/** The schema re-checks each row because artifacts are hand-edited files; a missing
 *  `complexity` field reads as unmeasured, and a row failing its shape is dropped. */
export function decodeComplexityRows(value: ArmResult['complexity']): ComplexityRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ComplexityRow[] = [];

  for (const entry of value) {
    const parsed = v.safeParse(ComplexityRowSchema, entry);

    if (parsed.success) rows.push(parsed.output);
  }

  return rows;
}

/** Box-side restore wall time (readiness gate hold), not driver round trip; null is absent, not 0.
 *  Row with `probeAt` and phases but no `wallMs` never settled; last phase is where it stopped. */
export interface RestoreProbeRow {
  readonly kind: 'cold-attach' | 'complexity-restore' | 'post-ladder-wake' | 'destroy-cold-restore';
  /** Served-tree bytes at the rung, or null when the size is not known
   *  (the cold attach lands on an empty tree the driver never measured). */
  readonly treeBytes: number | null;
  /** The attempt's wall ms, null when the box wrote no probe row or the
   *  attempt never settled. */
  readonly wallMs: number | null;
  /** When the attempt opened, null with an absent row. */
  readonly probeAt: number | null;
  /** 'ok', or why the row is absent or unsettled. */
  readonly outcome: string;
  /** The phases the restore reached, ms after entry. */
  readonly phases?: RestorePhaseStamps;
}

const RestoreProbeRowSchema: v.GenericSchema<RestoreProbeRow> = v.looseObject({
  kind: v.picklist(['cold-attach', 'complexity-restore', 'post-ladder-wake', 'destroy-cold-restore']),
  treeBytes: v.nullable(v.number()),
  wallMs: v.nullable(v.number()),
  probeAt: v.nullable(v.number()),
  outcome: v.string(),
  phases: v.optional(RestorePhaseStampsSchema),
});

/** Artifacts without `restoreProbes` read as unmeasured; a row failing its own shape is
 *  dropped rather than trusted. */
export function decodeRestoreProbeRows(value: ArmResult['restoreProbes']): RestoreProbeRow[] {
  if (!Array.isArray(value)) return [];
  const rows: RestoreProbeRow[] = [];

  for (const entry of value) {
    const parsed = v.safeParse(RestoreProbeRowSchema, entry);

    if (parsed.success) rows.push(parsed.output);
  }

  return rows;
}

/** One restore's priced bill: the operation count and the payload bytes the
 *  `/ops` window observed, each null while its source did not answer. */
export interface ComplexityBill {
  readonly remoteOps: number | null;
  readonly payloadBytes: number | null;
}

/** Same derivation `countedRestoreWork` applies to the final wake, so the tree-size table
 *  prices intermediate restores identically. */
export function complexityRestoreBill(
  wakeOps: OpTally | null | undefined,
): ComplexityBill {
  const calls = wakeOps?.calls;

  if (calls === undefined) return { remoteOps: null, payloadBytes: null };
  const total = Object.values(calls).reduce((sum, count) => sum + count, 0);

  if (!Number.isSafeInteger(total)) return { remoteOps: null, payloadBytes: null };
  const bytes = wakeOps?.bytes;

  if (bytes === undefined) return { remoteOps: total, payloadBytes: null };

  return { remoteOps: total, payloadBytes: bytes['payload'] ?? 0 };
}

export interface ArmResult {
  strategy: Strategy;
  box: string;
  verifyPassed: boolean;
  verifyChecks: VerifyCheck[];
  attachColdMs: number | null;
  attachColdKind: string;
  attachColdBootId: string | null;
  attachWarmMs: number | null;
  attachWarmKind: string;
  /** Generation the wake restored and the immediate second attach observed.
   * Equal, non-empty values prove the warm probe did not hide a replacement. */
  wakeBootId: string | null;
  attachWarmBootId: string | null;
  stopMs: number | null;
  wakeMs: number | null;
  wakeKind: string;
  /** The wake attach's detail verbatim, never re-derived: the counted-restore cell parses it,
   *  and an unreadable detail is an uncounted restore, not a zero. Empty when the wake never attached. */
  wakeDetail?: string;
  /** Flushed `/ops` window across the stop-to-wake restore only: the restore's whole R2 bill.
   *  Null when the window was not bracketed or its reads disagreed (a reset raced it). */
  wakeOps?: OpTally | null;
  /** Post-wake `/proc/mounts` lines at this arm's own mount points, kept line by line so the
   *  count carries its method. Empty when the wake never attached. */
  wakeMountLines?: string[];
  /** Served-tree entries counted with `find` after the wake window closes; the chain
   *  materializes nothing, so this is its `cpuSteps`. Null when the count did not answer. */
  wakeServedEntries?: number | null;
  checkpoints: CheckpointRow[];
  /** Tree-size complexity rows: one fixed 64 KiB backup plus one restore per ladder rung.
   *  Optional so older artifacts still read; absent reads as unmeasured, never as zero. */
  complexity?: ComplexityRow[];
  /** In-gate restore wall times from GET /restore-probe after each wake settles, with served
   *  bytes. Optional so older artifacts still read; absent means unmeasured, never zero. */
  restoreProbes?: RestoreProbeRow[];
  workloadStates?: ContinuityObservation[];
  startups?: StartupRecord[];
  phases: ProbeRun[];
  decisiveTicks: TickRecord[];
  decisiveRequested?: boolean;
  decisiveSegments?: DecisiveSegmentObservation[];
  c3?: LiveC3Observation;
  /** Ladder quiesces rebase the chain (full-tree archive) before the decisive window; recorded
   *  so a reader can check no rebase inflates the decisive tick sum. */
  quiescesBeforeDecisive: number;
  generationBeforeLadder: ChainGeneration | null;
  generationAfterLadder: ChainGeneration | null;
  treeBytes: Record<string, number>;
  ops: OpTally | null;
  teardown: TeardownReply | null;
  /** G2's whole evidence: `observed` false means the cell could not run or the predicted
   *  defect vanished; either refuses the run instead of passing. */
  witnessChecks: WitnessCheck[];
  witnessFacts?: ControlWitnessFacts;
  witnessProfile?: WitnessProfile;
  /** Null when the fault-cut cell never ran (arm died first or never attached its wake);
   *  the reason is in `notes`. */
  cut?: FaultCutObservation | null;
  /** Null when the G4 security cells never ran: the cell threw, or the fixture predates /security.
   *  The run-level security block is built from these, one per requested arm. */
  security?: SecurityCellsObservation | null;
  /** Failures the box had filed when the ladder published, oldest first; absent when the read missed.
   *  The `/state` totals say how many; only these rows say what. */
  publishIncidents?: IncidentReasonRow[];
  /** Every failure the box had filed after the wake, oldest first; kept apart from the
   *  publish-time rows so each incident is quoted beside the dump whose window filed it. */
  wakeIncidents?: IncidentReasonRow[];
  notes: string[];
}

async function installHarness(fixture: Fixture, box: string): Promise<void> {
  await execInBox(fixture, box, `mkdir -p ${HARNESS}`);

  for (const file of PROBE_FILES) {
    await writeFileInBox(
      fixture, box, `${HARNESS}/${file}`,
      readFileSync(join(REPO_ROOT, 'scripts/fixtures/r2-bench', file), 'utf8'),
    );
  }

  await installWitnessHarness(fixture, box, HARNESS);
}

async function installWitnessHarness(fixture: Fixture, box: string, directory: string): Promise<void> {
  const made = await execInBox(fixture, box, `mkdir -p '${directory}'`);

  if (made.ok !== true || made.exitCode !== 0) throw new Error(`the witness directory was not created: ${made.error ?? made.stderr ?? 'no result'}`);

  for (const file of ['witness-files.ts', 'seeded.ts']) {
    await writeFileInBox(fixture, box, `${directory}/${file}`, readFileSync(join(BENCH_DIR, file), 'utf8'));
  }
}

/** Minute-scale phases run backgrounded with a polled sentinel: blocking exec has a ceiling
 *  that no timeout option raises. */
interface PhaseRun {
  readonly fixture: Fixture;
  readonly box: string;
  readonly root: string;
  readonly phase: string;
  readonly seed: number;
  readonly budgetMs: number;
}

async function runPhase({ fixture, box, root, phase, seed, budgetMs }: PhaseRun): Promise<ProbeRun> {
  const base = `bun ${HARNESS}/probe.ts --root ${root} --phase ${phase} --seed ${seed} --budget-ms ${budgetMs}`;

  if (!PROCESS_PHASES.has(phase)) {
    // The platform can recycle the container between two RPCs and nothing local survives (P1),
    // so a missing harness (`cd: no such file or directory`) is a container event: reinstall once.
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
  // The harness can vanish when the container recycles; check before spawning, since a
  // detached process cannot report that its own interpreter was missing.
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

/** Waits out the minimum checkpoint interval instead of measuring the rate limiter.
 *  Caller keeps the maximum `treeBytes`: later repetitions re-run segments over the prior tree. */
interface DecisiveSegment {
  readonly fixture: Fixture;
  readonly box: string;
  readonly arm: string;
  readonly spec: (typeof DECISIVE_WORKLOADS)[number];
  readonly seed: number;
  readonly repetition: number;
  readonly segment: number;
  readonly observation: DecisiveSegmentObservation;
  readonly notes: string[];
}

async function executeDecisiveSegment(
  { fixture, box, arm, spec, seed, repetition, segment, observation, notes }: DecisiveSegment,
): Promise<{ tick: TickRecord | null; treeBytes: number | null }> {
  const root = `/workspace/decisive-${spec.id}`;

  const command = `bun ${HARNESS}/decisive.ts --root ${root} --workload ${spec.workload} `
    + `--seed ${seed} --segment ${segment} ${spec.args}`;

  const reply = await execInBox(fixture, box, command);
  observation.command = reply;
  const start = (reply.stdout ?? '').indexOf('{');

  if (reply.ok !== true || reply.exitCode !== 0 || start === -1) {
    observation.error = `${spec.id} segment ${segment}: unobserved execution: ${reply.error ?? reply.stderr ?? 'no successful JSON reply'}`;
    notes.push(observation.error);

    return { tick: null, treeBytes: null };
  }

  const run = parseDecisiveRun((reply.stdout ?? '').slice(start), `${arm}/${spec.id}#${segment}`);

  if (run.error !== undefined) {
    observation.error = `${spec.id} segment ${segment}: ${run.error}`;
    notes.push(observation.error);

    return { tick: null, treeBytes: null };
  }

  const segmentName = run.segments?.[0]?.name;
  observation.segmentName = segmentName ?? null;

  if (segmentName === undefined) {
    observation.error = 'the workload returned no segment';

    return { tick: null, treeBytes: run.treeBytes ?? null };
  }

  // Wait out the minimum checkpoint interval: ticking immediately is skipped by the guard,
  // so the driver would measure the rate limiter instead of checkpoint work.
  await delay(MIN_CHECKPOINT_INTERVAL_MS);

  await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  const before = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
  observation.accounting.before = before;
  const cp = await checkpointOperation({ fixture, box, kind: 'tick', what: `${spec.id} tick ${segmentName}` });
  observation.checkpoint = cp;

  // An uncommitted tick yields no row: its wall time would skew the decision's numerator,
  // and G9 counts it as one repetition fewer. The note carries the box's own reason.
  if (cp.ok !== true || cp.outcome?.kind !== 'committed') {
    observation.error = cp.error ?? checkpointOutcomeWords(cp);
    notes.push(
      `${spec.id} tick ${segmentName} did not commit `
      + `(${cp.error ?? checkpointOutcomeWords(cp)}); it prices nothing`,
    );

    return { tick: null, treeBytes: run.treeBytes ?? null };
  }

  if (cp.ms === undefined || !Number.isFinite(cp.ms) || cp.ms < 0) {
    observation.error = 'the committed checkpoint has no valid wall time';
    notes.push(`${spec.id} tick ${segmentName} committed without a measured duration; its wall time is unpriced`);

    return { tick: null, treeBytes: run.treeBytes ?? null };
  }

  await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  const after = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
  observation.accounting.after = after;
  const bill = pricedOpWindow(before, after);

  if (bill === null || bill.classA === undefined || bill.classB === undefined || bill.classFree === undefined) {
    observation.error = 'the checkpoint accounting window was unobserved or inconsistent';
    notes.push(observation.error);

    return { tick: null, treeBytes: run.treeBytes ?? null };
  }

  // `bytes` is the cumulative durable total; `movedBytes` is what this tick uploaded.
  // The report keeps held and moved apart.
  const bytes = cp.outcome?.bytes;
  const moved = cp.outcome?.movedBytes;

  const tick: TickRecord = {
    arm,
    workload: spec.id,
    repetition,
    segment: segmentName,
    wallMs: cp.ms,
    classA: bill.classA,
    classB: bill.classB,
    classFree: bill.classFree,
    // NOT `?? 0`: a failed tick may have landed blobs before throwing, and
    // answers `null`, which is a different fact from a skip's honest zero.
    bytesPut: moved ?? null,
    heldBytes: bytes ?? null,
    movedReported: moved !== undefined,
    unitsMoved: moved ?? null,
    unitLabel: 'delta bytes',
    outcome: cp.error !== undefined ? `error: ${cp.error}` : checkpointOutcomeWords(cp),
  };

  observation.priced = true;

  return { tick, treeBytes: run.treeBytes ?? null };
}

/** Charges each tick with an op diff; flush before closing the window, flush after so nothing
 *  the tick issued stays batched in an isolate. Unreported `unitsMoved` is null, not 0. */
export interface DecisiveCell {
  readonly fixture: Fixture;
  readonly box: string;
  readonly arm: string;
  readonly spec: (typeof DECISIVE_WORKLOADS)[number];
  readonly seed: number;
  /** Which repetition of this cell is running, counting from one. Stamped on
   *  every tick, so the artifact keeps the per-repetition rows apart. */
  readonly repetition: number;
  readonly record?: { segments: DecisiveSegmentObservation[]; settled: () => void };
}

export async function runDecisive(
  { fixture, box, arm, spec, seed, repetition, record }: DecisiveCell,
): Promise<{ ticks: TickRecord[]; treeBytes: number; notes: string[]; segments: DecisiveSegmentObservation[] }> {
  const notes: string[] = [];
  const ticks: TickRecord[] = [];
  const segments: DecisiveSegmentObservation[] = [];
  const root = `/workspace/decisive-${spec.id}`;

  // The excludes arm differs ONLY by the policy file, so the pair isolates the
  // policy rather than the workload.
  if (spec.excludes) {
    await call({
      fixture,
      method: 'POST',
      path: `/write?box=${box}`,
      schema: AckReplySchema,
      body: { path: `${root}/.devboxignore`, content: 'node_modules/**/dist/**\n**/*.map\n.git/objects/**\n', },
    });
  }

  // Segments interleave with checkpoints so later ticks measure incremental cost; checkpoints
  // taken after the whole workload collapse into one full-tree archive plus unchanged skips.
  let treeBytes = -1;

  for (let segment = 0; segment <= SEGMENTS_PER_WORKLOAD; segment++) {
    const observation: DecisiveSegmentObservation = {
      workload: spec.id, repetition, segment, before: null, after: null,
      command: null, checkpoint: null, accounting: { before: null, after: null },
      segmentName: null, priced: false, error: null,
    };

    segments.push(observation);
    record?.segments.push(observation);

    try {
      observation.before = await observeContinuity(fixture, box, `${spec.id}/${repetition}/${segment}: before`);

      const run = await executeDecisiveSegment({
        fixture,
        box,
        arm,
        spec,
        seed,
        repetition,
        segment,
        observation,
        notes,
      });

      if (run.treeBytes !== null && run.treeBytes > treeBytes) treeBytes = run.treeBytes;

      if (run.tick !== null) ticks.push(run.tick);
    } catch (error) {
      observation.error = describeThrown({ cause: error });
      throw error;
    } finally {
      observation.after = await observeContinuity(fixture, box, `${spec.id}/${repetition}/${segment}: after`);
      record?.settled();
    }
  }

  return { ticks, treeBytes, notes, segments };
}

// Witness cells run after the arm's `/ops` tally: their writes and checkpoints would inflate
// the measured operation count. G2 refuses both unobserved and unpredicted witnesses.

export interface WitnessCheck {
  readonly name: string;
  readonly observed: boolean;
  readonly detail: string;
}

/** The normal run requires composed restore and immutable delta publication; full-upper
 *  collapse is the layered profile, fixed before the run, never chosen from observations. */
const PREREGISTERED_WITNESSES = {
  'snapshot-chain': ['mutable-delta', 'chunked-absorption'],
} as const satisfies Record<Strategy, readonly string[]>;

export type WitnessProfile = 'chunked' | 'layered';

const LAYERED_WITNESSES = ['mutable-delta', 'delta-layer-collapse'] as const;

export interface ChunkedAbsorptionFacts {
  readonly markerPath: string;
  readonly markerDigest: string;
  readonly manifest: DeltaManifest | null;
  readonly manifestRead: ExecReply | null;
  readonly markerInMerged: FileObservation | null;
  readonly markerInUpper: FileObservation | null;
  readonly sidecarMounted: boolean | null;
  readonly blockMounted: boolean | null;
  readonly blockReads: BlockAttachMetrics | null;
  readonly mounts: ExecReply | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly afterNamesDelta: boolean | null;
  readonly nextCheckpoint: CheckpointReply | null;
  readonly wake: StartupCompletion | null;
  readonly seedCheckpoint?: CheckpointReply;
  readonly beforeState?: StateReply;
  readonly afterState?: StateReply;
  readonly deltaHead?: HeadReply;
  readonly destroyReceipt?: DestroyReply;
  readonly startupObservations?: readonly StartupObservation[];
  readonly errors?: readonly string[];
}

type ChunkedAbsorptionSample = { -readonly [Key in keyof ChunkedAbsorptionFacts]: ChunkedAbsorptionFacts[Key] };

/** Raw facts the cells observed, one group per witness; nothing here is a verdict.
 *  An absent group means its cell could not run: the witness is unobserved and G2 refuses. */
export interface ControlWitnessFacts {
  readonly chunkedAbsorption?: ChunkedAbsorptionFacts;
  readonly deltaLayerCollapse?: {
    readonly chainId: string;
    /** Bytes the store holds for that generation's delta. A wake with no delta
     *  proves nothing about how a delta is served. */
    readonly deltaBytes: number;
    /** `base+delta layered` is the served shape; `base+delta already in this upper` means the
     *  container kept the upper its own publication archived, so the wake never served the delta. */
    readonly attachDetail: string;
    /** Is the delta mounted as a lower layer under the overlay — the fact
     *  `deltaLayerServed` reads and the collapse below keys off? */
    readonly deltaLayerMounted: boolean;
    /** The marker this cell committed INTO the delta, read back through the
     *  merged work directory after the wake. */
    readonly markerInMergedView: boolean;
    /** The same marker looked for in the FRESH upper; a serve leaves it in the delta layer,
     *  so finding it here means the delta was copied up rather than served. */
    readonly markerInUpper: boolean;
    /** The generation the record names after the next checkpoint. A collapse
     *  archives the merged view as a fresh base under a NEW id. */
    readonly collapsedChainId: string;
    /** Whether that record still names a delta. A collapse records none. */
    readonly collapsedNamesDelta: boolean;
  };
  readonly mutableDelta?: {
    readonly key: string;
    readonly previousKey: string;
    readonly etagBefore: string;
    readonly etagAfter: string;
    readonly bytesBefore: number;
    readonly bytesAfter: number;
    readonly retainedHead: HeadReply;
    readonly beforeState: StateReply;
    readonly afterState: StateReply;
    readonly checkpoint: CheckpointReply;
  };
}

interface ChunkedMarkerObservation {
  readonly manifest: boolean;
  readonly merged: boolean;
  readonly upperAbsent: boolean;
}

interface ChunkedRestoreObservation {
  readonly cold: boolean;
  readonly zeroPayload: boolean;
  readonly mountedAndAdvanced: boolean;
}

/** Marker half of the chunked-absorption witness: the manifest names the file, the merged
 *  view serves it, and its absence from the fresh upper proves it was not copied. */
function chunkedMarkerObserved(cell: ChunkedAbsorptionFacts): ChunkedMarkerObservation {
  const manifest = cell.manifestRead?.ok === true && cell.manifestRead.exitCode === 0
    && cell.manifest !== null && v.safeParse(DeltaManifestSchema, cell.manifest).success
    && cell.manifest.files.some((file) => file.p === cell.markerPath);

  const merged = cell.markerInMerged?.path === `${DEVBOX_WORK_DIR}/${cell.markerPath}`
    && witnessMatches(cell.markerInMerged, cell.markerDigest) === true;

  const upperAbsent = cell.markerInUpper?.path === `${CHAIN_UPPER_DIR}/${cell.markerPath}`
    && cell.markerInUpper.error === null && cell.markerInUpper.reply?.ok === true
    && cell.markerInUpper.reply.exitCode === 0 && cell.markerInUpper.evidence?.kind === 'missing';

  return { manifest, merged, upperAbsent };
}

/** A new boot serves the marker through a mounted chunked lower with zero payload reads;
 *  the next publication keeps the record on the same base with a delta still named. */
function chunkedRestoreObserved(cell: ChunkedAbsorptionFacts): ChunkedRestoreObservation {
  const boot = cell.wake?.state.state?.bootId;

  const cold = boot !== undefined && cell.beforeState?.state?.bootId !== undefined
    && boot !== cell.beforeState.state.bootId && cell.wake?.attach.kind === 'attached'
    && cell.wake.state.state?.chain?.deltaFormat === 'chunked';

  const zeroPayload = cell.blockReads !== null && cell.blockReads.payloadBytes === 0
    && cell.blockReads.indexPages === 0 && cell.blockReads.readRequests === 0;

  const mountedAndAdvanced = cell.sidecarMounted === true && cell.blockMounted === true
    && cell.mounts?.ok === true && cell.mounts.exitCode === 0
    && cell.before !== null && cell.after === cell.before && cell.afterNamesDelta === true
    && cell.nextCheckpoint?.ok === true && cell.nextCheckpoint.outcome?.kind === 'committed';

  return { cold, zeroPayload, mountedAndAdvanced };
}

/** A committed marker reads through the composed lower on a new boot, stays
 * out of the fresh upper, and attaches without payload or index-page reads. */
function chunkedAbsorptionWitness(name: string, cell: ChunkedAbsorptionFacts | undefined): WitnessCheck {
  if (cell === undefined) return absentCell(name);

  const marker = chunkedMarkerObserved(cell);
  const restore = chunkedRestoreObserved(cell);

  const observed = marker.manifest && marker.merged && marker.upperAbsent
    && restore.cold && restore.zeroPayload && restore.mountedAndAdvanced;

  return {
    name, observed,
    detail: `chunked manifest ${marker.manifest ? 'confirmed' : 'unobserved'}; `
      + `marker merged=${marker.merged} upper absent=${marker.upperAbsent}; `
      + `cold=${restore.cold} sidecar mounted=${String(cell.sidecarMounted)} block mounted=${String(cell.blockMounted)} `
      + `zero attach payload=${restore.zeroPayload}; `
      + `next checkpoint=${cell.nextCheckpoint?.outcome?.kind ?? 'unobserved'}; `
      + `generation ${cell.before ?? 'unobserved'} to ${cell.after ?? 'unobserved'}`,
  };
}

function deltaLayerCollapseWitness(
  name: string,
  cell: NonNullable<ControlWitnessFacts['deltaLayerCollapse']> | undefined,
): WitnessCheck {
  if (cell === undefined) return absentCell(name);

  // A served delta reaches the merged view through its own layer: the marker is readable
  // at the work directory and absent from the emptied upper; a copy puts it in the upper.
  const served = cell.deltaBytes > 0
    && cell.deltaLayerMounted
    && cell.markerInMergedView
    && !cell.markerInUpper;

  // A served delta forces the next checkpoint to collapse: fresh generation id, no delta named.
  // Same id or a still-named delta is an ordinary append, which a copied delta produces.
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

/** Record-advance half of the mutable-delta witness: a new immutable delta under a fresh key,
 *  CAS-published on the same base (D7); the retained-key half is checked by the caller. */
function mutableDeltaAdvanced(cell: NonNullable<ControlWitnessFacts['mutableDelta']>): boolean {
  const before = cell.beforeState.state?.chain;
  const after = cell.afterState.state?.chain;

  return before?.rev !== undefined && after?.rev === before.rev + 1
    && before.base?.id !== undefined && after.base?.id === before.base.id
    && before.delta?.id !== undefined && after.delta?.id !== undefined
    && before.delta.id !== after.delta.id
    && cell.previousKey === `${cell.beforeState.storePrefix ?? ''}backups/${before.delta.id}/delta.sqsh`
    && cell.key === `${cell.afterState.storePrefix ?? ''}backups/${after.delta.id}/delta.sqsh`
    && cell.key !== cell.previousKey && cell.etagAfter.length > 0 && cell.bytesAfter > 0
    && cell.checkpoint.ok === true && cell.checkpoint.outcome?.kind === 'committed';
}

/** Despite its name, the witness requires two immutable objects and a CAS-published
 *  record advance; the retained mounted key must not change. */
function mutableDeltaWitness(
  name: string,
  cell: NonNullable<ControlWitnessFacts['mutableDelta']> | undefined,
): WitnessCheck {
  if (cell === undefined) return absentCell(name);
  const before = cell.beforeState.state?.chain;
  const after = cell.afterState.state?.chain;

  const preserved = cell.etagBefore.length > 0 && cell.retainedHead.ok === true
    && cell.retainedHead.exists === true && cell.retainedHead.etag === cell.etagBefore
    && cell.retainedHead.size === cell.bytesBefore && cell.bytesBefore > 0;


  const advanced = mutableDeltaAdvanced(cell);

  return {
    name,
    observed: preserved && advanced,
    detail: `${cell.previousKey}: ${cell.bytesBefore}B etag ${cell.etagBefore || '(none)'} `
      + `retained unchanged=${preserved}; new key ${cell.key}: ${cell.bytesAfter}B etag ${cell.etagAfter || '(none)'}; `
      + `record rev ${before?.rev ?? 'unobserved'} to ${after?.rev ?? 'unobserved'}, advanced=${advanced}`,
  };
}

/** Names and order come from the preregistered list, so a witness is never answered by a
 *  cell that was not preregistered for this arm. */
export function controlWitnessChecks(
  strategy: Strategy,
  facts: ControlWitnessFacts,
  profile: WitnessProfile = 'chunked',
): WitnessCheck[] {
  const names = profile === 'chunked' ? PREREGISTERED_WITNESSES[strategy] : LAYERED_WITNESSES;

  return names.map((name): WitnessCheck => {
    switch (name) {
      case 'chunked-absorption':
        return chunkedAbsorptionWitness(name, facts.chunkedAbsorption);

      case 'delta-layer-collapse':
        return deltaLayerCollapseWitness(name, facts.deltaLayerCollapse);

      case 'mutable-delta':
        return mutableDeltaWitness(name, facts.mutableDelta);

      default:
        return absentCell(name);
    }
  });
}

/** A cell that produced no facts proves nothing, so its witness is unobserved and G2 refuses. */
function absentCell(name: string): WitnessCheck {
  return {
    name,
    observed: false,
    detail: 'this witness cell produced no observation, so nothing was witnessed',
  };
}

/** Admission only decides whether the run continues; verify checks and `armCompletedTheCell`
 *  judge proof. Restates `ATTACH_OUTCOME_KINDS`; `bench-devbox-decision.test.ts` pins it. */
const PRODUCT_ATTACH_KINDS = ['empty', 'attached', 'already-attached'] as const;

/** The three startup steps an arm takes, named so a step cannot be misspelled
 *  into an empty exclusion set. */
type StartupStep = 'cold attach' | 'wake' | 'warm attach';

const ATTACH_KINDS_EXCLUDED = {
  'cold attach': {},
  wake: {
    empty: 'a wake that finds no head has nothing to measure, and continuing would '
      + 'spend a full decisive workload producing numbers that describe the container\'s '
      + 'own blank disk — which G1 refuses anyway',
  },
  'warm attach': {
    empty: 'an attached box whose head has vanished is a control-plane fault, not a '
      + 'slower attach, and every later cell would measure a blank disk',
  },
} satisfies Record<StartupStep, Readonly<Record<string, string>>>;

/** Exported so G6 derives its kind clauses from this instead of restating them;
 *  the suite proves the derivation per step per kind. */
export function admittedAttachKinds(step: StartupStep): readonly string[] {
  const excluded: Readonly<Record<string, string>> = ATTACH_KINDS_EXCLUDED[step];

  return PRODUCT_ATTACH_KINDS.filter((kind) => excluded[kind] === undefined);
}

/** Restates the constants the strategies publish (`storage.ts`, `snapshot-chain.ts`): this
 *  driver reads a deployed container over HTTP and imports nothing from the box it measures. */
const DEVBOX_WORK_DIR = '/workspace';

const CHAIN_UPPER_DIR = '/var/tmp/devbox/upper';

/** Layer paths the lifecycle proof reads; `bench-devbox-decision.test.ts` checks each against
 *  the strategy's exported constant, which is what makes restating them safe. */
const CHAIN_LOWER_BASE_DIR = '/var/tmp/devbox/lower-base';

/** One mount point per served generation, `${lowerDeltaRoot}/<generation>`; its presence in
 *  `/proc/mounts` is the fact `deltaLayerServed` reads to decide the collapse. */
const CHAIN_DELTA_LAYER_ROOT = '/var/tmp/devbox/lower-delta';

/** Restates `CHAIN_STORE_MOUNT` in `packages/devbox/src/snapshot-chain.ts`; the wake-count cell
 *  matches restore mount lines against it, and `bench-devbox-decision.test.ts` checks the copy. */
const CHAIN_STORE_MOUNT_DIR = '/backups';


function requiredChainId(id: string | undefined, what: string): string {
  if (id === undefined || !/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error(`the committed ${what} id is missing or invalid`);
  }

  return id;
}

/** A cell's own setup command either ran to exit 0 or the cell ends with the
 *  box's reason: a refused setup judged as if it ran is a witness of nothing. */
function ranInBox(reply: ExecReply, what: string): void {
  if (reply.ok === true && reply.exitCode === 0) return;

  throw new Error(`${what}: ${reply.error ?? reply.stderr ?? `exit ${String(reply.exitCode ?? -1)}`}`);
}

/** Publishes a marker delta, destroys the container without another quiesce, observes the wake.
 *  One sample accumulates every observation so the witness judges facts, not a re-run arm. */
async function observeChunkedAbsorption(
  fixture: Fixture,
  box: string,
  facts: { -readonly [Key in keyof ControlWitnessFacts]: ControlWitnessFacts[Key] },
): Promise<void> {
  const marker = `chunked-absorption-${crypto.randomUUID()}`;
  const markerFile = 'witness-chunked-absorption.txt';
  const errors: string[] = [];

  const sample: ChunkedAbsorptionSample = {
    markerPath: markerFile, markerDigest: createHash('sha256').update(marker).digest('hex'),
    manifest: null, manifestRead: null, markerInMerged: null, markerInUpper: null,
    sidecarMounted: null, blockMounted: null, blockReads: null, mounts: null, before: null, after: null, afterNamesDelta: null,
    nextCheckpoint: null, wake: null, errors,
  };

  facts.chunkedAbsorption = sample;
  const harness = basename(HARNESS);

  // A setup exec that did not run refuses the cell: a just-quiesced box can answer "ask again",
  // and judging the marker afterwards would test a marker nobody wrote.
  ranInBox(await execInBox(
    fixture,
    box,
    `find ${DEVBOX_WORK_DIR} -mindepth 1 -maxdepth 1 ! -name ${harness} -exec rm -rf {} + `
    + `&& printf %s ${marker} > ${DEVBOX_WORK_DIR}/${markerFile} && sync`,
  ), 'the marker was not written');
  await delay(MIN_CHECKPOINT_INTERVAL_MS);

  // A tick preserves the base; this cell needs a delta sidecar to restore.
  const seeded = await checkpointOperation({
    fixture,
    box,
    kind: 'tick',
    what: 'chunked-absorption marker commit',
  });

  sample.seedCheckpoint = seeded;

  if (seeded.outcome?.kind !== 'committed') {
    throw new Error(
      `the marker commit did not publish a delta to serve: `
      + `${seeded.outcome?.kind ?? 'unknown'}${seeded.outcome?.reason === undefined ? '' : ` (${seeded.outcome.reason})`}`,
    );
  }

  sample.beforeState = await boxState(fixture, box);
  const chainId = requiredChainId(sample.beforeState.state?.chain?.base?.id, 'chain');
  sample.before = chainId;
  const deltaId = requiredChainId(sample.beforeState.state?.chain?.delta?.id, 'delta');
  sample.deltaHead = await headObject(fixture, box, `${sample.beforeState.storePrefix ?? ''}backups/${deltaId}/delta.sqsh`);
  const manifestPoint = `${dirname(CHAIN_UPPER_DIR)}/witness-manifest`;
  sample.manifestRead = await execInBox(fixture, box,
    `mkdir -p '${manifestPoint}' && devbox-squashfuse '${CHAIN_STORE_MOUNT_DIR}/${deltaId}/delta.sqsh' '${manifestPoint}' && cat '${manifestPoint}/${DELTA_MANIFEST_NAME}'`);

  if (sample.manifestRead.ok === true && sample.manifestRead.exitCode === 0 && sample.manifestRead.stdout !== undefined) {
    try {
      const manifest = v.safeParse(DeltaManifestSchema, JSON.parse(sample.manifestRead.stdout));

      if (manifest.success) sample.manifest = manifest.output;
      else errors.push(`chunked manifest: ${issueText(manifest.issues)}`);
    } catch (error) {
      errors.push(`chunked manifest: ${describeThrown({ cause: error })}`);
    }
  } else {
    errors.push(sample.manifestRead.error ?? sample.manifestRead.stderr ?? 'the manifest observer did not complete');
  }

  sample.destroyReceipt = await destroyBox(fixture, box);
  const startupObservations: StartupObservation[] = [];
  sample.startupObservations = startupObservations;
  sample.wake = await startupOperation({
    fixture,
    box,
    path: '/wake',
    operation: 'chunked-absorption wake',
    allowedKinds: ['attached'],
    bounds: { observations: startupObservations },
  });
  sample.blockReads = await readBlockAttachMetrics(fixture, box);
  sample.mounts = await execInBox(fixture, box, 'cat /proc/mounts');

  if (sample.mounts.ok === true && sample.mounts.exitCode === 0 && sample.mounts.stdout !== undefined) {
    sample.sidecarMounted = mountAt(sample.mounts.stdout, `${CHAIN_DELTA_LAYER_ROOT}/${chainId}`) !== null;
    const block = mountAt(sample.mounts.stdout, `${dirname(CHAIN_UPPER_DIR)}/block-lower`);
    sample.blockMounted = block?.fstype === 'fuse';
  }

  sample.markerInMerged = await readBoxFile(fixture, box, `${DEVBOX_WORK_DIR}/${markerFile}`);
  sample.markerInUpper = await readBoxFile(fixture, box, `${CHAIN_UPPER_DIR}/${markerFile}`);

  // A new write makes the next publication observable rather than a no-op.
  ranInBox(await execInBox(
    fixture, box, `printf %s ${marker}-after > ${DEVBOX_WORK_DIR}/witness-composed-next.txt && sync`,
  ), 'the post-wake write did not run');
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  sample.nextCheckpoint = await checkpointOperation({
    fixture,
    box,
    kind: 'tick',
    what: 'chunked-absorption next checkpoint',
  });
  sample.afterState = await boxState(fixture, box);
  const next = sample.afterState.state?.chain;
  sample.after = next?.base?.id ?? null;
  sample.afterNamesDelta = next === undefined || next === null ? null : next.delta !== undefined && next.delta !== null;
}

/** A throwing cell records its reason and leaves its facts absent (G2 refuses an unobserved
 *  witness); it never takes the arm down, since the arm's measured rows outweigh it. */
async function runControlWitnessCells(
  fixture: Fixture,
  box: string,
): Promise<{ facts: ControlWitnessFacts; notes: string[] }> {
  const notes: string[] = [];

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

  // Pin the first archive in a live mount, so the next publication's sweep
  // must retain it and its exact pre-publication etag remains observable.
  await cell('mutable-delta', async () => {
    const before = await deltaAfterOneChange(fixture, box, 'a');
    await destroyBox(fixture, box);
    await startupOperation({
      fixture,
      box,
      path: '/wake',
      operation: 'immutable-delta retained mount',
      allowedKinds: ['attached'],
    });
    const after = await deltaAfterOneChange(fixture, box, 'b');

    if (before.chainId !== after.chainId) {
      throw new Error(
        `the chain rebased between the two heads (${before.chainId} then ${after.chainId}), so the `
        + 'cell compared two bases rather than successive immutable deltas',
      );
    }

    facts.mutableDelta = {
      key: after.key,
      previousKey: before.key,
      etagBefore: before.etag,
      etagAfter: after.etag,
      bytesBefore: before.bytes,
      bytesAfter: after.bytes,
      retainedHead: await headObject(fixture, box, before.key),
      beforeState: before.state,
      afterState: after.state,
      checkpoint: after.checkpoint,
    };
  });
  // Runs after priced workloads finish: publishes a small marker delta, then destroys
  // the container without another quiesce before observing chunked absorption.
  await cell('chunked-absorption', async () => {
    await observeChunkedAbsorption(fixture, box, facts);
  });

  return { facts, notes };
}

/** Large enough that no arm settles before the kill, small enough to heal inside the cell.
 *  A victim that settles before the kill is a missed cut, never a fast pass. */
const FAULT_CUT_VICTIM_MIB = 64;

function combineRollbackPhantom(rollback: boolean | null, phantom: boolean | null): boolean | null {
  if (rollback === true || phantom === true) return true;

  if (rollback === null || phantom === null) return null;

  return false;
}

/** A failed heal does not un-run the cut: crash-state judgments stand, the note travels,
 *  and post-heal convergence reads come back null. */
async function healBox(fixture: Fixture, box: string): Promise<string> {
  try {
    const healed = await checkpointOperation({ fixture, box, kind: 'quiesce', what: 'fault-cut heal' });

    if (healed.ok === true && healed.outcome?.kind === 'committed') return '';

    return `healing quiesce answered ${healed.outcome?.kind ?? 'nothing'} (${healed.error ?? 'no reason'})`;
  } catch (error) {
    return `healing quiesce threw: ${describeThrown({ cause: error }).slice(0, 160)}`;
  }
}

/** A marker absent after the cut means the cut beat the commit, so every reader shares this
 *  one read rather than inlining its own. */
async function readBoxMarker(
  fixture: Fixture,
  box: string,
  name: string,
): Promise<FileObservation> {
  return await readBoxFile(fixture, box, `/workspace/${name}`);
}

/** `marker` proves the commit started; `file` is large enough that the quiesce is still
 *  publishing when the kill lands. */
interface CutVictim {
  readonly marker: string;
  readonly content: string;
  readonly file: string;
}

/** Hold a stored payload acknowledgement, kill its writer, then judge the receipt. */
async function fireCutVictim(
  fixture: Fixture,
  box: string,
  victim: CutVictim,
  evidence: CutEvidence,
): Promise<{ victimEnd: string } | { missedReason: string }> {
  await execInBox(fixture, box, `printf %s ${victim.content} > /workspace/${victim.marker} && sync`);

  evidence.markerBefore = await readBoxMarker(fixture, box, victim.marker);

  if (witnessMatches(evidence.markerBefore, createHash('sha256').update(victim.content).digest('hex')) !== true) {
    throw new Error('the fault-cut marker did not land: the box is not serving its workspace');
  }

  await execInBox(
    fixture,
    box,
    `dd if=/dev/urandom of=/workspace/${victim.file} bs=1048576 count=${FAULT_CUT_VICTIM_MIB} 2>/dev/null && sync`,
  );

  const armed = await armCheckpointOperation({
    fixture,
    box,
    kind: 'quiesce',
    what: 'fault-cut victim',
    route: '/checkpoint-cut',
  });

  const query = `box=${box}&token=${encodeURIComponent(armed.op)}`;

  const pollOperation = async (): Promise<OperationPollReply> => await call({
    fixture,
    method: 'GET',
    path: `/operation?box=${box}&token=${encodeURIComponent(armed.token)}`,
    schema: OperationPollReplySchema,
  });

  try {
    const receipt = await rendezvousPublicationCut({
      read: async () => await call({
        fixture,
        method: 'GET',
        path: `/fault-cut?${query}`,
        schema: PublicationCutSchema,
      }),
      pending: async () => (await pollOperation()).state === 'pending',
      kill: async () => await call({
        fixture,
        method: 'POST',
        path: `/fault-cut/kill?${query}`,
        schema: PublicationCutSchema,
      }),
      cancel: async () => await call({
        fixture,
        method: 'POST',
        path: `/fault-cut/cancel?${query}`,
        schema: PublicationCutSchema,
      }),
      wait: async () => await delay(500),
    });

    evidence.receipt = receipt;

    if (!publicationWasCut(receipt, armed.op)) {
      return { missedReason: `NOT-CUT: ${JSON.stringify(receipt)}` };
    }

    let outcome: OperationPollReply | null = null;

    for (let waited = 0; waited < 120 && outcome === null; waited += 1) {
      await delay(500);
      const poll = await pollOperation();
      evidence.victimOperation = poll;

      if (poll.state === 'done' || poll.state === 'failed') outcome = poll;
      else if (poll.state !== 'pending') {
        throw new Error(`the victim answered state "${poll.state ?? 'none'}": ${poll.error ?? 'no reason given'}`);
      }
    }

    if (outcome === null) throw new Error('the victim never settled after the cut');

    return { victimEnd: `CUT: ${JSON.stringify(receipt)}; victim ${outcome.state ?? 'unmeasured'}` };
  } finally {
    await call({ fixture, method: 'POST', path: `/fault-cut/clear?${query}`, schema: AckReplySchema });
  }
}


/** Runs in a subshell: a top-level `exit` would kill the SDK's persistent bash session (D18).
 *  The child returns the write status while the session stays available. */
export function readOnlyLayerProbeCommand(layerPoint: string): string {
  return `( touch '${layerPoint}/.faultcut-ro-probe' 2>&1; code=$?; rm -f '${layerPoint}/.faultcut-ro-probe' 2>/dev/null; exit $code )`;
}

/** Served layers are squashfs, so a write must fail EROFS; a successful write refuses the run.
 *  A probe the box never ran yields `refusedWrites` null, never true. */
async function probeReadOnlyLayer(
  fixture: Fixture,
  box: string,
  evidence: CutEvidence,
): Promise<{ surface: string; refusedWrites: boolean | null } | null> {
  const mountsNow = await execInBox(fixture, box, 'cat /proc/mounts');
  evidence.mounts = mountsNow;
  let layerPoint: string | null = null;

  for (const raw of (mountsNow.ok === true && mountsNow.exitCode === 0 ? mountsNow.stdout ?? '' : '').split('\n')) {
    const at = raw.trim().split(' ')[1] ?? '';

    if (at.startsWith(`${CHAIN_DELTA_LAYER_ROOT}/`)) {
      layerPoint = at;
      break;
    }

    if (at === CHAIN_LOWER_BASE_DIR) layerPoint = at;
  }

  if (layerPoint === null) return null;

  const probe = await execInBox(
    fixture,
    box,
    readOnlyLayerProbeCommand(layerPoint),
  );

  evidence.readOnlyProbe = probe;

  return {
    surface: layerPoint,
    refusedWrites: probe.exitCode === undefined || probe.error !== undefined
      ? null
      : judgeReadOnlyRefusal(probe.exitCode, `${probe.stderr ?? ''}\n${probe.stdout ?? ''}`),
  };
}

async function readCutArchiveRows(
  fixture: Fixture,
  box: string,
  rows: readonly ChainArchiveExpectation[],
  evidence: CutEvidence,
): Promise<{
  readonly deltaRow: ChainArchiveExpectation | undefined;
  readonly baseExists: boolean | null;
  readonly deltaExists: boolean | null;
  readonly unexpectedDelta: boolean | null;
  readonly postDeltaEtag: string | null;
}> {
  const deltaRow = rows[1];
  const baseRow = rows[0];
  let baseExists: boolean | null = null;
  let deltaExists: boolean | null = null;
  let unexpectedDelta: boolean | null = false;
  let postDeltaEtag: string | null = null;

  if (baseRow !== undefined) {
    const head = await readCutHead(fixture, box, baseRow.key, evidence);
    baseExists = headPresence(head);
  }

  if (deltaRow !== undefined) {
    const head = await readCutHead(fixture, box, deltaRow.key, evidence);
    const exists = headPresence(head);
    deltaExists = deltaRow.present ? exists : null;
    unexpectedDelta = deltaRow.present ? false : exists;

    if (deltaRow.present && head?.error === undefined) postDeltaEtag = head?.etag ?? null;
  }

  return { deltaRow, baseExists, deltaExists, unexpectedDelta, postDeltaEtag };
}

/** Heals the box before returning, so the next cell meets a committed generation rather
 *  than a kill's aftermath. */
async function readChainCutCell(
  fixture: Fixture,
  box: string,
  cut: {
    readonly prefix: string;
    readonly marker: string;
    readonly content: string;
    readonly victimEnd: string;
    readonly kind: string;
    readonly detail: string;
    readonly pre: ChainGeneration | null;
    readonly preDeltaEtag: string | null;
  },
  evidence: CutEvidence,
): Promise<FaultCutObservation> {
  const {
    prefix, marker: cutMarker, content: cutContent, victimEnd,
    kind: cutKind, detail: cutDetail, pre: chainPre, preDeltaEtag: chainPreDeltaEtag,
  } = cut;

  evidence.postState = await boxState(fixture, box);
  const gen = chainGenerationFromState(evidence.postState);

  const recordPresent = evidence.postState.state === undefined || evidence.postState.error !== undefined
    ? null : gen.baseId !== null && gen.baseId.length > 0;

  const rows = recordPresent && gen.baseId !== null
    ? chainArchiveExpectations(gen.baseId, gen.deltaId ?? undefined, prefix)
    : [];

  const { deltaRow, baseExists, deltaExists, unexpectedDelta, postDeltaEtag } =
    await readCutArchiveRows(fixture, box, rows, evidence);

  evidence.markerAfter = await readBoxMarker(fixture, box, cutMarker);
  const markerPresent = witnessMatches(evidence.markerAfter, createHash('sha256').update(cutContent).digest('hex'));

  const facts: ChainCutFacts = {
    recordPresent,
    preDeltaId: chainPre?.deltaId ?? null,
    postDeltaId: gen.deltaId ?? null,
    preBaseId: chainPre?.baseId ?? null,
    preHasDelta: chainPre?.hasDelta ?? false,
    preRev: chainPre?.rev ?? null,
    preDeltaEtag: chainPreDeltaEtag,
    postBaseId: gen.baseId,
    postHasDelta: gen.hasDelta,
    postRev: gen.rev,
    postDeltaEtag,
    servedWord: chainServedWord(cutDetail),
    cutMarkerPresent: markerPresent,
    baseExists,
    deltaExists,
    unexpectedDelta,
  };

  const absentReferences = recordPresent !== true || baseExists === null || (gen.hasDelta && deltaExists === null)
    ? null
    : (!baseExists ? 1 : 0) + (deltaRow?.present === true && deltaExists === false ? 1 : 0);

  const readOnly = await probeReadOnlyLayer(fixture, box, evidence);
  const readOnlySurface = readOnly === null ? null : readOnly.surface;
  const readOnlyRefusedWrites = readOnly === null ? null : readOnly.refusedWrites;

  for (const witness of evidence.acknowledgement?.witnesses ?? []) {
    evidence.baselineAfter.push(await readBoxFile(fixture, box, witness.path));
  }

  evidence.facts = { ...facts, observersComplete: readOnly !== null && readOnly.refusedWrites !== null };
  const judgment = judgeChainCut(evidence.facts);
  const ackLoss = barrierAckLoss(evidence.acknowledgement, evidence.baselineAfter);
  const healNote = await healBox(fixture, box);

  return {
    completed: true,
    verdict: cutKind !== 'attached' && cutKind !== 'already-attached' ? 'mixed' : judgment.verdict,
    absentReferences,
    rollbackOrPhantomRoot: combineRollbackPhantom(judgment.rollback, judgment.phantom),
    barrierAckLoss: ackLoss,
    readOnlySurface,
    readOnlyRefusedWrites,
    detail: `victim ${victimEnd}; ${judgment.detail}${unexpectedDelta ? '; store holds a delta the record does not name' : ''}${healNote === '' ? '' : `; ${healNote}`}`,
    evidence,
  };
}

export function headPresence(head: HeadReply | null): boolean | null {
  if (head === null || head.error !== undefined || head.exists === undefined) return null;

  if (!head.exists) return false;

  if (head.size === undefined || !Number.isSafeInteger(head.size) || head.size < 0) return null;

  return head.size > 0;
}

async function readCutHead(fixture: Fixture, box: string, key: string, evidence: CutEvidence): Promise<HeadReply | null> {
  try {
    const reply = await headObject(fixture, box, key);
    evidence.heads.push({ key, reply, error: reply.error ?? null });

    return reply;
  } catch (error) {
    evidence.heads.push({ key, reply: null, error: describeThrown({ cause: error }) });

    return null;
  }
}

/** A cell that cannot run throws; the caller records an incomplete cell, never a fast pass.
 *  Runs after the witness cells and before teardown: it disturbs generations, so none may follow. */
async function runFaultCutCell(
  fixture: Fixture,
  box: string,
  evidence: CutEvidence,
): Promise<FaultCutObservation> {
  const tag = crypto.randomUUID().slice(0, 8);
  const cutMarker = `faultcut-cut-${tag}.txt`;
  const cutContent = `faultcut-cut-${tag}`;
  const victim = `faultcut-victim-${tag}.bin`;
  const acknowledgedContent = `acknowledged-before-cut-${crypto.randomUUID()}`;
  const acknowledgedPath = `/workspace/faultcut-ack-${tag}.txt`;

  const witness: BarrierWitness = {
    path: acknowledgedPath,
    expectedDigest: createHash('sha256').update(acknowledgedContent).digest('hex'),
    expectedSize: Buffer.byteLength(acknowledgedContent),
  };

  evidence.acknowledgement = { witnesses: [witness], checkpoint: null };
  await writeFileInBox(fixture, box, acknowledgedPath, acknowledgedContent);
  const baselineRead = await readBoxFile(fixture, box, acknowledgedPath);
  evidence.baselineBefore.push(baselineRead);

  if (witnessMatches(baselineRead, witness.expectedDigest) !== true) {
    throw new Error(`the baseline witness was not observed: ${baselineRead.error ?? 'bytes differ'}`);
  }

  const acknowledged = await checkpointOperation({
    fixture,
    box,
    kind: 'quiesce',
    what: 'fault-cut acknowledged baseline',
  });

  evidence.acknowledgement = { witnesses: [witness], checkpoint: acknowledged };

  if (acknowledged.ok !== true || acknowledged.outcome?.kind !== 'committed') {
    throw new Error(`the baseline was not acknowledged: ${checkpointOutcomeWords(acknowledged)}`);
  }

  const state0 = await boxState(fixture, box);
  evidence.preState = state0;
  const prefix = state0.storePrefix ?? '';
  const chainPre = chainGenerationFromState(state0);
  evidence.pre = chainPre;
  let chainPreDeltaEtag: string | null = null;

  if (chainPre.hasDelta && chainPre.baseId !== null) {
    const preRows = chainArchiveExpectations(chainPre.baseId, chainPre.deltaId ?? undefined, prefix);
    const preDelta = preRows[1];

    if (preDelta !== undefined) {
      const head = await readCutHead(fixture, box, preDelta.key, evidence);
      evidence.preDeltaHead = head;
      chainPreDeltaEtag = head?.error === undefined ? head?.etag ?? null : null;
    }
  }

  // A cut that never met its publication is a miss: record an incomplete cell, never a pass.
  const fired = await fireCutVictim(fixture, box, { marker: cutMarker, content: cutContent, file: victim }, evidence);

  if ('missedReason' in fired) {
    return {
      completed: false,
      verdict: 'unjudged',
      absentReferences: null,
      rollbackOrPhantomRoot: null,
      barrierAckLoss: null,
      readOnlySurface: null,
      readOnlyRefusedWrites: null,
      detail: fired.missedReason,
      evidence,
    };
  }

  // Every kind is admitted: an empty wake after the cut is the finding, not a step failure,
  // and the judges below read it as one.
  const cut = await startupOperation({
    fixture,
    box,
    path: '/wake',
    operation: 'fault-cut wake',
    allowedKinds: ['attached', 'already-attached', 'empty'],
    bounds: { observations: evidence.wakeObservations },
  });

  evidence.wake = cut;
  const cutDetail = cut.attach.detail;
  const cutKind = cut.attach.kind;

  return await readChainCutCell(fixture, box, {
    prefix,
    marker: cutMarker,
    content: cutContent,
    victimEnd: fired.victimEnd,
    kind: cutKind,
    detail: cutDetail,
    pre: chainPre,
    preDeltaEtag: chainPreDeltaEtag,
  }, evidence);
}

async function deltaAfterOneChange(
  fixture: Fixture,
  box: string,
  label: string,
): Promise<{ chainId: string; key: string; etag: string; bytes: number; state: StateReply; checkpoint: CheckpointReply }> {
  await execInBox(fixture, box, `printf %s mutable-delta-${label} > /workspace/witness-delta-${label}.txt && sync`);
  await delay(MIN_CHECKPOINT_INTERVAL_MS);
  const checkpoint = await checkpointOperation({ fixture, box, kind: 'tick', what: `mutable-delta cell ${label}` });
  const state = await call({ fixture, method: 'GET', path: `/state?box=${box}`, schema: StateReplySchema });
  const chainId = state.state?.chain?.base?.id ?? '';

  if (chainId.length === 0) throw new Error('/state reported no chain generation');
  const deltaId = state.state?.chain?.delta?.id;

  if (deltaId === undefined) throw new Error('/state reported no immutable delta identity');
  const key = `${state.storePrefix ?? ''}backups/${deltaId}/delta.sqsh`;

  const head = await call({
    fixture,
    method: 'GET',
    path: `/head?box=${box}&key=${encodeURIComponent(key)}`,
    schema: HeadReplySchema,
  });

  return { chainId, key, etag: head.etag ?? '', bytes: head.size ?? 0, state, checkpoint };
}

/** A chain record with no delta is valid: `shouldRebase` publishes a bare base once the delta
 *  outgrows it. A delta object under a generation whose record names none is a finding. */
export interface ChainArchiveExpectation {
  readonly name: string;
  readonly key: string;
  readonly present: boolean;
}

export function chainArchiveExpectations(
  chainId: string | undefined,
  deltaId: string | undefined,
  /** The box's own store prefix as `/state` reports it (`boxes/<id>/`); chain generations
   *  live under it per box, so a key built without it names nothing. */
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
    deltaId !== undefined
      ? {
          name: 'the delta object the record names exists in the store with non-zero size',
          key: `${storePrefix}backups/${deltaId}/delta.sqsh`,
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

/** Matches `Devbox.ensureReady()`'s own retry phrases; only the one naming `attachNow()` is a verdict.
 *  The reply carries no phase code, so re-armability cannot be inferred from one. */
export function isRearmableStartupRefusal(error: string | undefined): boolean {
  return /a startup is armed, so ask again|a retry is already under way/i.test(error ?? '');
}

/** An arm's result before measurement: every number absent, nothing proven. The run loop
 *  records this shape when an arm dies mid-measurement; a second literal would drift. */
function unmeasuredArm(strategy: Strategy, box: string, notes: string[]): ArmResult {
  return {
    strategy, box, verifyPassed: false, verifyChecks: [],
    attachColdMs: null, attachColdKind: '', attachColdBootId: null,
    attachWarmMs: null, attachWarmKind: '', wakeBootId: null, attachWarmBootId: null,
    checkpoints: [], stopMs: null, wakeMs: null, wakeKind: '', wakeDetail: '',
    wakeOps: null, wakeMountLines: [], complexity: [],
    phases: [], decisiveTicks: [], quiescesBeforeDecisive: 0,
    generationBeforeLadder: null, generationAfterLadder: null,
    treeBytes: {}, ops: null, teardown: null, witnessChecks: [], cut: null, notes,
  };
}

/** A window that does not difference records a note, so the report cannot read its null
 *  as a wake that did no remote work. */
async function closeWakeOpsWindow(
  fixture: Fixture,
  box: string,
  before: OpTally,
  notes: string[],
): Promise<OpTally | null> {
  await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  const after = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
  const wakeOps = diffOpTallies(before, after);

  if (wakeOps === null) {
    notes.push('the wake-window /ops bracket did not difference: the restore goes uncounted on totalRemoteOps');
  }

  return wakeOps;
}

const RestoreProbeReplySchema: v.GenericSchema<{
  readonly ok?: boolean;
  readonly probe?: {
    readonly wallMs: number | null;
    readonly at: number;
    readonly phases?: RestorePhaseStamps;
  } | null;
}> = v.looseObject({
  ok: v.optional(v.boolean()),
  probe: v.optional(v.nullable(v.looseObject({
    wallMs: v.nullable(v.number()),
    at: v.number(),
    phases: v.optional(RestorePhaseStampsSchema),
  }))),
});

/** Never throws: a failed poll would cost the arm its measured cells for one diagnostic
 *  read, so every failure is an absent row with its reason. */
export interface RestoreProbe {
  readonly fixture: Fixture;
  readonly box: string;
  readonly kind: RestoreProbeRow['kind'];
  readonly treeBytes: number | null;
  readonly notes: string[];
  readonly notBefore: number;
}

export async function readRestoreProbe(
  { fixture, box, kind, treeBytes, notes, notBefore }: RestoreProbe,
): Promise<RestoreProbeRow> {
  const absent = (outcome: string): RestoreProbeRow => ({ kind, treeBytes, wallMs: null, probeAt: null, outcome });
  let reply: v.InferOutput<typeof RestoreProbeReplySchema>;

  try {
    reply = await call({ fixture, method: 'GET', path: `/restore-probe?box=${box}`, schema: RestoreProbeReplySchema });
  } catch (error) {
    const words = describeThrown({ cause: error }).slice(0, 240);
    notes.push(`restore probe ${kind} did not answer: ${words}`);

    return absent(`error: ${words}`);
  }

  if (reply.probe === undefined || reply.probe === null) {
    return absent(reply.ok === false ? 'absent: the box wrote no probe row for its last start' : 'absent: no probe row in the reply');
  }

  const { wallMs, at, phases } = reply.probe;

  // The row names the last restore, not the last start: an adopting start runs no restore,
  // so a row opened before this startup belongs to an earlier restore and must not be timed.
  if (at < notBefore) {
    notes.push(`restore probe ${kind}: the last restore predates this startup, so it adopted the instance it held`);

    return absent(`absent: the last restore opened at ${String(at)}, before this startup at ${String(notBefore)}; the box adopted the instance it held`);
  }

  // A row with no wall time means the platform reset the object mid-restore or it still runs;
  // the last phase present is where it got to.
  const reached = Object.keys(phases ?? {});
  const where = reached.length === 0 ? 'none' : reached.join(', ');

  if (wallMs === null) notes.push(`restore probe ${kind}: the start never settled; phases reached: ${where}`);

  const row: RestoreProbeRow = {
    kind, treeBytes, wallMs, probeAt: at,
    outcome: wallMs === null ? `unsettled: the start opened a row and never settled it (phases: ${where})` : 'ok',
  };

  return phases === undefined ? row : { ...row, phases };
}

/** Every restore the walk settles records exactly one row, present or absent;
 *  the walk itself carries no branch for it. */
interface RecordedRestoreProbe extends RestoreProbe {
  readonly result: ArmResult;
}

async function recordRestoreProbe(
  { fixture, box, result, kind, treeBytes, notes, notBefore }: RecordedRestoreProbe,
): Promise<void> {
  const row = await readRestoreProbe({ fixture, box, kind, treeBytes, notes, notBefore });
  (result.restoreProbes ??= []).push(row);
  const phases = Object.entries(row.phases ?? {}).map(([phase, atMs]) => `${phase}=${String(atMs)}`).join(' ');
  log(`restore probe ${kind}: wallMs=${String(row.wallMs)} ${phases.length === 0 ? 'no phases' : phases} (${row.outcome})`);
}

/** Every phase once, then the deciding phase repeated.
 *  A verify-only probe skips all workloads and records the skip as a note, never silently. */
export interface WorkloadPhases {
  readonly fixture: Fixture;
  readonly box: string;
  readonly strategy: Strategy;
  readonly run: { seed: number; budgetMs: number; repetitions: number; verifyOnly: boolean };
  readonly result: ArmResult;
  readonly notes: string[];
}

export async function runWorkloadPhases(
  { fixture, box, strategy, run, result, notes }: WorkloadPhases,
): Promise<void> {
  if (run.verifyOnly) {
    notes.push(
      'workload phases skipped: a verify-only probe measures the lifecycle (ladder, stop, wake), '
      + 'not performance workloads',
    );

    return;
  }

  /** A throwing phase records its reason and leaves its row absent, so G9 counts one
   *  repetition fewer instead of a silent success. */
  const measurePhase = async (phase: string, what: string): Promise<void> => {
    const states = result.workloadStates ??= [];
    states.push(await observeContinuity(fixture, box, `${what}: before`));

    try {
      result.phases.push(await runPhase({
        fixture,
        box,
        root: `/workspace/ab-${strategy}`,
        phase,
        seed: run.seed,
        budgetMs: run.budgetMs,
      }));
    } catch (error) {
      const reason = describeThrown({ cause: error });
      log(`phase ${what} failed: ${reason.slice(0, 160)}`);
      notes.push(`phase ${what} did not complete: ${reason.slice(0, 240)}`);
    }

    states.push(await observeContinuity(fixture, box, `${what}: after`));

    await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  };

  log('workload phases');

  for (const phase of PHASES) await measurePhase(phase, phase);

  // G9 censors a cell with fewer than two repetitions of the deciding metric, so it repeats.
  // The phase is read from what the first pass measured, so the metric may move between phases.
  const decidingPhases = phasesMeasuring(result.phases, DECIDING_METRIC);

  if (decidingPhases.length === 0 && run.repetitions > 1) {
    notes.push(
      `no phase measured the deciding metric \`${DECIDING_METRIC}\`, so its `
      + `${run.repetitions} repetitions could not be run`,
    );
  }

  for (let repetition = 2; repetition <= run.repetitions; repetition += 1) {
    for (const phase of decidingPhases) {
      log(`deciding phase ${phase}, repetition ${repetition} of ${run.repetitions}`);
      await measurePhase(phase, `${phase} repetition ${repetition}`);
    }
  }

  log(
    `the deciding metric \`${DECIDING_METRIC}\` was measured `
    + `${metricRows(result, DECIDING_METRIC).length} time(s) over phase(s) `
    + `${decidingPhases.length === 0 ? '(none)' : decidingPhases.join(', ')}`,
  );
}

/** Witness cells run after the measured window: their own writes and checkpoints must not
 *  enter the arm's counts. G2 refuses an arm that shows none of its preregistered defects. */
interface WitnessCellsPhase {
  readonly fixture: Fixture;
  readonly box: string;
  readonly strategy: Strategy;
  readonly result: ArmResult;
  readonly notes: string[];
}

async function runWitnessCellsPhase(
  { fixture, box, strategy, result, notes }: WitnessCellsPhase,
): Promise<void> {
  if (PREREGISTERED_WITNESSES[strategy].length > 0) {
    log('witness cells');
    const witnessed = await runControlWitnessCells(fixture, box);
    result.witnessFacts = witnessed.facts;
    result.witnessChecks = controlWitnessChecks(strategy, witnessed.facts, result.witnessProfile);
    notes.push(...witnessed.notes);
    const unobserved = result.witnessChecks.filter((witness) => !witness.observed);

    if (unobserved.length > 0) {
      notes.push(
        `WITNESS DRIFT: ${unobserved.map((witness) => `${witness.name} (${witness.detail})`).join('; ')}`,
      );
    }
  }
}

/** Runs after all measurement: the cut (kill, wake, healing checkpoint) disturbs tally and ticks.
 *  Skips an arm with no verified lifecycle or attached wake; it has no publication to cut. */
async function runFaultCutPhase(
  fixture: Fixture,
  box: string,
  arm: Pick<ArmResult, 'verifyPassed' | 'wakeKind'>,
): Promise<{ cut: FaultCutObservation | null; notes: string[] }> {
  if (arm.verifyPassed && arm.wakeKind === 'attached') {
    log('fault-cut cell');
    const evidence = newCutEvidence();

    try {
      const cut = await runFaultCutCell(fixture, box, evidence);

      return { cut, notes: [`fault-cut: ${cut.detail}`] };
    } catch (error) {
      const reason = describeThrown({ cause: error }).slice(0, 240);
      evidence.errors.push(reason);

      return {
        cut: {
          completed: false,
          verdict: 'unjudged',
          absentReferences: null,
          rollbackOrPhantomRoot: null,
          barrierAckLoss: null,
          readOnlySurface: null,
          readOnlyRefusedWrites: null,
          detail: `the cut cell threw before judging: ${reason}`,
          evidence,
        },
        notes: [`fault-cut cell did not complete: ${reason}`],
      };
    }
  }

  return {
    cut: null,
    notes: [
      `fault-cut cell skipped: ${arm.verifyPassed ? `its wake answered "${arm.wakeKind || 'nothing'}"` : 'the arm never verified its lifecycle'}, so there is no publication to cut`,
    ],
  };
}

/** Storage-only in an isolated per-call namespace, so no lifecycle gate: never judges the
 *  arm's publication or touches a live prefix. An unrunnable cell reports why; G4 refuses. */
async function runSecurityCellsPhase(
  fixture: Fixture,
  box: string,
  strategy: Strategy,
): Promise<{ observation: SecurityCellsObservation | null; notes: string[] }> {
  log('security cells');

  try {
    const nonce = securityNonce();

    const outcome = await retryTransient('security fault cells', async (): Promise<{
      observation: SecurityCellsObservation; notes: string[]; error?: string;
    }> => await runSecurityFaultCells({ fixture, box, strategy, nonce }));

    return { observation: outcome.observation, notes: outcome.notes };
  } catch (error) {
    const reason = describeThrown({ cause: error }).slice(0, 240);

    return { observation: null, notes: [`security cells did not complete: ${reason}`] };
  }
}

/** Cleanup failure is not measurement failure: a step records its reason and the arm returns
 *  what it measured; `teardownLiveArms` still sweeps the box and reports under G8. */
async function releaseArm(
  fixture: Fixture,
  box: string,
  result: ArmResult,
  notes: string[],
): Promise<void> {
  const teardown = async (): Promise<ArmResult> => {
    result.teardown ??= await call({
      fixture,
      method: 'POST',
      path: `/teardown?box=${box}`,
      schema: TeardownReplySchema,
      body: { purge: true, prefix: '', whole: true },
    });

    return result;
  };

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

  // Each arm must hand its box back: `mountBucket` refuses a second mount of one binding at
  // a different prefix or readOnly, so a failed release surfaces as the next arm's create refusal.
  await cleanupStep('box release', async () => {
    const released = await stopOperation(fixture, box, 'box release');

    if (released.ok !== true) {
      notes.push(`the box was not released after the arm: ${released.error ?? 'stop did not confirm'}`);
    }
  });
}

/** A chain wake mounts layers and materializes nothing, so its `cpuSteps` is the served count.
 *  `printf x` per entry, so a newline in a name cannot count twice. */
async function recordServedEntries(
  fixture: Fixture,
  box: string,
  result: ArmResult,
  notes: string[],
): Promise<void> {
  if (result.wakeKind !== 'attached') return;

  const served = await retryTransient('served entry count', async () =>
    await execInBox(fixture, box, 'find /workspace -mindepth 1 -printf x | wc -c'));

  const count = Number((served.stdout ?? '').trim());

  if (served.exitCode === 0 && Number.isSafeInteger(count) && count >= 0) result.wakeServedEntries = count;
  else notes.push(`the served entry count did not answer: ${(served.stderr ?? served.error ?? '').trim().slice(0, 120)}`);
}

/** Every rung but the last stops and wakes; the post-ladder wake is the last rung's restore.
 *  A failed extra measurement writes a row and a note, never a gate. */
interface ComplexityRung {
  readonly fixture: Fixture;
  readonly box: string;
  readonly kib: number;
  readonly rung: number;
  readonly ladderBytes: number;
  readonly complexityScope: boolean;
  readonly result: ArmResult;
  readonly notes: string[];
  readonly startup: (
    path: '/create' | '/wake',
    operation: string,
    allowedKinds: readonly string[],
  ) => Promise<StartupCompletion>;
}

async function measureComplexityRung(
  { fixture, box, kib, rung, ladderBytes, complexityScope, result, notes, startup }: ComplexityRung,
): Promise<number> {
  if (!complexityScope) return ladderBytes;
  const treeBytes = ladderBytes + kib * 1024;

  try {
    await retryTransient(`complexity 64KiB write at ${treeBytes}B`, async () =>
      await execInBox(fixture, box, 'dd if=/dev/urandom of=/workspace/ladder/backup-64k.bin bs=1024 count=64 2>/dev/null && sync'),
    );
    result.quiescesBeforeDecisive++;

    const backup = await checkpointOperation({
      fixture,
      box,
      kind: 'quiesce',
      what: `complexity backup-64k at ${treeBytes}B`,
    });

    result.complexity?.push({
      treeBytes,
      kind: 'backup-64k',
      ms: backup.ms ?? null,
      outcome: backup.error !== undefined ? `error: ${backup.error}` : checkpointOutcomeWords(backup),
    });
  } catch (error) {
    const words = describeThrown({ cause: error }).slice(0, 240);
    notes.push(`complexity backup-64k at ${treeBytes}B did not answer: ${words}`);
    result.complexity?.push({ treeBytes, kind: 'backup-64k', ms: null, outcome: `error: ${words}` });
  }

  if (rung < CHANGE_SIZES_KIB.length - 1) {
    try {
      const restoreStop = await stopOperation(fixture, box, `complexity restore at ${treeBytes}B`);
      requireConfirmedStop(restoreStop, `complexity restore at ${treeBytes}B: stop failed before wake`);
      // The ops window opens after the stop confirms; opened earlier, the stop's final
      // checkpoint is counted as restore operations.
      await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
      const opsBeforeRestore = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
      const rewoke = await startup('/wake', `complexity restore at ${treeBytes}B`, admittedAttachKinds('wake'));
      const restoreOps = await closeWakeOpsWindow(fixture, box, opsBeforeRestore, notes);
      // Polled inside the try so a silent probe yields an absent row, not a thrown rung.
      await recordRestoreProbe({
        fixture,
        box,
        result,
        kind: 'complexity-restore',
        treeBytes,
        notes,
        notBefore: rewoke.startedAt,
      });
      result.complexity?.push({
        treeBytes,
        kind: 'restore',
        ms: rewoke.ms,
        outcome: rewoke.attach.kind,
        attachKind: rewoke.attach.kind,
        wakeOps: restoreOps,
      });
    } catch (error) {
      const words = describeThrown({ cause: error }).slice(0, 240);
      notes.push(`complexity restore at ${treeBytes}B did not answer: ${words}`);
      result.complexity?.push({ treeBytes, kind: 'restore', ms: null, outcome: `error: ${words}` });
    }
  }

  return treeBytes;
}

/** The last rung's restore is the post-ladder wake itself. Transcribe it from
 *  the wake the arm just took, so the third rung needs no extra stop and wake. */
function recordFinalComplexityRestore(
  result: ArmResult,
  ladderBytes: number,
  complexityScope: boolean,
): void {
  if (!complexityScope) return;
  result.complexity?.push({
    treeBytes: ladderBytes,
    kind: 'restore',
    ms: result.wakeMs,
    outcome: result.wakeKind,
    attachKind: result.wakeKind,
    wakeOps: result.wakeOps,
  });
}

interface ArmMeasurement {
  readonly fixture: Fixture;
  readonly strategy: Strategy;
  readonly options: Options;
  readonly noteLiveBox: (box: string) => void;
  /** Receives the arm's own mutable row before anything is measured into it, so a refusal
   *  mid-arm leaves the caller every step that completed instead of an `unmeasuredArm`. */
  readonly observe?: (row: ArmResult) => void;
}

async function measureArm(
  { fixture, strategy, options, noteLiveBox, observe = () => {} }: ArmMeasurement,
): Promise<ArmResult> {
  // ONE BOX PER ARM: mountBucket refuses a second mount of one binding at a
  // different prefix or readOnly value, so the arms cannot share an instance.
  const boxBase = `ab-${strategy}-${options.runId}`;
  let box = boxBase;
  const notes: string[] = [];
  const result = unmeasuredArm(strategy, box, notes);
  result.witnessProfile = 'chunked';
  result.decisiveRequested = options.decisive;
  observe(result);
  noteLiveBox(box);

  /** Writes the live row, never a copy, so the artifact cannot disagree with run-level assembly.
   *  A failed write is logged and swallowed: the safety-net artifact must not abort the arm. */
  const settle = (what: string): void => {
    try {
      writeArmArtifact(REPO_ROOT, options.runId, strategy, result);
    } catch (error) {
      log(`the durable arm artifact could not be written after ${what}: ${describeThrown({ cause: error })}`);
    }
  };

  settle('the arm started');

  /** A driver-driven startup stays in the row as real cost, but its driver contribution is
   *  recorded beside it so a reader sees the fixture's schedule did not complete it. */
  const startup = async (
    path: '/create' | '/wake',
    operation: string,
    allowedKinds: readonly string[],
  ): Promise<StartupCompletion> => {
    const record: StartupRecord = { path, operation, completion: null, failure: null, error: null, observations: [] };
    (result.startups ??= []).push(record);
    let completed: StartupCompletion;

    try {
      completed = await startupOperation({
        fixture,
        box,
        path,
        operation,
        allowedKinds,
        bounds: { observations: record.observations },
      });
      record.completion = completed;
    } catch (error) {
      record.error = describeThrown({ cause: error });
      record.failure = await observeContinuity(fixture, box, `${operation}: refused`);
      throw error;
    }

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
  const createKickedAt = Date.now();

  try {
    cold = await startup('/create', 'cold attach', admittedAttachKinds('cold attach'));
  } catch (error) {
    // Logged as well as noted: a create failure ends this arm and the run continues, so
    // without the log line the operator sees no reason outside the artifact.
    const note = `create failed: ${describeThrown({ cause: error })}`;
    log(note);
    notes.push(note);
    // A refused start's evidence: a start the platform reset leaves its row with the phases
    // it reached and no wall time, so the probe row is polled even on refusal.
    await recordRestoreProbe({
      fixture,
      box,
      result,
      kind: 'cold-attach',
      treeBytes: 0,
      notes,
      notBefore: createKickedAt,
    });
    settle('a refused create');

    return result;
  }

  result.attachColdMs = cold.ms;
  result.attachColdKind = cold.attach.kind;
  result.attachColdBootId = cold.state.state?.bootId ?? null;
  // Records the cold start's own restore wall time, separate from the driver's round trip.
  // The tree is empty here; sized restores are recorded per rung.
  await recordRestoreProbe({
    fixture,
    box,
    result,
    kind: 'cold-attach',
    treeBytes: 0,
    notes,
    notBefore: cold.startedAt,
  });
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
  await call({ fixture, method: 'POST', path: `/ops/reset?box=${box}`, schema: AckReplySchema });

  result.generationBeforeLadder = await chainGeneration(fixture, box);
  // Tree-size rows run only in the decisive scope; verify-only leaves ladder, stop and wake untouched.
  // `ladderBytes` is the size axis: ladder bytes written so far when the rung below measures.
  const complexityScope = !options.verifyOnly;
  let ladderBytes = 0;

  for (const [rung, kib] of CHANGE_SIZES_KIB.entries()) {
    await retryTransient(`ladder ${kib}KiB write`, async () =>
      await execInBox(fixture, box, `mkdir -p /workspace/ladder && dd if=/dev/urandom of=/workspace/ladder/c${kib}.bin bs=1024 count=${kib} 2>/dev/null && sync`),
    );

    for (const kind of ['quiesce', 'tick'] as const) {
      if (kind === 'quiesce') result.quiescesBeforeDecisive++;
      const cp = await checkpointOperation({ fixture, box, kind, what: `ladder ${kib}KiB ${kind}` });
      result.checkpoints.push({
        changeKiB: kib,
        kind,
        ms: cp.ms ?? -1,
        bytes: cp.outcome?.bytes ?? -1,
        outcome: cp.error !== undefined ? `error: ${cp.error}` : checkpointOutcomeWords(cp),
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

    ladderBytes = await measureComplexityRung({
      fixture,
      box,
      kib,
      rung,
      ladderBytes,
      complexityScope,
      result,
      notes,
      startup,
    });
  }

  // Read right after the ladder publishes, so the incident ledger names this publication's window.
  result.publishIncidents = await readIncidentReasons(fixture, box, notes);

  // Each request is independently retryable if a replacement interrupts it; nothing reruns
  // the whole proof.
  log('stop then wake');
  const stopped = await stopOperation(fixture, box, 'stop');
  result.stopMs = stopped.ms ?? null;
  // A failed quiesce can return before stop; waking then would observe the still-running box
  // and fabricate attach evidence for a recycle that never happened.
  requireConfirmedStop(stopped, 'stop failed before wake');
  // Flush before the wake: the tally batches in the proxy isolate, so an unflushed boundary
  // would bill the stop's tail to the restore; nothing inside the window hits counted seams.
  await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  const opsBeforeWake = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
  const woke = await startup('/wake', 'wake', admittedAttachKinds('wake'));
  result.wakeMs = woke.ms;
  result.wakeKind = woke.attach.kind;
  result.wakeDetail = woke.attach.detail;
  result.wakeBootId = woke.state.state?.bootId ?? null;
  result.wakeOps = await closeWakeOpsWindow(fixture, box, opsBeforeWake, notes);
  // Preserve this restore's row before the independent warm observation.
  await recordRestoreProbe({
    fixture,
    box,
    result,
    kind: 'post-ladder-wake',
    treeBytes: ladderBytes,
    notes,
    notBefore: woke.startedAt,
  });

  if (!options.verifyOnly) {
    const warm = await startup('/create', 'warm attach', admittedAttachKinds('warm attach'));
    result.attachWarmMs = warm.ms;
    result.attachWarmKind = warm.attach.kind;
    result.attachWarmBootId = warm.state.state?.bootId ?? null;
  }

  recordFinalComplexityRestore(result, ladderBytes, complexityScope);
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
  // Matches the work directory on the MOUNTPOINT field; a substring match also hits a device
  // name or option containing `/workspace`, then takes whichever line comes first.
  const workdirMount = mountAt(mountText, '/workspace');
  const mountLine = workdirMount?.line ?? '';
  result.wakeMountLines = selectWakeMountLines(mountText);
  await recordServedEntries(fixture, box, result, notes);

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

  // The served workspace is an overlay of a writable upper over the layers the record names,
  // or a plain directory when the box could only extract.
  const writableLayer = async (path: string): Promise<void> => {
    const exists = await retryTransient('writable-layer read', async () =>
      await execInBox(fixture, box, `test -d ${path} && echo yes || echo no`),
    );

    verify('the writable layer exists', (exists.stdout ?? '').trim() === 'yes', `${path} -> ${(exists.stdout ?? '').trim()}`);
  };

  const lowerLayer = async (name: string, path: string): Promise<void> => {
    const lower = await retryTransient(`${name} read`, async () =>
      await execInBox(
        fixture,
        box,
        `test -d ${path} && grep -qs " ${path} " /proc/mounts && echo yes || echo no`,
      ),
    );

    verify(
      name,
      (lower.stdout ?? '').trim() === 'yes',
      `${path} mounted -> ${(lower.stdout ?? '').trim()}`,
    );
  };

  if (mode === 'chain') {
    verify(
      '/workspace is really a overlay mount',
      workdirMount?.fstype.includes('overlay') === true,
      mountLine.length > 0 ? mountLine : '(no mount line)',
    );
    await writableLayer(CHAIN_UPPER_DIR);
    await lowerLayer('the base layer is present and mounted at its lower path', CHAIN_LOWER_BASE_DIR);
    // A chain freshly collapsed onto a new base (`shouldRebase`) names no delta and has no
    // `delta.sqsh`; check only the objects the record names.
    const chain = afterWake.state?.chain;

    const expectations = chainArchiveExpectations(
      chain?.base?.id,
      chain?.delta?.id,
      afterWake.storePrefix ?? '',
    );

    if (expectations.length === 0) {
      verify('the record names a generation to check the store against', false, '(no chain generation recorded)');
    }

    for (const expectation of expectations) await archive(expectation);
  } else {
    // The chain in EXTRACTION mode, which is the only other shape this box
    // can serve.
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

  // Reads the restore window's incidents here, beside the publish-time rows, so the probe
  // quotes each incident adjacent to the dump whose window filed it.
  result.wakeIncidents = await readIncidentReasons(fixture, box, notes);

  result.verifyPassed = result.verifyChecks.every((check) => check.pass);
  settle('the lifecycle proof');

  if (!result.verifyPassed) {
    notes.push('LIFECYCLE VERIFY FAILED: this arm measured a blank disk and is not ranked');
    notes.push(...result.verifyChecks.filter((check) => !check.pass).map((check) => `${check.name}: ${check.detail}`).slice(0, 6));
  }

  await runWorkloadPhases({ fixture, box, strategy, run: options, result, notes });

  result.generationAfterLadder = await chainGeneration(fixture, box);
  settle('the workload phases');

  // A verify-only probe stops here: later phases issue container work past the evidence
  // window and would file incident rows the dump comparison cannot place.
  if (options.verifyOnly) {
    notes.push(
      'probe scope: verify-only keeps the ladder, stop, wake and teardown; '
      + 'the decisive workloads, warm attach, tally and cells did not run',
    );
    settle('the probe evidence window');
    await releaseArm(fixture, box, result, notes);
    settle('the arm finished');

    return result;
  }

  // Runs before stop/wake: these workloads leave a large tree, and a wake measured across it
  // would time the tree, not the rows. Ticks keep their repetition so the spread stays visible.
  if (options.decisive) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const spec of DECISIVE_WORKLOADS) {
        log(`decisive ${spec.id}, repetition ${repetition} of ${options.repetitions}`);

        try {
          // A timed-out container operation can stop the spot container and lose the harness;
          // reinstalling before each workload also probes attach/replay for the new generation.
          await installHarness(fixture, box);

          const run = await runDecisive({
            fixture,
            box,
            arm: strategy,
            spec,
            seed: options.seed,
            repetition,
            record: { segments: result.decisiveSegments ??= [], settled: () => settle('a decisive segment') },
          });

          result.decisiveTicks.push(...run.ticks);
          // A later repetition re-runs the same segments over the tree the previous one left, so the
          // maximum, not the last reading, is the size the ticks ran against.
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


  log('ops accounting and teardown');
  await call({ fixture, method: 'POST', path: `/ops/flush?box=${box}`, schema: AckReplySchema });
  result.ops = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });

  await runWitnessCellsPhase({ fixture, box, strategy, result, notes });
  settle('the witness cells');

  // After the witness cells and before the teardown: see `runFaultCutPhase` for why
  // nothing after it may measure.
  const faultCut = await runFaultCutPhase(fixture, box, result);
  result.cut = faultCut.cut;
  notes.push(...faultCut.notes);
  settle('the fault-cut cell');

  // Runs after the fault cut, before teardown: storage-only and past every priced window.
  const securityCells = await runSecurityCellsPhase(fixture, box, strategy);
  result.security = securityCells.observation;
  notes.push(...securityCells.notes);
  settle('the security cells');
  // THE DESTROY-COLD RESTORE, after every priced cell and before the
  // teardown — see `runDestroyColdPhase` for why it can only append a row.
  await runDestroyColdPhase({ fixture, box, result, notes, startup, settle });

  // A cleanup failure is not a measurement failure; the arm still returns what it measured.
  await releaseArm(fixture, box, result, notes);

  await runLiveC3Phase({ fixture, box, options, result, notes, settle });

  settle('the arm finished');

  return result;
}

/** Runs after the arm's first release: the box is prepared again for the isolated one-file C3;
 *  its cleanup replaces the teardown row, and a C3 refusal is a note, never an arm failure. */
interface LiveC3Phase {
  readonly fixture: Fixture;
  readonly box: string;
  readonly options: Options;
  readonly result: ArmResult;
  readonly notes: string[];
  readonly settle: (what: string) => void;
}

async function runLiveC3Phase(
  { fixture, box, options, result, notes, settle }: LiveC3Phase,
): Promise<void> {
  if (!options.decisive) return;

  const preparation = result.teardown;
  result.c3 = await measureLiveC3({
    fixture,
    box,
    runId: `${FIXTURE_BASE}-${options.runId}`,
    preparation,
    observe: (row) => { result.c3 = row; settle('the live C3 evidence'); },
  });
  result.teardown = null;
  await releaseArm(fixture, box, result, notes);
  result.c3.cleanup = result.teardown;
  const c3 = evaluateLiveC3(result.c3);
  result.c3.correctness = c3.correctness;
  process.stdout.write(`${JSON.stringify(result.c3)}\n${JSON.stringify({ event: 'matched.chain.complete', case: result.c3.case, runId: result.c3.runId, correctness: c3.correctness })}\n`);

  if (!c3.admitted) notes.push(`live C3 refused: ${c3.errors.join('; ')}`);
}

/** Runs past every priced window and only appends a probe row (absent on failure); never fails
 *  a settled arm. `treeBytes` is the largest recorded size, a lower bound for unmeasured writes. */
interface DestroyColdPhase {
  readonly fixture: Fixture;
  readonly box: string;
  readonly result: ArmResult;
  readonly notes: string[];
  readonly startup: (
    path: '/create' | '/wake',
    operation: string,
    allowedKinds: readonly string[],
  ) => Promise<StartupCompletion>;
  readonly settle: (what: string) => void;
}

async function runDestroyColdPhase(
  { fixture, box, result, notes, startup, settle }: DestroyColdPhase,
): Promise<void> {
  try {
    await destroyBox(fixture, box);
    const rewokeCold = await startup('/wake', 'destroy-cold restore', admittedAttachKinds('wake'));
    const knownSizes = Object.values(result.treeBytes).filter((n) => Number.isSafeInteger(n));
    const coldTreeBytes = knownSizes.length > 0 ? Math.max(...knownSizes) : null;
    await recordRestoreProbe({
      fixture,
      box,
      result,
      kind: 'destroy-cold-restore',
      treeBytes: coldTreeBytes,
      notes,
      notBefore: rewokeCold.startedAt,
    });
    notes.push(
      `destroy-cold restore woke ${rewokeCold.attach.kind}; treeBytes is the largest size the run recorded, `
      + 'a lower bound past the witness and cut cells that wrote outside the measured window',
    );
    settle('the destroy-cold restore');
  } catch (error) {
    const words = describeThrown({ cause: error }).slice(0, 240);
    notes.push(`destroy-cold restore did not answer: ${words}`);
    (result.restoreProbes ??= []).push({
      kind: 'destroy-cold-restore', treeBytes: null, wallMs: null, probeAt: null, outcome: `error: ${words}`,
    });
    settle('a refused destroy-cold restore');
  }
}

const PublicationWindowReplySchema = v.looseObject({
  ok: v.optional(v.boolean()), error: v.optional(v.string()), window: v.optional(PublicationWindowSchema),
});

interface ReasonedStartup {
  readonly edge: keyof StartupIncidents;
  readonly path: '/create' | '/wake';
  readonly operation: string;
  readonly allowedKinds: readonly string[];
  readonly observations: StartupObservation[];
}

export interface LiveC3Measurement {
  readonly fixture: Fixture;
  readonly box: string;
  readonly runId: string;
  readonly preparation: TeardownReply | null;
  readonly observe?: (row: LiveC3Observation) => void;
  readonly startupBounds?: StartupBounds;
}

export async function measureLiveC3(
  { fixture, box, runId, preparation, observe = () => {}, startupBounds = {} }: LiveC3Measurement,
): Promise<LiveC3Observation> {
  const round: LiveC3Observation['rounds'][number] = {
    round: 1, checkpoint: null, published: { transport: { puts: null, putUploadBytes: null } },
    accounting: { beforeOps: null, afterOps: null, window: null },
  };

  const initialObservations: StartupObservation[] = [];
  const restorationObservations: StartupObservation[] = [];
  const incidents: StartupIncidents = { initial: null, restoration: null };

  const row: LiveC3Observation = {
    event: 'matched.chain.C3.observations', case: 'snapshot-chain/C3', runId, box,
    identity: fixture.identity ?? null, workload: C3_WORKLOAD, prefix: null, preparation: { cleanup: preparation, destroy: null },
    initial: null, initialObservations, baselineCommand: null, baselineCheckpoint: null,
    overwriteCommand: null, rounds: [round], beforeDestroy: null, destroyReceipt: null,
    restoration: null, restorationObservations, incidents, restoreProbe: null, file: null,
    correctness: 'unmeasured', errors: [], cleanup: null,
  };

  /** Each startup edge reads the incident ledger whether it attached or was refused,
   *  so a refusal carries reason strings, not just incident totals. */
  const startupWithReasons = async (
    { edge, path, operation, allowedKinds, observations }: ReasonedStartup,
  ): Promise<StartupCompletion> => {
    try {
      return await startupOperation({
        fixture,
        box,
        path,
        operation,
        allowedKinds,
        bounds: { ...startupBounds, observations },
      });
    } catch (cause) {
      const reasons = await readIncidentReasons(fixture, box, row.errors);
      incidents[edge] = reasons ?? null;

      throw new Error(`${describeThrown({ cause })}; incident reasons: ${describeIncidentReasons(reasons)}`, { cause });
    } finally {
      incidents[edge] ??= (await readIncidentReasons(fixture, box, row.errors)) ?? null;
    }
  };

  const harness = `/tmp/kinu-c3-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`;
  const token = `${runId}-C3-${crypto.randomUUID()}`;
  let windowAttempted = false;
  let windowClosed = false;

  const closeWindow = async (): Promise<void> => {
    try {
      const closed = await call({
        fixture,
        method: 'POST',
        path: `/publication-window/close?box=${box}&token=${encodeURIComponent(token)}`,
        schema: PublicationWindowReplySchema,
      });

      if (closed.ok !== true || closed.window?.token !== token || closed.window.closedAt === null) {
        throw new Error(`the C3 PUT window did not close: ${closed.error ?? 'no matching receipt'}`);
      }

      round.accounting.window = closed.window;
      windowClosed = true;
    } catch (error) {
      row.errors.push(`publication window: ${describeThrown({ cause: error })}`);
    }
  };

  observe(row);

  try {
    if (row.identity === null) throw new Error('live C3 requires the deployed build identity');
    row.preparation.destroy = await destroyBox(fixture, box);
    row.initial = await startupWithReasons({
      edge: 'initial',
      path: '/create',
      operation: 'C3 empty baseline',
      allowedKinds: ['empty'],
      observations: initialObservations,
    });
    row.prefix = row.initial.state.storePrefix ?? null;

    if (row.prefix === null) throw new Error('the C3 box did not report its store prefix');
    await installWitnessHarness(fixture, box, harness);
    row.baselineCommand = await execInBox(fixture, box, `bun ${harness}/witness-files.ts baseline /workspace`);

    if (row.baselineCommand.ok !== true || row.baselineCommand.exitCode !== 0) throw new Error('the C3 baseline writer did not complete');
    row.baselineCheckpoint = await checkpointOperation({ fixture, box, kind: 'quiesce', what: 'C3 baseline' });

    if (row.baselineCheckpoint.ok !== true || row.baselineCheckpoint.outcome?.kind !== 'committed') throw new Error('the C3 baseline checkpoint did not commit');
    observe(row);

    round.accounting.beforeOps = await call({
      fixture,
      method: 'GET',
      path: `/ops?box=${box}`,
      schema: OpTallySchema,
    });
    windowAttempted = true;

    const opened = await call({
      fixture,
      method: 'POST',
      path: `/publication-window/open?box=${box}&token=${encodeURIComponent(token)}`,
      schema: PublicationWindowReplySchema,
    });

    round.accounting.window = opened.window ?? null;

    if (opened.ok !== true || opened.window?.token !== token || opened.window.prefix !== row.prefix || opened.window.closedAt !== null) {
      throw new Error(`the C3 PUT window did not open: ${opened.error ?? 'no matching receipt'}`);
    }

    row.overwriteCommand = await execInBox(fixture, box, `bun ${harness}/witness-files.ts overwrite /workspace`);

    if (row.overwriteCommand.ok !== true || row.overwriteCommand.exitCode !== 0) throw new Error('the C3 overwrite writer did not complete');

    try {
      round.checkpoint = await checkpointOperation({ fixture, box, kind: 'quiesce', what: 'C3 overwrite' });
    } catch (error) {
      row.errors.push(`overwrite checkpoint: ${describeThrown({ cause: error })}`);
    }

    await closeWindow();
    round.accounting.afterOps = await call({ fixture, method: 'GET', path: `/ops?box=${box}`, schema: OpTallySchema });
    const totals = publicationTotals(round.accounting.window);
    round.published.transport = { puts: totals.objectsPut, putUploadBytes: totals.bytesPut };
    observe(row);

    if (round.checkpoint?.ok !== true || round.checkpoint.outcome?.kind !== 'committed') throw new Error('the C3 overwrite checkpoint did not commit');

    row.beforeDestroy = await boxState(fixture, box);
    row.destroyReceipt = await destroyBox(fixture, box);
    row.restoration = await startupWithReasons({
      edge: 'restoration',
      path: '/wake',
      operation: 'C3 cold restore',
      allowedKinds: ['attached'],
      observations: restorationObservations,
    });
    row.restoreProbe = await readRestoreProbe({
      fixture,
      box,
      kind: 'destroy-cold-restore',
      treeBytes: C3_WORKLOAD.baselineBytes,
      notes: row.errors,
      notBefore: row.restoration.startedAt,
    });
    row.blockReads = await readBlockAttachMetrics(fixture, box);
    observe(row);
    // Observer code is outside the one-file workload, and installed only after the cold clock ends.
    await installWitnessHarness(fixture, box, harness);
    row.file = await readBoxFile(fixture, box, `/workspace/${C3_WORKLOAD.path}`, harness);
  } catch (error) {
    row.errors.push(describeThrown({ cause: error }));
  } finally {
    if (windowAttempted && !windowClosed) await closeWindow();
    const totals = publicationTotals(round.accounting.window);
    round.published.transport = { puts: totals.objectsPut, putUploadBytes: totals.bytesPut };
    row.correctness = evaluateLiveC3(row).correctness;
    observe(row);
  }

  return row;
}

/** Capture before an observer reads the changed file. A missing counter is
 * unmeasured, never a zero inferred from absence. */
export async function readBlockAttachMetrics(fixture: Fixture, box: string): Promise<BlockAttachMetrics> {
  const reply = await execInBox(fixture, box, 'cat /var/tmp/devbox/block-lower-stats.json');

  if (reply.ok !== true || reply.exitCode !== 0 || reply.stdout === undefined) throw new Error(`block-read counters unobserved: ${reply.error ?? reply.stderr}`);

  return v.parse(BlockAttachMetricsSchema, JSON.parse(reply.stdout));
}

/** Short on purpose: the box is handed back so the next arm gets an instance, and a stop
 *  that cannot settle must not spend the run's remaining time proving it. */
const FAILED_ARM_RELEASE_DEADLINE_MS = 120_000;

/** Records the refusal both as a note and as a failed verify row: ranking, `armCompletedTheCell`
 *  and G1 derive from `verifyPassed`, so a false flag needs a failing check to point at. */
export function refuseFailedArm(arm: ArmResult, reason: string): ArmResult {
  arm.notes.push(reason);
  arm.verifyChecks.push({ name: 'the arm completed every measured step', pass: false, detail: reason });
  arm.verifyPassed = false;

  return arm;
}

// Each arm writes its row to disk the moment it settles; final assembly reads those files
// so a wedged sibling or killed driver cannot lose settled measurements.

/** Keyed by run id, not the `--out` basename: runs sharing an `--out` path never collide,
 *  and one run's directory holds exactly the arms that run requested. */
export function armArtifactDir(repoRoot: string, runId: string): string {
  return join(repoRoot, 'bench-artifacts', runId);
}

export function armArtifactPath(repoRoot: string, runId: string, arm: Strategy): string {
  return join(armArtifactDir(repoRoot, runId), `${arm}.json`);
}

/** The log tail is all an arm that never settled can offer; `settledAt` dates the write so
 *  a reader can tell whether this file or the run-level artifact is the one missing. */
export interface ArmArtifact<Row = ArmResult> {
  readonly schema: 'devbox-arm-artifact/1';
  readonly arm: Strategy;
  readonly runId: string;
  readonly settledAt: string;
  readonly logTail: readonly string[];
  readonly row: Row;
}

const ArmRowSchema = v.looseObject({});

const ArmArtifactSchema: v.GenericSchema<ArmArtifact> = v.looseObject({
  schema: v.literal('devbox-arm-artifact/1'),
  arm: v.picklist(STRATEGIES),
  runId: v.string(),
  settledAt: v.string(),
  logTail: v.array(v.string()),
  row: v.custom<ArmResult>((value) => v.safeParse(ArmRowSchema, value).success),
});

/** tmp + rename: the reader has lost its sibling and must see the file whole or not at all.
 *  Called at every phase boundary so a kill costs only the phase in flight; refusals write too. */
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

/** `error` is set only when the file exists but is unusable; an absent file is its own verdict
 *  (externally-aborted), so a wedged arm cannot hide behind a missing one. */
export interface ReadArmArtifact {
  readonly artifact: ArmArtifact | null;
  readonly error: string | null;
}

/** Assembly reads settled files, not in-memory rows: a wedged arm's siblings settled on disk.
 *  An unusable file is reported as an error, never read as "never measured". */
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

  return { artifact: parsed.output, error: null };
}

/** `reason` describes the run, not the arm; the arm's own answer stays in its durable file.
 *  The log tail becomes `log:` notes, the shape the report prints for a failed arm. */
export function externallyAbortedArm(arm: Strategy, box: string, reason: string): ArmResult {
  // The reason stays out of `notes`: `refuseFailedArm` appends it as the closing note and
  // the failed lifecycle check, so adding it here prints it twice.
  const notes = armLogTail(arm).map((line) => `log: ${line}`);

  return refuseFailedArm(unmeasuredArm(arm, box, notes), `externally-aborted: ${reason}`);
}

/** A failed arm keeps its partial rows and releases its box: the class has one container
 *  instance, so an unreleased box makes the next arm's create fail `Maximum number of instances`. */
export async function runArm(
  fixture: Fixture,
  strategy: Strategy,
  options: Options,
  noteLiveBox: (box: string) => void,
): Promise<ArmResult> {
  let partial: ArmResult | null = null;

  try {
    return await measureArm({ fixture, strategy, options, noteLiveBox, observe: (row) => { partial = row; } });
  } catch (error) {
    const measured = partial ?? unmeasuredArm(strategy, `ab-${strategy}-${options.runId}`, []);
    const reason = `arm failed mid-measurement: ${describeThrown({ cause: error })}`;
    log(reason);

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

    // The refusal is the arm's settled answer and is persisted like any other, so a killed run
    // cannot lose the reason the arm died.
    const refused = refuseFailedArm(measured, reason);

    try {
      writeArmArtifact(REPO_ROOT, options.runId, strategy, refused);
    } catch (writeError) {
      log(`the durable arm artifact could not be written after the failure: ${describeThrown({ cause: writeError })}`);
    }

    return refused;
  }
}

export type ArmLane = (strategy: Strategy) => Promise<ArmResult>;

/** Arms share only this process's I/O, never a container; `runWrangler` blocks the loop, so
 *  no deploy/delete may run here. A throwing lane is refused alone so `Promise.all` keeps siblings. */
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

        // A lane that never reached `measureArm` has no `settle`, so its artifact is written here;
        // a missing artifact reads as an external abort, and a lane failure is this run's REFUSED answer.
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

/** Raw repetitions, not a summary: the report takes a central value and G9 the dispersion,
 *  both from this one collection so the gate never judges a number the table did not show. */
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

/** Derived from the measured runs, not hardcoded: the repetition loop must re-run the phase
 *  that actually measures the deciding metric, or G9 silently gets one repetition. */
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

/** Artifact header printed above the tables; `INCOMPLETE` marks a run that stopped early
 *  so it does not read as whole. */
export interface RunMeta {
  date: string;
  /** The run name every arm's resources derive from; `worker` and `bucket` are per-arm,
   *  so neither identifies the run on its own. */
  run: string;
  worker: string;
  bucket: string;
  image: string;
  seed: string;
  'loop budget ms': string;
  /** Repetitions the run asked for per deciding cell; the per-arm counts are read against it. */
  'deciding repetitions': string;
  'frozen controls provenance'?: string;
  'publication rendezvous'?: string;
  'publication accounting'?: string;
  'witness profile'?: string;
  'live C3'?: string;
  INCOMPLETE?: string;
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

export function renderArmLifecycleRow(arm: ArmResult): string {
  const failing = arm.verifyChecks.filter((check) => !check.pass)
    .map((check) => `\`${check.name}\``).join(', ');

  return `| \`${arm.strategy}\` | ${arm.verifyPassed ? 'PASSED' : '**FAILED**'} | ${failing === '' ? '—' : failing} |`;
}

/** `date` comes from the run's own meta, never from the day the cell was written. */
function renderComplexitySection(arms: readonly ArmResult[], date: string): string {
  const out: string[] = [];
  out.push('#### Restore and backup time versus tree size');
  out.push('');
  out.push(
    'One fixed 64 KiB backup plus one stop then wake at each ladder rung’s cumulative tree size. '
    + 'The last rung’s restore is the post-ladder wake itself, so no container work is duplicated. '
    + `Measured ${date}.`,
  );
  out.push('');
  out.push('| arm | tree bytes | 64 KiB backup (ms) | restore (ms) | restore remote ops | restore payload bytes | outcome |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');

  for (const arm of arms) {
    const complexity = decodeComplexityRows(arm.complexity);

    for (const treeBytes of COMPLEXITY_TREE_BYTES) {
      const backup = complexity.find((row) => row.treeBytes === treeBytes && row.kind === 'backup-64k');
      const restore = complexity.find((row) => row.treeBytes === treeBytes && row.kind === 'restore');

      if (backup === undefined && restore === undefined) {
        const reason = `the arm recorded no tree-size row at ${num(treeBytes, 0)} bytes`;
        out.push(`| \`${arm.strategy}\` | ${num(treeBytes, 0)} | NOT MEASURED: ${reason} | — | — | — | NOT MEASURED |`);
        continue;
      }

      const bill = complexityRestoreBill(restore?.wakeOps);
      const outcome = [backup?.outcome, restore?.outcome].filter((part) => part !== undefined).join('; ');
      out.push(
        `| \`${arm.strategy}\` | ${num(treeBytes, 0)} | ${num(backup?.ms ?? null, 0)} | ${num(restore?.ms ?? null, 0)} `
        + `| ${num(bill.remoteOps, 0)} | ${num(bill.payloadBytes, 0)} | ${outcome} |`,
      );
    }
  }

  return out.join('\n');
}

/** A rebase writes a fresh base uuid and drops the delta, so comparing `baseId` across the
 *  two generations detects it. */
function rebaseWords(before: ChainGeneration | null, after: ChainGeneration | null): string {
  if (before === null || after === null) return 'not read';

  if (before.baseId === null && after.baseId === null) return 'no base generation';

  if (before.baseId === after.baseId) return 'no';

  return `YES (${String(before.baseId).slice(0, 8)} -> ${String(after.baseId).slice(0, 8)})`;
}

export interface Report {
  readonly arms: readonly ArmResult[];
  readonly meta: RunMeta;
  readonly admission: AdmissionVerdict;
  readonly frozenControls?: readonly FrozenControl[];
  readonly renderControlContext?: boolean;
}

export function render(
  { arms, meta, admission, frozenControls = [], renderControlContext = false }: Report,
): string {
  const out: string[] = [];
  const compared = arms.map((arm) => `\`${arm.strategy}\``).join(', ');
  out.push(`### Devbox storage strategy: ${compared}`);
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

  for (const arm of arms) out.push(renderArmLifecycleRow(arm));
  out.push('');
  out.push(
    'An ordinary arm whose lifecycle proof fails measured the container\'s own blank disk. Its rows '
    + 'are recorded for diagnosis and are NOT ranked. Probe rows are different: PRECONDITION FAILED '
    + 'means no probe ran; PARTIAL means some evidence was archived before the finding. Neither is an arm verdict.',
  );
  out.push('');

  const ticks = arms.flatMap((arm) => arm.decisiveTicks);

  if (ticks.length > 0) {
    out.push('#### The decisive experiment');
    out.push('');
    out.push(
      'Three workloads, chosen because each makes PENDING CHANGE and CHANGED SET diverge, '
      + 'with a checkpoint between every segment. The measurement is the TICK; the workload only '
      + 'exists to put a known amount of pending change in front of one.',
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
      + 'ticks inside the decisive window: `runDecisive` takes kind `\'tick\'` and no other '
      + 'checkpoint runs before the tally, so there is no inside-the-window quiesce count to '
      + 'render — only the ladder count below, which is how a reader checks the half that varies.',
    );
    out.push('');
    out.push('| arm | quiesces before the window | rebased in the ladder |');
    out.push('| --- | --- | --- |');

    for (const arm of arms) {
      const before = arm.generationBeforeLadder;
      const after = arm.generationAfterLadder;

      const rebased = rebaseWords(before, after);

      out.push(
        `| \`${arm.strategy}\` | ${arm.quiescesBeforeDecisive} | ${rebased} |`,
      );
    }

    out.push('');
    out.push(
      'The ladder\'s quiesces DO precede the window, so a rebase there changes the base the '
      + 'decisive ticks are measured against. That is a state difference rather than a tick-time '
      + 'confound, and the column above says whether it happened instead of leaving it as a '
      + 'possibility: a rebase writes a fresh base id and drops the delta, so the generation '
      + 'before and after the ladder answers it outright. The ladder\'s FIRST quiesce cannot '
      + 'rebase, because it creates the base and there is no delta to outgrow it.',
    );
    out.push('');
    out.push('| arm | workload | ticks | Σ tick ms | p50 | p95 | class A | class B | MiB moved |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

    for (const arm of arms) {
      for (const spec of DECISIVE_WORKLOADS) {
        const totals = totalsFor(arm.decisiveTicks, spec.id);

        if (totals.ticks === 0) continue;
        const blind = opsAreBlind(arm.decisiveTicks, spec.id);
        const opsCell = blind ? 'unmeasured' : String(totals.classA);
        const bCell = blind ? 'unmeasured' : String(totals.classB);

        const moved = (totals.bytesPut / 1024 / 1024).toFixed(1);
        const unanswered = totals.unanswerable > 0 ? ` (${totals.unanswerable} tick(s) could not answer)` : '';
        const movedCell = totals.movedReported ? `${moved}${unanswered}` : 'not measurable';

        out.push(
          `| \`${arm.strategy}\` | ${spec.id} | ${totals.ticks} | ${Math.round(totals.sumWallMs)} `
          + `| ${Math.round(totals.p50WallMs)} | ${Math.round(totals.p95WallMs)} | ${opsCell} `
          + `| ${bCell} | ${movedCell} |`,
        );
      }
    }

    out.push('');

    const refused = arms.filter((arm) => !arm.verifyPassed).map((arm) => arm.strategy);

    if (refused.length > 0) {
      out.push(
        `REFUSED FROM RANKING: ${refused.map((id) => `\`${id}\``).join(', ')} failed the lifecycle proof, so `
        + 'their ticks measured a container\'s own blank disk and are excluded from the ranking '
        + 'below. Their rows remain in the table above for diagnosis.',
      );
      out.push('');
    }

    if (frozenControls.length > 0) {
      out.push(
        'Only the current arm\'s rows may be ranked. The frozen controls above remain visible '
        + 'as historical context and never enter a rank or a recommendation.',
      );
      out.push('');
    }

    out.push('#### The sqlite arm, which decides a separate question');
    out.push('');
    out.push(
      'A 64 MiB database rewritten in place through real SQLite. This decides whether '
      + 'extent-level in-place tracking is ever worth building, NOT which strategy is default. '
      + 'File-granularity re-shipping the whole database per tick is recorded here as a '
      + 'measurement, never treated as disqualifying.',
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
  out.push(renderComplexitySection(arms, meta.date));
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
  // G9 scores the dispersion of exactly these repetitions; medians alone cannot show
  // a scored cell from a censored one.
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

/** Rank the frozen scope. A challenger must still clear the 10x/3x displacement bar. */
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

  const witnessCell = (witnesses: readonly string[]): string =>
    witnesses.length === 0 ? 'none preregistered' : witnesses.map((name) => `\`${name}\``).join(', ');

  const scored = proven.map((arm) => {
    const totals = RULE_WORKLOADS.map((workload) => totalsFor(arm.decisiveTicks, workload));

    return {
      arm,
      unmeasured: RULE_WORKLOADS.filter((_, index) => totals[index].ticks === 0),
      decisiveMs: totals.reduce((sum, row) => sum + row.sumWallMs, 0),
      statMs: metricSummary(arm, DECIDING_METRIC)?.p50 ?? null,
      witnesses: arm.witnessChecks.filter((witness) => witness.observed).map((witness) => witness.name),
    };
  });

  const rankable = scored
    .filter((row) => row.unmeasured.length === 0)
    .sort((a, b) => a.decisiveMs - b.decisiveMs);

  const out: string[] = [
    `RANKED ON THE DECISIVE WORKLOADS (${RULE_WORKLOADS.join(' + ')}), over every arm that completed the `
    + 'lifecycle proof.',
    '',
    '| rank | arm | Σ decisive tick ms | `' + DECIDING_METRIC + '` p50 (ms) | observed defects |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const [index, row] of rankable.entries()) {
    const name = `\`${row.arm.strategy}\``;

    out.push(
      `| ${index + 1} | ${name} | ${Math.round(row.decisiveMs)} `
      + `| ${row.statMs === null ? '—' : row.statMs.toFixed(2)} | ${witnessCell(row.witnesses)} |`,
    );
  }

  for (const row of scored.filter((candidate) => candidate.unmeasured.length > 0)) {
    out.push(
      `| — | \`${row.arm.strategy}\` | unranked: no ticks on ${row.unmeasured.join(', ')} `
      + `| ${row.statMs === null ? '—' : row.statMs.toFixed(2)} | ${witnessCell(row.witnesses)} |`,
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

  out.push(
    `\`${best.arm.strategy}\` IS THE SHIPPED DEFAULT, and this run measured it end to end: the decisive `
    + `tick time above is the number a later change to it is judged against.${wakeNote(best.arm)}`,
  );

  if (best.witnesses.length > 0) {
    out.push('');
    out.push(
      `\`${best.arm.strategy}\` carries ${best.witnesses.length} preregistered defect(s) this run OBSERVED: `
      + `${witnessCell(best.witnesses)}. Those are a property of adopting it, not a reason it was kept out of `
      + 'the ranking; the witness rows above say what each one did.',
    );
  }

  return out.join('\n');
}

/** G2 keeps every declared witness. */
export function devboxArmEvidence(
  arm: Pick<
    ArmResult,
    'strategy' | 'verifyPassed' | 'verifyChecks' | 'phases' | 'checkpoints' | 'decisiveTicks' | 'witnessChecks'
  >,
): ArmEvidence {
  return {
    arm: arm.strategy,
    kind: 'candidate',
    // The run measures only the shipped strategy, so it is always eligible to be recommended:
    // there is nothing else it could rank behind.
    rankEligible: true,
    expectedRedChecks: [...PREREGISTERED_WITNESSES[arm.strategy]],
    // Only witnesses a cell observed against the deployed arm; an unobserved one is left out
    // on purpose so `witnessProblems` refuses the run.
    observedRedChecks: arm.witnessChecks.filter((witness) => witness.observed).map((witness) => witness.name),
    attachedVerified: arm.verifyPassed,
    semanticsPassed: arm.verifyPassed,
    failedChecks: arm.verifyChecks.filter((check) => !check.pass).map((check) => check.name),
    producedMeasurements: arm.phases.length > 0 || arm.checkpoints.length > 0 || arm.decisiveTicks.length > 0,
  };
}

/** Admission contract's cold-attach ceiling; distinct from the fixture's 300 s abandonment
 *  budget in `packages/devbox/bench/worker.ts`. A run that missed it cannot raise it. */
export const COLD_ATTACH_CEILING_MS = 25_000;

/** Its cells are the ones G6 must see completed; an empty declaration makes G6 vacuous. */
const DEVBOX_DECLARED_STAGES: readonly StageId[] = ['blank'];

/** Metadata latency over many small files; named once so the gate judges the same
 *  quantity the report prints and `recommend` ranks. */
export const DECIDING_METRIC = 'small-stat-1k';

/** Minimum repetitions before a deciding cell has a dispersion claim; `scoreCells` censors below
 *  it. Named so the refusal can report which arm produced how many. */
const MIN_DECIDING_REPETITIONS = 2;

/** Default `--decisive` repetitions equal the G9 floor and are derived from it: a default one
 *  short of the gate yields a run G9 refuses however well it measures. */
const DECISIVE_REPETITIONS = MIN_DECIDING_REPETITIONS;

/** Ladder rows one complete arm owes: a quiesce and a tick per change size. Derived from the
 *  ladder so a completeness check cannot assert a stale count when the ladder changes. */
export const EXPECTED_LADDER_ROWS = CHANGE_SIZES_KIB.length * 2;

/** The restore class each arm claims, preregistered before the run; a claim is not a result.
 *  `snapshot-chain` claims `bounded-k`: a restore replays base plus the deltas rebase bounds. */
const RESTORE_CLAIMS = {
  'snapshot-chain': 'bounded-k',
} as const satisfies Record<Strategy, RestoreClaim>;

/** G5: a row becomes a `RestoreWork` only when every field was observed; an unobserved field
 *  stays null and G5 refuses naming its source, since a filled zero would be vacuous. */

/** Null when a side lacks per-op calls or a count is non-integer, negative or runs backwards:
 *  a reset racing the window must not be priced as a cheap restore. */
export function diffOpTallies(before: OpTally | null, after: OpTally | null): OpTally | null {
  const start = before?.calls;
  const end = after?.calls;

  if (start === undefined || end === undefined) return null;
  const calls = diffCounts(start, end);

  if (calls === null) return null;
  const total = Object.values(calls).reduce((sum, count) => sum + count, 0);

  // A fixture without a byte tally answers no `bytes`; the window then carries none,
  // so bytes stay uncounted rather than zero.
  if (before?.bytes === undefined || after?.bytes === undefined) return { calls, total };
  const bytes = diffCounts(before.bytes, after.bytes);

  if (bytes === null) return null;

  return { calls, total, bytes };
}

function pricedOpWindow(before: OpTally, after: OpTally): OpTally | null {
  const window = diffOpTallies(before, after);

  if (window === null || before.classA === undefined || before.classB === undefined || before.classFree === undefined
    || after.classA === undefined || after.classB === undefined || after.classFree === undefined) return null;

  const classes = diffCounts(
    { classA: before.classA, classB: before.classB, classFree: before.classFree },
    { classA: after.classA, classB: after.classB, classFree: after.classFree },
  );

  if (classes === null) return null;
  const classA = classes.classA ?? 0;
  const classB = classes.classB ?? 0;
  const classFree = classes.classFree ?? 0;

  if (classA + classB + classFree !== window.total) return null;

  return { ...window, classA, classB, classFree };
}

function diffCounts(start: Record<string, number>, end: Record<string, number>): Record<string, number> | null {
  const grown: Record<string, number> = {};
  const names = [...Object.keys(start), ...Object.keys(end)].filter((name, index, all) => all.indexOf(name) === index);

  for (const name of names) {
    const from = start[name] ?? 0;
    const to = end[name] ?? 0;

    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || to < from) {
      return null;
    }

    if (to > from) grown[name] = to - from;
  }

  return grown;
}

export const RESTORE_FIELD_SOURCES = {
  serialRemoteOps: 'the flushed /ops window across the stop-to-wake restore; the chain probes and mounts one read after another, so its whole window is serial',
  totalRemoteOps: 'the flushed /ops window across the stop-to-wake restore, summed over operation names',
  metadataBytes: 'the bytes `get` served under a control key inside the wake window, from the fixture’s byte tally; the chain keeps its control record in Durable Object storage, so the store serves none',
  payloadBytes: 'the bytes `get` served under every other key inside the wake window, from the fixture’s byte tally',
  cpuSteps: 'the entries the restore materialized: the served tree’s entry count after the wake',
  mounts: 'the post-wake /proc/mounts lines at the arm’s own mount points',
  replayUnits: 'the delta layer mount lines the wake read',
} satisfies Record<keyof RestoreWork, string>;

export type WakeRestoreCounts = { readonly [field in keyof RestoreWork]: number | null };

const UNCOUNTED: WakeRestoreCounts = {
  serialRemoteOps: null, totalRemoteOps: null, metadataBytes: null, payloadBytes: null, cpuSteps: null, mounts: null, replayUnits: null,
};

export interface CountedRestore {
  readonly counts: WakeRestoreCounts;
  /** The promoted row, or null while any of the seven fields stays unobserved. */
  readonly work: RestoreWork | null;
  /** One sentence per unobserved field, naming the source that is missing. */
  readonly missing: readonly string[];
  readonly detail: string;
}

interface WakeRestoreArgs {
  readonly wakeKind: string;
  readonly wakeDetail: string;
  readonly wakeOps: OpTally | null;
  readonly wakeMountLines: readonly string[];
  readonly wakeServedEntries?: number | null;
}

/** Replay units: delta layers the wake re-applied over its base, counted from its mount lines.
 *  Null, with the missing source named, when the mount read was refused. */
function replayUnitsOf(
  args: WakeRestoreArgs,
  mounts: number | null,
  missing: string[],
): number | null {
  if (mounts !== null) {
    return args.wakeMountLines.filter((line) => (line.split(' ')[1] ?? '').startsWith(`${CHAIN_DELTA_LAYER_ROOT}/`)).length;
  }

  missing.push('replayUnits: the chain counts its delta layers from the mount lines the wake read, and that read is refused above');

  return null;
}

/** A chain wake materializes nothing and serves the tree through its mounts, so CPU STEPS
 *  is the served tree's entry count, read after the wake window closed. */
function cpuStepsOf(args: WakeRestoreArgs, missing: string[]): number | null {
  if (args.wakeKind === 'already-attached') return 0;

  if (args.wakeServedEntries !== undefined && args.wakeServedEntries !== null) return args.wakeServedEntries;
  missing.push('cpuSteps: the served entry count after the chain wake did not answer');

  return null;
}

/** Counts one arm's wake restore only from data the run retained; stays pure so the
 *  decision suite drives it green and red without a deployment. */
export function countedRestoreWork(args: WakeRestoreArgs): CountedRestore {
  const { wakeKind, wakeDetail, wakeOps, wakeMountLines } = args;

  if (wakeKind !== 'attached' && wakeKind !== 'already-attached') {
    return {
      counts: UNCOUNTED,
      work: null,
      missing: [
        `no counted restore: the wake answered "${wakeKind || 'nothing'}", so the restore never ran and none of the seven fields was observed`,
      ],
      detail: `wake kind "${wakeKind || 'none'}"`,
    };
  }

  const missing: string[] = [];
  const calls = wakeOps?.calls;
  let totalRemoteOps: number | null = null;

  if (calls === undefined) {
    missing.push(
      'totalRemoteOps: the wake-window /ops bracket never landed — the arm died before the window closed, or a reset raced it — so the restore has no operation bill',
    );
  } else {
    const total = Object.values(calls).reduce((sum, count) => sum + count, 0);

    if (Number.isSafeInteger(total)) totalRemoteOps = total;
    else {
      missing.push('totalRemoteOps: the wake-window tally holds a non-integer count, so its sum is not a bill');
    }
  }

  // The chain probes and mounts one read after another, so the whole window is serial:
  // the serial bill equals the total.
  let serialRemoteOps: number | null = null;

  if (totalRemoteOps === null) {
    missing.push('serialRemoteOps: unobservable without the operation bill it is a path through');
  } else {
    serialRemoteOps = totalRemoteOps;
  }

  // An attached box always holds at least one mount line at its own points, so an empty
  // match on an attached wake is a failed read, not a zero; an already-attached wake took none.
  let mounts: number | null = null;

  if (wakeKind === 'attached' && wakeMountLines.length > 0) mounts = wakeMountLines.length;
  else if (wakeKind === 'already-attached') mounts = 0;
  else {
    missing.push(
      'mounts: the post-wake mount read matched none of the arm’s points on an attached wake — either the restore took no mounts or the read failed, and the two are indistinguishable, so the count is refused',
    );
  }

  const replayUnits = replayUnitsOf(args, mounts, missing);
  // Bytes are what `get` served in the fixture's tally over the same window as the operations,
  // split by whether the key holds a control record.
  let metadataBytes: number | null = null;
  let payloadBytes: number | null = null;
  const bytes = wakeOps?.bytes;

  if (bytes !== undefined && calls !== undefined) {
    metadataBytes = bytes['metadata'] ?? 0;
    payloadBytes = bytes['payload'] ?? 0;
  } else {
    missing.push(
      'metadataBytes/payloadBytes: the wake-window /ops bracket carried no byte tally, so the bytes the restore moved are uncounted',
    );
  }

  const cpuSteps = cpuStepsOf(args, missing);
  const counts: WakeRestoreCounts = { serialRemoteOps, totalRemoteOps, metadataBytes, payloadBytes, cpuSteps, mounts, replayUnits };
  const work = restoreWorkFromCounts(counts);
  const window = totalRemoteOps === null ? 'no operation bill' : `${totalRemoteOps} windowed store call(s)`;
  const served = payloadBytes === null ? 'bytes uncounted' : `${payloadBytes + (metadataBytes ?? 0)} bytes served`;

  return {
    counts,
    work,
    missing,
    detail: `wake "${wakeDetail.slice(0, 120) || 'no detail'}" — ${window} — ${served} — ${wakeMountLines.length} mount line(s)`,
  };
}

/** All seven fields or none: a partial row would price its arm cheaper than the unseen restore,
 *  and a field that already has a value is never re-derived. */
export function restoreWorkFromCounts(
  counts: { readonly [field in keyof RestoreWork]: number | null },
): RestoreWork | null {
  const { serialRemoteOps, totalRemoteOps, metadataBytes, payloadBytes, cpuSteps, mounts, replayUnits } = counts;

  if (
    serialRemoteOps === null || totalRemoteOps === null || metadataBytes === null || payloadBytes === null
    || cpuSteps === null || mounts === null || replayUnits === null
  ) {
    return null;
  }

  return { serialRemoteOps, totalRemoteOps, metadataBytes, payloadBytes, cpuSteps, mounts, replayUnits };
}

export interface BoundVerdict {
  readonly verified: boolean;
  readonly reason: string;
}

/** The only evidence one wake carries is its mount lines: at most one base and one delta layer
 *  (the two-deep serve) verify the arm's claimed restore class. */
export function verifyRestoreBound(
  work: RestoreWork | null,
  wakeMountLines: readonly string[],
): BoundVerdict {
  if (work === null) return { verified: false, reason: 'no counted row to hold to any bound' };
  const baseLayers = wakeMountLines.filter((line) => (line.split(' ')[1] ?? '') === CHAIN_LOWER_BASE_DIR).length;
  const deltaLayers = wakeMountLines.filter((line) => (line.split(' ')[1] ?? '').startsWith(`${CHAIN_DELTA_LAYER_ROOT}/`)).length;

  if (baseLayers <= 1 && deltaLayers <= 1) {
    return {
      verified: true,
      reason: `this wake served at most one base and one delta layer (the at-most-two-deep serve ${baseLayers}+${deltaLayers})`,
    };
  }

  return {
    verified: false,
    reason: `this wake served ${baseLayers} base and ${deltaLayers} delta layers, past the at-most-two-deep serve the bounded-k claim rests on`,
  };
}

/** Restates the mount points the strategy declares; the decision suite checks them against it. */
const WAKE_MOUNT_POINTS: readonly string[] = [
  DEVBOX_WORK_DIR, CHAIN_STORE_MOUNT_DIR, CHAIN_LOWER_BASE_DIR, CHAIN_DELTA_LAYER_ROOT,
  `${dirname(CHAIN_UPPER_DIR)}/block-lower`,
];

/** The delta-layer root matches by prefix because one directory per served generation lives
 *  under it; every other point matches its mountpoint exactly. */
export function selectWakeMountLines(
  mountsText: string,
  extraPoints: readonly string[] = [],
): string[] {
  const points = [...WAKE_MOUNT_POINTS, ...extraPoints];
  const lines: string[] = [];

  for (const raw of mountsText.split('\n')) {
    const line = raw.trim();

    if (line.length === 0) continue;
    const point = line.split(' ')[1] ?? '';

    if (point.length === 0) continue;

    if (
      points.some((wanted) =>
        point === wanted || (wanted === CHAIN_DELTA_LAYER_ROOT && point.startsWith(`${wanted}/`))
      )
    ) {
      lines.push(line);
    }
  }

  return lines;
}

/** G3 fault cut: after a mid-publication kill a reader must see all-old or all-new, no absent
 *  refs, rollback, phantom root or lost ack; runs after witness cells so no measured column moves. */

/** `mixed` is a caught violation; `unjudged` is a shape the judges do not cover. Both refuse
 *  the run, `unjudged` saying the instrument, not the arm, fell short. */
export type CutVerdict = 'all-old' | 'all-new' | 'mixed' | 'unjudged';

export interface FaultCutObservation {
  readonly completed: boolean;
  readonly verdict: CutVerdict;
  /** References swept that resolved to absent objects. Null when the arm's
   *  references could not be swept. */
  readonly absentReferences: number | null;
  readonly rollbackOrPhantomRoot: boolean | null;
  /** Barriers this arm acked before the cut that the post-cut head lost. Null
   *  when the arm has no barrier concept to lose. */
  readonly barrierAckLoss: number | null;
  readonly readOnlySurface: string | null;
  readonly readOnlyRefusedWrites: boolean | null;
  readonly detail: string;
  readonly evidence?: CutEvidence;
}

export interface CutEvidence {
  acknowledgement: BarrierAcknowledgement | null;
  baselineBefore: FileObservation[];
  baselineAfter: FileObservation[];
  preState: StateReply | null;
  postState: StateReply | null;
  pre: ChainGeneration | null;
  preDeltaHead: HeadReply | null;
  heads: Array<{ key: string; reply: HeadReply | null; error: string | null }>;
  markerBefore: FileObservation | null;
  markerAfter: FileObservation | null;
  receipt: PublicationCut | null;
  victimOperation: OperationPollReply | null;
  wake: StartupCompletion | null;
  wakeObservations: StartupObservation[];
  facts: ChainCutFacts | null;
  mounts: ExecReply | null;
  readOnlyProbe: ExecReply | null;
  errors: string[];
}

function newCutEvidence(): CutEvidence {
  return {
    acknowledgement: null, baselineBefore: [], baselineAfter: [],
    preState: null, postState: null, pre: null, preDeltaHead: null, heads: [],
    markerBefore: null, markerAfter: null, receipt: null, victimOperation: null,
    wake: null, wakeObservations: [], facts: null, mounts: null, readOnlyProbe: null, errors: [],
  };
}

export interface CutJudgment {
  readonly verdict: CutVerdict;
  readonly rollback: boolean | null;
  readonly phantom: boolean | null;
  readonly detail: string;
}

/** Mirrors the `restored` words published in `packages/devbox/src/snapshot-chain.ts`;
 *  the cut judge tells a kept upper from a fresh serve by them, and the decision suite checks them. */
const CHAIN_SERVED_PATTERN = /^chain \S+ \d+B (.+)$/;


/** Null when the detail has a shape the judges do not cover: a fallback path or a rewording. */
export function chainServedWord(detail: string): string | null {
  return CHAIN_SERVED_PATTERN.exec(detail)?.[1] ?? null;
}

export interface ChainCutFacts {
  readonly recordPresent: boolean | null;
  readonly preDeltaId: string | null;
  readonly postDeltaId: string | null;
  readonly preBaseId: string | null;
  readonly preHasDelta: boolean;
  readonly preRev: number | null;
  readonly preDeltaEtag: string | null;
  readonly postBaseId: string | null;
  readonly postHasDelta: boolean;
  readonly postRev: number | null;
  readonly postDeltaEtag: string | null;
  readonly servedWord: string | null;
  readonly cutMarkerPresent: boolean | null;
  readonly baseExists: boolean | null;
  /** Null when the post-cut record names no delta. */
  readonly deltaExists: boolean | null;
  readonly unexpectedDelta?: boolean | null;
  readonly observersComplete?: boolean;
}

/** Any missing observation makes the cut `unjudged`; the verdict never guesses in either
 *  direction. */
function cutObservationsMissing(facts: ChainCutFacts): boolean {
  return facts.recordPresent === null || facts.observersComplete === false
    || facts.unexpectedDelta === null || facts.cutMarkerPresent === null || facts.baseExists === null
    || facts.preRev === null || facts.postRev === null
    || (facts.preHasDelta && (facts.preDeltaId === null || facts.preDeltaEtag === null))
    || (facts.postHasDelta && (facts.postDeltaId === null || facts.postDeltaEtag === null || facts.deltaExists === null));
}

/** Record `rev` only moves forward, delta objects are immutable, the cut wake serves a fresh
 *  upper: unchanged record + marker is unnamed bytes; moved record serving marker is new. */
export function judgeChainCut(facts: ChainCutFacts): CutJudgment {
  if (facts.recordPresent === false) {
    return { verdict: 'mixed', rollback: null, phantom: true, detail: 'the recovered box has no chain record' };
  }

  if (cutObservationsMissing(facts)) {
    return {
      verdict: 'unjudged', rollback: null, phantom: null,
      detail: 'required marker, archive or record observations are missing',
    };
  }

  const phantom = !facts.recordPresent;
  const rollback = facts.preRev !== null && facts.postRev !== null ? facts.postRev < facts.preRev : null;

  const changed = facts.preBaseId !== facts.postBaseId
    || facts.preHasDelta !== facts.postHasDelta
    || facts.preDeltaId !== facts.postDeltaId
    || (facts.preRev !== null && facts.postRev !== null && facts.preRev !== facts.postRev);

  const rewritten = facts.preHasDelta && facts.postHasDelta
    && facts.preDeltaId === facts.postDeltaId && facts.preDeltaEtag !== facts.postDeltaEtag;

  const movedWithoutRevision = changed && facts.preRev === facts.postRev;

  const servedKnown = facts.servedWord !== null && Object.values(CHAIN_SERVED_WORDS).some((word) => word === facts.servedWord);
  let verdict: CutVerdict;
  let note: string;

  if (!facts.recordPresent) {
    verdict = 'mixed';
    note = 'the cut wake serves a generation no record names';
  } else if (!servedKnown) {
    verdict = 'unjudged';
    note = `the cut wake answered in words this cell does not judge ("${facts.servedWord ?? 'no detail'}")`;
  } else if (!facts.baseExists || (facts.postHasDelta && facts.deltaExists === false)) {
    verdict = 'mixed';
    note = 'a named archive is missing or empty';
  } else if (rewritten || movedWithoutRevision) {
    verdict = 'mixed';
    note = rewritten ? 'an immutable delta key was rewritten' : 'the record changed without a CAS revision advance';
  } else if (!changed && facts.cutMarkerPresent) {
    verdict = 'mixed';
    note = 'the cut marker is served but the record never moved: bytes no commit names';
  } else if (!changed) {
    verdict = 'all-old';
    note = 'the record is identical to its pre-cut self and the cut marker never landed';
  } else if (facts.cutMarkerPresent && facts.baseExists && facts.deltaExists !== false) {
    verdict = 'all-new';
    note = 'the record moved and serves the cut marker over archives that exist';
  } else {
    verdict = 'mixed';
    note = 'the record moved but the cut marker is missing or a named archive is absent';
  }

  return {
    verdict,
    rollback,
    phantom,
    detail: `${note} (base ${facts.preBaseId ?? '?'}→${facts.postBaseId ?? '?'} rev ${
      facts.preRev ?? '?'}→${facts.postRev ?? '?'})`,
  };
}

/** A probe that could not run never reaches this judge (the cell records null), so `false`
 *  always means a write into the served layer succeeded, which refuses the run. */
export function judgeReadOnlyRefusal(exitCode: number, stderr: string): boolean {
  return exitCode !== 0 && /read-only file system/i.test(stderr);
}

/** One caught `true` holds a field; `false` needs every arm judged clean, an unjudged arm nulls it.
 *  An arm the cell never reached contributes nothing, and the block refuses. */
export function summarizePublication(
  rows: readonly { readonly cut: FaultCutObservation | null }[],
): PublicationEvidence {
  const cuts = rows.map((row) => row.cut);
  const completed = cuts.length > 0 && cuts.every((cut) => cut !== null && cut.completed);
  let allOldOrAllNew: boolean | null = null;

  if (completed) {
    allOldOrAllNew = cuts.every((cut) => cut?.verdict === 'all-old' || cut?.verdict === 'all-new');
  }

  let absentReferences: number | null = null;

  if (completed) {
    absentReferences = 0;

    for (const cut of cuts) {
      if (cut === null || cut.absentReferences === null) {
        absentReferences = null;
        break;
      }

      absentReferences += cut.absentReferences;
    }
  }

  let rollbackOrPhantomRoot: boolean | null = null;

  if (completed) {
    if (cuts.some((cut) => cut?.rollbackOrPhantomRoot === true)) rollbackOrPhantomRoot = true;
    else if (cuts.length > 0 && cuts.every((cut) => cut?.rollbackOrPhantomRoot === false)) {
      rollbackOrPhantomRoot = false;
    }
  }

  let ackLossTotal: number | null = null;

  if (completed) {
    let counted = false;
    let lost = 0;

    for (const cut of cuts) {
      const loss = cut?.barrierAckLoss;

      if (loss === null || loss === undefined) continue;
      counted = true;
      lost += loss;
    }

    ackLossTotal = counted ? lost : null;
  }

  let readOnlyDeclared = false;
  let readOnlyRefusedWrites: boolean | null = null;

  if (completed) {
    const surfaces: FaultCutObservation[] = [];

    for (const cut of cuts) {
      if (cut !== null && cut.readOnlySurface !== null) surfaces.push(cut);
    }

    readOnlyDeclared = surfaces.length > 0;

    if (surfaces.length > 0) {
      if (surfaces.every((cut) => cut.readOnlyRefusedWrites === true)) readOnlyRefusedWrites = true;
      else if (surfaces.some((cut) => cut.readOnlyRefusedWrites === false)) readOnlyRefusedWrites = false;
    }
  }

  return {
    readOnlyDeclared,
    readOnlyRefusedWrites,
    faultCutCompleted: completed,
    allOldOrAllNew,
    barrierAckLoss: ackLossTotal,
    absentReferences,
    rollbackOrPhantomRoot,
  };
}

/** Run provenance as digests: every field is a G0 requirement, and each identifies source,
 *  whether that tree ran, the serving Worker version, real run times, and the exact image. */
export interface RunIdentity {
  readonly commit: string;
  /** sha256 over the tracked-file diff against HEAD, or `clean`. A dirty tree
   *  is a different instrument from its commit and no revision can say so. */
  readonly dirtyDigest: string;
  readonly workerVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly image: string;
  /** OCI manifest digest for the exact sandbox image the generated config pins. */
  readonly imageSha256: string;
  /** Each deployed arm's container application rollout, waited out before
   *  its first cold attach, so no startup figure below contains it. */
  readonly rollouts: readonly ApplicationRollout[];
}

export interface SourceRevision {
  readonly commit: string;
  readonly dirtyDigest: string;
}

export function sourceRevision(): SourceRevision {
  const commit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();

  // `git diff --binary HEAD` omits untracked paths; hash those via `trackedFiles`, not a private
  // `git ls-files`, so the digest covers the same source set as the project's own gates.
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

function identityVersions(identity: RunIdentity) {
  return {
    source: identity.commit,
    'source-tree': identity.dirtyDigest,
    'worker-version': identity.workerVersion,
    'container-image': identity.image,
    'container-image-digest': identity.imageSha256,
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
      + `(${identity.imageSha256})`,
  };
}

/** G0 reasons for an identity that cannot attribute the run. Each field is
 *  required outright: a blank one is a refusal, never a default. */
function identityProblems(identity: RunIdentity): string[] {
  const problems: string[] = [];

  for (const [name, value] of Object.entries(identityVersions(identity))) {
    if (value.trim() === '') problems.push(`the run recorded no ${name}`);
  }

  const digests = { 'container-image-digest': identity.imageSha256 };

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
  /** Admission compares the measured arms against exactly this set, so a run that lost
   *  an arm or gained an unrequested one cannot look complete. */
  readonly requested: readonly Strategy[];
  /** Repetitions each deciding cell was asked for; an arm measuring fewer lost some, so a
   *  refusal can name the loss (`asked for 2, measured 1`). G9 covers the dispersion floor. */
  readonly repetitions: number;
  readonly meta: RunMeta;
  readonly identity: RunIdentity;
  readonly token: string;
  readonly cleanup: CleanupEvidence;
}

/** An arm missing any clause here is an incomplete cell, never a faster one. */
function armCompletedTheCell(arm: ArmResult): boolean {
  return arm.verifyPassed
    && arm.attachColdMs !== null && arm.attachColdMs <= COLD_ATTACH_CEILING_MS
    // `already-attached` counts as a wake: an instance that kept its mount measured the same
    // durable bytes a re-attach would; the boot-id equality below proves the generation.
    && (arm.wakeKind === 'attached' || arm.wakeKind === 'already-attached')
    // `already-attached` is the unchanged-generation observation; the boot-id equality proves it.
    // Requiring `attached` would force a warm attach to re-attach.
    && (arm.attachWarmKind === 'attached' || arm.attachWarmKind === 'already-attached')
    && arm.wakeBootId !== null
    && arm.wakeBootId === arm.attachWarmBootId
    && arm.checkpoints.length === EXPECTED_LADDER_ROWS
    && arm.ops !== null;
}

/** The record for the shared gates; empty `restore`, `declaredStages`, `cells` or `deciding`
 *  arrays make G5, G6 and G9 pass vacuously on a run that measured nothing durable. */
function devboxRunRecord(input: DevboxAdmissionInput): StorageRunRecord {
  const armOf = (strategy: Strategy): ArmResult | undefined =>
    input.arms.find((row) => row.strategy === strategy);

  // Accounting is complete over every requested arm or null: summing only arms that reported
  // prices the rest as free, and an under-reported cost is never re-derived.
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

  // One deciding row per arm per cell: pooling arms into one row makes the CV measure
  // the arm difference, which is the effect under test, not noise.
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
    // Unobserved fault-cut fields stay at their refusing defaults; G4 stays refusing because
    // this driver runs no security-cell instrumentation. The leak scan covers cut-cell notes.
    publication: summarizePublication(
      input.requested.map((strategy) => ({ cut: armOf(strategy)?.cut ?? null })),
    ),
    security: summarizeSecurity({
      rows: input.requested.map((strategy) => ({
        strategy,
        observation: armOf(strategy)?.security ?? null,
      })),
      token: input.token,
      driverText: JSON.stringify({ meta: input.meta, arms: input.arms }),
    }),
    // One row per requested arm; work is null where the boundary serves no counters.
    // G5 refuses on every null, so an unobserved source never passes.
    restore: input.requested.map((strategy): RestoreEvidence => {
      const arm = armOf(strategy);

      const counted = arm === undefined
        ? null
        : countedRestoreWork({
          wakeKind: arm.wakeKind,
          wakeDetail: arm.wakeDetail ?? '',
          wakeOps: arm.wakeOps ?? null,
          wakeMountLines: arm.wakeMountLines ?? [],
          wakeServedEntries: arm.wakeServedEntries ?? null,
        });

      const work = counted?.work ?? null;

      return {
        arm: strategy,
        expected: true,
        work,
        claim: RESTORE_CLAIMS[strategy],
        mechanicalBoundVerified: work === null
          ? false
          : verifyRestoreBound(work, arm?.wakeMountLines ?? []).verified,
      };
    }),
    declaredStages: [...DEVBOX_DECLARED_STAGES],
    cells: cells.map((cell): CellCompletion => ({ ...cell, completed: cellComplete })),
    confirmatoryPlan: null,
    accounting,
    cleanup: input.cleanup,
    deciding,
    decidingBudgetMs: Number(input.meta['loop budget ms']),
  };
}

/** Arm set must match the request exactly: restore class, cell completeness and repetition
 *  count are claims about the whole arm set; a missing or extra arm voids them. */
function armSetProblems(input: DevboxAdmissionInput): string[] {
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

  return armSet;
}

/** Devbox-specific gate requirements the shared record gates cannot know (per-arm tallies,
 *  cold-attach ceiling, exact arm set); a refusal names the missing evidence, not a gate id. */

export function decisiveCompletenessProblems(arm: ArmResult, repetitions: number): string[] {
  if (arm.decisiveRequested !== true) return [];
  const rows = new Map<string, DecisiveSegmentObservation[]>();

  for (const row of arm.decisiveSegments ?? []) {
    const key = `${row.workload}/${row.repetition}/${row.segment}`;
    const found = rows.get(key) ?? [];
    found.push(row);
    rows.set(key, found);
  }

  const problems: string[] = [];

  for (const spec of DECISIVE_WORKLOADS) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (let segment = 0; segment <= SEGMENTS_PER_WORKLOAD; segment++) {
        const key = `${spec.id}/${repetition}/${segment}`;
        const found = rows.get(key);
        const row = found?.[0];
        rows.delete(key);

        if (found?.length !== 1 || row?.priced !== true || row.command?.ok !== true
          || row.command.exitCode !== 0 || row.checkpoint?.outcome?.kind !== 'committed' || row.error !== null) {
          problems.push(`arm ${arm.strategy} decisive segment ${key} is incomplete: ${row?.error ?? 'no unique priced observation'}`);
        }
      }
    }
  }

  for (const key of rows.keys()) problems.push(`arm ${arm.strategy} recorded an unrequested decisive segment ${key}`);

  return problems;
}

function devboxRequirements(input: DevboxAdmissionInput) {
  const g0 = identityProblems(input.identity);
  const g5: string[] = [];
  const g6: string[] = [];
  const g7: string[] = [];
  const g9: string[] = [];

  const armSet = armSetProblems(input);

  for (const arm of input.arms) g9.push(...decisiveCompletenessProblems(arm, input.repetitions));

  for (const arm of input.arms) {
    if (arm.decisiveRequested !== true) continue;

    if (arm.c3 === undefined) g6.push(`arm ${arm.strategy} recorded no required live C3 observation`);
    else {
      const c3 = evaluateLiveC3(arm.c3);

      if (!c3.admitted) g6.push(...c3.errors.map((error) => `arm ${arm.strategy} live C3: ${error}`));
    }
  }

  g5.push(...armSet);
  g6.push(...armSet);
  g9.push(...armSet);

  for (const strategy of input.requested) {
    const arm = input.arms.find((row) => row.strategy === strategy);

    if (arm === undefined) continue;

    // A cell whose arm never cold-attached, or whose second attach missed the existing
    // generation, did not complete, whatever its latency rows say.
    if (arm.attachColdMs === null) {
      g6.push(`arm \`${strategy}\` recorded no cold attach, so its first attach was never timed`);
    } else if (arm.attachColdMs > COLD_ATTACH_CEILING_MS) {
      g6.push(
        `arm \`${strategy}\` cold attach took ${arm.attachColdMs} ms, past the `
        + `${COLD_ATTACH_CEILING_MS} ms admission ceiling`,
      );
    }

    if (!admittedAttachKinds('cold attach').includes(arm.attachColdKind)) {
      g6.push(`arm \`${strategy}\` cold attach reported kind "${arm.attachColdKind || 'none'}"`);
    }

    // `already-attached` counts as observing the unchanged generation; the step's own admission
    // list decides so poll and gate cannot diverge, and boot-id equality proves sameness.
    if (!admittedAttachKinds('warm attach').includes(arm.attachWarmKind)) {
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

    if (!admittedAttachKinds('wake').includes(arm.wakeKind)) {
      g6.push(`arm \`${strategy}\` wake did not attach durable bytes (kind "${arm.wakeKind || 'none'}")`);
    }

    if (arm.checkpoints.length !== EXPECTED_LADDER_ROWS) {
      g6.push(
        `arm \`${strategy}\` recorded ${arm.checkpoints.length} of ${EXPECTED_LADDER_ROWS} `
        + 'ladder checkpoints',
      );
    }

    // Each arm needs its own tally: `accounting` is one summed row, so a missing arm
    // vanishes into a total that still adds up.
    if (arm.ops === null) {
      g7.push(`arm \`${strategy}\` recorded no \`/ops\` tally, so its operations are unaccounted`);
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

    // Also compare against the run's request: an arm below it lost repetitions, and a floor
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

  // The shared gate refuses an uncounted row; these per-field reasons name the missing source
  // so blindness reads apart from breakage. An unverifiable counted claim refuses here too.
  for (const strategy of input.requested) {
    const arm = input.arms.find((row) => row.strategy === strategy);

    if (arm === undefined) continue;

    const counted = countedRestoreWork({
      wakeKind: arm.wakeKind,
      wakeDetail: arm.wakeDetail ?? '',
      wakeOps: arm.wakeOps ?? null,
      wakeMountLines: arm.wakeMountLines ?? [],
      wakeServedEntries: arm.wakeServedEntries ?? null,
    });

    for (const missing of counted.missing) {
      g5.push(`arm \`${strategy}\` ${missing} (counted: ${counted.detail})`);
    }

    if (counted.work !== null) {
      const bound = verifyRestoreBound(counted.work, arm.wakeMountLines ?? []);

      if (!bound.verified) {
        g5.push(`arm \`${strategy}\` claims a \`${RESTORE_CLAIMS[strategy]}\` restore bound that was never mechanically verified: ${bound.reason}`);
      }
    }
  }

  return { G0: g0, G5: g5, G6: g6, G7: g7, G9: g9 };
}

/** `admitted` is recomputed from merged reasons, so a gate the shared record satisfied
 *  cannot stay green while a devbox requirement it does not know is unmet. */
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


/** Updated as each step completes, not returned at the end: teardown can fire at any instant
 *  while arms run concurrently, finding some live, some never deployed, some already swept. */
interface ArmLaneState {
  readonly fixture: ArmFixture;
  readonly box: string;
  /** Every box this arm raised, including any the run added after the first. */
  readonly boxes: Set<string>;
  /** The deployed origin and token, once this arm's Worker accepted them. */
  live: Fixture | null;
  stop: (() => readonly string[]) | null;
  workerStopped: boolean;
  workerVersion: string;
  rollouts: readonly ApplicationRollout[];
  /** Why this arm never reached its measured pipeline, if it did not. */
  refusal: string | null;
}

/** Deletes by resource name only: a recovered manifest's process is gone, so no lane state.
 *  "Already absent" is success so an interrupted recovery can be rerun. */
export function orphanTeardownExecutor(
  residue: R2ResiduePlane | null,
): (entry: TeardownEntry) => Promise<DeleteOutcome> {
  // Durable state is reachable only through its Worker, so a box-empty entry is worthless
  // until the Worker serving it is deleted.
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
      // Checks only the Worker derived from this box, not the whole recovery: one arm's failed
      // delete must not report another arm's durable state as surviving.
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

/** A recovered manifest carries no lane state; the box name alone says which Worker goes first.
 *  Null for a name no strategy produces: a wrong guess reports live-served state as deleted. */
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
  --arms <strategy,...>             Measure named strategies. Defaults to every
                                    strategy this package ships:
                                    ${STRATEGIES.join(', ')}.
  --control <strategy>=<path>       Add frozen historical context for one strategy,
                                    from a previous run's artifact. Any of:
                                    ${STRATEGIES.join(', ')}.
  --plan                            Print the execution plan without deploying.
  --decisive                        Run decisive workloads.
  --fault-cuts                      Enable the publication rendezvous at Worker boot.
                                    Without this flag G3 remains unmeasured.
  --verify-only                     Run durability verification and cleanup, without performance
                                    workloads: one arm's ladder, stop, wake and teardown.
                                    Wins over --decisive.
  --repetitions <n>                 Measure every deciding cell n times per arm — the
                                    decisive workloads and the \`${DECIDING_METRIC}\` phase
                                    G9 scores. Default ${DECISIVE_REPETITIONS} with --decisive, 1 without;
                                    G9 censors a cell below ${MIN_DECIDING_REPETITIONS} repetitions. Refuses n < 1.
  --keep                            Retain external resources for inspection.
  --out <path>                      Write the result artifact.
  --help                            Show this help.
`;

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      arms: { type: 'string', default: STRATEGIES.join(',') },
      control: { type: 'string', multiple: true, default: [] },
      seed: { type: 'string', default: '20260824' },
      'budget-ms': { type: 'string', default: '8000' },
      repetitions: { type: 'string' },
      decisive: { type: 'boolean', default: false },
      'verify-only': { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      'fault-cuts': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });

  const controls: ControlOption[] = [];
  const knownStrategies = STRATEGIES.join(', ');
  const seenControls = new Set<Strategy>();

  for (const rawControl of values.control) {
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
  }

  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  const requestedArms = values.arms.split(',').map((raw): Strategy => {
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

  // Verify-only wins over decisive: a probe runs one arm's ladder and never the decisive
  // workloads, which the arm walk's decisive block reads from this field.
  const decisive = values.decisive && !values['verify-only'];

  // Refused before provisioning: G3 needs the rendezvous armed at Worker boot (`--fault-cuts`);
  // see DECISIVE-2026-09-05.md, "Publication-cut instrument measured locally on 2026-09-06".
  if (decisive && !values['fault-cuts']) {
    throw new Error(
      '--decisive without --fault-cuts cannot be admitted: G3 (publication safety) judges a '
      + 'publication the rendezvous holds, and the rendezvous is armed only at Worker boot by '
      + '--fault-cuts. Add --fault-cuts, or drop --decisive for a smoke run.',
    );
  }

  // G9 scores repetitions, so a decisive run defaults to the fewest a dispersion claim rests on.
  const rawRepetitions = values.repetitions ?? String(decisive ? DECISIVE_REPETITIONS : 1);
  // The whole text, not `parseInt`'s prefix: `parseInt('1.5')` is 1.
  const repetitions = /^\d+$/.test(rawRepetitions.trim()) ? Number(rawRepetitions.trim()) : Number.NaN;

  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(
      `--repetitions must be a whole number of 1 or more; got "${rawRepetitions}". `
      + `G9 censors a deciding cell below ${MIN_DECIDING_REPETITIONS} repetitions.`,
    );
  }

  return {
    runId,
    seed: Number.parseInt(values.seed, 10),
    budgetMs: Number.parseInt(values['budget-ms'], 10),
    decisive,
    verifyOnly: values['verify-only'],
    plan: values.plan,
    faultCuts: values['fault-cuts'],
    keep: values.keep,
    repetitions,
    controls,
    arms: requestedArms,
    out: values.out ?? join('bench-artifacts', `devbox-strategies-${runId}.json`),
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
      `Devbox storage plan\n\narms          ${options.arms.join(', ')}\n`
      + `controls      ${controls}\n`
      + `phases        ${PHASES.join(',')}\n`
      + `process-driven ${[...PROCESS_PHASES].join(',')}\n`
      + `change sizes  ${CHANGE_SIZES_KIB.map((k) => (k >= 1024 ? `${k / 1024}MiB` : `${k}KiB`)).join(', ')}\n`
      + `repetitions   ${options.repetitions} per deciding cell (${DECIDING_METRIC} phase`
      + `${options.decisive ? ' and every decisive workload' : ''})\n`
      + `workers       ${planned.map((names) => names.worker).join(', ')}\n`
      + `buckets       ${planned.map((names) => names.bucket).join(', ')}\n`
      + `artifact      ${options.out}\n`
      + (options.decisive ? `live C3       Seeded(61), 64MiB vol/dense.bin; Seeded(62), 64KiB at 8MiB; PUT bytes < ${C3_BYTES_BOUND}, object attempts = 1; cold file verification\n` : '')
      + '\nNothing has run. Drop --plan to execute.\n',
    );

    return 0;
  }

  if (!existsSync(join(BENCH_DIR, 'worker.ts'))) {
    throw new Error(`the devbox bench app is not present at ${BENCH_DIR}`);
  }

  const r2AccessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const r2SecretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  // Check the R2 cleanup keys before any deploy: they are a local prerequisite, and a
  // missing key found after measurement leaves a teardown that cannot verify itself.
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

  // Read the source revision before bundling or deploying: a later read can name edits
  // made after deploy and attribute real numbers to the wrong driver.
  const revision = sourceRevision();
  const startedAt = new Date().toISOString();

  const residue = r2AccessKeyId !== undefined && r2SecretAccessKey !== undefined
    ? r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey })
    : null;

  // Recover abandoned runs before creating anything: their manifests name live resources that
  // no other run's teardown sees, and leftover buckets would confound the C1–C7 residue checks.
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

  const fixtures = createFixtureResources(options.runId, options.arms);
  const teardownManifest = fixtures.manifest;

  const lanes = fixtures.arms.map((fixture): ArmLaneState => ({
    fixture,
    box: boxName(options.runId, fixture.strategy),
    boxes: new Set([boxName(options.runId, fixture.strategy)]),
    live: null,
    stop: null,
    workerStopped: false,
    workerVersion: '',
    rollouts: [],
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

    // Each arm's boxes are swept through that arm's own Worker: an arm answers only on its own
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
        // Set only from observed statuses: `do-state`, `alarm` and `mount` entries answer `ok` on it,
        // and done entries are never revisited by the startup sweep; C4/C5 read it too.
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
    // Deploys run before the in-flight window: `execFileSync` blocks the event loop and would stall
    // a measuring sibling's polling, corrupting its cold attach wall clock; a refusal stays on its lane.
    for (const lane of lanes) {
      await armLogContext.run(lane.fixture.strategy, async (): Promise<void> => {
        try {
          wrangler(['r2', 'bucket', 'create', lane.fixture.bucket]);
          const started = await deployFixture(token, lane.fixture, options.faultCuts);
          lane.stop = started.stop;
          lane.live = { ...started.fixture, identity: { ...revision, workerVersion: started.workerVersion, image: SANDBOX_IMAGE } };
          lane.workerVersion = started.workerVersion;
          lane.rollouts = started.rollouts;
        } catch (error) {
          lane.refusal = `deploy failed: ${describeThrown({ cause: error })}`;
          log(lane.refusal);
        }
      });
    }

    // Arms run concurrently: each has its own Worker, bucket and container, sharing only polling.
    // `runArmsInFlight` isolates one arm's failure; `runArm` keeps measured rows and frees its box.
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
    // The stack is logged because a bare `TimeoutError` names no stage;
    // a refused run must say which call refused it.
    log(`run failed: ${failure}`);
    const thrown = parseThrown({ cause: error });

    if (thrown.stack !== undefined && thrown.stack.length > 0) log(`run failure stack:\n${thrown.stack}`);

    if (thrown.cause !== undefined) log(`run failure cause: ${describeThrown({ cause: thrown.cause })}`);
  } finally {
    await runTeardownOnce();
  }

  // Assembly reads each arm's durable artifact, not memory, so an interrupted run keeps settled rows.
  // An arm with no file is externally-aborted, never unmeasured: a wedge must not read as a result.
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
    'publication rendezvous': options.faultCuts
      ? 'armed at Worker boot; one added control RPC per successful object write'
      : 'unarmed; zero added control RPCs',
    'publication accounting': 'counter lookup per PUT/part/complete; the C3 window additionally persists each attempt completion',
    'witness profile': 'chunked',
    'live C3': options.decisive ? 'required; isolated one-file baseline after the priced workloads; raw PUT window and genuinely cold digest check' : 'not requested',
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
    // One version per deployed arm, keyed by strategy: a run deploys several Workers, so one id
    // cannot name them all. An undeployed arm adds nothing, so a run that deployed none fails G0.
    workerVersion: lanes
      .filter((lane) => lane.workerVersion !== '')
      .map((lane) => `${lane.fixture.strategy}=${lane.workerVersion}`)
      .join(', '),
    startedAt,
    finishedAt: new Date().toISOString(),
    image: SANDBOX_IMAGE,
    ...fixtures.digests,
    rollouts: lanes.flatMap((lane) => lane.rollouts),
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
  // A partial run renders the frozen-control section even when empty, so the report states
  // whether history covered the unmeasured arms.
  const partial = options.arms.length < STRATEGIES.length;
  process.stdout.write(`${render({ arms, meta, admission, frozenControls, renderControlContext: partial })}\n`);
  log(`artifact written to ${options.out}`);

  return benchmarkExitCode(failure, admission);
}

if (import.meta.main) process.exit(await main());
