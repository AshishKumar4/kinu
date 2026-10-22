/**
 * When a Worker's deploys landed, from the deployments API: what tells a code update's reset (platform-catalog.ts
 * do.reset.transient, "Durable Object reset because its code was updated.") that a deploy caused from the same words
 * thrown with no deploy at all (do.storage.write_await_reset), which is the version's own failure.
 */
import * as v from 'valibot';
import { restAnswer } from './cloudflare-rest';
import { restApiToken } from './cloudflare-token';
import { requireCloudflareAccountId } from './infra-cloudflare';

/** The deployments API's answer, as far as a window reads it: when each deploy landed and the versions it served. */
const DeploymentsAnswer = v.looseObject({
  result: v.looseObject({
    deployments: v.array(v.looseObject({ created_on: v.string(), versions: v.array(v.looseObject({ version_id: v.string() })) })),
  }),
});

/** The newest deployments the API lists in one answer (measured 2026-10-22: 10). */
const DEPLOYMENTS_LISTED = 10;

/** A deploy of a worker: when it landed, and the versions it served. */
export interface Deployment {
  readonly at: number;
  readonly versions: readonly string[];
}

/** `worker`'s newest deployments, read with the deploy's REST token: the Observability token cannot read them.
 *  `api`: Cloudflare's own origin unless a test serves one. */
export async function listDeployments(worker: string, api?: string): Promise<readonly Deployment[]> {
  const text = await restAnswer({
    method: 'GET',
    ...api !== undefined && { api },
    path: `/accounts/${requireCloudflareAccountId()}/workers/scripts/${worker}/deployments`,
    token: restApiToken(),
  });

  return v.parse(DeploymentsAnswer, JSON.parse(text)).result.deployments
    .map((deployment) => ({ at: Date.parse(deployment.created_on), versions: deployment.versions.map((served) => served.version_id) }));
}

/**
 * Whether a deploy other than `version`'s own landed inside `window`: only then can a code update have ended the
 * version's calls. Otherwise the runtime's "code was updated" is the version's own failure, and it counts as one. With
 * no version, any deploy inside counts. A list as long as the API lists that does not reach back to the window cannot
 * say, and fails the read.
 */
export function deployLanded(deployments: readonly Deployment[], window: { readonly from: number; readonly to: number }, version = ''): boolean {
  const others = deployments.filter((deployment) => !(deployment.versions.length === 1 && deployment.versions[0] === version));

  if (others.some((deployment) => deployment.at > window.from && deployment.at <= window.to)) return true;

  if (deployments.length >= DEPLOYMENTS_LISTED && deployments.every((deployment) => deployment.at > window.from)) {
    throw new Error(`the ${String(deployments.length)} deployments listed all landed after ${new Date(window.from).toISOString()}, so whether one landed inside the window is unknown`);
  }

  return false;
}
