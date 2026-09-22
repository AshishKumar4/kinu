import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const probe = (name: string) => env.FIBER_RECOVERY_PROBE.get(
  env.FIBER_RECOVERY_PROBE.idFromName(name),
);

/** The installed `agents` patch: the scan checks a stale row's age before decoding its malformed JSON,
 * so it skips/deletes it and reaches the fresh row after it. */
describe('the installed Agents fiber recovery scan', () => {
  it('skips an expired corrupt snapshot before decoding it and continues one fresh row at a time', async () => {
    const agent = probe('paged');
    const now = Date.now();
    await agent.seedRun('old-corrupt', 'old', '{not-json', now - 25 * 60 * 60 * 1000);
    await agent.seedRun('fresh-after', 'fresh', '{}', now);

    await agent.scan();

    expect(await agent.rows()).toEqual([]);
    expect(await agent.recoveredIds()).toEqual(['fresh-after']);
  });
});
