/** Tests the storage-strategy decision rule against hand-built rows, without a deployment.
 *  It must refuse: never a winner for every input, never an unmeasured arm as the best one. */

import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  opsAreBlind, sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';

import * as v from 'valibot';
import { WRANGLER_FAILED } from './fixtures/r2-bench/deploy-substrate';
import { present, scratchDir } from '@kinu.run/test-utils';
import { readFileEvidence, writeC3File, C3_WORKLOAD } from '../packages/devbox/bench/witness-files';
import { publicationTotals, type PublicationWindow } from '../packages/devbox/bench/publication-meter';
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
  readBoxFile,
  readOnlyLayerProbeCommand,
  barrierAckLoss,
  type BarrierAcknowledgement,
  type FileObservation,
  runArm,
  runDecisive,
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
  judgeChainCut,
  type ChainCutFacts,
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
  // Test by key presence, not `??`: an explicit `null` must stay null, not collapse to zero.
  bytesPut: 'bytesPut' in extra ? extra.bytesPut ?? null : 0,
  heldBytes: extra.heldBytes ?? null,
  movedReported: extra.movedReported ?? true,
  unitsMoved: extra.unitsMoved ?? null,
  unitLabel: extra.unitLabel ?? 'delta bytes',
  outcome: extra.outcome ?? 'committed',
});

describe('startup polling contract', () => {
  const unconfirmedAttachRecords = [
    { name: 'waits for this restoration, not a stale durable attach record', restoration: 'unstarted', detail: 'the previous generation' },
    { name: 'an attach record without a running observation remains pending', restoration: 'attached', detail: 'an unconfirmed generation' },
  ] as const;

  for (const record of unconfirmedAttachRecords) {
    test(record.name, () => {
      expect(startupPollVerdict({
        state: {
          restoration: record.restoration,
          lastAttach: { kind: 'attached', detail: record.detail },
        },
      })).toEqual({ kind: 'pending' });
    });
  }

  test('returns only after restoration publishes its durable attach outcome', () => {
    expect(startupPollVerdict({
      state: {
        running: true,
        restoration: 'attached',
        lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
      },
    })).toEqual({
      kind: 'attached',
      attach: { kind: 'attached', detail: 'the work directory is mounted' },
    });
  });

  test('a stopped container cannot reuse an attached or repair record', () => {
    for (const restoration of ['attached', 'repair'] as const) {
      expect(startupPollVerdict({
        state: {
          running: false,
          restoration,
          lastAttach: { kind: 'attached', detail: 'the stopped generation' },
          unready: 'the container stopped',
        },
      })).toEqual({ kind: 'stopped', detail: 'the container stopped' });
    }
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

  /** `pending` describes only the driver's knowledge; a ceiling refusal must report the
   *  box's own reading, since the box may already have filed incidents. */
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

/** The fixture replies with bytes so the driver's own schema must decode them.
 *  The fetch stub copies the real `preconnect` member instead of asserting into shape. */

const BENCH_FIXTURE = { origin: 'https://bench.invalid', token: 'bench-token' };

async function withFastClock<Result>(run: () => Promise<Result>): Promise<Result> {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof real>) => {
    const [handler, , ...rest] = args;

    return real(handler, 0, ...rest);
  }, real);

  try {
    return await run();
  } finally {
    globalThis.setTimeout = real;
  }
}

const OLD_CUT: ChainCutFacts = {
  recordPresent: true,
  preDeltaId: 'delta-before', postDeltaId: 'delta-before',
  preBaseId: 'base-before', preHasDelta: true, preRev: 7, preDeltaEtag: 'etag-before',
  postBaseId: 'base-before', postHasDelta: true, postRev: 7, postDeltaEtag: 'etag-before',
  servedWord: 'base+delta block-composed',
  cutMarkerPresent: false, baseExists: true, deltaExists: true,
};

describe('cut observation completeness', () => {
  test.each([0, 1])('the read-only probe preserves status %s without ending the persistent session', (status) => {
    const shell = spawnSync('sh', ['-c', `
touch() { if [ ${status} -ne 0 ]; then printf '%s\\n' 'touch: Read-only file system' >&2; fi; return ${status}; }
rm() { return 0; }
${readOnlyLayerProbeCommand('/var/tmp/devbox/lower-base')}
probe_status=$?
printf '\\nprobe_status=%s session=alive\\n' "$probe_status"
`], { encoding: 'utf8' });

    expect(shell.status).toBe(0);
    expect(shell.stdout.includes('Read-only file system')).toBe(status !== 0);
    expect(shell.stdout).toContain(`probe_status=${status} session=alive`);
  });

  test('immutable cuts refuse changed bytes or delta identities under an unchanged record revision', () => {
    expect(judgeChainCut({ ...OLD_CUT, postDeltaEtag: 'rewritten', cutMarkerPresent: true }).verdict).toBe('mixed');
    expect(judgeChainCut({ ...OLD_CUT, postDeltaId: 'delta-after', cutMarkerPresent: true }).verdict).toBe('mixed');
    expect(judgeChainCut({ ...OLD_CUT, postDeltaId: null }).verdict).toBe('unjudged');
    expect(judgeChainCut({ ...OLD_CUT, postRev: 8, postDeltaId: 'delta-after', postDeltaEtag: 'etag-after', cutMarkerPresent: true }).verdict).toBe('all-new');
  });

  test('publication accounting includes every fully observed PUT attempt and refuses unknown bodies', () => {
    const window: PublicationWindow = {
      schema: 'devbox-publication-window/1', token: 'window', prefix: 'boxes/test/', openedAt: 1, closedAt: 10,
      attempts: [
        { id: 'first', key: 'boxes/test/delta.sqsh', operation: 'put', uploadId: null, startedAt: 2, finishedAt: 3, bytes: 65_536, observedBytes: 65_536, outcome: 'threw', error: 'lost acknowledgement', bodyError: null },
        { id: 'retry', key: 'boxes/test/delta.sqsh', operation: 'put', uploadId: null, startedAt: 4, finishedAt: 5, bytes: 65_536, observedBytes: 65_536, outcome: 'returned', error: null, bodyError: null },
      ],
    };

    expect(publicationTotals(window)).toEqual({ objectsPut: 2, bytesPut: 131_072, errors: [] });
    expect(publicationTotals(null).bytesPut).toBeNull();
    expect(publicationTotals({ ...window, attempts: [{ ...window.attempts[0], bytes: null, bodyError: 'stream unobserved' }] }).bytesPut).toBeNull();
    expect(publicationTotals({ ...window, closedAt: null }).objectsPut).toBeNull();
  });

  test('the live C3 file producer matches the existing seeded overwrite exactly', async () => {
    expect(C3_WORKLOAD).toEqual({ path: 'vol/dense.bin', baselineBytes: 67_108_864, overwriteBytes: 65_536, offset: 8_388_608, baselineSeed: 61, overwriteSeed: 62 });
    const root = scratchDir('devbox-c3-files');
    await writeC3File(root, 'baseline');
    expect(await readFileEvidence(join(root, 'vol/dense.bin'))).toEqual({
      kind: 'file', size: 67_108_864, sha256: '936bd9856c5ba7b6d1a40f11b8be8ff3d296ce952447a6cf8c9973197adf1a2c',
    });
    await writeC3File(root, 'overwrite');
    expect(await readFileEvidence(join(root, 'vol/dense.bin'))).toEqual({
      kind: 'file', size: 67_108_864, sha256: '6adec5191fbd1aab70959259fdd85c2ea8195168a90dd2c98341360640aaaecb',
    });
  });

  test('a fully observed decisive checkpoint keeps its raw window and measured classes', async () => {
    const real = globalThis.fetch;
    let puts = 0;

    const answer = async (input: Parameters<typeof real>[0], init?: Parameters<typeof real>[1]) => {
      const path = new URL(v.parse(v.string(), input)).pathname;

      if (path === '/checkpoint') {
        puts++;

        return Response.json({ ok: true, token: `cp-${puts}`, state: 'pending' });
      }

      if (path === '/operation') return Response.json({ ok: true, state: 'done', ms: 3, outcome: { kind: 'committed', movedBytes: 16 } });

      if (path === '/ops') return Response.json({ calls: { put: puts }, total: puts, classA: puts, classB: 0, classFree: 0 });

      if (path === '/incidents') return Response.json({ ok: true, incidents: [] });

      if (path === '/state') return Response.json({ ok: true, state: { running: true, restoration: 'attached', bootId: 'stable' } });

      if (path === '/exec') {
        const body = v.parse(v.looseObject({ command: v.string() }), JSON.parse(v.parse(v.string(), init?.body ?? '{}')));
        const segment = /--segment (\d+)/.exec(body.command)?.[1] ?? 'unknown';

        return Response.json({ ok: true, exitCode: 0, stdout: JSON.stringify({
          workload: 'npm', segments: [{ name: `part-${segment}`, bytesWritten: 16, pathsTouched: 1, wallMs: 1 }],
        }) });
      }

      return Response.json({ ok: true });
    };

    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });

    try {
      const run = await withFastClock(async () => await runDecisive({
        fixture: BENCH_FIXTURE,
        box: 'box',
        arm: 'snapshot-chain',
        spec: { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
        seed: 1,
        repetition: 1,
      }));

      expect(run.ticks).toHaveLength(5);
      expect(run.ticks.every((row) => row.classA === 1 && row.classB === 0 && row.classFree === 0)).toBe(true);
      expect(run.segments[0]?.accounting.before?.calls).toEqual({ put: 0 });
      expect(run.segments[0]?.accounting.after?.calls).toEqual({ put: 1 });
    } finally {
      globalThis.fetch = real;
    }
  });

  test('unobserved decisive segments survive instead of disappearing from the run', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ ok: false, error: 'startup pending' }), { preconnect: real.preconnect });

    try {
      const run = await runDecisive({
        fixture: BENCH_FIXTURE,
        box: 'box',
        arm: 'snapshot-chain',
        spec: { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
        seed: 1,
        repetition: 1,
      });

      expect(run.ticks).toHaveLength(0);
      expect(run.segments).toHaveLength(5);
      expect(run.segments.every((row) => !row.priced && row.command?.error === 'startup pending')).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('barrier loss requires a committed acknowledgement and every read', () => {
    const digest = 'a'.repeat(64);

    const acknowledgement: BarrierAcknowledgement = {
      checkpoint: { ok: true, outcome: { kind: 'committed' } },
      witnesses: [{ path: '/workspace/ack.txt', expectedDigest: digest, expectedSize: 5 }],
    };

    const retained: FileObservation = {
      path: '/workspace/ack.txt', reply: { ok: true, exitCode: 0 }, error: null,
      evidence: { kind: 'file', size: 5, sha256: digest },
    };

    expect(barrierAckLoss(acknowledgement, [retained])).toBe(0);
    expect(barrierAckLoss(acknowledgement, [{ ...retained, evidence: { kind: 'missing' } }])).toBe(1);
    expect(barrierAckLoss(acknowledgement, [{
      ...retained, evidence: { kind: 'file', size: 5, sha256: 'b'.repeat(64) },
    }])).toBe(1);
    expect(barrierAckLoss(acknowledgement, [{ ...retained, evidence: null, error: 'pending' }])).toBeNull();
    expect(barrierAckLoss(acknowledgement, [])).toBeNull();
    expect(barrierAckLoss(null, [retained])).toBeNull();
    expect(barrierAckLoss({ ...acknowledgement, witnesses: [] }, [])).toBeNull();
    expect(barrierAckLoss({
      ...acknowledgement, checkpoint: { ok: true, outcome: { kind: 'failed' } },
    }, [retained])).toBeNull();
  });

  test('a refused observer is unobserved even when its body resembles absence', async () => {
    const real = globalThis.fetch;
    const reply = { ok: false, error: 'startup pending', stdout: '{"kind":"missing"}' };
    globalThis.fetch = Object.assign(async () => Response.json(reply), { preconnect: real.preconnect });

    try {
      const observed = await readBoxFile(BENCH_FIXTURE, 'box', '/workspace/witness.txt');
      expect(observed.evidence).toBeNull();
      expect(observed.reply).toEqual(reply);
      expect(observed.error).toContain('startup pending');
    } finally {
      globalThis.fetch = real;
    }
  });

  test('file evidence distinguishes bytes, absence and failed reads', async () => {
    const directory = scratchDir('devbox-file-evidence');
    const path = join(directory, 'witness.txt');
    writeFileSync(path, 'hello');
    expect(await readFileEvidence(path)).toEqual({
      kind: 'file', size: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(await readFileEvidence(join(directory, 'absent'))).toEqual({ kind: 'missing' });
    await expect(readFileEvidence(directory)).rejects.toThrow();
  });

  test('an unobserved marker cannot establish all-old state', () => {
    expect(judgeChainCut({ ...OLD_CUT, cutMarkerPresent: null }).verdict).toBe('unjudged');
    expect(judgeChainCut(OLD_CUT).verdict).toBe('all-old');
  });

  test('unknown archive or record evidence cannot establish a cut verdict', () => {
    const omissions: Partial<ChainCutFacts>[] = [
      { baseExists: null }, { deltaExists: null },
      { preDeltaEtag: null }, { postDeltaEtag: null },
      { preRev: null }, { postRev: null },
    ];

    for (const omission of omissions) {
      expect(judgeChainCut({ ...OLD_CUT, ...omission }).verdict).toBe('unjudged');
    }

    expect(judgeChainCut({
      ...OLD_CUT, postBaseId: 'base-after', postHasDelta: false, postRev: 8,
      postDeltaEtag: null, deltaExists: null, servedWord: 'base', cutMarkerPresent: true,
    }).verdict).toBe('all-new');
  });
});

/** The driver-side fields these fakes read out of a posted body. Parsed rather
 *  than trusted, because what the driver sends is the thing under test. */
const PostedBodySchema = v.looseObject({
  op: v.optional(v.string()),
  command: v.optional(v.string()),
});

/** Fixture for the async operation protocol; a publication starts only when an `op` is
 *  first armed, so a re-post resolving to an existing token adds none and the count fails both ways. */

/** Fast bounds: the protocol under test is the cadence's client, not the
 *  cadence. Production values live beside `OPERATION_DEADLINE_MS`. */

/** A fixture that measures a whole arm and then refuses its WAKE. Every earlier route answers,
 *  so what the artifact keeps is decided by the driver, not by how far the fake got. */

/** Store tally moves on every stop and wake, so a window opened before a stop confirms prices
 *  its operations. Wakes one and two attach (rung restores); the third refuses, ending the arm. */
function rungRestoreFixture(stopOps: number, wakeOps: number, workloadChurn = false) {
  const asked: string[] = [];
  let wakes = 0;
  let total = 5;
  let boot = 0;
  const real = globalThis.fetch;

  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(v.parse(v.string(), input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    asked.push(route);

    if (route === 'POST /wake') {
      wakes += 1;
      boot += 1;
      total += wakeOps;

      return new Response(JSON.stringify({ ok: true, ms: 12 }));
    }

    if (route === 'GET /state') {
      return new Response(JSON.stringify(!workloadChurn && wakes > 2
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
      const posted = v.safeParse(PostedBodySchema, JSON.parse(v.parse(v.string(), init?.body ?? '{}')));
      const command = posted.success ? posted.output.command ?? '' : '';
      const marker = /printf %s (devbox-verify-[0-9a-f-]+)/.exec(command)?.[1] ?? '';
      let stdout = marker;

      if (workloadChurn && command.includes('probe.ts')) boot = 99;

      if (workloadChurn && command.includes('echo DONE')) stdout = 'DONE';
      else if (workloadChurn && (command.includes('probe.ts') || command.includes('out-'))) {
        stdout = JSON.stringify({ schema: 'probe/1', root: '/workspace', seed: 1, loopBudgetMs: 1, phases: [] });
      }

      return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout, stderr: '', ms: 3 }));
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
  test('the warm observation belongs to its wake before later workload churn', async () => {
    const fixture = rungRestoreFixture(10, 3, true);
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = Object.assign((...args: Parameters<typeof realTimeout>) => {
      const [handler, , ...rest] = args;

      return realTimeout(handler, 0, ...rest);
    }, realTimeout);
    let arm: ArmResult;

    try {
      arm = await runArm(BENCH_FIXTURE, 'snapshot-chain', {
        ...parseOptions([]), arms: ['snapshot-chain'], runId: 'warm-window-probe',
      }, () => {});
    } finally {
      globalThis.setTimeout = realTimeout;
      fixture.restore();
    }

    expect(arm.wakeBootId).toBe('boot-3');
    expect(arm.attachWarmBootId).toBe('boot-3');
    expect(arm.workloadStates?.some((row) => row.state?.state?.bootId === 'boot-99')).toBe(true);
    expect(arm.startups?.find((row) => row.operation === 'warm attach')?.observations
      .some((row) => row.event === 'state' && row.finishedAt !== null && row.reply !== null)).toBe(true);
  });

  test('price the wake alone, never the stop that preceded it', async () => {
    // A rung opens its /ops window only after the stop confirms, so the stop's final
    // checkpoint is never priced as the restore.
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
  });
});

/** The fake answers the whole probe path, so what the arm skips is the driver's choice.
 *  Publish and wake answers differ: identical archived bytes cannot show when each was read. */

/** A stub lane's start or finish: overlap claims rest on the recorded ORDER;
 *  the wall clock is only for a reader of a failure. */

/** Stub lanes test the driver's own scheduling (arms in flight at once, throw isolation);
 *  a real lane could answer that only by deploying five Workers. */

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

/** Facts in which each control's defect shows up; `deltaLayerCollapse` is the served shape:
 *  delta in its own lower layer, never in the upper, next checkpoint collapses naming no delta. */
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
    key: 'backups/delta-2/delta.sqsh', previousKey: 'backups/delta-1/delta.sqsh', etagBefore: 'e1', etagAfter: 'e2',
    bytesBefore: 65_536, bytesAfter: 131_072,
    retainedHead: { ok: true, exists: true, etag: 'e1', size: 65_536 },
    beforeState: { state: { chain: { base: { id: 'chain-7' }, delta: { id: 'delta-1' }, rev: 2 } } },
    afterState: { state: { chain: { base: { id: 'chain-7' }, delta: { id: 'delta-2' }, rev: 3 } } },
    checkpoint: { ok: true, outcome: { kind: 'committed' } },
  },
};

/** A copying attach seeds the delta into the upper: marker in upper, no delta layer mounted,
 *  same-generation append; each fact is opposite to `WITNESSED`, so the witness discriminates. */
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
  test('chunked restore serves the marker from its composed lower with zero attach payload', () => {
    const digest = 'a'.repeat(64);

    const marker: FileObservation = {
      path: '/workspace/witness.txt', reply: { ok: true, exitCode: 0 }, error: null,
      evidence: { kind: 'file', size: 7, sha256: digest },
    };

    const facts: ControlWitnessFacts = {
      ...WITNESSED,
      chunkedAbsorption: {
        markerPath: 'witness.txt', markerDigest: digest,
        manifest: { v: 2, files: [{ kind: 'whole', p: 'witness.txt', s: 7 }], dirs: [], deleted: [], treplace: [], links: [] },
        manifestRead: { ok: true, exitCode: 0 }, markerInMerged: marker,
        markerInUpper: { ...marker, path: '/var/tmp/devbox/upper/witness.txt', evidence: { kind: 'missing' } },
        sidecarMounted: true, blockMounted: true, mounts: { ok: true, exitCode: 0 },
        blockReads: { generation: 'chain-before:boot-new', payloadBytes: 0, indexPages: 0, readRequests: 0 },
        before: 'chain-before', after: 'chain-before', afterNamesDelta: true,
        nextCheckpoint: { ok: true, outcome: { kind: 'committed' } },
        wake: { ms: 100, startedAt: 1, redrives: 0, attach: { kind: 'attached', detail: 'chain chain-before 123B base+delta block-composed' },
          state: { state: { bootId: 'boot-new', chain: { deltaFormat: 'chunked' } } } },
        beforeState: { state: { bootId: 'boot-old' } },
      },
    };

    const check = (input: ControlWitnessFacts) => controlWitnessChecks('snapshot-chain', input)
      .find((row) => row.name === 'chunked-absorption');

    expect(check(facts)?.observed).toBe(true);
    const absorption = present(facts.chunkedAbsorption, 'the chunked absorption facts');

    for (const changed of [
      { manifest: null }, { markerInMerged: { ...marker, evidence: null } },
      { markerInUpper: { ...marker, path: '/var/tmp/devbox/upper/witness.txt' } }, { sidecarMounted: false },
      { manifestRead: null }, { mounts: { ok: false, error: 'pending' } },
      { blockMounted: false }, { blockReads: null }, { wake: null },
      { blockReads: { generation: 'chain-before:boot-new', payloadBytes: 16384, indexPages: 0, readRequests: 1 } },
      { blockReads: { generation: 'chain-before:boot-new', payloadBytes: 0, indexPages: 1, readRequests: 1 } },
      { nextCheckpoint: { ok: true, outcome: { kind: 'skipped' } } },
    ]) {
      expect(check({ ...facts, chunkedAbsorption: { ...absorption, ...changed } })?.observed).toBe(false);
    }
  });

  test('a delta COPIED into the fresh upper is the old behaviour, and refuses as drift', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', COPIED_INTO_THE_UPPER, 'layered');
    expect(collapse?.name).toBe('delta-layer-collapse');
    expect(collapse?.observed).toBe(false);
    expect(collapse?.detail).toContain('NOT mounted as a layer');
    expect(collapse?.detail).toContain('the attach copied the delta');
    expect(collapse?.detail).toContain('did NOT collapse');

    // The served facts observe it: this witness, not which fields happen to be populated,
    // discriminates the two directions.
    const [, served] = controlWitnessChecks('snapshot-chain', WITNESSED, 'layered');
    expect(served?.observed).toBe(true);
    expect(served?.detail).toContain('mounted as a lower layer');
    expect(served?.detail).toContain('the delta is served');
    expect(served?.detail).toContain('collapsed onto fresh base chain-8 naming no delta');
  });

  test('a served delta whose next checkpoint appends instead of collapsing is drift', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      deltaLayerCollapse: {
        ...present(WITNESSED.deltaLayerCollapse, 'the delta-layer collapse facts'),
        collapsedChainId: 'chain-7',
        collapsedNamesDelta: true,
      },
    }, 'layered');

    expect(collapse?.observed).toBe(false);
    expect(collapse?.detail).toContain('and still names a delta');
  });

  test('a wake with no delta to serve witnesses nothing', () => {
    const [, collapse] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      deltaLayerCollapse: { ...present(WITNESSED.deltaLayerCollapse, 'the delta-layer collapse facts'), deltaBytes: 0, deltaLayerMounted: false },
    }, 'layered');

    expect(collapse?.observed).toBe(false);
    expect(collapse?.detail).toContain('delta 0B');
  });

  test('immutable publication preserves the mounted key and CAS advances the record to a new key', () => {
    const check = (mutableDelta: NonNullable<ControlWitnessFacts['mutableDelta']>) =>
      controlWitnessChecks('snapshot-chain', { mutableDelta })[0];

    const facts = present(WITNESSED.mutableDelta, 'the mutable delta facts');

    expect(check(facts)?.observed).toBe(true);

    for (const changed of [
      { previousKey: facts.key },
      { retainedHead: { ok: true, exists: true, etag: 'rewritten', size: 65_536 } },
      { retainedHead: { ok: true, exists: false } },
      { retainedHead: { ok: true, exists: true, etag: 'e1', size: 1 } },
      { etagAfter: '' },
      { afterState: facts.beforeState },
      { afterState: { state: { chain: { base: { id: 'chain-7' }, delta: { id: 'delta-2' }, rev: 2 } } } },
      { checkpoint: { ok: true, outcome: { kind: 'skipped' } } },
    ]) expect(check({ ...facts, ...changed })?.observed).toBe(false);
  });

});

/** The benchmark incurs no cost, so a dollar figure in the report is an unmeasured claim.
 *  `class A`/`class B` stay allowed: they name R2 operation kinds the experiment counts. */

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
    // The strip removes cost only: `class A`/`class B` name R2 operation kinds, and those counts,
    // bytes moved and tick time are what the decision reads.
    const report = render({
      arms: [reportArm('snapshot-chain')],
      meta: reportMeta,
      admission: { admitted: true, gates: [] },
    });

    expect(report).toContain('| class A | class B | MiB moved |');
    expect(report).toContain('Σ tick ms');
    expect(report).toContain('#### R2 operations and teardown');
    expect(report).toContain('| arm | class A | class B | free | total | teardown |');
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
    // Every measured number is asserted in the rendered report, so a section that drops a rung
    // fails here rather than publishing a short table.
    const root = scratchDir('devbox-complexity-rows');
    const complexity = measuredRows();
    const arm = complexityArm('snapshot-chain', complexity);
    writeArmArtifact(root, 'complexity1', 'snapshot-chain', arm);
    const read = readArmArtifact(root, 'complexity1', 'snapshot-chain');
    expect(read.error).toBeNull();
    expect(read.artifact?.schema).toBe('devbox-arm-artifact/1');
    const rows = decodeComplexityRows(read.artifact?.row.complexity);
    expect(rows).toEqual(complexity);

    const report = render({
      arms: [{ ...arm, complexity: rows }],
      meta: complexityMeta,
      admission: { admitted: true, gates: [] },
    });

    expect(report).toContain('#### Restore and backup time versus tree size');
    expect(report).toContain('| `snapshot-chain` | 65,536 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    expect(report).toContain('| `snapshot-chain` | 4,259,840 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    expect(report).toContain('| `snapshot-chain` | 71,368,704 | 120 | 5,100 | 7 | 90,112 | committed; attached |');
    // The section dates its numbers from `meta.date`, never a literal: a table must carry
    // the day its run measured it.

    const later = render({
      arms: [{ ...arm, complexity: rows }],
      meta: { ...complexityMeta, date: '2026-09-06' },
      admission: { admitted: true, gates: [] },
    });

    const section = later.slice(later.indexOf('#### Restore and backup time versus tree size'));
    expect(section).toContain('Measured 2026-09-06.');
    expect(section).not.toContain('2026-09-05');
  });

});

describe('detecting a blind op counter', () => {
  test('bytes moved with zero ops is blindness, not a cheap arm', () => {
    // Bytes reach R2 only through a PUT or a multipart part, so non-zero bytes with zero ops
    // of every class cannot describe a real tick.
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
    // Money is not a decision criterion: the free class is counted so small-file churn stays
    // visible in the operation columns, not because a rate applies to it.
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
    // Verbatim from `Devbox.ensureReady()`; quoted exactly so a rewording of the box's
    // refusals breaks this test instead of silently drifting the driver.
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
    // An empty object list does not rule out multipart residue: aborted runs leave uploads behind it.
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
    const deployed = cleanupObservationProbes({ wrangler: () => 'Created: yesterday', residue: null });
    expect(await deployed.workerAbsent('w')).toBe(false);

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
  });
});

describe('the chain arm asks the store for what its record names', () => {
  const CHAIN = 'c0ffee00-0000-4000-8000-00000000beef';

  test('a record naming a delta wants both archives present', () => {
    expect(chainArchiveExpectations(CHAIN, 'delta-uuid', 'boxes/witness/')).toEqual([
      {
        name: 'the base object the record names exists in the store with non-zero size',
        key: `boxes/witness/backups/${CHAIN}/data.sqsh`,
        present: true,
      },
      {
        name: 'the delta object the record names exists in the store with non-zero size',
        key: 'boxes/witness/backups/delta-uuid/delta.sqsh',
        present: true,
      },
    ]);
  });

  test('RED PROOF: a REBASED record wants its base and NO delta', () => {
    // A delta that outgrows its base collapses the chain onto a fresh generation: a
    // `data.sqsh` and no `delta.sqsh`, which is the strategy's documented shape, not a fault.
    const expectations = chainArchiveExpectations(CHAIN, undefined);
    expect(expectations.map((row) => [row.key, row.present])).toEqual([
      [`backups/${CHAIN}/data.sqsh`, true],
      [`backups/${CHAIN}/delta.sqsh`, false],
    ]);
  });

  test('the absence is a real expectation: an unnamed delta object is a finding', () => {
    // A delta archive under a generation whose record names none is a publication that lost
    // its record or a sweep that never ran, so its presence is a finding.
    const absent = chainArchiveExpectations(CHAIN, undefined)
      .find((row) => row.key.endsWith('delta.sqsh'));

    expect(absent?.present).toBe(false);
    expect(absent?.name).toContain('no delta');
  });

  test('a record with no generation asks nothing, so a caller must say so itself', () => {
    expect(chainArchiveExpectations(undefined, 'delta-uuid')).toEqual([]);
    expect(chainArchiveExpectations('', undefined)).toEqual([]);
  });

});

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

// The strategy owns container paths and exports them; the driver must read them from the
// strategy, never restate them, or its lifecycle proof checks paths no longer created.

// An admission step narrows what it admits only with a stated reason, and narrows from
// the product's own answer set, never a narrower restatement of it.

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
