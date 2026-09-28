/**
 * A Durable Object runs one event at a time only while the event does not yield to a macrotask.
 * Effect's default scheduler yields through `setImmediate` every 2,048 steps: measured 2026-09-23
 * (workerd via miniflare 5.20260903.0-alpha, effect 4.0.0-rc.117, compat 2025-12-01 and 2026-04-21),
 * a 5,000-step effect admitted 20 of 20 concurrent RPCs mid-run, 5 runs of 5. `settle` runs every
 * product effect on a microtask scheduler and admitted 0. Both halves are asserted: the premise,
 * so a platform or Effect change that removes the hazard is noticed, and the guarantee.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const STEPS = 5_000;

const CONCURRENT = 20;

async function admittedDuring(runner: 'settle' | 'default', name: string): Promise<number> {
  const probe = env.EFFECT_ATOMICITY_PROBE.get(env.EFFECT_ATOMICITY_PROBE.idFromName(name));
  // The long event is sent first, so every ping queues behind it; a ping sent first finishes first.
  const running = probe.interleaved(runner, STEPS);
  const pings = Array.from({ length: CONCURRENT }, () => probe.ping());
  const [admitted] = await Promise.all([running, ...pings]);

  return admitted;
}

describe('an effect inside a Durable Object event', () => {
  it('on the default scheduler, admits other events before it finishes', async () => {
    expect(await admittedDuring('default', 'effect-atomicity-default')).toBeGreaterThan(0);
  });

  it('under settle, admits none', async () => {
    expect(await admittedDuring('settle', 'effect-atomicity-settle')).toBe(0);
  });
});
