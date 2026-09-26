/**
 * An unattributed diagnostics line lands under its own workspace's digest whether it ran in an RPC
 * method, an alarm or a line logged after its call returned, inside another workspace's call. 98.6% of event rows in the 7 days to
 * 2026-09-26 had no workspace, so no fleet rule could group by one.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { analyticsDigest } from '@kinu.run/core/analytics';

const EVENTS = ['probe.alarm_line', 'probe.detached_line', 'probe.rpc_line'];

it('two workspaces each log three ways, and every line is filed under its own workspace', async () => {
  const probe = env.ATTRIBUTION_PROBE.get(env.ATTRIBUTION_PROBE.idFromName('attribution'));
  const workspaces = ['attribution-amber', 'attribution-birch'];

  const [amber = '', birch = ''] = workspaces;
  await Promise.all(workspaces.map((name) => probe.logThreeWays(name)));

  // Amber's held request answers only after amber's call returned, and only while birch's release is open.
  const order = await probe.releaseLineOf(birch, amber);
  await probe.releaseLineOf(amber, birch);
  const at = (entry: string) => order.indexOf(entry);

  expect(at(`${amber} returned`)).toBeGreaterThanOrEqual(0);
  expect(at(`${amber} returned`)).toBeLessThan(at(`release ${amber}`));
  expect(at(`release ${amber}`)).toBeLessThan(at(`${amber} logged detached`));
  expect(at(`${amber} logged detached`)).toBeLessThan(at(`release ${amber} answered`));

  // The alarms land on their own; the probe answers once all six lines have.
  const lines = await probe.written(workspaces[0] ?? '', EVENTS.length * workspaces.length);

  for (const name of workspaces) {
    const own = lines.filter((line) => line.index === analyticsDigest(name)).map((line) => line.event).sort();
    expect(own).toEqual(EVENTS);
  }

  expect(lines.filter((line) => line.index === '')).toEqual([]);
});
