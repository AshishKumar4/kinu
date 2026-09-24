/**
 * `/api/updates` (docs/SELF-DEPLOY.md § Updates). Owner only: the address in the deployment's own record;
 * everyone else gets 404, since an update button's existence is a fact about the owner. `dev`/CLI identities are refused.
 */
import { Hono } from 'hono';
import {
  DeploymentRecordSchema, ReleaseManifestSchema, SELF_UPDATE_RUN_ID, buildOf, updateOffer,
  type DeploymentRecord, type UpdateBuild, type UpdateOffer,
} from '@kinu.run/core/deploy';
import { err, json, readBuildStamp } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { DeployRunDO } from '../deploy/deploy-do';
import type { ApiVariables, FamilyEnv } from '../api/context';

const API = '/api/updates';

const RUN_PATH = `${API}/run`;

const APPLY_PATH = `${API}/apply`;

interface UpdatesVariables extends ApiVariables {
  record: DeploymentRecord | null;
}

export const updatesRoutes = new Hono<FamilyEnv<Env, UpdatesVariables>>();

updatesRoutes.on('ALL', [API, RUN_PATH, APPLY_PATH], async (c, next) => {
  const record = deploymentRecord(c.env);

  if (!ownedBy(record, c.get('identity'))) return err(404, 'Not found');
  c.set('record', record);
  await next();
});

updatesRoutes.get(API, async (c) => json({ body: await offer(c.req.raw, c.env, c.get('record')) }));

updatesRoutes.get(RUN_PATH, async (c) => json({ body: await runStub(c.env).snapshot() }));

updatesRoutes.post(APPLY_PATH, async (c) => {
  const record = c.get('record');
  const held = await offer(c.req.raw, c.env, record);

  if (record === null || !held.installable) {
    return err(409, held.reason === '' ? 'There is nothing to install.' : held.reason);
  }

  return json({ body: await runStub(c.env).selfUpdate(record, c.env.KINU_SELF_DEPLOY_REFRESH_TOKEN ?? '') });
});

/** A record that will not parse reads as no record. */
function deploymentRecord(env: Env): DeploymentRecord | null {
  const held = env.KINU_DEPLOYMENT_RECORD ?? '';

  if (held === '') return null;

  const parsed = v.safeParse(DeploymentRecordSchema, tolerate(() => JSON.parse(held), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

function ownedBy(record: DeploymentRecord | null, identity: AuthIdentity): boolean {
  if (record === null) return false;

  // Check both the CLI provider and scopes: an unscoped `cli` ticket must be refused here, not by routing.
  if (identity.provider === 'dev' || identity.provider === 'cli') return false;

  if (identity.cliScopes !== undefined) return false;
  const owner = record.inputs.ownerEmail.trim().toLowerCase();

  return owner !== '' && identity.email.trim().toLowerCase() === owner;
}

function runStub(env: Env): DurableObjectStub<DeployRunDO> {
  return env.DeployRunDO.get(env.DeployRunDO.idFromName(SELF_UPDATE_RUN_ID));
}

/** This deployment's stamp (read as `/api/health` does) beside the one its channel publishes. */
async function offer(request: Request, env: Env, record: DeploymentRecord | null): Promise<UpdateOffer> {
  const channelOrigin = record?.channelOrigin ?? '';
  const stamp = await readBuildStamp(env, request.url);

  return updateOffer({
    current: stamp === null ? null : { version: stamp.version, sha: stamp.sha, builtAt: stamp.builtAt },
    available: channelOrigin === '' ? null : await published(channelOrigin),
    channelOrigin,
    owned: record !== null && (env.KINU_SELF_DEPLOY_REFRESH_TOKEN ?? '') !== '',
  });
}

/** `stable` is the only channel; `edge` is not built. */
async function published(channelOrigin: string): Promise<UpdateBuild | null> {
  const response = await fetch(new URL('/downloads/release.json', channelOrigin));

  if (!response.ok) return null;
  const text = await response.text();
  const parsed = v.safeParse(ReleaseManifestSchema, tolerate(() => JSON.parse(text), 'malformed-input'));

  return parsed.success ? buildOf(parsed.output) : null;
}
