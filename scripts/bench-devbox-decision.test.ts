/**
 * The decision rule, proved without a deployment.
 *
 * This rule decides which storage strategy ships, so it has to be checkable
 * against hand-built rows rather than only against a run that costs a container
 * and thirty minutes. Every test here pins a behaviour a plausible bug would
 * break, and the two that matter most are the refusals: a rule that returns a
 * winner for every input is not a rule, and a rule that treats an unmeasured arm
 * as an infinitely good one would have crowned an arm on the day it could not
 * attach.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  opsAreBlind, sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';

import * as v from 'valibot';
import { WRANGLER_FAILED } from './fixtures/r2-bench/deploy-substrate';
import { scratchDir } from '@kinu.run/test-utils';
import {
  COMPLEXITY_TREE_BYTES,
  chainArchiveExpectations,
  controlWitnessChecks,
  cleanupObservationProbes,
  decodeComplexityRows,
  describeStartupState,
  drainBucketResidue,
  isRearmableStartupRefusal,
  isTransientContainerCreateError,
  parseOptions,
  readArmArtifact,
  runArm,
  render,
  orphanTeardownExecutor,
  SANDBOX_IMAGE,
  startupPollVerdict,
  writeArmArtifact,
  type ArmResult,
  type ComplexityRow,
  type ControlWitnessFacts,
  type Strategy,
  countedRestoreWork,
  diffOpTallies,
  restoreWorkFromCounts,
  verifyRestoreBound,
} from './bench-devbox-strategies';

const tick = (
  arm: string, workload: string, wallMs: number,
  extra: Partial<TickRecord> = {},
): TickRecord => ({
  arm,
  workload,
  repetition: extra.repetition ?? 1,
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

  test('a definitive refusal outranks a stopped container: a refusal is never driven', () => {
    expect(startupPollVerdict({
      state: { running: false, restoration: 'unattached', unready: 'the recovery ladder refused' },
    })).toEqual({ kind: 'failed', reason: 'the recovery ladder refused' });
  });

  test('a stopped container with no restoration is not something to wait for', () => {
    expect(startupPollVerdict({
      state: {
        running: false,
        restoration: 'unstarted',
        unready: 'no restoration has run for this container yet',
      },
    })).toEqual({ kind: 'stopped', detail: 'no restoration has run for this container yet' });
  });

  test('a RUNNING unstarted generation is still pending: the poll itself re-arms that row', () => {
    expect(startupPollVerdict({ state: { running: true, restoration: 'unstarted' } }))
      .toEqual({ kind: 'pending' });
  });

  test('a reply that does not report the container proves nothing and stays pending', () => {
    expect(startupPollVerdict({ state: { restoration: 'unstarted' } }))
      .toEqual({ kind: 'pending' });
  });

  /**
   * PROBE wakeprobe09010650: a `snapshot-chain` box, alone on its own Worker,
   * answered this reading for 300 s. `pending` describes the driver's
   * knowledge; the box had already filed two incidents, and a ceiling refusal
   * that says only "pending" throws that away.
   */
  test('the reading a refusal reports names the incidents a pending verdict hides', () => {
    expect(describeStartupState({
      state: {
        running: true,
        restoration: 'unstarted',
        unready: 'no restoration has run for this container yet',
        incidents: { total: 2, undelivered: 2 },
      },
    })).toBe(
      'running=true restoration=unstarted, 2 incident(s) recorded (2 undelivered), '
      + 'unready: no restoration has run for this container yet',
    );
  });

  test('a reply with no state at all reports the error rather than an invented reading', () => {
    expect(describeStartupState({ error: 'internal error; reference = cc4po3dqdeu4t8g7a7fg5aps' }))
      .toBe('no state in the reply: internal error; reference = cc4po3dqdeu4t8g7a7fg5aps');
  });
});

/**
 * A fixture that answers the two routes a startup uses and records what it was
 * asked, in order.
 *
 * It answers BYTES, because bytes are what the driver decodes: a reply built as
 * a typed object here would be one the driver's own schema never had to accept.
 * `typeof globalThis.fetch` carries a `preconnect` member beside its call
 * signature, so the stub is COMPLETED with the real one's rather than asserted
 * into shape.
 */

const BENCH_FIXTURE = { origin: 'https://bench.invalid', token: 'bench-token' };


/** The driver-side fields these fakes read out of a posted body. Parsed rather
 *  than trusted, because what the driver sends is the thing under test. */
const PostedBodySchema = v.looseObject({
  op: v.optional(v.string()),
  command: v.optional(v.string()),
});

/**
 * A fixture that implements the ASYNC operation protocol the deployed one now
 * implements, and counts the publications it starts.
 *
 * `publications` is the quantity the blocking protocol got wrong: a checkpoint
 * that outlived the driver's 180 s per-attempt deadline was re-posted, and the
 * fixture then ran a second full publication behind the first — measured on the
 * 20260831031426 and 20260831143544 decisive runs, on both candidate arms. Here
 * a publication starts when an `op` is armed for the FIRST time, so a re-post
 * that resolves to an existing token adds nothing, and a post carrying a fresh
 * `op` adds one. The counter can therefore fail in both directions.
 */

/** Fast bounds: the protocol under test is the cadence's client, not the
 *  cadence. Production values live beside `OPERATION_DEADLINE_MS`. */


/**
 * A fixture that measures a whole arm and then refuses its WAKE.
 *
 * The shape of both 2026-08-31 decisive runs: a cold attach that landed, a
 * checkpoint ladder that committed, and a refusal at the recycle. Every route
 * an arm touches before that point answers here, so what the artifact keeps is
 * decided by the driver rather than by how far the fake got.
 */


/**
 * A fixture whose store tally moves on every stop and every wake, so a window
 * that opens before a stop confirms prices the stop's own operations. The
 * first two wakes attach (the two tree-size rung restores); the third refuses,
 * which ends the arm after its ladder with the rung rows already settled.
 */
function rungRestoreFixture(stopOps: number, wakeOps: number) {
  const asked: string[] = [];
  let wakes = 0;
  let total = 5;
  let boot = 0;
  const real = globalThis.fetch;

  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    asked.push(route);

    if (route === 'POST /wake') {
      wakes += 1;
      boot += 1;
      total += wakeOps;

      return new Response(JSON.stringify({ ok: true, ms: 12 }));
    }

    if (route === 'GET /state') {
      return new Response(JSON.stringify(wakes > 2
        ? { ok: true, state: { running: true, restoration: 'unattached', unready: 'the third wake refuses' } }
        : {
            ok: true,
            storePrefix: 'boxes/probe/',
            state: {
              running: true,
              restoration: 'attached',
              lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
              bootId: `boot-${String(boot)}`,
              chain: { base: { id: 'chain-1' }, delta: { bytes: 4096 }, mode: 'chain', rev: 3 },
            },
          }));
    }

    if (route === 'POST /stop') {
      total += stopOps;

      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }

    if (route === 'POST /checkpoint') {
      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }

    if (route === 'GET /operation') {
      return new Response(JSON.stringify({
        ok: true, state: 'done', ms: 1_234, outcome: { kind: 'committed', bytes: 65_536, movedBytes: 32_768 },
      }));
    }

    if (route === 'POST /exec') {
      const posted = v.safeParse(PostedBodySchema, JSON.parse(String(init?.body ?? '{}')));
      const command = posted.success ? posted.output.command ?? '' : '';
      const marker = /printf %s (devbox-verify-[0-9a-f-]+)/.exec(command)?.[1] ?? '';

      return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout: marker, stderr: '', ms: 3 }));
    }

    if (route === 'GET /ops') {
      return new Response(JSON.stringify({ calls: { put: total }, classA: total, classB: 0, classFree: 0, total }));
    }

    return new Response(JSON.stringify({ ok: true, ms: 1 }));
  };

  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });

  return { asked, restore: () => { globalThis.fetch = real; } };
}

describe('the tree-size restore rows', () => {
  test('price the wake alone, never the stop that preceded it', async () => {
    // RED-FIRST. Run 20260905193714 recorded 67 remote operations for five
    // rung restores of three arms with different call mixes, and 10 puts on a
    // chain restore that puts nothing: the rung opened its /ops window before
    // the stop, so the stop's final checkpoint was priced as the restore. The
    // post-ladder wake opens its window after the stop confirms; the rungs
    // must do the same.
    const fixture = rungRestoreFixture(10, 3);
    let arm: ArmResult;

    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'snapshot-chain',
        { ...parseOptions([]), arms: ['snapshot-chain'], runId: 'rung-window-probe' },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    const restores = decodeComplexityRows(arm.complexity).filter((row) => row.kind === 'restore');
    expect(restores.map((row) => row.treeBytes)).toEqual([65_536, 4_259_840]);
    expect(restores.map((row) => row.wakeOps?.total)).toEqual([3, 3]);
  }, 20_000);
});

/**
 * A verify-only probe arm: one arm's ladder, stop and wake with the evidence
 * reads, then teardown — and nothing else. The fake answers the whole probe
 * path the way `wakeRefusingFixture` answers the failure path, so what the
 * arm does NOT ask for is decided by the driver rather than by how far the
 * fake got. The publish and wake answers differ on purpose: two reads that
 * archived the same bytes would prove nothing about when each was taken.
 */


/** When a stub lane started or finished: the ORDER it happened in, which is
 *  what an overlap claim rests on, and the wall clock it happened at, which is
 *  what a reader of a failure wants to see. */


/**
 * A fake-armed driver: one stub lane per arm, each recording when it started
 * and when it finished.
 *
 * The stubs are the whole point. What is under test is the DRIVER's own
 * scheduling — whether two arms are in flight at once, and whether one arm's
 * throw can reach a sibling — and a real lane would answer that question only
 * by deploying five Workers.
 */

/** A row shaped like a completed arm. Only the fields these tests read carry
 *  anything; the rest is the empty shape `unmeasuredArm` writes. */
function measuredArm(strategy: Strategy): ArmResult {
  return {
    strategy,
    box: `ab-${strategy}-in-flight`,
    verifyPassed: true,
    verifyChecks: [{ name: 'the arm completed every measured step', pass: true, detail: 'stub' }],
    attachColdMs: 1_200,
    attachColdKind: 'attached',
    attachColdBootId: 'boot-1',
    attachWarmMs: 30,
    attachWarmKind: 'attached',
    wakeBootId: 'boot-2',
    attachWarmBootId: 'boot-2',
    checkpoints: [],
    stopMs: 900,
    wakeMs: 1_100,
    wakeKind: 'attached',
    phases: [],
    decisiveTicks: [],
    quiescesBeforeDecisive: 0,
    generationBeforeLadder: null,
    generationAfterLadder: null,
    treeBytes: {},
    ops: { calls: { put: 3 }, classA: 3, classB: 0, classFree: 0, total: 3 },
    teardown: null,
    witnessChecks: [],
    notes: [],
  };
}


/** `/state` answers the same internal error forever; `/exec` never answers at
 *  all, which is what a readiness drive against a wedged box really does. */




/** Facts in which every control's documented defect DID show up.
 *
 *  `deltaLayerCollapse` is the SERVED shape: the delta reaches the merged view
 *  through a lower layer of its own, the fresh upper never holds it, and the
 *  next checkpoint collapses onto a new generation naming no delta.
 *  {@link COPIED_INTO_THE_UPPER} models the behaviour the wake fix removed, so
 *  the witness has to tell the two apart rather than accepting either. */
const WITNESSED: ControlWitnessFacts = {
  deltaLayerCollapse: {
    chainId: 'chain-7',
    deltaBytes: 71_303_168,
    attachDetail: 'chain chain-7 142606336B base+delta layered',
    deltaLayerMounted: true,
    markerInMergedView: true,
    markerInUpper: false,
    collapsedChainId: 'chain-8',
    collapsedNamesDelta: false,
  },
  mutableDelta: {
    key: 'backups/chain-7/delta.sqsh', etagBefore: 'e1', etagAfter: 'e2',
    bytesBefore: 65_536, bytesAfter: 131_072,
  },
};

/**
 * The OLD copy behaviour, as a fake: `cumulative-delta-seed` preregistered
 * exactly this reading, and the wake fix deleted the copy that produced it.
 *
 * A copying attach reads the delta end to end into the fresh upper, so the
 * marker committed into that delta lands in the upper, no layer of its own is
 * ever mounted, and the changed set is whole again — so the next checkpoint
 * appends an ordinary delta inside the SAME generation instead of collapsing.
 * Every one of those four facts is the opposite of {@link WITNESSED}, which is
 * what makes the witness a copy-versus-serve discriminator rather than a
 * statement that something happened.
 */
const COPIED_INTO_THE_UPPER: ControlWitnessFacts = {
  ...WITNESSED,
  deltaLayerCollapse: {
    chainId: 'chain-7',
    deltaBytes: 71_303_168,
    attachDetail: 'chain chain-7 142606336B base+delta seeded into the upper',
    deltaLayerMounted: false,
    markerInMergedView: true,
    markerInUpper: true,
    collapsedChainId: 'chain-7',
    collapsedNamesDelta: true,
  },
};


describe('the preregistered witness cells', () => {



  test('a delta COPIED into the fresh upper is the old behaviour, and refuses as drift', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', COPIED_INTO_THE_UPPER);
    expect(collapse?.name).toBe('delta-layer-collapse');
    expect(collapse?.observed).toBe(false);
    // Both halves of the copy are named, so a reader sees WHICH behaviour ran.
    expect(collapse?.detail).toContain('NOT mounted as a layer');
    expect(collapse?.detail).toContain('the attach copied the delta');
    expect(collapse?.detail).toContain('did NOT collapse');

    // And the SERVED facts observe it, so the two directions are discriminated
    // by this witness rather than by which fields happen to be populated.
    const [, served] = controlWitnessChecks('snapshot-chain', WITNESSED);
    expect(served?.observed).toBe(true);
    expect(served?.detail).toContain('mounted as a lower layer');
    expect(served?.detail).toContain('the delta is served');
    expect(served?.detail).toContain('collapsed onto fresh base chain-8 naming no delta');
  });

  test('a served delta whose next checkpoint appends instead of collapsing is drift', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      deltaLayerCollapse: {
        ...WITNESSED.deltaLayerCollapse!,
        collapsedChainId: 'chain-7',
        collapsedNamesDelta: true,
      },
    });

    expect(collapse?.observed).toBe(false);
    expect(collapse?.detail).toContain('and still names a delta');
  });

  test('a wake with no delta to serve witnesses nothing', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      deltaLayerCollapse: { ...WITNESSED.deltaLayerCollapse!, deltaBytes: 0, deltaLayerMounted: false },
    });

    expect(collapse?.observed).toBe(false);
    expect(collapse?.detail).toContain('delta 0B');
  });

  test('one key holding the same bytes twice is no longer a mutable delta', () => {
    const [mutable] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      mutableDelta: { ...WITNESSED.mutableDelta!, etagAfter: 'e1' },
    });

    expect(mutable?.observed).toBe(false);
    expect(mutable?.detail).toContain('NOT rewritten');
  });








});


/** Ratios of exactly 12x on git and 4x on npm: comfortably over the bar. */


describe('the lifecycle-proof gate at the rule', () => {


  test('the driver has no monolithic verification request', () => {
    const source = readFileSync(new URL('./bench-devbox-strategies.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('/verify?box=');
  });

});

/**
 * Money language, as one pattern the report contract is held to.
 *
 * THE RULING THIS ENFORCES, and the reason it is a fixture rather than a
 * habit: this benchmark incurs no cost and money is not a decision criterion,
 * so a dollar figure in a user-facing artifact is a claim the experiment never
 * measured. The words the strip removed are exactly the ones that can come
 * back by copy-paste — a `usd` total, a `$` cell, a "priced at" sentence — so
 * the pattern names them and the two tests below scan the WHOLE rendered
 * artifact rather than one column.
 *
 * `class A`/`class B` are deliberately NOT in it: they name the KIND of R2 API
 * operation, and the counts stay because the experiment measures them.
 */


describe('the rendered report carries no money', () => {
  /** One complete arm with decisive ticks, so the decisive table renders. */
  const reportArm = (strategy: Strategy): ArmResult => ({
    strategy,
    box: `box-${strategy}`,
    verifyPassed: true,
    verifyChecks: [{ name: 'the wake attached durable bytes', pass: true, detail: 'attached' }],
    attachColdMs: 4_200, attachColdKind: 'attached', attachColdBootId: `cold-${strategy}`,
    attachWarmMs: 90, attachWarmKind: 'attached',
    wakeBootId: `wake-${strategy}`, attachWarmBootId: `wake-${strategy}`,
    checkpoints: [{ changeKiB: 64, kind: 'quiesce', ms: 120, bytes: 65_536, outcome: 'committed' }],
    stopMs: 310, wakeMs: 5_100, wakeKind: 'attached',
    phases: [],
    decisiveTicks: [
      tick(strategy, 'git', 1_200, { classA: 94, classB: 40, bytesPut: 244_143_360 }),
      tick(strategy, 'npm', 400, { classA: 112, classB: 22, bytesPut: 244_143_360 }),
      tick(strategy, 'sqlite', 900, { classA: 494, classB: 28, bytesPut: 1_199_570_944 }),
    ],
    quiescesBeforeDecisive: 3,
    generationBeforeLadder: null, generationAfterLadder: null,
    treeBytes: { sqlite: 162_308_680 },
    ops: { calls: { put: 27 }, classA: 912, classB: 145, classFree: 1, total: 1_058 },
    teardown: null,
    witnessChecks: [{ name: 'mutable-delta', observed: true, detail: 'one key, rewritten in place' }],
    notes: [],
  });

  const reportMeta = {
    date: '2026-09-02',
    run: 'kinu-devbox-bench-20260902',
    worker: 'kinu-devbox-bench-20260902-snapshot-chain',
    bucket: 'kinu-devbox-bench-20260902-snapshot-chain',
    image: SANDBOX_IMAGE,
    seed: '20260824',
    'loop budget ms': '8000',
    'deciding repetitions': '2',
  };



  test('and it still carries the operation classes, bytes moved and latency', () => {
    // The strip removes money, NOT measurement: `class A`/`class B` name the
    // kind of R2 API operation, and those counts plus bytes moved and tick
    // time are what the decision reads.
    const report = render(
      [reportArm('snapshot-chain')],
      reportMeta,
      { admitted: true, gates: [] },
    );

    expect(report).toContain('| class A | class B | MiB moved |');
    expect(report).toContain('Σ tick ms');
    expect(report).toContain('#### R2 operations and teardown');
    expect(report).toContain('| arm | class A | class B | free | total | teardown |');
    // The tallies themselves survive, so nothing was dropped with the column.
    expect(report).toContain('912');
    expect(report).toContain('145');
  });
});

describe('restore and backup time versus tree size', () => {
  const complexityMeta = {
    date: '2026-09-05',
    run: 'kinu-devbox-bench-complexity-probe',
    worker: 'kinu-devbox-bench-complexity-probe-snapshot-chain',
    bucket: 'kinu-devbox-bench-complexity-probe-snapshot-chain',
    image: SANDBOX_IMAGE,
    seed: '20260905',
    'loop budget ms': '8000',
    'deciding repetitions': '2',
  };

  const backupRow = (treeBytes: number): ComplexityRow =>
    ({ treeBytes, kind: 'backup-64k', ms: 120, outcome: 'committed' });

  const restoreRow = (treeBytes: number): ComplexityRow => ({
    treeBytes,
    kind: 'restore',
    ms: 5_100,
    outcome: 'attached',
    attachKind: 'attached',
    wakeOps: { calls: { get: 7 }, bytes: { payload: 90_112 } },
  });

  const measuredRows = (): ComplexityRow[] =>
    COMPLEXITY_TREE_BYTES.flatMap((treeBytes) => [backupRow(treeBytes), restoreRow(treeBytes)]);

  const complexityArm = (strategy: Strategy, complexity?: ComplexityRow[]): ArmResult => {
    const arm = measuredArm(strategy);

    if (complexity !== undefined) arm.complexity = complexity;

    return arm;
  };

  test('measured tree-size rows round-trip through the artifact and render', () => {
    // RED WHEN THE SECTION OMITS A MEASURED ROW: every number the driver took
    // is asserted in the rendered report, so a section that drops a rung fails
    // here rather than publishing a short table. Measured 2026-09-05.
    const root = scratchDir('devbox-complexity-rows');
    const complexity = measuredRows();
    const arm = complexityArm('snapshot-chain', complexity);
    writeArmArtifact(root, 'complexity1', 'snapshot-chain', arm);
    const read = readArmArtifact(root, 'complexity1', 'snapshot-chain');
    expect(read.error).toBeNull();
    expect(read.artifact?.schema).toBe('devbox-arm-artifact/1');
    const rows = decodeComplexityRows(read.artifact?.row.complexity);
    expect(rows).toEqual(complexity);
    const report = render([{ ...arm, complexity: rows }], complexityMeta, { admitted: true, gates: [] });
    expect(report).toContain('#### Restore and backup time versus tree size');
    expect(report).toContain('| `snapshot-chain` | 65,536 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    expect(report).toContain('| `snapshot-chain` | 4,259,840 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    expect(report).toContain('| `snapshot-chain` | 71,368,704 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    // THE SECTION CARRIES THE RUN'S OWN DATE. It carried the literal
    // 2026-09-05, the day the cell was written, so every later run's table
    // would have dated its numbers to a day nobody measured them on.
    const later = render([{ ...arm, complexity: rows }], { ...complexityMeta, date: '2026-09-06' }, { admitted: true, gates: [] });
    const section = later.slice(later.indexOf('#### Restore and backup time versus tree size'));
    expect(section).toContain('Measured 2026-09-06.');
    expect(section).not.toContain('2026-09-05');
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
    // A delete is the free class and still proves the counter is watching, so a
    // delete-only tick is measured rather than blind.
    expect(opsAreBlind([
      tick('a', 'git', 100, { bytesPut: 1024, classFree: 3 }),
    ], 'git')).toBe(false);
  });

  test('no ticks at all is not blindness either', () => {
    expect(opsAreBlind([], 'git')).toBe(false);
  });
});

describe('operation totals', () => {
  test('free operations are counted, and counting them is the whole of it', () => {
    // MONEY IS NOT A DECISION CRITERION HERE, so there is nothing to price:
    // the free class is counted because small-file churn has to stay visible
    // in the operation columns, not because a rate applies to it.
    const totals = totalsFor([tick('a', 'git', 10, { classFree: 500 })], 'git');
    expect(totals.classFree).toBe(500);
    expect(totals.classA).toBe(0);
    expect(totals.classB).toBe(0);
    expect(Object.keys(totals)).not.toContain('usd');
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


  test("a skip's honest zero is answerable and is NOT unanswerable", () => {
    // A skip knows it moved nothing. Folding it in with the cannot-answer case
    // would lose the distinction the strategies deliberately draw.
    const totals = totalsFor([tick('a', 'git', 5, { bytesPut: 0 })], 'git');
    expect(totals.unanswerable).toBe(0);
    expect(totals.movedReported).toBe(true);
    expect(totals.bytesPut).toBe(0);
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
  test('the box\u2019s own re-armable sentences are told apart from its terminal one', () => {
    // Verbatim from `Devbox.ensureReady()`. A driver that guessed at this
    // wording would drift the moment the box reworded itself, which is why the
    // test quotes all three rather than paraphrasing.
    expect(isRearmableStartupRefusal(
      'this devbox is not ready: no restoration has run for this container yet. '
      + 'Nothing has been classified as a failure; a startup is armed, so ask again.',
    )).toBe(true);
    expect(isRearmableStartupRefusal(
      'this devbox has no attached work directory: the store was unreachable. '
      + 'A retry is already under way; operations are refused until it lands.',
    )).toBe(true);
    expect(isRearmableStartupRefusal(
      'this devbox has no attached work directory: the recovery ladder refused. '
      + 'That recovery class is terminal: call attachNow() to attempt the attach again.',
    )).toBe(false);
    expect(isRearmableStartupRefusal(undefined)).toBe(false);
  });
});







describe('cleanup verification observes; only the teardown replay deletes', () => {
  const plane = (world: {
    exists: boolean; objects: string[]; uploads: { key: string; uploadId: string }[];
  }) => {
    const deleted: string[] = [];
    const aborted: string[] = [];

    return {
      residue: {
        bucketExists: async (_bucket: string) => world.exists,
        listObjects: async (_bucket: string) => [...world.objects],
        deleteObject: async (_bucket: string, key: string) => {
          world.objects = world.objects.filter((held) => held !== key);
          deleted.push(key);
        },
        listUploads: async (_bucket: string) => [...world.uploads],
        abortUpload: async (_bucket: string, _key: string, uploadId: string) => {
          world.uploads = world.uploads.filter((held) => held.uploadId !== uploadId);
          aborted.push(uploadId);
        },
      },
      deleted, aborted,
    };
  };

  test('an existing bucket reports its REAL object and multipart counts', async () => {
    const world = plane({
      exists: true, objects: ['a', 'b'], uploads: [{ key: 'c', uploadId: 'u1' }],
    });

    const probes = cleanupObservationProbes({
      wrangler: () => { throw new Error('the S3 plane answers; wrangler must not be asked'); },
      residue: world.residue,
    });

    expect(await probes.bucketState('bench')).toEqual({ absent: false, objects: 2, multipartResidue: 1 });
    // OBSERVED, not remediated: the verifier deleted and aborted nothing.
    expect(world.deleted).toEqual([]);
    expect(world.aborted).toEqual([]);
  });

  test('a gone bucket certifies both counts, because delete refuses residue', async () => {
    const probes = cleanupObservationProbes({
      wrangler: () => { throw new Error('unasked'); },
      residue: plane({ exists: false, objects: [], uploads: [] }).residue,
    });

    expect(await probes.bucketState('bench')).toEqual({ absent: true, objects: 0, multipartResidue: 0 });
  });

  test('an unmeasurable multipart count is a FAILURE, never a zero', async () => {
    // The pre-fix shape hardcoded multipartResidue: 0 with no instrument — the
    // exact residue class two aborted runs left behind an empty object list.
    const probes = cleanupObservationProbes({
      wrangler: (args) => (args[0] === 'r2' ? 'name: bench\nobject_count: 0' : 'unexpected'),
      residue: null,
    });

    await expect(probes.bucketState('bench')).rejects.toThrow(/unmeasured count is not zero/);
  });

  test('keyless absence stays provable through bucket info', async () => {
    const probes = cleanupObservationProbes({
      wrangler: () => `${WRANGLER_FAILED}: a bucket with this name does not exist`,
      residue: null,
    });

    expect(await probes.bucketState('bench')).toEqual({ absent: true, objects: 0, multipartResidue: 0 });
  });

  test('worker absence is probed by listing, and an unreadable account throws', async () => {
    const present = cleanupObservationProbes({ wrangler: () => 'Created: yesterday', residue: null });
    expect(await present.workerAbsent('w')).toBe(false);

    const absent = cleanupObservationProbes({
      wrangler: () => `${WRANGLER_FAILED}: workers.api.error.script_not_found [code: 10007]`, residue: null,
    });

    expect(await absent.workerAbsent('w')).toBe(true);

    const broken = cleanupObservationProbes({
      wrangler: () => `${WRANGLER_FAILED}: Authentication error`, residue: null,
    });

    await expect(broken.workerAbsent('w')).rejects.toThrow(/deployments list on w failed/);
  });

  test('the teardown drain removes BOTH residue classes an interrupted run leaves', async () => {
    const world = plane({
      exists: true,
      objects: ['boxes/one', 'boxes/two'],
      uploads: [{ key: 'boxes/three', uploadId: 'u9' }],
    });

    expect(await drainBucketResidue(world.residue, 'bench')).toEqual({ objects: 2, uploads: 1 });
    expect(await world.residue.listObjects('bench')).toEqual([]);
    expect(await world.residue.listUploads('bench')).toEqual([]);
  });

  test('no verifier probe carries a destructive command', async () => {
    // Driven, not read: both observation probes run against a world that
    // records every mutation, and every wrangler command they issue is shown.
    const world = plane({ exists: true, objects: ['a'], uploads: [{ key: 'b', uploadId: 'u1' }] });
    const commands: string[] = [];

    const probes = cleanupObservationProbes({
      wrangler: (args) => {
        commands.push(args.join(' '));

        return `${WRANGLER_FAILED}: a bucket with this name does not exist`;
      },
      residue: world.residue,
    });

    // The probes really observed: an assertion over no calls proves nothing.
    expect(await probes.bucketState('bench')).toEqual({ absent: false, objects: 1, multipartResidue: 1 });
    expect(await probes.workerAbsent('w')).toBe(true);
    expect(world.deleted).toEqual([]);
    expect(world.aborted).toEqual([]);

    for (const command of commands) expect(command).not.toMatch(/delete|remove|--force/);
    // And the replay arm drains residue before retrying its delete. That order
    // lives in the recovery path whose wrangler calls are real subprocesses,
    // so no fake can drive it and only the source shows it.
    const source = readFileSync(join(import.meta.dirname, 'bench-devbox-strategies.ts'), 'utf8');
    expect(source).toContain('drainBucketResidue(residue, entry.name)');
  });
});

// ── what the store must hold for the generation the record names ────────────

describe('the chain arm asks the store for what its record names', () => {
  const CHAIN = 'c0ffee00-0000-4000-8000-00000000beef';

  test('a record naming a delta wants both archives present', () => {
    expect(chainArchiveExpectations(CHAIN, true)).toEqual([
      {
        name: 'the base object the record names exists in the store with non-zero size',
        key: `backups/${CHAIN}/data.sqsh`,
        present: true,
      },
      {
        name: 'the delta object the record names exists in the store with non-zero size',
        key: `backups/${CHAIN}/delta.sqsh`,
        present: true,
      },
    ]);
  });

  test('RED PROOF: a REBASED record wants its base and NO delta', () => {
    // The shape the instrument used to refuse. A quiesce whose delta has
    // outgrown its base collapses the chain onto a fresh generation, which has
    // a `data.sqsh` and no `delta.sqsh` — the last commit of run
    // 20260831184750, whose 71,389,184 bytes are a bare base. Asking for a
    // delta there failed the arm's verify for holding exactly the shape its
    // strategy documents, and G1 refused the run for it.
    const expectations = chainArchiveExpectations(CHAIN, false);
    expect(expectations.map((row) => [row.key, row.present])).toEqual([
      [`backups/${CHAIN}/data.sqsh`, true],
      [`backups/${CHAIN}/delta.sqsh`, false],
    ]);
  });

  test('the absence is a real expectation: an unnamed delta object is a finding', () => {
    // The other direction, so the correction is not simply "ask for less". An
    // archive under a generation whose record names none is a publication that
    // lost its record or a sweep that never ran.
    const absent = chainArchiveExpectations(CHAIN, false)
      .find((row) => row.key.endsWith('delta.sqsh'));

    expect(absent?.present).toBe(false);
    expect(absent?.name).toContain('no delta');
  });

  test('a record with no generation asks nothing, so a caller must say so itself', () => {
    expect(chainArchiveExpectations(undefined, true)).toEqual([]);
    expect(chainArchiveExpectations('', false)).toEqual([]);
  });

  test('the arm checks every expectation the record produced, in both directions', () => {
    // The wiring, guarded at the source: a branch that only ever called `head`
    // could not express an absence, which is how the one-directional check
    // survived. Both the loop and the absence arm have to be there.
    const source = readFileSync(join(import.meta.dirname, 'bench-devbox-strategies.ts'), 'utf8');
    expect(source).toContain('for (const expectation of expectations) await archive(expectation);');
    expect(source).toContain('found.exists !== true,');

    // And the chain branch no longer asks for a delta whatever the record says:
    // the only surviving unconditional delta head is the EXTRACTION branch's,
    // which is about a record that cannot have collapsed onto a fresh base.
    const chainBranch = source.slice(
      source.indexOf("if (mode === 'chain') {"),
      source.indexOf('  } else {\n    // The chain in EXTRACTION mode'),
    );

    expect(chainBranch.length).toBeGreaterThan(200);
    // Comments stripped: the prose in that branch explains the defect by name,
    // and a guard that could be tripped by its own explanation guards nothing.
    const code = chainBranch.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('delta.sqsh');
  });
});

// ── the teardown manifest exists before the resources do ────────────────────



describe('an abandoned run is deleted from its names alone', () => {

  test('a box name no strategy produces refuses rather than guessing an owner', async () => {
    const exec = orphanTeardownExecutor(null);

    expect(await exec({
      kind: 'mount', name: 'not-a-bench-box', detail: '', done: false, attempts: 0, lastError: null,
    })).toEqual({ ok: false, error: 'no Worker name derives from box not-a-bench-box' });
  });

  test('the generated config directory is removed by path', async () => {
    const directory = scratchDir('devbox-orphan-local-path');
    mkdirSync(join(directory, 'nested'), { recursive: true });
    writeFileSync(join(directory, 'nested', 'wrangler.jsonc'), '{}');

    const outcome = await orphanTeardownExecutor(null)({
      kind: 'local-path', name: directory, detail: '', done: false, attempts: 0, lastError: null,
    });

    expect(outcome).toEqual({ ok: true });
    expect(existsSync(directory)).toBe(false);
  });
});

// ── the paths the lifecycle proof checks ────────────────────────────────────
//
// THE DEPLOYED DEFECT this pins. One arm of run 20260903140046
// failed its lifecycle proof on `the tree lower is present and mounted at its
// lower path: /var/tmp/devbox/cas-lower -> no` — while the same proof's other
// rows showed the folded tree holding the committed marker and the cursor
// advanced. The mount graph was healthy; the CHECK was three commits stale.
// `cas-lower` was the lower's path until the arm moved it inside the store
// mount (one mount, so a fold and the lower are one object), and the driver
// kept asking about a path the strategy no longer creates — and demanding it
// be its own mount line, which the new layout deliberately does not have.
//
// A hardcoded container path in the driver is the defect class: the strategy
// owns those paths and exports them. This asserts the driver reads them from
// the strategy rather than restating them.


// ── every admission check admits what the product can answer ────────────────
//
// THE FAMILY THIS PINS. Three instrument defects reached deployed runs in one
// day, all the same shape — a check narrower than the thing it measures:
//   1. the lifecycle proof asking for a layer path the strategy had moved,
//   2. a fence reader demanding a manifest version the daemon no longer writes,
//   3. a startup step admitting only `attached` where the box legitimately
//      answered `already-attached`, which ended an arm after it had completed
//      its cold attach, its ladder, its stop and its wake.
//
// The third cost a full arm of a decisive run, so the rule is asserted rather
// than remembered: a step may narrow what it admits ONLY with a stated reason,
// and the set it narrows from is the product's own.


describe('the counted restore (G5)', () => {




  test('a wake that never attached counts nothing', () => {
    const counted = countedRestoreWork({
      wakeKind: 'empty', wakeDetail: '', wakeOps: null, wakeMountLines: [],
    });

    expect(counted.work).toBeNull();
    expect(counted.missing).toHaveLength(1);
    expect(counted.missing[0]).toContain('the restore never ran');
  });

  test('a reset racing the window refuses the bill instead of pricing it', () => {
    expect(diffOpTallies({ calls: { get: 4 } }, { calls: { get: 2 } })).toBeNull();
    expect(diffOpTallies(null, { calls: {} })).toBeNull();
    expect(diffOpTallies({ calls: { get: 1 } }, { calls: { get: 1, list: 1 } }))
      .toEqual({ calls: { list: 1 }, total: 1 });
    // The byte tally rides the bracket when both sides carry one, and stays
    // absent when either side predates it.
    expect(diffOpTallies(
      { calls: { get: 1 }, bytes: { payload: 100 } },
      { calls: { get: 3 }, bytes: { payload: 4196, metadata: 512 } },
    )).toEqual({ calls: { get: 2 }, total: 2, bytes: { payload: 4096, metadata: 512 } });
    expect(diffOpTallies({ calls: { get: 1 } }, { calls: { get: 2 }, bytes: { payload: 9 } })).toEqual({ calls: { get: 1 }, total: 1 });
    expect(diffOpTallies({ calls: { get: 1 }, bytes: { payload: 9 } }, { calls: { get: 2 }, bytes: { payload: 3 } })).toBeNull();
  });

  test('a chain wake counts from the byte tally, the mount lines and the served tree', () => {
    const lines = [
      's3fs /backups fuse.s3fs rw 0 0',
      'overlay /workspace overlay rw 0 0',
      'squashfuse /var/tmp/devbox/lower-base fuse.squashfuse ro 0 0',
      'squashfuse /var/tmp/devbox/lower-delta/abc123 fuse.squashfuse ro 0 0',
    ];

    const counted = countedRestoreWork({
      wakeKind: 'attached',
      wakeDetail: 'chain abc 4096B base+delta layered',
      wakeOps: { calls: { head: 2, get: 4, list: 1 }, total: 7, bytes: { payload: 65536 } },
      wakeMountLines: lines,
      wakeServedEntries: 12,
    });

    expect(counted.work).toEqual({
      serialRemoteOps: 7, totalRemoteOps: 7, metadataBytes: 0, payloadBytes: 65536, cpuSteps: 12, mounts: 4, replayUnits: 1,
    });

    // Without the byte tally or the served count the row refuses, field by field.
    const uncounted = countedRestoreWork({
      wakeKind: 'attached', wakeDetail: 'chain abc 4096B base',
      wakeOps: { calls: { get: 2 }, total: 2 }, wakeMountLines: lines.slice(0, 3), wakeServedEntries: null,
    });

    expect(uncounted.work).toBeNull();
    expect(uncounted.missing.map((reason) => reason.split(':')[0]).sort()).toEqual(['cpuSteps', 'metadataBytes/payloadBytes']);
  });


  test('promotion needs all seven fields, never six', () => {
    const full = {
      serialRemoteOps: 2, totalRemoteOps: 2, metadataBytes: 128, payloadBytes: 0,
      cpuSteps: 0, mounts: 2, replayUnits: 0,
    };

    expect(restoreWorkFromCounts(full)).toEqual(full);
    expect(restoreWorkFromCounts({ ...full, cpuSteps: null })).toBeNull();
    expect(restoreWorkFromCounts({
      serialRemoteOps: null, totalRemoteOps: null, metadataBytes: null, payloadBytes: null,
      cpuSteps: null, mounts: null, replayUnits: null,
    })).toBeNull();
  });

  test('the chain two-deep serve verifies, and a third layer is caught', () => {
    const row = (mounts: number) => ({
      serialRemoteOps: 3, totalRemoteOps: 3, metadataBytes: 64, payloadBytes: 0,
      cpuSteps: 0, mounts, replayUnits: 0,
    });

    const lines = [
      's3fs /backups fuse.s3fs rw 0 0',
      'overlay /workspace overlay rw 0 0',
      'squashfuse /var/tmp/devbox/lower-base fuse.squashfuse ro 0 0',
      'squashfuse /var/tmp/devbox/lower-delta/abc123 fuse.squashfuse ro 0 0',
    ];

    expect(verifyRestoreBound(row(4), lines).verified).toBe(true);

    const tooMany = verifyRestoreBound(
      row(5), [...lines, 'squashfuse /var/tmp/devbox/lower-delta/def456 fuse.squashfuse ro 0 0'],
    );

    expect(tooMany.verified).toBe(false);
    expect(tooMany.reason).toContain('past the at-most-two-deep serve');
  });





});



describe('the instruments restate nothing unchecked', () => {
  const driver = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
  const repo = (...parts: string[]): string => readFileSync(join(import.meta.dir, '..', ...parts), 'utf8');



  test('the chain served words are the product ternary’s', () => {
    const chain = repo('packages', 'devbox', 'src', 'snapshot-chain.ts');
    const product = /\? '([^']+)'\s*:\s*held \? '([^']+)' : '([^']+)'/.exec(chain);
    expect(product?.slice(1)).toEqual(['base', 'base+delta already in this upper', 'base+delta layered']);
    const restated = /CHAIN_SERVED_WORDS = \[([^\]]+)\]/.exec(driver)?.[1] ?? '';
    const words = [...restated.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    expect(words).toEqual([...(product?.slice(1) ?? [])].sort());
  });

  test('legacy checkpoints have no third kind to hide a barrier in', () => {
    const storage = repo('packages', 'devbox', 'src', 'storage.ts');
    const kinds = /type CheckpointKind = ((?:'[^']+'(?: \| )?)+)/.exec(storage)?.[1] ?? '';
    expect([...kinds.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()).toEqual(['quiesce', 'tick']);
  });

  test('the chain store mount is the product’s', () => {
    const chain = repo('packages', 'devbox', 'src', 'snapshot-chain.ts');
    const product = /CHAIN_STORE_MOUNT = '([^']+)'/.exec(chain)?.[1];
    const restated = /CHAIN_STORE_MOUNT_DIR = '([^']+)'/.exec(driver)?.[1];
    expect(product).toBeDefined();
    expect(restated).toBe(product);
  });




  test('the incident rows restate the ledger row, key for key', () => {
    const devbox = repo('packages', 'devbox', 'src', 'devbox.ts');
    const product = /export interface IncidentReasonRow \{([\s\S]*?)\}/.exec(devbox)?.[1] ?? '';
    const productKeys = [...product.matchAll(/readonly (\w+)/g)].map((match) => match[1]).sort();
    expect(productKeys).toEqual(['at', 'attempts', 'delivered', 'reason', 'stage']);
    const restated = /export interface IncidentReasonRow \{([\s\S]*?)\}/.exec(driver)?.[1] ?? '';
    const restatedKeys = [...restated.matchAll(/(\w+)\?:/g)].map((match) => match[1]).sort();
    expect(restatedKeys).toEqual(productKeys);
  });


  test('the probe scope gates the post-wake tail on verify-only', () => {
    const arm = /async function measureArm[\s\S]*?\n\}\n/.exec(driver)?.[0] ?? '';
    expect(arm).toContain('await runWorkloadPhases(fixture, box, strategy, options, result, notes);');
    expect(arm).toContain('if (options.verifyOnly) {');
    expect(arm).toContain('await releaseArm(fixture, box, result, notes);');
  });

});
