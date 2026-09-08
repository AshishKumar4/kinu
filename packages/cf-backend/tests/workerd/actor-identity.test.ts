import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

it('a fresh native root registers its main actor before child creation', async () => {
  const controller = env.ACTOR_IDENTITY.get(env.ACTOR_IDENTITY.idFromName('fresh-proof'));
  const actor = v.parse(v.object({ state: v.string(), name: v.string(), reference: v.object({ actorId: v.string(), parentActorId: v.string(), workspaceId: v.string() }), storageKey: v.string() }), await controller.fresh());
  expect(actor.state).toBe('active');
  expect(actor.name).toBe('reader');
  expect(actor.reference.actorId).not.toBe(actor.reference.parentActorId);
  expect(actor.reference.parentActorId).not.toBe(actor.reference.workspaceId);
});

it('a late native seed and retirement cannot bind or delete its replacement', async () => {
  const controller = env.ACTOR_IDENTITY.get(env.ACTOR_IDENTITY.idFromName('lifecycle-proof'));
  const seed = v.object({ ok: v.literal(true), name: v.string(), home: v.string() });
  const failure = v.object({ reason: v.string(), error: v.string() });
  const result = v.parse(v.object({ first: seed, fresh: seed, retainedName: failure, staleSeed: failure, oldGone: v.boolean(), nextPresent: v.boolean(), distinctKeys: v.boolean(), alive: v.string() }), await controller.lifecycle());
  expect(result.first.name).toBe('reader');
  expect(result.fresh.name).toBe('reader');
  expect(result.first.home).not.toBe(result.fresh.home);
  expect(result.retainedName.reason).toBe('denied');
  expect(result.staleSeed.reason).toBe('missing');
  expect([result.oldGone, result.nextPresent, result.distinctKeys]).toEqual([true, true, true]);
  expect(result.alive).toBe('active');
});
