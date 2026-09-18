/**
 * `/api/updates` — a deployment reading its own channel, and installing from it
 * (docs/SELF-DEPLOY.md § Updates).
 *
 * THE OWNER, AND ONLY THE OWNER. An update re-uploads this Worker, so the one
 * person who may press it is the address the deployment was created for — and
 * that address is in the deployment's own record, which nothing here can edit.
 * The allowlist gate beside this (`control-plane/admin-caller.ts`) answers a
 * different question against a var; this one asks the record, so a deployment
 * with no record has no update surface at all rather than one gated by
 * something else. Everyone else gets 404: the existence of an update button is
 * itself a fact about the owner.
 *
 * `dev` and CLI-token identities are refused for the same reason that gate
 * refuses them: a synthesized identity is granted by an env var, and a scoped
 * CLI token is a long-lived non-interactive credential. Neither is a person
 * deciding to re-upload their Worker.
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

  if (path === API && request.method === 'GET') return json(await offer(request, env, record));

  if (path === RUN_PATH && request.method === 'GET') return json(await runStub(env).snapshot());

  if (path === APPLY_PATH && request.method === 'POST') {
    const held = await offer(request, env, record);

    if (record === null || !held.installable) {
      return err(409, held.reason === '' ? 'There is nothing to install.' : held.reason);
    }

    return json(await runStub(env).selfUpdate(record, env.KINU_SELF_DEPLOY_REFRESH_TOKEN ?? ''));
  }

  return null;
}

/**
 * What this deployment knows about itself, or null.
 *
 * Null is the ordinary state of kinu.run itself, which nobody self-deployed. A
 * record that will not parse reads as no record, because a half-read record is
 * not something to run a plan from.
 */
function deploymentRecord(env: Env): DeploymentRecord | null {
  const held = env.KINU_DEPLOYMENT_RECORD ?? '';

  if (held === '') return null;

  const parsed = v.safeParse(DeploymentRecordSchema, tolerate(() => JSON.parse(held), 'malformed-input'));

  return parsed.success ? parsed.output : null;
}

/** Whether this session is the address the deployment was created for. */
function ownedBy(record: DeploymentRecord | null, identity: AuthIdentity): boolean {
  if (record === null) return false;

  // Both spellings of a CLI identity: the provider it carries, and the scopes
  // it carries only when the ticket had any. Keying on the scopes alone left
  // an unscoped `cli` ticket admitted by this check and refused only by which
  // paths tickets reach — a gate held up by routing rather than by itself.
  if (identity.provider === 'dev' || identity.provider === 'cli') return false;

  if (identity.cliScopes !== undefined) return false;
  const owner = record.inputs.ownerEmail.trim().toLowerCase();

  return owner !== '' && identity.email.trim().toLowerCase() === owner;
}

function runStub(env: Env): DurableObjectStub<DeployRunDO> {
  return env.DeployRunDO.get(env.DeployRunDO.idFromName(SELF_UPDATE_RUN_ID));
}

/** The two builds side by side: this deployment's own stamp, read the same way
 *  `/api/health` reads it, and the one its channel publishes. */
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

/** The channel's release, or null when it does not answer with one. `stable` is
 *  the one channel: `edge` is named as later in the doc and is not built. */
async function published(channelOrigin: string): Promise<UpdateBuild | null> {
  const response = await fetch(new URL('/downloads/release.json', channelOrigin));

  if (!response.ok) return null;
  const text = await response.text();
  const parsed = v.safeParse(ReleaseManifestSchema, tolerate(() => JSON.parse(text), 'malformed-input'));

  return parsed.success ? buildOf(parsed.output) : null;
}
