// One shared provider, paced. `lanes` is a fixture value; production's PROVIDER_REQUEST_LANES derives from
// `worker.simultaneous_connections`. Tested are the relationships, never a magnitude.
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
    // Read through a default pacer rather than comparing the constant with its own definition.
    const lanes = PLATFORM_CATALOG['worker.simultaneous_connections'].limit.value;
    expect(PLATFORM_CATALOG['worker.simultaneous_connections'].bounds).toBe('concurrency');

    const pacer = new ProviderPacer();
    const held: Array<() => void> = [];

    for (let i = 0; i < lanes; i++) held.push(await pacer.admit(HOST));

    // Raise or lower the default and exactly one of these two fails.
    let admitted = false;

    const extra = pacer.admit(HOST).then((release) => {
      admitted = true;

      return release;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);

    held[0]();
    expect(await extra).toBeInstanceOf(Function);

    for (const release of held.slice(1)) release();
  });
});

describe('request starts are paced against one provider', () => {
  test('the lane count bounds how many requests are out at once', async () => {
    const pacer = new ProviderPacer({ lanes: 2 });
    const first = await pacer.admit(HOST);
    const second = await pacer.admit(HOST);

    // Raced against a resolved promise, not a timer, so the assertion is about ordering, not speed.
    let admitted = false;

    const third = pacer.admit(HOST).then((release) => {
      admitted = true;

      return release;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);

    first();
    expect(await third).toBeInstanceOf(Function);
    expect(admitted).toBe(true);
    second();
  });

  test('a release is idempotent, so a double `finally` cannot mint capacity', async () => {
    // A double release would grow the lane budget by one for the life of the isolate.
    const pacer = new ProviderPacer({ lanes: 1 });
    const release = await pacer.admit(HOST);
    release();
    release();

    const held = await pacer.admit(HOST);
    let admitted = false;

    const third = pacer.admit(HOST).then((releaseThird) => {
      admitted = true;

      return releaseThird;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    held();
    expect(await third).toBeInstanceOf(Function);
  });

  test('two hosts do not share a lane budget', async () => {
    // Limits are per account per provider: a fast provider queued behind a rate-limited one would stall.
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

    // B had a free lane and an instruction it could not see.
    pacer.declareWait(HOST, 30_000);
    const release = await pacer.admit(HOST);

    expect(slept).toEqual([30_000]);
    release();
  });

  test('a longer wait already in force is never shortened by a peer\'s smaller one', async () => {
    // Taking the newest `Retry-After` would converge the fan-out on the smallest value any member received.
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
    // Cooldown before lane: a lane-first caller would hold capacity during the cooldown. The single lane is
    // held here, so a lane-first implementation records no sleep.
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

    const queued = pacer.admit(HOST).then((release) => {
      admitted = true;

      return release;
    });

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

describe('a cancelled caller stops waiting', () => {
  test('an abort releases a request queued behind a full lane budget', async () => {
    // Otherwise a cancelled node waits in the queue for an unrelated release to wake it.
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

    // The refusal must cost no capacity: a leaked lane would shrink the budget permanently.
    const release = await pacer.admit(HOST);
    expect(release).toBeInstanceOf(Function);
    release();
  });
});

describe('the shared wait, without a signal', () => {
  test('abortableSleep resolves when nobody is cancelling it', async () => {
    // The subject's own timer settles by resolving, never by an abort's rejection.
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });
});
