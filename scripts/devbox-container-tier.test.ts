import { expect, test } from 'bun:test';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';

test('the real-container tier refuses missing staging authority even when production authority exists', () => {
  expect(() => tierIdentity({ KINU_EVAL_WEB_IDENTITY: 'production' })).toThrow('requires KINU_EVAL_STAGING_WEB_IDENTITY');
  expect(tierIdentity({ KINU_EVAL_STAGING_WEB_IDENTITY: 'staging', KINU_EVAL_WEB_IDENTITY: 'production' })).toBe('staging');
});

test('a changed recovery value fails the same oracle the live tier uses', () => {
  expect(() => requireEqual('old bytes', 'new bytes')).toThrow('contract mismatch');
  requireEqual({ bytes: 'kept', deleted: false }, { bytes: 'kept', deleted: false });
});

test('a throwing health check is recorded and never stops Worker, application or bucket deletion', async () => {
  const deleted: string[] = [];

  const [outcome] = await Promise.allSettled([completeTeardown({
    health: async () => { throw new Error('DNS ETIMEOUT'); },
    beforeDelete: async () => undefined,
    worker: async () => { deleted.push('worker'); },
    application: async () => { deleted.push('application'); },
    bucket: async () => { deleted.push('bucket'); },
  })]);

  expect(deleted).toEqual(['worker', 'application', 'bucket']);
  expect(outcome).toEqual({ status: 'fulfilled', value: { health: { failure: 'DNS ETIMEOUT' }, errors: [] } });
});
