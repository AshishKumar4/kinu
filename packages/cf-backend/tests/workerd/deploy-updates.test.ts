/**
 * Self-update in workerd over real DO SQLite: the same `deployPlan` under the fixed self-update run id,
 * its ledger in `ctx.storage.sql`. Offer arithmetic is proved in `packages/core/tests/unit-deploy-flow.test.ts`.
 * The plane is `deploy-fake.ts`; an unmatched host throws, so nothing reaches a real network.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeploySnapshotSchema, DeploymentRecordSchema, SELF_UPDATE_RUN_ID, UpdateOfferSchema,
  type DeploySnapshot,
} from '@kinu.run/core/deploy';
import * as v from 'valibot';
import {
  DEPLOY_FAKE_CHANNEL_BUILD, DEPLOY_FAKE_OLDER_BUILD, DEPLOY_FAKE_OWNER,
  DEPLOY_FAKE_ROTATED_REFRESH, DEPLOY_FAKE_VERSION,
} from './deploy-fake';

/** The record's own owner at a browser: the only session this surface answers. */
const OWNER = {
  userId: 'probe-owner',
  email: DEPLOY_FAKE_OWNER,
  sub: 'probe-owner-sub',
  provider: 'google',
};

const NEXT_BUILD = {
  version: '0.4.1+probe02',
  sha: 'probe02',
  builtAt: '2026-09-19T00:00:00.000Z',
};

/** The run is over when the self-update object holds no secret material. */
async function hasVaultSecrets(): Promise<boolean> {
  const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(SELF_UPDATE_RUN_ID));

  return (await stub.heldSecretNames()).length > 0;
}

const STRANGER = { ...OWNER, userId: 'probe-other', email: 'someone@example.com' };

/** The owner via a long-lived scoped CLI token rather than a browser session. */
const OWNERS_CLI_TOKEN = { ...OWNER, cliScopes: ['workspace:read'] };

/** A CLI ticket carries `scopes` only when the credential had any, so this reaches the gate
 *  looking like a browser session. */
const UNSCOPED_CLI_TOKEN = { ...OWNER, provider: 'cli' };

beforeEach(async () => {
  await env.DEPLOY_FAKE.reset();
  // One ledger under a fixed id shared by every row here; a row inheriting a finished ledger passes by skipping.
  await env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(SELF_UPDATE_RUN_ID)).forget();
});

/** `apply` answers before the first step and parks on the alarm delivery (`settledAfter`), so the
 *  `/api/updates/run` read is taken once over a settled ledger. */
async function settled(): Promise<DeploySnapshot> {
  await env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(SELF_UPDATE_RUN_ID))
    .settledAfter(['done', 'failed']);

  return v.parse(
    DeploySnapshotSchema,
    JSON.parse((await env.UPDATES_PROBE.hit('GET', '/api/updates/run', OWNER)).body),
  );
}

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
    const accepted = v.parse(DeploySnapshotSchema, JSON.parse(applied.body));

    // The plan runs on the object's own alarm, so it outlives the request and its own upload's restart.
    expect(accepted.state).toBe('running');

    const snapshot = await settled();
    const made = await env.DEPLOY_FAKE.state();
    const written = v.parse(DeploymentRecordSchema, JSON.parse(made.secrets.KINU_DEPLOYMENT_RECORD ?? '{}'));

    expect(applied.status).toBe(200);
    expect(snapshot.runId).toBe(SELF_UPDATE_RUN_ID);
    expect(snapshot.state).toBe('done');
    expect(snapshot.version).toBe(DEPLOY_FAKE_VERSION);
    expect(snapshot.steps.every((row) => row.state === 'done')).toBe(true);
    expect(made.uploads).toBe(1);
    // A deployment that wrote back the token it already held could update once and never again.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
    expect(written.version).toBe(DEPLOY_FAKE_VERSION);

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

    // 404, not 403: whether an update surface exists is itself a fact about the owner.
    expect(stranger.status).toBe(404);
    expect(token.status).toBe(404);
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
  });

  it('answers nothing to a CLI ticket that carries no scopes', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);

    const offered = await env.UPDATES_PROBE.hit('GET', '/api/updates', UNSCOPED_CLI_TOKEN);
    const applied = await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', UNSCOPED_CLI_TOKEN);

    expect(offered.status).toBe(404);
    expect(applied.status).toBe(404);
    expect((await env.DEPLOY_FAKE.state()).uploads).toBe(0);
  });
});

/**
 * `runDeployPlan` skips `done` rows, so without the ledger reset the next release over the same
 * object uploads nothing while the refresh grant is still spent.
 */
describe('a deployment updating itself twice', () => {
  it('uploads and repoints once per release', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect((await settled()).state).toBe('done');

    const first = await env.DEPLOY_FAKE.state();

    expect(first.uploads).toBe(1);
    expect(first.deployments).toEqual(['version-1']);

    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_CHANNEL_BUILD);
    await env.DEPLOY_FAKE.publish(NEXT_BUILD);

    const offered = v.parse(
      UpdateOfferSchema,
      JSON.parse((await env.UPDATES_PROBE.hit('GET', '/api/updates', OWNER)).body),
    );

    expect(offered.available?.version).toBe(NEXT_BUILD.version);
    expect(offered.installable).toBe(true);

    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    const second = await settled();
    const made = await env.DEPLOY_FAKE.state();

    expect(second.state).toBe('done');
    expect(second.version).toBe(NEXT_BUILD.version);
    expect(made.uploads).toBe(2);
    expect(made.deployments).toEqual(['version-1', 'version-2']);
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
    expect(await hasVaultSecrets()).toBe(false);
  });

  it('writes the rotated refresh token before the plan, so a failed update can still be retried', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);
    // Smoke check refuses once: uploaded, pointer moved, grant already spent.
    await env.DEPLOY_FAKE.refuseOnce({ path: '/api/health', status: 502, code: 0, message: 'bad gateway' });
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect((await settled()).state).toBe('failed');

    // The working token is written to the Worker before the first step, not by the last one.
    expect((await env.DEPLOY_FAKE.state()).secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN)
      .toBe(DEPLOY_FAKE_ROTATED_REFRESH);

    // The fake's authorization server refuses any token but the one the run holds.
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    const finished = await settled();
    const made = await env.DEPLOY_FAKE.state();

    expect(finished.state).toBe('done');
    expect(made.uploads).toBe(1);
    expect(made.deployments).toEqual(['version-1']);
    expect(await hasVaultSecrets()).toBe(false);
  });
});
