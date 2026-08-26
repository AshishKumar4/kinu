import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import {
  BIG_FILE_BYTES, CHUNK_BYTES, RangeReadIntentSchema, RunIdentitySchema, Stage1ReportSchema,
  Stage2ReportSchema, SANDBOX_IMAGE, SANDBOX_IMAGE_VERSION, align8, buildRangeIntent,
  canonicalRange, classifyBootstrap, classifyMaterialization, classifyRun, handleProbeOp,
  imageMismatchVerdict, isAuthorized,
  packDirent, packEntryOut, packOpenHow, packOutHeader, sha256Hex, verifyChunk,
} from './fixtures/fuse-probe/core';
import type { ProbeBox, RunIdentity, Stage1Report, Stage2Report } from './fixtures/fuse-probe/core';
import type { Deployment, TeardownHooks } from './bench-fuse-probe';
import {
  awaitContainerAppAbsent, composeFuseProbeArtifact, deleteWorkerBothRoutes,
  deriveFixtureConfig, destroyRuntime, fuseProbeArtifactPath, parseProbeOutput,
  persistFuseProbeArtifact, planText, releaseResources, stripWholeLineComments, teardown,
} from './bench-fuse-probe';

const attemptId = 'fuse-attempt';
const DRIVER_SOURCE = readFileSync(new URL('./bench-fuse-probe.ts', import.meta.url), 'utf8');

function stage1(overrides: Partial<Stage1Report> = {}) {
  const base = {
    stage: 'stage1', attemptId, startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:01:00.000Z',
    census: {
      uid: 0, gid: 0, arch: 'x64', kernelRelease: '6.0', mountNamespace: 'mnt:[1]',
      capabilities: { names: ['SYS_ADMIN'], sysAdmin: true }, seccomp: { mode: 2, filters: 1 },
      devFuse: { exists: true, detail: 'mode=666' },
      binaries: [{ name: 'fusermount3', path: '/usr/bin/fusermount3', availability: 'available' }],
      kernelFilesystems: { fuse: true, overlay: true, erofs: false }, syscalls: [{ name: 'capget', nr: 125, outcome: 'capget v3' }],
      imageFormats: [
        { name: 'mkfs.erofs', path: null, availability: 'no_go' },
        { name: 'mkcomposefs', path: null, availability: 'no_go' },
        { name: 'nydusd', path: null, availability: 'no_go' },
      ],
    },
    openat2: {
      supported: true, beneathPositive: { ok: true, detail: 'SAFE' },
      absoluteEscape: { blocked: true, errnoName: 'EXDEV' }, dotDotEscape: { blocked: true, errnoName: 'EXDEV' },
      symlinkAncestorNoSymlinks: { blocked: true, errnoName: 'ELOOP' }, symlinkAncestorBeneathOnly: { blocked: true, errnoName: 'EXDEV' },
      deterministicSequence: { plainEscaped: true, openat2Blocked: true },
      syscallNr: 437,
      race: { swaps: 1500, resolutions: 1500, escapesObserved: 0, controlPlainEscapes: 3, outcomes: { ok: 700, ELOOP: 800 } },
    },
    mountAttempts: [
      { label: 'uid=65534', route: 'fusermount', ok: true, detail: 'helper mount+unmount succeeded' },
      { label: 'current-identity', route: 'direct-syscall', ok: true, detail: 'mount(2) succeeded' },
    ],
    mounted: true, mountpoint: '/tmp/fuse/mnt',
    bootstrapSamples: [{ entries: 200, ms: 4 }, { entries: 2_000, ms: 4.1 }, { entries: 8_000, ms: 4.2 }],
    coldRootChallengeMs: [1, 1.1], firstStatRead: [{ statMs: 0.2, readMs: 0.3, bytes: 11 }],
    workingSet: { files: 32, iterations: 20, fuse: { n: 1, minMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, meanMs: 1 }, native: { n: 1, minMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, meanMs: 1 } },
    fullWalk: { fuseFiles: 2_100, fuseMs: 5, nativeFiles: 2_100, nativeMs: 2 },
    rangeReads: [{ ...buildRangeIntent({ operationId: 'range-0', attemptId, exactKey: 'range-file.bin', byteOffset: 0, byteLength: 4096 }), latencyMs: 1, verified: true }],
    cache: { reps: 10, missP50Ms: 2, hitP50Ms: 0.2 },
    integrity: { poisonChunk: 3, refused: true, servedWrongBytes: false, errnoName: 'EIO', digestRefusal: { refused: true, errnoName: 'EIO' } },
    links: { symlinkResolvedContentOk: true, lstatIsLink: true, hardlinkSameInoAndNlink2: true },
    execMetadata: { mode0755Preserved: true, execAttempted: true, execOk: true },
    overlay: { attempted: true, composed: true, readVerified: true }, mountsPresentAtExit: [],
  };
  return v.parse(Stage1ReportSchema, { ...base, ...overrides });
}

function stage2(overrides: Partial<Stage2Report> = {}) {
  return v.parse(Stage2ReportSchema, {
    stage: 'stage2', attemptId, startedAt: '2026-08-26T00:02:00.000Z', finishedAt: '2026-08-26T00:03:00.000Z',
    restartResidue: { priorInstanceMountLines: [], freshInstanceClean: true }, remountOk: true,
    stuckMountDrill: { hungDetected: true, forcedUnmountOk: true },
    cleanup: { unmountOk: true, residueMounts: [], strayDaemonProcesses: 0, backingDirsRemoved: true, replayClean: true },
    ...overrides,
  });
}

test('reference ranges are deterministic and the range verifier refuses a poisoned chunk', () => {
  const first = canonicalRange(0x5f00d, CHUNK_BYTES - 13, 64);
  const second = canonicalRange(0x5f00d, CHUNK_BYTES - 13, 64);
  expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  expect(verifyChunk(0x5f00d, 3, canonicalRange(0x5f00d, 3 * CHUNK_BYTES, CHUNK_BYTES), false)).toEqual({ ok: true });
  expect(verifyChunk(0x5f00d, 3, canonicalRange(0x5f00d, 3 * CHUNK_BYTES, CHUNK_BYTES), true)).toEqual({ ok: false, reason: 'chunk 3 digest mismatch' });
  expect(BIG_FILE_BYTES / CHUNK_BYTES).toBe(256);
});

test('FUSE ABI packers preserve the kernel-required layouts and alignment', () => {
  const how = packOpenHow(0x80000n, 0n, 0xan);
  expect(how.length).toBe(24);
  expect(how.readBigUInt64LE(0)).toBe(0x80000n);
  expect(how.readBigUInt64LE(16)).toBe(0xan);

  const dirent = packDirent(9, 4, 8, 'range-file.bin');
  expect(dirent.length % 8).toBe(0);
  expect(dirent.length).toBe(align8(24 + 'range-file.bin'.length));
  expect(dirent.readBigUInt64LE(0)).toBe(9n);
  expect(dirent.readBigUInt64LE(8)).toBe(4n);
  expect(dirent.toString('utf8', 24, 38)).toBe('range-file.bin');

  const entry = packEntryOut(12, { ino: 12, size: 4096, mode: 0o100755, nlink: 2 });
  expect(entry.length).toBe(124);
  expect(entry.readBigUInt64LE(0)).toBe(12n);
  expect(entry.readUInt32LE(16 + 60)).toBe(0o100755);
  expect(entry.readUInt32LE(16 + 64)).toBe(2);

  const header = packOutHeader(64, 99n, -5);
  expect(header.readUInt32LE(0)).toBe(80);
  expect(header.readInt32LE(4)).toBe(-5);
  expect(header.readBigUInt64LE(8)).toBe(99n);
});

test('bootstrap classifier distinguishes fixed bring-up from an entry-dominated bootstrap', () => {
  expect(classifyBootstrap([{ entries: 200, ms: 4 }, { entries: 2_000, ms: 4.1 }, { entries: 8_000, ms: 4.2 }])?.eager).toBe(false);
  expect(classifyBootstrap([{ entries: 200, ms: 4 }, { entries: 2_000, ms: 40 }, { entries: 8_000, ms: 160 }])?.eager).toBe(true);
});

test('verdict is PASS only with a mounted reference, integrity refusals and no cleanup residue', () => {
  const verdict = classifyRun(stage1(), stage2());
  expect(verdict).toEqual({ outcome: 'pass', noGo: [], detections: [] });
});

test('verdict makes device and all-route mount absence typed NO_GOs', () => {
  const noDevice = stage1({ census: { ...stage1().census, devFuse: { exists: false, detail: 'ENOENT' } } });
  expect(classifyRun(noDevice, stage2()).noGo).toContainEqual({ kind: 'fuse-device-absent', detail: 'ENOENT' });
  const noMount = stage1({ mounted: false, mountAttempts: [{ label: 'uid=65534', route: 'fusermount', ok: false, detail: 'helper absent' }, { label: 'current', route: 'direct-syscall', ok: false, errnoName: 'EPERM', detail: 'denied' }] });
  expect(classifyRun(noMount, stage2()).noGo[0]?.kind).toBe('mount-refused');
});

test('verdict detects every named evidence failure class', () => {
  const eager = stage1({ bootstrapSamples: [{ entries: 200, ms: 4 }, { entries: 2_000, ms: 40 }, { entries: 8_000, ms: 160 }] });
  expect(classifyRun(eager, stage2()).detections.map((row) => row.kind)).toContain('eager-bootstrap');

  const integrity = stage1({ integrity: { poisonChunk: 3, refused: false, servedWrongBytes: true, digestRefusal: { refused: false } } });
  expect(classifyRun(integrity, stage2()).detections.map((row) => row.kind)).toEqual(expect.arrayContaining(['range-integrity-missing', 'digest-refusal-missing']));

  const residue = stage2({ cleanup: { unmountOk: true, residueMounts: ['fuse-probe /tmp/mnt fuse rw 0 0'], strayDaemonProcesses: 1, backingDirsRemoved: true, replayClean: false } });
  expect(classifyRun(stage1(), residue).detections.map((row) => row.kind)).toContain('mount-residue');
});

test('openat2 absence is a typed materialization NO_GO, not a silently skipped check', () => {
  const report = stage1({ openat2: { ...stage1().openat2, supported: false, supportErrnoName: 'ENOSYS' } });
  expect(classifyMaterialization(report.openat2)).toEqual({
    outcome: 'no_go',
    noGo: [{ kind: 'openat2-unavailable', detail: 'direct syscall openat2 unsupported (ENOSYS)' }],
    detections: [],
  });
});

test('range evidence is the shared RangeReadIntent contract, not a copied local shape', () => {
  const record = buildRangeIntent({ operationId: 'range-7', attemptId, exactKey: 'range-file.bin', byteOffset: 4096, byteLength: 4096 });
  expect(v.parse(RangeReadIntentSchema, record)).toEqual(record);
});

test('per-run fixture config is unique, token guarded and carries no storage binding', () => {
  const template = readFileSync(join(import.meta.dir, 'fixtures', 'fuse-probe', 'wrangler.jsonc'), 'utf8');
  const config = deriveFixtureConfig(template, 'kinu-fuse-probe-test', 'secret');
  expect(config.name).toBe('kinu-fuse-probe-test');
  expect(config.vars).toEqual({ FUSE_PROBE_TOKEN: 'secret' });
  expect(config.r2_buckets).toBeUndefined();
  expect(JSON.stringify(config)).toContain('docker.io/cloudflare/sandbox:0.12.8');
});

test('parser takes only the marked final JSON evidence after progress output', () => {
  const report = stage1();
  const output = `daemon started\nmount measurements\n__FUSE_PROBE_RESULT__\n${JSON.stringify(report)}\n`;
  expect(parseProbeOutput(output, Stage1ReportSchema)).toEqual(report);
});

test('artifact writes are immutable and plan names the openat2 and cleanup proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fuse-probe-test-'));
  const artifact = {
    schemaVersion: 1 as const,
    command: 'bun scripts/bench-fuse-probe.ts --run' as const,
    runId: 'unique', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:01:00.000Z', workerName: 'kinu-fuse-probe-unique',
    verdict: classifyRun(stage1(), stage2()), materialization: classifyMaterialization(stage1().openat2), stage1: stage1(), stage2: stage2(),
  };
  try {
    const output = await persistFuseProbeArtifact(dir, artifact);
    expect(output).toBe(fuseProbeArtifactPath(dir, 'unique'));
    await expect(persistFuseProbeArtifact(dir, artifact)).rejects.toThrow();
    expect(planText()).toContain('openat2 RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS');
    expect(planText()).toContain('idempotent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── fixture DO lifecycle ─────────────────────────────────────────────────────

const unitDeployment: Deployment = {
  workerName: 'kinu-fuse-probe-unittest',
  containerAppName: 'kinu-fuse-probe-unittest-fuseprobebox',
  configPath: '/tmp/unittest-wrangler.jsonc',
  origin: 'https://kinu-fuse-probe-unittest.workers.dev',
  token: 'unit-token',
};

/** The DO class itself runs only under workerd (@cloudflare/sandbox imports
 *  cloudflare:workers), so its lifecycle wiring is pinned by these ordered
 *  source assertions plus the fixture workers-types tsc; route behaviour is
 *  exercised through the pure contract fakes below. */
test('FuseProbeBox wiring: super-first onStart proof, typed mismatch, disposable destroy', () => {
  const source = readFileSync(join(import.meta.dir, 'fixtures', 'fuse-probe', 'worker.ts'), 'utf8');
  const indexOf = (needle: string): number => {
    const at = source.indexOf(needle);
    expect(at, `worker.ts must contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
    return at;
  };
  indexOf('class FuseProbeBox extends Sandbox');
  // onStart: super first, then version proof that throws the typed error.
  const superOnStart = indexOf('await super.onStart();');
  const versionCheck = indexOf('this.containerVersion()');
  const typedThrow = indexOf('throw new ImageIdentityError(SANDBOX_IMAGE');
  expect(superOnStart).toBeLessThan(versionCheck);
  expect(versionCheck).toBeLessThan(typedThrow);
  // destroy: SDK teardown first, storage clearance after it in a finally.
  const superDestroy = indexOf('await super.destroy();');
  const storageClear = indexOf('storage.deleteAll()');
  expect(superDestroy).toBeLessThan(storageClear);
  // The token and health gates answer before body parsing or sandbox dispatch.
  const tokenGuard = indexOf('isAuthorized(env.FUSE_PROBE_TOKEN');
  const health = indexOf("pathname === '/health'");
  const bodyParse = indexOf('await request.json()');
  const dispatch = indexOf('handleProbeOp(pathname');
  expect(tokenGuard).toBeLessThan(health);
  expect(health).toBeLessThan(bodyParse);
  expect(bodyParse).toBeLessThan(dispatch);
});
test('driver waits for authenticated propagation before container setup', () => {
  const readiness = DRIVER_SOURCE.indexOf('await awaitFixtureReady(deployment.origin, token)');
  const setup = DRIVER_SOURCE.indexOf("await setupExec(deployment.origin, token, 'mkdir -p /tmp/fuse-probe')");
  const identity = DRIVER_SOURCE.indexOf("'/prepare'");
  expect(readiness).toBeGreaterThan(-1);
  expect(setup).toBeGreaterThan(readiness);
  expect(identity).toBeGreaterThan(setup);
  expect(DRIVER_SOURCE).toContain('did not return JSON: ${raw.text.slice(0, 300)}');
  expect(DRIVER_SOURCE).toContain("stderr ?? '').slice(-800)");
});


test('the pure token gate refuses an unset secret or any other header value', () => {
  expect(isAuthorized(undefined, 'right')).toBe(false);
  expect(isAuthorized('right', null)).toBe(false);
  expect(isAuthorized('right', 'wrong')).toBe(false);
  expect(isAuthorized('right', 'right')).toBe(true);
});

interface RecordingHooks {
  hooks: TeardownHooks;
  order: string[];
}

function recordingHooks(options: { destroyFails?: boolean; workerDeleteFails?: boolean } = {}): RecordingHooks {
  const order: string[] = [];
  return {
    order,
    hooks: {
      destroyRuntime: async () => {
        order.push('destroy-runtime');
        if (options.destroyFails) throw new Error('runtime destroy exploded');
      },
      listContainerApps: () => [],
      deleteContainerApps: () => { order.push('delete-container-apps'); return ['absent']; },
      deleteWorker: () => { order.push('delete-worker'); return !options.workerDeleteFails; },
      removeConfig: async () => { order.push('remove-config'); },
      sleep: async () => undefined,
    },
  };
}

test('/destroy is the teardown route and /stop stays restart-evidence-only', async () => {
  const calls: string[] = [];
  const box: ProbeBox = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    stop: async () => { calls.push('stop'); },
    destroy: async () => { calls.push('destroy'); },
    prepare: async () => ({
      configuredImage: SANDBOX_IMAGE,
      expectedVersion: SANDBOX_IMAGE_VERSION,
      actualVersion: SANDBOX_IMAGE_VERSION,
      actualVersionDigest: sha256Hex(new TextEncoder().encode(SANDBOX_IMAGE_VERSION)),
    }),
  };
  expect((await handleProbeOp('/destroy', box, {})).status).toBe(200);
  expect(calls).toEqual(['destroy']);
  await handleProbeOp('/stop', box, {});
  expect(calls).toEqual(['destroy', 'stop']);
});

test('/prepare returns evidence under the shared RunIdentity contract', async () => {
  const evidence = {
    configuredImage: SANDBOX_IMAGE,
    expectedVersion: SANDBOX_IMAGE_VERSION,
    actualVersion: SANDBOX_IMAGE_VERSION,
    actualVersionDigest: sha256Hex(new TextEncoder().encode(SANDBOX_IMAGE_VERSION)),
    bunVersion: '1.3.7',
  };
  const box: ProbeBox = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    prepare: async () => evidence,
  };
  const body = v.parse(
    RunIdentitySchema,
    await handleProbeOp('/prepare', box, {}).then((response) => response.json()),
  );
  expect(body).toEqual(evidence);
});

test('/destroy tolerates only explicit absence; transport and server failures propagate', async () => {
  const log = (): void => undefined;
  const ok = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))();
  await destroyRuntime(unitDeployment.origin, unitDeployment.token, log, () => ok);

  const gone = (async () => new Response(JSON.stringify({ error: 'no such container' }), { status: 404 }))();
  await destroyRuntime(unitDeployment.origin, unitDeployment.token, log, () => gone);

  const refused = (async () => new Response(JSON.stringify({ error: 'ImageIdentityError: boom' }), { status: 500 }))();
  let caught500: unknown;
  try { await destroyRuntime(unitDeployment.origin, unitDeployment.token, log, () => refused); } catch (error) { caught500 = error; }
  expect(String(caught500)).toContain('/destroy failed (500)');

  let caughtTransport: unknown;
  try {
    await destroyRuntime(unitDeployment.origin, unitDeployment.token, log, async () => { throw new Error('connection reset'); });
  } catch (error) { caughtTransport = error; }
  expect(String(caughtTransport)).toContain('/destroy unreachable');
});

// ── driver teardown ──────────────────────────────────────────────────────────

test('teardown destroys twice, then releases application-before-Worker-config, all of it twice', async () => {
  const { hooks, order } = recordingHooks();
  await teardown(unitDeployment, hooks);
  expect(order.filter((step) => step === 'destroy-runtime')).toHaveLength(2);
  expect(order).toEqual([
    'destroy-runtime', 'destroy-runtime',
    'delete-container-apps', 'delete-worker', 'remove-config',
    'delete-container-apps', 'delete-worker', 'remove-config',
  ]);
});

test('teardown preserves failures from every pass instead of abandoning the rest', async () => {
  const { hooks, order } = recordingHooks({ destroyFails: true, workerDeleteFails: true });
  let caught: unknown;
  try { await teardown(unitDeployment, hooks); } catch (error) { caught = error; }
  const message = String(caught);
  expect(message).toContain('destroy pass 1');
  expect(message).toContain('destroy pass 2');
  expect(message).toContain('Worker deletion failed');
  expect(order.filter((step) => step === 'remove-config')).toHaveLength(2);
});

test('absence wait polls until the application disappears and reports when it never does', async () => {
  let listings = 0;
  let sleeps = 0;
  const gone = await awaitContainerAppAbsent(
    () => (++listings <= 2 ? [{ id: 'app-1', name: unitDeployment.workerName }] : []),
    async () => { sleeps++; },
  );
  expect(gone).toBe(true);
  expect(listings).toBe(3);
  expect(sleeps).toBe(2);

  const stuck = await awaitContainerAppAbsent(
    () => [{ id: 'app-1', name: unitDeployment.workerName }],
    async () => undefined,
    4,
  );
  expect(stuck).toBe(false);
});

test('a failed deploy releases application-before-Worker with no runtime destroy call', async () => {
  const { hooks, order } = recordingHooks();
  await releaseResources(hooks);
  expect(order).toEqual(['delete-container-apps', 'delete-worker', 'remove-config']);
});

test('worker deletion treats an already-absent Worker as success on both routes', () => {
  const log = (): void => undefined;
  // Explicit absence on the first route is success without a fallback call.
  const absentOnFirstRoute = (): string =>
    'WRANGLER_FAILED: A request to the Cloudflare API failed. workers.api.error.script_not_found [code: 10021]';
  expect(deleteWorkerBothRoutes('/repo', '/cfg.jsonc', 'w', log, absentOnFirstRoute)).toBe(true);

  // A different failure falls back to the second route, whose explicit
  // absence is also success.
  let calls = 0;
  const absentOnFallbackRoute = (): string => {
    calls++;
    return calls === 1
      ? 'WRANGLER_FAILED: something route-specific exploded'
      : 'WRANGLER_FAILED: could not find script w';
  };
  expect(deleteWorkerBothRoutes('/repo', '/cfg.jsonc', 'w', log, absentOnFallbackRoute)).toBe(true);
  expect(calls).toBe(2);

  const alwaysFails = (): string => 'WRANGLER_FAILED: something else exploded';
  expect(deleteWorkerBothRoutes('/repo', '/cfg.jsonc', 'w', log, alwaysFails)).toBe(false);
});

test('a mismatched image identity censors every measured cell and names the mismatch', () => {
  const fingerprintOf = (version: string): string => sha256Hex(new TextEncoder().encode(version));
  const mismatched: RunIdentity = v.parse(RunIdentitySchema, {
    configuredImage: SANDBOX_IMAGE,
    expectedVersion: SANDBOX_IMAGE_VERSION,
    actualVersion: '0.12.7',
    actualVersionDigest: fingerprintOf('0.12.7'),
    bunVersion: '1.3.7',
  });
  expect(imageMismatchVerdict(mismatched)?.noGo[0]?.kind).toBe('image-mismatch');
  expect(imageMismatchVerdict(undefined)).toBeUndefined();

  const censored = composeFuseProbeArtifact({
    runId: 'censored', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:05:00.000Z',
    workerName: 'kinu-fuse-probe-censored', identity: mismatched, stage1: stage1(), stage2: stage2(),
  });
  expect(censored.stage1).toBeUndefined();
  expect(censored.stage2).toBeUndefined();
  expect(censored.verdict.outcome).toBe('no_go');
  expect(censored.verdict.noGo[0]?.kind).toBe('image-mismatch');
  expect(censored.materialization.noGo[0]?.kind).toBe('image-mismatch');
  expect(censored.identity).toEqual(mismatched);

  const proven = composeFuseProbeArtifact({
    runId: 'proven', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:05:00.000Z',
    workerName: 'kinu-fuse-probe-proven',
    identity: v.parse(RunIdentitySchema, {
      ...mismatched,
      actualVersion: SANDBOX_IMAGE_VERSION,
      actualVersionDigest: fingerprintOf(SANDBOX_IMAGE_VERSION),
    }),
    stage1: stage1(), stage2: stage2(),
  });
  expect(proven.stage1).toBeDefined();
  expect(proven.verdict.outcome).toBe('pass');

  // No identity at all is the crash path, governed by classifyRun — not by
  // censorship, which exists for evidence captured on the WRONG platform.
  const unproven = composeFuseProbeArtifact({
    runId: 'unproven', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:05:00.000Z',
    workerName: 'kinu-fuse-probe-unproven', stage1: stage1(), failure: 'deploy died before /prepare',
  });
  expect(unproven.identity).toBeUndefined();
  expect(unproven.stage1).toBeDefined();
  expect(unproven.verdict.outcome).toBe('no_go');
});

const FixtureConfigSchema = v.looseObject({
  containers: v.array(v.looseObject({ class_name: v.string(), image: v.string() })),
  durable_objects: v.looseObject({ bindings: v.array(v.looseObject({ class_name: v.string() })) }),
  migrations: v.array(v.looseObject({ new_sqlite_classes: v.array(v.string()) })),
});

test('fixture config, DO class name and core image constant agree', () => {
  const template = readFileSync(join(import.meta.dir, 'fixtures', 'fuse-probe', 'wrangler.jsonc'), 'utf8');
  const parsed = v.parse(FixtureConfigSchema, JSON.parse(stripWholeLineComments(template)));
  expect(parsed.containers[0]?.image).toBe(SANDBOX_IMAGE);
  expect(parsed.containers[0]?.class_name).toBe('FuseProbeBox');
  expect(parsed.durable_objects.bindings[0]?.class_name).toBe('FuseProbeBox');
  expect(parsed.migrations[0]?.new_sqlite_classes).toContain('FuseProbeBox');
});
