/**
 * Defect 1: `ctx.waitUntil` inside a Durable Object does not retain work after the invocation returns (workerd's
 * `IoContext::addTask` cancels it in `drain()`). Re-establishes the premise of `anti-slop/no-wait-until-in-durable-object`;
 * the arms only separate inside workerd.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Long enough that a fast return is unambiguous, far below the `blockConcurrencyWhile` cancel threshold. */
const ARM_DELAY_MS = 700;

const SETTLE_MS = ARM_DELAY_MS * 2;

describe('DurableObjectState.waitUntil', () => {
  // A stub held across a reset is broken by it ("Application called abortAllDurableObjects()"); the id survives.
  const reopen = (name: string) => env.RETENTION.get(env.RETENTION.idFromName(name));

  it('the shipped shape holds the invocation open until the write commits, and survives a reset', async () => {
    const startedAt = Date.now();
    await reopen('awaited').scheduleAwaited(ARM_DELAY_MS);
    const elapsed = Date.now() - startedAt;

    // The output gate is this object's entire retention: the caller could not return before the row committed.
    expect(elapsed).toBeGreaterThanOrEqual(ARM_DELAY_MS);

    await abortAllDurableObjects();
    expect(await reopen('awaited').armedAt()).toBeTypeOf('number');
  });

  it('waitUntil returns immediately and the write is lost to a reset', async () => {
    const startedAt = Date.now();
    await reopen('wait-until-reset').scheduleViaWaitUntil(ARM_DELAY_MS);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(ARM_DELAY_MS);

    await abortAllDurableObjects();
    await scheduler.wait(SETTLE_MS);
    expect(await reopen('wait-until-reset').armedAt()).toBeUndefined();
  });

  // The denominator: rules out a broken binding or a mistyped storage key satisfying the assertion above.
  it('the same waitUntil write DOES land when nothing resets the object', async () => {
    await reopen('wait-until-alive').scheduleViaWaitUntil(ARM_DELAY_MS);
    await scheduler.wait(SETTLE_MS);

    expect(await reopen('wait-until-alive').armedAt()).toBeTypeOf('number');
  });
});
