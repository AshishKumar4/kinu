/**
 * The sandbox tells its workspace when a restore opens and when it settles, so the page's "starting" line and
 * listing failure come from the sandbox's own word rather than a poll. A quick restore settles while its open is
 * still on the wire; the settle must not land first, or the page is left showing a box as starting that is ready.
 */
import { expect, test } from 'bun:test';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { restoreNotices } from '../src/sandbox-lifecycle';

test("a quick restore's settle waits for its open, and each tells the state as it is when it goes out", async () => {
  let restoring = true;
  const told: boolean[] = [];
  const openSent = Promise.withResolvers<void>();
  const openLanded = Promise.withResolvers<void>();
  const both = Promise.withResolvers<void>();

  const notice = restoreNotices(async () => {
    told.push(restoring);

    if (told.length === 1) {
      openSent.resolve();
      await openLanded.promise;
    }

    if (told.length === 2) both.resolve();
  });

  notice('opened');
  await openSent.promise;
  restoring = false;
  notice('settled');
  // Held behind the open still on the wire.
  await Promise.resolve();
  expect(told).toEqual([true]);

  openLanded.resolve();
  await both.promise;

  expect(told).toEqual([true, false]);
});

test('the restore steps between its open and settle tell nothing', async () => {
  let told = 0;
  const settled = Promise.withResolvers<void>();

  const notice = restoreNotices(async () => {
    told += 1;
    settled.resolve();
  });

  for (const phase of ['containerStart', 'bootId', 'attached'] as const) notice(phase);
  notice('settled');
  await settled.promise;

  expect(told).toBe(1);
});

test('a notice the workspace refuses is logged, and the next one still goes out', async () => {
  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);
  const second = Promise.withResolvers<void>();
  let calls = 0;

  try {
    const notice = restoreNotices(async () => {
      calls += 1;

      if (calls === 1) throw new Error('the workspace object is unreachable');
      second.resolve();
    });

    notice('opened');
    notice('settled');
    await second.promise;

    expect(log.emitted.map((line) => line.event)).toEqual(['sandbox.starting_notice_failed']);
  } finally {
    restore();
  }
});
