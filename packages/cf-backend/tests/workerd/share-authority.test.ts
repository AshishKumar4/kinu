import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { LiveShareRecordSchema } from '@kinu.run/core';
import type { SlateShareProbeRpc } from './env';

type Probe = DurableObjectStub<SlateShareProbeRpc>;

const subject = (name: string): Probe =>
  // SAFETY: the binding is the probe worker's own class; the Rpc interface is its exact surface.
  env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName(name));

const ShareCreated = v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) });

const CLAIM = { userId: null, source: 'vitest', consented: true };

// Review of c4015d141 (MechanicalToad, 2026-10-17): authority comes from a record this host issued, never from what a call
// leaves out, and a viewer's request is held to every bound on the one server it shares.
it('R-P1 grant intersection. a viewer of the broader of two owner shares reaches only what both grant', async () => {
  const probe = subject('review-intersection');
  await probe.start();

  const broad = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'fs.write' }])).value);

  await probe.share([]);

  // One server, one storage: the narrower share's bound holds for the broader share's viewers too. Not even asked.
  expect((await probe.viewerBatch(broad.share.handle, CLAIM)).mutateError).toContain('does not reach workspace.fs.write');
  expect(await probe.ownerQueue()).toEqual([]);
});

it('R-P1 owner lineage. a shared slate calling its binding under no request of the host is refused, never taken for the owner', async () => {
  const probe = subject('review-lineage');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'fs.write' }])).value);

  // Asked by a viewer, the slate skips its runner and calls with no invocation: no write, and nothing for the owner to approve.
  expect(await probe.viewerCall(created.share.handle, CLAIM, 'raw')).toContain('called out under no request');
  expect(await probe.ownerQueue()).toEqual([]);
});

it('R-P1 stale viewer. a request admitted before the last share was revoked is refused, not promoted to the owner', async () => {
  const probe = subject('review-stale-viewer');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  expect(await probe.viewerAfterLastRevoke(created.share.handle, CLAIM, created.share.id)).toMatchObject({ ok: false, reason: 'denied' });
});

it("R-P1 in-flight launch. a launch that chose the owner's network before the slate was shared never runs with it", async () => {
  const probe = subject('review-launch-fence');
  await probe.start();
  const raced = await probe.launchAcrossShare();

  // The launch held where it took the owner's browser is stopped once shared and starts again, taking none: its image,
  // built before the share, is refused, and nothing it started is left running with the owner's network.
  expect(raced.actors).toBe(1);
  expect(raced.afterShare).toBe(1);
  expect(raced.refused).toContain("can't run while it's shared");
  expect(raced.running).toBe(0);
});

// Re-review of ccbb85a8d (MechanicalToad, 2026-10-17): the shared server is one principal.
it("R2-P1 one principal. the owner's own call of their shared slate asks them for its effect, and runs once they approve", async () => {
  const probe = subject('review2-owner-own');

  await probe.start();
  await probe.share([{ namespace: 'workspace', member: 'fs.write' }]);
  const seen = await probe.ownersOwnWrite();

  expect(seen.first).toContain('waits for the owner to approve it: fs.write on workspace');
  expect(seen.asked).toEqual(['the owner:fs.write']);
  expect(seen.second).not.toContain('waits for the owner');
  expect(seen.after).toBe(0);
});

it("R2-P1 hop lineage. a slate the shared one hops to is held to the shared server's bound, for a viewer and the owner alike", async () => {
  const probe = subject('review2-hop');

  await probe.start();
  // The hop is in the board's graph, so its share grants it; the digest's write under it the board's share does not.
  await probe.exerciseHop();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);
  const seen = await probe.hopWrites(created.share.handle, CLAIM);

  // The hop runs; its write, a leaf of the digest under the board's request, meets the board's bound and is refused.
  expect(seen.viewer).toContain('does not reach workspace.fs.write');
  expect(seen.owner).toContain('does not reach workspace.fs.write');
  expect(seen.asked).toBe(0);
});

// Third review of 451b3cd58 (MechanicalToad, 2026-10-17).
it('R3-P1 unbounded send. an owner\'s call that began unshared is not sent once its slate is shared while it prepared', async () => {
  const probe = subject('review3-unbounded');

  await probe.start();
  const seen = await probe.ownersHeldWrite();

  // Its process ends with the share, and the write it was preparing is not sent: unshared when it began is no permission.
  expect(seen.answered).not.toContain('null');
  expect(seen.written).toBe(false);
});

it('R3-P1 inherited bound. a slate the shared one hops to stays bounded by it when its own code names no request', async () => {
  const probe = subject('review3-inherited');

  await probe.start();
  await probe.exerciseHop('rawWrite');
  await probe.share();
  const seen = await probe.inheritedRaw();

  expect(seen.answered).toContain('called out under no request');
  expect(seen.written).toBe(false);
});

it('R3-P2 one environment. a call the shared server makes runs in its environment whoever asked; unshared, in the owner\'s', async () => {
  const probe = subject('review3-environment');

  await probe.start();
  await probe.ownerCall('probe');
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);
  const shared = (await probe.environments()).length;

  await probe.ownerCall('probe');
  await probe.viewerCall(created.share.handle, CLAIM, 'probe');
  const environments = await probe.environments();

  expect(environments[0]).toBe('fs.text:owner');
  expect(environments.slice(shared)).toEqual(['fs.text:shared', 'fs.text:shared']);
});

// Fourth review of 870c59e83 (MechanicalToad, 2026-10-17): a bound inherited through a shared slate, and a member a running
// tool reaches inside itself, end with the sharing they began under.
it('R4-P1 inherited chain. a slate the shared one hopped to acts no more once its last share is revoked, naming no request', async () => {
  const probe = subject('review4-inherited');

  await probe.start();
  await probe.exerciseHop('gatedRaw');
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);
  const seen = await probe.inheritedAfterRevoke(created.share.id);

  // Stopped with the board's own processes; and run again as it was minted, refused by the board's sealed sharing.
  expect(seen.inheriting).toBe(0);
  expect(seen.retained).toContain('Slate board\'s sharing changed since slate digest was started under it');
  expect(seen.written).toBe(false);
});

it('R4-P1 nested lineage. a member a running tool reaches inside itself is refused once its slate\'s sharing changed', async () => {
  const probe = subject('review4-nested');

  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);
  const [shared, revoked, ...more] = await probe.craftedAcrossRevoke(created.share.id);

  // Shared, its grant never reached the member; revoked while the tool ran, it is not the owner's for that.
  expect(shared).toContain('does not reach workspace.fs.write');
  expect(revoked).toContain('started before its sharing changed');
  expect(more).toEqual([]);
});

// Fifth review of a841655f8 (MechanicalToad, 2026-10-19): a launch is held to every sharing sealed in it once it is started.
it('R5-P2 inherited launch. a callee started while a shared slate above it stops sharing is stopped, never left registered', async () => {
  const probe = subject('review5-inherited-launch');

  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);
  const seen = await probe.inheritedLaunchAcrossRevoke(created.share.id);

  // The board's call ends with the board's own process. The digest it started under the board's sharing is refused
  // once it is up, and stopped, never left registered.
  expect(seen.answered).not.toContain('digest-ok');
  expect(seen.started).toContain("Slate board's sharing changed since slate digest was started under it");
  expect(seen.inheriting).toBe(0);
  expect(seen.leftRunning).toBe(0);
});

