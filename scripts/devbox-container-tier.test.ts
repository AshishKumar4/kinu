import { expect, test } from 'bun:test';
import { runToExit } from '@kinu.run/test-utils';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';
import { expiredContracts } from './fixtures/devbox-e2e/ledger';
import type { ContractTeardown } from './fixtures/devbox-e2e/ledger';

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

test('only own manifests beyond their enforced task wall are replayed, never a live task', () => {
  const manifest: ContractTeardown = {
    schema: 'devbox-contracts/teardown@1', run: 'dc20261009165047be72e', declared: 'cloudflare/debian-trixie',
    worker: 'kinu-dc20261009165047be72e', app: 'kinu-dc20261009165047be72e-contractbox',
    bucket: 'kinu-dc20261009165047be72e', boxes: ['devbox-golden'],
    snapshots: ['snapshot-owned-by-this-run'], applicationIds: ['app-owned-by-this-run'], notAfter: 120,
  };

  expect(expiredContracts([manifest], 119)).toEqual([]);
  expect(expiredContracts([manifest], 120)).toEqual([]);
  expect(expiredContracts([manifest], 121)).toEqual([manifest]);
  expect(expiredContracts([{ ...manifest, notAfter: 180 }, manifest], 121)).toEqual([manifest]);
});

test('a direct invocation outside armada refuses before fixture authority or resources are read', async () => {
  const run = await runToExit([process.execPath, 'scripts/devbox-container-tier.ts'], {
    env: { ...process.env, ARMADA_INDEX: undefined },
  });

  expect(run.exitCode).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr.trim().split('\n')).toHaveLength(1);
  expect(run.stderr).toContain('armada map --commit=HEAD');
});
