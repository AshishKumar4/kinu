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
import { WRANGLER_FAILED } from './fixtures/r2-bench/deploy-substrate';
import {
  addressArmRequest,
  benchmarkExitCode,
  CANDIDATE_CONTAINER_CLASSES,
  candidateLifecycleChecks,
  cleanupObservationProbes,
  comparablePair,
  devboxAdmission,
  drainBucketResidue,
  fixtureConfigForArms,
  frozenControlStatus,
  isTransientContainerCreateError,
  parseFrozenControlArtifact,
  parseObjectsPage,
  parseUploadsPage,
  parseOptions,
  pollForAttach,
  postLiveTeardown,
  rankableTicks,
  renderFrozenControls,
  resourceNames,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_DIGEST,
  startupPollVerdict,
  recommend,
  teardownLiveArms,
  type CandidateFactsReply,
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
function fixtureAnswering(body: (method: string, path: string) => string) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${url.pathname}`);
    return new Response(body(method, url.pathname));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
  return { asked, restore: () => { globalThis.fetch = real; } };
}

const BENCH_FIXTURE = { origin: 'https://bench.invalid', token: 'bench-token' };

describe('startup readiness redrive', () => {
  /**
   * DEPLOYED INCIDENT, run 20260831002524, worker version
   * 17395333-bc63-4872-94e1-02587822caf0, the `r2fs` arm. `/state` answered
   * `running: false, restoration: 'unstarted', ready: false` for over an hour
   * with no incident recorded, and every repeated `/create` returned
   * `{ ok: true }` without starting a restoration. One authenticated
   * `/exec { command: 'true' }` then completed in 3449 ms and left the box
   * `running: true, restoration: 'attached', lastAttach.kind: 'attached'`.
   *
   * The old driver had no verdict for that reading, called it `pending`, and
   * polled `/state` forever: it never reaches the assertions below at all.
   */
  test('the startup nobody else will drive is driven here (deployed run 20260831002524 waited an hour)', async () => {
    let attached = false;
    const fixture = fixtureAnswering((method, path) => {
      if (method === 'POST' && path === '/exec') {
        attached = true;
        // What the fixture really answers for `true`, with the 3449 ms the
        // deployed drive cost.
        return JSON.stringify({ ok: true, exitCode: 0, stdout: '', stderr: '', ms: 3449 });
      }
      if (method === 'GET' && path === '/state') {
        return JSON.stringify(attached
          ? {
            ok: true,
            state: {
              running: true,
              restoration: 'attached',
              lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
              bootId: 'boot-after-the-drive',
            },
          }
          : {
            ok: true,
            state: {
              running: false,
              restoration: 'unstarted',
              ready: false,
              unready: 'no restoration has run for this container yet',
            },
          });
      }
      throw new Error(`the driver asked for ${method} ${path}`);
    });
    try {
      const poll = await pollForAttach(
        BENCH_FIXTURE, 'ab-r2fs-20260831002524', 'cold attach', ['empty', 'attached'],
      );
      // The attach still comes from the STATE the restoration published, not
      // from the drive's own reply.
      expect(poll.attach).toEqual({ kind: 'attached', detail: 'the work directory is mounted' });
      expect(poll.state.state?.bootId).toBe('boot-after-the-drive');
      // Recorded rather than silent: this is what tells a reader of the artifact
      // that the fixture's own schedule is not what completed the startup.
      expect(poll.redrives).toBe(1);
    } finally {
      fixture.restore();
    }
    // ONE exec, only for the reading that proved nobody was starting the
    // container, and the state poll still owns the verdict either side of it.
    expect(fixture.asked).toEqual(['GET /state', 'POST /exec', 'GET /state']);
  });

  test('a readiness boundary that refuses ends the startup instead of driving again', async () => {
    const fixture = fixtureAnswering((method, path) => {
      if (method === 'POST' && path === '/exec') {
        return JSON.stringify({
          ok: false,
          error: 'this devbox has no attached work directory: the recovery ladder refused. '
            + 'Operations are refused until an attach succeeds.',
        });
      }
      if (method === 'GET' && path === '/state') {
        return JSON.stringify({ ok: true, state: { running: false, restoration: 'unstarted' } });
      }
      throw new Error(`the driver asked for ${method} ${path}`);
    });
    try {
      await expect(pollForAttach(
        BENCH_FIXTURE, 'ab-merkle-pack-20260831002524', 'wake', ['attached'],
      )).rejects.toThrow(/wake refused: this devbox has no attached work directory/);
    } finally {
      fixture.restore();
    }
    expect(fixture.asked).toEqual(['GET /state', 'POST /exec']);
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
      attachColdMs: null, attachColdKind: '', attachColdBootId: null,
      attachWarmMs: null, attachWarmKind: '', wakeBootId: null, attachWarmBootId: null,
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
    const admission = devboxAdmission({
      arms: [arm],
      requested: ['bounded-layers'],
      meta: {
        date: '2026-08-28', worker: 'blank-fixture', bucket: 'blank-bucket',
        image: SANDBOX_IMAGE, seed: '1', 'loop budget ms': '1',
      },
      identity: {
        commit: '3a115f232', dirtyDigest: 'clean',
        workerVersion: '0f0a1e2c-9a1b-4c3d-8e5f-6a7b8c9d0e1f',
        startedAt: '2026-08-28T09:00:00.000Z', finishedAt: '2026-08-28T09:12:00.000Z',
        image: SANDBOX_IMAGE,
        imageSha256: SANDBOX_IMAGE_DIGEST,
        dockerfileSha256: `sha256:${'a'.repeat(64)}`,
        candidateRunnerSha256: `sha256:${'b'.repeat(64)}`,
        overlayRunnerSha256: `sha256:${'c'.repeat(64)}`,
        journalDaemonSha256: `sha256:${'d'.repeat(64)}`,
      },
      token: 'test-token',
      cleanup,
    });

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
      // DERIVED from the declaration, never a second copy of its membership: an
      // arm added to the candidate set must not need this list edited to agree,
      // because a stale copy here would pass while the deployed arm ran on an
      // image with no runner in it.
      for (const container of config.containers) {
        expect(container.image).toBe(
          CANDIDATE_CONTAINER_CLASSES.has(container.class_name)
            ? '/tmp/candidate.Dockerfile'
            : SANDBOX_IMAGE,
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
    expect(() => parseOptions(['--arms', 'bounded-layers,bounded-layers'])).toThrow(
      '--arms repeats "bounded-layers"; each requested arm must appear exactly once',
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
    // NOT `VERIFIED`, and not `REFUSED` either: this artifact carries no
    // per-check lifecycle rows, no per-arm tally and no admission decision, so
    // its own boolean is not evidence about anything this instrument tests.
    expect(report).toContain('UNUSABLE (legacy contract)');
    expect(report).not.toContain('VERIFIED');
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
    const requestEnded = Promise.withResolvers<void>();
    const request = new DeferredVerifyRequest();
    let requestedUrl = '';
    let headers: Readonly<Record<string, string>> = {};
    const responseCallback =
      Promise.withResolvers<(response: DeferredVerifyResponse) => void>();
    const teardown = postLiveTeardown(
      { origin: 'https://fixture.invalid', token: 'memory-only-token' },
      'ab-snapshot-chain-20260827000000',
      (url, options, respond) => {
        requestedUrl = url.toString();
        headers = options.headers;
        responseCallback.resolve(respond);
        request.onEnd = () => {
          requestEnded.resolve();
        };
        return request;
      },
    );

    await requestEnded.promise;
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

    const sendResponse = await responseCallback.promise;
    const response = new DeferredVerifyResponse();
    sendResponse(response);
    response.emit('data', JSON.stringify({ ok: true, purged: 4 }));
    response.emit('end');
    await expect(teardown).resolves.toBeUndefined();
  });
});

describe('the compared pair comes from the arms the run measured', () => {
  test('a candidates-only run compares bounded-layers against merkle-pack', () => {
    const pair = comparablePair([{ strategy: 'bounded-layers' }, { strategy: 'merkle-pack' }]);

    expect(pair.kind).toBe('pair');
    expect(pair.kind === 'pair' ? [pair.baseline, pair.candidate] : []).toEqual([
      'bounded-layers', 'merkle-pack',
    ]);
  });

  test('a run missing half of every declared pair yields no ratio at all', () => {
    // THE SHAPE OF THE FINAL STAGING RUN BEFORE THIS REPAIR. `--candidates-only`
    // deploys two arms; the report nonetheless printed a decision rule whose
    // ratio was taken over `snapshot-chain` and `overlay-cas`, arms whose
    // durable-object bindings the generated fixture config omits entirely. The
    // guard was `STRATEGIES.find((id) => id === 'overlay-cas') !== undefined`
    // over a frozen constant, so it was true on every run ever made.
    const pair = comparablePair([{ strategy: 'bounded-layers' }]);

    expect(pair.kind).toBe('absent');
    expect(pair.kind === 'absent' ? pair.reason : '').toContain('`bounded-layers`');
    expect(pair.kind === 'absent' ? pair.reason : '').toContain('no declared pair');
  });

  test('a shipped-arms run compares the chain against overlay-cas', () => {
    const pair = comparablePair([
      { strategy: 'snapshot-chain' }, { strategy: 'r2fs' }, { strategy: 'overlay-cas' },
    ]);

    expect(pair.kind === 'pair' ? [pair.baseline, pair.candidate] : []).toEqual([
      'snapshot-chain', 'overlay-cas',
    ]);
  });

  test('a run of no arms names no pair rather than a default one', () => {
    expect(comparablePair([]).kind).toBe('absent');
  });

  test('an arm nobody paired with cannot borrow the other pair\'s baseline', () => {
    // r2fs is in no declared pair. A rule that fell back to "whatever else ran"
    // would produce a ratio over two arms the research never compared.
    const pair = comparablePair([{ strategy: 'r2fs' }, { strategy: 'merkle-pack' }]);

    expect(pair.kind).toBe('absent');
  });
});

// ── the candidate lifecycle contract ───────────────────────────────────────
//
// Before this contract existed, a candidate arm took the chain's mount checks
// whenever the box reported `mode: 'chain'`, and otherwise fell through to the
// extraction branch, which asks only that `/workspace` is a plain directory and
// that `ALLOW_EXTRACTION` is set. The first test below is that exact state: no
// journal mount, no store mount, no envelope and no closure. It used to be a
// PASS, and the arm's latency rows were then ranked.

const CANDIDATE_BOX_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const CANDIDATE_PAYLOAD_PREFIX = `boxes/${CANDIDATE_BOX_ID}/candidate/bounded-layers/`;
const CANDIDATE_ENVELOPE_PREFIX = `boxes/${CANDIDATE_BOX_ID}/candidate-control/bounded-layers/envelopes/`;
const CANDIDATE_ENVELOPE_ID = 'e'.repeat(64);
const RUNTIME_DIR = '/var/tmp/devbox';
const JOURNAL_STATE = `${RUNTIME_DIR}/candidate-journal/state`;
const JOURNAL_SOCKET = `${JOURNAL_STATE}/control.sock`;
const JOURNAL_ROOT = `${RUNTIME_DIR}/candidate-journal/root`;
const JOURNAL_BINARY = '/usr/local/bin/kinu-journal-daemon';
const STORE_MOUNT = `${RUNTIME_DIR}/candidate-r2`;

const ATTACHED_MOUNTS = [
  'overlay / overlay rw,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec 0 0',
  `kinu-journal /workspace fuse.kinu-journal rw,nosuid,nodev 0 0`,
  `s3fs ${STORE_MOUNT} fuse.s3fs rw,nosuid,nodev 0 0`,
].join('\n');

const DAEMON_ARGV = `${JOURNAL_BINARY} --root ${JOURNAL_ROOT} --mount /workspace `
  + `--state ${JOURNAL_STATE} --socket ${JOURNAL_SOCKET}`;

type CandidateStoreOverrides = NonNullable<CandidateFactsReply['store']>;
type CandidateContainerOverrides = NonNullable<CandidateFactsReply['container']>;

function candidateEnvelope(overrides: Partial<CandidateStoreOverrides['head']> = {}) {
  return {
    key: `${CANDIDATE_ENVELOPE_PREFIX}${CANDIDATE_ENVELOPE_ID}.json`,
    rootEnvelopeId: CANDIDATE_ENVELOPE_ID,
    sha256: CANDIDATE_ENVELOPE_ID,
    format: 'bounded-layers/v1',
    boxId: CANDIDATE_BOX_ID,
    generation: '4',
    cut: '117',
    closureCount: 2,
    ...overrides,
  };
}

function candidateFacts(overrides: {
  store?: Partial<CandidateStoreOverrides>;
  container?: Partial<CandidateContainerOverrides>;
  ok?: boolean;
} = {}): CandidateFactsReply {
  const head = candidateEnvelope();
  return {
    ok: overrides.ok ?? true,
    store: {
      payloadPrefix: CANDIDATE_PAYLOAD_PREFIX,
      envelopePrefix: CANDIDATE_ENVELOPE_PREFIX,
      expectedBoxId: CANDIDATE_BOX_ID,
      expectedFormat: 'bounded-layers/v1',
      envelopes: [head],
      head,
      forkedHeads: [],
      closure: [
        { key: `${CANDIDATE_PAYLOAD_PREFIX}roots/base.json`, declaredBytes: '4096', storedBytes: 4_096 },
        { key: `${CANDIDATE_PAYLOAD_PREFIX}closures/c.json`, declaredBytes: '512', storedBytes: 512 },
      ],
      unreadable: [],
      ...overrides.store,
    },
    container: {
      expectedWorkdirMount: '/workspace',
      expectedStoreMount: STORE_MOUNT,
      expectedJournalRoot: JOURNAL_ROOT,
      expectedJournalSocket: JOURNAL_SOCKET,
      expectedJournalBinary: JOURNAL_BINARY,
      mounts: ATTACHED_MOUNTS,
      journalRootPresent: true,
      journalSocketPresent: true,
      journalDaemonCommand: DAEMON_ARGV,
      ...overrides.container,
    },
  };
}

const failingChecks = (reply: CandidateFactsReply): string[] =>
  candidateLifecycleChecks('bounded-layers', reply)
    .filter((check) => !check.pass)
    .map((check) => check.name);

describe('the candidate lifecycle contract', () => {
  test('a fully attached candidate passes every check', () => {
    const checks = candidateLifecycleChecks('bounded-layers', candidateFacts());

    expect(failingChecks(candidateFacts())).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(9);
  });

  test('the extraction shape a candidate used to pass on fails on every clause', () => {
    // A container that never attached a candidate store at all: no journal
    // mount, no store mount, no daemon, no envelope, no closure. The old
    // extraction branch asked only that /workspace was a plain directory.
    const bare = candidateFacts({
      store: { envelopes: [], head: null, closure: [] },
      container: {
        mounts: 'overlay / overlay rw,relatime 0 0',
        journalRootPresent: false,
        journalSocketPresent: false,
        journalDaemonCommand: '',
      },
    });

    expect(failingChecks(bare)).toEqual([
      'the work directory is the journal daemon\'s FUSE mount',
      'the journal daemon is alive and serving this arm\'s root, mount and socket',
      'the journal root is materialized beneath the mount',
      'the journal control socket is present outside both mounts',
      'the payload store is an s3fs mount at the candidate prefix',
      'the control envelope is the single published head',
      'the control envelope is the immutable object its own key names',
      'the control envelope carries this arm\'s format and box',
      'the payload closure is completely present at its declared lengths',
    ]);
  });

  test('an overlay work directory fails: a candidate arm is not a chain', () => {
    // The other half of the fallthrough. `mode: 'chain'` sent a candidate into
    // the chain's branch, which is satisfied by an overlay mount.
    const overlay = candidateFacts({
      container: {
        mounts: [
          'overlay / overlay rw,relatime 0 0',
          'overlay /workspace overlay rw,lowerdir=/var/tmp/devbox/lower-base 0 0',
          `s3fs ${STORE_MOUNT} fuse.s3fs rw 0 0`,
        ].join('\n'),
      },
    });

    expect(failingChecks(overlay)).toEqual(['the work directory is the journal daemon\'s FUSE mount']);
  });

  test('a FUSE mount with no daemon behind it fails', () => {
    expect(failingChecks(candidateFacts({ container: { journalDaemonCommand: '' } }))).toContain(
      'the journal daemon is alive and serving this arm\'s root, mount and socket',
    );
  });

  test('a daemon serving another arm\'s root or socket fails', () => {
    const otherRoot = candidateFacts({
      container: {
        journalDaemonCommand: `${JOURNAL_BINARY} --root /var/tmp/devbox/other/root --mount /workspace `
          + `--state ${JOURNAL_STATE} --socket ${JOURNAL_SOCKET}`,
      },
    });

    expect(failingChecks(otherRoot)).toContain(
      'the journal daemon is alive and serving this arm\'s root, mount and socket',
    );
  });

  test('a control socket inside a mount the arm captures fails', () => {
    const inside = candidateFacts({
      container: {
        expectedJournalSocket: '/workspace/.journal/control.sock',
        journalDaemonCommand: `${JOURNAL_BINARY} --root ${JOURNAL_ROOT} --mount /workspace `
          + `--state /workspace/.journal --socket /workspace/.journal/control.sock`,
      },
    });

    expect(failingChecks(inside)).toEqual([
      'the journal control socket is present outside both mounts',
    ]);
  });

  test('a forked head fails rather than picking one of two envelopes', () => {
    const forked = candidateFacts({
      store: {
        head: null,
        forkedHeads: [
          `${CANDIDATE_ENVELOPE_PREFIX}${'a'.repeat(64)}.json`,
          `${CANDIDATE_ENVELOPE_PREFIX}${'b'.repeat(64)}.json`,
        ],
        closure: [],
      },
    });
    const checks = candidateLifecycleChecks('bounded-layers', forked);

    expect(failingChecks(forked)).toContain('the control envelope is the single published head');
    expect(
      checks.find((check) => check.name === 'the control envelope is the single published head')?.detail,
    ).toContain('share the newest generation');
  });

  test('an unreadable sibling envelope fails even when a head resolved', () => {
    const partial = candidateFacts({
      store: { unreadable: [`${CANDIDATE_ENVELOPE_PREFIX}${'c'.repeat(64)}.json is not JSON: bad token`] },
    });

    expect(failingChecks(partial)).toContain('the control envelope is the single published head');
  });

  test('an envelope whose bytes do not hash to its own key fails', () => {
    const tampered = candidateFacts({ store: { head: candidateEnvelope({ sha256: 'f'.repeat(64) }) } });

    expect(failingChecks(tampered)).toEqual([
      'the control envelope is the immutable object its own key names',
    ]);
  });

  test('an envelope from another format or another box fails', () => {
    expect(failingChecks(candidateFacts({
      store: { head: candidateEnvelope({ format: 'merkle-pack/v1' }) },
    }))).toEqual(['the control envelope carries this arm\'s format and box']);

    expect(failingChecks(candidateFacts({
      store: { head: candidateEnvelope({ boxId: 'ffffffffffffffffffffffffffffffff' }) },
    }))).toEqual(['the control envelope carries this arm\'s format and box']);
  });

  test('an envelope prefix inside the payload mount fails', () => {
    const inside = candidateFacts({
      store: { envelopePrefix: `${CANDIDATE_PAYLOAD_PREFIX}envelopes/` },
    });

    expect(failingChecks(inside)).toContain('the control envelope prefix is outside the payload mount');
  });

  test('a closure object absent from the store fails', () => {
    const missing = candidateFacts({
      store: {
        closure: [
          { key: `${CANDIDATE_PAYLOAD_PREFIX}roots/base.json`, declaredBytes: '4096', storedBytes: 4_096 },
          { key: `${CANDIDATE_PAYLOAD_PREFIX}closures/c.json`, declaredBytes: '512', storedBytes: null },
        ],
      },
    });
    const checks = candidateLifecycleChecks('bounded-layers', missing);

    expect(failingChecks(missing)).toEqual([
      'the payload closure is completely present at its declared lengths',
    ]);
    expect(
      checks.find((check) => check.name.startsWith('the payload closure'))?.detail,
    ).toContain('1 absent');
  });

  test('a closure object present at the wrong length fails, not only an absent one', () => {
    // PRESENCE IS NOT ENOUGH. A key the envelope declares at 4 KiB and the
    // store holds at 0 B exists, so an existence check passes a closure that
    // cannot be read back.
    const short = candidateFacts({
      store: {
        closure: [
          { key: `${CANDIDATE_PAYLOAD_PREFIX}roots/base.json`, declaredBytes: '4096', storedBytes: 0 },
          { key: `${CANDIDATE_PAYLOAD_PREFIX}closures/c.json`, declaredBytes: '512', storedBytes: 512 },
        ],
      },
    });
    const checks = candidateLifecycleChecks('bounded-layers', short);

    expect(failingChecks(short)).toEqual([
      'the payload closure is completely present at its declared lengths',
    ]);
    expect(
      checks.find((check) => check.name.startsWith('the payload closure'))?.detail,
    ).toContain('1 at the wrong length');
  });

  test('a complete closure borrowed from another arm fails', () => {
    // Existence and length are insufficient if an envelope can name another
    // box's payload. The closure must be candidate-specific, below this arm's
    // own payload prefix.
    const borrowed = candidateFacts({
      store: {
        closure: [
          { key: 'boxes/other/candidate/bounded-layers/roots/base.json', declaredBytes: '4096', storedBytes: 4_096 },
          { key: 'boxes/other/candidate/bounded-layers/closures/c.json', declaredBytes: '512', storedBytes: 512 },
        ],
      },
    });
    const checks = candidateLifecycleChecks('bounded-layers', borrowed);

    expect(failingChecks(borrowed)).toEqual([
      'the payload closure is completely present at its declared lengths',
    ]);
    expect(checks.find((check) => check.name.startsWith('the payload closure'))?.detail)
      .toContain('2 outside this arm\'s payload prefix');
  });

  test('a head envelope naming no payload objects at all fails', () => {
    const empty = candidateFacts({ store: { closure: [] } });

    expect(failingChecks(empty)).toEqual([
      'the payload closure is completely present at its declared lengths',
    ]);
  });

  test('a fixture that could not answer the contract fails as one named check', () => {
    const refused = candidateLifecycleChecks('merkle-pack', {
      ok: false,
      error: 'merkle-pack publishes no candidate control envelope',
    });

    expect(refused).toHaveLength(1);
    expect(refused[0]?.pass).toBe(false);
    expect(refused[0]?.name).toBe('the fixture answered the merkle-pack candidate contract');
    expect(refused[0]?.detail).toContain('publishes no candidate control envelope');
  });
});

describe('a legacy control artifact cannot read as verified', () => {
  const currentArm = {
    strategy: 'r2fs',
    verifyPassed: true,
    verifyChecks: [{ name: '/workspace is really a s3fs mount', pass: true }],
    ops: { total: 412 },
  };
  const cleanFrozenCleanup = () => ({
    attempted: true,
    kept: false,
    workerAbsent: true,
    runtimeAbsent: true,
    bucketAndMultipartEmpty: true,
    boxDurableStateEmpty: true,
    localSecretsProcessesAbsent: true,
    countersReconciled: true,
    replayIdempotent: true,
    multipartResidue: 0,
    errors: [],
  });

  test('an artifact with no lifecycle rows, tally, cleanup or admission is unusable, never verified', () => {
    const judged = frozenControlStatus({ strategy: 'r2fs', verifyPassed: true }, undefined, undefined);

    expect(judged.status).toBe('legacy-contract');
    expect(judged.statusDetail).toContain('per-check lifecycle rows');
    expect(judged.statusDetail).toContain('a per-arm operation tally');
    expect(judged.statusDetail).toContain('complete C1–C7 cleanup evidence');
    expect(judged.statusDetail).toContain('a G0–G9 admission decision');
  });

  test('each missing lifecycle, accounting, cleanup and admission half is named on its own', () => {
    expect(frozenControlStatus(
      { ...currentArm, verifyChecks: [] },
      cleanFrozenCleanup(),
      { admitted: true },
    ).statusDetail).toContain('per-check lifecycle rows');

    expect(frozenControlStatus(
      { ...currentArm, ops: null },
      cleanFrozenCleanup(),
      { admitted: true },
    ).statusDetail).toContain('a per-arm operation tally');

    expect(frozenControlStatus(currentArm, undefined, { admitted: true }).statusDetail)
      .toContain('complete C1–C7 cleanup evidence');

    expect(frozenControlStatus(currentArm, cleanFrozenCleanup(), undefined).statusDetail)
      .toContain('a G0–G9 admission decision');
  });

  test('an artifact carrying the whole contract and passing it reads verified', () => {
    expect(frozenControlStatus(currentArm, cleanFrozenCleanup(), { admitted: true })).toEqual({
      status: 'verified',
      statusDetail: 'lifecycle, accounting, cleanup and admission all present and passing',
    });
  });

  test('a contract-carrying artifact with failed cleanup reads refused, not verified', () => {
    expect(frozenControlStatus(
      currentArm,
      { ...cleanFrozenCleanup(), bucketAndMultipartEmpty: false },
      { admitted: true },
    )).toMatchObject({
      status: 'refused',
      statusDetail: 'its C1–C7 cleanup contract did not complete cleanly',
    });
  });

  test('a contract-carrying artifact whose own gates refused reads refused, not verified', () => {
    expect(frozenControlStatus(currentArm, cleanFrozenCleanup(), { admitted: false })).toMatchObject({
      status: 'refused',
      statusDetail: 'its run was not admitted by its own G0–G9 gates',
    });
  });

  test('a failed lifecycle check reads refused and names the check', () => {
    const judged = frozenControlStatus({
      ...currentArm,
      verifyChecks: [{ name: 'the writable layer exists', pass: false }],
    }, cleanFrozenCleanup(), { admitted: true });

    expect(judged.status).toBe('refused');
    expect(judged.statusDetail).toContain('the writable layer exists');
  });

  test('a `verifyPassed: true` boolean cannot override a failing check row', () => {
    expect(frozenControlStatus({
      ...currentArm,
      verifyPassed: true,
      verifyChecks: [{ name: 'the fold advanced the durable cursor', pass: false }],
    }, cleanFrozenCleanup(), { admitted: true }).status).toBe('refused');
  });

  test('the rendered table prints the legacy status and never VERIFIED beside it', () => {
    const legacy = JSON.stringify({
      meta: {
        date: '2026-08-26',
        image: 'docker.io/cloudflare/sandbox:0.12.8',
        seed: '20260824',
        'loop budget ms': '6000',
      },
      arms: [{ strategy: 'overlay-cas', verifyPassed: true }],
    });
    const parsed = parseFrozenControlArtifact('overlay-cas', 'bench-artifacts/legacy.json', legacy);

    expect(parsed.status).toBe('legacy-contract');
    expect(parsed.verifyPassed).toBe(true);
    const report = renderFrozenControls([parsed]);
    expect(report).toContain('UNUSABLE (legacy contract)');
    expect(report).not.toContain('VERIFIED');
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

  test('no verifier probe carries a destructive command', () => {
    const source = readFileSync(join(import.meta.dirname, 'bench-devbox-strategies.ts'), 'utf8');
    const probesBody = source.slice(
      source.indexOf('export function cleanupObservationProbes'),
      source.indexOf('interface Fixture {'),
    );
    expect(probesBody.length).toBeGreaterThan(200);
    expect(probesBody).not.toContain("'delete'");
    expect(probesBody).not.toContain('--force');
    // And the replay arm drains residue before retrying its delete.
    expect(source).toContain('drainBucketResidue(residue, entry.name)');
  });
});

describe('the S3 residue parsers read escaped names and follow every page', () => {
  test('an entity-escaped key round-trips, so its delete addresses the real object', () => {
    const page = parseObjectsPage(
      '<ListBucketResult><Contents><Key>boxes/a&amp;b &lt;v1&gt;&#x27;s.bin</Key></Contents>'
      + '<IsTruncated>false</IsTruncated></ListBucketResult>',
    );
    expect(page).toEqual({ keys: ["boxes/a&b <v1>'s.bin"], next: null });
  });

  test('a truncated object listing yields its cursor, and a cursorless one throws', () => {
    const page = parseObjectsPage(
      '<r><Contents><Key>a</Key></Contents><IsTruncated>true</IsTruncated>'
      + '<NextContinuationToken>tok&amp;1</NextContinuationToken></r>',
    );
    expect(page.next).toBe('tok&1');
    expect(() => parseObjectsPage('<r><IsTruncated>true</IsTruncated></r>'))
      .toThrow(/no NextContinuationToken/);
  });

  test('a truncated upload listing yields its marker pair, and a bare one throws', () => {
    // The pre-fix shape read ONE page and stopped: a bucket with more than
    // 1000 open uploads silently read partial, and C3 could certify clean
    // while residue remained.
    const page = parseUploadsPage(
      '<r><Upload><Key>k1</Key><UploadId>u1</UploadId></Upload>'
      + '<IsTruncated>true</IsTruncated><NextKeyMarker>k1</NextKeyMarker>'
      + '<NextUploadIdMarker>u1</NextUploadIdMarker></r>',
    );
    expect(page).toEqual({ uploads: [{ key: 'k1', uploadId: 'u1' }], next: { keyMarker: 'k1', uploadIdMarker: 'u1' } });
    expect(() => parseUploadsPage('<r><IsTruncated>true</IsTruncated></r>'))
      .toThrow(/no marker pair/);
    expect(parseUploadsPage('<r><Upload><Key>k</Key><UploadId>u</UploadId></Upload></r>').next).toBeNull();
  });
});
