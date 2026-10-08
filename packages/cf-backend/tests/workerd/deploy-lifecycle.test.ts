/**
 * A self-deployment's life in workerd over real DO SQLite, as journeys rather than rows: minted at the door and
 * authorized there, refused, retried, killed mid-step, renewed, a large release installed; a run nobody finished;
 * and the deployment updating itself through owner-only reads, a failed smoke, an expired vault and successive
 * releases. Step logic and offer arithmetic are `packages/core/tests/unit-deploy-flow.test.ts`'s. The plane is
 * `deploy-fake.ts`; an unmatched host throws.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { sha256Hex } from '@kinu.run/core';
import {
  DEPLOY_SOCKET_PROTOCOL, DeploySnapshotSchema, DeploymentRecordSchema, FACT_UPLOAD_PEAK, SELF_UPDATE_RUN_ID, UpdateOfferSchema, runKeyDigest,
  type DeployInputs, type DeploySnapshot,
} from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_ACCOUNT, DEPLOY_FAKE_CHANNEL_BUILD, DEPLOY_FAKE_OLDER_BUILD, DEPLOY_FAKE_OWNER,
  DEPLOY_FAKE_REFRESH_TOKEN, DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

/** Spelled rather than imported: the name is part of what the browser is promised. */
const DEPLOY_STATE_COOKIE = '__Host-kinu_deploy_state';

const INPUTS: DeployInputs = {
  accountId: DEPLOY_FAKE_ACCOUNT, instanceName: 'kinu', address: { kind: 'workers-dev', hostname: '', zoneId: '' },
  ownerEmail: 'owner@example.com', accessEmails: ['owner@example.com'], providerKeyNames: [], sandbox: false,
};

const ADDRESS = `kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev`;

const MIB = 1024 * 1024;

const R2_REFUSAL = {
  path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/r2/buckets`, status: 403, code: 10_042,
  message: 'R2 is not enabled for this account. Add a payment method to enable R2.',
};

async function mintedRun(): Promise<{ runId: string; runKey: string }> {
  const minted = await env.DEPLOY_DOOR_PROBE.hit('POST', '/api/deploy/runs');

  return v.parse(v.object({ runId: v.string(), runKey: v.string() }), JSON.parse(minted.body));
}

const runStub = (runId: string) => env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(runId));

const stateOf = (snapshot: DeploySnapshot, id: string): string => snapshot.steps.find((row) => row.id === id)?.state ?? 'absent';

const callback = (state: string, cookie?: string) => env.DEPLOY_DOOR_PROBE.hit(
  'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`, cookie === undefined ? undefined : { cookie: `${DEPLOY_STATE_COOKIE}=${cookie}` },
);

/** The authorize leg's handoff: its state, and the cookie that binds it to the browser that asked. */
async function authorizeLeg(run: { runId: string; runKey: string }) {
  const handoff = await env.DEPLOY_DOOR_PROBE.hit('POST', `/api/deploy/runs/${run.runId}/authorize`, { authorization: `Bearer ${run.runKey}` });
  const state = new URL(v.parse(v.object({ location: v.string() }), JSON.parse(handoff.body)).location).searchParams.get('state') ?? '';
  const bound = handoff.setCookie.find((cookie) => cookie.startsWith(`${DEPLOY_STATE_COOKIE}=`))?.split(';')[0]?.slice(DEPLOY_STATE_COOKIE.length + 1) ?? '';

  return { status: handoff.status, state, bound };
}

const twiceCreated = (creates: readonly string[]) => creates.filter((name, at) => creates.indexOf(name) !== at);

describe('a guided self-deployment', () => {
  it('is authorized at the door, refused, retried, killed mid-step and renewed, and deploys a large release holding nothing', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.expireGrant(30);
    await env.DEPLOY_FAKE.weigh({ modules: 120, moduleBytes: 30 * MIB, assets: 421, assetBytes: 78 * MIB, largestAsset: 21.5 * MIB });

    const run = await mintedRun();
    const stub = runStub(run.runId);

    // The run key travels in a header or the socket's subprotocol, never in a query a log would keep.
    const keys = {
      header: (await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}`, { authorization: `Bearer ${run.runKey}` })).status,
      query: (await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}?key=${encodeURIComponent(run.runKey)}`)).status,
      socket: (await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}/socket`, {
        upgrade: 'websocket', 'sec-websocket-protocol': `${DEPLOY_SOCKET_PROTOCOL}, ${run.runKey}`,
      })).status,
    };

    // A callback the leg's browser did not start, a state no leg minted, and a spent state all land nothing.
    const leg = await authorizeLeg(run);
    const forwarded = await callback(leg.state);
    const invented = `${run.runId}.not-a-nonce-this-object-minted`;
    const unknown = await callback(invented, sha256Hex(invented));
    const unauthorizedAfterForgeries = !(await stub.authorized());
    const landed = await callback(leg.state, sha256Hex(leg.state));
    const replayed = await callback(leg.state, sha256Hex(leg.state));

    expect({
      keys,
      leg: { status: leg.status, bound: leg.bound === await sha256HexOf(leg.state) },
      forwarded: forwarded.status,
      unknown: unknown.status,
      unauthorizedAfterForgeries,
      landed: landed.status,
      replayed: replayed.status,
      authorized: await stub.authorized(),
    }).toEqual({
      keys: { header: 200, query: 403, socket: 101 },
      leg: { status: 200, bound: true },
      forwarded: 400,
      unknown: 400,
      unauthorizedAfterForgeries: true,
      landed: 302,
      replayed: 400,
      authorized: true,
    });

    // Refused: the run stops at that step in Cloudflare's own words, keeps the authorization, and bounds how long.
    await env.DEPLOY_FAKE.refuseOnce(R2_REFUSAL);
    await stub.start(INPUTS);

    const refused = await stub.settledAfter(['done', 'failed']);
    const r2 = refused.steps.find((row) => row.id === 'r2');
    const lifetime = (await stub.alarmAt()) - (await stub.armedAt());

    expect({
      state: refused.state, failure: r2?.failure, upload: stateOf(refused, 'upload'), uploads: (await env.DEPLOY_FAKE.state()).uploads,
      holds: (await stub.heldCredentials()).length > 0, lifetimeWithinAnHour: lifetime > 3_000_000 && lifetime <= 3_600_000,
    }).toEqual({
      state: 'failed', failure: expect.objectContaining({ detail: R2_REFUSAL.message, code: R2_REFUSAL.code }), upload: 'pending', uploads: 0,
      holds: true, lifetimeWithinAnHour: true,
    });

    // Retried, then killed inside the next create: the redelivered alarm carries on, looking before it creates.
    await env.DEPLOY_FAKE.stallOnce({ method: 'POST', path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/ai-gateway/gateways` });
    await stub.retry('r2');
    await env.DEPLOY_FAKE.stallReached();
    await expect(stub.abort('probe: the object died mid-plan')).rejects.toThrow();
    await env.DEPLOY_FAKE.releaseStall();

    const again = runStub(run.runId);
    const done = await again.settledAfter(['done', 'failed']);
    const made = await env.DEPLOY_FAKE.state();
    const rows = await again.rowText();
    const peak = Number(done.steps.find((row) => row.id === 'upload')?.facts[FACT_UPLOAD_PEAK] ?? Number.NaN);

    expect({
      state: done.state, address: done.address, version: done.version, allDone: done.steps.every((row) => row.state === 'done'),
      r2Attempts: done.steps.find((row) => row.id === 'r2')?.attempt,
      createdTwice: twiceCreated(made.creates), uploads: made.uploads, namespaces: made.namespaces,
      // Renewed before the plan's first write, not after a failed step; the rotated pair is the one left behind.
      refreshes: made.refreshes, expiredCalls: made.expiredCalls, refreshSecret: made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN,
      held: await again.heldCredentials(),
      rowsHoldSecrets: [await runKeyDigest(run.runKey), run.runKey, DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_REFRESH_TOKEN].some((secret) => rows.includes(secret)),
      rowsNameAddress: rows.includes(ADDRESS),
    }).toEqual({
      state: 'done', address: ADDRESS, version: DEPLOY_FAKE_VERSION, allDone: true, r2Attempts: 2,
      createdTwice: [], uploads: 1, namespaces: ['kinu-auth-kv'],
      refreshes: 1, expiredCalls: 0, refreshSecret: DEPLOY_FAKE_ROTATED_REFRESH,
      held: [], rowsHoldSecrets: false, rowsNameAddress: true,
    });

    // `do.isolate.transient_alloc_reset` (packages/core/src/platform-catalog.ts): the peak is set by the largest member
    // and the batch bound, never by the release (measured 2026-09-18: 88.18 MiB held for a 108.46 MiB release).
    const { footprint } = made;

    expect({
      large: footprint.unpacked > 100 * MIB && footprint.largestMember > 21 * MIB,
      peakUnderReset: peak > 0 && peak < 128 * MIB,
      peakByMember: peak < footprint.served + 3 * footprint.largestMember,
      batched: footprint.assetBatches > 1 && footprint.assetBody < 2 * footprint.largestMember && footprint.versionBody < footprint.unpacked / 2,
    }).toEqual({ large: true, peakUnderReset: true, peakByMember: true, batched: true });
  });

  it('loses an unfinished run\'s tokens when its lifetime ends, and deletes an object that never ran a step', async () => {
    await env.DEPLOY_FAKE.reset();

    const run = await mintedRun();
    const stub = runStub(run.runId);
    const leg = await authorizeLeg(run);

    await callback(leg.state, sha256Hex(leg.state));
    await env.DEPLOY_FAKE.refuseOnce(R2_REFUSAL);
    await stub.start(INPUTS);
    await stub.settledAfter(['done', 'failed']);

    expect(await stub.expireSoon()).toBe(true);

    const expired = await stub.settledAfter(['expired']);
    const untouched = await mintedRun();
    const idle = runStub(untouched.runId);

    expect(await idle.expireSoon()).toBe(true);

    const left = await idle.reportAfterAlarm();

    expect({
      // The ledger stays so the page can offer signing in again into the same run.
      expired: { state: expired.state, ledger: expired.steps.length > 0, held: await stub.heldCredentials() },
      idle: { left, alarm: await idle.alarmAt(), admits: await idle.admits(untouched.runKey) },
    }).toEqual({
      expired: { state: 'expired', ledger: true, held: [] },
      idle: { left: { runId: '', state: 'collecting', address: '', version: '', steps: [] }, alarm: 0, admits: false },
    });
  });
});

/** The record's own owner at a browser: the only session the update surface answers. */
const OWNER = { userId: 'probe-owner', email: DEPLOY_FAKE_OWNER, sub: 'probe-owner-sub', provider: 'google' };

const NEXT_BUILD = { version: '0.4.1+probe02', sha: 'probe02', builtAt: '2026-09-19T00:00:00.000Z' };

const updateRun = () => runStub(SELF_UPDATE_RUN_ID);

async function applied(): Promise<DeploySnapshot> {
  await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);
  await updateRun().settledAfter(['done', 'failed']);

  return v.parse(DeploySnapshotSchema, JSON.parse((await env.UPDATES_PROBE.hit('GET', '/api/updates/run', OWNER)).body));
}

const offer = async (who: typeof OWNER) => v.parse(UpdateOfferSchema, JSON.parse((await env.UPDATES_PROBE.hit('GET', '/api/updates', who)).body));

describe('a deployment updating itself', () => {
  it('answers only its owner at a browser, installs each release once, and survives a failed smoke and an expired vault', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.existing();
    await updateRun().forget();
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);

    // 404, not 403: whether an update surface exists is itself a fact about the owner.
    const strangers = [
      (await env.UPDATES_PROBE.hit('GET', '/api/updates', { ...OWNER, userId: 'probe-other', email: 'someone@example.com' })).status,
      (await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', { ...OWNER, cliScopes: ['workspace:read'] })).status,
      (await env.UPDATES_PROBE.hit('GET', '/api/updates', { ...OWNER, provider: 'cli' })).status,
      (await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', { ...OWNER, provider: 'cli' })).status,
    ];

    const behind = await offer(OWNER);
    const first = await applied();
    const installed = await env.DEPLOY_FAKE.state();
    const record = v.parse(DeploymentRecordSchema, JSON.parse(installed.secrets.KINU_DEPLOYMENT_RECORD ?? '{}'));

    expect({
      strangers, uploadsBeforeOwner: installed.uploads - 1,
      behind: { current: behind.current?.version, available: behind.available, installable: behind.installable },
      first: { runId: first.runId, state: first.state, version: first.version },
      installed: { serving: installed.servingRelease, record: record.version, refresh: installed.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN },
    }).toEqual({
      strangers: [404, 404, 404, 404], uploadsBeforeOwner: 0,
      behind: { current: DEPLOY_FAKE_OLDER_BUILD.version, available: DEPLOY_FAKE_CHANNEL_BUILD, installable: true },
      first: { runId: SELF_UPDATE_RUN_ID, state: 'done', version: DEPLOY_FAKE_VERSION },
      // It spent its own refresh token and bound the rotated one: writing back the one it held would update once, never again.
      installed: { serving: DEPLOY_FAKE_VERSION, record: DEPLOY_FAKE_VERSION, refresh: DEPLOY_FAKE_ROTATED_REFRESH },
    });

    // Serving the channel's build: up to date, and an install is refused.
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_CHANNEL_BUILD);

    const current = await offer(OWNER);
    const refused = await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect({ upToDate: current.upToDate, refused: refused.status, uploads: (await env.DEPLOY_FAKE.state()).uploads })
      .toEqual({ upToDate: true, refused: 409, uploads: 1 });

    // The next release: its smoke fails twice and the old version keeps serving; the vault expires in between, and the
    // apply after that refreshes only if the deployment kept the last rotated token.
    await env.DEPLOY_FAKE.publish(NEXT_BUILD);

    const next = await offer(OWNER);

    await env.DEPLOY_FAKE.refuseOnce({ path: '/api/health', status: 502, code: 0, message: 'bad gateway' });
    const smoked = await applied();
    const servingAfterSmoke = (await env.DEPLOY_FAKE.state()).servingRelease;

    await env.DEPLOY_FAKE.refuseOnce({ path: '/api/health', status: 502, code: 0, message: 'bad gateway' });
    const smokedAgain = await applied();

    expect(await updateRun().expireSoon()).toBe(true);
    const expired = await updateRun().settledAfter(['expired']);
    const finished = await applied();
    const made = await env.DEPLOY_FAKE.state();

    expect({
      next: { version: next.available?.version, installable: next.installable },
      smoked: [smoked.state, smokedAgain.state], servingAfterSmoke, expired: expired.state,
      finished: { state: finished.state, version: finished.version }, serving: made.servingRelease,
      refreshIsLive: made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN === made.liveRefresh,
      vaultHolds: (await updateRun().heldCredentials()).length > 0,
    }).toEqual({
      next: { version: NEXT_BUILD.version, installable: true },
      smoked: ['failed', 'failed'], servingAfterSmoke: DEPLOY_FAKE_CHANNEL_BUILD.version, expired: 'expired',
      finished: { state: 'done', version: NEXT_BUILD.version }, serving: NEXT_BUILD.version,
      refreshIsLive: true, vaultHolds: false,
    });
  });
});

/** SHA-256 of `text`, hex, from Web Crypto rather than the product's own digest helper. */
async function sha256HexOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
