/**
 * The decision rule, proved without a deployment.
 *
 * This rule decides which storage strategy ships, so it has to be checkable
 * against hand-built rows rather than only against a run that costs a container
 * and thirty minutes. Every test here pins a behaviour a plausible bug would
 * break, and the two that matter most are the refusals: a rule that returns a
 * winner for every input is not a rule, and a rule that treats an unmeasured arm
 * as an infinitely good one would have crowned `overlay-cas` on the day it could
 * not attach.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  R2_CLASS_A_USD_PER_MILLION, R2_CLASS_B_USD_PER_MILLION, decide, opsAreBlind, priceOps,
  sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';
import { refusalText } from './fixtures/storage-matrix/admission';
import {
  addressArmRequest,
  benchmarkExitCode,
  devboxAdmission,
  fixtureConfigForArms,
  isTransientContainerCreateError,
  parseFrozenControlArtifact,
  parseOptions,
  postLiveTeardown,
  rankableTicks,
  renderFrozenControls,
  resourceNames,
  startupPollVerdict,
  recommend,
  teardownLiveArms,
} from './bench-devbox-strategies';
const tick = (
  arm: string, workload: string, wallMs: number,
  extra: Partial<TickRecord> = {},
): TickRecord => ({
  arm,
  workload,
  segment: extra.segment ?? `${workload}-1`,
  wallMs,
  classA: extra.classA ?? 0,
  classB: extra.classB ?? 0,
  classFree: extra.classFree ?? 0,
  // PRESENCE, not truthiness. `?? 0` here coerced an explicit `null` to zero —
  // the exact collapse these tests exist to forbid, inside the helper that tests
  // for it.
  bytesPut: 'bytesPut' in extra ? extra.bytesPut ?? null : 0,
  heldBytes: extra.heldBytes ?? null,
  movedReported: extra.movedReported ?? true,
  unitsMoved: extra.unitsMoved ?? null,
  unitLabel: extra.unitLabel ?? 'delta bytes',
  outcome: extra.outcome ?? 'committed',
});
describe('arm request addressing', () => {
  test('every box request carries the arm instead of defaulting to chain', () => {
    expect(addressArmRequest('GET', '/ops?box=ab-overlay-cas'))
      .toEqual({ path: '/ops?box=ab-overlay-cas&strategy=overlay-cas' });
    expect(addressArmRequest('GET', '/ops?box=ab-overlay-cas-20260825230000'))
      .toEqual({
        path: '/ops?box=ab-overlay-cas-20260825230000&strategy=overlay-cas',
      });
    expect(addressArmRequest('POST', '/checkpoint?box=ab-r2fs', { kind: 'tick' }))
      .toEqual({
        path: '/checkpoint?box=ab-r2fs',
        body: { kind: 'tick', strategy: 'r2fs' },
      });
    expect(addressArmRequest('GET', '/state')).toEqual({ path: '/state' });
  });

  test('an explicit strategy is not rewritten', () => {
    expect(addressArmRequest(
      'POST',
      '/create?box=ab-overlay-cas',
      { strategy: 'snapshot-chain' },
    )).toEqual({
      path: '/create?box=ab-overlay-cas',
      body: { strategy: 'snapshot-chain' },
    });
  });
});

describe('startup polling contract', () => {
  test('waits for this restoration, not a stale durable attach record', () => {
    expect(startupPollVerdict({
      state: {
        restoration: 'unstarted',
        lastAttach: { kind: 'attached', detail: 'the previous generation' },
      },
    })).toEqual({ kind: 'pending' });
  });

  test('returns only after restoration publishes its durable attach outcome', () => {
    expect(startupPollVerdict({
      state: {
        restoration: 'attached',
        lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
      },
    })).toEqual({
      kind: 'attached',
      attach: { kind: 'attached', detail: 'the work directory is mounted' },
    });
  });

  test('stops polling only on a definitive unattached restoration', () => {
    expect(startupPollVerdict({
      state: { restoration: 'unattached', unready: 'the recovery ladder refused' },
    })).toEqual({ kind: 'failed', reason: 'the recovery ladder refused' });
  });
});


/** Ratios of exactly 12x on git and 4x on npm: comfortably over the bar. */
const clearsTheBar: TickRecord[] = [
  tick('snapshot-chain', 'git', 1200),
  tick('overlay-cas', 'git', 100),
  tick('snapshot-chain', 'npm', 400),
  tick('overlay-cas', 'npm', 100),
];

describe('the decision rule', () => {
  test('crowns the O(p) shape only when BOTH bars are cleared', () => {
    const verdict = decide(clearsTheBar, 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('o-p-wins');
    expect(verdict.kind === 'o-p-wins' ? verdict.detail : '').toContain('12.00x');
  });

  test('a git ratio over the bar does NOT win on its own', () => {
    // git 12x, npm 1.5x. The rule requires both, because a strategy that only
    // helps the rename-storm case is not a default.
    const verdict = decide([
      tick('snapshot-chain', 'git', 1200), tick('overlay-cas', 'git', 100),
      tick('snapshot-chain', 'npm', 150), tick('overlay-cas', 'npm', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
  });

  test('the chain stays when both ratios are under 3x', () => {
    const verdict = decide([
      tick('snapshot-chain', 'git', 250), tick('overlay-cas', 'git', 100),
      tick('snapshot-chain', 'npm', 200), tick('overlay-cas', 'npm', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('chain-stays');
    expect(verdict.kind === 'chain-stays' ? verdict.detail : '').toContain('not the bottleneck');
  });

  test('the band between the thresholds is undecided, not rounded to a winner', () => {
    // git 5x clears 3 but not 10; npm 4x clears 3. Neither branch applies.
    const verdict = decide([
      tick('snapshot-chain', 'git', 500), tick('overlay-cas', 'git', 100),
      tick('snapshot-chain', 'npm', 400), tick('overlay-cas', 'npm', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
    expect(verdict.kind === 'inconclusive' ? verdict.reason : '').toContain('deliberately leaves undecided');
  });

  test('the bar is inclusive at exactly 10x and 3x', () => {
    const verdict = decide([
      tick('snapshot-chain', 'git', 1000), tick('overlay-cas', 'git', 100),
      tick('snapshot-chain', 'npm', 300), tick('overlay-cas', 'npm', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('o-p-wins');
  });

  test('an arm that produced no ticks is REFUSED, never treated as infinitely fast', () => {
    // This is the shape that would have crowned an arm which could not attach.
    const missing = clearsTheBar.filter((row) => !(row.arm === 'overlay-cas' && row.workload === 'git'));
    const verdict = decide(missing, 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
    expect(verdict.kind === 'inconclusive' ? verdict.reason : '').toContain('no git ticks');
  });

  test('a zero-millisecond candidate is refused rather than dividing by zero', () => {
    const verdict = decide([
      tick('snapshot-chain', 'git', 1200), tick('overlay-cas', 'git', 0),
      tick('snapshot-chain', 'npm', 400), tick('overlay-cas', 'npm', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
    expect(verdict.kind === 'inconclusive' ? verdict.reason : '').toContain('cannot be a denominator');
  });

  test('the excludes arm is a separate workload and cannot substitute for npm', () => {
    // Only npm-excluded rows exist for the candidate, so npm is unmeasured. A
    // rule that silently accepted the excluded variant would report a ratio for
    // a workload nobody ran.
    const verdict = decide([
      tick('snapshot-chain', 'git', 1200), tick('overlay-cas', 'git', 100),
      tick('snapshot-chain', 'npm', 400), tick('overlay-cas', 'npm-excluded', 100),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
    expect(verdict.kind === 'inconclusive' ? verdict.reason : '').toContain('no npm ticks');
  });
});

describe('the lifecycle-proof gate at the rule', () => {
  test('a blank-disk arm is filtered out and the rule refuses to rank it', () => {
    const eligible = rankableTicks([
      { strategy: 'snapshot-chain', verifyPassed: true },
      { strategy: 'overlay-cas', verifyPassed: false },
    ], clearsTheBar);
    const verdict = decide(eligible, 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('inconclusive');
    expect(verdict.kind === 'inconclusive' ? verdict.reason : '').toContain('overlay-cas produced no');
  });

  test('a blank lifecycle arm refuses admission, ranking, recommendation, and success', () => {
    const arm = {
      strategy: 'bounded-layers' as const,
      box: 'blank-arm',
      verifyPassed: false,
      verifyChecks: [{ name: 'wake restoration', pass: false, detail: 'blank disk' }],
      attachColdMs: null, attachColdKind: '', attachWarmMs: null, attachWarmKind: '',
      checkpoints: [], stopMs: null, wakeMs: null, wakeKind: '', phases: [], decisiveTicks: [
        tick('bounded-layers', 'git', 10),
      ],
      quiescesBeforeDecisive: 0, decisiveQuiesces: 0,
      generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
      ops: null, teardown: null, notes: [],
    };
    const cleanup = {
      attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
      bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
      localSecretsProcessesAbsent: true, countersReconciled: true,
      replayIdempotent: true, multipartResidue: 0, errors: [],
    };
    const admission = devboxAdmission([arm], {
      date: '2026-08-28', worker: 'blank-fixture', bucket: 'blank-bucket',
      image: 'docker.io/cloudflare/sandbox:0.12.8', seed: '1', 'loop budget ms': '1',
    }, 'test-token', cleanup);

    expect(admission.admitted).toBe(false);
    expect(refusalText(admission)).toContain('blank disk');
    expect(rankableTicks([arm], arm.decisiveTicks)).toEqual([]);
    expect(() => recommend([arm], admission)).toThrow('RECOMMENDATION REFUSED');
    expect(benchmarkExitCode(null, admission)).toBe(1);
    // `--keep` may retain the resources for inspection; it cannot turn refusal
    // into a successful benchmark process.
    expect(benchmarkExitCode(null, admission)).toBe(1);
  });

  test('the driver has no monolithic verification request', () => {
    const source = readFileSync(new URL('./bench-devbox-strategies.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('/verify?box=');
  });

  test('a ratio near 1.0 is what a chain-measured-twice fallthrough would look like', () => {
    // Named because it nearly happened: an unrecognised strategy served the
    // chain by fallthrough would have produced two near-identical arms, a ratio
    // about 1.0, and a confident `chain stays default`. The rule cannot detect
    // that on its own — only the dispatch guard can — so this test exists to
    // record that the verdict shape is indistinguishable and the guard is what
    // makes it safe.
    const verdict = decide([
      tick('snapshot-chain', 'git', 1000), tick('overlay-cas', 'git', 1010),
      tick('snapshot-chain', 'npm', 800), tick('overlay-cas', 'npm', 795),
    ], 'snapshot-chain', 'overlay-cas');
    expect(verdict.kind).toBe('chain-stays');
  });
});

describe('detecting a blind op counter', () => {
  test('bytes moved with zero ops is blindness, not a cheap arm', () => {
    // The contradiction that makes it detectable: bytes reach R2 through a PUT or
    // a multipart part and there is no third way, so non-zero bytes with zero
    // operations of every class cannot describe a real tick.
    expect(opsAreBlind([
      tick('a', 'git', 100, { bytesPut: 536 * 1024 * 1024 }),
    ], 'git')).toBe(true);
  });

  test('a genuinely free tick is NOT blindness', () => {
    // A skipped checkpoint moves nothing and issues nothing. Calling that blind
    // would mark every correct no-op as an instrument fault.
    expect(opsAreBlind([tick('a', 'git', 5, { bytesPut: 0 })], 'git')).toBe(false);
  });

  test('any counted class clears it, including the free one', () => {
    // Deletes are billed at nothing but prove the counter is watching, so a
    // delete-only tick is measured rather than blind.
    expect(opsAreBlind([
      tick('a', 'git', 100, { bytesPut: 1024, classFree: 3 }),
    ], 'git')).toBe(false);
  });

  test('no ticks at all is not blindness either', () => {
    expect(opsAreBlind([], 'git')).toBe(false);
  });
});

describe('pricing and totals', () => {
  test('prices class A and class B at the published rates', () => {
    expect(priceOps(1_000_000, 0)).toBeCloseTo(R2_CLASS_A_USD_PER_MILLION, 10);
    expect(priceOps(0, 1_000_000)).toBeCloseTo(R2_CLASS_B_USD_PER_MILLION, 10);
    // Class A is the expensive one by an order of magnitude, which is why a
    // write-amplifying strategy loses on cost before it loses on latency.
    expect(priceOps(1_000_000, 0)).toBeGreaterThan(priceOps(0, 1_000_000) * 10);
  });

  test('free operations are counted and priced at nothing', () => {
    const totals = totalsFor([tick('a', 'git', 10, { classFree: 500 })], 'git');
    expect(totals.classFree).toBe(500);
    expect(totals.usd).toBe(0);
  });

  test('percentiles are nearest-rank, so p95 is always a measured value', () => {
    const rows = [10, 20, 30, 40, 1000].map((ms) => tick('a', 'git', ms));
    const totals = totalsFor(rows, 'git');
    expect(totals.p50WallMs).toBe(30);
    expect(totals.p95WallMs).toBe(1000);
    expect([10, 20, 30, 40, 1000]).toContain(totals.p95WallMs);
  });

  test('totals ignore other workloads, so one arm cannot borrow another\'s ticks', () => {
    const totals = totalsFor([
      tick('a', 'git', 100), tick('a', 'npm', 999_999),
    ], 'git');
    expect(totals.ticks).toBe(1);
    expect(totals.sumWallMs).toBe(100);
  });
});

describe('moved bytes are three-valued, and the third value is not zero', () => {
  test('a tick that cannot answer is counted as unanswerable, not as zero', () => {
    // A failed checkpoint may have landed blobs before throwing, and r2fs cannot
    // attribute bytes to a commit boundary at all. Coercing either to 0 would let
    // an unanswerable tick contribute a confident zero to a total.
    const totals = totalsFor([
      tick('a', 'git', 10, { bytesPut: 1024 }),
      tick('a', 'git', 10, { bytesPut: null, movedReported: false }),
    ], 'git');
    expect(totals.bytesPut).toBe(1024);
    expect(totals.unanswerable).toBe(1);
    expect(totals.movedReported).toBe(true);
  });

  test('a workload where NO tick can answer reports movedReported false', () => {
    // This is the r2fs shape. The renderer must print "not measurable" rather
    // than 0.0 MiB, because a sum of absences is zero and zero is a claim.
    const totals = totalsFor([
      tick('r2fs', 'npm', 10, { bytesPut: null, movedReported: false }),
      tick('r2fs', 'npm', 10, { bytesPut: null, movedReported: false }),
    ], 'npm');
    expect(totals.movedReported).toBe(false);
    expect(totals.unanswerable).toBe(2);
  });

  test("a skip's honest zero is answerable and is NOT unanswerable", () => {
    // A skip knows it moved nothing. Folding it in with the cannot-answer case
    // would lose the distinction the strategies deliberately draw.
    const totals = totalsFor([tick('a', 'git', 5, { bytesPut: 0 })], 'git');
    expect(totals.unanswerable).toBe(0);
    expect(totals.movedReported).toBe(true);
    expect(totals.bytesPut).toBe(0);
  });

  test('blindness detection ignores ticks that cannot answer', () => {
    // Otherwise every r2fs workload would read as a blind counter rather than as
    // a strategy that cannot attribute bytes to a commit.
    expect(opsAreBlind([tick('r2fs', 'npm', 10, { bytesPut: null, movedReported: false })], 'npm'))
      .toBe(false);
  });

  test('the sqlite median excludes unanswerable ticks rather than zeroing them', () => {
    const db = 64 * 1024 * 1024;
    const finding = sqliteFinding([
      tick('a', 'sqlite', 90, { segment: 'sqlite-rewrite-1', bytesPut: db }),
      tick('a', 'sqlite', 90, { segment: 'sqlite-rewrite-2', bytesPut: null, movedReported: false }),
    ], db);
    expect(finding).toContain('100%');
    expect(finding).not.toContain('0.0 MiB');
  });

  test('a sqlite arm where nothing can answer says so instead of dividing', () => {
    const finding = sqliteFinding([
      tick('r2fs', 'sqlite', 90, { segment: 'sqlite-rewrite-1', bytesPut: null, movedReported: false }),
    ], 64 * 1024 * 1024);
    expect(finding).toContain('none able to report bytes moved');
  });
});

describe('the sqlite finding', () => {
  test('names a whole-database re-ship when the tick moves most of the file', () => {
    const db = 64 * 1024 * 1024;
    const finding = sqliteFinding([
      tick('overlay-cas', 'sqlite', 900, { segment: 'sqlite-rewrite-1', bytesPut: db }),
      tick('overlay-cas', 'sqlite', 900, { segment: 'sqlite-rewrite-2', bytesPut: db }),
    ], db);
    expect(finding).toContain('extent-level tracking is the only thing');
    expect(finding).toContain('100%');
  });

  test('says extent tracking buys less when the tick moves a fraction', () => {
    const db = 64 * 1024 * 1024;
    const finding = sqliteFinding([
      tick('overlay-cas', 'sqlite', 90, { segment: 'sqlite-rewrite-1', bytesPut: db / 32 }),
    ], db);
    expect(finding).toContain('buys less than expected');
  });

  test('refuses a ratio when the database size was not measured', () => {
    const finding = sqliteFinding([
      tick('overlay-cas', 'sqlite', 90, { segment: 'sqlite-rewrite-1', bytesPut: 1024 }),
    ], -1);
    expect(finding).toContain('not measured');
    expect(finding).not.toContain('%');
  });

  test('the fill segment is not a rewrite tick', () => {
    // Charging the initial load as a rewrite would make every arm look like it
    // re-ships the database.
    const finding = sqliteFinding([
      tick('overlay-cas', 'sqlite', 5000, { segment: 'sqlite-fill', bytesPut: 64 * 1024 * 1024 }),
    ], 64 * 1024 * 1024);
    expect(finding).toContain('no sqlite rewrite ticks');
  });
});

describe('container create retry classification', () => {
  test('the two deployed transient signatures are retried', () => {
    expect(isTransientContainerCreateError(
      'There is no container instance that can be provided to this durable object',
    )).toBe(true);
    expect(isTransientContainerCreateError(
      'The container service is unreachable, try again later',
    )).toBe(true);
    expect(isTransientContainerCreateError('invalid strategy')).toBe(false);
  });
});

describe('per-run fixture deployment', () => {
  const template = readFileSync(join(import.meta.dir, '..', 'packages/devbox/bench/wrangler.jsonc'), 'utf8');
  const runId = '20260826003000';
  /** Typed by the driver's own parameter, so a strategy typo fails here. */
  interface FixtureCase {
    readonly arms: Parameters<typeof resourceNames>[1];
    readonly classes: readonly string[];
    readonly apps: readonly string[];
  }
  const cases: readonly FixtureCase[] = [
    {
      arms: ['bounded-layers', 'merkle-pack'],
      classes: ['BoundedLayersBox', 'MerklePackBox', 'BenchOpCounter'],
      apps: ['boundedlayersbox', 'merklepackbox'],
    },
    {
      arms: ['merkle-pack'],
      classes: ['MerklePackBox', 'BenchOpCounter'],
      apps: ['merklepackbox'],
    },
    {
      arms: ['snapshot-chain', 'r2fs', 'overlay-cas', 'bounded-layers', 'merkle-pack'],
      classes: ['SnapshotChainBox', 'R2fsBox', 'OverlayCasBox', 'BoundedLayersBox', 'MerklePackBox', 'BenchOpCounter'],
      apps: ['snapshotchainbox', 'r2fsbox', 'overlaycasbox', 'boundedlayersbox', 'merklepackbox'],
    },
    {
      arms: [],
      classes: ['BenchOpCounter'],
      apps: [],
    },
  ];

  for (const { arms, classes, apps } of cases) {
    test(`deploys only the selected [${arms.join(', ')}] fixture classes`, () => {
      const resources = resourceNames(runId, arms);
      const config = JSON.parse(fixtureConfigForArms(template, resources, arms, '/tmp/candidate.Dockerfile'));

      expect(resources.worker).toBe(`kinu-devbox-bench-${runId}`);
      expect(resources.bucket).toBe(resources.worker);
      expect(resources.containerApps).toEqual(apps.map((app) => `${resources.worker}-${app}`));
      expect(config.durable_objects.bindings.map((binding: { class_name: string }) => binding.class_name)).toEqual(classes);
      expect(config.migrations[0].new_sqlite_classes).toEqual(classes);
      expect(config.containers.map((container: { class_name: string }) => container.class_name)).toEqual(
        classes.filter((className: string) => className !== 'BenchOpCounter'),
      );
      for (const container of config.containers) {
        expect(container.image).toBe(
          container.class_name === 'BoundedLayersBox' || container.class_name === 'MerklePackBox'
            ? '/tmp/candidate.Dockerfile'
            : 'docker.io/cloudflare/sandbox:0.12.8',
        );
      }
    });
  }
  test('drops a future migration whose classes are all pruned', () => {
    const synthetic = template.replace(
      '"migrations": [',
      '"migrations": [{ "tag": "future", "new_sqlite_classes": ["FutureBox"] },',
    );
    const config = JSON.parse(fixtureConfigForArms(
      synthetic,
      resourceNames(runId, ['bounded-layers']),
      ['bounded-layers'],
      '/tmp/candidate.Dockerfile',
    ));
    expect(config.migrations.some((migration: { tag: string }) => migration.tag === 'future')).toBe(false);
  });
});


describe('candidate-only controls', () => {
  const multiArmArtifact = JSON.stringify({
    meta: {
      date: '2026-08-25',
      worker: 'control-worker',
      bucket: 'control-bucket',
      image: 'docker.io/cloudflare/sandbox:0.12.8',
      seed: '20260824',
      'loop budget ms': '6000',
    },
    arms: [
      { strategy: 'snapshot-chain', verifyPassed: true },
      { strategy: 'r2fs', verifyPassed: false },
      { strategy: 'bounded-layers', verifyPassed: true },
    ],
  });

  test('selects current candidates and accepts optional, strategy-qualified controls', () => {
    const options = parseOptions([
      '--candidates-only',
      '--control', 'snapshot-chain=bench-artifacts/controls.json',
      '--control', 'r2fs=bench-artifacts/controls.json',
    ]);

    expect(options.arms).toEqual(['bounded-layers', 'merkle-pack']);
    expect(options.controls).toEqual([
      { strategy: 'snapshot-chain', path: 'bench-artifacts/controls.json' },
      { strategy: 'r2fs', path: 'bench-artifacts/controls.json' },
    ]);
    expect(parseOptions(['--candidates-only']).controls).toEqual([]);
    expect(() => parseOptions(['--candidates-only', '--arms', 'snapshot-chain'])).toThrow(
      '--candidates-only selects bounded-layers and merkle-pack',
    );
    expect(() => parseOptions(['--control', '--plan'])).toThrow(
      '--control requires <strategy>=<path>',
    );
    expect(() => parseOptions(['--control', 'snapshot-chain'])).toThrow(
      '--control requires <strategy>=<path>; got "snapshot-chain"',
    );
    expect(() => parseOptions(['--control', 'bounded-layers=bench-artifacts/control.json'])).toThrow(
      '--control strategy "bounded-layers" is not a historical control; known controls: snapshot-chain, r2fs, overlay-cas',
    );
    expect(() => parseOptions([
      '--control', 'snapshot-chain=bench-artifacts/one.json',
      '--control', 'snapshot-chain=bench-artifacts/two.json',
    ])).toThrow('--control must not repeat strategy "snapshot-chain"');
  });

  test('plans candidate-only work and reports strategy-qualified control context', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devbox-control-'));
    const path = join(directory, 'control.json');
    writeFileSync(path, multiArmArtifact);
    try {
      const plan = Bun.spawnSync(
        [
          'bun', 'scripts/bench-devbox-strategies.ts', '--candidates-only', '--plan',
          '--control', `snapshot-chain=${path}`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      expect(plan.exitCode, plan.stderr.toString()).toBe(0);
      expect(plan.stdout.toString()).toContain('arms          bounded-layers, merkle-pack');
      expect(plan.stdout.toString()).toContain(`controls      snapshot-chain=${path}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('documents strategy-qualified controls in CLI help', () => {
    const help = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--help'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(help.exitCode, help.stderr.toString()).toBe(0);
    expect(help.stdout.toString()).toContain('--control <strategy>=<path>');
    expect(help.stdout.toString()).toContain('snapshot-chain, r2fs, overlay-cas');
  });

  test('selects exactly one named control from a multi-arm artifact and preserves provenance', () => {
    const parsed = parseFrozenControlArtifact(
      'r2fs',
      'bench-artifacts/multi-arm-control.json',
      multiArmArtifact,
    );

    expect(parsed).toMatchObject({
      strategy: 'r2fs',
      verifyPassed: false,
      artifact: 'bench-artifacts/multi-arm-control.json',
      date: '2026-08-25',
      worker: 'control-worker',
      bucket: 'control-bucket',
      image: 'docker.io/cloudflare/sandbox:0.12.8',
      seed: '20260824',
      budgetMs: '6000',
      sha256: createHash('sha256').update(multiArmArtifact).digest('hex'),
    });
    const report = renderFrozenControls([parsed]);
    expect(report).toContain('bench-artifacts/multi-arm-control.json#sha256:');
    expect(report).toContain('control-worker');
    expect(report).toContain('control-bucket');
    expect(report).toContain('6000');
    expect(report).toContain('REFUSED');
    expect(report).toContain('Candidate ranking uses only measurements from this run.');
  });

  test('refuses missing or duplicate selected strategies in a valid multi-arm artifact', () => {
    expect(() => parseFrozenControlArtifact('overlay-cas', 'bench-artifacts/missing.json', multiArmArtifact)).toThrow(
      'control artifact bench-artifacts/missing.json must contain exactly one requested overlay-cas arm; found 0',
    );
    expect(() => parseFrozenControlArtifact(
      'snapshot-chain',
      'bench-artifacts/duplicate.json',
      JSON.stringify({
        meta: {
          date: '2026-08-25',
          image: 'docker.io/cloudflare/sandbox:0.12.8',
          seed: '20260824',
          'loop budget ms': '6000',
        },
        arms: [
          { strategy: 'snapshot-chain', verifyPassed: true },
          { strategy: 'snapshot-chain', verifyPassed: false },
          { strategy: 'merkle-pack', verifyPassed: true },
        ],
      }),
    )).toThrow(
      'control artifact bench-artifacts/duplicate.json must contain exactly one requested snapshot-chain arm; found 2',
    );
  });

  test('refuses artifacts outside the control contract', () => {
    expect(() => parseFrozenControlArtifact(
      'r2fs',
      'bench-artifacts/bad-control.json',
      JSON.stringify({ meta: {}, arms: [{ strategy: 'r2fs', verifyPassed: true }] }),
    )).toThrow('control artifact bench-artifacts/bad-control.json does not match the control contract');
  });
});

class DeferredVerifyResponse extends EventEmitter {
  readonly statusCode = 200;

  destroy(error?: Error): void {
    if (error !== undefined) this.emit('error', error);
  }
}

class DeferredVerifyRequest extends EventEmitter {
  body = '';
  onEnd: ((body: string) => void) | null = null;

  end(body: string): void {
    this.body = body;
    this.onEnd?.(body);
  }

  destroy(error?: Error): void {
    if (error !== undefined) this.emit('error', error);
  }
}

describe('live arm teardown', () => {
  test('purges every potential arm twice after a timeout before the first result', async () => {
    const boxes = ['ab-snapshot-chain-20260827000000', 'ab-r2fs-20260827000000'];
    const calls: { box: string; payload: unknown }[] = [];
    const errors = await teardownLiveArms(
      { origin: 'https://fixture.invalid', token: 'memory-only-token' },
      boxes,
      async (_fixture, box, payload) => {
        calls.push({ box, payload });
        if (box === boxes[0] && calls.filter((call) => call.box === box).length === 1) {
          throw new DOMException('the first arm timed out', 'TimeoutError');
        }
      },
    );

    expect(calls).toEqual([
      { box: boxes[0], payload: { purge: true, prefix: '', whole: true } },
      { box: boxes[1], payload: { purge: true, prefix: '', whole: true } },
      { box: boxes[0], payload: { purge: true, prefix: '', whole: true } },
      { box: boxes[1], payload: { purge: true, prefix: '', whole: true } },
    ]);
    expect(errors).toEqual([
      `live teardown pass 1 ${boxes[0]}: the first arm timed out`,
    ]);
  });
});

describe('long teardown transport', () => {
  test('waits for a deferred HTTPS purge reply without an elapsed timeout', async () => {
    const release = Promise.withResolvers<void>();
    const request = new DeferredVerifyRequest();
    let requestedUrl = '';
    let headers: Readonly<Record<string, string>> = {};
    const teardown = postLiveTeardown(
      { origin: 'https://fixture.invalid', token: 'memory-only-token' },
      'ab-snapshot-chain-20260827000000',
      (url, options, respond) => {
        requestedUrl = url.toString();
        headers = options.headers;
        request.onEnd = () => {
          void release.promise.then(() => {
            const response = new DeferredVerifyResponse();
            respond(response);
            response.emit('data', JSON.stringify({ ok: true, purged: 4 }));
            response.emit('end');
          });
        };
        return request;
      },
    );

    await Promise.resolve();
    expect(request.body).toBe(JSON.stringify({
      purge: true,
      prefix: '',
      whole: true,
      strategy: 'snapshot-chain',
    }));
    expect(requestedUrl).toBe('https://fixture.invalid/teardown?box=ab-snapshot-chain-20260827000000');
    expect(headers).toMatchObject({
      authorization: 'Bearer memory-only-token',
      'content-type': 'application/json',
    });
    expect(requestedUrl).not.toContain('memory-only-token');
    expect(request.body).not.toContain('memory-only-token');

    release.resolve();
    await expect(teardown).resolves.toBeUndefined();
  });
});
