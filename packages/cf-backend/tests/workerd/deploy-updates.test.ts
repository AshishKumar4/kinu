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
  type DeploySnapshot,
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

/** The release after the channel's current one: a second build for a row that
 *  installs twice. */
const NEXT_BUILD = {
  version: '0.4.1+probe02',
  sha: 'probe02',
  builtAt: '2026-09-19T00:00:00.000Z',
};

/** Whether the self-update object is still holding secret material. The run is
 *  over when it holds none. */
async function hasVaultSecrets(): Promise<boolean> {
  const stub = env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(SELF_UPDATE_RUN_ID));

  return (await stub.heldSecretNames()).length > 0;
}

const STRANGER = { ...OWNER, userId: 'probe-other', email: 'someone@example.com' };

/** The owner, but through a long-lived scoped CLI token rather than a person
 *  at a browser deciding to re-upload their Worker. */
const OWNERS_CLI_TOKEN = { ...OWNER, cliScopes: ['workspace:read'] };

beforeEach(async () => {
  await env.DEPLOY_FAKE.reset();
  // The update ledger is one object under a fixed id, shared by every row in
  // this file. A row that started from the previous row's finished ledger would
  // pass by skipping every step.
  await env.DEPLOY_RUN_PROBE.get(env.DEPLOY_RUN_PROBE.idFromName(SELF_UPDATE_RUN_ID)).forget();
});

const DEADLINE_MS = 20_000;

const POLL_MS = 25;

/** The update, read back the way the page reads it, until it settles. */
async function settled(): Promise<DeploySnapshot> {
  const deadline = Date.now() + DEADLINE_MS;

  const read = async (): Promise<DeploySnapshot> => v.parse(
    DeploySnapshotSchema,
    JSON.parse((await env.UPDATES_PROBE.hit('GET', '/api/updates/run', OWNER)).body),
  );

  let held = await read();

  while (held.state !== 'done' && held.state !== 'failed' && Date.now() < deadline) {
    await scheduler.wait(POLL_MS);
    held = await read();
  }

  return held;
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

    // The POST answers before the first step: the plan runs on the object's
    // own alarm, which is what lets it outlive the request and the restart its
    // own upload causes. The page polls exactly this way.
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

/**
 * The second update, which is where a fixed run id bites.
 *
 * `runDeployPlan` skips rows that are `done` — right for a resume, wrong for
 * the next release over the same object. Without the ledger reset the second
 * apply uploads nothing, moves no pointer, and reports done while the Worker
 * still serves the old build; the refresh grant is spent either way, so the
 * deployment ends up unable to update again at all.
 */
describe('a deployment updating itself twice', () => {
  it('uploads and repoints once per release', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect((await settled()).state).toBe('done');

    const first = await env.DEPLOY_FAKE.state();

    expect(first.uploads).toBe(1);
    expect(first.deployments).toEqual(['version-1']);

    // The channel publishes the next release, and this deployment now serves
    // the one it just installed.
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
    // And the deployment holds the token the SECOND refresh handed it.
    expect(made.secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN).toBe(DEPLOY_FAKE_ROTATED_REFRESH);
    expect(await hasVaultSecrets()).toBe(false);
  });

  it('writes the rotated refresh token before the plan, so a failed update can still be retried', async () => {
    await env.DEPLOY_FAKE.serve(DEPLOY_FAKE_OLDER_BUILD);
    // The smoke check refuses once: the upload happened, the pointer moved, and
    // the run failed after the grant was already spent.
    await env.DEPLOY_FAKE.refuseOnce({ path: '/api/health', status: 502, code: 0, message: 'bad gateway' });
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    expect((await settled()).state).toBe('failed');

    // THE POINT: the token that still works is already on the Worker, written
    // before the first step rather than by the last one. A deployment holding
    // the spent token here could never update again.
    expect((await env.DEPLOY_FAKE.state()).secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN)
      .toBe(DEPLOY_FAKE_ROTATED_REFRESH);

    // Applying again refreshes with the token the run holds — the fake's
    // authorization server refuses any other — and finishes the same ledger.
    await env.UPDATES_PROBE.hit('POST', '/api/updates/apply', OWNER);

    const finished = await settled();
    const made = await env.DEPLOY_FAKE.state();

    expect(finished.state).toBe('done');
    expect(made.uploads).toBe(1);
    expect(made.deployments).toEqual(['version-1']);
    expect(await hasVaultSecrets()).toBe(false);
  });
});
