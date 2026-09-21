import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { LiveShareRecordSchema, ViewerRequestRecordSchema } from '@kinu.run/core';
import type { SlateShareProbeRpc } from './env';

type Probe = DurableObjectStub<SlateShareProbeRpc>;

const subject = (name: string): Probe =>
  // SAFETY: the binding is the probe worker's own class; the Rpc interface is its exact surface.
  env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName(name)) as Probe;

const ShareCreated = v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) });

const Requests = v.object({ ok: v.literal(true), value: v.array(ViewerRequestRecordSchema) });

const CLAIM = { userId: null, source: 'vitest', consented: true };

it('a public share serves the slate, admits the granted member, refuses the rest and audits all of it', async () => {
  const probe = subject('live-share');
  await probe.start();
  const shared = await probe.share();
  expect(shared, JSON.stringify(shared)).toMatchObject({ ok: true });
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), shared).value);
  const handle = created.share.handle;

  expect(created.url).toBe(`https://${handle}.share.test/`);

  // The plain GET reaches the authored fetch through the port hop.
  expect(await probe.viewerFetch(handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });

  // The batch arm: probe() reads the granted member; mutate() is refused at
  // the grant, before the member runs.
  const batch = await probe.viewerBatch(handle, CLAIM);
  expect(batch.probe).toBe('fixture-bytes');
  expect(batch.mutateError).toContain('does not grant');

  // The socket arm: the same calls over the session the upgrade opens, and
  // its invocation retires on close — a replay of it refuses 'not running'.
  const socket = await probe.viewerSocket(handle, CLAIM);
  expect(socket.probe).toBe('fixture-bytes');
  expect(socket.mutateError).toContain('does not grant');

  const replay = await probe.replay(created.share.id);
  expect(replay).toMatchObject({ ok: false, reason: 'denied' });
  expect('error' in replay && replay.error).toContain('not running');

  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;

  expect(rows.map((row) => [row.viewer, row.path, row.outcome])).toEqual([
    ['source:vitest', '/__rpc', 'closed'],
    ['source:vitest', '/__rpc', 'ok'],
    ['source:vitest', '/', 'ok'],
  ]);
  expect(rows[0]?.calls).toEqual([
    { slate: 'board', binding: 'FILES', member: 'readFile', effect: 'read', ok: true },
    { slate: 'board', binding: 'FILES', member: 'writeFile', effect: 'mutate', ok: false },
  ]);
  expect(rows[1]?.calls).toEqual(rows[0]?.calls);
  expect(rows[2]?.calls).toEqual([]);
});

it('a revoked share refuses the route and stops the process it carried', async () => {
  const probe = subject('live-revoke');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  expect((await probe.viewerFetch(created.share.handle, CLAIM)).status).toBe(200);

  await probe.revoke(created.share.id);

  expect((await probe.viewerFetch(created.share.handle, CLAIM)).status).toBe(404);
  expect(await probe.stopped()).toBe(true);
});


it('a shared slate still serves after the object that ran it is evicted', async () => {
  // S6's durability leg: the share row and the slate's source live in the
  // object's own storage, so a cold request re-reads both and re-boots the
  // slate rather than answering 404.
  const probe = () => subject('live-evict');
  await probe().start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe().share()).value);

  expect(await probe().viewerFetch(created.share.handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });

  await abortAllDurableObjects();

  expect(await probe().viewerFetch(created.share.handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });
});
