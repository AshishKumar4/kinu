import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

const Counts = v.object({ actors: v.number(), events: v.number(), historicalId: v.nullable(v.string()),
  legacyConfig: v.array(v.object({ key: v.string(), value: v.string() })),
  legacyState: v.array(v.object({ key: v.string(), value: v.string(), updated_at: v.number() })), liveConfig: v.number(), liveState: v.number() });
const Result = v.object({ before: Counts, after: Counts, archiveLines: v.array(v.string()),
  children: v.object({ view: v.literal('children'), page: v.object({ items: v.array(v.object({ name: v.string(), status: v.string(), actorReference: v.null() })) }) }),
  frames: v.array(v.object({ reason: v.string(), type: v.string() })),
  failures: v.array(v.object({ reason: v.string(), error: v.string() })), page: v.object({ items: v.array(v.object({ content: v.string() })) }) });

it('an unimported native root preserves owner reads and refuses runtime entry', async () => {
  const controller = env.ACTOR_IDENTITY.get(env.ACTOR_IDENTITY.idFromName('legacy-proof'));
  const result = v.parse(Result, await controller.legacy());
  expect(result.before).toEqual({ actors: 0, events: 1, historicalId: 'historic-observed-id', legacyConfig: [{ key: 'model', value: 'legacy-model' }], legacyState: [{ key: 'saved', value: '{"legacy":true}', updated_at: 1 }], liveConfig: 0, liveState: 0 });
  expect(result.after).toEqual(result.before);
  expect(result.failures.map((failure) => failure.reason)).toEqual(['missing', 'missing', 'missing', 'missing']);
  expect(result.frames.map((frame) => frame.reason)).toEqual(['missing', 'missing']);
  expect(result.archiveLines.join('\n')).toContain('historic-observed-id');
  expect(result.archiveLines.join('\n')).toContain('preserve this');
  expect(result.page.items.map((message) => message.content)).toEqual(['preserve this']);
  expect(result.children.page.items).toEqual([{ name: 'retained-child', status: 'dismissed', actorReference: null }]);
});

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
