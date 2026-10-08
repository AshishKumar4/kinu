// One provider's declared cooldown, honoured by every sibling request to its host.
import { describe, test, expect } from 'bun:test';
import { ProviderPacer } from '../src/providers/pacing';

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
  test('a declared wait is what every sibling waits out before the call goes out', async () => {
    const clock = fixedClock();
    const pacer = new ProviderPacer({ now: clock.now, sleep: async (ms) => { clock.advance(ms); } });

    // B had an instruction it could not see.
    pacer.declareWait(HOST, 30_000);
    expect(pacer.cooling(HOST)?.waitMs).toBe(30_000);
    await pacer.pause(30_000);

    expect(pacer.cooling(HOST)).toBeNull();
  });

  test('a longer wait already in force is never shortened by a peer\'s smaller one', () => {
    // Taking the newest `Retry-After` would converge the fan-out on the smallest value any member received.
    const pacer = new ProviderPacer({ now: fixedClock().now });

    pacer.declareWait(HOST, 60_000);
    pacer.declareWait(HOST, 5_000);

    expect(pacer.cooling(HOST)?.waitMs).toBe(60_000);
  });

  test('another host\'s cooldown holds nobody here', () => {
    // Limits are per account per provider: a fast provider held behind a rate-limited one would stall.
    const pacer = new ProviderPacer();

    pacer.declareWait(HOST, 30_000);

    expect(pacer.cooling('api.openai.com')).toBeNull();
  });
});

describe('a cancelled caller stops waiting', () => {
  test('an abort during a declared wait rejects with the caller\'s own reason', async () => {
    const pacer = new ProviderPacer();
    pacer.declareWait(HOST, 30_000);
    const controller = new AbortController();
    const waiting = pacer.pause(pacer.cooling(HOST)?.waitMs ?? 0, controller.signal);

    controller.abort(new Error('stop pressed'));
    await expect(waiting).rejects.toThrow('stop pressed');
  });
});
