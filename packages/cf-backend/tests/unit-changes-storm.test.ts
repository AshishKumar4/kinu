// The review of 2026-09-25, in ticks: a write every tick (10 ms) for 300, a 20-tick (200 ms) walk, 1 to 3 tabs.
import { expect, test } from 'bun:test';
import { ChangeSetCache, oneAtATime, type WorkspaceDiffResult } from '@kinu.run/core';

/** Time runs in ticks of one write: a walk takes {@link WALK_TICKS} of them, and the writes go on for {@link WRITES}. */
const WRITES = 300;

const WALK_TICKS = 20;

const WALK_BOUND = WRITES / WALK_TICKS + 2;

// A storm ends as a failed bound, not a hang.
const STORM = 2_000;

/** Every callback and continuation already queued runs before this settles. */
const drained = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

async function storm(tabs: number): Promise<{ walks: number; frames: number; reads: number[]; widest: number[]; walksAtOnce: number }> {
  let walks = 0;
  let walksAtOnce = 0;
  let frames = 0;
  let tick = 0;
  const reads = Array.from({ length: tabs }, () => 0);
  const running = Array.from({ length: tabs }, () => 0);
  const widest = Array.from({ length: tabs }, () => 0);
  const pages: (() => Promise<WorkspaceDiffResult>)[] = [];
  const pending: { readonly at: number; readonly done: () => void }[] = [];
  const started: Promise<WorkspaceDiffResult>[] = [];

  const walk = async (): Promise<WorkspaceDiffResult> => {
    walks += 1;
    const done = Promise.withResolvers<void>();
    pending.push({ at: tick + WALK_TICKS, done: done.resolve });
    walksAtOnce = Math.max(walksAtOnce, pending.length);
    await done.promise;

    return { files: [], trackedSince: 0, baseline: 'b' };
  };

  const cache = new ChangeSetCache(() => {
    frames += 1;

    for (const page of pages) started.push(page());
  });

  for (let tab = 0; tab < tabs; tab++) {
    pages.push(oneAtATime(async () => {
      reads[tab] += 1;

      if (reads[tab] > STORM) return { files: [], trackedSince: 0, baseline: 'storm' };
      running[tab] += 1;
      widest[tab] = Math.max(widest[tab], running[tab]);

      try {
        return await cache.read(walk);
      } finally {
        running[tab] -= 1;
      }
    }));
  }

  for (const page of pages) started.push(page());

  for (; tick < WRITES || pending.length > 0; tick++) {
    if (tick < WRITES) cache.touched(['/home/main/notes.md']);

    for (const due of pending.filter((each) => each.at <= tick)) {
      pending.splice(pending.indexOf(due), 1);
      due.done();
    }

    await drained();
  }

  await Promise.all(started);

  return { walks, frames, reads, widest, walksAtOnce };
}

for (const tabs of [1, 2, 3]) {
  test(`a write every tick under ${String(tabs)} open tab(s) keeps walks, frames and reads bounded`, async () => {
    const run = await storm(tabs);

    expect(run.walksAtOnce).toBe(1);
    expect(run.walks).toBeLessThanOrEqual(WALK_BOUND);
    expect(run.frames).toBeLessThanOrEqual(run.walks + 1);
    expect(run.widest).toEqual(Array.from({ length: tabs }, () => 1));

    for (const reads of run.reads) expect(reads).toBeLessThanOrEqual(2 * run.frames + 2);
  });
}
