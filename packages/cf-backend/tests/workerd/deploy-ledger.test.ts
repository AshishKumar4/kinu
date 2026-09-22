/**
 * A guided self-deployment in workerd over real DO SQLite: the ledger, vault, wipe and resume-from-row
 * need the runtime; step logic is proved in `packages/core/tests/unit-deploy-flow.test.ts`.
 * The plane is the `outboundService` fake (`deploy-fake.ts`); an unmatched host throws.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEPLOY_SOCKET_PROTOCOL, FACT_UPLOAD_PEAK, runKeyDigest } from '@kinu.run/core/deploy';
import { sha256Hex } from '@kinu.run/core';
import * as v from 'valibot';
import type { DeployInputs, DeployRunPhase, DeploySnapshot } from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_ACCOUNT, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_REFRESH_TOKEN,
  DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

/** Spelled rather than imported: the name is part of what the browser is promised. */
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

/** A run id names one Durable Object; a fresh id per row keeps ledgers apart. */
function openRun() {
  runs += 1;

  return env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(`probe-run-${String(runs)}`));
}

/** A new stub for the last `openRun` object: a stub whose object was aborted is poisoned. */
function reopenRun() {
  return env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(`probe-run-${String(runs)}`));
}

async function authorized() {
  const stub = openRun();

  await stub.open(`probe-run-${String(runs)}`, runKeyDigest(RUN_KEY));
  // The fake authorization server refuses a missing or short verifier, so this proves the PKCE pair travelled.
  const state = await stub.holdAuthorization('a-verifier-of-forty-three-characters-at-least');

  expect(await stub.landAuthorization(DEPLOY_FAKE_CLIENT_ID, 'https://kinu.run/deploy/callback', 'probe-code', state))
    .toBe(true);

  return stub;
}

/**
 * The run, driven to its outcome. `start` answers before the first step (the plan runs on the alarm), so
 * this parks on the end of an alarm delivery (`settledAfter`) instead of polling.
 */
async function settled(stub: {
  settledAfter(states: readonly DeployRunPhase[]): Promise<DeploySnapshot>;
}): Promise<DeploySnapshot> {
  return await stub.settledAfter(['done', 'failed']);
}

async function mintedRun(): Promise<{ runId: string; runKey: string }> {
  const minted = await env.DEPLOY_DOOR_PROBE.hit('POST', '/api/deploy/runs');

  return v.parse(v.object({ runId: v.string(), runKey: v.string() }), JSON.parse(minted.body));
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

    await stub.start(INPUTS);

    const snapshot = await settled(stub);
    const made = await env.DEPLOY_FAKE.state();

    expect(snapshot.state).toBe('done');
    expect(snapshot.address).toBe(ADDRESS);
    expect(snapshot.version).toBe(DEPLOY_FAKE_VERSION);
    expect(snapshot.steps.every((row) => row.state === 'done')).toBe(true);
    expect(made.namespaces).toEqual(['kinu-auth-kv']);
    expect(made.uploads).toBe(1);
    // The refresh token is now a secret on the new Worker and the run's vault is empty.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_REFRESH_TOKEN);
    expect(await stub.heldSecretNames()).toEqual([]);
  });

  it('keeps no key digest, token or minted secret in a durable row', async () => {
    const stub = await authorized();

    await stub.start(INPUTS);
    await settled(stub);

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

    await stub.start(INPUTS);

    const snapshot = await settled(stub);
    const refused = snapshot.steps.find((row) => row.id === 'r2');

    expect(snapshot.state).toBe('failed');
    expect(refused?.failure?.detail).toBe('R2 is not enabled for this account. Add a payment method to enable R2.');
    expect(refused?.failure?.code).toBe(10_042);
    expect(stateOf(snapshot, 'upload')).toBe('pending');
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
    // A refusal is not a reason to drop the authorization a person gave; the run is resumable.
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

    await stub.start(INPUTS);

    expect((await settled(stub)).state).toBe('failed');
    await stub.retry('ai-gateway');

    const resumed = await settled(stub);
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
 * The door's own routes. `/deploy/callback` is a navigation and cannot present the run key, so the
 * authorize leg's cookie binds it: a forwarded authorize URL consented in another browser must stay unauthorized.
 */
describe('the door\'s authorization leg', () => {

  const bindingOf = (answer: { setCookie: readonly string[] }): string => {
    const held = answer.setCookie.find((cookie) => cookie.startsWith(`${DEPLOY_STATE_COOKIE}=`)) ?? '';
    const value = held.split(';')[0]?.slice(DEPLOY_STATE_COOKIE.length + 1) ?? '';

    return value;
  };

  const stateOfHandoff = (location: string): string =>
    new URL(v.parse(v.object({ location: v.string() }), JSON.parse(location)).location).searchParams.get('state') ?? '';

  it('refuses a callback from a browser that did not start the leg, and the run stays unauthorized', async () => {
    const run = await mintedRun();

    const handoff = await env.DEPLOY_DOOR_PROBE.hit(
      'POST', `/api/deploy/runs/${run.runId}/authorize`, { authorization: `Bearer ${run.runKey}` },
    );

    const state = stateOfHandoff(handoff.body);

    expect(handoff.status).toBe(200);
    expect(state).not.toBe('');
    expect(bindingOf(handoff)).toBe(sha256Hex(state));

    const forwarded = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`,
    );

    expect(forwarded.status).toBe(400);
    expect(forwarded.body).toContain('This browser did not start that authorization.');

    // `DEPLOY_RUN_PROBE` and `DeployRunDO` are two names for one class on one script.
    const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(run.runId));

    expect(await stub.authorized()).toBe(false);
    expect(await stub.heldSecretNames()).toEqual([]);

    const landed = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`,
      { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(state)}` },
    );

    expect(landed.status).toBe(302);
    expect(await stub.authorized()).toBe(true);
  });

  it('refuses a state no leg minted, and a state already spent', async () => {
    const run = await mintedRun();

    const handoff = await env.DEPLOY_DOOR_PROBE.hit(
      'POST', `/api/deploy/runs/${run.runId}/authorize`, { authorization: `Bearer ${run.runKey}` },
    );

    const state = stateOfHandoff(handoff.body);
    const cookie = { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(state)}` };

    // An attacker controls their own browser, so the cookie alone cannot be the whole check.
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

    // The object deletes the state when spent, so a replay lands nothing.
    const replayed = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`, cookie,
    );

    expect(replayed.status).toBe(400);
    expect(replayed.body).toContain('That authorization is not one this run started.');
  });

  it('takes the run key from a header and from the socket subprotocol, never from a query', async () => {
    const run = await mintedRun();

    const byHeader = await env.DEPLOY_DOOR_PROBE.hit(
      'GET', `/api/deploy/runs/${run.runId}`, { authorization: `Bearer ${run.runKey}` },
    );

    const byQuery = await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}?key=${encodeURIComponent(run.runKey)}`);

    const bySocket = await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}/socket`, {
      upgrade: 'websocket',
      'sec-websocket-protocol': `${DEPLOY_SOCKET_PROTOCOL}, ${run.runKey}`,
    });

    expect(byHeader.status).toBe(200);
    // The query form is not read, which keeps the key out of logs.
    expect(byQuery.status).toBe(403);
    expect(bySocket.status).toBe(101);
  });
});

/**
 * The vault's bound: an hour idle and the tokens are gone. Two assertions: the alarm is armed (a run
 * holding tokens with no timer is the defect) and a real alarm dispatch empties the vault.
 */
describe('a run nobody finished', () => {
  it('arms a bounded lifetime for the tokens it holds, and loses them when it fires', async () => {
    const stub = await authorized();

    await env.DEPLOY_FAKE.refuseOnce({
      path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/r2/buckets`,
      status: 403,
      code: 10_042,
      message: 'R2 is not enabled for this account. Add a payment method to enable R2.',
    });
    await stub.start(INPUTS);

    expect((await settled(stub)).state).toBe('failed');
    expect(await stub.heldSecretNames()).not.toEqual([]);

    const due = await stub.alarmAt();
    const armed = await stub.armedAt();

    // Measured between two instants the object took, not the test process's clock.
    expect(due - armed).toBeGreaterThan(3_000_000);
    expect(due - armed).toBeLessThanOrEqual(3_600_000);

    expect(await stub.expireSoon()).toBe(true);

    const expired = await stub.settledAfter(['expired']);

    expect(await stub.heldSecretNames()).toEqual([]);
    // The ledger survives so the page can offer signing in again into the same run.
    expect(expired.state).toBe('expired');
    expect(expired.steps.length).toBeGreaterThan(0);
  });

  it('deletes an object that never got past minting', async () => {
    const run = await mintedRun();
    const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(run.runId));

    // `POST /api/deploy/runs` is public: an object that never ran a step leaves nothing.
    expect(await stub.alarmAt()).toBeGreaterThan(await stub.armedAt());
    expect(await stub.expireSoon()).toBe(true);

    // An object with no rows deletes itself, so the row waits on the end of the delivery.
    const left = await stub.reportAfterAlarm();

    expect(await stub.alarmAt()).toBe(0);
    expect(left).toEqual({ runId: '', state: 'collecting', address: '', version: '', steps: [] });
    expect(await stub.admits(run.runKey)).toBe(false);
  });
});

/**
 * The runtime redelivers an alarm whose handler did not finish. `ctx.abort()` kills the plan mid-step after
 * the bucket exists but before the object learned it; the run must carry on, looking before it creates.
 */
describe('a run the runtime could not finish', () => {
  it('carries on from the redelivered alarm and creates nothing twice', async () => {
    const stub = await authorized();

    await env.DEPLOY_FAKE.stallOnce({
      method: 'POST', path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/r2/buckets`,
    });
    await stub.start(INPUTS);

    // The plane signals the held create, so the abort lands inside the window by construction, not by timing.
    await env.DEPLOY_FAKE.stallReached();

    expect(stateOf(await stub.snapshot(), 'r2')).toBe('running');
    expect((await env.DEPLOY_FAKE.state()).buckets).not.toEqual([]);

    // The abort poisons the stub; from here the object is reached as the next request would.
    await expect(stub.abort('probe: the object died mid-plan')).rejects.toThrow();

    await env.DEPLOY_FAKE.releaseStall();

    const again = reopenRun();
    const resumed = await settled(again);
    const made = await env.DEPLOY_FAKE.state();
    const twice = made.creates.filter((name, at) => made.creates.indexOf(name) !== at);

    expect(resumed.state).toBe('done');
    expect(twice).toEqual([]);
    expect(made.uploads).toBe(1);
    expect(made.buckets.length).toBe(new Set(made.buckets).size);
    expect(await again.heldSecretNames()).toEqual([]);
  });
});

/**
 * A plan that outlives its Cloudflare access token: the fake refuses the token after the lifetime this
 * row chooses, so a run that did not renew fails every step with 401.
 */
describe('a run whose access token expired', () => {
  it('renews it inside the plan and finishes on the token the renewal minted', async () => {
    await env.DEPLOY_FAKE.expireGrant(30);

    const stub = await authorized();

    await stub.start(INPUTS);

    const snapshot = await settled(stub);
    const made = await env.DEPLOY_FAKE.state();

    expect(snapshot.state).toBe('done');
    expect(made.refreshes).toBe(1);
    // The renewal happened before the plan's first write, not after a failed step.
    expect(made.expiredCalls).toBe(0);
    expect(made.uploads).toBe(1);
    // The rotated pair is left, so the first self-update spends a grant that still exists.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
  });
});

/**
 * One release's cost to the installing object (`do.isolate.transient_alloc_reset`,
 * `packages/core/src/platform-catalog.ts`: a transient 128 MiB allocate-and-free resets it).
 * Measured 2026-09-18 on `@cloudflare/workerd-linux-64`: the isolate cannot read its own memory, so the run
 * records its peak (`FACT_UPLOAD_PEAK`); 88.18 MiB held for a 108.46 MiB release, where the replaced reader held 243.39 MiB.
 * Defends the shape: the peak is set by the largest member and the batch bound, never by the release.
 */
describe('the artifact in a Durable Object', () => {
  const MIB = 1024 * 1024;

  it('installs a release it never holds, a member at a time', async () => {
    await env.DEPLOY_FAKE.weigh({
      modules: 120, moduleBytes: 30 * MIB, assets: 421, assetBytes: 78 * MIB, largestAsset: 21.5 * MIB,
    });

    const stub = await authorized();

    await stub.start(INPUTS);

    const snapshot = await settled(stub);

    expect(snapshot.state).toBe('done');

    const { footprint } = await env.DEPLOY_FAKE.state();
    const upload = snapshot.steps.find((row) => row.id === 'upload');
    const peak = Number(upload?.facts[FACT_UPLOAD_PEAK] ?? Number.NaN);

    expect(footprint.unpacked).toBeGreaterThan(100 * MIB);
    expect(footprint.largestMember).toBeGreaterThan(21 * MIB);

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(128 * MIB);

    // Compressed artifact plus one member's base64 plus the transport's copy of the body.
    expect(peak).toBeLessThan(footprint.served + 3 * footprint.largestMember);

    // A batch is bounded: a body carrying the whole bundle, or the release twice, fails.
    expect(footprint.assetBatches).toBeGreaterThan(1);
    expect(footprint.assetBody).toBeLessThan(2 * footprint.largestMember);
    expect(footprint.versionBody).toBeLessThan(footprint.unpacked / 2);
  });
});
