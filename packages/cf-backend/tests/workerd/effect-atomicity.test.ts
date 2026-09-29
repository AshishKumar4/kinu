/**
 * A Durable Object runs one event at a time only while the event does not yield to a macrotask.
 * Effect's default scheduler yields through `setImmediate` every 2,048 steps: measured 2026-09-23
 * (workerd via miniflare 5.20260903.0-alpha, effect 4.0.0-rc.117, compat 2025-12-01 and 2026-04-21),
 * a 5,000-step effect admitted 20 of 20 concurrent RPCs mid-run, 5 runs of 5. `settle` runs every
 * product effect on a microtask scheduler and admitted 0. Both halves are asserted: the premise,
 * so a platform or Effect change that removes the hazard is noticed, and the guarantee. Measured
 * 2026-09-28 under load: pings sent from the test could share the long event's turn, and a plain
 * `await` chain with no Effect admitted one the same way, so the pings are sent from inside it.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const STEPS = 200_000;

const CONCURRENT = 20;

async function admittedDuring(runner: 'settle' | 'default', name: string): Promise<number> {
  const probe = env.EFFECT_ATOMICITY_PROBE.get(env.EFFECT_ATOMICITY_PROBE.idFromName(name));

  return probe.interleaved(runner, STEPS, CONCURRENT);
}

describe('an effect inside a Durable Object event', () => {
  it('on the default scheduler, admits other events before it finishes', async () => {
    expect(await admittedDuring('default', 'effect-atomicity-default')).toBe(CONCURRENT);
  });

  it('under settle, admits none', async () => {
    expect(await admittedDuring('settle', 'effect-atomicity-settle')).toBe(0);
  });
});
