#!/usr/bin/env bun
/**
 * Deployed lane 0 measurement driver.
 *
 * Usage:
 *   bun packages/devbox/bench/measure-first/probe.ts --run [--run-id ID]
 *
 * The driver writes its planned resources before it creates one, builds the
 * exact image pinned by `scripts/bench-devbox-strategies.ts`, deploys one
 * token-guarded Sandbox fixture, records every raw sample under
 * `bench-artifacts/`, then tears the fixture down. Cleanup is replayable from a
 * signal and is part of the artifact: the container application, Worker,
 * bucket and temp build directory are each probed absent.
 *
 * The probe makes no product change. Candidate binaries are the checked-in
 * journal daemon transformed by exact anchors in `candidate-daemon.ts` and
 * compiled beside today's unchanged binary inside the throwaway image.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';

import {
  WRANGLER_FAILED,
  armSignalTeardown,
  containerAppIds,
  containerApplicationName,
  delay,
  deleteContainerApps,
  deleteFixtureWorker,
  describeThrown,
  publishTeardown,
  runTeardownOnce,
  runWrangler,
  wranglerProvesAbsence,
} from '../../../../scripts/fixtures/r2-bench/deploy-substrate';
import { candidateDaemonSource } from './candidate-daemon';

const FIXTURE_DIR = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(FIXTURE_DIR, '../../../..');
const DAEMON_DIR = join(REPO_ROOT, 'packages/devbox/bench/journal-daemon');
const DAEMON_SOURCE = join(DAEMON_DIR, 'journal-daemon.c');
const DAEMON_DOCKERFILE = join(DAEMON_DIR, 'Dockerfile');
const DECISIVE_SOURCE = join(REPO_ROOT, 'scripts/fixtures/r2-bench/decisive.ts');
const CONTAINER_SOURCE = join(FIXTURE_DIR, 'container.ts');
const IMAGE_TAG = 'docker.io/cloudflare/sandbox:0.12.8';
const IMAGE_DIGEST = 'sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f';
const IMAGE = `docker.io/cloudflare/sandbox@${IMAGE_DIGEST}`;
const RUNS = 3;
const MiB = 1024 * 1024;
const ROOT = '/var/tmp/kinu-measure-first';
const STORE_MOUNT = `${ROOT}/r2`;
/** The s3fs mount prefix (leading slash, as the SDK validates it) and the R2
 *  key prefix it maps to (no leading slash): the egress handler composes
 *  bucket keys as `${mountPrefix}/${key}`. */
const STORE_PREFIX = '/measure';
const STORE_KEY_PREFIX = 'measure';
const CONTAINER_HELPER = '/var/tmp/kinu-measure-first/container.ts';
const DECISIVE_HELPER = '/var/tmp/kinu-measure-first/decisive.ts';
const REQUEST_TIMEOUT_MS = 370_000;

const log = (message: string): void => { process.stderr.write(`[measure-first] ${message}\n`); };
armSignalTeardown(log);

interface Options {
  readonly run: boolean;
  readonly keep: boolean;
  readonly runId: string;
  /** Second pass: measure only the R2 cells and import the first pass's
   *  filesystem, write-path and fence samples from that run's artifact. */
  readonly onlyR2: boolean;
  readonly r2Artifact: string | null;
}

function options(argv: readonly string[]): Options {
  const at = argv.indexOf('--run-id');
  const generated = `m${new Date().toISOString().replace(/\D/g, '').slice(4, 14)}`;
  const runId = at === -1 ? generated : argv[at + 1] ?? '';
  if (!/^[a-z0-9][a-z0-9-]{2,22}$/.test(runId)) {
    throw new Error('--run-id must be 3-23 lowercase letters, digits or hyphens');
  }
  const r2At = argv.indexOf('--with-fs-artifact');
  return {
    run: argv.includes('--run'), keep: argv.includes('--keep'), runId,
    onlyR2: argv.includes('--only-r2'), r2Artifact: r2At === -1 ? null : argv[r2At + 1] ?? null,
  };
}

interface Deployment {
  readonly origin: string;
  readonly token: string;
  readonly worker: string;
  readonly bucket: string;
  readonly containerApp: string;
  readonly configPath: string;
  readonly buildDir: string;
  readonly workerVersion: string;
}

interface RequestBody {
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly path?: string;
  readonly content?: string;
  readonly processId?: string;
  readonly prefix?: string;
  readonly key?: string;
}

interface ExecReply {
  readonly ok?: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly ms?: number;
}

const AckSchema = v.looseObject({
  ok: v.optional(v.boolean()), error: v.optional(v.string()), purged: v.optional(v.number()),
});
const ExecSchema: v.GenericSchema<ExecReply> = v.looseObject({
  ok: v.optional(v.boolean()), exitCode: v.optional(v.number()), stdout: v.optional(v.string()),
  stderr: v.optional(v.string()), error: v.optional(v.string()), ms: v.optional(v.number()),
});
const IoSchema = v.looseObject({ iops: v.number(), bw_bytes: v.number() });
const FioSchema = v.looseObject({
  jobs: v.array(v.looseObject({ read: IoSchema, write: IoSchema })),
});
const SummarySchema = v.looseObject({
  ops: v.number(), meanUs: v.optional(v.number()), p50Us: v.number(), p95Us: v.number(), maxUs: v.number(),
  sumUs: v.optional(v.number()),
});
const FsyncSchema = v.looseObject({
  ops: v.number(), pwrite: SummarySchema, fdatasync: SummarySchema, pair: SummarySchema,
});
const MetaSchema = v.looseObject({
  count: v.number(), readdirEntries: v.number(), readdirUs: v.number(), stat: SummarySchema,
});
const SmallStatSchema = v.looseObject({
  count: v.number(), listed: v.number(), readdirMs: v.number(), statWallMs: v.number(),
});
const DecisiveSchema = v.looseObject({
  treeBytes: v.number(),
  segments: v.array(v.looseObject({ name: v.string(), bytesWritten: v.number(), wallMs: v.number() })),
});
const CapabilitySchema = v.looseObject({
  protoMajor: v.number(), protoMinor: v.number(), capable: v.number(), capableExt: v.number(),
  passthrough: v.boolean(), directIoAllowMmap: v.boolean(), caps: v.array(v.string()),
});
const RangeSchema = v.looseObject({
  rangeBytes: v.number(), concurrency: v.number(), requests: v.number(), bytes: v.number(), wallMs: v.number(),
  p50Ms: v.number(), p95Ms: v.number(), meanMs: v.number(), maxMs: v.number(), mibPerSec: v.number(),
  failures: v.optional(v.number()),
});
const HeaderSchema = v.looseObject({ name: v.string(), value: v.string() });
const PutSchema = v.looseObject({
  key: v.string(), bytes: v.number(), ms: v.number(), status: v.number(), sha256Hex: v.string(),
  mibPerSec: v.number(), responseHeaders: v.array(HeaderSchema), bodyText: v.string(),
});
const StoreHeadSchema = v.looseObject({
  ok: v.boolean(), key: v.string(), exists: v.boolean(), size: v.optional(v.number()),
  etag: v.optional(v.string()), httpEtag: v.optional(v.string()), uploaded: v.optional(v.string()),
  checksums: v.optional(v.looseObject({
    md5: v.nullable(v.string()), sha1: v.nullable(v.string()), sha256: v.nullable(v.string()),
    sha384: v.nullable(v.string()), sha512: v.nullable(v.string()),
  })),
});
const DaemonReplySchema = v.looseObject({ op: v.string(), ms: v.number(), reply: v.looseObject({ ok: v.boolean() }) });

async function call<TSchema extends v.GenericSchema>(
  deployment: Deployment, method: 'GET' | 'POST', path: string, schema: TSchema,
  input?: RequestBody, timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<v.InferOutput<TSchema>> {
  const headers = new Headers({ authorization: `Bearer ${deployment.token}` });
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (input !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(input);
  }
  const response = await fetch(`${deployment.origin}${path}`, init);
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`${method} ${path} returned non-JSON (${String(response.status)}): ${text.slice(0, 300)}`, { cause: error });
  }
  const parsed = v.safeParse(schema, decoded);
  if (!parsed.success) {
    throw new Error(`${method} ${path} reply did not match its contract: ${parsed.issues[0]?.message ?? 'invalid reply'}; ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${String(response.status)}): ${text.slice(0, 300)}`);
  }
  return parsed.output;
}

async function exec(deployment: Deployment, command: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ExecReply> {
  const reply = await call(deployment, 'POST', '/exec', ExecSchema, { command, timeoutMs }, timeoutMs + 10_000);
  if (reply.exitCode !== 0) {
    throw new Error(`container command failed (${String(reply.exitCode)}): ${command}\n${reply.stderr ?? reply.error ?? reply.stdout ?? ''}`);
  }
  return reply;
}

function parseOutput<TSchema extends v.GenericSchema>(
  reply: ExecReply, schema: TSchema, what: string, lastLine = false,
): v.InferOutput<TSchema> {
  const stdout = reply.stdout ?? '';
  const text = lastLine ? stdout.trimEnd().split('\n').at(-1) ?? '' : stdout;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} emitted invalid JSON: ${stdout.slice(0, 500)}`, { cause: error });
  }
  return v.parse(schema, decoded);
}

async function execJson<TSchema extends v.GenericSchema>(
  deployment: Deployment, command: string, schema: TSchema, what: string, lastLine = false,
): Promise<v.InferOutput<TSchema>> {
  return parseOutput(await exec(deployment, command), schema, what, lastLine);
}

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function configFor(worker: string, bucket: string, token: string, dockerfilePath: string): string {
  return `${JSON.stringify({
    $schema: join(REPO_ROOT, 'node_modules/wrangler/config-schema.json'),
    name: worker,
    main: join(FIXTURE_DIR, 'worker.ts'),
    account_id: 'f44999d1ddda7012e9a87729eba250f1',
    compatibility_date: '2025-12-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    durable_objects: { bindings: [{ class_name: 'MeasureBox', name: 'MeasureBox' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['MeasureBox'] }],
    containers: [{
      class_name: 'MeasureBox', image: dockerfilePath, max_instances: 1,
      instance_type: { vcpu: 2, memory_mib: 6144, disk_mb: 8000 },
    }],
    vars: { SANDBOX_TRANSPORT: 'rpc', MEASURE_TOKEN: token },
    r2_buckets: [{ binding: 'BACKUP_BUCKET', bucket_name: bucket }],
  }, null, 2)}\n`;
}

interface BuildOutput {
  readonly buildDir: string;
  readonly configPath: string;
  readonly dockerfileSha256: string;
  readonly candidateDaemonSha256: string;
  readonly containerHelperSha256: string;
}

function prepareBuild(runId: string, worker: string, bucket: string, token: string): BuildOutput {
  const buildDir = `/tmp/kinu-devbox-measure-${runId}`;
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  for (const name of ['fuse-caps.c', 'metabench.c', 'rangeread.c', 'fsyncbench.c'] as const) {
    copyFileSync(join(FIXTURE_DIR, name), join(buildDir, name));
  }
  copyFileSync(DAEMON_SOURCE, join(buildDir, 'journal-daemon.c'));
  const original = readFileSync(DAEMON_SOURCE, 'utf8');
  const candidate = candidateDaemonSource(original);
  writeFileSync(join(buildDir, 'journal-daemon-candidate.c'), candidate);
  const recipe = readFileSync(DAEMON_DOCKERFILE, 'utf8');
  const firstLine = `FROM ${IMAGE_TAG}\n`;
  if (!recipe.startsWith(firstLine)) throw new Error(`daemon recipe must start with ${firstLine.trim()}`);
  const dockerfile = `FROM ${IMAGE}\n${recipe.slice(firstLine.length)}\n${readFileSync(join(FIXTURE_DIR, 'Dockerfile.tail'), 'utf8')}\n`;
  const dockerfilePath = join(buildDir, 'Dockerfile');
  writeFileSync(dockerfilePath, dockerfile);
  const configPath = join(buildDir, 'wrangler.jsonc');
  writeFileSync(configPath, configFor(worker, bucket, token, dockerfilePath));
  return {
    buildDir, configPath, dockerfileSha256: sha256(dockerfile), candidateDaemonSha256: sha256(candidate),
    containerHelperSha256: sha256(readFileSync(CONTAINER_SOURCE)),
  };
}

async function awaitReady(deployment: Deployment): Promise<void> {
  // Prove the public endpoint is closed first.
  const unauth = await fetch(`${deployment.origin}/health`, { signal: AbortSignal.timeout(15_000) });
  if (unauth.status === 200) throw new Error('fixture answered an unauthenticated request');
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    try {
      const response = await fetch(`${deployment.origin}/health`, {
        headers: { authorization: `Bearer ${deployment.token}` }, signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 200) break;
    } catch (error) {
      log(`health observation ${String(attempt)} did not answer: ${describeThrown({ cause: error })}`);
    }
    if (attempt === 18) throw new Error('fixture never accepted its run token');
    await delay(3_000);
  }
  // The Worker may be ready before its container application is provisioned.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await exec(deployment, 'true', 60_000);
      return;
    } catch (error) {
      log(`container readiness observation ${String(attempt)}: ${describeThrown({ cause: error })}`);
      if (attempt === 12) throw error;
      await delay(3_000);
    }
  }
}

async function deploy(runId: string): Promise<{ deployment: Deployment; build: BuildOutput }> {
  const worker = `kinu-db-measure-${runId}`;
  const bucket = worker;
  const token = randomUUID();
  const build = prepareBuild(runId, worker, bucket, token);
  runWrangler(REPO_ROOT, ['r2', 'bucket', 'create', bucket]);
  const output = runWrangler(REPO_ROOT, ['deploy', '--config', build.configPath]);
  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  const workerVersion = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(output)?.[1];
  if (origin === undefined || workerVersion === undefined) {
    throw new Error(`deploy output omitted origin or version: ${output.slice(-2_000)}`);
  }
  const deployment = {
    origin, token, worker, bucket, containerApp: containerApplicationName(worker, 'MeasureBox'),
    configPath: build.configPath, buildDir: build.buildDir, workerVersion,
  };
  await awaitReady(deployment);
  return { deployment, build };
}

interface FsSample {
  readonly variant: string;
  readonly run: number;
  readonly randomWriteIops: number;
  readonly randomReadIops: number;
  readonly sequentialWriteMiBps: number;
  readonly sequentialReadMiBps: number;
  readonly smallStat1kMs: number;
  readonly smallReaddir1kMs: number;
  readonly stat10kMs: number;
  readonly readdir10kMs: number;
  readonly sqliteRewriteMs: number;
  readonly fsyncP50Us: number;
  readonly fsyncP95Us: number;
  readonly writeFsyncPairP50Us: number;
}

interface WritePathSample {
  readonly variant: string;
  readonly run: number;
  readonly randomWriteIops: number;
}

interface FenceSample {
  readonly variant: string;
  readonly dirtyBytes: number;
  readonly run: number;
  readonly ms: number;
}

interface RangeSample {
  readonly path: 'direct-http' | 's3fs';
  readonly rangeBytes: number;
  readonly concurrency: number;
  readonly run: number;
  readonly requests: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly mibPerSec: number;
}

interface PutSample {
  readonly run: number;
  readonly receipt: v.InferOutput<typeof PutSchema>;
  readonly stored: v.InferOutput<typeof StoreHeadSchema>;
}

interface Identity {
  readonly raw: string;
  readonly unameR: string;
  readonly capabilities: v.InferOutput<typeof CapabilitySchema>;
}

interface CleanupEvidence {
  purgeReplies: string[];
  destroyReplies: string[];
  containerApplicationsAbsent: boolean;
  workerAbsent: boolean;
  bucketAbsent: boolean;
  localBuildAbsent: boolean;
  errors: string[];
}

interface Artifact {
  meta: {
    runId: string;
    startedAt: string;
    finishedAt: string | null;
    repoCommit: string;
    image: string;
    imageDigest: string;
    worker: string;
    bucket: string;
    containerApp: string;
    workerVersion: string | null;
    dockerfileSha256: string | null;
    candidateDaemonSha256: string | null;
    containerHelperSha256: string | null;
  };
  identity: Identity | null;
  filesystem: FsSample[];
  writePath: WritePathSample[];
  fence: FenceSample[];
  directPut32MiB: PutSample[];
  rangeGets: RangeSample[];
  rangeFixturePut: v.InferOutput<typeof PutSchema> | null;
  cleanup: CleanupEvidence | null;
  errors: string[];
}

function fioCommand(name: string, filename: string, args: string): string {
  return `fio --name=${name} --filename=${filename} --ioengine=psync --iodepth=1 --thread --group_reporting --output-format=json ${args}`;
}

async function fio(
  deployment: Deployment, name: string, filename: string, args: string,
): Promise<v.InferOutput<typeof FioSchema>> {
  return await execJson(deployment, fioCommand(name, filename, args), FioSchema, name);
}

async function startDaemon(deployment: Deployment, variant: string, binary: string): Promise<{
  root: string; mount: string; state: string; socket: string;
}> {
  const base = `${ROOT}/${variant}`;
  const root = `${base}/root`;
  const mount = `${base}/mount`;
  const state = `${base}/state`;
  const socket = `${state}/control.sock`;
  await exec(deployment, `rm -rf '${base}' && mkdir -p '${root}' '${mount}' '${state}'`);
  await call(deployment, 'POST', '/start', AckSchema, {
    processId: `daemon-${variant}`,
    command: `exec '${binary}' --root '${root}' --mount '${mount}' --state '${state}' --socket '${socket}' >'${base}/daemon.log' 2>&1`,
  });
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const mounted = await call(deployment, 'POST', '/exec', ExecSchema, {
      command: `mountpoint -q '${mount}'`, timeoutMs: 30_000,
    }, 40_000);
    if (mounted.exitCode === 0) return { root, mount, state, socket };
    if (attempt === 20) {
      const logs = await exec(deployment, `cat '${base}/daemon.log' 2>/dev/null || true`);
      throw new Error(`${variant} did not mount: ${logs.stdout ?? logs.stderr ?? ''}`);
    }
    await delay(250);
  }
  throw new Error(`${variant} did not mount`);
}

async function stopDaemon(deployment: Deployment, variant: string, socket: string): Promise<void> {
  await execJson(deployment, `bun '${CONTAINER_HELPER}' daemon '${socket}' stop`, DaemonReplySchema, `${variant} stop`, true);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const reply = await call(deployment, 'POST', '/exec', ExecSchema, {
      command: `mountpoint -q '${ROOT}/${variant}/mount'`, timeoutMs: 30_000,
    }, 40_000);
    if (reply.exitCode !== 0) return;
    await delay(250);
  }
  throw new Error(`${variant} stayed mounted after stop`);
}

async function measureFilesystem(
  deployment: Deployment, variant: string, binary: string | null, output: FsSample[],
): Promise<void> {
  const base = `${ROOT}/${variant}`;
  let root = base;
  let mount = base;
  let socket: string | null = null;
  await exec(deployment, `rm -rf '${base}' && mkdir -p '${base}'`);
  if (binary !== null) {
    const started = await startDaemon(deployment, variant, binary);
    root = started.root;
    mount = started.mount;
    socket = started.socket;
  }
  try {
    // Seed beneath FUSE, as restore does. Dense bytes prevent sparse-file read
    // shortcuts. Both read files stay resident and are warmed before every run.
    await exec(deployment,
      `dd if=/dev/zero of='${root}/randread.bin' bs=1M count=64 conv=fdatasync status=none && `
      + `dd if=/dev/zero of='${root}/seqread.bin' bs=1M count=512 conv=fdatasync status=none && `
      + `truncate -s 64M '${root}/randwrite.bin'`,
    );
    for (let run = 1; run <= RUNS; run += 1) {
      log(`${variant}: filesystem run ${String(run)}/${String(RUNS)}`);
      const randomWrite = await fio(deployment, `${variant}-rw-${String(run)}`, `${mount}/randwrite.bin`,
        '--rw=randwrite --bs=4k --size=64m --time_based=1 --runtime=10 --ramp_time=1 --direct=0 --norandommap=1 --randrepeat=0 --allow_file_create=0');
      await exec(deployment, `cat '${mount}/randread.bin' >/dev/null`);
      const randomRead = await fio(deployment, `${variant}-rr-${String(run)}`, `${mount}/randread.bin`,
        '--rw=randread --bs=4k --size=64m --time_based=1 --runtime=10 --ramp_time=1 --direct=0 --invalidate=0 --norandommap=1 --randrepeat=0 --allow_file_create=0');
      const sequentialWrite = await fio(deployment, `${variant}-sw-${String(run)}`, `${mount}/seqwrite.bin`,
        '--rw=write --bs=1m --size=512m --direct=0 --end_fsync=1');
      await exec(deployment, `cat '${mount}/seqread.bin' >/dev/null`);
      const sequentialRead = await fio(deployment, `${variant}-sr-${String(run)}`, `${mount}/seqread.bin`,
        '--rw=read --bs=1m --size=512m --direct=0 --invalidate=0 --allow_file_create=0');

      const smallDir = `${mount}/small-${String(run)}`;
      await exec(deployment, `mkdir -p '${smallDir}'`);
      const small = await execJson(deployment,
        `bun '${CONTAINER_HELPER}' smallstat '${smallDir}' 1000`, SmallStatSchema, `${variant} small-stat`, true);
      await exec(deployment, `rm -rf '${smallDir}'`);

      const metaDir = `${mount}/meta-${String(run)}`;
      await exec(deployment, `mkdir -p '${metaDir}'`);
      const meta = await execJson(deployment,
        `metabench '${metaDir}' 10000 256`, MetaSchema, `${variant} metadata`, true);
      await exec(deployment, `rmdir '${metaDir}'`);

      const sqliteDir = `${mount}/sqlite-${String(run)}`;
      await execJson(deployment,
        `bun '${DECISIVE_HELPER}' --root '${sqliteDir}' --workload sqlite --seed ${String(20260902 + run)} --segment 0 --size-mib 64 --segments 4`,
        DecisiveSchema, `${variant} sqlite fill`, true);
      const sqlite = await execJson(deployment,
        `bun '${DECISIVE_HELPER}' --root '${sqliteDir}' --workload sqlite --seed ${String(20260902 + run)} --segment 1 --size-mib 64 --segments 4`,
        DecisiveSchema, `${variant} sqlite rewrite`, true);
      await exec(deployment, `rm -rf '${sqliteDir}'`);

      const sync = await execJson(deployment,
        `fsyncbench '${mount}/fsync-${String(run)}.bin' 128`, FsyncSchema, `${variant} fsync`, true);
      const jobWrite = randomWrite.jobs[0];
      const jobRead = randomRead.jobs[0];
      const jobSeqWrite = sequentialWrite.jobs[0];
      const jobSeqRead = sequentialRead.jobs[0];
      const rewrite = sqlite.segments[0];
      if (jobWrite === undefined || jobRead === undefined || jobSeqWrite === undefined || jobSeqRead === undefined || rewrite === undefined) {
        throw new Error(`${variant} returned an empty fio or sqlite result`);
      }
      output.push({
        variant, run,
        randomWriteIops: jobWrite.write.iops,
        randomReadIops: jobRead.read.iops,
        sequentialWriteMiBps: jobSeqWrite.write.bw_bytes / MiB,
        sequentialReadMiBps: jobSeqRead.read.bw_bytes / MiB,
        smallStat1kMs: small.statWallMs,
        smallReaddir1kMs: small.readdirMs,
        stat10kMs: (meta.stat.sumUs ?? 0) / 1_000,
        readdir10kMs: meta.readdirUs / 1_000,
        sqliteRewriteMs: rewrite.wallMs,
        fsyncP50Us: sync.fdatasync.p50Us,
        fsyncP95Us: sync.fdatasync.p95Us,
        writeFsyncPairP50Us: sync.pair.p50Us,
      });
    }
  } finally {
    if (socket !== null) await stopDaemon(deployment, variant, socket);
    await exec(deployment, `rm -rf '${base}'`);
  }
}

async function measureNoFsyncWritePath(deployment: Deployment, output: WritePathSample[]): Promise<void> {
  const variant = 'no-wal-fsync';
  const started = await startDaemon(deployment, variant, '/usr/local/bin/jd-nofsync');
  try {
    await exec(deployment, `truncate -s 64M '${started.root}/randwrite.bin'`);
    for (let run = 1; run <= RUNS; run += 1) {
      const result = await fio(deployment, `${variant}-${String(run)}`, `${started.mount}/randwrite.bin`,
        '--rw=randwrite --bs=4k --size=64m --time_based=1 --runtime=10 --ramp_time=1 --direct=0 --norandommap=1 --randrepeat=0 --allow_file_create=0');
      const job = result.jobs[0];
      if (job === undefined) throw new Error('no-fsync fio returned no job');
      output.push({ variant, run, randomWriteIops: job.write.iops });
    }
  } finally {
    await stopDaemon(deployment, variant, started.socket);
    await exec(deployment, `rm -rf '${ROOT}/${variant}'`);
  }
}

async function measureFence(deployment: Deployment, output: FenceSample[]): Promise<void> {
  const variant = 'today-400m-tree';
  const started = await startDaemon(deployment, variant, '/usr/local/bin/kinu-journal-daemon');
  try {
    await exec(deployment, `dd if=/dev/zero of='${started.root}/tree.bin' bs=1M count=400 conv=fdatasync status=none`);
    for (const dirtyBytes of [64 * 1024, 4 * MiB, 64 * MiB]) {
      for (let run = 1; run <= RUNS; run += 1) {
        await exec(deployment,
          `dd if=/dev/zero of='${started.mount}/tree.bin' bs=${String(dirtyBytes)} count=1 conv=notrunc status=none`,
        );
        const fenced = await execJson(deployment,
          `bun '${CONTAINER_HELPER}' daemon '${started.socket}' fence`, DaemonReplySchema,
          `fence ${String(dirtyBytes)} run ${String(run)}`, true);
        output.push({ variant, dirtyBytes, run, ms: fenced.ms });
        await exec(deployment, `rm -rf '${started.state}'/stage-* '${started.state}'/fence-*`);
      }
    }
  } finally {
    await stopDaemon(deployment, variant, started.socket);
    await exec(deployment, `rm -rf '${ROOT}/${variant}'`);
  }
}

function requestCount(rangeBytes: number, concurrency: number): number {
  if (rangeBytes === 64 * 1024) return Math.max(64, concurrency * 4);
  if (rangeBytes === MiB) return Math.max(32, concurrency * 2);
  return Math.max(8, concurrency);
}

async function measureR2(
  deployment: Deployment,
  puts: PutSample[], ranges: RangeSample[],
): Promise<v.InferOutput<typeof PutSchema>> {
  await call(deployment, 'POST', '/mount', AckSchema, { path: STORE_MOUNT, prefix: STORE_PREFIX });
  await exec(deployment, `mountpoint -q '${STORE_MOUNT}' && grep -F ' ${STORE_MOUNT} ' /proc/mounts`);
  for (let run = 1; run <= RUNS; run += 1) {
    const key = `put-32m-run-${String(run)}.bin`;
    const receipt = await execJson(deployment,
      `bun '${CONTAINER_HELPER}' r2 put '${key}' ${String(32 * MiB)} sha256`, PutSchema, `32 MiB PUT ${String(run)}`, true);
    const stored = await call(deployment, 'GET', `/head?key=${encodeURIComponent(`${STORE_KEY_PREFIX}/${key}`)}`, StoreHeadSchema);
    puts.push({ run, receipt, stored });
  }

  const objectBytes = 512 * MiB;
  const key = 'range-512m.bin';
  const fixturePut = await execJson(deployment,
    `bun '${CONTAINER_HELPER}' r2 put '${key}' ${String(objectBytes)} none`, PutSchema, 'range fixture PUT', true);
  await exec(deployment, `test "$(stat -c %s '${STORE_MOUNT}/${key}')" = '${String(objectBytes)}'`);

  for (const rangeBytes of [64 * 1024, MiB, 8 * MiB]) {
    for (const concurrency of [1, 16, 64]) {
      const requests = requestCount(rangeBytes, concurrency);
      for (let run = 1; run <= RUNS; run += 1) {
        log(`R2 ${String(rangeBytes)} bytes x ${String(concurrency)}, run ${String(run)}/${String(RUNS)}`);
        const seed = rangeBytes + concurrency * 101 + run * 1009;
        const direct = await execJson(deployment,
          `bun '${CONTAINER_HELPER}' r2 range '${key}' ${String(objectBytes)} ${String(rangeBytes)} ${String(concurrency)} ${String(requests)} ${String(seed)}`,
          RangeSchema, 'direct range GET', true);
        ranges.push({
          path: 'direct-http', rangeBytes, concurrency, run, requests: direct.requests,
          p50Ms: direct.p50Ms, p95Ms: direct.p95Ms, meanMs: direct.meanMs, maxMs: direct.maxMs,
          mibPerSec: direct.mibPerSec,
        });
        const s3fs = await execJson(deployment,
          `rangeread '${STORE_MOUNT}/${key}' ${String(rangeBytes)} ${String(concurrency)} ${String(requests)} ${String(seed)}`,
          RangeSchema, 's3fs range GET', true);
        ranges.push({
          path: 's3fs', rangeBytes, concurrency, run, requests: s3fs.requests,
          p50Ms: s3fs.p50Ms, p95Ms: s3fs.p95Ms, meanMs: s3fs.meanMs, maxMs: s3fs.maxMs,
          mibPerSec: s3fs.mibPerSec,
        });
      }
    }
  }
  await call(deployment, 'POST', '/unmount', AckSchema, { path: STORE_MOUNT });
  return fixturePut;
}

async function collectIdentity(deployment: Deployment): Promise<Identity> {
  const raw = await exec(deployment,
    'printf "uname-r="; uname -r; printf "proc-version="; cat /proc/version; '
    + 'printf "sandbox-version="; printf "%s\\n" "$SANDBOX_VERSION"; '
    + 'printf "libfuse="; pkg-config --modversion fuse3; '
    + 'printf "fio="; fio --version; printf "s3fs="; s3fs --version 2>&1 | head -1; '
    + 'printf "backing-fs="; stat -f -c %T /var/tmp; printf "cpus="; nproc; '
    + 'printf "memory-kib="; awk \'/MemTotal/{print $2}\' /proc/meminfo; '
    + 'sha256sum /usr/local/bin/kinu-journal-daemon /usr/local/bin/jd-v2 /usr/local/bin/jd-pt',
  );
  await exec(deployment, `mkdir -p '${ROOT}/caps'`);
  const capabilities = await execJson(deployment,
    `fuse-caps '${ROOT}/caps'`, CapabilitySchema, 'FUSE capability probe', true);
  const first = (raw.stdout ?? '').split('\n').find((line) => line.startsWith('uname-r='));
  return { raw: raw.stdout ?? '', unameR: first?.slice('uname-r='.length) ?? '', capabilities };
}

async function installHelpers(deployment: Deployment): Promise<void> {
  await exec(deployment, `mkdir -p '${ROOT}'`);
  await call(deployment, 'POST', '/put', AckSchema, {
    path: CONTAINER_HELPER, content: readFileSync(CONTAINER_SOURCE, 'utf8'),
  });
  await call(deployment, 'POST', '/put', AckSchema, {
    path: DECISIVE_HELPER, content: readFileSync(DECISIVE_SOURCE, 'utf8'),
  });
}

async function probeWorkerAbsent(origin: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) return true;
    } catch (error) {
      // A DNS or transport refusal after account-side deletion is also absence;
      // there is no route left to answer.
      log(`post-delete Worker probe: ${describeThrown({ cause: error })}`);
      return true;
    }
    await delay(2_000);
  }
  return false;
}

async function cleanup(
  planned: { worker: string; bucket: string; containerApp: string; configPath: string; buildDir: string },
  deployment: Deployment | null, keep: boolean,
): Promise<CleanupEvidence> {
  const evidence: CleanupEvidence = {
    purgeReplies: [], destroyReplies: [], containerApplicationsAbsent: false,
    workerAbsent: false, bucketAbsent: false, localBuildAbsent: false, errors: [],
  };
  if (keep) {
    evidence.errors.push('--keep selected: resources deliberately remain');
    return evidence;
  }
  if (deployment !== null) {
    try {
      const purged = await call(deployment, 'POST', '/purge', AckSchema, { prefix: '' });
      evidence.purgeReplies.push(JSON.stringify(purged));
    } catch (error) {
      evidence.errors.push(`purge: ${describeThrown({ cause: error })}`);
    }
    for (const pass of [1, 2]) {
      try {
        const destroyed = await call(deployment, 'POST', '/destroy', AckSchema, {});
        evidence.destroyReplies.push(JSON.stringify(destroyed));
      } catch (error) {
        evidence.errors.push(`destroy pass ${String(pass)}: ${describeThrown({ cause: error })}`);
      }
    }
  }
  try {
    const deleted = deleteContainerApps(REPO_ROOT, [planned.containerApp], log);
    if (deleted.some((row) => row.endsWith('FAILED'))) evidence.errors.push(`container deletion: ${deleted.join(', ')}`);
  } catch (error) {
    evidence.errors.push(`container deletion: ${describeThrown({ cause: error })}`);
  }
  try {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      if (containerAppIds(REPO_ROOT, [planned.containerApp], log).length === 0) {
        evidence.containerApplicationsAbsent = true;
        break;
      }
      await delay(5_000);
    }
  } catch (error) {
    evidence.errors.push(`container absence probe: ${describeThrown({ cause: error })}`);
  }
  try {
    if (!deleteFixtureWorker(REPO_ROOT, planned.configPath, planned.worker, log)) {
      evidence.errors.push('Worker deletion failed');
    }
  } catch (error) {
    evidence.errors.push(`Worker deletion: ${describeThrown({ cause: error })}`);
  }
  if (deployment !== null) evidence.workerAbsent = await probeWorkerAbsent(deployment.origin);
  else evidence.workerAbsent = true;
  let deletedBucket = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', planned.bucket], { allowFailure: true });
  if (!wranglerProvesAbsence(deletedBucket)) {
    await delay(3_000);
    deletedBucket = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', planned.bucket], { allowFailure: true });
  }
  evidence.bucketAbsent = wranglerProvesAbsence(deletedBucket);
  if (!evidence.bucketAbsent) evidence.errors.push(`bucket deletion: ${deletedBucket.slice(0, 300)}`);
  rmSync(planned.buildDir, { recursive: true, force: true });
  evidence.localBuildAbsent = !existsSync(planned.buildDir);
  return evidence;
}

async function main(): Promise<number> {
  const selected = options(process.argv.slice(2));
  const worker = `kinu-db-measure-${selected.runId}`;
  const bucket = worker;
  const containerApp = containerApplicationName(worker, 'MeasureBox');
  const buildDir = `/tmp/kinu-devbox-measure-${selected.runId}`;
  const configPath = join(buildDir, 'wrangler.jsonc');
  const artifactPath = join(REPO_ROOT, 'bench-artifacts', `devbox-measure-first-${selected.runId}.json`);
  if (!selected.run) {
    process.stdout.write(
      `Lane 0 deployed measurement plan\n\nimage       ${IMAGE}\nworker      ${worker}\nbucket      ${bucket}\n`
      + `container   ${containerApp}\nartifact    ${artifactPath}\nruns/cell   ${String(RUNS)}\n\n`
      + 'Nothing has run. Pass --run to deploy and measure.\n',
    );
    return 0;
  }
  if (runWrangler(REPO_ROOT, ['whoami'], { allowFailure: true }).startsWith(WRANGLER_FAILED)) {
    throw new Error('wrangler is not authenticated; no deployed number can be measured');
  }
  mkdirSync(dirname(artifactPath), { recursive: true });
  const artifact: Artifact = {
    meta: {
      runId: selected.runId, startedAt: new Date().toISOString(), finishedAt: null,
      repoCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      image: IMAGE, imageDigest: IMAGE_DIGEST, worker, bucket, containerApp, workerVersion: null,
      dockerfileSha256: null, candidateDaemonSha256: null, containerHelperSha256: null,
    },
    identity: null, filesystem: [], writePath: [], fence: [], directPut32MiB: [], rangeGets: [],
    rangeFixturePut: null, cleanup: null, errors: [],
  };
  const settle = (): void => { writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`); };
  settle(); // The planned resource names exist on disk before the first create.

  let deployment: Deployment | null = null;
  let build: BuildOutput | null = null;
  publishTeardown(async () => {
    artifact.cleanup = await cleanup({ worker, bucket, containerApp, configPath, buildDir }, deployment, selected.keep);
    artifact.meta.finishedAt = new Date().toISOString();
    settle();
  });
  try {
    const started = await deploy(selected.runId);
    deployment = started.deployment;
    build = started.build;
    artifact.meta.workerVersion = deployment.workerVersion;
    artifact.meta.dockerfileSha256 = build.dockerfileSha256;
    artifact.meta.candidateDaemonSha256 = build.candidateDaemonSha256;
    artifact.meta.containerHelperSha256 = build.containerHelperSha256;
    settle();
    log(`deployed ${deployment.origin} at Worker version ${deployment.workerVersion}`);
    await installHelpers(deployment);
    artifact.identity = await collectIdentity(deployment);
    settle();

    if (selected.onlyR2 && selected.r2Artifact !== null) {
      const imported = v.parse(v.looseObject({
        filesystem: v.array(v.any()),
        writePath: v.array(v.any()),
        fence: v.array(v.any()),
      }), JSON.parse(readFileSync(selected.r2Artifact, 'utf8')));
      if (selected.r2Artifact !== null) {
        artifact.filesystem.push(...imported.filesystem);
        artifact.writePath.push(...imported.writePath);
        artifact.fence.push(...imported.fence);
      }
      try {
        artifact.rangeFixturePut = await measureR2(deployment, artifact.directPut32MiB, artifact.rangeGets);
      } catch (error) {
        artifact.errors.push(`R2: ${describeThrown({ cause: error })}`);
    }
      settle();
    } else {
    for (const [variant, binary] of [
      ['native', null],
      ['today', '/usr/local/bin/kinu-journal-daemon'],
      ['v2-keep-cache', '/usr/local/bin/jd-v2'],
      ['v2-passthrough', '/usr/local/bin/jd-pt'],
    ] as const) {
      try {
        await measureFilesystem(deployment, variant, binary, artifact.filesystem);
      } catch (error) {
        artifact.errors.push(`${variant}: ${describeThrown({ cause: error })}`);
      }
      settle();
    }
    try {
      await measureNoFsyncWritePath(deployment, artifact.writePath);
    } catch (error) {
      artifact.errors.push(`no-fsync write path: ${describeThrown({ cause: error })}`);
    }
    settle();
    try {
      await measureFence(deployment, artifact.fence);
    } catch (error) {
      artifact.errors.push(`fence: ${describeThrown({ cause: error })}`);
    }
    settle();
    try {
      artifact.rangeFixturePut = await measureR2(deployment, artifact.directPut32MiB, artifact.rangeGets);
    } catch (error) {
      artifact.errors.push(`R2: ${describeThrown({ cause: error })}`);
    }
    settle();
    }
  } catch (error) {
    artifact.errors.push(describeThrown({ cause: error }));
    settle();
  } finally {
    await runTeardownOnce();
  }
  const cleanupOk = artifact.cleanup !== null
    && artifact.cleanup.containerApplicationsAbsent
    && artifact.cleanup.workerAbsent
    && artifact.cleanup.bucketAbsent
    && artifact.cleanup.localBuildAbsent
    && artifact.cleanup.errors.length === 0;
  process.stdout.write(`${artifactPath}\n`);
  return artifact.errors.length === 0 && cleanupOk ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
