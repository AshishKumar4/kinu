/**
 * A deployment reading its own release channel and installing from it, in
 * workerd, over real Durable Object SQLite.
 *
 * WHAT IS PLATFORM HERE, and therefore why this is not a bun test: an update is
 * the SAME `deployPlan`, run from inside the deployment under the fixed
 * self-update run id. So the object `/api/updates/apply` drives is the object
 * `/api/updates/run` reads back, its ledger is `ctx.storage.sql`, and the
 * secrets the new version is re-bound with are the ones this Worker's own
 * bindings carry. The offer arithmetic is a pure function and is proved under
 * `bun test` (`packages/core/tests/unit-deploy-flow.test.ts`); these four rows
 * are the ones that need the runtime.
 *
 * The plane is the same Node-side fake as `deploy-ledger.test.ts`
 * (`deploy-fake.ts`), plus the two things only a DEPLOYED Kinu has: the build
 * stamp its own asset bundle serves (`env.ASSETS`, so `readBuildStamp` answers
 * what this deployment is running) and a refresh grant at the authorization
 * server. The probe worker is bound the way the flow leaves a deployment —
 * `KINU_DEPLOYMENT_RECORD`, `KINU_SELF_DEPLOY_REFRESH_TOKEN` and the two minted
 * root secrets — and an unmatched host throws in the fake, so nothing here
 * reaches a real network.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeploySnapshotSchema, DeploymentRecordSchema, SELF_UPDATE_RUN_ID, UpdateOfferSchema,
} from '@kinu.run/core/deploy';
import * as v from 'valibot';
import {
  DEPLOY_FAKE_CHANNEL_BUILD, DEPLOY_FAKE_OLDER_BUILD, DEPLOY_FAKE_OWNER,
  DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

/** The record's own owner, signed in at a browser: the one session this
 *  surface answers at all. */
const OWNER = {
  userId: 'probe-owner',
  email: DEPLOY_FAKE_OWNER,
  sub: 'probe-owner-sub',
  provider: 'google',
};

const STRANGER = { ...OWNER, userId: 'probe-other', email: 'someone@example.com' };

/** The owner, but through a long-lived scoped CLI token rather than a person
 *  at a browser deciding to re-upload their Worker. */
const OWNERS_CLI_TOKEN = { ...OWNER, cliScopes: ['workspace:read'] };

beforeEach(async () => {
  await env.DEPLOY_FAKE.reset();
});

describe('a deployment updating itself', () => {
  it('offers the channel\'s build to a deployment that is behind it', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);

    const answer = await env.UPDATES_PROBE.hit('GET', '/api/updates', OWNER);
    const offer = v.parse(UpdateOfferSchema, JSON.parse(answer.body));

    expect(answer.status).toBe(200);
    expect(offer.current?.version).toBe(DEPLOY_FAKE_OLDER_BUILD.version);
    expect(offer.available).toEqual(DEPLOY_FAKE_CHANNEL_BUILD);
    expect(offer.upToDate).toBe(false);
    expect(offer.installable).toBe(true);
    expect(offer.reason).toBe('');
  });

  it('installs it by running the whole plan from inside the deployment', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);

    const applied = await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);
    const snapshot = v.parse(DeploySnapshotSchema, JSON.parse(applied.body));
    const made = await env.DEPLOY_FAKE.state();
    const written = v.parse(DeploymentRecordSchema, JSON.parse(made.secrets.KINU_DEPLOYMENT_RECORD ?? '{}'));

    expect(applied.status).toBe(200);
    expect(snapshot.runId).toBe(SELF_UPDATE_RUN_ID);
    expect(snapshot.state).toBe('done');
    expect(snapshot.version).toBe(DEPLOY_FAKE_VERSION);
    expect(snapshot.steps.every((row) => row.state === 'done')).toBe(true);
    expect(made.uploads).toBe(1);
    // The deployment spent its OWN refresh token and re-bound the rotated one:
    // a deployment that wrote back the token it already held could update once
    // and never again.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
    expect(written.version).toBe(DEPLOY_FAKE_VERSION);

    // The rows that run wrote are what the page's poll reads back, from the
    // object the fixed run id names.
    const watched = await env.UPDATES_PROBE.hit('GET', '/api/updates/run', OWNER);
    const polled = v.parse(DeploySnapshotSchema, JSON.parse(watched.body));

    expect(polled.steps.map((row) => row.id)).toEqual(snapshot.steps.map((row) => row.id));
    expect(polled.state).toBe('done');
  });

  it('says it is up to date, and refuses to install, when it serves the channel\'s build', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_CHANNEL_BUILD);

    const answer = await env.UPDATES_PROBE.hit('GET', '/api/updates', OWNER);
    const offer = v.parse(UpdateOfferSchema, JSON.parse(answer.body));
    const refused = await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect(offer.upToDate).toBe(true);
    expect(offer.installable).toBe(false);
    expect(offer.reason).toBe('This is the build the channel publishes.');
    expect(refused.status).toBe(409);
    expect(refused.body).toContain('This is the build the channel publishes.');
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
  });

  it('answers nothing at all to a session that is not the owner at a browser', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);

    const stranger = await env.UPDATES_PROBE.hit('GET', '/api/updates', STRANGER);
    const token = await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNERS_CLI_TOKEN);

    // 404, not 403: whether this deployment has an update surface at all is
    // itself a fact about its owner.
    expect(stranger.status).toBe(404);
    expect(token.status).toBe(404);
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
  });
});
