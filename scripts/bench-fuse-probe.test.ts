import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import {
  BIG_FILE_BYTES, CHUNK_BYTES, RangeReadIntentSchema, RunIdentitySchema, Stage1ReportSchema,
  Stage2ReportSchema, Stage3ReportSchema, SANDBOX_IMAGE, SANDBOX_IMAGE_VERSION, align8, buildRangeIntent,
  canonicalRange, classifyBootstrap, classifyMaterialization, classifyRun, classifyWritableMmap,
  classifyWritableMmapControls, handleProbeOp,
  imageMismatchVerdict, isAuthorized,
  packDirent, packEntryOut, packGetattrOut, packInitOut, packOpenHow, packOutHeader, sha256Hex, verifyChunk,
} from './fixtures/fuse-probe/core';
import { destroyProbeRuntime, parseProbeRequest } from './fixtures/fuse-probe/worker-contract';
import type { ProbeBox, RunIdentity, Stage1Report, Stage2Report, Stage3Report } from './fixtures/fuse-probe/core';
import type { Deployment, TeardownHooks } from './bench-fuse-probe';
import {
  awaitContainerAppAbsent, awaitWritableMmapResult, bundleFuseProbeSource, composeFuseProbeArtifact,
  deleteWorkerBothRoutes, deriveFixtureConfig, destroyRuntime,
  fuseProbeArtifactPath, parseProbeOutput, parseWritableMmapEvidence, parseWritableMmapOutput,
  persistFuseProbeArtifact, planText,
  releaseResources, requireWritableProbeImage, stripWholeLineComments, teardown, writableProbeCommand,
  writableProbeOperationId,
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

function stage3(overrides: Partial<Stage3Report> = {}): Stage3Report {
  return v.parse(Stage3ReportSchema, {
    stage: 'stage3',
    protocol: {
      requested: '7.39',
      kernelHeader: {
        libfuse: '3.17.1',
        kernel: { major: 7, minor: 40 },
        constants: { directIoAllowMmap: 68_719_476_736, openDirectIo: 1 },
        headers: { fuse_kernel_h: 'a'.repeat(64), fuse_lowlevel_h: 'b'.repeat(64), sourceSha256: 'c'.repeat(64) },
      },
    },
    mutation: 'none',
    mounted: true,
    directIoMmap: true,
    preStore: true,
    duringStore: true,
    postStore: true,
    msyncCalled: true,
    controlFenceOk: true,
    fsyncOk: true,
    intentJournalDurable: true,
    resultJournalDurable: true,
    intentFsyncFailureRefused: true,
    resultFsyncFailureRefused: true,
    forkedMapper: true,
    continuousDirtying: true,
    ordinaryWrites: true,
    continuousDirtyBeforeFenceClosed: true,
    continuousDirtyAfterFenceComplete: true,
    requestLoopServedAfterFence: true,
    restartRemountOk: true,
    restartOpenedExistingBacking: true,
    restartRemountReadOk: true,
    restartTruncationRefused: true,
    restartDaemonKilled: true,
    restartDeadMountDetached: true,
    restartJournalReconciled: true,
    crashCutAfterIntent: true,
    journalPendingEmpty: true,
    recoveryAbortDurable: true,
    pendingEffectExcluded: true,
    fenceClosed: true,
    fenceDrained: true,
    postWriteAfterFenceCut: true,
    noWritesAdmittedWhileClosed: true,
    prefixReplayOk: true,
    prePrefixIncluded: true,
    excludedWritesAbsentFromPrefix: true,
    designatedWaiterResultAfterFenceCut: true,
    finalBackingAllWrites: true,
    backingOrderOk: true,
    orderedLog: true,
    loggedBeforeReply: true,
    controlFenceObserved: true,
    postFenceBeforeCompletion: false,
    watchdogDeadlock: false,
    finalUnmountOk: true,
    daemonExitOk: true,
    cleanupPathsRemoved: true,
    mountResidueAbsent: true,
    pathResidueAbsent: true,
    reapBounded: true,
    linearizable: true,
    ...overrides,
  });
}
function controls() {
  return ([
    ['reply-before-log', { loggedBeforeReply: false }],
    ['fence-closes-request-loop', { requestLoopServedAfterFence: false, postStore: false }],
    ['omit-msync', { msyncCalled: false }],
    ['post-fence-contamination', { excludedWritesAbsentFromPrefix: false, prefixReplayOk: false }],
    ['intent-fsync-failure', { intentJournalDurable: false, intentFsyncFailureRefused: true }],
    ['result-fsync-failure', { resultJournalDurable: false, resultFsyncFailureRefused: true }],
    ['restart-truncation', { restartRemountReadOk: false, restartTruncationRefused: true }],
    ['skip-recovery', { journalPendingEmpty: false, recoveryAbortDurable: false, pendingEffectExcluded: false }],
  ] as const).map(([mutation, failure]) => {
    const report = stage3({ mutation, linearizable: false, ...failure });
    return { mutation, exitCode: 86 as const, report, verdict: classifyWritableMmap(report) };
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
  expect(entry.length).toBe(128);
  expect(entry.readBigUInt64LE(0)).toBe(12n);
  expect(entry.readUInt32LE(40 + 60)).toBe(0o100755);
  expect(entry.readUInt32LE(40 + 64)).toBe(2);

  const getattr = packGetattrOut({ ino: 12, size: 4096, mode: 0o100755, nlink: 2 });
  expect(getattr.length).toBe(104);
  expect(getattr.readUInt32LE(16 + 60)).toBe(0o100755);

  // linux/fuse.h `fuse_init_out`: u32 head at 0..15, u16 pairs at
  // 16/18 and 28/30, then the negotiated extension tail.
  const init = packInitOut(38, 0, 4096);
  expect(init.length).toBe(64);
  expect(init.readUInt32LE(0)).toBe(7);
  expect(init.readUInt32LE(4)).toBe(38);
  expect(init.readUInt32LE(8)).toBe(4096);
  expect(init.readUInt32LE(12)).not.toBe(0);
  expect(init.readUInt16LE(16)).toBe(0);
  expect(init.readUInt16LE(18)).toBe(0);
  expect(init.readUInt32LE(20)).toBe(1024 * 1024);
  expect(init.readUInt32LE(24)).toBe(1);
  expect(init.readUInt16LE(28)).toBe(256);
  expect(init.readUInt16LE(30)).toBe(0);
  expect(init.readUInt32LE(32)).toBe(0);
  expect(init.readUInt32LE(36)).toBe(0);
  expect(init.readUInt16LE(40)).toBe(0);

  const header = packOutHeader(64, 99n, -5);
  expect(header.readUInt32LE(0)).toBe(80);
  expect(header.readInt32LE(4)).toBe(-5);
  expect(header.readBigUInt64LE(8)).toBe(99n);
});

test('bootstrap classifier distinguishes fixed bring-up from an entry-dominated bootstrap', () => {
  expect(classifyBootstrap([{ entries: 200, ms: 4 }, { entries: 2_000, ms: 4.1 }, { entries: 8_000, ms: 4.2 }])?.eager).toBe(false);
  expect(classifyBootstrap([{ entries: 200, ms: 4 }, { entries: 2_000, ms: 40 }, { entries: 8_000, ms: 160 }])?.eager).toBe(true);
});

test('writable mmap evidence passes only as an all-or-nothing barrier proof', () => {
  expect(classifyWritableMmap(stage3())).toEqual({ outcome: 'pass', noGo: [], detections: [] });
  expect(classifyWritableMmap(undefined).noGo[0]?.kind).toBe('mmap-not-linearizable');
});

test('writable negative mutations each become typed mmap-not-linearizable NO_GOs', () => {
  const controls: ReadonlyArray<readonly [Stage3Report['mutation'], Partial<Stage3Report>]> = [
    ['reply-before-log', { loggedBeforeReply: false, linearizable: false }],
    ['fence-closes-request-loop', { requestLoopServedAfterFence: false, postStore: false, linearizable: false }],
    ['omit-msync', { msyncCalled: false, linearizable: false }],
    ['post-fence-contamination', { excludedWritesAbsentFromPrefix: false, prefixReplayOk: false, linearizable: false }],
    ['intent-fsync-failure', { intentJournalDurable: false, intentFsyncFailureRefused: true, linearizable: false }],
    ['result-fsync-failure', { resultJournalDurable: false, resultFsyncFailureRefused: true, linearizable: false }],
    ['restart-truncation', { restartRemountReadOk: false, restartTruncationRefused: true, linearizable: false }],
    ['skip-recovery', { journalPendingEmpty: false, recoveryAbortDurable: false, pendingEffectExcluded: false, linearizable: false }],
  ];
  for (const [mutation, failure] of controls) {
    const verdict = classifyWritableMmap(stage3({ mutation, ...failure }));
    expect(verdict.outcome).toBe('no_go');
    expect(verdict.noGo[0]?.kind).toBe('mmap-not-linearizable');
    expect(verdict.noGo[0]?.detail).toContain(mutation);
  }
  for (const field of [
    'restartDaemonKilled',
    'restartDeadMountDetached',
    'restartJournalReconciled',
    'reapBounded',
  ] as const) {
    const report = stage3({ [field]: false, linearizable: false });
    expect(classifyWritableMmap(report).outcome).toBe('no_go');
  }
});
test('writable control evidence requires each real mutation exit/report refusal pair', () => {
  expect(classifyWritableMmapControls(controls())).toEqual({ outcome: 'pass', noGo: [], detections: [] });
  expect(classifyWritableMmapControls(controls().slice(0, 3)).noGo[0]?.detail)
    .toContain('post-fence-contamination');
  const falselyPassing = controls().map((control) => control.mutation === 'omit-msync'
    ? { ...control, exitCode: 0 as const }
    : control);
  expect(classifyWritableMmapControls(falselyPassing).noGo[0]?.detail).toContain('omit-msync');
});
test('classifier rejects an event stream that contradicts closed admission', () => {
  for (const field of [
    'controlFenceOk',
    'controlFenceObserved',
    'fenceClosed',
    'fenceDrained',
    'designatedWaiterResultAfterFenceCut',
    'postWriteAfterFenceCut',
    'noWritesAdmittedWhileClosed',
    'requestLoopServedAfterFence',
    'continuousDirtyBeforeFenceClosed',
    'continuousDirtyAfterFenceComplete',
  ] as const) {
    expect(classifyWritableMmap(stage3({ [field]: false, linearizable: false })).outcome).toBe('no_go');
  }
});
test('driver persists every live mutation exit/report pair before stage one', () => {
  const controls = DRIVER_SOURCE.indexOf('const writableControls: WritableMmapControl[] = []');
  const loop = DRIVER_SOURCE.indexOf('for (const mutation of [');
  const firstStage = DRIVER_SOURCE.indexOf("probe.mjs stage1");
  expect(controls).toBeGreaterThanOrEqual(0);
  expect(loop).toBeGreaterThan(controls);
  expect(firstStage).toBeGreaterThan(loop);
  for (const mutation of [
    'reply-before-log',
    'fence-closes-request-loop',
    'omit-msync',
    'post-fence-contamination',
    'intent-fsync-failure',
    'result-fsync-failure',
    'skip-recovery',
    'restart-truncation',

  ]) expect(DRIVER_SOURCE).toContain(`'${mutation}'`);
  expect(DRIVER_SOURCE.indexOf('writableControls.push', loop)).toBeGreaterThan(loop);
});
test('writable process is watchdog-bounded while driver polling has no elapsed deadline', () => {
  expect(writableProbeCommand()).toContain('timeout -k 5s 90s');
  expect(writableProbeCommand()).toContain('/tmp/fuse-mmap-probe.*/events.ndjson');
  expect(writableProbeCommand()).toContain('exit "$code"');
  expect(writableProbeCommand('omit-msync')).toContain('--mutation=omit-msync');
});




test('writable report parser preserves a non-zero proof result instead of calling it a crash', () => {
  const report = stage3({ directIoMmap: false, linearizable: false });
  expect(parseWritableMmapOutput({ stdout: `${JSON.stringify(report)}\n`, stderr: '', exitCode: 86 })).toEqual(report);
});

test('writable evidence preserves the C exit/report pair', () => {
  const report = stage3({ linearizable: false, loggedBeforeReply: false, mutation: 'reply-before-log' });
  expect(parseWritableMmapEvidence({ stdout: `${JSON.stringify(report)}\n`, stderr: '', exitCode: 86 }))
    .toEqual({ exitCode: 86, report });
});

test('writable deployment accepts only an immutable custom-image digest', () => {
  const template = readFileSync(join(import.meta.dir, 'fixtures', 'fuse-probe', 'wrangler.jsonc'), 'utf8');
  const image = `registry.example/fuse-mmap@sha256:${'a'.repeat(64)}`;
  expect(requireWritableProbeImage(image)).toBe(image);
  expect(() => requireWritableProbeImage('registry.example/fuse-mmap:latest')).toThrow(/immutable registry image digest/);
  expect(deriveFixtureConfig(template, 'kinu-fuse-probe-test', 'secret', image).containers[0]?.image).toBe(image);
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

test('runtime bundle closes every repository-relative import', async () => {
  const source = await bundleFuseProbeSource();
  expect(source).toContain('__FUSE_PROBE_RESULT__');
  expect(source).not.toContain('../../../packages/');
  expect(source).not.toContain("from './core'");
});

test('artifact writes are immutable and plan names the openat2 and cleanup proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fuse-probe-test-'));
  const artifact = {
    schemaVersion: 1 as const,
    command: 'bun scripts/bench-fuse-probe.ts --run' as const,
    runId: 'unique', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:01:00.000Z', workerName: 'kinu-fuse-probe-unique',
    verdict: classifyRun(stage1(), stage2()),
    materialization: classifyMaterialization(stage1().openat2),
    writableMmap: classifyWritableMmap(stage3()),
    writableControls: controls(),
    writableImage: `registry.example/fuse-mmap@sha256:${'a'.repeat(64)}`,
    stage1: stage1(), stage2: stage2(), stage3: stage3(),
  };
  try {
    const output = await persistFuseProbeArtifact(dir, artifact);
    expect(output).toBe(fuseProbeArtifactPath(dir, 'unique'));
    // The errno is the contract: link() emits no product message of its own,
    // and its sentence is libc wording.
    await expect(persistFuseProbeArtifact(dir, artifact)).rejects.toThrow(/EEXIST/);
    expect(planText()).toContain('FUSE_PROBE_IMAGE=registry/name@sha256:<digest>');
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
  writableImage: `registry.example/fuse-mmap@sha256:${'a'.repeat(64)}`,
};

/** The DO class itself runs only under workerd (@cloudflare/sandbox imports
 *  cloudflare:workers), so its lifecycle wiring is pinned by these ordered
 *  source assertions plus the fixture workers-types tsc; route behaviour is
 *  exercised through the pure contract fakes below. */
test('FuseProbeBox wiring: super-first onStart proof, typed mismatch, process-owning destroy', () => {
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
  // destroy delegates process termination, SDK teardown and storage clearance
  // to the tested shared runtime teardown contract.
  const destroy = indexOf('await destroyProbeRuntime(');
  const processList = indexOf('this.listProcesses()');
  const storageClear = indexOf('storage.deleteAll()');
  expect(destroy).toBeLessThan(processList);
  expect(processList).toBeLessThan(storageClear);
  // The token and health gates answer before body parsing or sandbox dispatch.
  const tokenGuard = indexOf('isAuthorized(env.FUSE_PROBE_TOKEN');
  const health = indexOf("pathname === '/health'");

  const bodyParse = indexOf('await request.json()');
  const dispatch = indexOf('handleProbeOp(pathname');
  expect(tokenGuard).toBeLessThan(health);
  expect(health).toBeLessThan(bodyParse);
  expect(bodyParse).toBeLessThan(dispatch);
});
test('container restart reinstalls the immutable probe before stage two', () => {
  const restart = DRIVER_SOURCE.indexOf('await stopAndProveRestart');
  const reupload = DRIVER_SOURCE.indexOf('await uploadProbeBundle', restart);
  const stage2 = DRIVER_SOURCE.indexOf('probe.mjs stage2', restart);
  expect(restart).toBeGreaterThan(-1);
  expect(reupload).toBeGreaterThan(restart);
  expect(stage2).toBeGreaterThan(reupload);
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
    startProcess: async () => ({ id: 'unused', status: 'completed', exitCode: 0, getLogs: async () => ({ stdout: '', stderr: '' }) }),
    getProcess: async () => null,
  };
  expect((await handleProbeOp('/destroy', box, {})).status).toBe(200);
  expect(calls).toEqual(['destroy']);
  await handleProbeOp('/stop', box, {});
  expect(calls).toEqual(['destroy', 'stop']);
});

test('process control preserves a running operation across redrive and returns complete settled logs', async () => {
  let starts = 0;
  const running = {
    id: 'writable-run-positive',
    status: 'running',
    getLogs: async () => ({ stdout: 'partial', stderr: 'partial-error' }),
  };
  const complete = {
    id: 'writable-run-positive',
    status: 'completed',
    exitCode: 0,
    getLogs: async () => ({ stdout: '{"linearizable":true}\n', stderr: '' }),
  };
  const box: ProbeBox = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    prepare: async () => ({ configuredImage: SANDBOX_IMAGE, expectedVersion: SANDBOX_IMAGE_VERSION, actualVersion: SANDBOX_IMAGE_VERSION, actualVersionDigest: 'digest' }),
    startProcess: async () => { starts += 1; return running; },
    getProcess: async () => starts === 0 ? null : running,
  };
  const request = { operationId: 'writable-run-positive', command: 'probe' };
  expect(await handleProbeOp('/start', box, request).then((response) => response.json()))
    .toEqual({ operationId: request.operationId, status: 'running', exitCode: null, started: true });
  expect(await handleProbeOp('/start', box, request).then((response) => response.json()))
    .toEqual({ operationId: request.operationId, status: 'running', exitCode: null, started: false });
  expect(starts).toBe(1);

  expect(await handleProbeOp('/poll', box, { operationId: request.operationId }).then((response) => response.json()))
    .toEqual({ operationId: request.operationId, status: 'running', exitCode: null });
  box.getProcess = async () => complete;
  expect(await handleProbeOp('/poll', box, { operationId: request.operationId }).then((response) => response.json()))
    .toEqual({
      operationId: request.operationId, status: 'completed', exitCode: 0,
      stdout: '{"linearizable":true}\n', stderr: '',
    });
});

test('process control preserves the exit-86 report and reports missing processes as JSON', async () => {
  const refused = {
    id: 'writable-run-omit-msync',
    status: 'failed',
    exitCode: 86,
    getLogs: async () => ({ stdout: '{"linearizable":false}\n', stderr: 'proof refused' }),
  };
  const box: ProbeBox = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFile: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    prepare: async () => ({ configuredImage: SANDBOX_IMAGE, expectedVersion: SANDBOX_IMAGE_VERSION, actualVersion: SANDBOX_IMAGE_VERSION, actualVersionDigest: 'digest' }),
    startProcess: async () => refused,
    getProcess: async () => refused,
  };
  expect(await handleProbeOp('/poll', box, { operationId: refused.id }).then((response) => response.json()))
    .toEqual({
      operationId: refused.id, status: 'failed', exitCode: 86,
      stdout: '{"linearizable":false}\n', stderr: 'proof refused',
    });
  box.getProcess = async () => null;
  const missing = await handleProbeOp('/poll', box, { operationId: refused.id });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: `process ${refused.id} not found` });
});

test('process control request schemas are closed and the writable driver uses start/poll rather than exec', async () => {
  const unexpectedStart = JSON.parse('{"operationId":"run","command":"probe","unexpected":true}');
  const incompletePoll = JSON.parse('{"command":"probe"}');
  expect(() => parseProbeRequest('/start', unexpectedStart)).toThrow('"unexpected"');
  expect(() => parseProbeRequest('/poll', incompletePoll)).toThrow('"operationId"');
  expect(writableProbeOperationId('run-42')).toBe('fuse-run-42-positive');
  expect(writableProbeOperationId('run-42', 'omit-msync')).toBe('fuse-run-42-omit-msync');

  const requests: string[] = [];
  const report = stage3({ linearizable: true });
  const completed = new Response(JSON.stringify({
    operationId: 'fuse-run-42-positive', status: 'completed', exitCode: 0,
    stdout: `${JSON.stringify(report)}\n`, stderr: '',
  }));
  const deployment = { ...unitDeployment, origin: 'https://fixture.example' };
  const evidence = await awaitWritableMmapResult(
    deployment,
    'fuse-run-42-positive',
    undefined,
    async (input) => {
      requests.push(new URL(String(input)).pathname);
      return requests.at(-1) === '/start'
        ? new Response(JSON.stringify({ operationId: 'fuse-run-42-positive', status: 'running', exitCode: null, started: true }))
        : completed.clone();
    },
    async () => undefined,
  );
  expect(evidence).toEqual({ exitCode: 0, report });
  expect(requests).toEqual(['/start', '/poll']);
});

test('runtime destroy kills every process before teardown and retains failures after storage clearance', async () => {
  const calls: string[] = [];
  let failure: unknown;
  try {
    await destroyProbeRuntime(
      async () => [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
      async (id) => {
        calls.push(`kill:${id}`);
        if (id === 'two') throw new Error('kill failed');
      },
      async () => { calls.push('destroy'); },
      async () => { calls.push('clear'); },
    );
  } catch (error) {
    failure = error;
  }
  expect(calls).toEqual(['kill:one', 'kill:two', 'kill:three', 'destroy', 'clear']);
  expect(failure).toBeInstanceOf(AggregateError);
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
    startProcess: async () => ({ id: 'unused', status: 'completed', exitCode: 0, getLogs: async () => ({ stdout: '', stderr: '' }) }),
    getProcess: async () => null,
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
    stage1: stage1(), stage2: stage2(), stage3: stage3(), writableControls: controls(),
  });
  const missingControls = composeFuseProbeArtifact({
    runId: 'missing-controls', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:05:00.000Z',
    workerName: 'kinu-fuse-probe-missing-controls',
    identity: v.parse(RunIdentitySchema, {
      ...mismatched,
      actualVersion: SANDBOX_IMAGE_VERSION,
      actualVersionDigest: fingerprintOf(SANDBOX_IMAGE_VERSION),
    }),
    stage1: stage1(), stage2: stage2(), stage3: stage3(),
  });
  expect(missingControls.verdict.outcome).toBe('no_go');
  expect(missingControls.verdict.noGo[0]?.detail).toContain('reply-before-log');

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
