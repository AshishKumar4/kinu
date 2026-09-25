/**
 * An id-addressed first entry must not leave the workspace object nameless: after it, the page's named claim and
 * history seed answer as they would have without it. warm-forge-4d6acc02 on 2026-09-25 answered every named entry
 * with "could not determine its Durable Object name" for 62 minutes after a `supervisorOp` built the object.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('a supervisor op by id, first after an eviction, leaves the named claim and seed working', async () => {
  const probe = env.ADDRESSED_NAME_PROBE.get(env.ADDRESSED_NAME_PROBE.idFromName('addressed-name'));
  const workspace = 'addressed-name-workspace';

  expect(await probe.claimAndEvict(workspace)).toContain('the workspace object is evicted');
  expect(await probe.idThenNamed(workspace)).toEqual({
    supervisor: 'served',
    claim: 'fedcba9876543210fedcba9876543210',
    seed: '200',
  });
});

it('an object first reached by id, never named before, refuses that entry and answers its first named claim', async () => {
  const probe = env.ADDRESSED_NAME_PROBE.get(env.ADDRESSED_NAME_PROBE.idFromName('addressed-name'));

  // workerd marks an activation whose constructor threw `broken.constructorFailed` and builds a new one for the next entry.
  expect(await probe.idThenNamed('addressed-name-unclaimed')).toEqual({
    supervisor: expect.stringContaining('reached by id before any named start recorded its name'),
    claim: 'fedcba9876543210fedcba9876543210',
    seed: '200',
  });
});
