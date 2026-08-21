// ONE SHARED PROVIDER, PACED.
//
// The incident this exists for, measured on the owner's live workspace
// (my-personal-assistant-f0e4afa6): an `ideate` swarm started five nodes in one
// expression, every one of them drove its own turn loop against the SAME
// Cloudflare OAuth credential, and the account rate-limited them together.
// Nothing spaced the request starts and nothing told the fifth node that the
// first had just been handed a `Retry-After`, so five requests raced past an
// instruction one of them had already received.
//
// WHAT IS UNDER TEST IS THE RELATIONSHIP, never a magnitude. `lanes` is a fixture
// value here for the reason `stallTimeoutMs` is one in its own suite: the shipped
// value is six, derived from `worker.simultaneous_connections`, and a suite that
// has to finish cannot exercise it against a real provider. The properties
// asserted — starts are bounded, a declared wait holds every sibling, a wait
// declared by one caller is visible to a watchdog in another — are the ones
// PROVIDER_REQUEST_LANES runs in production.
import { describe, test, expect } from 'bun:test';
import { ProviderPacer, abortableSleep } from '../src/providers/pacing';
import { PLATFORM_CATALOG } from '../src/platform-catalog';

/** A pacer on a hand-cranked clock, so a declared wait costs the suite nothing. */
function fixedClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
  };
}

const HOST = 'api.cloudflare.com';

describe('the lane bound is the platform\'s, not a number of ours', () => {
  test('a pacer nobody configured paces at the platform\'s connection limit', async () => {
    // The catalog is this repository's single copy of every platform number.
    // Read through a DEFAULT pacer — the one production builds — rather than by
    // comparing the constant with the expression that defines it, which is the
    // same statement twice and holds however wrong the number is.
    const lanes = PLATFORM_CATALOG['worker.simultaneous_connections'].limit.value;
    expect(PLATFORM_CATALOG['worker.simultaneous_connections'].bounds).toBe('concurrency');

    const pacer = new ProviderPacer();
    const held: Array<() => void> = [];
    for (let i = 0; i < lanes; i++) held.push(await pacer.admit(HOST));

    // One more than the platform allows is held, and admitted the moment a lane
    // frees. Raise or lower the default and exactly one of these two fails.
    let admitted = false;
    const extra = pacer.admit(HOST).then((release) => { admitted = true; return release; });
    await Promise.resolve();
    expect(admitted).toBe(false);

    held[0]!();
    expect(await extra).toBeInstanceOf(Function);
    for (const release of held.slice(1)) release();
  });
});

describe('request starts are paced against one provider', () => {
  test('the lane count bounds how many requests are out at once', async () => {
    const pacer = new ProviderPacer({ lanes: 2 });
    const first = await pacer.admit(HOST);
    const second = await pacer.admit(HOST);

    // A third caller is held. Proven by racing it against a resolved promise
    // rather than by a timer, so the assertion is about ordering and not speed.
    let admitted = false;
    const third = pacer.admit(HOST).then((release) => { admitted = true; return release; });
    await Promise.resolve();
    expect(admitted).toBe(false);

    first();
    expect(await third).toBeInstanceOf(Function);
    expect(admitted).toBe(true);
    second();
  });

  test('a release is idempotent, so a double `finally` cannot mint capacity', async () => {
    // The failure this guards is silent and unbounded: a release called twice
    // decrements a counter nobody re-checks, and the lane budget grows by one for
    // the life of the isolate.
    const pacer = new ProviderPacer({ lanes: 1 });
    const release = await pacer.admit(HOST);
    release();
    release();

    const held = await pacer.admit(HOST);
    let admitted = false;
    void pacer.admit(HOST).then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    held();
  });

  test('two hosts do not share a lane budget', async () => {
    // The limit being respected is one account's at one provider. A fast provider
    // queued behind a rate-limited one would be this pacer causing the stall it
    // exists to prevent.
    const pacer = new ProviderPacer({ lanes: 1 });
    const held = await pacer.admit(HOST);
    const other = await pacer.admit('api.openai.com');
    expect(other).toBeInstanceOf(Function);
    held();
    other();
  });
});

describe('a wait one caller was told to take holds its siblings', () => {
  test('a declared wait is honoured before a lane is granted', async () => {
    const clock = fixedClock();
    const slept: number[] = [];
    const pacer = new ProviderPacer({
      lanes: 8,
      now: clock.now,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

    // Node A is handed `Retry-After: 30`. Nothing about node B changed, and that
    // is the defect: B had a free lane and an instruction it could not see.
    pacer.declareWait(HOST, 30_000);
    const release = await pacer.admit(HOST);

    expect(slept).toEqual([30_000]);
    release();
  });

  test('a longer wait already in force is never shortened by a peer\'s smaller one', async () => {
    // Five nodes are rate-limited within a moment of each other and are handed
    // different `Retry-After` values. Taking the newest would converge the whole
    // fan-out on the smallest number any member happened to receive.
    const clock = fixedClock();
    const slept: number[] = [];
    const pacer = new ProviderPacer({
      lanes: 8,
      now: clock.now,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

    pacer.declareWait(HOST, 60_000);
    pacer.declareWait(HOST, 5_000);
    const release = await pacer.admit(HOST);

    expect(slept).toEqual([60_000]);
    release();
  });

  test('the provider\'s instruction is honoured BEFORE a lane is competed for', async () => {
    // The ordering, and it is the whole reason a cooldown is not just a lane of
    // its own: a caller that queued for a lane first would spend the cooldown
    // holding capacity nobody may use, and would then issue its request the
    // instant a lane freed — whatever the provider last said.
    //
    // Observable because the cooldown sleep happens even when NO lane is free: the
    // single lane is already held here, so a lane-first implementation records no
    // sleep at all.
    const clock = fixedClock();
    const slept: number[] = [];
    const pacer = new ProviderPacer({
      lanes: 1,
      now: clock.now,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

    const held = await pacer.admit(HOST);
    pacer.declareWait(HOST, 10_000);

    let admitted = false;
    const queued = pacer.admit(HOST).then((release) => { admitted = true; return release; });
    // One microtask turn is enough for the cooldown sleep to have been entered.
    await Promise.resolve();
    await Promise.resolve();
    expect(slept).toEqual([10_000]);
    expect(admitted).toBe(false);

    held();
    (await queued)();
    expect(admitted).toBe(true);
  });
});

describe('a declared wait is readable by whoever is timing the silence', () => {
  test('an open wait reports its deadline; an elapsed one reports only that it happened', () => {
    // The two questions the turn loop's watchdog asks, and they are different.
    // "Is a wait open" says whether to keep waiting. "Did one happen at all" says
    // whether the silence it is about to end was explained — a wait that opened
    // AND elapsed inside the window is gone by the time the watchdog looks, and
    // the turn would otherwise be reported as an unexplained stall with the cause
    // sitting in the log.
    const clock = fixedClock();
    const pacer = new ProviderPacer({ now: clock.now });

    expect(pacer.waits()).toEqual({ untilMs: 0, declared: 0 });

    pacer.declareWait(HOST, 5_000);
    const open = pacer.waits();
    expect(open.untilMs).toBe(clock.now() + 5_000);
    expect(open.declared).toBe(1);

    clock.advance(5_001);
    const elapsed = pacer.waits();
    expect(elapsed.untilMs).toBe(0);
    expect(elapsed.declared).toBe(1);
  });

  test('the furthest open deadline wins across hosts', () => {
    const clock = fixedClock();
    const pacer = new ProviderPacer({ now: clock.now });
    pacer.declareWait(HOST, 2_000);
    pacer.declareWait('api.openai.com', 9_000);
    expect(pacer.waits().untilMs).toBe(clock.now() + 9_000);
  });

  test('a non-wait is not recorded as one', () => {
    // `parseRetryAfter` legitimately yields 0 for `Retry-After: 0`, and a
    // zero-length wait that still bumped the count would make the watchdog blame
    // a rate limit for a silence nobody was asked to take.
    const pacer = new ProviderPacer({ now: fixedClock().now });
    pacer.declareWait(HOST, 0);
    pacer.declareWait(HOST, -1);
    expect(pacer.waits()).toEqual({ untilMs: 0, declared: 0 });
  });
});

describe('a cancelled caller stops waiting', () => {
  test('an abort releases a request queued behind a full lane budget', async () => {
    // Without this a cancelled node sits in the queue until an unrelated release
    // happens to wake it, which on a busy host is a stopped agent still counted
    // as working.
    const pacer = new ProviderPacer({ lanes: 1 });
    const held = await pacer.admit(HOST);
    const controller = new AbortController();
    const queued = pacer.admit(HOST, controller.signal);

    controller.abort(new Error('the search was aborted'));
    await expect(queued).rejects.toThrow('the search was aborted');
    held();
  });

  test('an abort during a declared wait rejects with the caller\'s own reason', async () => {
    const pacer = new ProviderPacer({ lanes: 1 });
    pacer.declareWait(HOST, 30_000);
    const controller = new AbortController();
    const waiting = pacer.admit(HOST, controller.signal);

    controller.abort(new Error('stop pressed'));
    await expect(waiting).rejects.toThrow('stop pressed');
  });

  test('an already-aborted caller is refused before it takes a lane', async () => {
    const pacer = new ProviderPacer({ lanes: 1 });
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(pacer.admit(HOST, controller.signal)).rejects.toThrow('already gone');

    // And the refusal cost no capacity, which is the half that matters: a lane
    // leaked here would shrink the budget permanently.
    const release = await pacer.admit(HOST);
    expect(release).toBeInstanceOf(Function);
    release();
  });
});

describe('the shared wait, without a signal', () => {
  test('abortableSleep resolves when nobody is cancelling it', async () => {
    const before = Date.now();
    await abortableSleep(10);
    expect(Date.now() - before).toBeGreaterThanOrEqual(5);
  });
});
