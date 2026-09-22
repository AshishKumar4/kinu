// Chat send admission: one synchronous latch, so two presses inside one tick start one turn.
// Cases interleave without awaits: a reactive guard read before either press commits is invisible otherwise.
import { describe, test, expect } from 'bun:test';
import { abandonTurn, abandonTurnIfOwner, admitTurn, newSendLatch } from '@kinu.run/core';

/** A turn whose terminal settle this test controls. */
interface DeferredTurn {
  begin: () => Promise<void>;
  finish: () => void;
  fail: (reason: Error) => void;
  starts: () => number;
}

interface DeferredSettlement {
  readonly promise: Promise<void>;
  finish(): void;
  fail(reason: Error): void;
}

function deferredTurn(): DeferredTurn {
  let started = 0;
  const unsettled: DeferredSettlement[] = [];

  return {
    begin: () => {
      started += 1;
      const settle = Promise.withResolvers<void>();
      unsettled.push({
        promise: settle.promise,
        finish: () => { settle.resolve(); },
        fail: (reason) => { settle.reject(reason); },
      });

      return settle.promise;
    },
    finish: () => {
      for (const settle of unsettled.splice(0)) settle.finish();
    },
    fail: (reason: Error) => {
      for (const settle of unsettled.splice(0)) settle.fail(reason);
    },
    starts: () => started,
  };
}

/** Two microtask turns, because the release is queued behind the settle that triggers it. */
const settleMicrotasks = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

/** The replaced mechanism, as a non-vacuity control: `streaming` stands for React state, visible only on the next render. */
function reactiveAdmission(startedTurns: Promise<void>[]): (begin: () => Promise<void>) => boolean {
  let streaming = false;
  let committed = false;

  return (begin) => {
    if (streaming) return false;

    if (!committed) { committed = true; queueMicrotask(() => { streaming = true; }); }

    const started = begin();
    startedTurns.push(started);

    return true;
  };
}

describe('send admission', () => {
  test('two presses in the same tick start one turn', () => {
    const latch = newSendLatch();
    const turn = deferredTurn();

    // No await between these two lines: that is the reproduction.
    const first = admitTurn(latch, turn.begin);
    const second = admitTurn(latch, turn.begin);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(turn.starts()).toBe(1);
  });

  test('NEGATIVE CONTROL: the reactive guard admits both presses', async () => {
    const startedTurns: Promise<void>[] = [];
    const admit = reactiveAdmission(startedTurns);
    const turn = deferredTurn();

    // Old mechanism, same interleaving: two turns start, proving the case above tests something.
    expect(admit(turn.begin)).toBe(true);
    expect(admit(turn.begin)).toBe(true);
    expect(turn.starts()).toBe(2);
    turn.finish();
    await Promise.all(startedTurns);
  });

  test('a refused press never calls begin, so a draft survives it', () => {
    const latch = newSendLatch();
    const held = deferredTurn();
    const refused = deferredTurn();

    expect(admitTurn(latch, held.begin)).toBe(true);
    expect(admitTurn(latch, refused.begin)).toBe(false);
    // The caller clears the composer only on `true`.
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
    expect(admitTurn(latch, deferredTurn().begin)).toBe(true);
  });

  test('a stale settle cannot release a newer owner', async () => {
    const latch = newSendLatch();
    const abandoned = deferredTurn();
    expect(admitTurn(latch, abandoned.begin)).toBe(true);

    abandonTurn(latch);
    const current = deferredTurn();
    expect(admitTurn(latch, current.begin)).toBe(true);

    abandoned.finish();
    await settleMicrotasks();

    const intruder = deferredTurn();
    expect(admitTurn(latch, intruder.begin)).toBe(false);
    expect(intruder.starts()).toBe(0);

    current.finish();
    await settleMicrotasks();
    expect(admitTurn(latch, deferredTurn().begin)).toBe(true);
  });

  test('abandoning a free latch is not a release of the next owner', async () => {
    // Negative control: an `abandonTurn` that cleared a token rather than the owner would admit twice.
    const latch = newSendLatch();
    abandonTurn(latch);
    const turn = deferredTurn();
    expect(admitTurn(latch, turn.begin)).toBe(true);
    expect(admitTurn(latch, deferredTurn().begin)).toBe(false);
    await settleMicrotasks();
    expect(admitTurn(latch, deferredTurn().begin)).toBe(false);
  });

  test('an abort releases only the turn it aborted, never a newer owner', () => {
    // `abortChat` awaits two RPCs; its release is conditional on still holding the token it snapshotted, or a Send admitted meanwhile starts a concurrent turn.
    const latch = newSendLatch();
    const turn = deferredTurn();
    expect(admitTurn(latch, turn.begin)).toBe(true);
    const aborting = latch.owner;
    abandonTurn(latch);
    const next = deferredTurn();
    expect(admitTurn(latch, next.begin)).toBe(true);
    abandonTurnIfOwner(latch, aborting);
    expect(latch.owner).not.toBeNull();
    expect(admitTurn(latch, deferredTurn().begin)).toBe(false);
    const free = newSendLatch();
    abandonTurnIfOwner(free, null);
    expect(admitTurn(free, deferredTurn().begin)).toBe(true);
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
