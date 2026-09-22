/**
 * `/api/updates` (docs/SELF-DEPLOY.md § Updates). Owner only: the address in the deployment's own record;
 * everyone else gets 404, since an update button's existence is a fact about the owner. `dev`/CLI identities are refused.
 */
import {
  DeploymentRecordSchema, ReleaseManifestSchema, SELF_UPDATE_RUN_ID, buildOf, updateOffer,
  type DeploymentRecord, type UpdateBuild, type UpdateOffer,
} from '@kinu.run/core/deploy';
import { err, json, readBuildStamp } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { AuthIdentity } from '../auth/session';
import type { DeployRunDO } from '../deploy/deploy-do';

const API = '/api/updates';

const RUN_PATH = `${API}/run`;

const APPLY_PATH = `${API}/apply`;

export async function handleUpdatesRequest(
  request: Request,
  env: Env,
  identity: AuthIdentity,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;

  if (path !== API && path !== RUN_PATH && path !== APPLY_PATH) return null;

  const record = deploymentRecord(env);

  if (!ownedBy(record, identity)) return err(404, 'Not found');

  if (path === API && request.method === 'GET') return json({ body: await offer(request, env, record) });

  if (path === RUN_PATH && request.method === 'GET') return json({ body: await runStub(env).snapshot() });

  if (path === APPLY_PATH && request.method === 'POST') {
    const held = await offer(request, env, record);

    if (record === null || !held.installable) {
      return err(409, held.reason === '' ? 'There is nothing to install.' : held.reason);
    }

    return json({ body: await runStub(env).selfUpdate(record, env.KINU_SELF_DEPLOY_REFRESH_TOKEN ?? '') });
  }

  return null;
}

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
