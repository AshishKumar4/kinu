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
import { DEPLOY_SOCKET_PROTOCOL, runKeyDigest } from '@kinu.run/core/deploy';
import { sha256Hex } from '@kinu.run/core';
import * as v from 'valibot';
import type { DeployInputs, DeploySnapshot } from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_ACCOUNT, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_REFRESH_TOKEN,
  DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

/** The binding cookie's name, spelled here rather than imported: this file runs
 *  in workerd against the production routes, and the name is part of what the
 *  browser is promised. A rename that did not reach this row would leave the
 *  row asserting a cookie nothing sets, and it fails rather than passes. */
const DEPLOY_STATE_COOKIE = '__Host-kinu_deploy_state';

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

  await stub.open(`probe-run-${String(runs)}`, runKeyDigest(RUN_KEY));
  // The authorization leg for real: the fake authorization server refuses an
  // exchange whose verifier is missing or short, so this proves the PKCE pair
  // the object minted travelled.
  const state = await stub.holdAuthorization('a-verifier-of-forty-three-characters-at-least');

  expect(await stub.landAuthorization(DEPLOY_FAKE_CLIENT_ID, 'https://kinu.run/deploy/callback', 'probe-code', state))
    .toBe(true);

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

/**
 * The door's own routes, over the same object.
 *
 * WHAT THESE ROWS ARE FOR: `/deploy/callback` is a navigation, so nothing in it
 * can present the run key. What must make it this browser's is the cookie the
 * authorize leg set. The attacker in the threat model mints a run (and holds
 * its key), starts the leg, and forwards the Cloudflare authorize URL to
 * somebody else; the victim consents in THEIR browser, which carries no cookie
 * for that state, and the run must come out as unauthorized as it went in.
 */
describe('the door\'s authorization leg', () => {
  /** A run minted the way the page mints one, and the key it answered with. */
  const mint = async (): Promise<{ runId: string; runKey: string }> => {
    const minted = await env.DEPLOY_DOOR_PROBE.hit('POST', '/api/deploy/runs');

    return v.parse(v.object({ runId: v.string(), runKey: v.string() }), JSON.parse(minted.body));
  };

  /** The `__Host-kinu_deploy_state` value a `set-cookie` carries, or ''. */
  const bindingOf = (answer: { setCookie: readonly string[] }): string => {
    const held = answer.setCookie.find((cookie) => cookie.startsWith(`${DEPLOY_STATE_COOKIE}=`)) ?? '';
    const value = held.split(';')[0]?.slice(DEPLOY_STATE_COOKIE.length + 1) ?? '';

    return value;
  };

  const stateOfHandoff = (location: string): string =>
    new URL(v.parse(v.object({ location: v.string() }), JSON.parse(location)).location).searchParams.get('state') ?? '';

  it('refuses a callback from a browser that did not start the leg, and the run stays unauthorized', async () => {
    const run = await mint();

    const handoff = await env.DEPLOY_DOOR_PROBE.hit(
      'POST', `/api/deploy/runs/${run.runId}/authorize`, { authorization: `Bearer ${run.runKey}` },
    );

    const state = stateOfHandoff(handoff.body);

    expect(handoff.status).toBe(200);
    expect(state).not.toBe('');
    // The binding the browser is given: the digest of this leg's state, on a
    // `__Host-` HttpOnly Secure cookie.
    expect(bindingOf(handoff)).toBe(sha256Hex(state));

    const forwarded = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`,
    );

    expect(forwarded.status).toBe(400);
    expect(forwarded.body).toContain('This browser did not start that authorization.');

    // The same namespace the route addressed: `DEPLOY_RUN_PROBE` and the
    // product's own `DeployRunDO` binding are two names for one class on one
    // script, so this is the object the callback would have written into.
    const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(run.runId));

    expect(await stub.authorized()).toBe(false);
    expect(await stub.heldSecretNames()).toEqual([]);

    // And the browser that DID start it lands the pair, over the same state.
    const landed = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`,
      { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(state)}` },
    );

    expect(landed.status).toBe(302);
    expect(await stub.authorized()).toBe(true);
  });

  it('refuses a state no leg minted, and a state already spent', async () => {
    const run = await mint();

    const handoff = await env.DEPLOY_DOOR_PROBE.hit(
      'POST', `/api/deploy/runs/${run.runId}/authorize`, { authorization: `Bearer ${run.runKey}` },
    );

    const state = stateOfHandoff(handoff.body);
    const cookie = { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(state)}` };

    // A state this run never minted, presented with a cookie the caller made
    // for it — an attacker controls their own browser, so the cookie alone
    // cannot be the whole check.
    const invented = `${run.runId}.not-a-nonce-this-object-minted`;

    const unknown = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(invented)}`,
      { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(invented)}` },
    );

    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain('That authorization is not one this run started.');

    expect((await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`, cookie,
    )).status).toBe(302);

    // The object deleted the state when it spent it, so the same URL replayed
    // from the same browser lands nothing a second time.
    const replayed = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`, cookie,
    );

    expect(replayed.status).toBe(400);
    expect(replayed.body).toContain('That authorization is not one this run started.');
  });

  it('takes the run key from a header and from the socket subprotocol, never from a query', async () => {
    const run = await mint();

    const byHeader = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/api/deploy/runs/${run.runId}`, { authorization: `Bearer ${run.runKey}` },
    );

    const byQuery = await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}?key=${encodeURIComponent(run.runKey)}`);

    const bySocket = await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}/socket`, {
      upgrade: 'websocket',
      'sec-websocket-protocol': `${DEPLOY_SOCKET_PROTOCOL}, ${run.runKey}`,
    });

    expect(byHeader.status).toBe(200);
    // The query form is not read at all: a caller that put the key in a URL is
    // refused, which is what keeps it out of the logs.
    expect(byQuery.status).toBe(403);
    expect(bySocket.status).toBe(101);
  });
});
