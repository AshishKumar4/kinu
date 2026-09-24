// One provider's declared cooldown, honoured by every sibling request to its host.
import { describe, test, expect } from 'bun:test';
import { ProviderPacer, abortableSleep } from '../src/providers/pacing';

/** A pacer on a hand-cranked clock, so a declared wait costs the suite nothing. */
function fixedClock(startMs = 1_000_000) {
  let nowMs = startMs;

  return {
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
  };
}

const HOST = 'api.cloudflare.com';

describe('a wait one caller was told to take holds its siblings', () => {
  test('a declared wait is honoured before the call goes out', async () => {
    const clock = fixedClock();
    const slept: number[] = [];

    const pacer = new ProviderPacer({
      now: clock.now,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

    // B had an instruction it could not see.
    pacer.declareWait(HOST, 30_000);
    await pacer.admit(HOST);

    expect(slept).toEqual([30_000]);
  });

  test('a longer wait already in force is never shortened by a peer\'s smaller one', async () => {
    // Taking the newest `Retry-After` would converge the fan-out on the smallest value any member received.
    const clock = fixedClock();
    const slept: number[] = [];

    const pacer = new ProviderPacer({
      now: clock.now,
      sleep: async (ms) => { slept.push(ms); clock.advance(ms); },
    });

    pacer.declareWait(HOST, 60_000);
    pacer.declareWait(HOST, 5_000);
    await pacer.admit(HOST);

    expect(slept).toEqual([60_000]);
  });

  test('another host\'s cooldown holds nobody here', async () => {
    // Limits are per account per provider: a fast provider held behind a rate-limited one would stall.
    const slept: number[] = [];
    const pacer = new ProviderPacer({ sleep: async (ms) => { slept.push(ms); } });

    pacer.declareWait(HOST, 30_000);
    await pacer.admit('api.openai.com');

    expect(slept).toEqual([]);
  });
});

describe('a cancelled caller stops waiting', () => {
  test('an abort during a declared wait rejects with the caller\'s own reason', async () => {
    const pacer = new ProviderPacer();
    pacer.declareWait(HOST, 30_000);
    const controller = new AbortController();
    const waiting = pacer.admit(HOST, controller.signal);

    controller.abort(new Error('stop pressed'));
    await expect(waiting).rejects.toThrow('stop pressed');
  });

  test('an already-aborted caller is refused before the call goes out', async () => {
    const pacer = new ProviderPacer();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(pacer.admit(HOST, controller.signal)).rejects.toThrow('already gone');
  });
});

describe('the shared wait, without a signal', () => {
  test('abortableSleep resolves when nobody is cancelling it', async () => {
    // The subject's own timer settles by resolving, never by an abort's rejection.
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });
});
