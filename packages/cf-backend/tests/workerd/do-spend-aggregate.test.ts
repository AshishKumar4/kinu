/**
 * The workspace spend total, summed by the platform rather than by us.
 *
 * WHAT WE HAD BEFORE THIS FILE. The producer totals were folded in TypeScript
 * over a bounded recent-rows read, so nothing about them depended on the
 * database beyond `SELECT payload`. They are now one SQL aggregate — `WITH`
 * CTEs over `json_extract(payload, …)` — because a total that is folded a window
 * at a time is a floor, and the panel that rendered it said so only in small
 * text beside a figure the owner decides on.
 *
 * That trade moved the risk. Every other test of this read runs under
 * `bun test`, against `bun:sqlite`, and a JSON1 function present there says
 * nothing about workerd. If the Durable Object's SQLite answered
 * `no such function: json_extract`, the cost panel would throw on its first
 * render in production with the whole bun suite green — the shape of every
 * runtime defect this project has shipped.
 *
 * So this asserts the platform, not our arithmetic: the production recorder,
 * the production DDL, the production query, over `ctx.storage.sql`.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { ProbeTally } from './spend-probe';

const open = (name: string) => env.SPEND_PROBE.get(env.SPEND_PROBE.idFromName(name));
const bySource = (rows: ProbeTally[]) =>
  Object.fromEntries(rows.map((row) => [row.source, row]));

describe('the workspace spend aggregate on Durable Object SQLite', () => {
  it('sums every row of a log longer than any window it used to be read over', async () => {
    const subject = open('over-window');

    // 2600 + 600 + 40. Past `readRecentByType`'s 200-row default, past this
    // backend's own ACTIVITY_STEP_WINDOW of 400, and past the CLI's former
    // SPEND_WINDOW of 2000. Under the windowed fold the agent row came back as
    // 2000 calls here and the panel called that the workspace total.
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
    // A silent provider: 40 calls, no tokens, and `{}` rather than a zero — the
    // absence `SUM` over a NULL column has to survive on this database too.
    expect(spend.platform).toMatchObject({ calls: 40, callsWithoutUsage: 40 });
    expect(spend.platform?.usage).toEqual({});
    expect(spend.platform?.usd).toBeNull();
  });

  it('a field no call reported is absent from the sum, not summed to zero', async () => {
    const subject = open('absence');

    // Nothing written here reports `cacheWrite` or `reasoning`. On this database
    // `SUM` of an all-NULL column must come back NULL, which is what keeps
    // "nobody mentioned caching" distinguishable from "every call read nothing
    // from cache". A platform that returned 0 instead would print a measurement
    // where there is none.
    const spend = bySource(await subject.measure(3, 0, 0));
    expect(Object.keys(spend.agent?.usage ?? {}).sort())
      .toEqual(['cacheRead', 'input', 'neurons', 'output']);
  });

  it('an empty log has no producers, rather than failing the read', async () => {
    // The first render of a fresh workspace. The DDL has to exist and the
    // aggregate has to answer over zero rows.
    expect(await open('fresh').measure(0, 0, 0)).toEqual([]);
  });
});
