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
  DEPLOY_SOCKET_PROTOCOL, DeployPreflightSchema, DeployRunFrameSchema, DeployRunViewSchema, DeploySessionSchema, DeploySnapshotSchema,
  DeploymentRecordSchema, FACT_UPLOAD_PEAK, SELF_UPDATE_RUN_ID, UpdateOfferSchema, runKeyDigest,
  type DeployInputs, type DeploySnapshot,
} from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_ACCOUNT, DEPLOY_FAKE_CHANNEL_BUILD, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_OLDER_BUILD, DEPLOY_FAKE_OWNER,
  DEPLOY_FAKE_REFRESH_TOKEN, DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_SUBDOMAIN, DEPLOY_FAKE_USER, DEPLOY_FAKE_VERSION, deployFakeZoneId,
} from './deploy-fake';

/** Spelled rather than imported: the name is part of what the browser is promised. */
const DEPLOY_STATE_COOKIE = '__Host-kinu_deploy_state';

const DEPLOY_SESSION_COOKIE = '__Host-kinu_deploy_session';

const INPUTS: DeployInputs = {
  accountId: DEPLOY_FAKE_ACCOUNT, instanceName: 'kinu', address: { kind: 'workers-dev', hostname: '', zoneId: '' },
  ownerEmail: 'owner@example.com', providerKeyNames: [], sandbox: false,
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

  // kinu.run 2026-10-20: a declined consent or a refused scope came back as "That is not an authorization this flow
  // started.", and a refused account listing as a bare route error.
  it('brings Cloudflare\'s own refusal to the page: a declined consent, a refused code, a refused read', async () => {
    await env.DEPLOY_FAKE.reset();

    const run = await mintedRun();
    const declined = await env.DEPLOY_DOOR_PROBE.hit('GET', '/deploy/callback?error=access_denied&error_description=The%20resource%20owner%20denied%20the%20request.');
    const leg = await authorizeLeg(run);
    const refusedCode = await env.DEPLOY_DOOR_PROBE.hit('GET', `/deploy/callback?code=not-issued&state=${encodeURIComponent(leg.state)}`, { cookie: `${DEPLOY_STATE_COOKIE}=${sha256Hex(leg.state)}` });
    const signedIn = await authorizeLeg(run);

    await callback(signedIn.state, sha256Hex(signedIn.state));
    await env.DEPLOY_FAKE.refuseOnce({ path: '/accounts?', status: 403, code: 9109, message: 'Unauthorized to access requested resource' });
    const listing = await env.DEPLOY_DOOR_PROBE.hit('GET', `/api/deploy/runs/${run.runId}/accounts`, { authorization: `Bearer ${run.runKey}` });
    const params = (location: string) => Object.fromEntries(new URL(location, 'https://kinu.probe.workers.dev').searchParams);

    expect({
      declined: { status: declined.status, page: params(declined.location) },
      refusedCode: { status: refusedCode.status, page: params(refusedCode.location) },
      listing: { status: listing.status, body: listing.body },
    }).toEqual({
      declined: { status: 302, page: { error: 'access_denied', error_description: 'The resource owner denied the request.' } },
      refusedCode: { status: 302, page: { error: 'token_exchange_failed', error_description: expect.stringContaining('that authorization code is not one this server issued') } },
      listing: { status: 502, body: expect.stringContaining('Unauthorized to access requested resource') },
    });
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
      idle: { left: { runId: '', state: 'collecting', address: '', version: '', steps: [], setupLink: null }, alarm: 0, admits: false },
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

const HOUR = 3_600_000;

const WEEK = 7 * 24 * HOUR;

const NEW_KINU = { kind: 'new', account: DEPLOY_FAKE_ACCOUNT, name: 'kinu', address: { kind: 'workers' }, computer: false, mail: null };

const newKinu = JSON.stringify(NEW_KINU);

/** One browser on the page: its sign-in cookie, carried as a browser carries it. */
async function signedInPage(): Promise<string> {
  const started = await env.DEPLOY_DOOR_PROBE.hit('POST', '/api/deploy/signin', { 'content-type': 'application/json', ...FROM_THE_PAGE }, JSON.stringify({ end: 'tab' }));
  const cookie = (name: string) => started.setCookie.find((each) => each.startsWith(`${name}=`))?.split(';')[0] ?? '';
  const state = new URL(v.parse(v.object({ location: v.string() }), JSON.parse(started.body)).location).searchParams.get('state') ?? '';

  const landed = await env.DEPLOY_DOOR_PROBE.hit(
    'GET', `/deploy/callback?code=probe-code&state=${encodeURIComponent(state)}`, { cookie: `${cookie(DEPLOY_STATE_COOKIE)}; ${cookie(DEPLOY_SESSION_COOKIE)}` },
  );

  expect({ status: landed.status, location: landed.location }).toEqual({ status: 302, location: '/deploy' });

  return cookie(DEPLOY_SESSION_COOKIE);
}

/** What a browser says of a request the page itself made. */
const FROM_THE_PAGE = { 'sec-fetch-site': 'same-origin' };

/** A call from that browser: no run key, only its cookie; a body is JSON. */
const page = async (cookie: string, method: string, path: string, body?: string) => env.DEPLOY_DOOR_PROBE.hit(
  method, path, body === undefined ? { cookie, ...FROM_THE_PAGE } : { cookie, 'content-type': 'application/json', ...FROM_THE_PAGE }, body,
);

const current = async (cookie: string) => v.parse(DeployRunViewSchema, JSON.parse((await page(cookie, 'GET', '/api/deploy/runs/current')).body));

const sessionOf = async (cookie: string) => v.parse(DeploySessionSchema, JSON.parse((await page(cookie, 'GET', '/api/deploy/session')).body));

// A preview or share host is the same site, so the browser sends it the page's cookie: it may not act with it.
it('refuses the page\'s routes to a request from a sibling host, which carries the cookie, and keeps the CLI\'s door', async () => {
  await env.DEPLOY_FAKE.reset();

  const cookie = await signedInPage();
  const sibling = { cookie, 'sec-fetch-site': 'same-site', origin: 'https://preview-1.kinu.probe.workers.dev' };
  const asked = async (method: string, path: string, body?: string) => (await env.DEPLOY_DOOR_PROBE.hit(method, path, body === undefined ? sibling : { ...sibling, 'content-type': 'application/json' }, body)).status;

  expect({
    session: await asked('GET', '/api/deploy/session'),
    run: await asked('POST', '/api/deploy/runs', newKinu),
    carryOn: await asked('POST', '/api/deploy/runs/current/continue'),
    current: await asked('GET', '/api/deploy/runs/current'),
    page: (await page(cookie, 'GET', '/api/deploy/session')).status,
    cli: (await env.DEPLOY_DOOR_PROBE.hit('POST', '/api/deploy/runs')).status,
  }).toEqual({ session: 403, run: 403, carryOn: 403, current: 403, page: 200, cli: 200 });
});

/** The run is named for its Cloudflare user and account; the sign-in for its cookie's digest. */
const pageRun = (user = DEPLOY_FAKE_USER.id) => runStub(`deploy-run.${user}.${DEPLOY_FAKE_ACCOUNT}`);

const signInObject = (cookie: string) => runStub(`deploy-session.${sha256Hex(cookie.slice(DEPLOY_SESSION_COOKIE.length + 1))}`);

describe('the deploy page', () => {
  it('signs in with Cloudflare, pauses a run on R2 and carries on once it is on, and goes live with its setup link', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.r2(false);

    const cookie = await signedInPage();
    const session = await sessionOf(cookie);
    const checklist = v.parse(DeployPreflightSchema, JSON.parse((await page(cookie, 'GET', `/api/deploy/preflight?account=${DEPLOY_FAKE_ACCOUNT}`)).body));
    const begun = await page(cookie, 'POST', '/api/deploy/runs', newKinu);
    const run = pageRun();

    await run.settledAfter(['failed']);

    // Asked again by the page's read and by its own clock, still refused: paused, never refused.
    const readsBefore = (await env.DEPLOY_FAKE.state()).r2Reads;
    const paused = await current(cookie);

    await run.settledAfter(['failed']);
    await run.advance(15_000);
    await run.settledAfter(['failed']);
    const rechecks = (await env.DEPLOY_FAKE.state()).r2Reads - readsBefore;

    expect({
      session, begun: begun.status,
      checklist: { r2: checklist.r2, needs: checklist.needs.map((need) => need.id), name: checklist.suggestedName, subdomain: checklist.workersSubdomain, plan: checklist.plan },
      paused: { state: paused.state, phase: paused.phase.id, need: paused.paused?.id, href: paused.paused?.action.href, code: paused.paused?.details?.code },
      rechecked: rechecks >= 2,
      // The grant moved into the run: the sign-in keeps its access token for reads, never the refresh token.
      sessionHolds: await signInObject(cookie).heldCredentials(),
      runHolds: await run.heldCredentials(),
    }).toEqual({
      session: { signedIn: true, email: DEPLOY_FAKE_OWNER, unreadable: [], accounts: [{ id: DEPLOY_FAKE_ACCOUNT, name: 'Probe Account' }], resume: null, deployments: [], apiTokens: 'granted' },
      begun: 200,
      checklist: { r2: 'off', needs: ['r2'], name: 'kinu', subdomain: DEPLOY_FAKE_SUBDOMAIN, plan: 'unknown' },
      paused: { state: 'paused', phase: 'storage', need: 'r2', href: `https://dash.cloudflare.com/${DEPLOY_FAKE_ACCOUNT}/r2/overview`, code: 10_042 },
      rechecked: true,
      sessionHolds: [DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_ACCESS_TOKEN],
      runHolds: [DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_REFRESH_TOKEN],
    });

    await env.DEPLOY_FAKE.r2(true);
    await current(cookie);
    await run.settledAfter(['done']);

    const live = await current(cookie);
    const frames = await env.DEPLOY_FRAMES_PROBE.frames('/api/deploy/runs/current/socket', { upgrade: 'websocket', cookie, ...FROM_THE_PAGE }, 2);
    const made = await env.DEPLOY_FAKE.state();
    const rows = await run.rowText();

    expect({
      state: live.state, url: live.live?.url, link: live.live?.setupLink.startsWith(`https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev/login?setup=`),
      cli: live.live?.cli, phases: live.phases.map((phase) => phase.state), uploads: made.uploads,
      frame: v.parse(DeployRunFrameSchema, JSON.parse(frames[1] ?? '{}')).run, held: await run.heldCredentials(),
      rowsHoldSecrets: [DEPLOY_FAKE_ACCESS_TOKEN, DEPLOY_FAKE_REFRESH_TOKEN, cookie.slice(DEPLOY_SESSION_COOKIE.length + 1)].some((secret) => rows.includes(secret)),
    }).toEqual({
      state: 'live', url: `https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev`, link: true,
      cli: `curl -fsSL https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev/install.sh | bash`, phases: ['done', 'done', 'done', 'done', 'done', 'done'], uploads: 1,
      frame: live, held: [], rowsHoldSecrets: false,
    });
  });

  it('lets go of the grant an hour into a pause, keeps what it minted, resumes from another device, and deletes itself a week on', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.refuseOnce({ path: `/accounts/${DEPLOY_FAKE_ACCOUNT}/workers/scripts/kinu/subdomain`, status: 401, code: 10_000, message: 'Authentication error', sticky: true });

    const first = await signedInPage();
    const runId = v.parse(v.object({ runId: v.string() }), JSON.parse((await page(first, 'POST', '/api/deploy/runs', newKinu)).body)).runId;
    const run = pageRun();

    await run.settledAfter(['failed']);
    const paused = await current(first);

    await run.settledAfter(['failed']);
    await run.advance(HOUR);

    const dropped = { view: await current(first), holds: await run.heldCredentials(), vault: await run.vaultNames() };

    // Another Cloudflare user's sign-in cannot name this run.
    await env.DEPLOY_FAKE.signInAs({ id: 'probe-other', email: 'other@example.com' });
    const stranger = await signedInPage();
    const strangers = { resume: (await sessionOf(stranger)).resume, current: (await page(stranger, 'GET', '/api/deploy/runs/current')).status };

    await env.DEPLOY_FAKE.signInAs(DEPLOY_FAKE_USER);
    await env.DEPLOY_FAKE.unrefuse();
    const second = await signedInPage();
    const resume = (await sessionOf(second)).resume;
    const continued = await page(second, 'POST', '/api/deploy/runs/current/continue');

    await run.settledAfter(['done']);
    const live = await current(second);
    const uploads = (await env.DEPLOY_FAKE.state()).uploads;

    await run.advance(WEEK);

    expect({
      paused: { state: paused.state, phase: paused.phase.id, need: paused.paused?.id, code: paused.paused?.details?.code },
      dropped: { state: dropped.view.state, need: dropped.view.paused?.id, holds: dropped.holds, vault: dropped.vault },
      strangers, resume, continued: continued.status,
      live: { runId: live.runId, state: live.state, uploads },
      gone: { object: await run.gone(), current: (await page(second, 'GET', '/api/deploy/runs/current')).status },
    }).toEqual({
      paused: { state: 'paused', phase: 'address', need: 'signin-again', code: 10_000 },
      dropped: { state: 'paused', need: 'signin-again', holds: [], vault: ['CREDENTIAL_ENCRYPTION_KEY', 'JWT_SECRET', 'KINU_FIRST_OWNER_LINK', 'WEBHOOK_ROUTE_SECRET'] },
      strangers: { resume: null, current: 404 },
      resume: { runId, account: DEPLOY_FAKE_ACCOUNT, phase: 'address', state: 'paused' },
      continued: 200,
      // The version it uploaded before the pause is the one that went live.
      live: { runId, state: 'live', uploads: 1 },
      gone: { object: true, current: 404 },
    });
  });

  it('offers a Kinu on an older build its update and installs it in place; one on the channel\'s build is offered nothing', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.existing();

    const cookie = await signedInPage();
    const offered = (await sessionOf(cookie)).deployments;

    await page(cookie, 'POST', '/api/deploy/runs', JSON.stringify({ kind: 'update', account: DEPLOY_FAKE_ACCOUNT, name: 'kinu' }));
    await pageRun().settledAfter(['done']);

    const made = await env.DEPLOY_FAKE.state();
    const after = (await sessionOf(cookie)).deployments;

    expect({
      offered: offered.map((kinu) => [kinu.name, kinu.url, kinu.update.current?.version, kinu.update.available?.version, kinu.update.installable]),
      installed: { uploads: made.uploads, serving: made.servingRelease, rootKeysBound: made.versionSecrets, live: (await current(cookie)).live?.url },
      after: after.map((kinu) => [kinu.name, kinu.update.current?.sha, kinu.update.upToDate, kinu.update.installable]),
    }).toEqual({
      offered: [['kinu', `https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev`, DEPLOY_FAKE_OLDER_BUILD.version, DEPLOY_FAKE_CHANNEL_BUILD.version, true]],
      // The same Worker, one new version, its root keys kept by Cloudflare rather than minted again.
      installed: { uploads: 1, serving: DEPLOY_FAKE_VERSION, rootKeysBound: [], live: `https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev` },
      after: [['kinu', DEPLOY_FAKE_CHANNEL_BUILD.sha, true, false]],
    });
  });

  it('adds a domain registered elsewhere as a zone, goes live on workers.dev meanwhile, and moves onto it once it is active', async () => {
    await env.DEPLOY_FAKE.reset();

    const cookie = await signedInPage();

    await page(cookie, 'POST', '/api/deploy/runs', JSON.stringify({ ...NEW_KINU, address: { kind: 'domain', domain: 'flourandhearth.com', host: 'flourandhearth.com' } }));
    const run = pageRun();

    await run.settledAfter(['done']);
    const waiting = await current(cookie);
    // The deployment holds the refresh token now, and the run none: it watches the domain in public DNS.
    const heldWhileWaiting = await run.heldCredentials();

    await env.DEPLOY_FAKE.activate(deployFakeZoneId('flourandhearth.com'));
    await run.advance(5 * 60_000);
    const ready = await current(cookie);
    // A sign-in on another device finds the run, and the grant it brings moves the deployment.
    const again = await signedInPage();

    await sessionOf(again);
    await page(again, 'POST', '/api/deploy/runs/current/continue');
    // Its clock looks at the zone with that grant, then runs the move.
    await run.advance(0);
    await run.advance(0);
    await run.settledAfter(['done']);

    const moved = await current(again);
    const made = await env.DEPLOY_FAKE.state();

    expect({
      waiting: { state: waiting.state, url: waiting.live?.url, pending: waiting.live?.pending }, heldWhileWaiting,
      ready: ready.live?.pending?.ready,
      moved: { state: moved.state, url: moved.live?.url, pending: moved.live?.pending },
      made: { domains: made.domains, uploads: made.uploads }, held: await run.heldCredentials(),
    }).toEqual({
      waiting: {
        state: 'live', url: `https://kinu.${DEPLOY_FAKE_SUBDOMAIN}.workers.dev`,
        pending: { domain: 'flourandhearth.com', nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], ready: false },
      },
      heldWhileWaiting: [],
      ready: true,
      moved: { state: 'live', url: 'https://flourandhearth.com', pending: undefined },
      // A new version for the new origin; the move's handover gives the deployment the new grant and keeps none.
      made: { domains: ['flourandhearth.com'], uploads: 2 }, held: [],
    });
  });

  // The owner's free account, 2026-10-21: a run made storage before Cloudflare refused its Dynamic Workers (10195).
  it('tells a Workers Free account it needs Paid, and a run started there stops at its first step, making nothing', async () => {
    await env.DEPLOY_FAKE.reset();
    await env.DEPLOY_FAKE.free(true);

    const cookie = await signedInPage();
    const checklist = v.parse(DeployPreflightSchema, JSON.parse((await page(cookie, 'GET', `/api/deploy/preflight?account=${DEPLOY_FAKE_ACCOUNT}`)).body));

    await page(cookie, 'POST', '/api/deploy/runs', newKinu);
    await pageRun().settledAfter(['failed']);
    const stopped = await current(cookie);
    const made = await env.DEPLOY_FAKE.state();

    expect({ plan: checklist.plan, first: checklist.needs[0]?.id, need: stopped.paused?.id, code: stopped.paused?.details?.code, made: made.creates })
      .toEqual({ plan: 'free', first: 'plan', need: 'plan', code: 1000, made: [] });
  });
});
