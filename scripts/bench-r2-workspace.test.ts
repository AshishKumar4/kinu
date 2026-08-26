// Credential-free verification of the R2 workspace-layout benchmark: the
// statistics it is allowed to report, the determinism of its workload, the
// containment property of its key scoping, the honesty of its option sets, and
// the renderer's refusal to rank arms whose repetitions disagreed.
//
// None of it needs a container, a bucket, or a credential, which is what makes
// it a gate. The parts that DO need a container are the measurements themselves,
// and a measurement cannot be unit-tested into existence — so what is pinned
// here is everything that could silently make a real measurement wrong.
import { describe, expect, test } from 'bun:test';
import {
  REJECTED_S3FS_OPTIONS, SDK_DEFAULT_R2_S3FS_OPTIONS, SDK_FORCED_S3FS_OPTIONS,
  SDK_REFUSED_S3FS_OPTIONS, TUNED_S3FS_OPTIONS, benchKeyPrefix, layoutsFor, mountPrefixFor,
  mountSignature,
} from './fixtures/r2-bench/layouts';
import {
  EMPTY_SUMMARY, UNSTABLE_CV, isUnstable, mulberry32, percentile, randomOffsets, slowdown,
  summarize, throughputMiBs,
} from './fixtures/r2-bench/stats';
import {
  HEADLINE_METRICS, aggregate, recommend, renderMarkdown, verdictTable,
  type LayoutAggregates, type LayoutResult, type ProbeRun, type RunArtifact,
} from './fixtures/r2-bench/report';
import { evaluateRun, recordFromR2Artifact } from './fixtures/storage-matrix/admission';

describe('statistics the report is allowed to make', () => {
  test('an empty sample reports zero observations rather than a number', () => {
    const summary = summarize([]);
    expect(summary).toEqual(EMPTY_SUMMARY);
    expect(summary.n).toBe(0);
  });

  test('percentiles are nearest-rank, so every reported value is one an operation took', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0.99)).toBe(10);
    // Interpolation would produce 5.5 here, a latency nothing measured.
    expect(sorted).toContain(percentile(sorted, 0.5));
  });

  test('a single observation is summarised without inventing dispersion', () => {
    const summary = summarize([42]);
    expect(summary.n).toBe(1);
    expect(summary.p50).toBe(42);
    expect(summary.p95).toBe(42);
    expect(summary.stddev).toBe(0);
    expect(summary.cv).toBe(0);
  });

  test('the sample standard deviation uses n-1, and cv is its ratio to the mean', () => {
    const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(summary.mean).toBe(5);
    // Population sd here is 2; the sample sd is sqrt(32/7).
    expect(summary.stddev).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(summary.cv).toBeCloseTo(Math.sqrt(32 / 7) / 5, 10);
  });

  test('dispersion above the threshold marks an arm unrankable, and one observation never does', () => {
    const steady = summarize([100, 101, 99, 100]);
    expect(steady.cv).toBeLessThan(UNSTABLE_CV);
    expect(isUnstable(steady)).toBe(false);

    const erratic = summarize([10, 200, 15, 180]);
    expect(erratic.cv).toBeGreaterThan(UNSTABLE_CV);
    expect(isUnstable(erratic)).toBe(true);

    // A single repetition cannot disagree with itself, so it is never flagged —
    // it is reported with n=1 and the reader can see the sample size.
    expect(isUnstable(summarize([10]))).toBe(false);
  });

  test('a zero-duration measurement reports no throughput instead of Infinity', () => {
    expect(throughputMiBs(1024 * 1024, 0)).toBe(0);
    expect(throughputMiBs(1024 * 1024, 1000)).toBe(1);
    expect(Number.isFinite(throughputMiBs(5, 0))).toBe(true);
  });

  test('a slowdown against a missing control is absent, not a division artefact', () => {
    expect(slowdown(10, 0)).toBeNull();
    expect(slowdown(0, 10)).toBeNull();
    expect(slowdown(30, 10)).toBe(3);
  });
});

describe('the workload is the same workload on every arm', () => {
  test('the generator is reproducible from its seed and differs between seeds', () => {
    const a = Array.from({ length: 8 }, mulberry32(7));
    const b = Array.from({ length: 8 }, mulberry32(7));
    const c = Array.from({ length: 8 }, mulberry32(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('random offsets are block-aligned, in range, and identical across arms', () => {
    const fileBytes = 32 * 1024 * 1024;
    const block = 4096;
    const first = randomOffsets(fileBytes, block, 256, 99);
    const second = randomOffsets(fileBytes, block, 256, 99);
    expect(first).toEqual(second);
    expect(first).toHaveLength(256);
    for (const offset of first) {
      // Unaligned reads span two blocks and measure a different thing on every
      // filesystem in the comparison, so alignment is load-bearing.
      expect(offset % block).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + block).toBeLessThanOrEqual(fileBytes);
    }
  });

  test('a file smaller than one block still yields a legal offset', () => {
    expect(randomOffsets(1000, 4096, 4, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('key scoping is containment, not convention', () => {
  test('the prefix the mount writes and the prefix teardown deletes are the same prefix', () => {
    // If these two drift, the benchmark writes under one prefix and deletes
    // another, and "leaves no resources" becomes false silently. This is the
    // cheapest possible check for the most expensive possible mistake.
    for (const runId of ['20260824120000', 'abc', '0']) {
      expect(`${mountPrefixFor(runId)}/`).toBe(`/${benchKeyPrefix(runId)}`);
    }
  });

  test('mountBucket requires a leading slash and no trailing slash', () => {
    const prefix = mountPrefixFor('20260824120000');
    expect(prefix.startsWith('/')).toBe(true);
    expect(prefix.endsWith('/')).toBe(false);
  });

  test('every mounted arm is scoped to the run, and the control is not mounted at all', () => {
    const runId = '20260824120000';
    const layouts = layoutsFor(runId);
    expect(layouts.map((l) => l.id)).toEqual(['native', 'r2-uncached', 'r2-tuned', 'overlay']);
    const native = layouts.find((l) => l.id === 'native');
    expect(native?.mount).toBeUndefined();
    for (const layout of layouts.filter((l) => l.mount !== undefined)) {
      expect(layout.mount?.prefix).toBe(mountPrefixFor(runId));
    }
  });

  test('the plan is a pure function of the run id', () => {
    expect(layoutsFor('A')).toEqual(layoutsFor('A'));
    expect(layoutsFor('A')).not.toEqual(layoutsFor('B'));
  });

  test('a remount is forced whenever readOnly or the option set differs', () => {
    const layouts = layoutsFor('20260824120000');
    const signatures = layouts.map(mountSignature).filter((s) => s !== null);
    // Three mounted arms, three distinct mounts: the SDK refuses a second mount
    // of one binding at a different readOnly value, so two arms sharing a
    // signature would mean one silently ran on the other's mount.
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(mountSignature(layouts[0]!)).toBeNull();
  });
});

describe('the option sets say what they do', () => {
  test('the uncached arm is exactly the SDK defaults, and asks for nothing itself', () => {
    const uncached = layoutsFor('r').find((l) => l.id === 'r2-uncached');
    expect(uncached?.mount?.s3fsOptions).toEqual([]);
    // Documented so the report can print what the arm IS rather than an empty
    // list that reads as "no options".
    expect(SDK_DEFAULT_R2_S3FS_OPTIONS).toContain('stat_cache_expire=60');
    expect(SDK_DEFAULT_R2_S3FS_OPTIONS).toContain('enable_noobj_cache');
    expect(SDK_DEFAULT_R2_S3FS_OPTIONS).toContain('multipart_size=5');
    expect(SDK_DEFAULT_R2_S3FS_OPTIONS).toContain('nomixupload');
  });

  test('the tuned arm asks for nothing the SDK would override or refuse', () => {
    const names = TUNED_S3FS_OPTIONS.map((option) => option.split('=')[0]);
    for (const forced of SDK_FORCED_S3FS_OPTIONS) {
      // An option the SDK applies AFTER the caller's cannot take effect, so
      // requesting it would be a tuning claim the run cannot support.
      expect(names).not.toContain(forced);
    }
    for (const refused of SDK_REFUSED_S3FS_OPTIONS) {
      expect(names).not.toContain(refused);
    }
  });

  test('the tuned arm does not contain anything it declared rejected', () => {
    const names = new Set(TUNED_S3FS_OPTIONS.map((option) => option.split('=')[0]));
    for (const { option } of REJECTED_S3FS_OPTIONS) {
      const name = option.split('=')[0]!.split(' ')[0]!;
      if (name === 'use_cache' || name === 'parallel_count') continue; // rejected at a VALUE, present at another
      expect(names.has(name)).toBe(false);
    }
  });

  test('use_cache is never requested without a disk floor beside it', () => {
    const hasCache = TUNED_S3FS_OPTIONS.some((o) => o.startsWith('use_cache='));
    const hasFloor = TUNED_S3FS_OPTIONS.some((o) => o.startsWith('ensure_diskfree='));
    const hasDrop = TUNED_S3FS_OPTIONS.includes('del_cache');
    // The cache shares the container's 8000 MB disk with /workspace. Unbounded,
    // the arm ends in ENOSPC on an unrelated write and reports a write failure
    // instead of a cache result.
    expect(hasCache).toBe(hasFloor);
    expect(hasCache).toBe(hasDrop);
  });

  test('every rejected option carries a reason', () => {
    expect(REJECTED_S3FS_OPTIONS.length).toBeGreaterThan(0);
    for (const rejected of REJECTED_S3FS_OPTIONS) {
      expect(rejected.reason.length).toBeGreaterThan(40);
    }
  });
});

// ── renderer fixtures ───────────────────────────────────────────────────────
function probeRun(values: { create: number; stat: number; p95?: number; fsync?: boolean }): ProbeRun {
  return {
    schema: 'r2-bench/probe@1',
    root: '/x',
    seed: 1,
    loopBudgetMs: 30_000,
    phases: [{
      phase: 'small',
      status: 'ok',
      wallMs: 10,
      cpuUserMs: 4,
      cpuSystemMs: 1,
      metrics: [
        {
          name: 'small-create-1k',
          summary: summarize([values.create, values.create, values.p95 ?? values.create]),
          wallMs: values.create * 3,
          ops: 3,
        },
        {
          name: 'small-stat-1k',
          summary: summarize([values.stat]),
          wallMs: values.stat,
          ops: 1,
        },
      ],
      verdicts: [
        { name: 'rename-file', holds: true, detail: 'moved' },
        { name: 'fsync-directory', holds: values.fsync ?? values.stat < 5, detail: 'ENOTSUP' },
      ],
    }],
  };
}

function layout(id: LayoutResult['id'], reps: readonly ProbeRun[], extra: Partial<LayoutResult> = {}): LayoutResult {
  return {
    id,
    label: id,
    question: 'q',
    root: `/${id}`,
    s3fsOptions: [],
    readOnly: null,
    mountColdMs: id === 'native' ? null : 900,
    mountWarmMs: id === 'native' ? null : 400,
    mountError: null,
    reps,
    ops: id === 'native' ? null : { calls: { get: 5, put: 7, delete: 3 }, classA: 7, classB: 5, classFree: 3, total: 15 },
    objectsAfter: id === 'native' ? null : 42,
    bytesAfter: id === 'native' ? null : 4096,
    sync: null,
    durability: { verdict: true, detail: '24 intact', restartMs: 2500 },
    notes: [],
    ...extra,
  };
}

function artifactOf(layouts: readonly LayoutResult[]): RunArtifact {
  const artifact = {
    schema: 'r2-bench/run@1' as const,
    runId: '20260824120000',
    startedAt: '2026-08-24T12:00:00.000Z',
    finishedAt: '2026-08-24T12:40:00.000Z',
    repetitions: 3,
    seed: 20260824,
    mode: 'dev-remote',
    bucket: 'kinu-bench-r2fs',
    keyPrefix: 'bench/20260824120000/',
    versions: { commit: 'abc1234', '@cloudflare/sandbox': '0.12.8', image: 'docker.io/cloudflare/sandbox:0.12.8' },
    containerFacts: 'Linux 6.6 x86_64\n2\nMemTotal: 6333952 kB',
    layouts,
    teardown: { objectsDeleted: 42, objectsRemaining: 0, bucketDeleted: true },
    conditions: ['readOnly mount refuses writes: yes'],
  };
  return {
    ...artifact,
    admission: evaluateRun(recordFromR2Artifact(artifact, {
      declaredStages: [],
      confirmatoryPlan: null,
      cleanup: {
        attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
        bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
        localSecretsProcessesAbsent: true, countersReconciled: true,
        replayIdempotent: true, multipartResidue: 0, errors: [],
      },
      deciding: [],
      decidingBudgetMs: 30_000,
      publication: {
        readOnlyDeclared: false, readOnlyRefusedWrites: null, faultCutCompleted: true,
        allOldOrAllNew: true, barrierAckLoss: 0, absentReferences: 0, rollbackOrPhantomRoot: false,
      },
      security: {
        credentialLeaks: [], securityCellsComplete: true, prefixEscapes: 0,
        capabilityEscapesOrReplays: 0, staleWriterAccepted: false, hostileMetadataAccepted: false,
      },
      restore: [],
    })),
  };
}

describe('aggregation across repetitions', () => {
  test('a metric is summarised over the per-repetition medians, and the count is the repetitions', () => {
    const reps = [probeRun({ create: 10, stat: 1 }), probeRun({ create: 20, stat: 2 }), probeRun({ create: 30, stat: 3 })];
    const aggregated = aggregate(reps);
    const create = aggregated.get('small-create-1k');
    expect(create?.reps).toBe(3);
    expect(create?.acrossReps.n).toBe(3);
    expect(create?.acrossReps.p50).toBe(20);
  });

  test('repetitions that disagree are marked unstable rather than averaged into a ranking', () => {
    const steady = aggregate([probeRun({ create: 10, stat: 1 }), probeRun({ create: 10, stat: 1 })]);
    expect(steady.get('small-create-1k')?.unstable).toBe(false);

    const erratic = aggregate([probeRun({ create: 5, stat: 1 }), probeRun({ create: 500, stat: 1 })]);
    expect(erratic.get('small-create-1k')?.unstable).toBe(true);
  });

  test('a verdict that held in some repetitions and not others is reported as flaky', () => {
    const rows = verdictTable([probeRun({ create: 1, stat: 1 }), probeRun({ create: 1, stat: 9 })]);
    const fsync = rows.find((row) => row.name === 'fsync-directory');
    expect(fsync?.of).toBe(2);
    expect(fsync?.held).toBe(1);
    const rename = rows.find((row) => row.name === 'rename-file');
    expect(rename?.held).toBe(2);
    expect(rename?.of).toBe(2);
  });
});

describe('the rendered section', () => {
  const rendered = renderMarkdown(artifactOf([
    layout('native', [probeRun({ create: 1, stat: 1 })]),
    layout('r2-uncached', [probeRun({ create: 400, stat: 60 })]),
  ]));

  test('states the date, the repetition count and the seed', () => {
    expect(rendered).toContain('2026-08-24');
    expect(rendered).toContain('3 repetitions');
    expect(rendered).toContain('20260824');
  });

  test('records the container facts and the exact versions that produced the numbers', () => {
    expect(rendered).toContain('MemTotal');
    expect(rendered).toContain('0.12.8');
    expect(rendered).toContain('abc1234');
  });

  test('prints the option sets and the rejected configurations by name', () => {
    expect(rendered).toContain('stat_cache_expire=60');
    expect(rendered).toContain('use_cache=');
    expect(rendered).toContain('nomultipart');
    expect(rendered).toContain('parallel_count=32');
  });

  test('deletes are reported in their own class, never folded into the billed one', () => {
    // The phases that decide this benchmark are create/stat/read/DELETE over
    // thousands of objects. Folding deletes into class A overstates the bill;
    // dropping them understates the work. Both are wrong in a way that reads as
    // a result, so the table carries three classes and `total` sums all three.
    const withOps = artifactOf([
      layout('native', [probeRun({ create: 1, stat: 1 })]),
      layout('r2-uncached', [probeRun({ create: 400, stat: 60 })]),
    ]);
    const ops = withOps.layouts[1]!.ops!;
    expect(ops.classA).toBe(7);
    expect(ops.classB).toBe(5);
    expect(ops.classFree).toBe(3);
    expect(ops.classA + ops.classB + ops.classFree).toBe(ops.total);
    expect(renderMarkdown(withOps)).toContain('R2 free');
  });

  test('names the teardown result, so a run that left objects cannot look clean', () => {
    expect(rendered).toContain('objectsRemaining: 0');
    expect(rendered).toContain('bucketDeleted: true');
  });

  test('a metric no arm measured is absent rather than reported as zero', () => {
    // The fixture only produces small-file metrics; a 100 MiB write row would be
    // a fabricated measurement.
    expect(rendered).not.toContain('| `write-100MiB` |');
    expect(rendered).toContain('| `small-create-1k` |');
    expect(HEADLINE_METRICS).toContain('write-100MiB');
  });

  test('an arm that refused says so instead of appearing as a missing row', () => {
    const withRefusal = renderMarkdown(artifactOf([
      layout('native', [probeRun({ create: 1, stat: 1 })]),
      layout('r2-tuned', [], { mountError: 'InvalidMountConfigError: option "url" cannot be overridden' }),
    ]));
    expect(withRefusal).toContain('Arms that refused');
    expect(withRefusal).toContain('cannot be overridden');
  });

  test('unstable arms carry the marker and are named as unranked', () => {
    const unstable = renderMarkdown(artifactOf([
      layout('native', [probeRun({ create: 1, stat: 1 }), probeRun({ create: 1, stat: 1 })]),
      layout('r2-uncached', [probeRun({ create: 5, stat: 1 }), probeRun({ create: 500, stat: 1 })]),
    ]));
    expect(unstable).toContain('!');
    expect(unstable).toMatch(/not ranked/);
  });
});

describe('the recommendation follows the numbers', () => {
  const aggregatesOf = (layouts: readonly LayoutResult[]): LayoutAggregates => {
    const map: LayoutAggregates = new Map();
    for (const item of layouts) map.set(item.id, aggregate(item.reps));
    return map;
  };

  test('a metadata gap of orders of magnitude rejects R2-primary', () => {
    const layouts = [
      layout('native', [probeRun({ create: 1, stat: 0.5 })]),
      layout('r2-uncached', [probeRun({ create: 400, stat: 60, fsync: true })]),
      layout('r2-tuned', [probeRun({ create: 200, stat: 30, fsync: true })]),
    ];
    const verdict = recommend(artifactOf(layouts), aggregatesOf(layouts));
    expect(verdict).toContain('R2-PRIMARY IS REJECTED');
    expect(verdict).toMatch(/container disk/);
  });

  test('a close arm that also holds every invariant is allowed to be defensible', () => {
    const layouts = [
      layout('native', [probeRun({ create: 1, stat: 1 })]),
      layout('r2-uncached', [probeRun({ create: 3, stat: 2 })]),
      layout('r2-tuned', [probeRun({ create: 2, stat: 1.5 })]),
    ];
    const verdict = recommend(artifactOf(layouts), aggregatesOf(layouts));
    expect(verdict).toContain('DEFENSIBLE');
  });

  test('without a native control nothing is recommended, because nothing has a denominator', () => {
    const layouts = [layout('r2-uncached', [probeRun({ create: 400, stat: 60, fsync: true })])];
    const verdict = recommend(artifactOf(layouts), aggregatesOf(layouts));
    expect(verdict).toContain('no recommendation');
  });

  test('a broken POSIX invariant on an R2 arm is named in the verdict', () => {
    const layouts = [
      layout('native', [probeRun({ create: 1, stat: 1 })]),
      // stat >= 5 makes the fixture's fsync-directory verdict false.
      layout('r2-uncached', [probeRun({ create: 400, stat: 60 })]),
    ];
    expect(() => recommend(artifactOf(layouts), aggregatesOf(layouts))).toThrow('fsync-directory');
  });

  test('missing provenance and dirty teardown cannot call recommend', () => {
    const layouts = [
      layout('native', [probeRun({ create: 1, stat: 1 })]),
      layout('r2-uncached', [probeRun({ create: 3, stat: 2 })]),
    ];
    const base = artifactOf(layouts);
    const extras = {
      declaredStages: [] as const,
      confirmatoryPlan: null,
      deciding: [],
      decidingBudgetMs: 30_000,
      publication: {
        readOnlyDeclared: false, readOnlyRefusedWrites: null, faultCutCompleted: true,
        allOldOrAllNew: true, barrierAckLoss: 0, absentReferences: 0, rollbackOrPhantomRoot: false,
      },
      security: {
        credentialLeaks: [], securityCellsComplete: true, prefixEscapes: 0,
        capabilityEscapesOrReplays: 0, staleWriterAccepted: false, hostileMetadataAccepted: false,
      },
      restore: [],
    };
    const cleanCleanup = {
      attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
      bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
      localSecretsProcessesAbsent: true, countersReconciled: true,
      replayIdempotent: true, multipartResidue: 0, errors: [],
    };
    const missingDraft = { ...base, versions: { ...base.versions, commit: '' } };
    const missingProvenance = {
      ...missingDraft,
      admission: evaluateRun(recordFromR2Artifact(missingDraft, {
        ...extras,
        cleanup: cleanCleanup,
      })),
    };
    expect(() => recommend(missingProvenance, aggregatesOf(layouts))).toThrow('not a git revision');
    expect(renderMarkdown(missingProvenance)).toContain('RECOMMENDATION REFUSED');

    const dirtyTeardown = {
      ...base,
      admission: evaluateRun(recordFromR2Artifact(base, {
        ...extras,
        cleanup: { ...cleanCleanup, bucketAndMultipartEmpty: false, multipartResidue: 1 },
      })),
    };
    expect(() => recommend(dirtyTeardown, aggregatesOf(layouts))).toThrow('multipart upload');
  });
});
