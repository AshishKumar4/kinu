/**
 * The prompt-cache warm on the timer chain, in workerd: a Durable Object hibernates while the warm waits,
 * so the obligation must live in DO SQLite and be read back inside the real `alarm()` frame.
 * Policy is proved in packages/core/tests/unit-cache-warming.test.ts; `sentAtOffsetMs` stands in for advancing the clock.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** A request sent this long ago has its refresh due now. */
const DUE_AGE_MS = 5 * 60_000 - 15_000 + 1_000;

const FRESH_AGE_MS = 30_000;

describe('the prompt-cache warm on the wake chain', () => {
  const open = (name: string) => env.CACHE_WARM_PROBE.get(env.CACHE_WARM_PROBE.idFromName(name));

  it('fires past the TTL-minus-lead point with no real request in between, as a zero-output replay', async () => {
    const probe = open('fires');

    const at = await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });

    expect(at).not.toBeNull();
    // `reportAfterWake` resolves at the end of the alarm frame, so this is the state that frame left.
    const report = await probe.reportAfterWake();

    expect(report.fires).toBeGreaterThan(0);
    expect(report.sentMaxTokens).toEqual([0]);
    expect(report.sentStreaming).toBe(false);
    expect(report.spendSources).toEqual(['warming']);
    expect(report.nextWarmAt).not.toBeNull();
  });

  it('does not fire when a real request re-armed it', async () => {
    const probe = open('rearmed');
    await probe.armFromTurn({
      provider: 'anthropic', retention: 'short', sentAtOffsetMs: DUE_AGE_MS, cacheRead: 40_000, cacheWrite: 0,
    });
    // A turn starting before the wake rewrites the prefix itself, voiding the warm.
    await probe.noteRealRequest();

    const report = await probe.reportAfterWake();

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

    const report = await probe.reportAfterWake();

    expect(report.refused).toContain('401');
    expect(report.fires).toBeGreaterThan(0);
    // A row left armed here would be one request a second against a provider that just refused one.
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
