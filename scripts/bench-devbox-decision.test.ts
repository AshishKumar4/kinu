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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  R2_CLASS_A_USD_PER_MILLION, R2_CLASS_B_USD_PER_MILLION, decide, opsAreBlind, priceOps,
  sqliteFinding, totalsFor, type TickRecord,
} from './fixtures/r2-bench/decision';
import { refusalText } from './fixtures/storage-matrix/admission';
import { loadManifest, manifestPath } from './fixtures/storage-matrix/cleanup';
import * as v from 'valibot';
import { WRANGLER_FAILED } from './fixtures/r2-bench/deploy-substrate';
import {
  addressArmRequest,
  benchmarkExitCode,
  boxName,
  CANDIDATE_CONTAINER_CLASSES,
  candidateLifecycleChecks,
  chainArchiveExpectations,
  controlWitnessChecks,
  cleanupObservationProbes,
  checkpointOperation,
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
  isTransientContainerCreateError,
  parseFrozenControlArtifact,
  parseOptions,
  pollForAttach,
  postLiveTeardown,
  rankableTicks,
  runArm,
  runArmsInFlight,
  renderFrozenControls,
  orphanTeardownExecutor,
  plannedTeardownManifest,
  resourceNames,
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_DIGEST,
  STRATEGIES,
  startupPollVerdict,
  stopOperation,
  recommend,
  teardownLiveArms,
  type ArmResult,
  type ControlWitnessFacts,
  type CandidateFactsReply,
  type Strategy,
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
    // The two routes now travel through `awaitArmedOperation`; a `call` that
    // posts either of them is a request holding a publication open again.
    expect(source).not.toContain("'POST', `/checkpoint?box=");
    expect(source).not.toContain("'POST', `/stop?box=");
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
function wakeRefusingFixture(refusal: string) {
  const asked: string[] = [];
  let woken = false;
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
    if (route === 'POST /checkpoint' || route === 'POST /stop') {
      return new Response(JSON.stringify({ ok: true, token: `token-${String(asked.length)}`, state: 'pending' }), {
        status: 202,
      });
    }
    if (route === 'GET /operation') {
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
    decisiveQuiesces: 0,
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

/** Facts in which every control's documented defect DID show up. */
const WITNESSED: ControlWitnessFacts = {
  cumulativeDeltaSeed: {
    deltaBytes: 71_303_168, markerInUpper: true, seedStamp: 'chain-7:71303168:v4', chainId: 'chain-7',
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

const witnessNames = (checks: readonly { name: string; observed: boolean }[]): string[] =>
  checks.filter((check) => check.observed).map((check) => check.name);

describe('the preregistered witness cells', () => {
  test('every preregistered witness is answered, by name and in order', () => {
    expect(controlWitnessChecks('snapshot-chain', WITNESSED).map((check) => check.name))
      .toEqual(['cumulative-delta-seed', 'mutable-delta']);
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
      .toEqual(['cumulative-delta-seed', 'mutable-delta']);
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

  test('a delta the attach no longer copies is drift, not a pass', () => {
    const [seed] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      cumulativeDeltaSeed: { ...WITNESSED.cumulativeDeltaSeed!, markerInUpper: false },
    });
    expect(seed?.observed).toBe(false);
    expect(seed?.detail).toContain('does NOT hold');
  });

  test('a seed stamp naming an older generation does not witness THIS delta', () => {
    const [seed] = controlWitnessChecks('snapshot-chain', {
      ...WITNESSED,
      cumulativeDeltaSeed: { ...WITNESSED.cumulativeDeltaSeed!, seedStamp: 'chain-6:71303168:v3' },
    });
    expect(seed?.observed).toBe(false);
  });

  test('one key holding the same bytes twice is no longer a mutable delta', () => {
    const [, mutable] = controlWitnessChecks('snapshot-chain', {
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

  test('a witness is a cost, not an eligibility filter: every arm ranks', () => {
    // THE FILTER THIS REMOVES. `devboxArmEvidence` answered
    // `kind: 'control', rankEligible: false` for the three shipped arms, so G2
    // refused them a place in the ranking whatever they measured — an arm's
    // documented defects decided the outcome before a single tick was taken.
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
      expect(evidence.rankEligible).toBe(true);
      // And the preregistration still binds: an arm that promised witnesses
      // still has to produce exactly those, which is what makes the cost real.
      expect(evidence.expectedRedChecks).toEqual(evidence.observedRedChecks);
    }
  });

  test('a rank-eligible arm whose promised witness vanished still refuses the run', () => {
    // Witness enforcement used to live on the non-candidate branch of the
    // admission gate, so making these arms rank-eligible would have silently
    // switched their drift detector off. It keys off the preregistration now.
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

    expect(drifted.rankEligible).toBe(true);
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
      quiescesBeforeDecisive: 0, decisiveQuiesces: 0,
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
      meta: {
        date: '2026-08-28', run: 'blank-run', worker: 'blank-fixture', bucket: 'blank-bucket',
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

describe('the recommendation ranks every measured arm', () => {
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
    quiescesBeforeDecisive: 0, decisiveQuiesces: 0,
    generationBeforeLadder: null, generationAfterLadder: null, treeBytes: {},
    ops: null, teardown: null,
    witnessChecks: witnesses.map((name) => ({ name, observed: true, detail: 'observed' })),
    notes: [],
  });

  test('every arm appears in the ranking, ordered by decisive tick cost', () => {
    // THE FILTER THIS REPLACES. `recommend` scored on metadata latency and named
    // one best and one worst, over arms `devboxArmEvidence` had already narrowed
    // to {bounded-layers, merkle-pack}. All five are ranked now, and `r2fs` —
    // which no declared pair even contained — is one of the rows.
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      rankArm('r2fs', { git: 900, npm: 380 }, ['open-write-loss', 'POSIX-gap']),
      rankArm('overlay-cas', { git: 300, npm: 200 }),
      rankArm('bounded-layers', { git: 100, npm: 100 }),
      rankArm('merkle-pack', { git: 150, npm: 120 }),
    ], ADMITTED);

    for (const strategy of STRATEGIES) expect(report).toContain(`\`${strategy}\``);
    const order = STRATEGIES
      .map((strategy) => ({ strategy, at: report.indexOf(`| \`${strategy}\``) }))
      .filter((row) => row.at !== -1)
      .sort((a, b) => a.at - b.at)
      .map((row) => row.strategy);
    expect(order).toEqual([
      'bounded-layers', 'merkle-pack', 'overlay-cas', 'r2fs', 'snapshot-chain',
    ]);
    expect(report).toContain(`\`${INCUMBENT}\` (incumbent)`);
  });

  test('an observed witness is priced beside the arm, never used to drop it', () => {
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      rankArm('r2fs', { git: 20, npm: 20 }, ['open-write-loss', 'non-atomic-rename']),
    ], ADMITTED);

    // r2fs carries three documented semantic defects and still wins the ranking
    // on cost; the defects are reported as the price of adopting it.
    expect(report).toContain('`open-write-loss`, `non-atomic-rename`');
    expect(report).toContain('DEFAULT TO `r2fs`');
    expect(report).toContain('preregistered defect(s) this run OBSERVED');
  });

  test('costing least does not displace the incumbent without clearing the bar', () => {
    // 2x on git and 1.3x on npm: cheaper, nowhere near the preregistered
    // 10x/3x bar. The ranking and the decision rule must not disagree.
    const report = recommend([
      rankArm('snapshot-chain', { git: 200, npm: 130 }),
      rankArm('merkle-pack', { git: 100, npm: 100 }),
    ], ADMITTED);

    expect(report).toContain('`snapshot-chain` STAYS DEFAULT');
    expect(report).toContain('`merkle-pack` costs 1.6x less decisive tick time');
    expect(report).not.toContain('DEFAULT TO `merkle-pack`');
  });

  test('a run without the incumbent ranks its arms but claims no default', () => {
    const report = recommend([
      rankArm('bounded-layers', { git: 100, npm: 100 }),
      rankArm('merkle-pack', { git: 300, npm: 300 }),
    ], ADMITTED);

    expect(report).toContain('`bounded-layers` COSTS LEAST HERE');
    expect(report).toContain(`the incumbent \`${INCUMBENT}\` is not in the ranking`);
    expect(report).not.toContain('DEFAULT TO');
  });

  test('an arm missing a decisive workload is named unranked, not silently dropped', () => {
    const partial = rankArm('overlay-cas', { git: 100, npm: 100 });
    const report = recommend([
      rankArm('snapshot-chain', { git: 1200, npm: 400 }),
      { ...partial, decisiveTicks: [tick('overlay-cas', 'git', 100)] },
    ], ADMITTED);

    expect(report).toContain('unranked: no ticks on npm');
    expect(report).toContain('`overlay-cas`');
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

  test('every arm runs by default, a subset is named outright, and controls are strategy-qualified', () => {
    // NO PRIVILEGED SUBSET. `--candidates-only` used to select
    // {bounded-layers, merkle-pack} — the two arms the old taxonomy allowed to
    // win — so the default shape of a run encoded the conclusion. The default
    // is now every arm, and a subset has to be asked for by name.
    expect(parseOptions([]).arms).toEqual([...STRATEGIES]);
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
    const directory = mkdtempSync(join(tmpdir(), 'devbox-control-'));
    const path = join(directory, 'control.json');
    writeFileSync(path, multiArmArtifact);
    try {
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a plan with no --arms deploys every strategy', () => {
    const plan = Bun.spawnSync(
      ['bun', 'scripts/bench-devbox-strategies.ts', '--plan'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(plan.exitCode, plan.stderr.toString()).toBe(0);
    expect(plan.stdout.toString()).toContain(`arms          ${STRATEGIES.join(', ')}`);
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
      'r2fs', 'overlay-cas', 'bounded-layers', 'merkle-pack',
    ]);
    expect(comparison.kind === 'pairs' ? comparison.pairs.every((pair) => pair.baseline === INCUMBENT) : false)
      .toBe(true);
  });

  test('r2fs is a challenger like any other, and is no longer uncomparable', () => {
    // THE TAXONOMY DEFECT THIS PINS. `DECISION_PAIRS` held two hand-written
    // pairs and neither contained `r2fs`, so the one arm with a full set of
    // preregistered semantic defects was also the one arm whose tick cost was
    // never put beside anything. It answered `absent` here.
    expect(challengers([{ strategy: 'snapshot-chain' }, { strategy: 'r2fs' }])).toEqual(['r2fs']);
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
    const directory = mkdtempSync(join(tmpdir(), 'devbox-control-'));
    mkdirSync(join(directory, 'nested'), { recursive: true });
    writeFileSync(join(directory, 'nested', 'wrangler.jsonc'), '{}');

    const outcome = await orphanTeardownExecutor(null)({
      kind: 'local-path', name: directory, detail: '', done: false, attempts: 0, lastError: null,
    });

    expect(outcome).toEqual({ ok: true });
    expect(existsSync(directory)).toBe(false);
  });
});
