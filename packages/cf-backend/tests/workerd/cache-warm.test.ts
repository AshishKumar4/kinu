/**
 * The prompt-cache warm on the timer chain, inside workerd.
 *
 * WHAT IS PLATFORM HERE, and therefore why this file is not a bun test: the
 * obligation is an `ON CONFLICT` upsert into Durable Object SQLite, the wake is
 * a real `setAlarm` delivered into a real `alarm()` frame, and the counter that
 * decides whether the warm still fires is read back IN that frame — not from a
 * field the arming activation happened to still hold. A Durable Object
 * hibernates within seconds of going idle, which is the whole interval a warm
 * waits out, so an in-memory obligation would never be there when the wake
 * arrived. The policy itself (provider, retention, cache-read evidence, the
 * three-refresh cap) is proved in packages/core/tests/unit-cache-warming.test.ts.
 *
 * The probe wires the PRODUCTION classes — `CacheWarmStore` over
 * `ctx.storage.sql`, `CacheWarmingLane` over the real policy — and records the
 * replay at the provider seam, so the assertions read the request's own
 * `max_tokens` rather than a claim about it.
 *
 * `sentAtOffsetMs` moves the last request's SEND instant into the past. Nothing
 * can advance a workerd clock, and the alternative is a test that waits four
 * minutes forty-five seconds for the vendor's TTL.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { CacheWarmReport } from './worker';

/** Five minutes minus the fifteen-second lead, plus a second, expressed as an
 *  age: a request sent this long ago is one whose refresh is due now. */
const DUE_AGE_MS = 5 * 60_000 - 15_000 + 1_000;

/** A request sent this long ago has a refresh four minutes out — armed, not
 *  due. */
const FRESH_AGE_MS = 30_000;

const DEADLINE_MS = 10_000;

const POLL_MS = 25;

describe('the prompt-cache warm on the wake chain', () => {
  const open = (name: string) => env.CACHE_WARM_PROBE.get(env.CACHE_WARM_PROBE.idFromName(name));

  /** Wait for the CONDITION, never for a fixed sleep: a timeout falls through
   *  and lets the assertion report the state actually reached. */
  const settle = async (name: string, done: (report: CacheWarmReport) => boolean): Promise<CacheWarmReport> => {
    const deadline = Date.now() + DEADLINE_MS;
    let report = await open(name).report();

    while (!done(report) && Date.now() < deadline) {
      await scheduler.wait(POLL_MS);
      report = await open(name).report();
    }

    return report;
  };

  it('fires past the TTL-minus-lead point with no real request in between, as a zero-output replay', async () => {
    const probe = open('fires');

    const at = await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });

    expect(at).not.toBeNull();
    const report = await settle('fires', (r) => r.sentMaxTokens.length > 0);

    expect(report.fires).toBeGreaterThan(0);
    // The replay the provider was handed: the previous request's body with no
    // completion allowed and no stream — "do not use `max_tokens: 1`".
    expect(report.sentMaxTokens).toEqual([0]);
    expect(report.sentStreaming).toBe(false);
    // Its spend is its own producer, never a turn's.
    expect(report.spendSources).toEqual(['warming']);
    // One warm sent, and the chain armed again for the next one.
    expect(report.nextWarmAt).not.toBeNull();
  });

  it('does not fire when a real request re-armed it', async () => {
    const probe = open('rearmed');
    await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });
    // The turn that starts before the wake lands reads and rewrites the prefix
    // itself: the counter moves, and the warm behind it is void.
    await probe.noteRealRequest();

    const report = await settle('rearmed', (r) => r.fires > 0);

    expect(report.fires).toBeGreaterThan(0);
    expect(report.sentMaxTokens).toEqual([]);
    expect(report.spendSources).toEqual([]);
    expect(report.nextWarmAt).toBeNull();
  });

  it('arms nothing for a provider that is not the official Anthropic endpoint, or a long entry', async () => {
    const gateway = open('gateway');

    expect(await gateway.armFromTurn({
      provider: 'ai-gateway', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    })).toBeNull();
    expect((await gateway.report()).nextWarmAt).toBeNull();

    const long = open('long-entry');

    expect(await long.armFromTurn({
      provider: 'anthropic', retention: 'long', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    })).toBeNull();
    expect((await long.report()).nextWarmAt).toBeNull();

    const wrote = open('wrote-prefix');

    expect(await wrote.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 0, cacheWrite: 40_000,
    })).toBeNull();
    expect((await wrote.report()).nextWarmAt).toBeNull();
  });

  it('a refused replay retires the row instead of leaving a wake to re-fire every tick', async () => {
    const probe = open('refused');
    await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });
    await probe.refuseNextSend();

    const report = await settle('refused', (r) => r.refused !== null);

    // The failure is diagnosed exactly once …
    expect(report.refused).toContain('401');
    expect(report.fires).toBeGreaterThan(0);
    // … and the obligation is gone, so the fold that arms the chain has nothing
    // past-due to answer: a row left armed here is one request a second against
    // a provider that just refused one.
    expect(report.nextWarmAt).toBeNull();
    expect(report.spendSources).toEqual([]);
  });

  it('a warm still ahead of its TTL waits, and the row survives to say so', async () => {
    const probe = open('waiting');

    const at = await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: FRESH_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });

    const report = await open('waiting').report();

    expect(report.nextWarmAt).toBe(at);
    expect(report.sentMaxTokens).toEqual([]);
    expect(report.wakes).toEqual([at]);
  });
});
