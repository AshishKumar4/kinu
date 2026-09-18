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
  DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_VERSION,
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

/** Another stub for the object the last `openRun` named. A stub whose object
 *  was aborted is poisoned — every call on it answers with the abort — so the
 *  row that killed one reaches it again through a new stub, the way the next
 *  request would. */
function reopenRun() {
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

/** Generous, and never spent on a passing run: the wait stops at the outcome. */
const DEADLINE_MS = 20_000;

const POLL_MS = 25;

/**
 * The run, driven to its outcome.
 *
 * `start` answers before the first step exists — the plan runs on the object's
 * alarm — so a row that wants the finished ledger waits for the state the alarm
 * wrote. Waiting for the CONDITION rather than sleeping: a broken runner spends
 * the deadline and the assertion then reports whatever state it reached.
 */
async function settled(stub: { snapshot(): Promise<DeploySnapshot> }): Promise<DeploySnapshot> {
  const deadline = Date.now() + DEADLINE_MS;
  let held = await stub.snapshot();

  while (held.state !== 'done' && held.state !== 'failed' && Date.now() < deadline) {
    await scheduler.wait(POLL_MS);
    held = await stub.snapshot();
  }

  return held;
}

/** A run minted the way the page mints one, and the key it answered with. */
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
    // The deployment owns its key from here: the refresh token is a secret on
    // the new Worker, and the run's vault is empty.
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

  /** The `__Host-kinu_deploy_state` value a `set-cookie` carries, or ''. */
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
    const run = await mintedRun();

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
    // The query form is not read at all: a caller that put the key in a URL is
    // refused, which is what keeps it out of the logs.
    expect(byQuery.status).toBe(403);
    expect(bySocket.status).toBe(101);
  });
});

/**
 * The vault's bound: an hour of not moving, and the tokens are gone.
 *
 * WHY THIS IS TWO ASSERTIONS AND NOT ONE. That the bound EXISTS is the armed
 * alarm — a run holding somebody's Cloudflare tokens with no timer is the
 * defect, and `alarmAt` reads the object's own slot. That it WORKS is the
 * runtime delivering that alarm to the production `alarm()`: the row brings the
 * expiry forward and waits for the wipe, so what empties the vault is a real
 * dispatch and not a method the test called.
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
    // Still held right after the refusal: a refusal is not a reason to drop the
    // authorization a person gave, and the run is resumable.
    expect(await stub.heldSecretNames()).not.toEqual([]);

    const due = await stub.alarmAt();

    // An hour, give or take the time the plan took.
    expect(due - Date.now()).toBeGreaterThan(3_000_000);
    expect(due - Date.now()).toBeLessThanOrEqual(3_600_000);

    expect(await stub.expireSoon()).toBe(true);

    const deadline = Date.now() + DEADLINE_MS;

    while ((await stub.heldSecretNames()).length > 0 && Date.now() < deadline) {
      await scheduler.wait(POLL_MS);
    }

    expect(await stub.heldSecretNames()).toEqual([]);
    // The ledger survives and says what happened, so the page can offer signing
    // in again into the same run rather than a second set of everything.
    expect((await stub.snapshot()).state).toBe('expired');
    expect((await stub.snapshot()).steps.length).toBeGreaterThan(0);
  });

  it('deletes an object that never got past minting', async () => {
    const run = await mintedRun();
    const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(run.runId));

    // `POST /api/deploy/runs` is public, so every probe of the door leaves an
    // object behind. One that never ran a step leaves nothing at all.
    expect(await stub.alarmAt()).toBeGreaterThan(Date.now());
    expect(await stub.expireSoon()).toBe(true);

    const deadline = Date.now() + DEADLINE_MS;

    while (await stub.alarmAt() !== 0 && Date.now() < deadline) await scheduler.wait(POLL_MS);

    expect(await stub.snapshot()).toEqual({ runId: '', state: 'collecting', address: '', version: '', steps: [] });
    expect(await stub.admits(run.runKey)).toBe(false);
  });
});

/**
 * The eviction a run cannot control, delivered on purpose.
 *
 * WHAT IS PLATFORM HERE AND NOWHERE ELSE: the runtime redelivers an alarm
 * whose handler did not finish. `ctx.abort()` destroys the activation driving
 * the plan mid-step, so the intent is still stored, the row the step was on is
 * still `running`, and nothing recorded an outcome — and the deployment must
 * carry on from there rather than start again. The worst moment to die is
 * chosen on purpose: the account already holds the bucket the step created and
 * the object never learned it, which is exactly what "the steps look before
 * they create" is for.
 */
describe('a run the runtime could not finish', () => {
  it('carries on from the redelivered alarm and creates nothing twice', async () => {
    const stub = await authorized();

    // The R2 creation is answered late: while this call hangs the bucket
    // exists in the account and the run does not know it.
    await env.DEPLOY_FAKE.stallOnce({
      method: 'POST', path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/r2/buckets`, ms: 2_000,
    });
    await stub.start(INPUTS);

    const deadline = Date.now() + DEADLINE_MS;

    while (stateOf(await stub.snapshot(), 'r2') !== 'running' && Date.now() < deadline) {
      await scheduler.wait(POLL_MS);
    }

    expect(stateOf(await stub.snapshot(), 'r2')).toBe('running');
    expect((await env.DEPLOY_FAKE.state()).buckets).not.toEqual([]);

    // The abort takes the caller's own RPC with it, and poisons the stub: from
    // here the object is reached the way the next request reaches it.
    await expect(stub.abort('probe: the object died mid-plan')).rejects.toThrow();

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
 * The hour a Cloudflare access token lasts, against a plan that outlives it.
 *
 * A person who answers the questions, hits a refusal, and comes back after
 * lunch is the ordinary case: the run holds a token the API no longer accepts.
 * The fake's authorization server hands out a lifetime this row chooses and
 * then refuses that access token on every call, the way Cloudflare refuses an
 * expired one, so a run that did not renew fails every step with 401 instead
 * of passing.
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
    // Not one call was answered 401: the renewal happened before the plan's
    // first write, not after a step had already failed.
    expect(made.expiredCalls).toBe(0);
    expect(made.uploads).toBe(1);
    // And the pair the deployment is left with is the rotated one, so its own
    // first self-update spends a grant that still exists.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
  });
});

/**
 * What one release costs the object that installs it.
 *
 * MEASURED, NOT ASSERTED, and measured by the plane rather than by the code:
 * the isolate offers no memory reading at all (2026-09-18, workerd through
 * `vitest-pool-workers`: `performance.measureUserAgentSpecificMemory` is
 * undefined and `process.memoryUsage()` answers zeroes; the pool enforces no
 * memory ceiling either — 400 MiB allocated there without complaint — so a row
 * cannot reach `do.isolate.transient_alloc_reset` by trying). The four figures
 * below are bytes this channel really served and bodies the object really
 * built and sent.
 *
 * THE MULTIPLE, 2026-09-18 on this tree, for an 8 MiB release: served
 * 4.34 MiB compressed, 8.01 MiB unpacked and held for the length of the plan,
 * one 10.67 MiB asset body, 1.6 KiB version body — 23.01 MiB at the peak,
 * 2.87x the unpacked release.
 *
 * AND THE RELEASE THIS TREE PUBLISHES DOES NOT FIT. Measured the same day from
 * `scripts/build-worker-release.ts` at f75d4745b: the artifact is 27.35 MiB
 * compressed and 107.99 MiB unpacked, so the digest check (which holds the
 * compressed bytes) and the unpacked archive come to 135.34 MiB together,
 * before one asset is base64'd. `do.isolate.transient_alloc_reset` is the
 * entry that governs it — a transient allocate-and-free of that size in a
 * Durable Object context resets the object about 1.7 s later, after the
 * request returned 200 — so the guided door cannot install today's release
 * from inside `DeployRunDO`. docs/SELF-DEPLOY.md carries the finding.
 *
 * WHAT THE BOUND DEFENDS: the multiple, not the size. An upload that base64'd
 * every asset before sending any grows with the release instead of with its
 * largest batch, and the artifact is the one thing here that only gets bigger.
 */
describe('the artifact in a Durable Object', () => {
  const MIB = 1024 * 1024;

  it('holds one unpacked release and one batch of assets', async () => {
    await env.DEPLOY_FAKE.weigh(8 * MIB);

    const stub = await authorized();

    await stub.start(INPUTS);

    expect((await settled(stub)).state).toBe('done');

    const { footprint } = await env.DEPLOY_FAKE.state();
    const peak = footprint.served + footprint.unpacked + footprint.assetBody;

    expect(footprint.unpacked).toBeGreaterThan(8 * MIB);
    // base64 of the batch plus its multipart envelope, and nothing else: a
    // body that carried a second copy of the release fails here.
    expect(footprint.assetBody).toBeLessThan(footprint.unpacked * 1.5);
    expect(peak).toBeLessThan(footprint.unpacked * 4);
  });
});
