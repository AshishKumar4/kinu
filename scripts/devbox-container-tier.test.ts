import { expect, test } from 'bun:test';
import { runToExit } from '@kinu.run/test-utils';
import { requireEqual, tierIdentity } from './fixtures/devbox-e2e/oracle';
import { completeTeardown } from './fixtures/devbox-e2e/teardown';
import { contractLedger, contractOwner, contractOwnerEnded, contractRunEnded, recoverAbandoned } from './fixtures/devbox-e2e/ledger';
import type { ContractOwner, ContractTeardown } from './fixtures/devbox-e2e/ledger';
import { dropLease, fixtureNames, takeLease, type Lease, type LeaseStore } from './fixtures/devbox-e2e/fixture';

test('the real-container tier refuses missing staging authority even when production authority exists', () => {
  expect(() => tierIdentity({ KINU_EVAL_WEB_IDENTITY: 'production' })).toThrow('requires KINU_EVAL_STAGING_WEB_IDENTITY');
  expect(tierIdentity({ KINU_EVAL_STAGING_WEB_IDENTITY: 'staging', KINU_EVAL_WEB_IDENTITY: 'production' })).toBe('staging');
});

test('a changed recovery value fails the same oracle the live tier uses', () => {
  expect(() => requireEqual('old bytes', 'new bytes')).toThrow('contract mismatch');
  requireEqual({ bytes: 'kept', deleted: false }, { bytes: 'kept', deleted: false });
});

test('a throwing health check is recorded and never stops the boxes, snapshots or bucket going', async () => {
  const deleted: string[] = [];

  const [outcome] = await Promise.allSettled([completeTeardown({
    health: async () => { throw new Error('DNS ETIMEOUT'); },
    boxes: async () => { deleted.push('boxes'); },
    snapshots: async () => { deleted.push('snapshots'); },
    bucket: async () => { deleted.push('bucket'); },
  })]);

  expect(deleted).toEqual(['boxes', 'snapshots', 'bucket']);
  expect(outcome).toEqual({ status: 'fulfilled', value: { health: { failure: 'DNS ETIMEOUT' }, errors: [] } });
});

// A box's clear reads its store: a bucket deleted under a box that was not emptied leaves a box no replay can clear.
test('a box that was not emptied keeps the bucket for the replay, and the snapshots still go', async () => {
  const deleted: string[] = [];

  const outcome = await completeTeardown({
    health: async () => 200,
    boxes: async () => { throw new Error('cleanup eval-devbox-x: contract mismatch'); },
    snapshots: async () => { deleted.push('snapshots'); },
    bucket: async () => { deleted.push('bucket'); },
  });

  expect({ deleted, errors: outcome.errors }).toEqual({
    deleted: ['snapshots'],
    errors: ['boxes: cleanup eval-devbox-x: contract mismatch', 'bucket deletion: retained for the replay, as a box was not emptied'],
  });
});

// 2026-10-16: a namespace new to the platform answered `internal error` for up to 45 s after its deploy, and a Worker of
// each run's own met it in 8 of 153 runs; a deploy of an existing one met it in none of 6 probes.
test('every run deploys the same fixture Worker, and binds a bucket of its own', () => {
  const [first, second] = ['dc20261016140327aaaaa', 'dc20261016150327bbbbb'].map((run) => fixtureNames(run));

  expect({ worker: first?.worker === second?.worker, app: first?.app === second?.app, buckets: first?.bucket !== second?.bucket, bucketIsRuns: first?.bucket.includes('dc20261016140327aaaaa') })
    .toEqual({ worker: true, app: true, buckets: true, bucketIsRuns: true });
});

/** A lease store as R2 keeps one: a write lands where none is held, or where the held one is still the version named. */
function leaseStore(): LeaseStore & { held: () => Lease | null } {
  let held: { lease: Lease; version: string } | null = null;
  let versions = 0;

  return {
    held: () => held?.lease ?? null,
    read: async () => held,
    write: async (lease, version) => {
      if ((held?.version ?? null) !== version) return false;
      versions += 1;
      held = { lease, version: String(versions) };

      return true;
    },
    remove: async () => { held = null; },
  };
}

const leaseOf = (run: string, job: string): Lease => ({
  schema: 'devbox-contracts/lease@1', worker: 'kinu-devbox-contracts-staging', run,
  owner: { job, index: 0, attempt: 1, vessel: 'v1', statusUrl: `https://armada.test/status/${job}`, statusToken: 'scoped' },
});

/**
 * R2 as measured on 2026-10-19: a GET that may be compressed answers gzip with the ETag weakened (`W/"…"`), one asking
 * for `identity` answers the strong ETag, and a PUT's If-Match holds only against the strong one.
 */
function r2() {
  let held: { body: string; tag: string } | null = null;
  let tags = 0;

  return Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
    if (request.method === 'GET') {
      if (held === null) return new Response('missing', { status: 404 });
      const compressed = (request.headers.get('accept-encoding') ?? '').includes('gzip');

      return new Response(held.body, { headers: { etag: compressed ? `W/${held.tag}` : held.tag } });
    }

    const match = request.headers.get('if-match');

    if (request.headers.get('if-none-match') === '*' ? held !== null : match !== held?.tag) return new Response('', { status: 412 });
    held = { body: await request.text(), tag: `"${String(tags += 1)}"` };

    return new Response('', { status: 200 });
  } });
}

// Staging deploy of 001f6d749, 2026-10-19 12:03Z: the lease a killed deploy held at 11:53:41 was never written again,
// yet the takeover was refused as "taken by another run": its If-Match carried the weakened ETag of a gzip GET.
test('an ended holder\'s lease is taken over in R2 itself, over the version its read named', async () => {
  const server = r2();

  try {
    const store = contractLedger({ account: 'f44999d1ddda7012e9a87729eba250f1', accessKeyId: 'id', secretAccessKey: 'secret', origin: server.url.origin }).lease('kinu-devbox-contracts-staging');

    await takeLease(store, leaseOf('dc20261019115338aaaaa', 'job-a'), async () => false);
    await takeLease(store, leaseOf('dc20261019120039bbbbb', 'job-b'), async () => true);
    expect((await store.read())?.lease).toEqual(leaseOf('dc20261019120039bbbbb', 'job-b'));
  } finally {
    await server.stop(true);
  }
});

test('one run at a time deploys the fixture: a running holder refuses the next, naming it, and an ended one is taken over', async () => {
  const store = leaseStore();
  const first = leaseOf('dc20261016140327aaaaa', 'job-a');
  const second = leaseOf('dc20261016150327bbbbb', 'job-b');

  await takeLease(store, first, async () => false);
  await expect(takeLease(store, second, async () => false)).rejects.toThrow('held by run dc20261016140327aaaaa (armada job job-a, task 0, attempt 1), which is still running');

  const asked: string[] = [];

  await takeLease(store, second, async (owner) => {
    asked.push(owner.job);

    return true;
  });
  expect({ asked, held: store.held() }).toEqual({ asked: ['job-a'], held: second });
});

test('a run gives up only its own lease', async () => {
  const store = leaseStore();
  const first = leaseOf('dc20261016140327aaaaa', 'job-a');

  await takeLease(store, first, async () => false);
  await expect(dropLease(store, 'dc20261016150327bbbbb')).rejects.toThrow('not run dc20261016150327bbbbb');
  await dropLease(store, first.run);
  await dropLease(store, first.run);
  expect(store.held()).toBe(null);
});

/** An abandoned run's teardown record, as the ledger answers it. */
const abandoned = (run: string): ContractTeardown => ({
  schema: 'devbox-contracts/teardown@3', run, ...fixtureNames(run),
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
