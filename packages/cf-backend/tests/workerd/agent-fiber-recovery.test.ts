import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const probe = (name: string) => env.FIBER_RECOVERY_PROBE.get(
  env.FIBER_RECOVERY_PROBE.idFromName(name),
);

/** The installed `agents` patch is the subject. A stale row carries malformed
 * JSON: the OLD bulk scan decodes it before checking age and this call rejects;
 * the patched scan checks age first, emits skip/delete, and reaches the fresh
 * row after it without ever materializing the stale snapshot. */
describe('the installed Agents fiber recovery scan', () => {
  it('skips an expired corrupt snapshot before decoding it and continues one fresh row at a time', async () => {
    const agent = probe('paged');
    const now = Date.now();
    await agent.seedRun('old-corrupt', 'old', '{not-json', now - 25 * 60 * 60 * 1000);
    await agent.seedRun('fresh-after', 'fresh', '{}', now);

    await agent.scan();

    expect(await agent.rows()).toEqual([]);
    // The fresh row was reached after the corrupt stale row. If the scan stops
    // after one metadata row, or still bulk-decodes snapshots, this is absent or
    // the scan rejects on `{not-json`.
    expect(await agent.recoveredIds()).toEqual(['fresh-after']);
  });
});
