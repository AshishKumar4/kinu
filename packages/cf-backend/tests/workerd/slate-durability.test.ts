/**
 * A slate is a durable Nimbus application: its preview URL is minted from a
 * reservation in the workspace object's storage, and a request that arrives
 * after the isolate that served it is gone re-drives the process rather than
 * 404ing. `abortAllDurableObjects()` is that eviction: every object in the
 * pool — the probe root, the orchestrator, the retained facet — is destroyed,
 * and only its storage survives.
 *
 * WHY `bun test` CANNOT HOST IT. There is no `abortAllDurableObjects`, no
 * `ctx.facets`, and no `ctx.storage` reservation table outside workerd — the
 * three things the assertion is about are all platform semantics.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('a slate survives eviction on its own URL', async () => {
  // A stub held across the reset is itself broken by it ("Application called
  // abortAllDurableObjects()"): the id survives, the stub does not — so the
  // subject is re-acquired the way a real caller's next request re-resolves.
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('survives'));

  const boot = await subject().serveSlate({
    workspace: 'durability-keep', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // The URL answers before the eviction too: the 200 below is the re-drive,
  // not a slate that only ever ran cold.
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });
  expect(boot.reservations).toEqual([
    { port: boot.port, owner: 'keeper', capability: boot.capability },
  ]);

  await abortAllDurableObjects();

  // The cold request re-drives the durable application and answers on the
  // same URL; the reservation record — port AND capability — is the same row
  // the URL was minted from.
  expect(await subject().portReservations('durability-keep')).toEqual([
    { port: boot.port, owner: 'keeper', capability: boot.capability },
  ]);
});

it('a removed slate’s URL is dead even when a new app claims its port', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('removed'));

  const boot = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject.removeSlate('durability-remove', 'keeper'))
    .toEqual({ ok: true, port: boot.port });

  // The port is free again and a different slate takes it: the squatter's own
  // URL serves, so the old URL's 404 is the retired capability refusing — not
  // a port nothing listens on.
  const squatter = await subject.serveSlate({
    workspace: 'durability-remove', owner: 'durability-owner', id: 'squatter',
    body: 'squatter-body', preferredPort: boot.port,
  });

  expect(squatter.port).toBe(boot.port);
  expect(squatter.url).not.toBe(boot.url);
  expect(await subject.drivePreview(squatter.url)).toEqual({ status: 200, body: 'squatter-body' });
  expect(await subject.drivePreview(boot.url)).toMatchObject({ status: 404 });
});

it('the /__rpc surface answers over the durable URL after eviction', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('rpc'));

  const boot = await subject().serveSlate({
    workspace: 'durability-rpc', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  // One row now, so the post-eviction call both proves the socket path and
  // reads the retained facet's own SQLite back: 2 means this.sql survived.
  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":1}' });

  await abortAllDurableObjects();

  expect(await subject().rpcPreview(boot.url, 'ping')).toEqual({ ok: true, value: '{"rows":2}' });
});

it('a slate keeps answering its URL while a workspace process runs beside it', async () => {
  const subject = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('beside-a-process'));

  const boot = await subject().serveSlate({
    workspace: 'durability-beside', owner: 'durability-owner', id: 'keeper', body: 'keeper-body',
  });

  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });

  // The process outlives the drives below; the URL must answer throughout.
  const running = subject().runInWorkspace('durability-beside', 'sleep 6');

  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });

  const finished = await running;

  expect(finished.exitCode).toBe(0);
  expect(await subject().drivePreview(boot.url)).toEqual({ status: 200, body: 'keeper-body' });
});
