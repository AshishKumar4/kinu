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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  decide, opsAreBlind,
  sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';
import { refusalText } from './fixtures/storage-matrix/admission';

import { loadManifest, manifestPath } from './fixtures/storage-matrix/cleanup';
import * as v from 'valibot';
import { WRANGLER_FAILED } from './fixtures/r2-bench/deploy-substrate';
import { scratchDir } from '@kinu.run/test-utils';
import {
  DECIDING_METRIC,
  admittedAttachKinds,
  addressArmRequest,
  armLogTail,
  underArmLog,
  benchmarkExitCode,
  boxName,
  CANDIDATE_CONTAINER_CLASSES,
  candidateProbePrecondition,
  candidateLifecycleChecks,
  chainArchiveExpectations,
  controlWitnessChecks,
  cleanupObservationProbes,
  checkpointOperation,
  contextCopySources,
  comparablePairs,
  createFixtureResources,
  describeStartupState,
  devboxAdmission,
  devboxArmEvidence,
  drainBucketResidue,
  EXPECTED_LADDER_ROWS,
  INCUMBENT,
  fixtureConfigForArms,
  frozenControlStatus,
  candidateImageDockerfile,
  isRearmableStartupRefusal,
  isTransientContainerCreateError,
  stageImageContext,
  parseFrozenControlArtifact,
  parseOptions,
  pollForAttach,
  postLiveTeardown,
  r2CleanupKeyRefusal,
  R2_CLEANUP_KEY_FILE,
  rankableTicks,
  retainWakeMountLines,
  readArmArtifact,
  refuseFailedArm,
  resetArmLogs,
  runArm,
  runArmsInFlight,
  runDecisive,
  renderArmLifecycleRow,
  runWorkloadPhases,
  render,
  renderFrozenControls,
  orphanTeardownExecutor,
  plannedTeardownManifest,
  resourceNames,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_DIGEST,
  startupOperation,
  STRATEGIES, DECISIVE_ARMS,
  startupPollVerdict,
  stopOperation,
  recommend,
  teardownLiveArms,
  externallyAbortedArm,
  writeArmArtifact,
  type ArmResult,
  type ControlWitnessFacts,
  type CandidateFactsReply,
  type Strategy,
  candidateRootId,
  chainServedWord,
  compareGenerations,
  countedRestoreWork,
  diffOpTallies,
  foldedCursor,
  judgeCandidateCut,
  judgeChainCut,
  judgeOverlayCut,
  judgeReadOnlyRefusal,
  parseCursorSeq,
  parseOverlaySweep,
  replayedEntries,
  restoreWorkFromCounts,
  selectWakeMountLines,
  summarizePublication,
  verifyRestoreBound,
  type CandidateCutFacts,
  type ChainCutFacts,
  type FaultCutObservation,
  type OverlayCutFacts,
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
            + 'That recovery class is terminal: call attachNow() to attempt the attach again.',
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

  /**
   * DEPLOYED INCIDENT, 2026-09-01: `bun scripts/devbox-e2e.ts --arms
   * snapshot-chain` ended its cold attach at 12,810 ms with the box's own
   * "a startup is armed, so ask again", on both sides of the byte-plane change
   * (12,817 ms at the commit before it). `Devbox.ensureReady()` writes three
   * sentences and only the terminal one is a verdict; this driver read all
   * three as one, so a container that was still coming up was recorded as a
   * refusal.
   */
  test('a box that says to ask again is still starting, and the poll keeps asking', async () => {
    let drives = 0;
    const fixture = fixtureAnswering((method, path) => {
      if (method === 'POST' && path === '/exec') {
        drives += 1;
        return JSON.stringify({
          ok: false,
          error: 'this devbox is not ready: no restoration has run for this container yet. '
            + 'Nothing has been classified as a failure; a startup is armed, so ask again.',
        });
      }
      if (method === 'GET' && path === '/state') {
        return JSON.stringify(drives === 0
          ? { ok: true, state: { running: false, restoration: 'unstarted' } }
          : {
            ok: true,
            state: {
              running: true,
              restoration: 'attached',
              lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
            },
          });
      }
      throw new Error(`the driver asked for ${method} ${path}`);
    });
    try {
      const poll = await pollForAttach(
        BENCH_FIXTURE, 'ab-snapshot-chain-e2e20260901213301', 'cold attach', ['empty', 'attached'],
        { deadlineMs: 30_000 },
      );
      expect(poll.attach.kind).toBe('attached');
      expect(poll.redrives).toBe(1);
    } finally {
      fixture.restore();
    }
    // The refusal did not end the wait: the NEXT state reading did, which is
    // the same oracle every other reading goes through.
    expect(fixture.asked.slice(-1)).toEqual(['GET /state']);
  });

  /**
   * A fixture whose `/exec` never answers, which is what a readiness drive
   * posted against a slow restoration really looks like: `/exec` waits on
   * `ensureReady()`, so the request stays open for as long as the attach takes
   * and the client's own deadline is the only thing that ends it.
   */
  function fixtureWithAHangingExec(state: () => string) {
    const asked: string[] = [];
    const real = globalThis.fetch;
    const answer = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      asked.push(`${method} ${url.pathname}`);
      if (url.pathname === '/exec') return await new Promise<Response>(() => {});
      return new Response(state());
    };
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    return { asked, restore: () => { globalThis.fetch = real; } };
  }

  /**
   * DEPLOYED INCIDENT, the `snapshot-chain` wake in devbox-e2e-e2ecal0901002202
   * (540,050 ms = `CALL_ATTEMPTS` x `CALL_DEADLINE_MS`) and the same arm in the
   * decisive run 20260831233915, whose log shows the wake's drive losing two
   * `POST /exec` attempts before the arm died on `The operation timed out.`.
   *
   * Awaiting the drive meant nothing asked `/state` for nine minutes, so a box
   * that attached during the wait was recorded as one that never attached at
   * all — the transport's verdict wearing the product's name.
   */
  test('a drive whose reply never lands does not become the startup verdict', async () => {
    let driven = false;
    const fixture = fixtureWithAHangingExec(() => JSON.stringify(driven
      ? {
        ok: true,
        state: {
          running: true,
          restoration: 'attached',
          lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
        },
      }
      : { ok: true, state: { running: false, restoration: 'unstarted' } }));
    try {
      const polled = pollForAttach(
        BENCH_FIXTURE, 'ab-snapshot-chain-e2ecal0901002202', 'wake', ['attached'],
        { deadlineMs: 30_000 },
      );
      // The restoration finishes while the drive's request is still open, which
      // is the case the old loop could not see.
      driven = true;
      const poll = await polled;
      expect(poll.attach.kind).toBe('attached');
      expect(poll.redrives).toBe(1);
    } finally {
      fixture.restore();
    }
    // The poll kept reading state THROUGH the unanswered drive.
    expect(fixture.asked.filter((call) => call === 'POST /exec')).toEqual(['POST /exec']);
    expect(fixture.asked.slice(-1)).toEqual(['GET /state']);
  });

  test('the ceiling refusal names the drive that never answered', async () => {
    const fixture = fixtureWithAHangingExec(() =>
      JSON.stringify({ ok: true, state: { running: false, restoration: 'unstarted' } }));
    try {
      const refused = pollForAttach(
        BENCH_FIXTURE, 'ab-snapshot-chain-e2ecal0901002202', 'wake', ['attached'],
        { deadlineMs: 800 },
      );
      await expect(refused).rejects.toThrow(
        /wake did not attach within its 800 ms ceiling .*a readiness drive posted \d+ ms ago has not answered/,
      );
    } finally {
      fixture.restore();
    }
    // ONE drive, however many readings the ceiling window held.
    expect(fixture.asked.filter((call) => call === 'POST /exec')).toEqual(['POST /exec']);
  });
});

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
function armingFixture(options: {
  /** How many polls the operation stays pending for before it settles. */
  readonly pollsBeforeSettled: number;
  /** Lose the FIRST arming reply after the arm landed: the deployed shape of a
   *  transport loss, and the case a non-idempotent arm publishes twice for. */
  readonly loseFirstArmReply?: boolean;
  readonly settleAs?: 'done' | 'failed';
  readonly outcomeKind?: string;
}) {
  const tokenByOp = new Map<string, string>();
  const polls = new Map<string, number>();
  const asked: string[] = [];
  let publications = 0;
  let armPosts = 0;
  const arm = (op: string): string => {
    const existing = tokenByOp.get(op);
    if (existing !== undefined) return existing;
    publications += 1;
    const token = `checkpoint-${String(publications)}`;
    tokenByOp.set(op, token);
    polls.set(token, 0);
    return token;
  };
  const real = globalThis.fetch;
  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${url.pathname}`);
    if (method === 'POST') {
      armPosts += 1;
      // PARSED, not narrowed: a post that carries no `op` is what the OLD
      // protocol sent, and this fixture has to be able to tell the two apart.
      const posted = v.safeParse(PostedBodySchema, JSON.parse(String(init?.body ?? '{}')));
      const op = posted.success && posted.output.op !== undefined
        ? posted.output.op
        : `anonymous-${String(armPosts)}`;
      const token = arm(op);
      if (options.loseFirstArmReply === true && armPosts === 1) {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      }
      return new Response(JSON.stringify({ ok: true, token, state: 'pending' }), { status: 202 });
    }
    const token = url.searchParams.get('token') ?? '';
    const seen = (polls.get(token) ?? 0) + 1;
    polls.set(token, seen);
    if (seen < options.pollsBeforeSettled) {
      return new Response(JSON.stringify({ ok: true, token, state: 'pending' }));
    }
    const settleAs = options.settleAs ?? 'done';
    // The failure reason is a field of the settled reply, present only when the
    // publication failed — which is what `error` means on this route.
    const failure = settleAs === 'failed' ? 'the publication threw mid-flight' : undefined;
    return new Response(JSON.stringify({
      ok: settleAs === 'done',
      token,
      state: settleAs,
      // The FIXTURE's own duration, which is the number a measured row keeps:
      // it is unaffected by how long the driver polled for it.
      ms: 41_000,
      outcome: { kind: options.outcomeKind ?? 'committed', bytes: 4096, movedBytes: 2048 },
      error: failure,
    }));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
  return {
    asked,
    arms: () => armPosts,
    publications: () => publications,
    restore: () => { globalThis.fetch = real; },
  };
}

/** Fast bounds: the protocol under test is the cadence's client, not the
 *  cadence. Production values live beside `OPERATION_DEADLINE_MS`. */
const TEST_BOUNDS = { pollMs: 1, deadlineMs: 2_000 };

describe('the async checkpoint and stop protocol', () => {
  test('a checkpoint outliving one HTTP attempt publishes once and is read by token', async () => {
    const fixture = armingFixture({ pollsBeforeSettled: 4 });
    try {
      const settled = await checkpointOperation(
        BENCH_FIXTURE, 'ab-snapshot-chain-20260831', 'quiesce', 'ladder 64KiB quiesce', TEST_BOUNDS,
      );
      // The OUTCOME came from the poll, not from the request that armed it, and
      // the measured millisecond figure is the fixture's own.
      expect(settled.outcome?.kind).toBe('committed');
      expect(settled.ms).toBe(41_000);
    } finally {
      fixture.restore();
    }
    // ONE arm, then polls until it settled: four polls for an operation that
    // stayed pending through three of them.
    expect(fixture.publications()).toBe(1);
    expect(fixture.arms()).toBe(1);
    expect(fixture.asked).toEqual([
      'POST /checkpoint', 'GET /operation', 'GET /operation', 'GET /operation', 'GET /operation',
    ]);
  });

  test('an arming reply lost in transit re-asks the SAME operation, never a second one', async () => {
    const fixture = armingFixture({ pollsBeforeSettled: 1, loseFirstArmReply: true });
    try {
      const settled = await checkpointOperation(
        BENCH_FIXTURE, 'ab-merkle-pack-20260831', 'quiesce', 'candidate barrier', TEST_BOUNDS,
      );
      expect(settled.outcome?.kind).toBe('committed');
    } finally {
      fixture.restore();
    }
    // TWO posts, ONE publication. The arm landed before the reply was lost, so a
    // protocol keyed on anything but the caller's own `op` would have started a
    // second publication here — which is exactly what the blocking protocol did
    // with its 180 s deadline and three attempts.
    expect(fixture.arms()).toBe(2);
    expect(fixture.publications()).toBe(1);
  });

  test('the counter this guard rests on rises when an op is NOT reused', async () => {
    // The failing direction, so `publications() === 1` above is not vacuous: two
    // posts that do not name one operation are two publications, which is the
    // pre-fix behaviour of a timed-out retry.
    const fixture = armingFixture({ pollsBeforeSettled: 1 });
    try {
      await checkpointOperation(BENCH_FIXTURE, 'ab-r2fs-1', 'tick', 'first', TEST_BOUNDS);
      await checkpointOperation(BENCH_FIXTURE, 'ab-r2fs-1', 'tick', 'second', TEST_BOUNDS);
    } finally {
      fixture.restore();
    }
    expect(fixture.publications()).toBe(2);
  });

  test('an operation that never settles refuses at its deadline instead of re-posting', async () => {
    const fixture = armingFixture({ pollsBeforeSettled: Number.MAX_SAFE_INTEGER });
    try {
      await expect(checkpointOperation(
        BENCH_FIXTURE, 'ab-bounded-layers-1', 'quiesce', 'barrier', { pollMs: 1, deadlineMs: 25 },
      )).rejects.toThrow(/did not settle within the .* operation deadline/);
    } finally {
      fixture.restore();
    }
    expect(fixture.publications()).toBe(1);
    expect(fixture.arms()).toBe(1);
  });

  test('a stop reports the quiesce it armed, and a failed one is not a release', async () => {
    const failed = armingFixture({ pollsBeforeSettled: 2, settleAs: 'failed', outcomeKind: 'failed' });
    try {
      const settled = await stopOperation(BENCH_FIXTURE, 'ab-overlay-cas-1', 'stop', TEST_BOUNDS);
      expect(settled.ok).toBe(false);
      expect(settled.error).toContain('threw mid-flight');
      expect(settled.ms).toBe(41_000);
    } finally {
      failed.restore();
    }
    expect(failed.publications()).toBe(1);

    const done = armingFixture({ pollsBeforeSettled: 1 });
    try {
      expect((await stopOperation(BENCH_FIXTURE, 'ab-overlay-cas-1', 'stop', TEST_BOUNDS)).ok).toBe(true);
    } finally {
      done.restore();
    }
  });

  test('no minute-scale route is posted as a blocking request any more', () => {
    const source = readFileSync(new URL('./bench-devbox-strategies.ts', import.meta.url), 'utf8');
    // The two routes travel through the async arm-and-poll protocol; a `call`
    // that posts either of them and then waits out the outcome is a request
    // holding a publication open again. `armCheckpointOperation` is the one
    // named exception: it posts the arm, returns the token, and never waits —
    // the fault-cut cell kills the container while the token is pending, so
    // waiting there would defeat the cut it exists to make.
    const lines = source.split('\n');
    let enclosing = '';
    for (const line of lines) {
      const fn = /^(?:export )?async function ([A-Za-z0-9_]+)/.exec(line)?.[1]
        ?? /^(?:export )?function ([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (fn !== undefined) enclosing = fn;
      if (line.includes("'POST', `/checkpoint?box=") || line.includes("'POST', `/stop?box=")) {
        expect(['awaitArmedOperation', 'armCheckpointOperation']).toContain(enclosing);
      }
    }
    expect(source).toContain('awaitArmedOperation');
  });
});

/**
 * A fixture that measures a whole arm and then refuses its WAKE.
 *
 * The shape of both 2026-08-31 decisive runs: a cold attach that landed, a
 * checkpoint ladder that committed, and a refusal at the recycle. Every route
 * an arm touches before that point answers here, so what the artifact keeps is
 * decided by the driver rather than by how far the fake got.
 */
function wakeRefusingFixture(refusal: string, stopRefusal?: string) {
  const asked: string[] = [];
  let woken = false;
  let stopping = false;
  const real = globalThis.fetch;
  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    asked.push(route);
    if (route === 'POST /wake') {
      woken = true;
      return new Response(JSON.stringify({ ok: true, ms: 12 }));
    }
    if (route === 'GET /state') {
      return new Response(JSON.stringify(woken
        ? { ok: true, state: { running: true, restoration: 'unattached', unready: refusal } }
        : {
            ok: true,
            storePrefix: 'boxes/probe/',
            state: {
              running: true,
              restoration: 'attached',
              lastAttach: { kind: 'attached', detail: 'the work directory is mounted' },
              bootId: 'boot-before-the-stop',
              chain: { base: { id: 'chain-1' }, delta: { bytes: 4096 }, mode: 'chain', rev: 3 },
            },
          }));
    }
    if (route === 'POST /stop' && stopRefusal !== undefined) {
      stopping = true;
      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }
    if (route === 'POST /checkpoint' || route === 'POST /stop') {
      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }
    if (route === 'GET /operation') {
      if (stopping && stopRefusal !== undefined) {
        return new Response(JSON.stringify({
          ok: false, state: 'failed', ms: 1_234, outcome: { kind: 'failed' }, error: stopRefusal,
        }));
      }
      return new Response(JSON.stringify({
        ok: true,
        state: 'done',
        ms: 1_234,
        outcome: { kind: 'committed', bytes: 65_536, movedBytes: 32_768 },
      }));
    }
    if (route === 'POST /exec') {
      // Whatever is asked, answered as a success carrying its own stdout: the
      // marker read is the only exec whose OUTPUT the arm reads before the wake.
      const posted = v.safeParse(PostedBodySchema, JSON.parse(String(init?.body ?? '{}')));
      const command = posted.success ? posted.output.command ?? '' : '';
      const marker = /printf %s (devbox-verify-[0-9a-f-]+)/.exec(command)?.[1] ?? '';
      return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout: marker, stderr: '', ms: 3 }));
    }
    if (route === 'GET /ops') {
      return new Response(JSON.stringify({ calls: { put: 4 }, classA: 4, classB: 1, classFree: 0, total: 5 }));
    }
    return new Response(JSON.stringify({ ok: true, ms: 1 }));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
  return { asked, restore: () => { globalThis.fetch = real; } };
}

describe('an arm that fails mid-measurement', () => {
  test('keeps its cold attach and its ladder instead of being replaced by nulls', async () => {
    const refusal = 'S3FS mount failed: s3fs: MOUNTPOINT directory /workspace is not empty';
    const fixture = wakeRefusingFixture(refusal);
    let arm: ArmResult;
    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'snapshot-chain',
        { ...parseOptions([]), arms: ['snapshot-chain'], runId: 'preserve-probe' },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    // WHAT WAS MEASURED IS STILL THERE. Pre-fix every one of these was null.
    expect(arm.attachColdKind).toBe('attached');
    expect(arm.attachColdMs).not.toBeNull();
    expect(arm.attachColdBootId).toBe('boot-before-the-stop');
    expect(arm.checkpoints).toHaveLength(EXPECTED_LADDER_ROWS);
    expect(arm.checkpoints.every((row) => row.outcome.startsWith('committed'))).toBe(true);
    expect(arm.stopMs).toBe(1_234);
    expect(arm.generationBeforeLadder).toEqual({ baseId: 'chain-1', hasDelta: true, rev: 3 });

    // AND THE REFUSAL TRAVELS WITH THEM, in the fixture's own words.
    expect(arm.notes.join(' ')).toContain(refusal);
    expect(arm.notes.join(' ')).toContain('arm failed mid-measurement');

    // THE FAILED ARM RANKS NOTHING: the wake never happened, so the rows above
    // describe a box whose recycle was never proven.
    expect(arm.wakeKind).toBe('');
    expect(arm.wakeMs).toBeNull();
    expect(arm.verifyPassed).toBe(false);
    expect(arm.verifyChecks.some((check) => !check.pass && check.detail.includes(refusal))).toBe(true);
    expect(rankableTicks([arm], arm.decisiveTicks)).toEqual([]);

    // AND ITS INSTANCE WAS HANDED BACK, which is what stops one arm's death
    // from refusing the next arm's create with `Maximum number of instances`.
    expect(fixture.asked.filter((route) => route === 'POST /stop')).toHaveLength(2);
  }, 20_000);

  test('a failed stop never asks wake against the still-running box', async () => {
    // THE PROBE'S FAILURE SHAPE. The final quiesce answered
    // CandidateCaptureUnavailable before detach/invalidate/stop, so the box was
    // still running. Asking /wake next observed that live box as attached and
    // manufactured stop-to-wake evidence from a lifecycle that never recycled.
    const refusal = 'CandidateCaptureUnavailable: journal capture did not seal';
    const fixture = wakeRefusingFixture('the still-running box answered its live state', refusal);
    let arm: ArmResult;
    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'bounded-layers',
        { ...parseOptions([]), arms: ['bounded-layers'], runId: 'stop-refused-probe', verifyOnly: false },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    expect(fixture.asked).not.toContain('POST /wake');
    expect(arm.stopMs).toBe(1_234);
    expect(arm.wakeKind).toBe('');
    expect(arm.wakeMs).toBeNull();
    expect(arm.verifyPassed).toBe(false);
    expect(arm.notes.join(' ')).toContain(refusal);
    expect(arm.notes.join(' ')).toContain('arm failed mid-measurement');
    // The failed arm still asks stop once more through the bounded release
    // path, but neither failed stop can be followed by a wake.
    expect(fixture.asked.filter((route) => route === 'POST /stop')).toHaveLength(2);
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
function probeScopeFixture(options: {
  readonly journalReady?: boolean;
  readonly failLadderTick?: boolean;
} = {}) {
  const asked: { route: string; body: string }[] = [];
  const real = globalThis.fetch;
  let woken = false;
  let marker = '';
  let candidateCalls = 0;
  let incidentCalls = 0;
  let checkpointArms = 0;
  const journalReady = options.journalReady ?? true;
  const mounts =
    'journald /workspace fuse.journald rw 0 0\ns3fs /var/tmp/devbox/store fuse.s3fs rw 0 0\n';
  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    const body = String(init?.body ?? '');
    asked.push({ route, body });
    if (route === 'POST /wake') {
      woken = true;
      return new Response(JSON.stringify({ ok: true, ms: 12 }));
    }
    if (route === 'GET /state') {
      return new Response(JSON.stringify({
        ok: true,
        storePrefix: 'boxes/probe/',
        state: {
          running: true,
          restoration: 'attached',
          lastAttach: { kind: 'attached', detail: 'restored candidate root aabbcc' },
          bootId: woken ? 'boot-after-the-wake' : 'boot-before-the-stop',
          chain: { base: { id: 'chain-1' }, delta: { bytes: 4096 }, mode: 'chain', rev: 3 },
        },
      }));
    }
    if (route === 'POST /checkpoint') checkpointArms += 1;
    if (route === 'POST /checkpoint' || route === 'POST /stop') {
      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }
    if (route === 'GET /operation') {
      if (options.failLadderTick === true && checkpointArms === 2) {
        return new Response(JSON.stringify({
          ok: false, state: 'failed', ms: 91, outcome: { kind: 'failed' },
          error: 'CandidateCaptureUnavailable: journal disappeared during the ladder tick',
        }));
      }
      return new Response(JSON.stringify({
        ok: true,
        state: 'done',
        ms: 1_234,
        outcome: { kind: 'committed', bytes: 65_536, movedBytes: 32_768 },
      }));
    }
    if (route === 'POST /exec') {
      const posted = v.safeParse(PostedBodySchema, JSON.parse(String(init?.body ?? '{}')));
      const command = posted.success ? posted.output.command ?? '' : '';
      const written = /printf %s (devbox-verify-[0-9a-f-]+)/.exec(command)?.[1] ?? '';
      if (written !== '') marker = written;
      const stdout = command.includes('cat /proc/mounts')
        ? mounts
        : command.includes('.devbox-verify-marker.txt') ? (written !== '' ? written : marker) : '';
      return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout, stderr: '', ms: 3 }));
    }
    if (route === 'GET /ops') {
      return new Response(JSON.stringify({ calls: { put: 4 }, classA: 4, classB: 1, classFree: 0, total: 5 }));
    }
    if (route === 'GET /candidate') {
      candidateCalls += 1;
      const head = candidateCalls === 1 ? 'precondition-head' : candidateCalls === 2 ? 'pub-head' : 'wake-head';
      return new Response(JSON.stringify({
        ok: true,
        store: {
          payloadPrefix: 'boxes/probe/candidate/bounded-layers/payload/',
          envelopePrefix: 'boxes/probe/candidate/bounded-layers/envelopes/',
          expectedBoxId: 'probe-box',
          expectedFormat: 'probe-format',
          envelopes: [],
          head: {
            key: 'boxes/probe/candidate/bounded-layers/envelopes/aabb.json',
            rootEnvelopeId: 'aabb',
            sha256: 'aabb',
            format: 'probe-format',
            boxId: 'probe-box',
            generation: '3',
            cut: 'all',
          },
          forkedHeads: [],
          closure: [{
            key: 'boxes/probe/candidate/bounded-layers/payload/obj-1',
            declaredBytes: '8',
            storedBytes: 8,
          }],
          unreadable: [],
        },
        container: {
          expectedWorkdirMount: '/workspace',
          expectedStoreMount: '/var/tmp/devbox/store',
          expectedJournalRoot: '/var/tmp/journal',
          expectedJournalSocket: '/var/tmp/journal.sock',
          expectedJournalBinary: 'journal-daemon',
          mounts,
          journalRootPresent: true,
          journalSocketPresent: true,
          journalDaemonCommand: 'journal-daemon --root /var/tmp/journal --mount /workspace --socket /var/tmp/journal.sock',
          journalReady,
          journalReadyDetail: journalReady ? '{"ok":true,"sequence":7}' : 'connect ECONNREFUSED',
        },
        control: {
          strategy: 'bounded-layers',
          boxId: 'probe-box',
          key: 'candidate/bounded-layers/control',
          found: true,
          head,
          operation: 'quiesce',
        },
      }));
    }
    if (route === 'GET /incidents') {
      incidentCalls += 1;
      const ladder = [{ stage: 'checkpoint', reason: 'ladder-window failure', at: 1000, attempts: 1, delivered: true }];
      return new Response(JSON.stringify({
        ok: true,
        incidents: incidentCalls === 1
          ? ladder
          : [...ladder, { stage: 'restore', reason: 'restore-window failure', at: 2000, attempts: 3, delivered: false }],
      }));
    }
    return new Response(JSON.stringify({ ok: true, ms: 1 }));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
  return { asked, restore: () => { globalThis.fetch = real; } };
}

describe('a verify-only probe arm', () => {
  test('runs one ladder, stop, wake and teardown with its evidence reads — and nothing else', async () => {
    const fixture = probeScopeFixture();
    let arm: ArmResult;
    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'bounded-layers',
        { ...parseOptions([]), arms: ['bounded-layers'], runId: 'probe-scope-verify', verifyOnly: true },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    // THE LADDER, STOP AND WAKE RAN: the evidence window's own steps.
    expect(arm.checkpoints).toHaveLength(EXPECTED_LADDER_ROWS);
    expect(arm.stopMs).toBe(1_234);
    expect(arm.wakeKind).toBe('attached');
    expect(arm.wakeBootId).toBe('boot-after-the-wake');
    expect(arm.verifyPassed).toBe(true);
    expect(arm.probe?.status).toBe('complete');
    expect(renderArmLifecycleRow(arm)).toContain('PROBE COMPLETE — NOT SCORED');

    // THE FOUR ARCHIVED READS, each from its own window.
    expect(arm.publishControl?.found).toBe(true);
    expect(arm.publishControl?.head).toBe('pub-head');
    expect(arm.wakeControl?.head).toBe('wake-head');
    expect(arm.publishIncidents?.map((row) => row.reason)).toEqual(['ladder-window failure']);
    expect(arm.wakeIncidents?.map((row) => row.reason)).toEqual(['ladder-window failure', 'restore-window failure']);

    // AND NOTHING ELSE: no workload phases, no decisive ticks, no warm
    // attach, no tally, no cells — with the skips noted, not silent.
    expect(arm.phases).toEqual([]);
    expect(arm.decisiveTicks).toEqual([]);
    expect(arm.attachWarmMs).toBeNull();
    expect(arm.ops).toBeNull();
    expect(arm.witnessChecks).toEqual([]);
    expect(arm.cut).toBeNull();
    expect(arm.notes.join(' ')).toContain('workload phases skipped');
    expect(arm.notes.join(' ')).toContain('probe scope');

    // A PROBE THAT SILENTLY RAN A WORKLOAD IS THE FAILURE MODE: no exec
    // carried a phase or a decisive workload, and the box was still torn
    // down and handed back.
    const execs = fixture.asked.filter((ask) => ask.route === 'POST /exec');
    expect(execs.length).toBeGreaterThan(0);
    for (const ask of execs) {
      expect(ask.body).not.toContain('probe.ts');
      expect(ask.body).not.toContain('decisive.ts');
    }
    expect(fixture.asked.some((ask) => ask.route === 'POST /teardown')).toBe(true);
    expect(fixture.asked.filter((ask) => ask.route === 'POST /stop')).toHaveLength(2);
  }, 20_000);

  test('a missing journal aborts as a probe precondition before the ladder', async () => {
    // A socket file and daemon argv are not an answer. The fixture reports
    // the probe of the read-only `stats` request refusing; before this guard
    // the driver spent the whole ladder and went on to stop/wake anyway.
    const fixture = probeScopeFixture({ journalReady: false });
    let arm: ArmResult;
    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'bounded-layers',
        { ...parseOptions([]), arms: ['bounded-layers'], runId: 'journal-precondition', verifyOnly: true },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    expect(fixture.asked).not.toContainEqual(expect.objectContaining({ route: 'POST /checkpoint' }));
    expect(fixture.asked).not.toContainEqual(expect.objectContaining({ route: 'POST /write' }));
    expect(fixture.asked).not.toContainEqual(expect.objectContaining({ route: 'POST /ops/reset' }));
    expect(arm.checkpoints).toEqual([]);
    expect(arm.probe).toEqual({ status: 'precondition-failed', detail: 'connect ECONNREFUSED' });
    expect(arm.verifyChecks).toEqual([]);
    expect(arm.notes.join(' ')).toContain('PROBE PRECONDITION FAILED');
    expect(arm.notes.join(' ')).toContain('connect ECONNREFUSED');
    expect(arm.notes.join(' ')).not.toContain('arm failed mid-measurement');
    expect(renderArmLifecycleRow(arm)).toContain('PROBE NOT RUN — PRECONDITION FAILED');
    expect(renderArmLifecycleRow(arm)).not.toContain('| **FAILED** |');
    expect(fixture.asked.some((ask) => ask.route === 'POST /teardown')).toBe(true);
  }, 20_000);

  test('a later journal tick failure aborts the probe before stop or wake', async () => {
    const fixture = probeScopeFixture({ failLadderTick: true });
    let arm: ArmResult;
    try {
      arm = await runArm(
        BENCH_FIXTURE,
        'bounded-layers',
        { ...parseOptions([]), arms: ['bounded-layers'], runId: 'journal-tick-partial', verifyOnly: true },
        () => {},
      );
    } finally {
      fixture.restore();
    }

    expect(fixture.asked.filter((ask) => ask.route === 'POST /checkpoint')).toHaveLength(2);
    expect(fixture.asked.some((ask) => ask.route === 'POST /wake')).toBe(false);
    expect(arm.checkpoints).toHaveLength(2);
    expect(arm.checkpoints[1]?.outcome).toContain('CandidateCaptureUnavailable');
    expect(arm.notes.join(' ')).toContain('PROBE PARTIAL');
    expect(arm.probe?.status).toBe('partial');
    expect(renderArmLifecycleRow(arm)).toContain('PROBE PARTIAL — NOT SCORED');
    expect(arm.notes.join(' ')).toContain('journal disappeared during the ladder tick');
    expect(fixture.asked.some((ask) => ask.route === 'POST /teardown')).toBe(true);
  }, 20_000);

  test('verify-only wins over decisive at parse time', () => {
    const options = parseOptions(['--arms', 'bounded-layers', '--decisive', '--verify-only']);
    expect(options.verifyOnly).toBe(true);
    expect(options.decisive).toBe(false);
  });

  test('the workload phases skip without touching the fixture', async () => {
    const arm = measuredArm('bounded-layers');
    const notes: string[] = [];
    await runWorkloadPhases(
      BENCH_FIXTURE,
      'ab-bounded-layers-probe',
      'bounded-layers',
      { seed: 1, budgetMs: 1, repetitions: 2, verifyOnly: true },
      arm,
      notes,
    );
    expect(arm.phases).toEqual([]);
    expect(notes.join(' ')).toContain('workload phases skipped');
  });

  test('mount retention reads the reply’s own points for candidates, declared points elsewhere', () => {
    const mounts = 'journald /workspace fuse.journald rw 0 0\ns3fs /var/tmp/devbox/store fuse.s3fs rw 0 0\n';
    expect(retainWakeMountLines('bounded-layers', mounts, {
      expectedWorkdirMount: '/workspace',
      expectedStoreMount: '/var/tmp/devbox/store',
    })).toEqual([
      'journald /workspace fuse.journald rw 0 0',
      's3fs /var/tmp/devbox/store fuse.s3fs rw 0 0',
    ]);
    expect(retainWakeMountLines('r2fs', mounts)).toEqual(['journald /workspace fuse.journald rw 0 0']);
    expect(retainWakeMountLines('r2fs', mounts, {
      expectedWorkdirMount: '/nowhere',
      expectedStoreMount: '/nowhere-else',
    })).toEqual(['journald /workspace fuse.journald rw 0 0']);
  });
});

/** When a stub lane started or finished: the ORDER it happened in, which is
 *  what an overlap claim rests on, and the wall clock it happened at, which is
 *  what a reader of a failure wants to see. */
interface LaneStamp {
  readonly order: number;
  readonly ms: number;
}

/**
 * Yield the event loop `count` times, waiting no duration at all.
 *
 * A concurrent driver has already started the next arm by the time the first
 * of these resolves, so the wait ends immediately on evidence. A SEQUENTIAL
 * driver cannot start it inside them — nothing else is scheduled — so the wait
 * still ends, and the overlap assertion below fails on a recorded order rather
 * than on a test timeout.
 */
async function eventLoopTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

/**
 * A fake-armed driver: one stub lane per arm, each recording when it started
 * and when it finished.
 *
 * The stubs are the whole point. What is under test is the DRIVER's own
 * scheduling — whether two arms are in flight at once, and whether one arm's
 * throw can reach a sibling — and a real lane would answer that question only
 * by deploying five Workers.
 */
function recordingLanes(options: {
  readonly slow: Strategy;
  readonly fast: Strategy;
  /** Thrown by the slow lane once it has finished, or never. */
  readonly slowThrows?: string;
}) {
  const started: Record<string, LaneStamp> = {};
  const finished: Record<string, LaneStamp> = {};
  let order = 0;
  const stamp = (): LaneStamp => {
    order += 1;
    return { order, ms: Date.now() };
  };
  const fastStarted = Promise.withResolvers<void>();
  const lane = async (strategy: Strategy): Promise<ArmResult> => {
    started[strategy] = stamp();
    if (strategy === options.fast) {
      fastStarted.resolve();
      await Promise.resolve();
    } else {
      await Promise.race([fastStarted.promise, eventLoopTurns(20)]);
    }
    finished[strategy] = stamp();
    if (strategy === options.slow && options.slowThrows !== undefined) {
      throw new Error(options.slowThrows);
    }
    return measuredArm(strategy);
  };
  return { lane, started, finished };
}

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

/** Everything the driver wrote to stderr while `run` was in flight. `log`
 *  writes whole lines as strings, and anything a library writes instead is
 *  stringified rather than dropped. */
async function capturedStderr(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  const capture = (chunk: Uint8Array | string): boolean => {
    written.push(String(chunk));
    return true;
  };
  process.stderr.write = capture;
  try {
    await run();
  } finally {
    process.stderr.write = real;
  }
  return written.join('');
}

/** `/state` answers the same internal error forever; `/exec` never answers at
 *  all, which is what a readiness drive against a wedged box really does. */
function fixtureAnsweringInternalError() {
  const asked: string[] = [];
  const real = globalThis.fetch;
  const answer = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${url.pathname}`);
    if (url.pathname === '/exec') return await new Promise<Response>(() => {});
    return new Response(JSON.stringify({ error: 'internal error; reference = cc4po3dqdeu4t8g7a7fg5aps' }));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
  return { asked, restore: () => { globalThis.fetch = real; } };
}

describe('a startup whose state poll answers internal error forever refuses at the ceiling, not never', () => {
  /**
   * THE RED PROOF THE TICKET ASKS FOR, as a scripted fixture: `/state` answers
   * `internal error` on every poll — the reading the calibration run's
   * `bounded-layers` cold attach sat on for its whole 900,000 ms wall while the
   * unbounded kick loop below it re-kicked every 15 s and nothing named either
   * one. The pre-fix `pollForAttach` had no deadline and the pre-fix kick loop
   * none either, so this test HANGS against that seam (5 s test timeout) rather
   * than refusing; here the ceiling is the only thing that ends it, and the
   * refusal names the box's own words.
   */
  test('refuses at the caller\'s ceiling, naming the reading it kept getting', async () => {
    const fixture = fixtureAnsweringInternalError();
    try {
      const started = Date.now();
      await expect(pollForAttach(
        BENCH_FIXTURE, 'ab-bounded-layers-20260831233915', 'cold attach', ['attached'],
        { deadlineMs: 600 },
      )).rejects.toThrow(/cold attach did not attach within its 600 ms ceiling \(last reading: pending.*internal error/);
      // NOT A LOOP. A poll that merely kept asking would outlive any test
      // budget; refusing inside a small multiple of the ceiling is the whole
      // claim. One drive is in flight at most (the hanging /exec), and the
      // refusal names it rather than reporting it as the verdict.
      expect(Date.now() - started).toBeLessThan(5_000);
      // The poll kept ASKING throughout the window rather than blocking on one
      // request: a ceiling that fires over a single unanswered call would prove
      // nothing about the loop.
      expect(fixture.asked.filter((call) => call === 'GET /state').length).toBeGreaterThan(1);
    } finally {
      fixture.restore();
    }
  });

  /**
   * The kick loop's half of the same defect, same run: a `/create` that keeps
   * answering transient capacity re-kicked forever, unbounded by the caller's
   * window. `startupOperation` with a ceiling must refuse naming the last kick.
   */
  test('the capacity kick loop honours the ceiling and names the last kick', async () => {
    const asked: string[] = [];
    const real = globalThis.fetch;
    const answer = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      asked.push(`${method} ${url.pathname}`);
      return new Response(JSON.stringify({
        ok: false,
        error: 'no container instance is available right now, try again later',
      }));
    };
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    try {
      await expect(startupOperation(
        BENCH_FIXTURE, 'ab-bounded-layers-20260831233915', '/create', 'cold attach', ['attached'],
        { deadlineMs: 1 },
      )).rejects.toThrow(
        /was still being admitted at its 1 ms ceiling after 1 kick\(s\) \(last kick: no container instance is available right now, try again later\)/,
      );
      expect(asked).toEqual(['POST /create']);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('durable per-arm artifacts', () => {
  /** A temporary repo root with its own bench-artifacts, so a test never reads
   *  or writes a real run's directory. Minted through the repo's own scratch
   *  namespace, which is what preflight counts and reclaims. */
  const artifactRoot = (): string => scratchDir('devbox-arm-artifacts');

  test('a row written the moment it settles reads back whole, atomically, with the log tail', () => {
    const root = artifactRoot();
    const row = measuredArm('snapshot-chain');
    row.attachColdMs = 1_968;
    resetArmLogs();
    const artifact = writeArmArtifact(root, 'redprobe1', 'snapshot-chain', row);
    // No `.tmp` residue: a kill between write and rename must never leave a
    // partial file a reader could mistake for the arm's answer.
    expect(existsSync(join(root, 'bench-artifacts', 'redprobe1', 'snapshot-chain.json.tmp'))).toBe(false);
    const read = readArmArtifact(root, 'redprobe1', 'snapshot-chain');
    expect(read.error).toBeNull();
    expect(read.artifact?.schema).toBe('devbox-arm-artifact/1');
    expect(read.artifact?.row).toEqual(row);
    expect(artifact.settledAt.length).toBeGreaterThan(0);
    // An arm that never ran reads as absent, not as a read failure.
    expect(readArmArtifact(root, 'redprobe1', 'merkle-pack')).toEqual({ artifact: null, error: null });
  });

  test('a corrupted artifact is a named finding, never a silent absence', () => {
    const root = artifactRoot();
    mkdirSync(join(root, 'bench-artifacts', 'redprobe2'), { recursive: true });
    writeFileSync(
      join(root, 'bench-artifacts', 'redprobe2', 'r2fs.json'),
      '{not json',
    );
    const read = readArmArtifact(root, 'redprobe2', 'r2fs');
    expect(read.artifact).toBeNull();
    expect(read.error).toContain('unreadable');
    expect(read.error).toContain('r2fs.json');
  });

  /**
   * THE KILLED-DRIVER RED PROOF, as a scripted fixture. Two arms settle —
   * cold attach + ladder + wake recorded — and the third is killed mid-flight:
   * no artifact exists for it. What survives on disk must be exactly the two
   * settled arms' measurements, readable by a process that never watched them
   * settle, and the run-level assembly records the third as externally-aborted
   * carrying its log tail rather than as an unmeasured row.
   */
  test('a driver killed after two arms settled leaves those two arms readable and the third externally-aborted', async () => {
    const root = artifactRoot();
    const runId = 'killedprobe';
    // Arm one: measured through the wake.
    const one = measuredArm('snapshot-chain');
    one.attachColdMs = 1_968;
    one.wakeMs = 5_854;
    // Arm two: measured through the ladder only.
    const two = measuredArm('r2fs');
    two.attachColdMs = 2_210;
    two.wakeMs = null;
    writeArmArtifact(root, runId, 'snapshot-chain', one);
    writeArmArtifact(root, runId, 'r2fs', two);

    // The killed third arm left log lines but no artifact — the wedge killed the
    // process mid-poll. Its last words are the tail it never got to write, and
    // they are what the run-level row carries in their place. The lines come
    // from the DRIVER's own poll, not from a stub: a tail assembled by the test
    // would prove nothing about what a live arm records.
    resetArmLogs();
    const killed = await underArmLog('overlay-cas', async () => {
      const wedged = fixtureAnsweringInternalError();
      try {
        // The refusal is the POINT: this is the arm dying at its ceiling, and
        // the lines it logged getting there are what the tail must carry.
        await expect(pollForAttach(
          BENCH_FIXTURE, `ab-overlay-cas-${runId}`, 'wake', ['attached'], { deadlineMs: 400 },
        )).rejects.toThrow(/wake did not attach within its 400 ms ceiling/);
      } finally {
        wedged.restore();
      }
      return externallyAbortedArm(
        'overlay-cas',
        `ab-overlay-cas-${runId}`,
        'the run was killed while this arm was still measuring',
      );
    });
    // The driver really did record those lines against THIS arm.
    expect(armLogTail('overlay-cas').some((line) => line.includes('internal error'))).toBe(true);

    // WHAT SURVIVED IS READABLE, from a process that never watched it settle.
    const first = readArmArtifact(root, runId, 'snapshot-chain');
    const second = readArmArtifact(root, runId, 'r2fs');
    expect(first.artifact?.row).toEqual(one);
    expect(first.artifact?.row.attachColdMs).toBe(1_968);
    expect(first.artifact?.row.wakeMs).toBe(5_854);
    expect(second.artifact?.row).toEqual(two);
    expect(second.artifact?.row.wakeMs).toBeNull();

    // AND THE UNSETTLED ARM IS NOT LOST AS NULLS. The row the assembly records
    // for it names the abort, fails verification, and ranks nothing.
    expect(killed.notes.at(-1)).toBe('externally-aborted: the run was killed while this arm was still measuring');
    // THE LOG TAIL RIDES ALONG. Without it the row says an arm vanished and
    // nothing about what it was doing when it did.
    expect(killed.notes.some((note) => note.startsWith('log: ') && note.includes('internal error'))).toBe(true);
    expect(killed.verifyPassed).toBe(false);
    expect(killed.attachColdMs).toBeNull();
    expect(killed.wakeMs).toBeNull();
    expect(killed.checkpoints).toEqual([]);
    expect(killed.verifyChecks.some((check) =>
      check.pass === false && check.detail.includes('externally-aborted'))).toBe(true);
    expect(rankableTicks([killed], killed.decisiveTicks)).toEqual([]);
    expect(readArmArtifact(root, runId, 'overlay-cas')).toEqual({ artifact: null, error: null });
  });

  test('an arm artifact written after a refusal keeps the reason with what was measured', () => {
    const root = artifactRoot();
    const row = measuredArm('merkle-pack');
    row.attachColdMs = 15_721;
    row.wakeMs = null;
    const refused = refuseFailedArm(row, 'arm failed mid-measurement: wake refused: [abandoned -> refuse] Devbox.attach exceeded its 300000ms budget');
    writeArmArtifact(root, 'refuseprobe', 'merkle-pack', refused);
    const read = readArmArtifact(root, 'refuseprobe', 'merkle-pack');
    expect(read.artifact?.row.attachColdMs).toBe(15_721);
    expect(read.artifact?.row.verifyPassed).toBe(false);
    expect(read.artifact?.row.notes.join(' ')).toContain('arm failed mid-measurement');
  });
});

describe('the arms are measured in flight together', () => {
  test('a later arm starts before an earlier one has finished', async () => {
    const lanes = recordingLanes({ slow: 'snapshot-chain', fast: 'r2fs' });

    const rows = await runArmsInFlight(['snapshot-chain', 'r2fs'], 'overlap-probe', lanes.lane);

    // THE OVERLAP ITSELF. Sequentially the second arm cannot start until the
    // first has returned, so this comparison is the difference between the two
    // shapes rather than a restatement of the call order.
    const slowFinished = lanes.finished['snapshot-chain'];
    const fastStarted = lanes.started['r2fs'];
    expect(slowFinished).toBeDefined();
    expect(fastStarted).toBeDefined();
    expect(fastStarted?.order ?? Infinity).toBeLessThan(slowFinished?.order ?? 0);
    expect(fastStarted?.ms ?? Infinity).toBeLessThanOrEqual(slowFinished?.ms ?? 0);

    // AND THE ROWS COME BACK IN THE ORDER THE ARMS WERE ASKED FOR, because the
    // report, the admission record and the decision pair all read them by
    // position as well as by name.
    expect(rows.map((row) => row.strategy)).toEqual(['snapshot-chain', 'r2fs']);
  }, 20_000);

  test('one arm throwing keeps its sibling and classifies only itself', async () => {
    const refusal = 'no container instance is available for this arm';
    const lanes = recordingLanes({ slow: 'snapshot-chain', fast: 'r2fs', slowThrows: refusal });

    let rows: ArmResult[] = [];
    const stderr = await capturedStderr(async () => {
      rows = await runArmsInFlight(['snapshot-chain', 'r2fs'], 'isolation-probe', lanes.lane);
    });

    // THE SIBLING SURVIVED. A rejected lane used to take the whole run with it:
    // every arm behind the thrown one was never measured and never reported.
    const sibling = rows.find((row) => row.strategy === 'r2fs');
    expect(sibling?.verifyPassed).toBe(true);
    expect(sibling?.attachColdMs).toBe(1_200);

    // AND THE THROWN ARM IS A CLASSIFIED FAILURE, not a hole: a row that ranks
    // nothing, carrying the reason in both places a reader looks.
    const refused = rows.find((row) => row.strategy === 'snapshot-chain');
    expect(refused?.verifyPassed).toBe(false);
    expect(refused?.box).toBe('ab-snapshot-chain-isolation-probe');
    expect(refused?.notes.join(' ')).toContain(refusal);
    expect(refused?.verifyChecks.some((check) => !check.pass && check.detail.includes(refusal))).toBe(true);
    expect(rankableTicks(rows, rows.flatMap((row) => row.decisiveTicks))).toEqual([]);

    // AND THE LINE THAT REPORTED IT NAMES THE ARM IT BELONGS TO. Interleaved
    // output is unreadable — and unusable as evidence — without it.
    expect(stderr).toContain('[devbox-bench:snapshot-chain]');
  }, 20_000);
});

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
  unboundedPendingReplay: { smallPending: 50, smallReplayed: 50, largePending: 500, largeReplayed: 500 },
  upperScan: { smallEntries: 210, smallMs: 900, largeEntries: 2_010, largeMs: 7_400 },
  openWriteLoss: { wroteBytes: 41, survivedBytes: null },
  nonAtomicRename: { fileBytes: 1_048_576, storeOps: 3, sourcePresent: false, destinationBytes: 1_048_576 },
  posixGap: { syncedKeyPresent: false, key: 'boxes/probe/witness-open-write.bin' },
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

const witnessNames = (checks: readonly { name: string; observed: boolean }[]): string[] =>
  checks.filter((check) => check.observed).map((check) => check.name);

describe('the preregistered witness cells', () => {
  test('every preregistered witness is answered, by name and in order', () => {
    expect(controlWitnessChecks('snapshot-chain', WITNESSED).map((check) => check.name))
      .toEqual(['mutable-delta', 'delta-layer-collapse']);
    expect(controlWitnessChecks('overlay-cas', WITNESSED).map((check) => check.name))
      .toEqual(['unbounded-pending-replay', 'O(u)-scan']);
    expect(controlWitnessChecks('r2fs', WITNESSED).map((check) => check.name))
      .toEqual(['open-write-loss', 'non-atomic-rename', 'POSIX-gap']);
    // An arm that preregistered nothing answers nothing. That is a statement
    // about what its strategy is known to do wrong, not about whether it may
    // win: `devboxArmEvidence` ranks every arm either way.
    expect(controlWitnessChecks('bounded-layers', WITNESSED)).toEqual([]);
    expect(controlWitnessChecks('merkle-pack', WITNESSED)).toEqual([]);
  });

  test('facts in which the defects showed up observe every witness', () => {
    expect(witnessNames(controlWitnessChecks('snapshot-chain', WITNESSED)))
      .toEqual(['mutable-delta', 'delta-layer-collapse']);
    expect(witnessNames(controlWitnessChecks('overlay-cas', WITNESSED)))
      .toEqual(['unbounded-pending-replay', 'O(u)-scan']);
    expect(witnessNames(controlWitnessChecks('r2fs', WITNESSED)))
      .toEqual(['open-write-loss', 'non-atomic-rename', 'POSIX-gap']);
  });

  test('a cell that never ran witnesses nothing, and says so', () => {
    const checks = controlWitnessChecks('r2fs', {});
    expect(witnessNames(checks)).toEqual([]);
    expect(checks.every((check) => check.detail.includes('produced no observation'))).toBe(true);
  });

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

  test('a replay capped at a constant is a BOUNDED restore, so the witness vanishes', () => {
    const [replay] = controlWitnessChecks('overlay-cas', {
      ...WITNESSED,
      unboundedPendingReplay: { smallPending: 50, smallReplayed: 8, largePending: 500, largeReplayed: 8 },
    });
    expect(replay?.observed).toBe(false);
    expect(replay?.detail).toContain('did NOT follow the pending set');
  });

  test('a tick whose cost does not follow the layer is not an O(u) scan', () => {
    const [, scan] = controlWitnessChecks('overlay-cas', {
      ...WITNESSED,
      upperScan: { smallEntries: 210, smallMs: 900, largeEntries: 2_010, largeMs: 950 },
    });
    expect(scan?.observed).toBe(false);
    expect(scan?.detail).toContain('cost did NOT grow');
  });

  test('bytes that survived an open handle across the stop end the loss witness', () => {
    const [loss] = controlWitnessChecks('r2fs', {
      ...WITNESSED,
      openWriteLoss: { wroteBytes: 41, survivedBytes: 41 },
    });
    expect(loss?.observed).toBe(false);
    expect(loss?.detail).toContain('41B survived');
  });

  test('a rename costing the store nothing is atomic, and refuses as drift', () => {
    const [, rename] = controlWitnessChecks('r2fs', {
      ...WITNESSED,
      nonAtomicRename: { fileBytes: 1_048_576, storeOps: 0, sourcePresent: false, destinationBytes: 1_048_576 },
    });
    expect(rename?.observed).toBe(false);
  });

  test('a store that holds a synced open file means a flush primitive exists', () => {
    const [, , gap] = controlWitnessChecks('r2fs', {
      ...WITNESSED,
      posixGap: { syncedKeyPresent: true, key: 'boxes/probe/witness-open-write.bin' },
    });
    expect(gap?.observed).toBe(false);
    expect(gap?.detail).toContain('a flush-to-store primitive exists');
  });

  test('an arm carrying observed witnesses publishes them as its red checks', () => {
    const evidence = devboxArmEvidence({
      strategy: 'r2fs',
      verifyPassed: true,
      verifyChecks: [],
      phases: [],
      checkpoints: [],
      decisiveTicks: [],
      witnessChecks: controlWitnessChecks('r2fs', WITNESSED),
    });
    expect(evidence.expectedRedChecks).toEqual(['open-write-loss', 'non-atomic-rename', 'POSIX-gap']);
    expect(evidence.observedRedChecks).toEqual(['open-write-loss', 'non-atomic-rename', 'POSIX-gap']);
  });

  test('the frozen scope ranks while retired arms retain their witnesses', () => {
    for (const strategy of STRATEGIES) {
      const evidence = devboxArmEvidence({
        strategy,
        verifyPassed: true,
        verifyChecks: [],
        phases: [],
        checkpoints: [],
        decisiveTicks: [],
        witnessChecks: controlWitnessChecks(strategy, WITNESSED),
      });

      expect(evidence.kind).toBe('candidate');
      expect(evidence.rankEligible).toBe(strategy === 'snapshot-chain' || strategy === 'bounded-layers' || strategy === 'merkle-pack');
      // And the preregistration still binds: an arm that promised witnesses
      // still has to produce exactly those, which is what makes the cost real.
      expect(evidence.expectedRedChecks).toEqual(evidence.observedRedChecks);
    }
  });

  test('a retired arm retains a missing-witness finding', () => {
    const drifted = devboxArmEvidence({
      strategy: 'overlay-cas',
      verifyPassed: true,
      verifyChecks: [],
      phases: [],
      checkpoints: [],
      decisiveTicks: [],
      witnessChecks: controlWitnessChecks('overlay-cas', {
        ...WITNESSED,
        unboundedPendingReplay: { smallPending: 50, smallReplayed: 8, largePending: 500, largeReplayed: 8 },
      }),
    });

    expect(drifted.rankEligible).toBe(false);
    expect(drifted.expectedRedChecks).toContain('unbounded-pending-replay');
    expect(drifted.observedRedChecks).not.toContain('unbounded-pending-replay');
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
      quiescesBeforeDecisive: 0,
      generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
      ops: null, teardown: null, witnessChecks: [], notes: [],
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
      repetitions: 1,
      meta: {
        date: '2026-08-28', run: 'blank-run', worker: 'blank-fixture', bucket: 'blank-bucket',
        image: SANDBOX_IMAGE, seed: '1', 'loop budget ms': '1', 'deciding repetitions': '1',
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
const MONEY_LANGUAGE = /\$|usd|price|pricing|priced|cost|billing|billed|dollar/i;

describe('the recommendation ranks the frozen scope', () => {
  const ADMITTED = { admitted: true, gates: [] };
  /** One arm with the fields `recommend` reads and nothing else. */
  const rankArm = (
    strategy: Strategy,
    ms: { git: number; npm: number },
    witnesses: readonly string[] = [],
  ): ArmResult => ({
    strategy,
    box: `box-${strategy}`,
    verifyPassed: true,
    verifyChecks: [],
    attachColdMs: null, attachColdKind: '', attachColdBootId: null,
    attachWarmMs: null, attachWarmKind: '', wakeBootId: null, attachWarmBootId: null,
    checkpoints: [], stopMs: null, wakeMs: null, wakeKind: 'attached',
    phases: [],
    decisiveTicks: [tick(strategy, 'git', ms.git), tick(strategy, 'npm', ms.npm)],
    quiescesBeforeDecisive: 0,
    generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
    ops: null, teardown: null,
    witnessChecks: witnesses.map((name) => ({ name, observed: true, detail: 'observed' })),
    notes: [],
  });

  test('frozen arms rank by decisive tick time while retired arms stay excluded', () => {
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      rankArm('r2fs', { git: 900, npm: 380 }, ['open-write-loss', 'POSIX-gap']),
      rankArm('overlay-cas', { git: 300, npm: 200 }),
      rankArm('bounded-layers', { git: 100, npm: 100 }),
      rankArm('merkle-pack', { git: 150, npm: 120 }),
    ], ADMITTED);

    for (const strategy of DECISIVE_ARMS) expect(report).toContain(`\`${strategy}\``);
    const order = STRATEGIES
      .map((strategy) => ({ strategy, at: report.indexOf(`| \`${strategy}\``) }))
      .filter((row) => row.at !== -1)
      .sort((a, b) => a.at - b.at)
      .map((row) => row.strategy);
    expect(order).toEqual([
      'bounded-layers', 'merkle-pack', 'snapshot-chain',
    ]);
    expect(report).toContain(`\`${INCUMBENT}\` (incumbent)`);
  });

  test('a faster retired arm cannot displace the incumbent', () => {
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      rankArm('r2fs', { git: 20, npm: 20 }, ['open-write-loss', 'non-atomic-rename']),
      rankArm('overlay-cas', { git: 10, npm: 10 }),
    ], ADMITTED);
    expect(report).toContain('`snapshot-chain` STAYS DEFAULT');
    expect(report).not.toContain('DEFAULT TO `r2fs`');
    expect(report).not.toContain('DEFAULT TO `overlay-cas`');
  });

  test('ranking first does not displace the incumbent without clearing the bar', () => {
    // 2x on git and 1.3x on npm: faster, nowhere near the preregistered
    // 10x/3x bar. The ranking and the decision rule must not disagree.
    const report = recommend([
      rankArm('snapshot-chain', { git: 200, npm: 130 }),
      rankArm('merkle-pack', { git: 100, npm: 100 }),
    ], ADMITTED);

    expect(report).toContain('`snapshot-chain` STAYS DEFAULT');
    expect(report).toContain('`merkle-pack` has 1.6x lower decisive tick time');
    expect(report).not.toContain('DEFAULT TO `merkle-pack`');
  });

  test('a run without the incumbent ranks its arms but claims no default', () => {
    const report = recommend([
      rankArm('bounded-layers', { git: 100, npm: 100 }),
      rankArm('merkle-pack', { git: 300, npm: 300 }),
    ], ADMITTED);

    expect(report).toContain('`bounded-layers` RAN FASTEST HERE');
    expect(report).toContain(`the incumbent \`${INCUMBENT}\` is not in the ranking`);
    expect(report).not.toContain('DEFAULT TO');
  });

  test('an arm missing a decisive workload is named unranked, not silently dropped', () => {
    const partial = rankArm('bounded-layers', { git: 100, npm: 100 });
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      { ...partial, decisiveTicks: [tick('bounded-layers', 'git', 100)] },
    ], ADMITTED);

    expect(report).toContain('unranked: no ticks on npm');
    expect(report).toContain('`bounded-layers`');
  });

  test('the recommendation carries no money language', () => {
    // MONEY IS NOT A DECISION CRITERION for this benchmark, which incurs no
    // cost at all, so the recommendation ranks on measured time and
    // names observed defects — never a rate, a total or a currency.
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }, ['mutable-delta']),
      rankArm('bounded-layers', { git: 900, npm: 380 }),
    ], ADMITTED);

    expect(report).not.toMatch(MONEY_LANGUAGE);
    // And what it must still say: the ranked quantity and the defect column.
    expect(report).toContain('Σ decisive tick ms');
    expect(report).toContain('observed defects');
    expect(report).toContain('`mutable-delta`');
  });
});

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

  test('every section of the artifact is free of rates, totals and currency', () => {
    // THE ARTIFACT IS THE USER-FACING SURFACE, so the scan is over the WHOLE of
    // it — header, decisive table, decision rule, sqlite finding, lifecycle,
    // ladder, operations and the recommendation — rather than over the one
    // column the USD cell used to sit in. Red before the strip: the decisive
    // table's header carried `USD`, its rows `$0.000437`, and the intro
    // sentence quoted R2's published rates.
    const report = render(
      [reportArm('snapshot-chain'), reportArm('merkle-pack')],
      reportMeta,
      { admitted: true, gates: [] },
    );

    expect(report).not.toMatch(MONEY_LANGUAGE);
    expect(report).not.toContain('| USD |');
  });

  test('a REFUSED run says why with no money in the refusal either', () => {
    // The refusal path is the report a failed run actually publishes, and it
    // renders the admission reasons — so G7's own words are part of the
    // artifact. `unpriced` was one of them until this strip.
    const report = render(
      [reportArm('snapshot-chain')],
      reportMeta,
      devboxAdmission({
        arms: [{ ...reportArm('snapshot-chain'), ops: null }],
        requested: ['snapshot-chain'],
        repetitions: 2,
        meta: reportMeta,
        identity: {
          commit: '', dirtyDigest: 'clean', workerVersion: '', startedAt: '', finishedAt: '',
          image: SANDBOX_IMAGE, imageSha256: SANDBOX_IMAGE_DIGEST,
          dockerfileSha256: '', candidateRunnerSha256: '', overlayRunnerSha256: '',
          journalDaemonSha256: '',
        },
        token: 'devbox-test-token',
        cleanup: {
          attempted: true, kept: false, workerAbsent: false, runtimeAbsent: false,
          bucketAndMultipartEmpty: false, boxDurableStateEmpty: false, countersReconciled: false,
          replayIdempotent: false, localSecretsProcessesAbsent: false, multipartResidue: 1,
          errors: ['cleanup verification failed'],
        },
      }),
    );

    expect(report).toContain('G7');
    expect(report).toContain('operations are unaccounted');
    expect(report).not.toMatch(MONEY_LANGUAGE);
  });

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

  test('a decisive run prices only committed ticks, and says which segments it did not', async () => {
    // RED-FIRST for a decision skew: runDecisive pushed a TickRecord per
    // segment even on checkpoint error with wallMs -1, and the aggregates
    // summed it — a chain arm erroring every tick summed a negative numerator.
    // The first two of five segments fail here, the third commits without a
    // measured duration, and the last two commit whole.
    let checkpointArms = 0;
    const real = globalThis.fetch;
    const answer = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const url = new URL(String(input));
      const route = `${init?.method ?? 'GET'} ${url.pathname}`;
      if (route === 'POST /exec') {
        return new Response(JSON.stringify({
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            workload: 'npm',
            segments: [{ name: 's0', bytesWritten: 8, pathsTouched: 1, wallMs: 5 }],
            treeBytes: 100,
          }),
          stderr: '',
          ms: 3,
        }));
      }
      if (route === 'POST /checkpoint') {
        checkpointArms += 1;
        return new Response(
          JSON.stringify({ ok: true, token: `token-${String(checkpointArms)}`, state: 'pending' }),
          { status: 202 },
        );
      }
      if (route === 'GET /operation') {
        if (checkpointArms <= 2) {
          return new Response(JSON.stringify({ ok: true, state: 'done', ms: 50, outcome: { kind: 'failed' } }));
        }
        if (checkpointArms === 3) {
          return new Response(JSON.stringify({
            ok: true, state: 'done', outcome: { kind: 'committed', bytes: 100, movedBytes: 80 },
          }));
        }
        return new Response(JSON.stringify({
          ok: true, state: 'done', ms: 50, outcome: { kind: 'committed', bytes: 100, movedBytes: 80 },
        }));
      }
      if (route === 'GET /ops') {
        return new Response(JSON.stringify({ calls: {}, classA: 0, classB: 0, classFree: 0, total: 0 }));
      }
      return new Response(JSON.stringify({ ok: true, ms: 1 }));
    };
    globalThis.fetch = Object.assign(answer, { preconnect: real.preconnect });
    let run: { ticks: TickRecord[]; treeBytes: number; notes: string[] };
    try {
      // Five segments at the three-second checkpoint interval: ~15 s of honest
      // waiting, which is why this test owns its timeout.
      run = await runDecisive(
        BENCH_FIXTURE,
        'ab-snapshot-chain-probe',
        'snapshot-chain',
        { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
        1,
        1,
      );
    } finally {
      globalThis.fetch = real;
    }
    expect(run.ticks).toHaveLength(2);
    expect(run.ticks.every((tick) => tick.wallMs === 50)).toBe(true);
    expect(run.notes.filter((note) => note.includes('did not commit'))).toHaveLength(2);
    expect(run.notes.filter((note) => note.includes('without a measured duration'))).toHaveLength(1);
    expect(totalsFor(run.ticks, 'npm').sumWallMs).toBe(100);
    expect(run.treeBytes).toBe(100);
  }, 25_000);

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

describe('per-arm fixture deployment', () => {
  const template = readFileSync(join(import.meta.dir, '..', 'packages/devbox/bench/wrangler.jsonc'), 'utf8');
  const runId = '20260826003000';
  /** Typed by the driver's own parameter, so a strategy typo fails here. */
  interface FixtureCase {
    readonly arm: Parameters<typeof resourceNames>[1];
    readonly classes: readonly string[];
    readonly app: string;
  }
  const cases: readonly FixtureCase[] = [
    { arm: 'snapshot-chain', classes: ['SnapshotChainBox', 'BenchOpCounter'], app: 'snapshotchainbox' },
    { arm: 'r2fs', classes: ['R2fsBox', 'BenchOpCounter'], app: 'r2fsbox' },
    { arm: 'overlay-cas', classes: ['OverlayCasBox', 'BenchOpCounter'], app: 'overlaycasbox' },
    { arm: 'bounded-layers', classes: ['BoundedLayersBox', 'BenchOpCounter'], app: 'boundedlayersbox' },
    { arm: 'merkle-pack', classes: ['MerklePackBox', 'BenchOpCounter'], app: 'merklepackbox' },
  ];

  for (const { arm, classes, app } of cases) {
    test(`gives ${arm} its own Worker, bucket and container application`, () => {
      const resources = resourceNames(runId, arm);
      const config = JSON.parse(fixtureConfigForArms(template, resources, [arm], '/tmp/candidate.Dockerfile'));

      // THE ARM IS IN EVERY NAME. Concurrent arms that shared any of these three
      // would share a keyspace, a `/teardown` purge or an operation counter.
      expect(resources.worker).toBe(`kinu-devbox-bench-${runId}-${arm}`);
      expect(resources.bucket).toBe(resources.worker);
      expect(resources.containerApps).toEqual([`${resources.worker}-${app}`]);
      expect(config.name).toBe(resources.worker);
      expect(config.vars.BENCH_SELECTED_ARMS).toBe(arm);
      expect(config.r2_buckets.map((bucket: { bucket_name: string }) => bucket.bucket_name))
        .toEqual([resources.bucket]);
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

  test('no two arms are given the same Worker or the same bucket', () => {
    const everyArm = cases.map(({ arm }) => resourceNames(runId, arm));
    expect(new Set(everyArm.map((names) => names.worker)).size).toBe(cases.length);
    expect(new Set(everyArm.map((names) => names.bucket)).size).toBe(cases.length);
    expect(new Set(everyArm.flatMap((names) => names.containerApps)).size).toBe(cases.length);
  });

  test('drops a future migration whose classes are all pruned', () => {
    const synthetic = template.replace(
      '"migrations": [',
      '"migrations": [{ "tag": "future", "new_sqlite_classes": ["FutureBox"] },',
    );
    const config = JSON.parse(fixtureConfigForArms(
      synthetic,
      resourceNames(runId, 'bounded-layers'),
      ['bounded-layers'],
      '/tmp/candidate.Dockerfile',
    ));
    expect(config.migrations.some((migration: { tag: string }) => migration.tag === 'future')).toBe(false);
  });
});


describe('arm selection and frozen historical context', () => {
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

  test('the frozen scope is the default and controls retain retired strategies', () => {
    expect(parseOptions([]).arms).toEqual(['snapshot-chain', 'bounded-layers', 'merkle-pack']);
    for (const retired of ['r2fs', 'overlay-cas'] as const) {
      expect(() => parseOptions(['--decisive', '--arms', retired])).toThrow('red-structural cells 6.10');
      expect(parseOptions(['--verify-only', '--arms', retired]).arms).toEqual([retired]);
    }
    expect(parseOptions(['--arms', 'bounded-layers,merkle-pack']).arms)
      .toEqual(['bounded-layers', 'merkle-pack']);

    const options = parseOptions([
      '--arms', 'bounded-layers,merkle-pack',
      '--control', 'snapshot-chain=bench-artifacts/controls.json',
      '--control', 'r2fs=bench-artifacts/controls.json',
    ]);
    expect(options.controls).toEqual([
      { strategy: 'snapshot-chain', path: 'bench-artifacts/controls.json' },
      { strategy: 'r2fs', path: 'bench-artifacts/controls.json' },
    ]);
    expect(parseOptions([]).controls).toEqual([]);
    expect(() => parseOptions(['--arms', 'bounded-layers,bounded-layers'])).toThrow(
      '--arms repeats "bounded-layers"; each requested arm must appear exactly once',
    );
    expect(() => parseOptions(['--control', '--plan'])).toThrow(
      '--control requires <strategy>=<path>',
    );
    expect(() => parseOptions(['--control', 'snapshot-chain'])).toThrow(
      '--control requires <strategy>=<path>; got "snapshot-chain"',
    );
    // ANY strategy may be supplied frozen. "Frozen" says the numbers came from
    // a previous run, never that the arm is one of a set barred from winning,
    // so the arms this used to reject are exactly the ones it must accept.
    expect(parseOptions(['--control', 'bounded-layers=bench-artifacts/control.json']).controls)
      .toEqual([{ strategy: 'bounded-layers', path: 'bench-artifacts/control.json' }]);
    expect(() => parseOptions(['--control', 'not-a-strategy=bench-artifacts/control.json'])).toThrow(
      `--control strategy "not-a-strategy" is not a known strategy; known strategies: ${STRATEGIES.join(', ')}`,
    );
    expect(() => parseOptions([
      '--control', 'snapshot-chain=bench-artifacts/one.json',
      '--control', 'snapshot-chain=bench-artifacts/two.json',
    ])).toThrow('--control must not repeat strategy "snapshot-chain"');
  });

  test('plans the named arms and reports strategy-qualified control context', () => {
    // One owner per file: minted through the scratch namespace preflight counts
    // and reclaims, so nothing here has to remember to remove it.
    const path = join(scratchDir('devbox-control'), 'control.json');
    writeFileSync(path, multiArmArtifact);
    const plan = Bun.spawnSync(
      [
        'bun', 'scripts/bench-devbox-strategies.ts', '--arms', 'bounded-layers,merkle-pack', '--plan',
        '--control', `snapshot-chain=${path}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(plan.exitCode, plan.stderr.toString()).toBe(0);
    expect(plan.stdout.toString()).toContain('arms          bounded-layers, merkle-pack');
    expect(plan.stdout.toString()).toContain(`controls      snapshot-chain=${path}`);
  });

  test('a plan without --arms selects the frozen scope', () => {
    const plan = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--plan'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(plan.exitCode, plan.stderr.toString()).toBe(0);
    expect(plan.stdout.toString()).toContain(`arms          ${DECISIVE_ARMS.join(', ')}`);
  });

  test('documents strategy-qualified controls in CLI help', () => {
    const help = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--help'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(help.exitCode, help.stderr.toString()).toBe(0);
    expect(help.stdout.toString()).toContain('--control <strategy>=<path>');
    expect(help.stdout.toString()).toContain(STRATEGIES.join(', '));
    // The flag that named a privileged subset is gone, not merely unused.
    expect(help.stdout.toString()).not.toContain('--candidates-only');
  });

  test('--repetitions defaults to two under --decisive, one without, and refuses below one', () => {
    // G9 censors a deciding cell below two repetitions, and until now the
    // driver had no way to run one twice: every arm of run 20260902154130 was
    // censored for measuring the deciding metric once or not at all. The
    // decisive default is therefore the gate's own floor.
    expect(parseOptions(['--decisive']).repetitions).toBe(2);
    expect(parseOptions([]).repetitions).toBe(1);
    expect(parseOptions(['--decisive', '--repetitions', '3']).repetitions).toBe(3);
    expect(parseOptions(['--repetitions', '2']).repetitions).toBe(2);
    for (const refused of ['0', '-1', 'two', '1.5']) {
      expect(() => parseOptions(['--repetitions', refused]), refused)
        .toThrow('--repetitions must be a whole number of 1 or more');
    }
  });

  test('documents --repetitions in CLI help, with its default and the gate floor', () => {
    const help = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--help'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(help.exitCode, help.stderr.toString()).toBe(0);
    const text = help.stdout.toString();
    expect(text).toContain('--repetitions <n>');
    expect(text).toContain('Measure every deciding cell n times per arm');
    expect(text).toContain(DECIDING_METRIC);
    expect(text).toContain('Default 2 with --decisive, 1 without');
    expect(text).toContain('Refuses n < 1');
  });

  test('a run that verifies its own cleanup refuses without the two S3 keys', () => {
    // MEASURED: run 20260902154130 deployed, measured for thirteen minutes, and
    // then could not verify its teardown — the keys were absent the whole time
    // and nothing asked until the bucket probe threw. C1-C7 were written false
    // over a check that never ran, and one bucket survived the run.
    const refusal = r2CleanupKeyRefusal({
      verifiesCleanup: true, accessKeyIdPresent: false, secretAccessKeyPresent: false,
    });
    expect(refusal).toContain('R2_ACCESS_KEY_ID');
    expect(refusal).toContain('R2_SECRET_ACCESS_KEY');
    // NAMED WHERE THEY LIVE, because "absent" is not an actionable refusal.
    expect(refusal).toContain(R2_CLEANUP_KEY_FILE);
    expect(refusal).toContain('Nothing has been created.');

    // ONE MISSING KEY IS STILL A REFUSAL, and it names the one that is missing.
    const halfArmed = r2CleanupKeyRefusal({
      verifiesCleanup: true, accessKeyIdPresent: true, secretAccessKeyPresent: false,
    });
    expect(halfArmed).toContain('R2_SECRET_ACCESS_KEY is absent');

    // AND THE TWO WAYS A RUN NEEDS NOTHING: both keys present, or a --keep run,
    // which deletes nothing and therefore verifies nothing.
    expect(r2CleanupKeyRefusal({
      verifiesCleanup: true, accessKeyIdPresent: true, secretAccessKeyPresent: true,
    })).toBeNull();
    expect(r2CleanupKeyRefusal({
      verifiesCleanup: false, accessKeyIdPresent: false, secretAccessKeyPresent: false,
    })).toBeNull();
  });

  test('the keyless refusal lands before the driver creates anything', () => {
    // The teardown manifest is the FIRST thing a run creates — before the
    // config directory and long before a deploy — so its absence is the proof
    // that this refusal preceded every resource.
    const tree = dirname(dirname(new URL(import.meta.url).pathname));
    const manifests = (): string[] => {
      const dir = dirname(manifestPath(tree, 'probe'));
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    };
    const before = manifests();
    // THE CHILD IS FENCED, because a regression in the refusal really does
    // reach resource creation: measured 2026-09-02, the driver one commit
    // earlier ran the recovery sweep and then `wrangler r2 bucket create` with
    // no keys in its environment. So this child gets an unusable token and an
    // empty wrangler config home, which stops it at the authentication gate —
    // one line the assertions below tell apart from the refusal under test.
    const scrubbed = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env)
          .filter(([name, value]) => value !== undefined && !scrubbed.includes(name))
          .map(([name, value]) => [name, String(value)]),
      ),
      CLOUDFLARE_API_TOKEN: 'refused-by-this-test',
      HOME: scratchDir('devbox-keyless'),
      XDG_CONFIG_HOME: scratchDir('devbox-keyless-config'),
    };

    const run = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--arms', 'snapshot-chain'],
      { stdout: 'pipe', stderr: 'pipe', env },
    );

    const stderr = run.stderr.toString();
    expect(run.exitCode, stderr).toBe(1);
    expect(stderr).toContain('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are absent');
    expect(stderr).toContain(R2_CLEANUP_KEY_FILE);
    // It refused at the preflight, not at the authentication check behind it,
    // and it swept nothing on the way out.
    expect(stderr).not.toContain('wrangler is not authenticated');
    expect(stderr).not.toContain('abandoned benchmark resources');
    expect(manifests()).toEqual(before);
  }, 30_000);

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
    // A frozen row is context because it came from ANOTHER run, never because
    // its arm belongs to a set barred from winning this one.
    expect(report).toContain('They come from a PREVIOUS run');
    expect(report).toContain('uses only arms this run measured');
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
  /** Whether the transport RELEASED the socket, not merely rejected its own
   *  promise: an elapsed bound that leaves the request open bounds nothing. */
  destroyed = false;

  end(body: string): void {
    this.body = body;
    this.onEnd?.(body);
  }

  destroy(error?: Error): void {
    this.destroyed = true;
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

  /**
   * MEASURED: the calibration run devbox-e2e-e2ecal0901002202 spent a 900,000 ms
   * teardown ceiling on `r2fs` and another on `overlay-cas`, and probe
   * wakeprobe09010702 reproduced it against a box wedged in its own attach
   * loop. The reply-size bound this transport already had says nothing about a
   * box that never answers, so a caller with a ceiling supplies an elapsed one
   * and the second idempotent pass is the retry.
   */
  test('a purge that never answers is abandoned at the bound its caller supplied', async () => {
    const request = new DeferredVerifyRequest();
    const teardown = postLiveTeardown(
      { origin: 'https://fixture.invalid', token: 'memory-only-token' },
      'ab-r2fs-e2ecal0901002202',
      () => request,
      25,
    );

    await expect(teardown).rejects.toThrow(/\/teardown did not answer inside 25 ms/);
    expect(request.destroyed).toBe(true);
  });
});

describe('every challenger is compared against the incumbent', () => {
  const challengers = (arms: readonly { strategy: string }[]): string[] => {
    const comparison = comparablePairs(arms);
    return comparison.kind === 'pairs' ? comparison.pairs.map((pair) => pair.candidate) : [];
  };

  test('a full run takes one ratio per challenger, incumbent on every baseline', () => {
    const comparison = comparablePairs(STRATEGIES.map((strategy) => ({ strategy })));

    expect(comparison.kind).toBe('pairs');
    expect(challengers(STRATEGIES.map((strategy) => ({ strategy })))).toEqual([
      'bounded-layers', 'merkle-pack',
    ]);
    expect(comparison.kind === 'pairs' ? comparison.pairs.every((pair) => pair.baseline === INCUMBENT) : false)
      .toBe(true);
  });

  test('retired arms create no decisive ratio', () => {
    expect(challengers([{ strategy: 'snapshot-chain' }, { strategy: 'r2fs' }, { strategy: 'overlay-cas' }])).toEqual([]);
  });

  test('a challenger-only run yields no ratio, and says the incumbent is missing', () => {
    // THE SHAPE OF THE FINAL STAGING RUN. Two arms deployed, and the report
    // nonetheless printed a decision rule whose ratio was taken over
    // `snapshot-chain` and `overlay-cas`, arms whose durable-object bindings
    // the generated fixture config omits entirely. The guard was
    // `STRATEGIES.find((id) => id === 'overlay-cas') !== undefined` over a
    // frozen constant, so it was true on every run ever made.
    const comparison = comparablePairs([{ strategy: 'bounded-layers' }, { strategy: 'merkle-pack' }]);

    expect(comparison.kind).toBe('absent');
    expect(comparison.kind === 'absent' ? comparison.reason : '').toContain('`bounded-layers`');
    expect(comparison.kind === 'absent' ? comparison.reason : '').toContain(`\`${INCUMBENT}\` is not among them`);
  });

  test('the incumbent alone carries no challenger to compare against', () => {
    const comparison = comparablePairs([{ strategy: INCUMBENT }]);

    expect(comparison.kind).toBe('absent');
    expect(comparison.kind === 'absent' ? comparison.reason : '').toContain('no challenger');
  });

  test('a run of no arms names no pair rather than a default one', () => {
    expect(comparablePairs([]).kind).toBe('absent');
  });

  test('two challengers without the incumbent cannot borrow each other as a baseline', () => {
    // The predecessor's leading pair was `bounded-layers` vs `merkle-pack`,
    // which decides which challenger is better while never asking whether
    // either beats what production runs.
    expect(comparablePairs([{ strategy: 'r2fs' }, { strategy: 'merkle-pack' }]).kind).toBe('absent');
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
      journalReady: true,
      journalReadyDetail: '{"ok":true,"sequence":7}',
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

  test('the probe precondition requires an answering journal, not its artifacts', () => {
    const ready = candidateProbePrecondition(candidateFacts());
    expect(ready.pass).toBe(true);
    expect(ready.name).toBe('the mutation journal answers before the ladder');

    // Every old proxy for readiness remains healthy: mounted FUSE, socket
    // path, process argv. Only the read-only stats request did not answer.
    const absent = candidateProbePrecondition(candidateFacts({ container: {
      journalReady: false,
      journalReadyDetail: 'connect ECONNREFUSED',
    } }));
    expect(absent.pass).toBe(false);
    expect(absent.detail).toBe('connect ECONNREFUSED');

    const unobserved = candidateProbePrecondition(candidateFacts({ container: {
      journalReady: undefined,
      journalReadyDetail: undefined,
    } }));
    expect(unobserved.pass).toBe(false);
    expect(unobserved.detail).toBe('journalReady=unreported');
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
      source.indexOf("} else if (mode === 'chain') {"),
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

describe('the run records what it will own before it owns anything', () => {
  /** The root `createFixtureResources` writes its manifest under, resolved the
   *  same way the driver resolves it. */
  const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));

  test('the planned manifest names every resource, derived from the run id alone', () => {
    // NOTHING HERE NEEDS A RESOURCE TO EXIST. That is what makes it writable
    // first: every name is a function of the run id and the arms.
    const manifest = plannedTeardownManifest('20260901090909', ['snapshot-chain', 'r2fs'], '/tmp/build-dir');

    expect(manifest.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'worker:kinu-devbox-bench-20260901090909-snapshot-chain',
      'container-app:kinu-devbox-bench-20260901090909-snapshot-chain-snapshotchainbox',
      'r2-bucket:kinu-devbox-bench-20260901090909-snapshot-chain',
      'do-state:ab-snapshot-chain-20260901090909',
      'alarm:ab-snapshot-chain-20260901090909',
      'mount:ab-snapshot-chain-20260901090909',
      'worker:kinu-devbox-bench-20260901090909-r2fs',
      'container-app:kinu-devbox-bench-20260901090909-r2fs-r2fsbox',
      'r2-bucket:kinu-devbox-bench-20260901090909-r2fs',
      'do-state:ab-r2fs-20260901090909',
      'alarm:ab-r2fs-20260901090909',
      'mount:ab-r2fs-20260901090909',
      'local-path:/tmp/build-dir',
    ]);
    expect(manifest.entries.every((entry) => !entry.done)).toBe(true);
    // The box rows agree with the box the run actually raises, because both
    // come from `boxName` rather than from two copies of one format string.
    for (const strategy of ['snapshot-chain', 'r2fs'] as const) {
      expect(manifest.entries.some((entry) => entry.name === boxName('20260901090909', strategy))).toBe(true);
    }
  });

  test('a driver that dies building its fixtures still leaves a complete manifest', async () => {
    // THE WINDOW THIS CLOSES. The manifest used to be built by `main` from the
    // fixtures `createFixtureResources` RETURNS, so between "the resource names
    // are decided" and "the list is durable" sat two bundle builds, a
    // Dockerfile render and a config write per arm. A driver killed in there —
    // or one that threw, as here — left a run id nothing had recorded.
    //
    // Forced by pre-creating a FILE where the build directory belongs, so the
    // `mkdirSync` on the line after the manifest write fails with EEXIST.
    const runId = 'unittest20260901';
    const buildDir = join(tmpdir(), `kinu-devbox-bench-${runId}`);
    const manifestFile = manifestPath(repoRoot, runId);
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(manifestFile, { force: true });
    writeFileSync(buildDir, 'not a directory');
    try {
      await expect(createFixtureResources(runId, ['r2fs'])).rejects.toThrow();

      const manifest = loadManifest(repoRoot, runId);
      expect(manifest).not.toBeNull();
      expect(manifest?.entries.map((entry) => entry.kind)).toEqual([
        'worker', 'container-app', 'r2-bucket', 'do-state', 'alarm', 'mount', 'local-path',
      ]);
      // Including the build directory, which is named before it is created.
      expect(manifest?.entries.at(-1)?.name).toBe(buildDir);
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
      rmSync(manifestFile, { force: true });
    }
  });
});

describe('the candidate image build context', () => {
  const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));
  const daemonDir = join(repoRoot, 'packages/devbox/bench/journal-daemon');
  /** One build directory to stage into, pre-seeded with the two bundle files
   * the driver writes before staging runs. */
  const stagedContext = () => {
    const dir = scratchDir('devbox-candidate-context');
    writeFileSync(join(dir, 'candidate-runner.bundle.mjs'), '/* bundle */');
    writeFileSync(join(dir, 'overlay-cas-runner.bundle.mjs'), '/* bundle */');
    return { dir, dockerfile: candidateImageDockerfile() };
  };

  test('carries every file the generated Dockerfile COPYs out of it', () => {
    // MEASURED DEFECT THIS FORBIDS. Run 20260903131640 deployed `snapshot-chain`
    // and `r2fs` and refused `overlay-cas`, `bounded-layers` and `merkle-pack` —
    // exactly the three arms whose class raises the candidate image — with
    // `Docker build exited with code: 1`. The build stopped at
    // `COPY journal-delta.h`: `failed to compute cache key: "/journal-delta.h":
    // not found`. The daemon recipe is re-used verbatim as the builder stage and
    // COPYs three sources; staging wrote one, because the daemon was split into
    // `journal-daemon.c` plus `journal-delta.c`/`.h` and a hardcoded copy list
    // did not follow the recipe that names them.
    const { dir, dockerfile } = stagedContext();
    try {
      stageImageContext({
        dir,
        dockerfile,
        written: ['candidate-runner.bundle.mjs', 'overlay-cas-runner.bundle.mjs'],
        sourceDir: daemonDir,
      });

      // The split daemon's three translation units are inputs of this image, so
      // the recipe names them and the context holds them.
      expect(contextCopySources(dockerfile)).toEqual(expect.arrayContaining([
        'journal-daemon.c', 'journal-delta.c', 'journal-delta.h',
      ]));
      for (const source of contextCopySources(dockerfile)) {
        expect(existsSync(join(dir, source))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stage copy is not demanded from the context', () => {
    // `COPY --from=<stage>` reads an earlier build stage. Reading those as
    // context inputs would refuse every complete build, so the parser that
    // decides what to stage skips them — and still reads the flagless copies on
    // either side of one.
    expect(contextCopySources([
      'FROM base AS builder',
      'COPY daemon.c /src/daemon.c',
      'FROM base',
      'COPY --from=builder /usr/local/bin/daemon /usr/local/bin/daemon',
      'COPY runner.mjs /opt/runner.mjs',
    ].join('\n'))).toEqual(['daemon.c', 'runner.mjs']);
  });

  test('a recipe input the daemon directory does not hold refuses before any deploy', () => {
    // The other direction: a recipe naming a file nobody can stage refuses while
    // the run still owns nothing, rather than deploying a context `docker build`
    // rejects one arm at a time.
    const { dir } = stagedContext();
    const dockerfile = [
      'FROM base AS journal-daemon',
      'COPY journal-daemon.c /usr/local/src/kinu-journal-daemon.c',
      'COPY journal-nothing.c /usr/local/src/journal-nothing.c',
    ].join('\n');
    try {
      expect(() => stageImageContext({
        dir,
        dockerfile,
        written: [],
        sourceDir: daemonDir,
      })).toThrow(/journal-nothing\.c/);
      // And nothing was staged into the context behind the refusal.
      expect(existsSync(join(dir, 'journal-daemon.c'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the recorded daemon digest covers every source the image is built from', () => {
    // PROVENANCE. `journal-daemon-source` is one digest in the artifact's version
    // row, and it stood for `journal-daemon.c` alone while the image also
    // compiled `journal-delta.c` and its header — so two runs whose delta code
    // differed recorded the same provenance and could not be told apart.
    const { dir, dockerfile } = stagedContext();
    try {
      const staged = stageImageContext({
        dir,
        dockerfile,
        written: ['candidate-runner.bundle.mjs', 'overlay-cas-runner.bundle.mjs'],
        sourceDir: daemonDir,
      });
      // The canonicalization the driver commits to: name, byte length and bytes
      // per input in sorted order, so neither a rename nor a byte change nor a
      // boundary shift between two inputs can collide.
      const canonical = staged.daemonSources.slice().sort().map((name) => {
        const bytes = readFileSync(join(daemonDir, name), 'utf8');
        return `${name}\0${String(bytes.length)}\0${bytes}`;
      }).join('');

      expect(staged.journalDaemonSha256)
        .toBe(`sha256:${createHash('sha256').update(canonical).digest('hex')}`);
      // And it is NOT the single-source digest it used to be.
      expect(staged.journalDaemonSha256).not.toBe(
        `sha256:${createHash('sha256')
          .update(readFileSync(join(daemonDir, 'journal-daemon.c'), 'utf8')).digest('hex')}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an abandoned run is deleted from its names alone', () => {
  test('durable state refuses until the Worker that serves it is gone', async () => {
    // A recovered manifest carries no lane state, so the owning Worker is read
    // back out of the box name. A recovery that reported durable state deleted
    // while its Worker still ran would be reporting a fact it cannot know.
    const exec = orphanTeardownExecutor(null);
    const outcome = await exec({
      kind: 'do-state',
      name: boxName('20260901111111', 'overlay-cas'),
      detail: '', done: false, attempts: 0, lastError: null,
    });

    expect(outcome).toEqual({
      ok: false,
      error: 'Worker kinu-devbox-bench-20260901111111-overlay-cas must be deleted before its durable state',
    });
  });

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
// THE DEPLOYED DEFECT this pins. The overlay-cas arm of run 20260903140046
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

describe('the lifecycle proof names the paths the strategies export', () => {
  test('every layer path the proof restates is the constant its strategy declares', () => {
    // THE DRIVER RESTATES THESE ON PURPOSE — it reads a deployed container over
    // HTTP and imports nothing from the box it measures, and neither does this
    // test: the scripts project is not compiled with the Workers types those
    // sources need. So both sides are read as TEXT, which is exactly the
    // comparison that was missing while `cas-lower` drifted for three commits
    // and a healthy arm failed its proof for it.
    const driver = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
    const overlay = readFileSync(
      join(import.meta.dir, '..', 'packages', 'devbox', 'src', 'overlay-cas.ts'),
      'utf8',
    );
    const r2fs = readFileSync(join(import.meta.dir, '..', 'packages', 'devbox', 'src', 'r2fs.ts'), 'utf8');
    const RUNTIME = '/var/tmp/devbox';
    /** A `${DEVBOX_RUNTIME_DIR}/<leaf>` constant, as the strategy writes it. */
    const strategyLeaf = (source: string, name: string): string | undefined =>
      new RegExp(`${name} = \`\\$\\{DEVBOX_RUNTIME_DIR\\}([^\`]+)\``).exec(source)?.[1];
    const declared = (name: string): string | undefined =>
      new RegExp(`const ${name} = '([^']+)'`).exec(driver)?.[1];

    expect(declared('R2FS_CACHE_DIR')).toBe(`${RUNTIME}${strategyLeaf(r2fs, 'R2FS_CACHE_DIR') ?? '?'}`);
    expect(declared('CAS_UPPER_DIR')).toBe(`${RUNTIME}${strategyLeaf(overlay, 'CAS_UPPER_DIR') ?? '?'}`);
    expect(declared('CAS_STORE_MOUNT_DIR'))
      .toBe(`${RUNTIME}${strategyLeaf(overlay, 'CAS_STORE_MOUNT') ?? '?'}`);
    // THE PROPERTY THAT BROKE: the overlay's lower is INSIDE the store mount,
    // and both sides derive it from that mount rather than naming it apart.
    expect(overlay).toContain('CAS_TREE_MOUNT = `${CAS_STORE_MOUNT}/tree`');
    expect(driver).toContain('CAS_TREE_LOWER_DIR = `${CAS_STORE_MOUNT_DIR}/tree`');
  });

  test('the proof asks whether the STORE is mounted, never the lower itself', () => {
    // The overlay-cas layout has ONE mount; a lower inside it never appears in
    // /proc/mounts under its own path, so a check that demanded one could only
    // ever answer `no` — which is exactly what run 20260903140046 recorded.
    const source = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
    expect(source).toContain('CAS_TREE_LOWER_DIR,\n      CAS_STORE_MOUNT_DIR,');
    expect(source).not.toContain("'/var/tmp/devbox/cas-lower'");
  });
});

// ── every admission check admits what the product can answer ────────────────
//
// THE FAMILY THIS PINS. Three instrument defects reached deployed runs in one
// day, all the same shape — a check narrower than the thing it measures:
//   1. the lifecycle proof asking for a layer path the strategy had moved,
//   2. a fence reader demanding a manifest version the daemon no longer writes,
//   3. a startup step admitting only `attached` where the box legitimately
//      answered `already-attached`, which ended `r2fs` after it had completed
//      its cold attach, its ladder, its stop and its wake.
//
// The third cost a full arm of a decisive run, so the rule is asserted rather
// than remembered: a step may narrow what it admits ONLY with a stated reason,
// and the set it narrows from is the product's own.

describe('the driver admits every outcome the product can produce', () => {
  test('the restated attach kinds are the product\'s own list', () => {
    // The driver imports nothing from the box it measures, so it restates this
    // list — and this is what keeps the restatement true.
    const driver = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
    const storage = readFileSync(
      join(import.meta.dir, '..', 'packages', 'devbox', 'src', 'storage.ts'),
      'utf8',
    );
    const product = /ATTACH_OUTCOME_KINDS = \[([^\]]+)\]/.exec(storage)?.[1];
    const restated = /PRODUCT_ATTACH_KINDS = \[([^\]]+)\]/.exec(driver)?.[1];
    expect(product).toBeDefined();
    expect(restated).toBeDefined();
    const kinds = (list: string): string[] =>
      [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
    expect(kinds(restated ?? '')).toEqual(kinds(product ?? ''));
  });

  test('every startup step admits `already-attached`, and cold attach excludes nothing', () => {
    // Through the admission list G6 itself reads, so the poll and the gate
    // cannot narrow apart. `already-attached` is legitimate at every step: a
    // re-kicked create, a wake on an instance that never lost its mount, and
    // a warm attach, which by definition attaches an attached box.
    expect(admittedAttachKinds('cold attach')).toContain('already-attached');
    expect(admittedAttachKinds('wake')).toContain('already-attached');
    expect(admittedAttachKinds('warm attach')).toContain('already-attached');
    expect(admittedAttachKinds('cold attach')).toContain('empty');
  });

  test('the state reply decodes every restoration phase the product can report', () => {
    // CHECKED AND SOUND TODAY, pinned because the failure would be quiet: the
    // phase list is a valibot picklist inside StateReplySchema, so a phase the
    // product added and this driver did not know would fail the parse of EVERY
    // `/state` reply — and a poll that cannot decode a reply waits out its
    // deadline reporting nothing rather than naming the phase it did not know.
    const driver = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
    const devbox = readFileSync(
      join(import.meta.dir, '..', 'packages', 'devbox', 'src', 'devbox.ts'),
      'utf8',
    );
    const restated = /restoration: v\.optional\(\s*v\.picklist\(\[([^\]]+)\]/.exec(driver)?.[1];
    expect(restated).toBeDefined();
    const admitted = [...(restated ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
    // The product's phases are the `phase:` literals of its Restoration union.
    const produced = [...devbox.matchAll(/\{ readonly phase: '([^']+)'/g)].map((match) => match[1]!);
    expect(produced.length).toBeGreaterThan(0);
    for (const phase of new Set(produced)) expect(admitted).toContain(phase);
  });

  /** One admission input the two tests below share: a healthy arm G6 holds, so
   *  each test states only what it varies. */
  const meta = {
    date: '2026-09-04', run: 'kinu-devbox-bench-test', worker: 'w', bucket: 'b',
    image: SANDBOX_IMAGE, seed: '20260824', 'loop budget ms': '8000',
    'deciding repetitions': '2',
  };
  const identity = {
    commit: '6823779aa', dirtyDigest: 'clean', workerVersion: 'v',
    startedAt: '2026-09-04T00:00:00.000Z', finishedAt: '2026-09-04T01:00:00.000Z',
    image: SANDBOX_IMAGE, imageSha256: SANDBOX_IMAGE_DIGEST,
    dockerfileSha256: `sha256:${'a'.repeat(64)}`, candidateRunnerSha256: `sha256:${'b'.repeat(64)}`,
    overlayRunnerSha256: `sha256:${'c'.repeat(64)}`, journalDaemonSha256: `sha256:${'d'.repeat(64)}`,
  };
  const cleanup = {
    attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
    bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
    localSecretsProcessesAbsent: true, countersReconciled: true,
    replayIdempotent: true, multipartResidue: 0, errors: [],
  };
  const checkpoints = Array.from({ length: EXPECTED_LADDER_ROWS }, (_, index) => ({
    changeKiB: 64, kind: index % 2 === 0 ? 'quiesce' as const : 'tick' as const,
    ms: 10, bytes: 100, outcome: 'committed',
  }));
  const healthyArm = (overrides: Partial<ArmResult> = {}): ArmResult => ({
    strategy: 'snapshot-chain', box: 'box-snapshot-chain', verifyPassed: true, verifyChecks: [],
    attachColdMs: 1000, attachColdKind: 'attached', attachColdBootId: 'cold',
    attachWarmMs: 50, attachWarmKind: 'attached', wakeBootId: 'wake', attachWarmBootId: 'wake',
    checkpoints, stopMs: 100, wakeMs: 2000, wakeKind: 'attached',
    phases: [], decisiveTicks: [], quiescesBeforeDecisive: 0,
    generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
    ops: { total: 10 }, teardown: null, witnessChecks: [], notes: [],
    ...overrides,
  });
  const g6 = (arm: ArmResult): string => {
    const verdict = devboxAdmission({
      arms: [arm], requested: [arm.strategy], repetitions: 2, meta, identity, token: 't', cleanup,
    });
    return verdict.gates.find((row) => row.gate === 'G6')?.reasons.join(' | ') ?? '';
  };

  test('the completed cell accepts an unchanged-generation warm attach', () => {
    // Through G6, the gate that reads this clause: an `already-attached` warm
    // attach over equal boot ids holds, and a changed generation refuses even
    // when the kind is already-attached.
    expect(g6(healthyArm({ attachWarmKind: 'already-attached' }))).toBe('');
    expect(g6(healthyArm({ attachWarmKind: 'already-attached', attachWarmBootId: 'other' })))
      .toContain('changed generation');
  });

  test('devboxRequirements admits every kind each startup step admits', () => {
    // G6 DERIVES its kind clauses from the steps' own admission lists, so the
    // poll and the gate cannot narrow apart: a healthy arm refused for the
    // kind it legitimately answered is the defect that ended `r2fs` after a
    // completed cold attach, ladder, stop and wake. The boot-id equality stays
    // the generation proof — these arms all carry it.
    expect(g6(healthyArm())).toBe('');
    for (const kind of admittedAttachKinds('cold attach')) {
      expect(g6(healthyArm({ attachColdKind: kind }))).toBe('');
    }
    for (const kind of admittedAttachKinds('wake')) {
      expect(g6(healthyArm({ wakeKind: kind }))).toBe('');
    }
    for (const kind of admittedAttachKinds('warm attach')) {
      expect(g6(healthyArm({ attachWarmKind: kind }))).toBe('');
    }
    // AND THE TEETH STAY: what a step excludes still refuses.
    expect(g6(healthyArm({ wakeKind: 'empty' }))).toContain('did not attach');
    expect(g6(healthyArm({ attachWarmKind: 'empty' }))).toContain('unchanged generation');
  });

});

describe('the counted restore (G5)', () => {
  const casMountLines = [
    's3fs /var/tmp/devbox/cas-store fuse.s3fs rw 0 0',
    'overlay /workspace overlay rw,lowerdir=/var/tmp/devbox/cas-store/tree 0 0',
  ];

  test('an unchanged overlay-cas wake counts exactly, and only bytes and cpu stay null', () => {
    const counted = countedRestoreWork({
      strategy: 'overlay-cas',
      wakeKind: 'attached',
      wakeDetail: 'overlay-cas folded 14 0P',
      wakeOps: { calls: { get: 1, list: 1 }, total: 2 },
      wakeMountLines: casMountLines,
    });
    expect(counted.counts).toEqual({ serialRemoteOps: 2, totalRemoteOps: 2, mounts: 2, replayUnits: 0 });
    expect(counted.work).toBeNull();
    expect(counted.missing.map((reason) => reason.split(':')[0]).sort()).toEqual([
      'cpuSteps',
      'metadataBytes/payloadBytes',
    ]);
  });

  test('a busy overlay-cas wake counts the replay but refuses the critical path', () => {
    const counted = countedRestoreWork({
      strategy: 'overlay-cas',
      wakeKind: 'attached',
      wakeDetail: 'overlay-cas folded 14 3P',
      wakeOps: { calls: { get: 4, list: 1 }, total: 5 },
      wakeMountLines: casMountLines,
    });
    expect(counted.counts).toEqual({ serialRemoteOps: null, totalRemoteOps: 5, mounts: 2, replayUnits: 3 });
    expect(counted.work).toBeNull();
    expect(counted.missing.join(' ')).toContain('store pool');
  });

  test('an unreadable detail and a missing bracket refuse every field', () => {
    const counted = countedRestoreWork({
      strategy: 'overlay-cas',
      wakeKind: 'attached',
      wakeDetail: 'overlay-cas overlay already mounted',
      wakeOps: null,
      wakeMountLines: [],
    });
    expect(counted.work).toBeNull();
    expect(counted.missing.length).toBeGreaterThanOrEqual(5);
    expect(counted.missing.join(' ')).toContain('went uncounted rather than zero');
  });

  test('a wake that never attached counts nothing', () => {
    const counted = countedRestoreWork({
      strategy: 'snapshot-chain', wakeKind: 'empty', wakeDetail: '', wakeOps: null, wakeMountLines: [],
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
    expect(verifyRestoreBound('snapshot-chain', row(4), lines).verified).toBe(true);
    const tooMany = verifyRestoreBound(
      'snapshot-chain', row(5), [...lines, 'squashfuse /var/tmp/devbox/lower-delta/def456 fuse.squashfuse ro 0 0'],
    );
    expect(tooMany.verified).toBe(false);
    expect(tooMany.reason).toContain('past the at-most-two-deep serve');
  });

  test('every other claim refuses with the cell that would verify it named', () => {
    const row = {
      serialRemoteOps: 1, totalRemoteOps: 1, metadataBytes: 1, payloadBytes: 0,
      cpuSteps: 0, mounts: 1, replayUnits: 0,
    };
    for (const strategy of ['r2fs', 'overlay-cas', 'bounded-layers', 'merkle-pack'] as const) {
      expect(verifyRestoreBound(strategy, row, []).verified).toBe(false);
    }
    expect(verifyRestoreBound('r2fs', row, []).reason).toContain('two-size');
    expect(verifyRestoreBound('overlay-cas', row, []).reason).toContain('red witness');
    expect(verifyRestoreBound('bounded-layers', row, []).reason).toContain('MAX_LAYER_DEPTH');
    expect(verifyRestoreBound('merkle-pack', row, []).reason).toContain('log-p');
    expect(verifyRestoreBound('snapshot-chain', null, []).verified).toBe(false);
  });

  test('mount lines match by point, delta layers by prefix', () => {
    const text = [
      's3fs /backups fuse.s3fs rw 0 0',
      'squashfuse /var/tmp/devbox/lower-delta/abc fuse.squashfuse ro 0 0',
      'overlay /workspace overlay rw 0 0',
      's3fs /var/tmp/devbox/cas-store fuse.s3fs rw 0 0',
      'proc /proc proc rw 0 0',
    ].join('\n');
    expect(selectWakeMountLines('snapshot-chain', text)).toHaveLength(3);
    expect(selectWakeMountLines('r2fs', text)).toHaveLength(1);
    expect(selectWakeMountLines('overlay-cas', text)).toHaveLength(2);
    expect(selectWakeMountLines('merkle-pack', text)).toHaveLength(0);
    expect(selectWakeMountLines('merkle-pack', text, ['/workspace'])).toHaveLength(1);
  });

  test('detail parsers read the product shapes and refuse the rest', () => {
    expect(replayedEntries('overlay-cas folded 14 3P')).toBe(3);
    expect(replayedEntries('overlay-cas overlay already mounted')).toBeNull();
    expect(foldedCursor('overlay-cas folded 14 3P')).toBe(14);
    expect(candidateRootId('restored candidate root 9f86d081')).toBe('9f86d081');
    expect(candidateRootId('repaired candidate root 9f86d081')).toBe('9f86d081');
    expect(candidateRootId('candidate control has no published head')).toBeNull();
    expect(parseCursorSeq('{"version":1,"foldedSeq":14}')).toBe(14);
    expect(parseCursorSeq('{"foldedSeq":"soon"}')).toBeNull();
    expect(parseCursorSeq('not json')).toBeNull();
    expect(chainServedWord('chain abc 123B base+delta layered')).toBe('base+delta layered');
    expect(chainServedWord('recovered chain abc 123B base')).toBeNull();
  });

  test('the sweep parser counts absent objects and ignores diagnostics', () => {
    expect(parseOverlaySweep('swept 3 batches\nmissing blobs/ab/cd\nsweep-note: slow\nmissing cursor.json\n'))
      .toEqual({ batches: 3, missing: 2 });
    expect(parseOverlaySweep('')).toEqual({ batches: null, missing: 0 });
  });
});

describe('the fault-cut judges (G3)', () => {
  const chainFacts = (overrides: Partial<ChainCutFacts> = {}): ChainCutFacts => ({
    recordPresent: true,
    preBaseId: 'base1', preHasDelta: true, preRev: 7, preDeltaEtag: 'etag-a',
    postBaseId: 'base1', postHasDelta: true, postRev: 7, postDeltaEtag: 'etag-a',
    servedWord: 'base+delta layered', cutMarkerPresent: false, baseExists: true, deltaExists: true,
    ...overrides,
  });

  test('a chain cut reads all-old, all-new, and the torn middle', () => {
    const old = judgeChainCut(chainFacts());
    expect(old.verdict).toBe('all-old');
    expect(old.rollback).toBe(false);
    expect(old.phantom).toBe(false);
    const fresh = judgeChainCut(chainFacts({
      postRev: 8, postDeltaEtag: 'etag-b', cutMarkerPresent: true,
    }));
    expect(fresh.verdict).toBe('all-new');
    // THE MIXED READ the cell must catch: bytes served that no commit names.
    const torn = judgeChainCut(chainFacts({ cutMarkerPresent: true }));
    expect(torn.verdict).toBe('mixed');
  });

  test('a chain rollback and a vanished record are caught', () => {
    expect(judgeChainCut(chainFacts({ postRev: 6 })).rollback).toBe(true);
    const vanished = judgeChainCut(chainFacts({ recordPresent: false }));
    expect(vanished.phantom).toBe(true);
    expect(vanished.verdict).toBe('mixed');
    expect(judgeChainCut(chainFacts({ servedWord: null })).verdict).toBe('unjudged');
  });

  const overlayFacts = (overrides: Partial<OverlayCutFacts> = {}): OverlayCutFacts => ({
    seqMoved: false, seqComparable: true, seqDecreased: false, replayedEntries: 0,
    cutMarkerPresent: false, cursorExists: true, journalEmpty: true,
    ...overrides,
  });

  test('an overlay-cas cut reads all-old, all-new, and the torn middle', () => {
    expect(judgeOverlayCut(overlayFacts()).verdict).toBe('all-old');
    expect(judgeOverlayCut(overlayFacts({ seqMoved: true, cutMarkerPresent: true })).verdict).toBe('all-new');
    // Folded without the bytes: the record moved but the marker never landed.
    expect(judgeOverlayCut(overlayFacts({ seqMoved: true })).verdict).toBe('mixed');
    expect(judgeOverlayCut(overlayFacts({ seqMoved: null })).verdict).toBe('unjudged');
  });

  test('an overlay-cas rollback and an unreaped remainder are caught', () => {
    const back = judgeOverlayCut(overlayFacts({ seqMoved: true, seqDecreased: true }));
    expect(back.rollback).toBe(true);
    expect(back.verdict).toBe('mixed');
    expect(judgeOverlayCut(overlayFacts({ journalEmpty: false })).phantom).toBe(true);
    expect(judgeOverlayCut(overlayFacts({ journalEmpty: null })).phantom).toBeNull();
    expect(judgeOverlayCut({ ...overlayFacts(), cursorExists: false }).verdict).toBe('mixed');
  });

  const candidateFacts = (overrides: Partial<CandidateCutFacts> = {}): CandidateCutFacts => ({
    postKind: 'attached',
    preGeneration: '5', preRootId: 'aaaa',
    postGeneration: '5', postRootId: 'aaaa', detailRootId: 'aaaa',
    forkedHeads: [], closureAbsent: 0, closureChecked: true,
    cutMarkerPresent: false, barrierGeneration: '5', barrierMarkerPresent: true,
    healForkedHeads: [], healStrayEnvelopes: 0, healUnreadable: 0,
    ...overrides,
  });

  test('a candidate cut reads all-old and all-new', () => {
    const old = judgeCandidateCut(candidateFacts());
    expect(old.verdict).toBe('all-old');
    expect(old.rollback).toBe(false);
    expect(old.phantom).toBe(false);
    expect(old.barrierAckLoss).toBe(0);
    const fresh = judgeCandidateCut(candidateFacts({
      postGeneration: '6', postRootId: 'bbbb', detailRootId: 'bbbb', cutMarkerPresent: true,
    }));
    expect(fresh.verdict).toBe('all-new');
    expect(fresh.barrierAckLoss).toBe(0);
  });

  test('a candidate mixed read, absent reference and detail mismatch are caught', () => {
    // Advanced without the bytes.
    expect(judgeCandidateCut(candidateFacts({
      postGeneration: '6', postRootId: 'bbbb', detailRootId: 'bbbb',
    })).verdict).toBe('mixed');
    // The attach claims a root the store does not head.
    expect(judgeCandidateCut(candidateFacts({
      postGeneration: '6', postRootId: 'bbbb', detailRootId: 'cccc', cutMarkerPresent: true,
    })).verdict).toBe('mixed');
    // A sealed envelope member with no bytes behind it.
    const absent = judgeCandidateCut(candidateFacts({
      postGeneration: '6', postRootId: 'bbbb', detailRootId: 'bbbb',
      cutMarkerPresent: true, closureAbsent: 1,
    }));
    expect(absent.verdict).toBe('mixed');
  });

  test('a candidate rollback, phantom, lost barrier and vanished head are caught', () => {
    expect(judgeCandidateCut(candidateFacts({ postGeneration: '4' })).rollback).toBe(true);
    expect(judgeCandidateCut(candidateFacts({ postKind: 'empty' })).rollback).toBe(true);
    expect(judgeCandidateCut(candidateFacts({ healForkedHeads: ['k1', 'k2'] })).phantom).toBe(true);
    expect(judgeCandidateCut(candidateFacts({ healStrayEnvelopes: 1 })).phantom).toBe(true);
    expect(judgeCandidateCut(candidateFacts({ healUnreadable: 1 })).phantom).toBe(true);
    expect(judgeCandidateCut(candidateFacts({
      postGeneration: '4', barrierGeneration: '5',
    })).barrierAckLoss).toBe(1);
    expect(judgeCandidateCut(candidateFacts({ barrierGeneration: null })).barrierAckLoss).toBeNull();
  });

  test('a read-only probe refuses writes and only writes', () => {
    expect(judgeReadOnlyRefusal(1, 'touch: /backups/x: Read-only file system')).toBe(true);
    expect(judgeReadOnlyRefusal(0, '')).toBe(false);
    expect(judgeReadOnlyRefusal(1, 'touch: /backups/x: Permission denied')).toBe(false);
  });

  test('generations order decimally or refuse', () => {
    expect(compareGenerations('5', '6')).toBe(-1);
    expect(compareGenerations('6', '6')).toBe(0);
    expect(compareGenerations('10', '9')).toBe(1);
    expect(compareGenerations('007', '7')).toBeNull();
    expect(compareGenerations(null, '7')).toBeNull();
  });

  const passCut = (overrides: Partial<FaultCutObservation> = {}): FaultCutObservation => ({
    completed: true, verdict: 'all-new', absentReferences: 0, rollbackOrPhantomRoot: false,
    barrierAckLoss: null, readOnlySurface: null, readOnlyRefusedWrites: null,
    detail: 'cut',
    ...overrides,
  });

  test('a complete cut folds into a passing publication block', () => {
    const publication = summarizePublication([
      { strategy: 'snapshot-chain', cut: passCut({ readOnlySurface: '/backups', readOnlyRefusedWrites: true }) },
      { strategy: 'overlay-cas', cut: passCut() },
      { strategy: 'bounded-layers', cut: passCut({ barrierAckLoss: 0 }) },
      { strategy: 'merkle-pack', cut: passCut({ barrierAckLoss: 0 }) },
      { strategy: 'r2fs', cut: null },
    ]);
    expect(publication).toEqual({
      readOnlyDeclared: true,
      readOnlyRefusedWrites: true,
      faultCutCompleted: true,
      allOldOrAllNew: true,
      barrierAckLoss: 0,
      absentReferences: 0,
      rollbackOrPhantomRoot: false,
    });
  });

  test('a mixed read, a caught true, and a missing cell refuse the block', () => {
    const rows = (cut: FaultCutObservation | null) => ([
      { strategy: 'snapshot-chain' as const, cut },
      { strategy: 'r2fs' as const, cut: null },
    ]);
    expect(summarizePublication(rows(passCut({ verdict: 'mixed' }))).allOldOrAllNew).toBe(false);
    expect(summarizePublication(rows(passCut({ absentReferences: 2 }))).absentReferences).toBe(2);
    expect(summarizePublication(rows(passCut({ rollbackOrPhantomRoot: true }))).rollbackOrPhantomRoot).toBe(true);
    expect(summarizePublication(rows(passCut({ barrierAckLoss: 1 }))).barrierAckLoss).toBe(1);
    const incomplete = summarizePublication(rows(null));
    expect(incomplete.faultCutCompleted).toBe(false);
    expect(incomplete.allOldOrAllNew).toBeNull();
    expect(incomplete.absentReferences).toBeNull();
    expect(incomplete.rollbackOrPhantomRoot).toBeNull();
    expect(incomplete.barrierAckLoss).toBeNull();
  });
});

describe('the cut and counted cells reach the verdict', () => {
  const meta = {
    date: '2026-09-04', run: 'kinu-devbox-bench-test', worker: 'w', bucket: 'b',
    image: SANDBOX_IMAGE, seed: '20260824', 'loop budget ms': '8000', 'deciding repetitions': '2',
  };
  const identity = {
    commit: '6823779aa', dirtyDigest: 'clean', workerVersion: 'v',
    startedAt: '2026-09-04T00:00:00.000Z', finishedAt: '2026-09-04T01:00:00.000Z',
    image: SANDBOX_IMAGE, imageSha256: SANDBOX_IMAGE_DIGEST,
    dockerfileSha256: `sha256:${'a'.repeat(64)}`, candidateRunnerSha256: `sha256:${'b'.repeat(64)}`,
    overlayRunnerSha256: `sha256:${'c'.repeat(64)}`, journalDaemonSha256: `sha256:${'d'.repeat(64)}`,
  };
  const cleanup = {
    attempted: true, kept: false, workerAbsent: true, runtimeAbsent: true,
    bucketAndMultipartEmpty: true, boxDurableStateEmpty: true,
    localSecretsProcessesAbsent: true, countersReconciled: true,
    replayIdempotent: true, multipartResidue: 0, errors: [],
  };
  const admissionArm = (strategy: Strategy, overrides: Partial<ArmResult> = {}): ArmResult => ({
    strategy, box: `box-${strategy}`, verifyPassed: true, verifyChecks: [],
    attachColdMs: 1000, attachColdKind: 'empty', attachColdBootId: 'cold',
    attachWarmMs: 50, attachWarmKind: 'attached', wakeBootId: 'wake', attachWarmBootId: 'wake',
    checkpoints: [], stopMs: 100, wakeMs: 2000, wakeKind: 'attached',
    phases: [], decisiveTicks: [], quiescesBeforeDecisive: 0,
    generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
    ops: { total: 10 }, teardown: null, witnessChecks: [], notes: [],
    ...overrides,
  });
  const reasons = (verdict: { gates: readonly { gate: string; reasons: readonly string[] }[] }, gate: string): string =>
    verdict.gates.find((row) => row.gate === gate)?.reasons.join(' | ') ?? '';

  test('an uncounted overlay-cas arm refuses G5 on its bill and its unbounded claim', () => {
    const verdict = devboxAdmission({
      arms: [admissionArm('overlay-cas', {
        wakeDetail: 'overlay-cas folded 14 3P', wakeOps: null, wakeMountLines: [],
      })],
      requested: ['overlay-cas'], repetitions: 2, meta, identity, token: 't', cleanup,
    });
    const g5 = verdict.gates.find((row) => row.gate === 'G5');
    expect(g5?.ok).toBe(false);
    expect(reasons(verdict, 'G5')).toContain('totalRemoteOps');
    expect(reasons(verdict, 'G5')).toContain('unbounded restore class');
  });

  test('a fully cut candidate arm holds G3, a missing cut refuses it', () => {
    const cut: FaultCutObservation = {
      completed: true, verdict: 'all-new', absentReferences: 0, rollbackOrPhantomRoot: false,
      barrierAckLoss: 0, readOnlySurface: null, readOnlyRefusedWrites: null,
      detail: 'cut',
    };
    const held = devboxAdmission({
      arms: [admissionArm('bounded-layers', { cut })],
      requested: ['bounded-layers'], repetitions: 2, meta, identity, token: 't', cleanup,
    });
    expect(held.gates.find((row) => row.gate === 'G3')?.ok).toBe(true);
    const refused = devboxAdmission({
      arms: [admissionArm('bounded-layers', { cut: null })],
      requested: ['bounded-layers'], repetitions: 2, meta, identity, token: 't', cleanup,
    });
    expect(refused.gates.find((row) => row.gate === 'G3')?.ok).toBe(false);
    expect(reasons(refused, 'G3')).toContain('fault-cut');
  });
});

describe('the instruments restate nothing unchecked', () => {
  const driver = readFileSync(join(import.meta.dir, 'bench-devbox-strategies.ts'), 'utf8');
  const repo = (...parts: string[]): string => readFileSync(join(import.meta.dir, '..', ...parts), 'utf8');

  test('the folded parser instantiates the product template', () => {
    const overlay = repo('packages', 'devbox', 'src', 'overlay-cas.ts');
    const template = /detail: `(overlay-cas folded )\$\{[^}]+\} \$\{[^}]+\}(P)`/.exec(overlay);
    expect(template?.[1]).toBe('overlay-cas folded ');
    expect(template?.[2]).toBe('P');
    const sample = `${template?.[1]}14 3${template?.[2]}`;
    expect(replayedEntries(sample)).toBe(3);
    expect(foldedCursor(sample)).toBe(14);
  });

  test('the candidate root parser instantiates servedOutcome', () => {
    const container = repo('packages', 'devbox', 'src', 'candidates', 'container.ts');
    expect(container).toContain('detail: `${how} candidate root ${rootId}`');
    const words = new Set(
      [...container.matchAll(/servedOutcome\([^,]+, '(restored|repaired)'\)/g)].map((match) => match[1]),
    );
    expect([...words].sort()).toEqual(['repaired', 'restored']);
    for (const word of words) {
      expect(candidateRootId(`${word} candidate root ${'9f'.repeat(32)}`)).toBe('9f'.repeat(32));
    }
    expect(candidateRootId('candidate control has no published head')).toBeNull();
  });

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

  test('the sweep spells every key the product declares', () => {
    const types = repo('packages', 'devbox', 'src', 'cas', 'types.ts');
    const values = [
      /KEY_CURSOR = '([^']+)'/.exec(types)?.[1],
      /PREFIX_JOURNAL = '([^']+)'/.exec(types)?.[1],
      /PREFIX_BLOBS = '([^']+)'/.exec(types)?.[1],
    ];
    expect(values.every((value) => value !== undefined && value.length > 0)).toBe(true);
    const script = /OVERLAY_SWEEP_SCRIPT = \[([\s\S]*?)\]\.join/.exec(driver)?.[1] ?? '';
    for (const value of values) expect(script).toContain(value ?? '(absent)');
    expect(script).toContain('.json');
    expect(types).toContain('.json');
  });

  test('the chain store mount is the product’s', () => {
    const chain = repo('packages', 'devbox', 'src', 'snapshot-chain.ts');
    const product = /CHAIN_STORE_MOUNT = '([^']+)'/.exec(chain)?.[1];
    const restated = /CHAIN_STORE_MOUNT_DIR = '([^']+)'/.exec(driver)?.[1];
    expect(product).toBeDefined();
    expect(restated).toBe(product);
  });

  test('every strategy has mount points, and candidates hold none statically', () => {
    const block = /WAKE_MOUNT_POINTS = \{([\s\S]*?)\} satisfies/.exec(driver)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);
    for (const strategy of STRATEGIES) {
      expect(block).toContain(strategy);
    }
    expect(block).toContain("'bounded-layers': [],");
    expect(block).toContain("'merkle-pack': [],");
  });
  test('r2fs is the only exclusion, and its reason says why', () => {
    const block = /FAULT_CUT_EXCLUDED = \{([\s\S]*?)\} satisfies/.exec(driver)?.[1] ?? '';
    expect(block).toContain('r2fs:');
    for (const strategy of STRATEGIES) {
      if (strategy === 'r2fs') continue;
      expect(block).not.toContain(`'${strategy}'`);
      expect(block).not.toContain(`${strategy}:`);
    }
    const reason = /r2fs: '([^']*(?:'[^']*)*)'/.exec(block)?.[0] ?? '';
    expect(reason.length).toBeGreaterThan(40);
    // The reader goes through `faultCutExclusion`, not the table: its cases
    // must stay exactly the table's keys, or an exclusion would read one way
    // and judge another.
    //
    // DIGITS IN THE CLASS, and a `case` that may wrap onto its own line. Both
    // patterns began as `[a-z-]+` against one line, so every strategy name
    // carrying a digit matched neither — and `r2fs` is the only exclusion
    // there is. Keys came back empty, cases came back empty, and comparing
    // them would have agreed about nothing; only the literal `['r2fs']`
    // expectation beside them made the miss visible instead of vacuous.
    const keys = [...block.matchAll(/^  ([a-z0-9-]+):/gm)].map((match) => match[1]).sort();
    const cases = [...driver.matchAll(
      /case '([a-z0-9-]+)':\s*(?:\n\s*)?return FAULT_CUT_EXCLUDED\./g,
    )]
      .map((match) => match[1])
      .sort();
    expect(keys).toEqual(['r2fs']);
    expect(cases).toEqual(keys);
  });

  test('the cut cell dispatches every cuttable arm', () => {
    const cell = /async function runFaultCutCell[\s\S]*?\n\}\n/.exec(driver)?.[0] ?? '';
    for (const strategy of ['snapshot-chain', 'overlay-cas', 'bounded-layers', 'merkle-pack']) {
      expect(cell).toContain(`'${strategy}'`);
    }
  });

  test('the control dump restates the product row, key for key', () => {
    // Both sides literal: an empty comparison agreeing about nothing is the
    // failure this device exists to catch — a character class that matches no
    // name carrying a digit taught us that.
    const devbox = repo('packages', 'devbox', 'src', 'devbox.ts');
    const product = /export interface CandidateControlDump \{([\s\S]*?)\}/.exec(devbox)?.[1] ?? '';
    const productKeys = [...product.matchAll(/readonly (\w+)/g)].map((match) => match[1]).sort();
    expect(productKeys).toEqual(['boxId', 'found', 'head', 'key', 'operation', 'strategy']);
    const restated = /export interface CandidateControlDump \{([\s\S]*?)\}/.exec(driver)?.[1] ?? '';
    const restatedKeys = [...restated.matchAll(/(\w+)\?:/g)].map((match) => match[1]).sort();
    expect(restatedKeys).toEqual(productKeys);
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

  test('the control-dump exclusion names the route’s own refusal', () => {
    // Non-candidate arms publish no control row, so the read skips them
    // without a gap note — but the reason lives here in prose, pinned to the
    // refusal the route answers, so a rewording on either side fails loudly.
    const reads = /async function readControlDump[\s\S]*?\n\}/.exec(driver)?.[0] ?? '';
    expect(reads).toContain(`strategy !== 'bounded-layers' && strategy !== 'merkle-pack'`);
    expect(reads).toContain('publishes no candidate control envelope');
    const worker = repo('packages', 'devbox', 'bench', 'worker.ts');
    expect(worker).toContain('publishes no candidate control envelope');
  });

  test('the journal readiness fact is identical across fixture and driver', () => {
    const worker = repo('packages', 'devbox', 'bench', 'worker.ts');
    const served = /export interface CandidateContainerFacts \{([\s\S]*?)\}/.exec(worker)?.[1] ?? '';
    const servedKeys = [...served.matchAll(/readonly (\w+)/g)].map((match) => match[1]).sort();
    expect(servedKeys).toEqual([
      'expectedJournalBinary', 'expectedJournalRoot', 'expectedJournalSocket', 'expectedStoreMount',
      'expectedWorkdirMount', 'journalDaemonCommand', 'journalReady', 'journalReadyDetail',
      'journalRootPresent', 'journalSocketPresent', 'mounts',
    ]);
    const decoded = /interface CandidateContainerFact \{([\s\S]*?)\}/.exec(driver)?.[1] ?? '';
    const decodedKeys = [...decoded.matchAll(/(\w+)\?:/g)].map((match) => match[1]).sort();
    expect(decodedKeys).toEqual(servedKeys);
  });

  test('the readiness probe asks the daemon’s read-only stats operation', () => {
    const probeModule = repo('packages', 'devbox', 'bench', 'journal-ready-probe.ts');
    const probe = /const JOURNAL_READY_PROBE = \[([\s\S]*?)\]\.join/.exec(probeModule)?.[1] ?? '';
    expect(probe).toContain("op: 'stats'");
    const daemon = repo('packages', 'devbox', 'bench', 'journal-daemon', 'journal-daemon.c');
    expect(daemon).toContain('strcmp(op, "stats") == 0');
  });

  test('the probe scope gates the post-wake tail on verify-only', () => {
    const arm = /async function measureArm[\s\S]*?\n\}\n/.exec(driver)?.[0] ?? '';
    expect(arm).toContain('await runWorkloadPhases(fixture, box, strategy, options, result, notes);');
    expect(arm).toContain('if (options.verifyOnly) {');
    expect(arm).toContain('await releaseArm(fixture, box, result, notes);');
  });

});
