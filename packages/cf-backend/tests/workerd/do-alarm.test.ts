/**
 * The Durable Object alarm, fired through workerd (bun has no alarm). Defends the platform behaviours the
 * timer chain relies on; the SDK's `_cf_runAlarmBody` dispatch is not run here.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AlarmReport } from './worker';

const ARM_MS = 200;

/** Bounds only how long a broken platform gets; waits stop at the condition. */
const DEADLINE_MS = 10_000;

const POLL_MS = 50;

describe('DurableObjectStorage alarms', () => {
  const open = (name: string) => env.ALARMED.get(env.ALARMED.idFromName(name));

  /** Redelivery backoff is unspecified by the runtime, so wait for the condition; a timeout falls through to the assertion. */
  const settle = async (name: string, done: (report: AlarmReport) => boolean): Promise<AlarmReport> => {
    const deadline = Date.now() + DEADLINE_MS;
    let report = await open(name).report();

    while (!done(report) && Date.now() < deadline) {
      await scheduler.wait(POLL_MS);
      report = await open(name).report();
    }

    return report;
  };

  it('an armed alarm is delivered and the write it makes is durable', async () => {
    await open('fires').arm(ARM_MS);

    const report = await settle('fires', (r) => r.completed);

    // `next: null` is the runtime clearing the slot on a delivery it considers final.
    expect(report).toEqual({ fires: 1, completed: true, next: null });
  });

  it('a second setAlarm replaces the first instead of queueing beside it', async () => {
    // A slot that queued would deliver twice.
    await open('one-slot').armTwice(ARM_MS, ARM_MS * 2);

    // Fixed wait: an absence cannot be polled; it must outlast the later alarm by a clear margin.
    await scheduler.wait(ARM_MS * 5);

    // One alarm row per object is what makes `armTimer`'s soonest-wins dedup safe.
    expect(await open('one-slot').report()).toMatchObject({ fires: 1, completed: true });
  });

  it('a handler that throws is redelivered until it succeeds', async () => {
    await open('flaky').armFlaky(ARM_MS, 1);

    const report = await settle('flaky', (r) => r.completed);

    // `_executeScheduleCallback` rethrows code-update resets, transient errors and memory kills so the
    // row survives and the runtime redelivers; a final throw would drop schedules on every deploy.
    expect(report.fires).toBeGreaterThan(1);
    expect(report.completed).toBe(true);
    // The retry converges: the slot is empty once delivery succeeded.
    expect(report.next).toBeNull();
  });
});
