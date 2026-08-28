// Chat send admission: one synchronous latch, so two presses inside one tick
// start ONE turn. Every case here interleaves deliberately — the defect was a
// reactive guard both presses read before either had committed, so a test that
// awaits between presses cannot see it.
import { describe, test, expect } from 'bun:test';
import { abandonTurn, admitTurn, newSendLatch } from '../src/hooks/send-admission';

/** A turn whose terminal settle this test controls. */
interface DeferredTurn {
  begin: () => Promise<void>;
  finish: () => void;
  fail: (reason: Error) => void;
  starts: () => number;
}

function deferredTurn(): DeferredTurn {
  let started = 0;
  // The platform's own resolver pair, so the settle handles carry their types
  // instead of a hand-written anonymous shape restating them.
  let settle: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  return {
    begin: () => {
      started += 1;
      settle = Promise.withResolvers<void>();
      return settle.promise;
    },
    finish: () => { settle?.resolve(); },
    fail: (reason: Error) => { settle?.reject(reason); },
    starts: () => started,
  };
}

/** Let every already-queued microtask run, and nothing else. Two turns, because
 *  the release is itself queued behind the settle that triggers it. */
const settleMicrotasks = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

/**
 * The mechanism this replaced, so the assertions above are not vacuous.
 *
 * `streaming` stands for React state: a value the press READS but that only
 * becomes visible on the next render, which is why both presses saw `false`.
 */
function reactiveAdmission(): (begin: () => Promise<void>) => boolean {
  let streaming = false;
  let committed = false;
  return (begin) => {
    if (streaming) return false;
    // The write the old code relied on, deferred exactly as a render is.
    if (!committed) { committed = true; queueMicrotask(() => { streaming = true; }); }
    void begin();
    return true;
  };
}

describe('send admission', () => {
  test('two presses in the same tick start one turn', () => {
    const latch = newSendLatch();
    const turn = deferredTurn();

    // No await between these two lines. This IS the reproduction: the old guard
    // read React state that neither press had committed yet.
    const first = admitTurn(latch, turn.begin);
    const second = admitTurn(latch, turn.begin);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(turn.starts()).toBe(1);
  });

  test('NEGATIVE CONTROL: the reactive guard admits both presses', () => {
    const admit = reactiveAdmission();
    const turn = deferredTurn();

    // Same interleaving, old mechanism. Both pass, and two turns start — which
    // is the defect, and proof that the case above is testing something.
    expect(admit(turn.begin)).toBe(true);
    expect(admit(turn.begin)).toBe(true);
    expect(turn.starts()).toBe(2);
  });

  test('a refused press never calls begin, so a draft survives it', () => {
    const latch = newSendLatch();
    const held = deferredTurn();
    const refused = deferredTurn();

    expect(admitTurn(latch, held.begin)).toBe(true);
    expect(admitTurn(latch, refused.begin)).toBe(false);
    // The caller clears the composer only on `true`; proving `begin` was never
    // reached is what makes that safe.
    expect(refused.starts()).toBe(0);
  });

  test('the latch reopens when the turn finishes', async () => {
    const latch = newSendLatch();
    const first = deferredTurn();
    expect(admitTurn(latch, first.begin)).toBe(true);

    first.finish();
    await settleMicrotasks();

    const second = deferredTurn();
    expect(admitTurn(latch, second.begin)).toBe(true);
    expect(second.starts()).toBe(1);
  });

  test('a failed turn releases too — a rejection is a terminal settle', async () => {
    const latch = newSendLatch();
    const failing = deferredTurn();
    expect(admitTurn(latch, failing.begin)).toBe(true);

    failing.fail(new Error('the socket closed mid-turn'));
    await settleMicrotasks();

    expect(admitTurn(latch, deferredTurn().begin)).toBe(true);
  });

  test('a synchronous throw releases and propagates', () => {
    const latch = newSendLatch();
    const boom = new Error('the transport refused to encode this message');
    expect(() => admitTurn(latch, () => { throw boom; })).toThrow(boom);
    // Not stuck: the throw was that send's whole life.
    expect(admitTurn(latch, deferredTurn().begin)).toBe(true);
  });

  test('a stale settle cannot release a newer owner', async () => {
    const latch = newSendLatch();
    const abandoned = deferredTurn();
    expect(admitTurn(latch, abandoned.begin)).toBe(true);

    // The pane moved on — another conversation, or a reset — and a NEW turn
    // took the latch.
    abandonTurn(latch);
    const current = deferredTurn();
    expect(admitTurn(latch, current.begin)).toBe(true);

    // Now the abandoned turn finally settles. It must not open the door on the
    // turn that is genuinely live.
    abandoned.finish();
    await settleMicrotasks();

    const intruder = deferredTurn();
    expect(admitTurn(latch, intruder.begin)).toBe(false);
    expect(intruder.starts()).toBe(0);

    // …and the live turn's own settle still releases.
    current.finish();
    await settleMicrotasks();
    expect(admitTurn(latch, deferredTurn().begin)).toBe(true);
  });

  test('abandoning a free latch is not a release of the next owner', async () => {
    // Negative control for the case above: if `abandonTurn` cleared a token
    // rather than the owner, this sequence would admit twice.
    const latch = newSendLatch();
    abandonTurn(latch);
    const turn = deferredTurn();
    expect(admitTurn(latch, turn.begin)).toBe(true);
    expect(admitTurn(latch, deferredTurn().begin)).toBe(false);
    await settleMicrotasks();
    expect(admitTurn(latch, deferredTurn().begin)).toBe(false);
  });

  test('tokens never repeat, so no two sends can ever be the same owner', () => {
    const latch = newSendLatch();
    const tokens: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      admitTurn(latch, () => Promise.resolve());
      tokens.push(latch.minted);
      abandonTurn(latch);
    }
    expect(tokens).toEqual([1, 2, 3, 4, 5]);
  });
});
