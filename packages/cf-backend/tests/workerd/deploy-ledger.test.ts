/**
 * A guided self-deployment, in workerd, over real Durable Object SQLite.
 *
 * WHAT IS PLATFORM HERE, and therefore why this is not a bun test: the ledger
 * is `ctx.storage.sql`, the vault is `ctx.storage`'s KV side, the wipe is
 * `ctx.storage.delete`, and the resume path is "a row an earlier activation
 * wrote is what the next one reads". The step logic itself is proved against a
 * port fake in `packages/core/tests/unit-deploy-flow.test.ts`; these four rows
 * are the ones that need the runtime.
 *
 * The plane the run talks to is the Node-side fake installed as the probe
 * worker's `outboundService` (`deploy-fake.ts`): a Cloudflare API that
 * remembers what it created, an authorization server that checks the PKCE
 * verifier, and a release channel serving a real tarball whose digest matches
 * the one it publishes. An unmatched host throws there, so nothing in these
 * rows reaches a real network.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runKeyDigest } from '@kinu.run/core/deploy';
import type { DeployInputs, DeploySnapshot } from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_ACCOUNT, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_REFRESH_TOKEN,
  DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

const RUN_KEY = 'a-run-key-of-at-least-thirty-two-characters';

const INPUTS: DeployInputs = {
  accountId: DEPLOY_FAKE_ACCOUNT,
  instanceName: 'kinu',
  address: { kind: 'workers-dev', hostname: '', zoneId: '' },
  ownerEmail: 'owner@example.com',
  accessEmails: ['owner@example.com'],
  providerKeyNames: [],
  sandbox: false,
};

const ADDRESS = `kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev`;

let runs = 0;

/** A fresh object per row: a run id names one Durable Object, and a row that
 *  reused an id would read the previous row's ledger. */
function openRun() {
  runs += 1;

  return env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(`probe-run-${String(runs)}`));
}

async function authorized() {
  const stub = openRun();

  await stub.open(`probe-run-${String(runs)}`, await runKeyDigest(RUN_KEY));
  // The authorization leg for real: the fake authorization server refuses an
  // exchange whose verifier is missing or short, so this proves the PKCE pair
  // the object minted travelled.
  const state = await stub.holdAuthorization('a-verifier-of-forty-three-characters-at-least');

  await stub.landAuthorization(DEPLOY_FAKE_CLIENT_ID, 'https://kinu.run/deploy/callback', 'probe-code', state);

  return stub;
}

function stateOf(snapshot: DeploySnapshot, id: string): string {
  return snapshot.steps.find((row) => row.id === id)?.state ?? 'absent';
}

beforeEach(async () => {
  await env.DEPLOY_FAKE.reset();
});

describe('a guided run in a Durable Object', () => {
  it('authorizes with PKCE, deploys, and holds nothing when it is over', async () => {
    const stub = await authorized();

    expect(await stub.authorized()).toBe(true);

    const snapshot = await stub.start(INPUTS);
    const made = await env.DEPLOY_FAKE.state();

    expect(snapshot.state).toBe('done');
    expect(snapshot.address).toBe(ADDRESS);
    expect(snapshot.version).toBe(DEPLOY_FAKE_VERSION);
    expect(snapshot.steps.every((row) => row.state === 'done')).toBe(true);
    expect(made.namespaces).toEqual(['kinu-auth-kv']);
    expect(made.uploads).toBe(1);
    // The deployment owns its key from here: the refresh token is a secret on
    // the new Worker, and the run's vault is empty.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_REFRESH_TOKEN);
    expect(await stub.heldSecretNames()).toEqual([]);
  });

  it('keeps no key digest, token or minted secret in a durable row', async () => {
    const stub = await authorized();

    await stub.start(INPUTS);

    const rows = await stub.rowText();

    expect(rows).not.toContain(await runKeyDigest(RUN_KEY));
    expect(rows).not.toContain(RUN_KEY);
    expect(rows).not.toContain(DEPLOY_FAKE_ACCESS_TOKEN);
    expect(rows).not.toContain(DEPLOY_FAKE_REFRESH_TOKEN);
    expect(rows).toContain(ADDRESS);
  });

  it('stops at the step that refused, keeping Cloudflare\'s own sentence', async () => {
    const stub = await authorized();

    await env.DEPLOY_FAKE.refuseOnce({
      path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/r2/buckets`,
      status: 403,
      code: 10_042,
      message: 'R2 is not enabled for this account. Add a payment method to enable R2.',
    });

    const snapshot = await stub.start(INPUTS);
    const refused = snapshot.steps.find((row) => row.id === 'r2');

    expect(snapshot.state).toBe('failed');
    expect(refused?.failure?.detail).toBe('R2 is not enabled for this account. Add a payment method to enable R2.');
    expect(refused?.failure?.code).toBe(10_042);
    expect(stateOf(snapshot, 'upload')).toBe('pending');
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
    // The token is still held: the run is resumable, and a refusal is not a
    // reason to drop the authorization a person gave.
    expect(await stub.heldSecretNames()).not.toEqual([]);
  });

  it('resumes after a refusal and creates nothing twice', async () => {
    const stub = await authorized();

    await env.DEPLOY_FAKE.refuseOnce({
      path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/ai-gateway/gateways`,
      status: 500,
      code: 10_000,
      message: 'internal error',
    });

    const stopped = await stub.start(INPUTS);

    expect(stopped.state).toBe('failed');

    const resumed = await stub.retry('ai-gateway');
    const made = await env.DEPLOY_FAKE.state();
    const twice = made.creates.filter((name, at) => made.creates.indexOf(name) !== at);

    expect(resumed.state).toBe('done');
    expect(resumed.steps.find((row) => row.id === 'ai-gateway')?.attempt).toBe(2);
    expect(resumed.steps.find((row) => row.id === 'kv')?.attempt).toBe(1);
    expect(twice).toEqual([]);
    expect(made.uploads).toBe(1);
    expect(await stub.heldSecretNames()).toEqual([]);
  });
});
