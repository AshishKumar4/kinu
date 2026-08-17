/**
 * Defect 1, executed. `ctx.waitUntil` inside a Durable Object does not retain
 * work, and is the same code path as a bare floating promise.
 *
 * WHAT WE HAD BEFORE THIS FILE. The rule
 * `anti-slop/no-wait-until-in-durable-object` rejects the shape, and
 * `unit-alarm-chain-contract.test.ts:103-113` greps `orchestrator.ts` for the
 * absence of the string `this.ctx.waitUntil(`. Both are correct and both assert
 * TEXT. The reason they are correct — that workerd routes an actor's
 * `waitUntil` through `IoContext::addTask` ("In Actors, we treat all tasks as
 * wait-until tasks") and cancels it in `drain()` under a `result.catch_` that
 * swallows the exception — was established once by a deployed probe and by
 * reading workerd's C++. Nothing in CI re-establishes it. If the platform ever
 * changed, our rule's stated rationale would become false and every gate we own
 * would stay green. This file is the missing half.
 *
 * WHY `bun test` CANNOT HOST IT. There is no output gate, no actor, and no
 * shutdown drain in bun. All three arms below are bit-identical there: the
 * promise settles and the write lands, whichever retention verb was used. The
 * arms only separate inside workerd.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Long enough that a fast return is unambiguous, short enough to stay far from
 *  the 30s `blockConcurrencyWhile` cancel threshold. */
const ARM_DELAY_MS = 700;
/** Past the arm delay, so "the write never landed" cannot mean "we looked
 *  early". */
const SETTLE_MS = ARM_DELAY_MS * 2;

describe('DurableObjectState.waitUntil', () => {
  // A stub held across a reset is itself broken by the reset ("Application
  // called abortAllDurableObjects()"), which is the platform telling us the
  // instance is gone. The id survives; the stub does not. Re-acquiring is what
  // a real caller does on the next request.
  const reopen = (name: string) => env.RETENTION.get(env.RETENTION.idFromName(name));

  it('the shipped shape holds the invocation open until the write commits, and survives a reset', async () => {
    const startedAt = Date.now();
    await reopen('awaited').scheduleAwaited(ARM_DELAY_MS);
    const elapsed = Date.now() - startedAt;

    // The output gate is the entire retention this object has: the caller could
    // not have returned before the row committed.
    expect(elapsed).toBeGreaterThanOrEqual(ARM_DELAY_MS);

    await abortAllDurableObjects();
    expect(await reopen('awaited').armedAt()).toBeTypeOf('number');
  });

  it('waitUntil returns immediately and the write is lost to a reset', async () => {
    const startedAt = Date.now();
    await reopen('wait-until-reset').scheduleViaWaitUntil(ARM_DELAY_MS);
    const elapsed = Date.now() - startedAt;

    // The pre-fix docstring claimed the write "lands even if the caller's
    // invocation ends first". The invocation ends here, ~700ms early.
    expect(elapsed).toBeLessThan(ARM_DELAY_MS);

    await abortAllDurableObjects();
    await scheduler.wait(SETTLE_MS);
    expect(await reopen('wait-until-reset').armedAt()).toBeUndefined();
  });

  it('a bare floating promise is lost the same way — waitUntil bought nothing', async () => {
    await reopen('floating-reset').scheduleFloating(ARM_DELAY_MS);
    await abortAllDurableObjects();
    await scheduler.wait(SETTLE_MS);

    expect(await reopen('floating-reset').armedAt()).toBeUndefined();
  });

  // The denominator. Without this the two `toBeUndefined()` assertions above
  // are satisfied by an arm that never wrote anything, a broken binding, or a
  // typo in the storage key — the vacuous-pass shape every gate in this repo
  // carries a control against.
  it('the same waitUntil write DOES land when nothing resets the object', async () => {
    await reopen('wait-until-alive').scheduleViaWaitUntil(ARM_DELAY_MS);
    await scheduler.wait(SETTLE_MS);

    expect(await reopen('wait-until-alive').armedAt()).toBeTypeOf('number');
  });
});
