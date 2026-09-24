import { scratchDir } from '../packages/test-utils/src/scratch';
import { expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

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
import { destroyProbeRuntime, parseProbeRequest, serveProbeRequest } from './fixtures/fuse-probe/worker-contract';
import type { ProbeBox, RunIdentity, Stage1Report, Stage2Report, Stage3Report } from './fixtures/fuse-probe/core';
import type { Deployment, ExecResponse, FetchLike, ProbeFixture, TeardownHooks } from './bench-fuse-probe';
import {
  awaitContainerAppAbsent, awaitWritableMmapResult, bundleFuseProbeSource, composeFuseProbeArtifact,
  deleteWorkerBothRoutes, deriveFixtureConfig, destroyRuntime,
  fuseProbeArtifactPath, liveFixture, measure, parseProbeOutput, parseWritableMmapEvidence, parseWritableMmapOutput,
  persistFuseProbeArtifact, planText,
  releaseResources, requireWritableProbeImage, RESULT_MARKER, stripWholeLineComments, teardown, WRITABLE_MMAP_MUTATIONS,
  writableProbeCommand, writableProbeOperationId,
} from './bench-fuse-probe';

const attemptId = 'fuse-attempt';

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
  const mutationFailures: ReadonlyArray<readonly [Stage3Report['mutation'], Partial<Stage3Report>]> = [
    ['reply-before-log', { loggedBeforeReply: false, linearizable: false }],
    ['fence-closes-request-loop', { requestLoopServedAfterFence: false, postStore: false, linearizable: false }],
    ['omit-msync', { msyncCalled: false, linearizable: false }],
    ['post-fence-contamination', { excludedWritesAbsentFromPrefix: false, prefixReplayOk: false, linearizable: false }],
    ['intent-fsync-failure', { intentJournalDurable: false, intentFsyncFailureRefused: true, linearizable: false }],
    ['result-fsync-failure', { resultJournalDurable: false, resultFsyncFailureRefused: true, linearizable: false }],
    ['restart-truncation', { restartRemountReadOk: false, restartTruncationRefused: true, linearizable: false }],
    ['skip-recovery', { journalPendingEmpty: false, recoveryAbortDurable: false, pendingEffectExcluded: false, linearizable: false }],
  ];

  for (const [mutation, failure] of mutationFailures) {
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

/** The digest the scripted writable reports carry (`stage3()`'s default). */
const REVIEWED_SOURCE = 'c'.repeat(64);

const PROVEN_IDENTITY = {
  configuredImage: SANDBOX_IMAGE, expectedVersion: SANDBOX_IMAGE_VERSION, actualVersion: SANDBOX_IMAGE_VERSION,
  actualVersionDigest: 'd'.repeat(64), bunVersion: '1.3.0',
};

/** A healthy fixture that records every step it is asked for; `answers` replaces one step's answer. */
function scriptedFixture(answers: { readonly stage1?: ExecResponse; readonly identity?: RunIdentity } = {}) {
  const steps: string[] = [];
  const reported = (report: Stage1Report | Stage2Report): ExecResponse => ({ exitCode: 0, stdout: `mounting\n${RESULT_MARKER}\n${JSON.stringify(report)}\n`, stderr: '' });
  const refusals = new Map(controls().map((control) => [control.mutation, control.report]));

  const fixture: ProbeFixture = {
    ready: async () => { steps.push('ready'); },
    setup: async () => { steps.push('setup'); },
    prepare: async () => {
      steps.push('prepare');

      return answers.identity ?? PROVEN_IDENTITY;
    },
    upload: async () => { steps.push('upload'); },
    stage: async (stage) => {
      steps.push(stage);

      return stage === 'stage1' ? answers.stage1 ?? reported(stage1()) : reported(stage2());
    },
    restart: async () => { steps.push('restart'); },
    writable: async (_operationId, mutation) => {
      steps.push(mutation === undefined ? 'writable' : `writable:${mutation}`);

      if (mutation === undefined) return { exitCode: 0, report: stage3() };
      const report = refusals.get(mutation);

      if (report === undefined) throw new Error(`no refusal is scripted for ${mutation}`);

      return { exitCode: 86, report };
    },
  };

  return { fixture, steps };
}

test('a run proves the image, drives every refusal, and reinstalls the probe after the restart', async () => {
  const { fixture, steps } = scriptedFixture();
  const measured = await measure('run-order', fixture, REVIEWED_SOURCE);

  expect(measured.failure).toBeUndefined();
  expect(steps).toEqual([
    'ready', 'setup', 'prepare',
    'writable', ...WRITABLE_MMAP_MUTATIONS.map((mutation) => `writable:${mutation}`),
    'upload', 'stage1',
    // The restart wipes /tmp, so stage two needs the probe installed again.
    'restart', 'setup', 'prepare', 'upload', 'stage2',
  ]);
  expect(measured.writableControls.map((control) => control.mutation)).toEqual(controls().map((control) => control.mutation));
  expect(measured.stage2).toEqual(stage2());
});

test('every refusal is on record before stage one, so a stage-one failure keeps them all', async () => {
  const stderr = `${'x'.repeat(900)}the probe's last words`;
  const { fixture } = scriptedFixture({ stage1: { exitCode: 1, stdout: '', stderr } });
  const measured = await measure('run-cut', fixture, REVIEWED_SOURCE);

  // The tail of stderr, where the probe's failure is, not its head.
  expect(measured.failure).toBe(`stage1 exited 1: ${stderr.slice(-800)}`);
  expect(measured.writableControls.map((control) => control.mutation)).toEqual(controls().map((control) => control.mutation));
  expect(measured.stage3?.linearizable).toBe(true);
});

test('a container on another image, or a writable probe from another source, stops the run before it measures', async () => {
  const wrongImage = scriptedFixture({ identity: { ...PROVEN_IDENTITY, actualVersion: '0.0.1' } });
  const imageRun = await measure('run-image', wrongImage.fixture, REVIEWED_SOURCE);
  expect(imageRun.failure).toBe(`container identity mismatch: reports SANDBOX_VERSION 0.0.1, configured ${SANDBOX_IMAGE_VERSION}`);
  expect(wrongImage.steps).toEqual(['ready', 'setup', 'prepare']);

  const wrongSource = scriptedFixture();
  const sourceRun = await measure('run-source', wrongSource.fixture, 'e'.repeat(64));
  expect(sourceRun.failure).toBe('custom writable probe source digest does not match the reviewed fixture source');
  expect(wrongSource.steps).toEqual(['ready', 'setup', 'prepare', 'writable']);
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
  const dir = scratchDir('fuse-probe-test');

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

  const output = await persistFuseProbeArtifact(dir, artifact);
  expect(output).toBe(fuseProbeArtifactPath(dir, 'unique'));
  // The errno is the contract: link() emits no product message of its own,
  // and its sentence is libc wording.
  await expect(persistFuseProbeArtifact(dir, artifact)).rejects.toThrow(/EEXIST/);
  expect(planText()).toContain('FUSE_PROBE_IMAGE=registry/name@sha256:<digest>');
  expect(planText()).toContain('openat2 RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS');
  expect(planText()).toContain('idempotent');
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

/** The path of a fixture request, however the driver spelled it. */
function pathOf(input: URL | RequestInfo): string {
  return (input instanceof Request ? new URL(input.url) : new URL(input)).pathname;
}

test('the driver sets the container up only once the fixture accepts its token', async () => {
  const seen: string[] = [];
  let healthChecks = 0;

  const doFetch: FetchLike = async (input) => {
    seen.push(pathOf(input));

    if (pathOf(input) === '/health') return new Response(null, { status: ++healthChecks < 3 ? 401 : 200 });

    return Response.json({ exitCode: 0, stdout: '', stderr: '' });
  };

  const fixture = liveFixture(unitDeployment, doFetch, async () => undefined);

  await fixture.ready();
  await fixture.setup();

  expect(seen).toEqual(['/health', '/health', '/health', '/exec']);
});

test('a fixture answer that is not JSON names the route, the status and the body', async () => {
  const gateway: FetchLike = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 });

  await expect(liveFixture(unitDeployment, gateway, async () => undefined).prepare())
    .rejects.toThrow('/prepare (502) did not return JSON: <html>502 Bad Gateway</html>');
});

test('the fixture refuses a wrong token before reading the body, and answers health without the container', async () => {
  let boxes = 0;

  const unreached = (): ProbeBox => {
    boxes += 1;
    throw new Error('the container is not reached');
  };

  const call = (path: string, token: string | null, body?: string): Request => new Request(`https://probe.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', ...(body !== undefined && { body }),
    headers: token === null ? {} : { 'x-fuse-probe-token': token },
  });

  expect((await serveProbeRequest(call('/exec', 'wrong', '{not json'), 'right', unreached)).status).toBe(401);
  expect((await serveProbeRequest(call('/health', 'right'), undefined, unreached)).status).toBe(401);
  const health = await serveProbeRequest(call('/health', 'right'), 'right', unreached);
  expect([health.status, await health.json()]).toEqual([200, { ok: true }]);
  // A body its route does not accept is a 400 before any container call.
  expect((await serveProbeRequest(call('/exec', 'right', '{not json'), 'right', unreached)).status).toBe(400);
  expect(boxes).toBe(0);
});

test('an accepted body reaches the container, and a container failure is a 500 naming it', async () => {
  const commands: string[] = [];

  const box: ProbeBox = {
    exec: async (command) => {
      commands.push(command);

      if (command === 'false') throw new Error('the container went away');

      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    writeFile: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    prepare: async () => PROVEN_IDENTITY,
    startProcess: unstartedProcess,
    getProcess: async () => null,
  };

  const exec = (command: string): Request => new Request('https://probe.test/exec', {
    method: 'POST', body: JSON.stringify({ command }), headers: { 'x-fuse-probe-token': 'right' },
  });

  expect((await serveProbeRequest(exec('true'), 'right', () => box)).status).toBe(200);
  const failed = await serveProbeRequest(exec('false'), 'right', () => box);
  expect([failed.status, await failed.json()]).toEqual([500, { error: 'Error: the container went away' }]);
  expect(commands).toEqual(['true', 'false']);
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
      deleteContainerApps: () => {
        order.push('delete-container-apps');

        return ['absent'];
      },
      deleteWorker: () => {
        order.push('delete-worker');

        return !options.workerDeleteFails;
      },
      removeConfig: async () => { order.push('remove-config'); },
      sleep: async () => undefined,
    },
  };
}

/** A start the /destroy, /stop and /prepare cases never observe: those routes
 *  start no process. */
const unstartedProcess: ProbeBox['startProcess'] = async () => ({
  id: 'unused', status: 'completed', exitCode: 0, getLogs: async () => ({ stdout: '', stderr: '' }),
});

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
    startProcess: unstartedProcess,
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
    startProcess: async () => {
      starts += 1;

      return running;
    },
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

  const evidence = await awaitWritableMmapResult({
    deployment,
    operationId: 'fuse-run-42-positive',
    doFetch: async (input) => {
      requests.push(new URL(input instanceof Request ? input.url : input).pathname);

      return requests.at(-1) === '/start'
        ? new Response(JSON.stringify({ operationId: 'fuse-run-42-positive', status: 'running', exitCode: null, started: true }))
        : completed.clone();
    },
    sleep: async () => undefined,
  });

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
    startProcess: unstartedProcess,
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

  expect(deleteWorkerBothRoutes({ repoRoot: '/repo', configPath: '/cfg.jsonc', workerName: 'w', log, wrangle: absentOnFirstRoute })).toBe(true);

  // A different failure falls back to the second route, whose explicit
  // absence is also success.
  let calls = 0;

  const absentOnFallbackRoute = (): string => {
    calls++;

    return calls === 1
      ? 'WRANGLER_FAILED: something route-specific exploded'
      : 'WRANGLER_FAILED: could not find script w';
  };

  expect(deleteWorkerBothRoutes({ repoRoot: '/repo', configPath: '/cfg.jsonc', workerName: 'w', log, wrangle: absentOnFallbackRoute })).toBe(true);
  expect(calls).toBe(2);

  const alwaysFails = (): string => 'WRANGLER_FAILED: something else exploded';
  expect(deleteWorkerBothRoutes({ repoRoot: '/repo', configPath: '/cfg.jsonc', workerName: 'w', log, wrangle: alwaysFails })).toBe(false);
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
