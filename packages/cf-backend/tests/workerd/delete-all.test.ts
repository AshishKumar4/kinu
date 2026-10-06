/**
 * m1924: a workspace delete could be the Durable Object `deleteAll()` alone. Measured on workerd: what a parent's
 * `deleteAll()` leaves of a facet's storage, its own tables and its alarm, against a control that only restarts it.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const ROW = 'the facet\'s row';

it('a facet restarted without a wipe reads the storage it kept', async () => {
  const probe = env.DELETE_ALL_PROBE.get(env.DELETE_ALL_PROBE.idFromName('control'));
  const kept = await probe.measure('none');

  expect(kept.facetAfter).toEqual([ROW]);
  expect(kept.parentTables).toBe(1);
});

// The shipped wipe deleted each facet first; the parent's deleteAll alone ends the same.
it.each([
  ['the parent\'s deleteAll empties its own tables, its alarm and its facet\'s storage', 'deleteAll'],
  ['deleting the facet first ends the same', 'facet-then-deleteAll'],
] as const)('%s', async (name, wipe) => {
  const probe = env.DELETE_ALL_PROBE.get(env.DELETE_ALL_PROBE.idFromName(name));

  expect(await probe.measure(wipe)).toEqual({ facetBefore: [ROW], facetAfter: [], parentTables: 0, alarmAfter: null });
});

it('a deleted workspace leaves none of its agents\' facet storage', async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('deleted-workspace-facet'));

  expect(await probe.deletedWorkspaceFacet('deleted-facet-workspace')).toEqual({ before: ['the agent\'s own row'], after: [] });
});
