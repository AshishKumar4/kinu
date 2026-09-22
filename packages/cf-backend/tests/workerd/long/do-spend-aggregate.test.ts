/**
 * Defends: the spend aggregate's `json_extract`/`SUM` semantics on the Durable
 * Object's SQLite (bun:sqlite says nothing about workerd), via the production
 * recorder, DDL and query over `ctx.storage.sql`.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { ProbeTally } from '../spend-probe';

const open = (name: string) => env.SPEND_PROBE.get(env.SPEND_PROBE.idFromName(name));

const bySource = (rows: ProbeTally[]) =>
  Object.fromEntries(rows.map((row) => [row.source, row]));

describe('the workspace spend aggregate on Durable Object SQLite', () => {
  it('sums the complete log across producers without a recent-row window', async () => {
    const subject = open('over-window');

    // Exceeds every bounded read window: the aggregate must count all rows.
    const rows = await subject.measure(2600, 600, 40);
    expect(await subject.rows()).toBe(3240);

    const spend = bySource(rows);
    expect(spend.agent).toMatchObject({ calls: 2600, callsWithoutUsage: 0, unpricedCalls: 0 });
    expect(spend.agent?.usage).toEqual({
      input: 2600 * 1800, output: 2600 * 240, cacheRead: 2600 * 1600, neurons: 2600 * 3.5,
    });
    expect(spend.agent?.usd).toBeCloseTo(2600 * 0.002, 6);
    expect(spend.judge).toMatchObject({ calls: 600, unpricedCalls: 600 });
    expect(spend.judge?.usage).toEqual({ input: 600 * 900, output: 600 * 60 });
    // No tokens reports `{}`, not zero: `SUM` over NULL must stay absent here too.
    expect(spend.platform).toMatchObject({ calls: 40, callsWithoutUsage: 40 });
    expect(spend.platform?.usage).toEqual({});
    expect(spend.platform?.usd).toBeNull();
  });

  it('a field no call reported is absent from the sum, not summed to zero', async () => {
    const subject = open('absence');

    // `SUM` of an all-NULL column must be NULL, not 0: unreported is not zero.
    const spend = bySource(await subject.measure(3, 0, 0));
    expect(Object.keys(spend.agent?.usage ?? {}).sort())
      .toEqual(['cacheRead', 'input', 'neurons', 'output']);
  });

  it('an empty log has no producers, rather than failing the read', async () => {
    // Fresh workspace: the aggregate answers over zero rows.
    expect(await open('fresh').measure(0, 0, 0)).toEqual([]);
  });
});
