import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Files } from '@cloudflare/sandbox';
import { ContainerRoutes } from '../src/gateway';
import { classifyRecovery } from '../src/lifecycle';
import { storeRouteHost, storeSource } from '../src/store-gateway';
import { chainBox, type ChainBox, type ChainTestBox } from './support/chain-box';
import { Devbox, harness, type FakeSandbox } from './support/devbox-harness';
import type { StoredValue } from '../src/storage';

const store = { binding: 'WORKSPACES' };

const source = storeSource(store.binding);

const prefix = 'boxes/owner/backups/';

const markerPath = '/run/sandbox/s3-mounts/markers/' + createHash('sha256').update('/backups').digest('hex') + '.json';

/** What the guest wrote at the SDK's marker path, which the box must not trust. */
type GuestMarker = { readonly [key: string]: StoredValue };

async function refused(marker?: GuestMarker, arrange?: (container: FakeSandbox) => void): Promise<Error> {
  const { box, container } = harness(Devbox);
  await box.start();
  arrange?.(container);

  if (marker !== undefined) container.files.set(markerPath, JSON.stringify(marker));
  const unexpected = (): never => { throw new Error('a refused registration must not install routing'); };

  const routes = new ContainerRoutes({
    container: container.handle(), files: new Files(container.handle()), prefix, internet: false,
    bindings: { DevboxStoreGateway: unexpected, DevboxOutbound: unexpected },
  });

  try {
    try { await routes.configure({ routes: {} }, store, true); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(classifyRecovery({ cause: error })).toBe('permanent');
      expect(container.destroys).toBe(0);

      return error;
    }

    throw new Error('the marker was admitted');
  } finally { await box.destroy(); }
}

test('an unknown SDK marker protocol refuses without replacing the container', async () => {
  expect((await refused({ protocolVersion: 2 })).message).toBe('S3Mount marker protocol 2 not understood');
});

test('a store path mounted without an SDK marker refuses by name rather than rebuilding with an empty route table', async () => {
  const error = await refused(undefined, (container) => { container.s3fsMounts.add('/backups'); });

  expect(error.message).toContain('S3Mount marker missing for /backups, which is unmanaged');
});

test('a guest marker cannot widen the store route to another box\'s prefix', async () => {
  const error = await refused({
    protocolVersion: 1, routeId: 'owned-route', mountPath: '/backups',
    configuration: {
      source: { type: 's3', endpoint: source.endpoint, region: source.region, bucket: source.bucket },
      keyPrefix: 'boxes/another-owner/backups/', access: 'read-write',
    },
  });

  expect(error.message).toContain('does not match this devbox store');
});

test('a marker from a mount made at the box prefix is refused: its s3fs sends keys a rooted route would prefix twice', async () => {
  const error = await refused({
    protocolVersion: 1, routeId: 'owned-route', mountPath: '/backups',
    configuration: {
      source: { type: 's3', endpoint: source.endpoint, region: source.region, bucket: source.bucket },
      keyPrefix: prefix, access: 'read-write',
    },
  });

  expect(error.message).toContain('does not match this devbox store');
});

/** The marker exactly as sandbox-shim 1.0.0 writes it for a root mount (`s3_mount/model.rs:41-92`): no
 *  `keyPrefix`, since `skip_serializing_if` drops an absent one, and each s3fs option's value or `null`. */
function rootMountMarker(routeId: string) {
  return {
    protocolVersion: 1, routeId, mountPath: '/backups',
    configuration: {
      source: { type: 's3', endpoint: source.endpoint, region: source.region, bucket: source.bucket },
      access: 'read-write',
      s3fsOptions: [{ name: 'connect_timeout', value: '10' }, { name: 'nonempty', value: null }],
    },
  };
}

test('the SDK marker of a root mount rebinds its route, rooted at this box\'s prefix', async () => {
  const { box, container } = harness(Devbox);
  await box.start();
  container.files.set(markerPath, JSON.stringify(rootMountMarker('owned-route')));
  const stores: unknown[] = [];
  const installed: string[][] = [];
  const unreached = (): never => { throw new Error('a store route must not be called while it is installed'); };

  const routes = new ContainerRoutes({
    container: container.handle(), files: new Files(container.handle()), prefix, internet: false,
    bindings: {
      DevboxStoreGateway: ({ props }) => {
        stores.push(props);

        return { fetch: unreached, connect: unreached };
      },
      DevboxOutbound: ({ props }) => {
        installed.push(Object.keys(props.routes).sort());

        return { fetch: unreached, connect: unreached };
      },
    },
  });

  try {
    await routes.configure({ routes: {} }, store, true);
  } finally { await box.destroy(); }

  expect(installed.at(-1)).toContain(storeRouteHost('owned-route'));
  expect(stores).toContainEqual({ protocolVersion: 1, mode: 'active', routeId: 'owned-route', source, keyPrefix: prefix, access: 'read-write' });
});

/** What an evicted owner's request is answered, and what the object left behind. */
async function askAfterEviction(successor: ChainTestBox, chain: ChainBox): Promise<{ readiness: unknown; incidents: readonly string[]; destroys: number; starts: number }> {
  let readiness: unknown;

  try {
    readiness = await successor.resolveReadiness();
  } catch (error) {
    readiness = error instanceof Error ? error.message : error;
  }

  return {
    readiness,
    incidents: (await successor.devboxIncidentReasons()).map(row => row.reason),
    destroys: chain.container.destroys,
    starts: chain.container.containerStarts,
  };
}

const afterEviction = (chain: ChainBox) => askAfterEviction(chain.evict(), chain);

test('a warm owner evicted after its store mount rebinds the SDK\'s root-mount marker and is ready', async () => {
  const chain = chainBox();
  await chain.box.start();
  await chain.box.writeFile('/workspace/kept.txt', 'kept');
  expect((await chain.box.checkpointNow('tick')).kind).toBe('committed');
  expect(chain.container.files.has(markerPath)).toBe(true);

  expect(await afterEviction(chain)).toEqual({ readiness: { kind: 'restored' }, incidents: [], destroys: 0, starts: 1 });
});

test('a warm owner evicted before its store was ever mounted is ready: no marker and nothing mounted is nothing to route', async () => {
  const chain = chainBox();
  await chain.box.start();
  expect(chain.container.files.has(markerPath)).toBe(false);

  expect(await afterEviction(chain)).toEqual({ readiness: { kind: 'restored' }, incidents: [], destroys: 0, starts: 1 });
});

test('a marker this box cannot route refuses once, terminally, and arms no retry', async () => {
  const chain = chainBox();
  await chain.box.start();
  await chain.box.writeFile('/workspace/kept.txt', 'kept');
  expect((await chain.box.checkpointNow('tick')).kind).toBe('committed');
  chain.container.files.set(markerPath, JSON.stringify({ protocolVersion: 2 }));
  const startupRows = (): number => chain.container.scheduleRows.filter(row => row.callback === 'devboxStartup').length;
  const successor = chain.evict();
  const reason = '[permanent -> refuse] S3Mount marker protocol 2 not understood';

  const refusal = {
    readiness: expect.stringContaining(`this devbox has no attached work directory: ${reason}.`),
    incidents: [reason], destroys: 0, starts: 1, startupRows: 0,
  };

  expect({ ...await askAfterEviction(successor, chain), startupRows: startupRows() }).toEqual(refusal);
  // Nothing the box does next changes the answer: the platform's alarm and a later request file nothing more.
  await chain.container.alarm();
  expect({ ...await askAfterEviction(successor, chain), startupRows: startupRows() }).toEqual(refusal);
});
