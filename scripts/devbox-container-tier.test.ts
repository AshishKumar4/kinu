import { expect, test } from 'bun:test';
import { runToExit } from '@kinu.run/test-utils';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';
import { contractOwner, contractOwnerEnded, contractRunEnded, recoverAbandoned } from './fixtures/devbox-e2e/ledger';
import type { ContractOwner, ContractTeardown } from './fixtures/devbox-e2e/ledger';

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

/** An abandoned run's teardown record, as the ledger answers it. */
const abandoned = (run: string): ContractTeardown => ({
  schema: 'devbox-contracts/teardown@2', run, worker: `kinu-${run}`, app: `kinu-${run}-contractbox`, bucket: `kinu-${run}`,
  boxes: [], declared: 'cloudflare/debian-trixie', snapshots: [], applicationIds: [],
  owner: { job: '20261015185143-44a621b9', index: 2, attempt: 1, vessel: 'v1', statusUrl: 'https://armada.invalid/status/20261015185143-44a621b9', statusToken: 'scoped' },
});

test('inherited teardowns are replayed at once, each timed, before anything is created', async () => {
  const order: string[] = [];
  const runs = ['dc20261015185153bd8a1', 'dc202610151851575e717', 'dc20261015185157f140c'];

  const recovered = await recoverAbandoned(runs.map(abandoned), async ({ run }) => {
    order.push(`start ${run}`);
    // Tasks, not timers: each replay yields once, so one that waited on another would end before the next began.
    await Promise.resolve();
    await Promise.resolve();
    order.push(`end ${run}`);
  });

  expect(order).toEqual([...runs.map((run) => `start ${run}`), ...runs.map((run) => `end ${run}`)]);
  expect(recovered.map(({ contract, detail }) => ({ contract, detail }))).toEqual(runs.map((run) => ({
    contract: 'recovered-teardown', detail: { run, owner: { job: '20261015185143-44a621b9', index: 2, attempt: 1, vessel: 'v1' } },
  })));
  expect(recovered.every(({ ms }) => Number.isInteger(ms) && ms >= 0)).toBe(true);
});

test('one failed inherited teardown refuses the run, naming it, after every other was still replayed', async () => {
  const replayed: string[] = [];
  const runs = ['dc20261015185153bd8a1', 'dc202610151851575e717', 'dc20261015185157f140c'];

  await expect(recoverAbandoned(runs.map(abandoned), async ({ run }) => {
    replayed.push(run);

    if (run === 'dc202610151851575e717') throw new Error('its replay exited 1');
  })).rejects.toThrow('no new fixture was created: dc202610151851575e717: Error: its replay exited 1');
  expect(replayed).toEqual(runs);
});

test('the exact physical owner must be gone, including a late copy of an already decided task', () => {
  const owner: ContractOwner = {
    job: '20261011010101-0123abcd', index: 0, attempt: 1, vessel: 'v1',
    statusUrl: 'https://armada.test/status/20261011010101-0123abcd', statusToken: 'job-scoped-read-only-token',
  };

  const status = { job: owner.job, index: 0, attempt: 1, running: [{ vessel: 'v1', attempt: 1 }] };

  expect(contractRunEnded(owner, status)).toBe(false);
  expect(contractRunEnded(owner, { ...status, running: [] })).toBe(true);
  expect(contractRunEnded(owner, { ...status, running: [{ vessel: 'r1', attempt: 1 }] })).toBe(true);
  expect(contractRunEnded(owner, { ...status, attempt: 2, running: [{ vessel: 'v1', attempt: 2 }] })).toBe(true);
  expect(() => contractRunEnded(owner, { ...status, job: 'another-job' })).toThrow('recorded fixture owner');
  expect(() => contractRunEnded(owner, { ...status, index: 1 })).toThrow('recorded fixture owner');
  expect(() => contractRunEnded(owner, { ...status, attempt: 0 })).toThrow('recorded fixture owner');
});

test('missing exact armada identity refuses without echoing its scoped token', () => {
  expect(() => contractOwner({ ARMADA_INDEX: '0', ARMADA_STATUS_TOKEN: 'private-status-capability' })).toThrow('require armada task identity');

  const owner = contractOwner({ ARMADA_JOB_ID: 'job', ARMADA_INDEX: '2', ARMADA_ATTEMPT: '1', ARMADA_VESSEL: 'v1',
    ARMADA_STATUS_URL: 'https://armada.test/status/job', ARMADA_STATUS_TOKEN: 'private-status-capability' });

  expect(owner).toEqual({ job: 'job', index: 2, attempt: 1, vessel: 'v1', statusUrl: 'https://armada.test/status/job', statusToken: 'private-status-capability' });
});

test('a refused status witness never authorizes recovery or echoes the private capability', async () => {
  const owner: ContractOwner = { job: 'job', index: 2, attempt: 1, vessel: 'v1', statusUrl: 'https://armada.test/status/job', statusToken: 'private-status-capability' };

  const queries: string[] = [];

  const query = async (url: string, init: RequestInit) => {
    queries.push(url);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-status-capability');

    return new Response('private-status-capability must not appear in the failure', { status: 403 });
  };

  const [result] = await Promise.allSettled([contractOwnerEnded(owner, query)]);

  expect(result?.status).toBe('rejected');

  if (result?.status === 'rejected') {
    expect(String(result.reason)).not.toContain(owner.statusToken);
  }

  expect(queries).toEqual(['https://armada.test/status/job/2']);
});

test('a direct invocation outside armada refuses before fixture authority or resources are read', async () => {
  const run = await runToExit([process.execPath, 'scripts/devbox-container-tier.ts'], {
    env: { ...process.env, ARMADA_INDEX: undefined },
  });

  expect(run.exitCode).toBe(1);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('armada map --connection=');
});
