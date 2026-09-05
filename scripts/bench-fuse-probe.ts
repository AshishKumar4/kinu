#!/usr/bin/env bun
/**
 * Ephemeral deployed custom read-only FUSE capability/performance probe.
 *
 *   bun scripts/bench-fuse-probe.ts --plan  # describes proof, touches nothing
 *   bun scripts/bench-fuse-probe.ts --run   # deploys a unique Worker, probes,
 *                                           # persists immutable evidence, cleans up
 *
 * Local dev cannot answer this question: Containers and SQLite Durable Objects
 * are local-only in `wrangler dev --remote`, while a local Worker has neither
 * the product container's kernel namespace nor its seccomp/capability set. A
 * real, throwaway deployment is the only valid measurement. The fixture has a
 * unique workers.dev name and a per-run token; finally plus signal teardown
 * delete its Worker and container application idempotently.
 *
 * There is intentionally no R2 arm and no product code path here. This probe
 * establishes whether a future lazy range-backed read-only mount is possible;
 * it does not pretend that the product already uses FUSE.
 */
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import {
  armSignalTeardown, containerAppIds, containerApplicationName, delay,
  deleteContainerApps, deleteFixtureWorker, describeThrown, publishTeardown,
  runTeardownOnce, runWrangler, WRANGLER_FAILED,
} from './fixtures/r2-bench/deploy-substrate';
import {
  classifyMaterialization, classifyRun, classifyWritableMmap, classifyWritableMmapControls,
  imageMismatchVerdict, RunIdentitySchema, SANDBOX_IMAGE, SANDBOX_IMAGE_VERSION,
  Stage1ReportSchema, Stage2ReportSchema, Stage3ReportSchema,
} from './fixtures/fuse-probe/core';
import type {
  FuseProbeArtifact, RunIdentity, Stage1Report, Stage2Report, Stage3Report,
  WritableMmapControl, WritableMmapMutation,
} from './fixtures/fuse-probe/core';

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'fixtures', 'fuse-probe');
const ARTIFACT_DIR = join(REPO_ROOT, 'bench-artifacts');
const RESULT_MARKER = '__FUSE_PROBE_RESULT__';

export const PHASES = [
  ['P0', 'deployment', 'unique token-guarded Worker and one Sandbox container'],
  ['P1', 'platform census', 'uid/capabilities/seccomp, exact direct syscall results, binaries and kernel filesystems'],
  ['P2', 'safe materialization', 'openat2 RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS positive, deterministic escape and concurrent symlink-race controls'],
  ['P3', 'FUSE bring-up', 'custom raw /dev/fuse server, direct and uid=65534 helper mount routes'],
  ['P4', 'semantics', 'range digest refusal, cache, links, executable mode, wide/deep lookup and overlay composition'],
  ['P5', 'performance', 'cold root, first stat/read, fixed working set, full walk and native lower control'],
  ['P6', 'writable mmap barrier', 'pinned C/libfuse probe at FUSE protocol 7.39, direct-I/O MAP_SHARED stores, ordered WRITE/FSYNC/SYNCFS fence, daemon kill/restart/remount'],
  ['P7', 'restart and cleanup', 'stop+wake, remount, forced unmount, residue/process scan and idempotent replay'],
] as const;

export interface Deployment {
  readonly workerName: string;
  readonly containerAppName: string;
  readonly configPath: string;
  readonly origin: string;
  /** Process-local only: reaches /destroy during teardown, never persisted. */
  readonly token: string;
  /** Immutable custom image for the writable C/libfuse stage. */
  readonly writableImage: string;
}

const ExecResponseSchema = v.looseObject({
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  exitCode: v.optional(v.number()),
  wallMs: v.optional(v.number()),
});
type ExecResponse = v.InferOutput<typeof ExecResponseSchema>;

const ProcessStartSchema = v.strictObject({
  operationId: v.string(),
  status: v.string(),
  exitCode: v.nullable(v.number()),
  started: v.boolean(),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
});

const ProcessPollSchema = v.strictObject({
  operationId: v.string(),
  status: v.string(),
  exitCode: v.nullable(v.number()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
});

const OkSchema = v.object({ ok: v.boolean() });

export function stripWholeLineComments(jsonc: string): string {
  return jsonc.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
}

/** The per-run wrangler config the driver generates. Only the fields the
 * driver or tests read are named; everything else passes through untouched
 * from the fixture template. */
export interface FixtureConfig {
  readonly name: string;
  readonly vars: { FUSE_PROBE_TOKEN: string };
  readonly r2_buckets?: unknown;
  readonly containers: Array<{ class_name: string; image: string }>;
}

const FixtureConfigSchema = v.looseObject({
  containers: v.array(v.looseObject({ class_name: v.string(), image: v.string() })),
});

/** The writable stage never deploys a mutable tag. The image must be built from
 * fixtures/fuse-probe/Dockerfile, pushed by the operator, and addressed by its
 * registry digest so a later tag overwrite cannot change an artifact's claim. */
export function requireWritableProbeImage(image = process.env.FUSE_PROBE_IMAGE): string {
  if (image === undefined || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('FUSE_PROBE_IMAGE must be an immutable registry image digest built from scripts/fixtures/fuse-probe/Dockerfile');
  }
  return image;
}

/** Pure config derivation: tests prove a run cannot re-use the fixture name or
 * omit its token. The fixture has no bucket; cleanup is Worker+container only. */
export function deriveFixtureConfig(template: string, workerName: string, token: string, writableImage = SANDBOX_IMAGE): FixtureConfig {
  const parsed = v.parse(FixtureConfigSchema, JSON.parse(stripWholeLineComments(template)));
  return {
    ...parsed,
    name: workerName,
    vars: { FUSE_PROBE_TOKEN: token },
    containers: parsed.containers.map((container) => ({ ...container, image: writableImage })),
  };
}

export function fuseProbeArtifactPath(artifactDir: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) throw new Error(`safe artifact id required, got ${JSON.stringify(runId)}`);
  return join(artifactDir, `fuse-probe-${runId}.json`);
}

/** Atomic, immutable evidence write. link() refuses a duplicate final name,
 * while rename() would silently overwrite a prior measured run. */
export async function persistFuseProbeArtifact(artifactDir: string, artifact: FuseProbeArtifact): Promise<string> {
  await mkdir(artifactDir, { recursive: true });
  const target = fuseProbeArtifactPath(artifactDir, artifact.runId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export function planText(): string {
  return [
    'fuse-probe plan — no deployment or container is started:',
    ...PHASES.map(([id, name, proves]) => `  ${id} ${name}: ${proves}`),
    '  writable image: build scripts/fixtures/fuse-probe/Dockerfile, push it, then set FUSE_PROBE_IMAGE=registry/name@sha256:<digest>.',
    '  live command: FUSE_PROBE_IMAGE=registry/name@sha256:<digest> bun scripts/bench-fuse-probe.ts --run',
    '  cleanup: /destroy twice, then container application deleted and proven absent, Worker deleted, generated config removed — every step twice, already-absent succeeds.',
    `  evidence: immutable JSON under ${ARTIFACT_DIR}`,
  ].join('\n');
}

function requestHeaders(token: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-fuse-probe-token': token };
}

/** The slice of fetch the HTTP helpers need — narrower than the ambient
 *  global so tests can pass plain arrow fakes. */
export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

/** Wire body every fixture route accepts — the driver-side mirror of the
 * fixture contract's CommandSchema. */
interface ProbeCommandBody {
  command?: string;
  path?: string;
  contentBase64?: string;
  timeoutMs?: number;
  operationId?: string;
}

/** The raw transport result: status plus body text. Parsing happens against a
 * valibot schema one layer up, so evidence shapes are checked exactly once. */
interface RawResponse { status: number; text: string }

async function sendJson(
  origin: string,
  token: string,
  path: string,
  body: ProbeCommandBody,
  doFetch: FetchLike = fetch,
): Promise<RawResponse> {
  const response = await doFetch(new URL(path, origin), {
    method: 'POST', headers: requestHeaders(token), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, text: await response.text() };
}

async function requestJson<T>(
  origin: string,
  token: string,
  path: string,
  body: ProbeCommandBody,
  schema: v.GenericSchema<T>,
  doFetch: FetchLike = fetch,
): Promise<{ status: number; parsed: T }> {
  const raw = await sendJson(origin, token, path, body, doFetch);
  try {
    return { status: raw.status, parsed: v.parse(schema, JSON.parse(raw.text)) };
  } catch (error) {
    throw new Error(
      `${path} (${raw.status}) did not return JSON: ${raw.text.slice(0, 300)}`,
      { cause: error },
    );
  }
}

async function request<T>(
  origin: string,
  token: string,
  path: string,
  body: ProbeCommandBody,
  schema: v.GenericSchema<T>,
  doFetch: FetchLike = fetch,
): Promise<T> {
  const { status, parsed } = await requestJson(origin, token, path, body, schema, doFetch);
  if (status < 200 || status >= 300) throw new Error(`${path} failed (${status}): ${JSON.stringify(parsed).slice(0, 800)}`);
  return parsed;
}

async function exec(origin: string, token: string, command: string, timeoutMs: number): Promise<ExecResponse> {
  return request(origin, token, '/exec', { command, timeoutMs }, ExecResponseSchema);
}
async function awaitFixtureReady(origin: string, token: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', origin), {
        headers: { 'x-fuse-probe-token': token },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 200) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = describeThrown({ cause: error });
    }
    await delay(2_000);
  }
  throw new Error(`fixture did not accept its token: ${last}`);
}

async function setupExec(
  origin: string,
  token: string,
  command: string,
): Promise<ExecResponse> {
  let last = 'setup was not attempted';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await exec(origin, token, command, 60_000);
    } catch (error) {
      last = describeThrown({ cause: error });
      if (attempt < 4) await delay(attempt * 5_000);
    }
  }
  throw new Error(`container setup failed after four attempts: ${last}`);
}


export async function bundleFuseProbeSource(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(FIXTURE_DIR, 'probe.ts')],
    target: 'bun',
    format: 'esm',
    minify: false,
  });
  if (!built.success) {
    throw new Error(`FUSE probe bundle failed: ${built.logs.map((entry) => entry.message).join('; ')}`);
  }
  const output = built.outputs[0];
  if (output === undefined) throw new Error('FUSE probe bundle produced no output');
  return output.text();
}

async function uploadProbeBundle(origin: string, token: string): Promise<void> {
  const content = Buffer.from(await bundleFuseProbeSource(), 'utf8');
  await request(origin, token, '/put', {
    path: '/tmp/fuse-probe/probe.mjs',
    contentBase64: content.toString('base64'),
  }, OkSchema);
}

/** The probe writes progress before its final JSON. Only the line immediately
 * after the marker is evidence; terminal noise cannot become a result shape. */
export function parseProbeOutput<T>(stdout: string, schema: v.GenericSchema<T>): T {
  const lines = stdout.split('\n');
  const marker = lines.lastIndexOf(RESULT_MARKER);
  if (marker === -1 || lines[marker + 1] === undefined) throw new Error(`probe output has no ${RESULT_MARKER} result marker`);
  let parsed: unknown;
  try { parsed = JSON.parse(lines[marker + 1]!); } catch (error) { throw new Error(`probe result JSON invalid: ${describeThrown({ cause: error })}`, { cause: error }); }
  return v.parse(schema, parsed);
}

/** Teardown's entry point while the Worker still exists. Tolerated ONLY by
 *  explicit absence (404): a timeout, transport failure or other status means
 *  nobody knows whether the runtime — and with it the DO storage clearance —
 *  actually happened, so cleanup fails loudly instead of skipping it. */
export async function destroyRuntime(
  origin: string,
  token: string,
  log: (message: string) => void,
  doFetch: FetchLike = fetch,
): Promise<void> {
  let detail: string;

  try {
    const raw = await sendJson(origin, token, '/destroy', {}, doFetch);
    if (raw.status >= 200 && raw.status < 300) return;
    if (raw.status === 404) { log('/destroy answered 404 — the runtime is already gone'); return; }
    detail = `/destroy failed (${raw.status}): ${raw.text.slice(0, 300)}`;
  } catch (error) {
    detail = `/destroy unreachable: ${describeThrown({ cause: error })}`;
  }
  throw new Error(detail);
}
function parseExecReport<T>(
  phase: 'stage1' | 'stage2',
  result: ExecResponse,
  schema: v.GenericSchema<T>,
): T {
  if (result.exitCode !== 0) {
    throw new Error(`${phase} exited ${result.exitCode}: ${(result.stderr ?? '').slice(-800)}`);
  }
  try {
    return parseProbeOutput(result.stdout ?? '', schema);
  } catch (error) {
    throw new Error(
      `${phase} result invalid: ${describeThrown({ cause: error })}; stderr: ${(result.stderr ?? '').slice(-800)}`,
      { cause: error },
    );
  }
}

/** The C probe exits non-zero for a proved NO_GO. Its JSON is therefore parsed
 * before interpreting the exit code; discarding it would erase the evidence
 * that explains the refusal. */
export function parseWritableMmapOutput(result: ExecResponse): Stage3Report {
  if (result.exitCode !== 0 && result.exitCode !== 86) {
    throw new Error(`writable mmap probe exited ${String(result.exitCode)}: ${(result.stderr ?? '').slice(-800)}`);
  }
  const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`writable mmap probe emitted no JSON: ${(result.stderr ?? '').slice(-800)}`);
  try {
    const report = v.parse(Stage3ReportSchema, JSON.parse(line));
    if (result.exitCode === 0 && !report.linearizable) throw new Error('writable mmap probe exited 0 with a non-linearizable report');
    if (result.exitCode === 86 && report.linearizable) throw new Error('writable mmap probe exited 86 with a linearizable report');
    return report;
  } catch (error) {
    throw new Error(`writable mmap probe emitted invalid evidence: ${describeThrown({ cause: error })}`, { cause: error });
  }
}
export interface WritableMmapEvidence {
  readonly exitCode: 0 | 86;
  readonly report: Stage3Report;
}

export function parseWritableMmapEvidence(result: ExecResponse): WritableMmapEvidence {
  const report = parseWritableMmapOutput(result);
  const exitCode = result.exitCode;
  if (exitCode !== 0 && exitCode !== 86) {
    throw new Error(`writable mmap probe exit code missing or unsupported: ${String(exitCode)}`);
  }
  return { exitCode, report };
}


async function deploy(runId: string, token: string, writableImage: string): Promise<Deployment> {
  const workerName = `kinu-fuse-probe-${runId}`;
  const containerAppName = containerApplicationName(workerName, 'FuseProbeBox');
  const configPath = join(FIXTURE_DIR, `wrangler.${runId}.jsonc`);
  const template = await readFile(join(FIXTURE_DIR, 'wrangler.jsonc'), 'utf8');
  await writeFile(configPath, `${JSON.stringify(deriveFixtureConfig(template, workerName, token, writableImage), null, 2)}\n`, 'utf8');
  const deployed = runWrangler(REPO_ROOT, ['deploy', '--config', configPath], { allowFailure: true });
  if (deployed.startsWith(WRANGLER_FAILED)) {
    await releaseResources(liveReleaseHooks(configPath, workerName, containerAppName));
    throw new Error(`wrangler deploy failed: ${deployed.slice(0, 2_000)}`);
  }
  const origin = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/.exec(deployed)?.[0];
  if (origin === undefined) throw new Error('wrangler deploy printed no workers.dev URL');
  return { workerName, containerAppName, configPath, origin, token, writableImage };
}

async function wake(origin: string, token: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      // Exit status, not stdout: `test ! -e` prints nothing on either branch,
      // so only exitCode 0 proves a fresh instance.
      const result = await exec(origin, token, 'test ! -e /tmp/fuse-probe-restart-marker', 60_000);
      if (result.exitCode === 0) return;
    } catch (error) { last = error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000 * (attempt + 1)));
  }
  throw new Error(`container did not wake after stop: ${describeThrown({ cause: last })}`);
}

async function stopAndProveRestart(origin: string, token: string): Promise<void> {
  const marker = `fuse-probe-restart-${randomUUID()}`;
  await exec(origin, token, `printf %s ${JSON.stringify(marker)} >/tmp/fuse-probe-restart-marker`, 60_000);
  await request(origin, token, '/stop', {}, OkSchema);
  await wake(origin, token);
}

/** How much account-side resource deletion can be driven. Injectable so the
 *  order and replay properties are provable offline. */
export interface ReleaseHooks {
  listContainerApps(): Array<{ id: string; name: string }>;
  deleteContainerApps(): string[];
  deleteWorker(): boolean;
  removeConfig(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface TeardownHooks extends ReleaseHooks {
  destroyRuntime(): Promise<void>;
}

/** Compatibility-free wrapper over the shared two-route deletion policy. */
export function deleteWorkerBothRoutes(
  repoRoot: string,
  configPath: string,
  workerName: string,
  log: (message: string) => void,
  wrangle: typeof runWrangler = runWrangler,
): boolean {
  return deleteFixtureWorker(repoRoot, configPath, workerName, log, wrangle);
}

export const CONTAINER_APP_ABSENCE_ATTEMPTS = 12;
export const CONTAINER_APP_ABSENCE_GAP_MS = 5_000;

/** Deletion is asynchronous account-side: poll until no application matching
 *  this run's name remains. An empty listing means absence; a listing the
 *  substrate cannot parse never reads as absence (it filters to matches). */
export async function awaitContainerAppAbsent(
  listMatchingApps: () => Array<{ id: string; name: string }>,
  sleep: (ms: number) => Promise<void> = delay,
  attempts = CONTAINER_APP_ABSENCE_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (listMatchingApps().length === 0) return true;
    if (attempt + 1 < attempts) await sleep(CONTAINER_APP_ABSENCE_GAP_MS);
  }
  return false;
}

function liveReleaseHooks(
  configPath: string,
  workerName: string,
  containerAppName: string,
): ReleaseHooks {
  return {
    listContainerApps: () => containerAppIds(REPO_ROOT, [containerAppName], console.log),
    deleteContainerApps: () => deleteContainerApps(REPO_ROOT, [containerAppName], console.log),
    deleteWorker: () => deleteWorkerBothRoutes(REPO_ROOT, configPath, workerName, console.log),
    removeConfig: () => rm(configPath, { force: true }).then(() => undefined),
    sleep: delay,
  };
}

function liveTeardownHooks(deployment: Deployment): TeardownHooks {
  return {
    ...liveReleaseHooks(
      deployment.configPath,
      deployment.workerName,
      deployment.containerAppName,
    ),
    destroyRuntime: () => destroyRuntime(deployment.origin, deployment.token, console.log),
  };
}

/** Application before Worker: delete the container APPLICATION, prove its
 *  absence, then the Worker, then the generated config that names them. Every
 *  step tolerates its own absence, so teardown replays cleanly. */
export async function releaseResources(hooks: ReleaseHooks): Promise<void> {
  const failures: string[] = [];
  try {
    const deleted = hooks.deleteContainerApps();
    if (deleted.some((row) => row.endsWith('FAILED'))) failures.push(`container deletion: ${deleted.join(', ')}`);
  } catch (error) { failures.push(`container deletion: ${describeThrown({ cause: error })}`); }
  const absent = await awaitContainerAppAbsent(hooks.listContainerApps, hooks.sleep);
  if (!absent) failures.push(`container application still present after ${CONTAINER_APP_ABSENCE_ATTEMPTS} checks`);
  try {
    if (!hooks.deleteWorker()) failures.push('Worker deletion failed');
  } catch (error) { failures.push(`Worker deletion: ${describeThrown({ cause: error })}`); }
  try { await hooks.removeConfig(); } catch (error) { failures.push(`generated config: ${describeThrown({ cause: error })}`); }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Destroy the runtime while its Worker still exists to receive /destroy,
 *  then release everything account-side — each stage run TWICE inside this
 *  one pass. The second destroy proves the destroy+storage-clear pair
 *  idempotent before anything account-side could remove the Worker and make
 *  that proof impossible; the second release finds application absent,
 *  Worker absent and config gone, proving every step tolerates its own
 *  absence. (The outer signal/finally replay is a guarded no-op via
 *  runTeardownOnce, so THIS is where double-pass idempotence lives.)
 *  Failures from every pass are preserved. */
export async function teardown(
  deployment: Deployment | undefined,
  hooks?: TeardownHooks,
): Promise<void> {
  if (deployment === undefined) return;
  const effective = hooks ?? liveTeardownHooks(deployment);
  const failures: string[] = [];
  for (const pass of [1, 2] as const) {
    try { await effective.destroyRuntime(); } catch (error) { failures.push(`destroy pass ${pass}: ${describeThrown({ cause: error })}`); }
  }
  for (const pass of [1, 2] as const) {
    try { await releaseResources(effective); } catch (error) { failures.push(`release pass ${pass}: ${describeThrown({ cause: error })}`); }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

function hasWranglerAuth(): boolean {
  return !runWrangler(REPO_ROOT, ['whoami'], { allowFailure: true }).startsWith(WRANGLER_FAILED);
}

/** The immutable record of one run. Cells survive only under a proven image
 *  identity: a mismatched container measured the wrong platform, so every
 *  stage cell is censored and the verdict names the mismatch instead. */
export function composeFuseProbeArtifact(input: {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly workerName: string;
  readonly identity?: RunIdentity;
  readonly writableImage?: string;
  readonly stage1?: Stage1Report;
  readonly stage2?: Stage2Report;
  readonly stage3?: Stage3Report;
  readonly writableControls?: readonly WritableMmapControl[];
  readonly failure?: string;
  readonly cleanupFailure?: string;
}): FuseProbeArtifact {
  const mismatch = imageMismatchVerdict(input.identity);
  const censored = mismatch !== undefined;
  const stage1 = censored ? undefined : input.stage1;
  const stage2 = censored ? undefined : input.stage2;
  const stage3 = censored ? undefined : input.stage3;
  const readOnlyVerdict = censored
    ? mismatch
    : classifyRun(stage1, stage2, input.failure);
  const writableMmap = censored
    ? mismatch
    : classifyWritableMmap(stage3);
  const writableControls = censored ? [] : [...(input.writableControls ?? [])];
  const controlsVerdict = censored
    ? mismatch
    : classifyWritableMmapControls(writableControls);
  const writableVerdict = writableMmap.outcome === 'pass' ? controlsVerdict : writableMmap;
  return {
    schemaVersion: 1,
    command: 'bun scripts/bench-fuse-probe.ts --run',
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    workerName: input.workerName,
    verdict: writableVerdict.outcome === 'pass' ? readOnlyVerdict : writableVerdict,
    materialization: censored || stage1 === undefined
      ? (mismatch ?? {
          outcome: 'no_go',
          noGo: [{ kind: 'runtime-crash', detail: input.failure ?? 'probe produced no stage1 evidence' }],
          detections: [],
        })
      : classifyMaterialization(stage1.openat2),
    writableMmap,
    writableControls,
    identity: input.identity,
    writableImage: input.writableImage,
    stage1,
    stage2,
    stage3,
    failure: input.failure,
    cleanupFailure: input.cleanupFailure,
  };
}

/** The retained process has its own bounded watchdog. The driver itself has no
 * elapsed deadline and polls until the provider records this process exit. */
export function writableProbeCommand(mutation?: WritableMmapMutation): string {
  const arg = mutation === undefined ? '' : ` --mutation=${mutation}`;
  return `timeout -k 5s 90s /usr/local/bin/fuse-mmap-probe${arg}; code=$?; `
    + 'for f in /tmp/fuse-mmap-probe.*/events.ndjson; do '
    + 'if test -f "$f"; then echo "=== $f ===" >&2; cat "$f" >&2; fi; '
    + 'done; exit "$code"';
}

/** Deterministic operation identity gives a redriven driver the same durable
 * process record, rather than a second concurrent writable probe. */
export function writableProbeOperationId(runId: string, mutation?: WritableMmapMutation): string {
  return `fuse-${runId}-${mutation ?? 'positive'}`;
}

/** Start once and observe until the provider settles it. There is deliberately
 * no elapsed deadline: stage three's process is the authority on completion.
 * Only a signal or the explicit teardown changes that outcome. */
export async function awaitWritableMmapResult(
  deployment: Deployment,
  operationId: string,
  mutation: WritableMmapMutation | undefined = undefined,
  doFetch: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<WritableMmapEvidence> {
  const started = await request(
    deployment.origin,
    deployment.token,
    '/start',
    { operationId, command: writableProbeCommand(mutation) },
    ProcessStartSchema,
    doFetch,
  );
  if (started.operationId !== operationId) {
    throw new Error(`/start returned operation ${started.operationId}, expected ${operationId}`);
  }
  for (;;) {
    const polled = await request(
      deployment.origin,
      deployment.token,
      '/poll',
      { operationId },
      ProcessPollSchema,
      doFetch,
    );
    if (polled.operationId !== operationId) {
      throw new Error(`/poll returned operation ${polled.operationId}, expected ${operationId}`);
    }
    if (polled.exitCode === null) {
      if (polled.status !== 'starting' && polled.status !== 'running') {
        throw new Error(`writable mmap process ${operationId} settled without an exit code`);
      }
      await sleep(250);
      continue;
    }
    if (polled.stdout === undefined || polled.stderr === undefined) {
      throw new Error(`writable mmap process ${operationId} settled without complete logs`);
    }
    const result: ExecResponse = {
      exitCode: polled.exitCode,
      stdout: polled.stdout,
      stderr: polled.stderr,
    };
    return parseWritableMmapEvidence(result);
  }
}

async function runWritableProbe(
  deployment: Deployment,
  operationId: string,
  mutation?: WritableMmapMutation,
): Promise<WritableMmapEvidence> {
  return awaitWritableMmapResult(deployment, operationId, mutation);
}

export async function run(): Promise<FuseProbeArtifact> {
  const token = process.env.FUSE_PROBE_TOKEN ?? randomUUID();
  const runId = randomUUID().slice(0, 12);
  const startedAt = new Date().toISOString();
  let deployment: Deployment | undefined;
  let identity: RunIdentity | undefined;
  let stage1: Stage1Report | undefined;
  let stage2: Stage2Report | undefined;
  const writableControls: WritableMmapControl[] = [];
  let stage3: Stage3Report | undefined;
  let writableImage: string | undefined;
  let failure: string | undefined;
  let cleanupFailure: string | undefined;
  try {
    writableImage = requireWritableProbeImage();
    deployment = await deploy(runId, token, writableImage);
    publishTeardown(async () => { await teardown(deployment); });
    console.log(`fuse probe origin ${deployment.origin}`);
    await awaitFixtureReady(deployment.origin, token);
    await setupExec(deployment.origin, token, 'mkdir -p /tmp/fuse-probe');
    identity = await request(deployment.origin, token, '/prepare', {}, RunIdentitySchema);
    if (identity.actualVersion !== SANDBOX_IMAGE_VERSION) {
      throw new Error(`container identity mismatch: reports SANDBOX_VERSION ${identity.actualVersion}, configured ${SANDBOX_IMAGE_VERSION}`);
    }

    // C exits 86 for a proved NO_GO; preserve that report instead of treating
    // it as an infrastructure crash.
    const positive = await runWritableProbe(deployment, writableProbeOperationId(runId));
    stage3 = positive.report;
    const writableSource = await readFile(join(FIXTURE_DIR, 'writable-probe.c'));
    const sourceHasher = new Bun.CryptoHasher('sha256');
    sourceHasher.update(writableSource);
    const expectedSourceDigest = sourceHasher.digest('hex');
    if (stage3.protocol.kernelHeader?.headers.sourceSha256 !== expectedSourceDigest) {
      throw new Error('custom writable probe source digest does not match the reviewed fixture source');
    }
    for (const mutation of [
      'reply-before-log',
      'fence-closes-request-loop',
      'omit-msync',
      'post-fence-contamination',
      'intent-fsync-failure',
      'result-fsync-failure',
      'restart-truncation',
      'skip-recovery',
    ] as const satisfies readonly WritableMmapMutation[]) {
      const evidence = await runWritableProbe(deployment, writableProbeOperationId(runId, mutation), mutation);
      const report = evidence.report;
      const verdict = classifyWritableMmap(report);
      if (evidence.exitCode !== 86 || report.mutation !== mutation || report.linearizable
          || report.protocol.kernelHeader?.headers.sourceSha256 !== expectedSourceDigest
          || verdict.outcome !== 'no_go') {
        throw new Error(`writable negative control ${mutation} did not produce its exit-86 refusal evidence`);
      }
      writableControls.push({ mutation, exitCode: evidence.exitCode, report, verdict });
    }

    await uploadProbeBundle(deployment.origin, token);
    const first = await exec(deployment.origin, token, 'bun /tmp/fuse-probe/probe.mjs stage1', 300_000);
    stage1 = parseExecReport('stage1', first, Stage1ReportSchema);
    if (stage1.rangeReads.some((record) => !record.verified)) {
      throw new Error('reference range read returned bytes that failed its shared-contract digest');
    }

    await stopAndProveRestart(deployment.origin, token);
    await setupExec(deployment.origin, token, 'mkdir -p /tmp/fuse-probe');
    const restartedIdentity = await request(deployment.origin, token, '/prepare', {}, RunIdentitySchema);
    if (restartedIdentity.actualVersionDigest !== identity.actualVersionDigest) {
      throw new Error('container restart changed the measured image identity');
    }
    await uploadProbeBundle(deployment.origin, token);
    const second = await exec(deployment.origin, token, 'bun /tmp/fuse-probe/probe.mjs stage2', 180_000);
    stage2 = parseExecReport('stage2', second, Stage2ReportSchema);
  } catch (error) {
    failure = describeThrown({ cause: error });
  } finally {
    try { await runTeardownOnce(); } catch (error) { cleanupFailure = describeThrown({ cause: error }); }
  }

  const artifact = composeFuseProbeArtifact({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    workerName: deployment?.workerName ?? `kinu-fuse-probe-${runId}`,
    identity,
    writableImage,
    stage1,
    stage2,
    stage3,
    writableControls,
    failure,
    cleanupFailure,
  });
  const output = await persistFuseProbeArtifact(ARTIFACT_DIR, artifact);
  console.log(`${artifact.verdict.outcome.toUpperCase()} ${output}`);
  return artifact;
}

async function main(): Promise<number> {
  const arg = process.argv[2] ?? '--plan';
  if (arg === '--plan') { console.log(planText()); return 0; }
  if (arg !== '--run') throw new Error('usage: bun scripts/bench-fuse-probe.ts --plan|--run');
  if (!hasWranglerAuth()) {
    console.log(`${planText()}\nno wrangler authentication: deployment intentionally not attempted`);
    return 0;
  }
  armSignalTeardown(console.log);
  try { await run(); return 0; } finally { await runTeardownOnce(); }
}

if (import.meta.main) process.exit(await main());
