import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Files } from '@cloudflare/sandbox';
import { ContainerRoutes } from '../src/gateway';
import { classifyRecovery } from '../src/lifecycle';
import { storeSource } from '../src/store-gateway';
import { Devbox, harness } from './support/devbox-harness';
import type { StoredValue } from '../src/storage';

const store = { binding: 'WORKSPACES' };

const source = storeSource(store.binding);

const prefix = 'boxes/owner/backups/';

const markerPath = '/run/sandbox/s3-mounts/markers/' + createHash('sha256').update('/backups').digest('hex') + '.json';

/** What the guest wrote at the SDK's marker path, which the box must not trust. */
type GuestMarker = { readonly [key: string]: StoredValue };

async function refused(marker?: GuestMarker): Promise<Error> {
  const { box, container } = harness(Devbox);
  await box.start();

  if (marker !== undefined) container.files.set(markerPath, JSON.stringify(marker));
  const unexpected = (): never => { throw new Error('a refused registration must not install routing'); };

  const routes = new ContainerRoutes({
    container: container.handle(), files: new Files(container.handle()), prefix, owner: { binding: 'Box', id: 'owner' }, internet: false,
    bindings: { DevboxStoreGateway: unexpected, DevboxSyncGateway: unexpected, DevboxOutbound: unexpected },
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
  expect((await refused({ protocolVersion: 2 })).message).toBe('S3Mounts marker protocol 2 not understood');
});

test('a missing SDK marker refuses by name rather than rebuilding with an empty route table', async () => {
  expect((await refused()).message).toContain('S3Mounts marker missing');
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
