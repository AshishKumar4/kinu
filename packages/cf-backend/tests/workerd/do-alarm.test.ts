/**
 * The Durable Object alarm, fired. Two platform behaviours the timer chain is
 * built on, neither of which had ever been observed in CI.
 *
 * WHAT WE HAD BEFORE THIS FILE. Two guards over the alarm, both reading TEXT: a
 * regex for an `alarm()` override missing its `super.alarm()`
 * (`unit-alarm-chain-contract.test.ts`) and an AST walk. They exist because
 * shadowing `alarm()` once silently stopped every scheduled callback for two
 * months — no error, no failed request, just nothing waking up. The nearest
 * behavioural test reaches the tick by calling `_proteusTimerTick()` directly
 * (`unit-alarm-tracing.test.ts`), which runs the BODY and never the dispatch.
 * Nothing anywhere invoked `alarm()` through the runtime.
 *
 * WHY `bun test` CANNOT HOST IT. There is no alarm outside workerd. The bun fake
 * for the Agent SDK does not mention alarm, schedule or setAlarm at all, so the
 * dispatch path it stands in for is absent rather than faked.
 *
 * WHAT IS STILL NOT COVERED, so this file is not read as more than it is: the
 * SDK's own dispatch chain. These tests fire a real alarm and observe the
 * runtime's contract around it; they do not run `_cf_runAlarmBody`, so a shadowed
 * `alarm()` in a production class remains a regex's problem.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AlarmReport } from './worker';

const ARM_MS = 200;
/** Generous, because it is never spent on a passing run: the waits below stop at
 *  the condition. It bounds only how long a BROKEN platform is given before the
 *  assertion reports whatever state it reached. */
const DEADLINE_MS = 10_000;
const POLL_MS = 50;

describe('DurableObjectStorage alarms', () => {
  const open = (name: string) => env.ALARMED.get(env.ALARMED.idFromName(name));

  /**
   * Redelivery backoff is the runtime's schedule and is not specified anywhere we
   * can cite, so waiting for the CONDITION is the only honest shape: a fixed
   * sleep would either assert a backoff we were never promised or pay for the
   * worst case on every green run. A timeout is not an error here — it falls
   * through and lets the assertion report the state actually reached.
   */
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

    // The denominator for everything below, and by itself the first observation
    // in this repository that an alarm arrives at all. `next: null` is the
    // runtime clearing the slot on a delivery it considers final.
    expect(report).toEqual({ fires: 1, completed: true, next: null });
  });

  it('a second setAlarm replaces the first instead of queueing beside it', async () => {
    // Armed for +200ms then +400ms. A slot that queued would deliver twice.
    await open('one-slot').armTwice(ARM_MS, ARM_MS * 2);

    // The one place a fixed wait is the right instrument: the claim is that a
    // second delivery NEVER arrives, and no condition can be polled for an
    // absence. This has to outlast the later of the two alarms by a clear margin.
    await scheduler.wait(ARM_MS * 5);

    // This is what makes `armTimer`'s soonest-wins dedup a correct optimisation
    // rather than a lost wake-up: collapsing many schedules onto one row is only
    // safe because the object HAS one row. If this ever became 2, every collapsed
    // schedule in `cf_agents_schedules` would dispatch once per collision.
    expect(await open('one-slot').report()).toMatchObject({ fires: 1, completed: true });
  });

  it('a handler that throws is redelivered until it succeeds', async () => {
    await open('flaky').armFlaky(ARM_MS, 1);

    const report = await settle('flaky', (r) => r.completed);

    // The backstop the SDK deliberately depends on: `_executeScheduleCallback`
    // rethrows a code-update reset, a transient platform error and a memory kill
    // precisely so the row survives and the RUNTIME redelivers. If an uncaught
    // throw out of `alarm()` were final, every schedule caught by a deploy would
    // be dropped silently — the same shape as the two-month outage above, and
    // invisible for the same reason.
    expect(report.fires).toBeGreaterThan(1);
    expect(report.completed).toBe(true);
    // And the retry converges rather than spinning: the slot is empty once the
    // delivery succeeded.
    expect(report.next).toBeNull();
  });
});
