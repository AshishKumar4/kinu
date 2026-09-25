#!/usr/bin/env bun
/** The deployed devbox fixture the live drivers share: Worker and bucket resources, box RPC,
 *  lifecycle operations, R2 residue accounting and teardown. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, awaitApplicationRollout, containerAppIds, delay, deleteContainerApps,
  describeThrown, runWrangler, type ApplicationRollout,
} from './fixtures/r2-bench/deploy-substrate';
import * as v from 'valibot';
import {
  ExecReplySchema, CheckpointReplySchema, FileEvidenceSchema,
  StateReplySchema, KickReplySchema, DestroyReplySchema, TeardownReplySchema,
  type ExecReply, type CheckpointReply, type FileObservation,
  type AttachOutcome, type StateReply, type KickReply, type StartupPoll, type StartupCompletion,
  type StartupObservation, type StartupIncidents, type DestroyReply, type TeardownReply,
} from '../packages/devbox/bench/observation-schema';
import { BlockAttachMetricsSchema, evaluateLiveC3, type BlockAttachMetrics, type C3Identity, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import { PublicationWindowSchema, publicationTotals } from '../packages/devbox/bench/publication-meter';
import { C3_WORKLOAD } from '../packages/devbox/bench/witness-files';
import { AwsClient } from 'aws4fetch';
import {
  RestorePhaseStampsSchema, type RestorePhaseStamps,
} from '@kinu.run/devbox/durability/contracts';
import {
  checkCleanup, createManifest, replayTeardown, writeManifest,
  type CleanupProbes, type CleanupReport, type DeleteOutcome, type TeardownEntry,
  type TeardownManifest,
} from './fixtures/storage-matrix/cleanup';
import { parseJsonc } from './jsonc';
import { trackedFiles } from './sources';
import blockImage from '../packages/devbox/block-lower/upstream.json';
import { R2_OPERATION_NAMES as R2_OP_VOCABULARY } from '../packages/devbox/bench/r2-operations';

type StartupPollVerdict =
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
function startupPollVerdict(reply: StateReply): StartupPollVerdict {
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
function describeStartupState(reply: StateReply): string {
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

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));

/** `storage.ts`'s checkpoint kinds and attach outcomes, restated for the same reason; a kind the
 *  box adds is refused, loudly, until it is added here. */
type CheckpointKind = 'tick' | 'quiesce';

const ATTACH_OUTCOME_KINDS = ['empty', 'attached', 'already-attached'] as const;

const BENCH_DIR = join(REPO_ROOT, 'packages/devbox/bench');

/** The account every devbox fixture is raised on; exported so the deployed lifecycle suite
 *  names this one rather than a second copy (`gate:policy-drift` checks this). */
export const BENCH_ACCOUNT_ID = 'f44999d1ddda7012e9a87729eba250f1';

const FIXTURE_BASE = 'kinu-devbox-bench';

const FIXTURE_CLASS_BY_STRATEGY = {
  'snapshot-chain': 'SnapshotChainBox',
} as const satisfies Record<Strategy, string>;

const FIXTURE_COUNTER_CLASS = 'BenchOpCounter';

interface FixtureNames {
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

interface FixtureResources {
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
function plannedTeardownManifest(
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

const SANDBOX_IMAGE_DIGEST = blockImage.digest;

/** Fixture configs pin this immutable reference so the provenance row names the bytes that ran,
 *  not a tag another publisher can repoint. */
export const SANDBOX_IMAGE = blockImage.image;

const PROCESS_DEADLINE_MS = 1_500_000;

export type Strategy = 'snapshot-chain';

export const STRATEGIES: readonly Strategy[] = ['snapshot-chain'];

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

const armLogTail = (arm: Strategy): readonly string[] => [...(armLogTails.get(arm) ?? [])];

/** Valibot's own field-level words for a payload that missed its contract. What
 *  the fixture sent is the only authority on what is wrong with it. */
const issueText = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ');

const wrangler = (args: readonly string[], options: { allowFailure?: boolean } = {}): string =>
  runWrangler(REPO_ROOT, args, options);

/** Open multipart uploads are invisible to `bucket info` and the REST object list; only S3
 *  ListMultipartUploads sees them, and they or leftover objects block `bucket delete` (10008). */
interface R2ResiduePlane {
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
const R2_CLEANUP_KEY_VARS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

const R2_CLEANUP_KEY_FILE = '.dev.vars';

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
    + 'verifies its own cleanup: the check reads every bucket through S3, so a bucket that still exists '
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
  readonly kind?: CheckpointKind;
  /** Idempotency key for one semantic operation on the two armed routes; reused across retries
   *  so a re-posted request cannot arm a second publication. */
  readonly op?: string;
  readonly purge?: boolean;
  readonly prefix?: string;
  readonly whole?: boolean;
}

interface AddressedArmRequest {
  readonly path: string;
  readonly body?: DriverRequest;
}

/** Binds every box-addressed request to its arm: GET carries it in the query, POST in JSON.
 *  fetch rejects a GET body, so GET must never carry the arm in a body. */
function addressArmRequest(
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

async function readBoxFile(fixture: Fixture, box: string, path: string, harness = HARNESS): Promise<FileObservation> {
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

interface DeployedFixture {
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
  boot: { readonly productionSync?: boolean } = {},
): Promise<DeployedFixture> {
  const output = wrangler([
    'deploy', '--config', fixture.configPath, '--var', `BENCH_TOKEN:${token}`,
    ...(boot.productionSync === true ? ['--var', 'BENCH_PRODUCTION_SYNC:1'] : []),
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

/** The fields of the box's incident rows the driver reads, as the wire carries them.
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

/** The ledger as one line for a refusal message, newest last.
 *  An absent ledger says so rather than reading as an empty one. */
export function describeIncidentReasons(rows: readonly IncidentReasonRow[] | undefined): string {
  if (rows === undefined) return 'unread';

  if (rows.length === 0) return 'none filed';

  return rows.map((incident) =>
    `[${incident.stage ?? '?'}${incident.delivered === true ? '' : ', undelivered'}] ${incident.reason ?? '(no reason)'}`).join(' | ');
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

type HttpsRequester = (
  url: URL,
  options: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
  },
  respond: (response: HttpsResponse) => void,
) => HttpsRequest;

type LiveTeardownHttpsRequester = HttpsRequester;

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
interface AttachPoll {
  readonly fixture: Fixture;
  readonly box: string;
  readonly operation: string;
  readonly allowedKinds: readonly string[];
  readonly bounds?: StartupBounds;
}

async function pollForAttach(
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
interface StartupBounds {
  readonly deadlineMs?: number;
  readonly observations?: StartupObservation[];
}

/** Waits for THIS generation's attach, timed end to end from the kick. `/create` and `/wake`
 *  differ only in what the container is allowed to restore. */
interface StartupRequest {
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

interface StopReply { ok?: boolean; ms?: number; error?: string }

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
interface OperationPollReply extends CheckpointReply {
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

interface OperationBounds {
  readonly pollMs?: number;
  readonly deadlineMs?: number;
}

/** Mint `op` inside the retried closure: a settled operation is answered from its row forever,
 *  so only a fresh `op` heals a replacement; the transport re-post keeps the attempt's `op`. */
interface CheckpointRequest {
  readonly fixture: Fixture;
  readonly box: string;
  readonly kind: CheckpointKind;
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

type TeardownPurgePayload = Readonly<Pick<DriverRequest, 'purge' | 'prefix' | 'whole'>>;

const TEARDOWN_PURGE_PAYLOAD: TeardownPurgePayload = { purge: true, prefix: '', whole: true };

type LiveTeardownSender = (
  fixture: Fixture,
  box: string,
  payload: TeardownPurgePayload,
  /** The elapsed bound one pass may take, or undefined for the benchmark's own
   *  unbounded purge. */
  timeoutMs?: number,
) => Promise<void>;

async function postLiveTeardown(
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

/** Box-side restore wall time (readiness gate hold), not driver round trip; null is absent, not 0.
 *  Row with `probeAt` and phases but no `wallMs` never settled; last phase is where it stopped. */
interface RestoreProbeRow {
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

async function installWitnessHarness(fixture: Fixture, box: string, directory: string): Promise<void> {
  const made = await execInBox(fixture, box, `mkdir -p '${directory}'`);

  if (made.ok !== true || made.exitCode !== 0) throw new Error(`the witness directory was not created: ${made.error ?? made.stderr ?? 'no result'}`);

  for (const file of ['witness-files.ts', 'seeded.ts']) {
    await writeFileInBox(fixture, box, `${directory}/${file}`, readFileSync(join(BENCH_DIR, file), 'utf8'));
  }
}

/** The three startup steps an arm takes, named so a step cannot be misspelled
 *  into an empty exclusion set. */
type StartupStep = 'cold attach' | 'wake' | 'warm attach';

const ATTACH_KINDS_EXCLUDED = {
  'cold attach': {},
  wake: {
    empty: 'a wake that finds no head has nothing to measure, and continuing would '
      + 'spend a full workload producing numbers that describe the container\'s '
      + 'own blank disk',
  },
  'warm attach': {
    empty: 'an attached box whose head has vanished is a control-plane fault, not a '
      + 'slower attach, and every later cell would measure a blank disk',
  },
} satisfies Record<StartupStep, Readonly<Record<string, string>>>;

/** Exported so a driver admits the same kinds instead of restating them. */
export function admittedAttachKinds(step: StartupStep): readonly string[] {
  const excluded: Readonly<Record<string, string>> = ATTACH_KINDS_EXCLUDED[step];

  return ATTACH_OUTCOME_KINDS.filter((kind) => excluded[kind] === undefined);
}

function isTransientContainerCreateError(error: string | undefined): boolean {
  return /no container instance|container service is unreachable|try again later|ContainerUnavailable|OperationInterrupted/i
    .test(error ?? '');
}

/** Matches `Devbox.ensureReady()`'s own retry phrases; only the one naming `attachNow()` is a verdict.
 *  The reply carries no phase code, so re-armability cannot be inferred from one. */
function isRearmableStartupRefusal(error: string | undefined): boolean {
  return /a startup is armed, so ask again|a retry is already under way/i.test(error ?? '');
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
interface RestoreProbe {
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

interface LiveC3Measurement {
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

/** Each arm writes its row to disk the moment it settles, so a wedged sibling or killed driver
 *  cannot lose a settled measurement. Keyed by run id: one run's directory holds exactly its arms. */
function armArtifactDir(repoRoot: string, runId: string): string {
  return join(repoRoot, 'bench-artifacts', runId);
}

function armArtifactPath(repoRoot: string, runId: string, arm: Strategy): string {
  return join(armArtifactDir(repoRoot, runId), `${arm}.json`);
}

/** The log tail is all an arm that never settled can offer; `settledAt` dates the write. */
interface ArmArtifact<Row> {
  readonly schema: 'devbox-arm-artifact/1';
  readonly arm: Strategy;
  readonly runId: string;
  readonly settledAt: string;
  readonly logTail: readonly string[];
  readonly row: Row;
}

/** tmp + rename: a reader sees the file whole or not at all. */
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

/** Admission contract's cold-attach ceiling; distinct from the fixture's 300 s abandonment
 *  budget in `packages/devbox/bench/worker.ts`. A run that missed it cannot raise it. */
export const COLD_ATTACH_CEILING_MS = 25_000;

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

/** One lane per planned arm, each raising only its own box until the run adds more. */
export function armLanes(runId: string, fixtures: FixtureResources): ArmLaneState[] {
  return fixtures.arms.map((fixture) => ({
    fixture,
    box: boxName(runId, fixture.strategy),
    boxes: new Set([boxName(runId, fixture.strategy)]),
    live: null,
    stop: null,
    workerStopped: false,
    workerVersion: '',
    rollouts: [],
    refusal: null,
  }));
}

export interface LaneTeardown {
  readonly report: CleanupReport | null;
  readonly errors: readonly string[];
  /** The first failure in teardown order; null once every resource is observed gone. */
  readonly failure: string | null;
}

/** Tears a run down through its manifest: each arm's boxes on its own Worker, then every recorded
 *  resource, then a check that observes each one gone. */
export async function teardownLanes(
  fixtures: FixtureResources,
  lanes: readonly ArmLaneState[],
  residue: R2ResiduePlane | null,
): Promise<LaneTeardown> {
  const errors: string[] = [];
  let failure: string | null = null;

  // Each arm's boxes are swept through that arm's own Worker: an arm answers only on its own
  // deployment, and an arm that never deployed has nothing to sweep.
  for (const lane of lanes) {
    if (lane.live === null) continue;
    const liveTeardownErrors = await teardownLiveArms(lane.live, lane.boxes);
    errors.push(...liveTeardownErrors);

    if (liveTeardownErrors.length > 0) {
      failure ??= `live teardown failed: ${liveTeardownErrors.join('; ')}`;
    }
  }

  // Container applications, buckets and the config directory go by name, as an abandoned run's do;
  // only the Worker and what it serves need this run's lane state.
  const byName = orphanTeardownExecutor(residue);

  const replay = await replayTeardown(REPO_ROOT, fixtures.manifest, async (entry): Promise<DeleteOutcome> => {
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

    if (entry.kind === 'do-state' || entry.kind === 'alarm' || entry.kind === 'mount') {
      // Gated on THIS box's own Worker. An arm whose Worker is still up has
      // durable state nothing has proved gone, however many siblings are.
      const lane = lanes.find((candidate) => candidate.box === entry.name);

      return lane?.workerStopped === true
        ? { ok: true }
        : { ok: false, error: 'Worker must be deleted before its durable state' };
    }

    return await byName(entry);
  });

  if (replay.failures.length > 0) {
    errors.push(...replay.failures);
    failure ??= `cleanup failed: ${replay.failures.join('; ')}`;
  }

  let cleanupCheck: CleanupReport | null = null;

  try {
    cleanupCheck = await checkCleanup(REPO_ROOT, fixtures.manifest, {
      ...cleanupObservationProbes({ wrangler, residue }),
      containerAppAbsent: async (name) => containerAppIds(REPO_ROOT, [name], log).length === 0,
      boxStateEmpty: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
      alarmAbsent: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
      mountAbsent: async (name) => lanes.find((lane) => lane.box === name)?.workerStopped === true,
      localPathAbsent: async (path) => !existsSync(path),
      processAbsent: async () => true,
      counters: async () => ({ ...fixtures.manifest.counters }),
    }, R2_OP_VOCABULARY);
  } catch (cause) {
    // A verifier that could not OBSERVE proves nothing either way; the
    // run then carries no cleanup evidence.
    errors.push(`cleanup verification failed: ${describeThrown({ cause })}`);
    failure ??= 'cleanup verification failed';
  }

  if (cleanupCheck !== null && !cleanupCheck.passed) {
    errors.push(...cleanupCheck.checks.filter((row) => !row.ok).map((row) => `${row.gate}: ${row.detail}`));
    failure ??= 'cleanup checks failed';
  }

  if (!lanes.every((lane) => lane.workerStopped)) fixtures.disposeConfig();

  return { report: cleanupCheck, errors, failure };
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
