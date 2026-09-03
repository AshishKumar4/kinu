/**
 * The sidecar as a PROCESS: when it seals, what it does when seals pile up,
 * and what its status file says while that happens.
 *
 * WHY THIS IS SEPARATE FROM THE FORMAT TESTS. `tests/merkle-pack-v2.test.ts`
 * asks whether a generation costs what changed; this asks whether the box
 * reaches the two-second cadence at all — one long-lived runtime instead of a
 * process per checkpoint, a seal owed by time or by bytes, a barrier that
 * forces one whatever the clock says, and a backlog that folds into ONE
 * follow-up rather than a publish per trigger.
 *
 * The clock is injected, so every deadline here is a decision rather than a
 * sleep, and the loop is driven through the same `SealLoop` the entry runs.
 */

import { describe, expect, test } from 'bun:test';

import { SEAL_DIRTY_BYTES, SEAL_INTERVAL_MS, SealLoop } from '../bench/sidecar/seal-loop';
import type { SealTarget } from '../bench/sidecar/seal-loop';
import type { SealKind, SealOutcome } from '../bench/sidecar/core';
import { openSidecar } from './support/sidecar-fixture';
import { Seeded, textTree } from './support/tree-model';

/** A seal that never finishes until the test lets it, so overlap is a choice. */
class HeldTarget implements SealTarget {
  readonly started: SealKind[] = [];
  unsealedBytes = 0;
  unsealedSince: number | null = null;
  #release: (() => void)[] = [];

  async seal(kind: SealKind): Promise<SealOutcome> {
    this.started.push(kind);
    const gate = Promise.withResolvers<void>();
    this.#release.push(() => { gate.resolve(); });
    await gate.promise;
    this.unsealedBytes = 0;
    this.unsealedSince = null;
    return { kind: 'published', rootEnvelopeId: `head-${this.started.length}`, generation: String(this.started.length) };
  }

  /** Let the oldest in-flight seal finish. */
  release(): void {
    const next = this.#release.shift();
    if (next === undefined) throw new Error('no seal is in flight');
    next();
  }
}

describe('the seal cadence', () => {
  test('a seal is owed two seconds after the first unsealed write, and not before', async () => {
    let now = 1_000;
    const target = new HeldTarget();
    const loop = new SealLoop(target, () => now);

    // NOTHING WRITTEN, NOTHING OWED: an idle box does not publish.
    expect(loop.due()).toBe(false);
    expect(await loop.pump()).toBe(null);

    target.unsealedBytes = 4_096;
    target.unsealedSince = now;
    now += SEAL_INTERVAL_MS - 1;
    expect(loop.due()).toBe(false);
    expect(target.started).toEqual([]);

    now += 1;
    expect(loop.due()).toBe(true);
    const pumped = loop.pump();
    target.release();
    expect((await pumped)?.kind).toBe('published');
    expect(target.started).toEqual(['tick']);
    // The seal cleared the lag, so the next pump has nothing to do.
    expect(loop.due()).toBe(false);
  });

  test('eight MiB of unsealed bytes seals immediately, whatever the clock says', async () => {
    let now = 1_000;
    const target = new HeldTarget();
    const loop = new SealLoop(target, () => now);
    target.unsealedBytes = SEAL_DIRTY_BYTES - 1;
    target.unsealedSince = now;
    expect(loop.due()).toBe(false);

    target.unsealedBytes = SEAL_DIRTY_BYTES;
    expect(loop.due()).toBe(true);
    const pumped = loop.pump();
    target.release();
    expect((await pumped)?.kind).toBe('published');
    expect(target.started).toEqual(['tick']);
  });

  test('a barrier and a quiesce force a seal the cadence would not have run', async () => {
    const target = new HeldTarget();
    const loop = new SealLoop(target, () => 1_000);
    expect(loop.due()).toBe(false);

    const barrier = loop.force('barrier');
    target.release();
    expect((await barrier).kind).toBe('published');
    const quiesce = loop.force('quiesce');
    target.release();
    expect((await quiesce).kind).toBe('published');
    expect(target.started).toEqual(['barrier', 'quiesce']);
  });
});

describe('seals that pile up', () => {
  test('triggers during an upload fold into one follow-up seal', async () => {
    let now = 1_000;
    const target = new HeldTarget();
    const loop = new SealLoop(target, () => now);
    target.unsealedBytes = SEAL_DIRTY_BYTES;
    target.unsealedSince = now;

    // One seal in flight, three more triggers behind it. A loop that queued a
    // publish per trigger would owe four generations and eight PUTs.
    const first = loop.pump();
    const followers = [loop.force('barrier'), loop.pump(), loop.force('barrier')];
    expect(target.started).toEqual(['tick']);

    target.release();
    expect((await first)?.kind).toBe('published');
    // The three folded into ONE follow-up, and it took the strongest kind.
    expect(loop.coalesced).toBe(3);
    expect(target.started).toEqual(['tick', 'barrier']);
    target.release();
    for (const follower of followers) expect((await follower)?.kind).toBe('published');
    expect(target.started).toEqual(['tick', 'barrier']);
  });

  test('a quiesce behind a barrier claims the follow-up: the strongest kind wins', async () => {
    const target = new HeldTarget();
    const loop = new SealLoop(target, () => 1_000);
    target.unsealedBytes = SEAL_DIRTY_BYTES;
    target.unsealedSince = 1_000;
    const first = loop.force('barrier');
    const behind = [loop.pump(), loop.force('quiesce')];
    target.release();
    await first;
    expect(target.started).toEqual(['barrier', 'quiesce']);
    target.release();
    for (const one of behind) expect((await one)?.kind).toBe('published');
  });

  test('a seal that throws does not wedge the loop: the follow-up still runs', async () => {
    const failures: string[] = [];
    let attempt = 0;
    const target: SealTarget = {
      unsealedBytes: 0,
      unsealedSince: null,
      async seal(kind) {
        attempt += 1;
        if (attempt === 1) throw new Error('the stage vanished');
        failures.push(kind);
        return { kind: 'published', rootEnvelopeId: 'head', generation: '2' };
      },
    };
    const loop = new SealLoop(target, () => 1_000);
    const first = loop.force('barrier');
    const second = loop.force('quiesce');
    await expect(first).rejects.toThrow('the stage vanished');
    // THE FOLLOW-UP IS NOT THE FAILURE'S CASUALTY: it runs, and it runs as the
    // kind that asked for it.
    expect((await second).kind).toBe('published');
    expect(failures).toEqual(['quiesce']);
  });
});

describe('the status file the Durable Object reads', () => {
  test('one runtime seals many generations, and its rows say what each one did', async () => {
    let now = 10_000;
    const fixture = openSidecar({ now: () => now });
    const loop = new SealLoop(fixture.core, () => now);

    fixture.daemon.plant(textTree({ 'notes.txt': 'generation one' }));
    fixture.core.noteDirty(fixture.daemon.walBytes);
    // BEFORE THE CADENCE FIRES, the box says how far behind it is rather than
    // publishing: unsealed bytes and the age of the oldest unsealed write.
    expect(loop.due()).toBe(false);
    const waiting = fixture.core.status();
    expect(waiting.lag.unsealedBytes).toBe(fixture.daemon.walBytes);
    expect(waiting.lag.unsealedMs).toBe(0);

    now += SEAL_INTERVAL_MS;
    expect(loop.due()).toBe(true);
    const first = await loop.pump();
    if (first?.kind !== 'published') throw new Error(`the first seal answered ${String(first?.kind)}`);
    const afterFirst = fixture.core.status();
    expect(afterFirst.attach.kind).toBe('attached');
    expect(afterFirst.lag.unsealedBytes).toBe(0);
    expect(afterFirst.lag.unpublishedGenerations).toBe(0);
    expect(afterFirst.work.publish.objectsPut).toBe(3);
    expect(afterFirst.work.seal.bytesStaged).toBeGreaterThan(0);

    // A SECOND GENERATION THROUGH THE SAME RUNTIME — the point of a long-lived
    // sidecar. Its rows are that publish's, not a total across the boot.
    fixture.daemon.pwrite('notes.txt', 0, new Seeded(4).fill(new Uint8Array(8)));
    fixture.core.noteDirty(8);
    now += SEAL_INTERVAL_MS;
    const second = await loop.pump();
    if (second?.kind !== 'published') throw new Error(`the second seal answered ${String(second?.kind)}`);
    expect(second.rootEnvelopeId).not.toBe(first.rootEnvelopeId);
    const afterSecond = fixture.core.status();
    expect(afterSecond.work.publish.objectsPut).toBe(3);
    expect(afterSecond.work.publish.casAttempts).toBe(1);
    expect(afterSecond.attach.kind === 'attached' ? afterSecond.attach.generation : '').toBe(second.generation);

    // A quiesce with nothing dirty publishes NOTHING rather than an empty
    // generation, and says so.
    const idle = await loop.force('quiesce');
    expect(idle.kind).toBe('no-change');
    expect(fixture.payload.ops.filter((op) => op.op === 'put').length).toBe(4);
  });
});
