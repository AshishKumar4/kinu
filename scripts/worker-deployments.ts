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
 * How long after a deploy lands its code update can still reset the calls of the version it replaced: the longest
 * measured. A reset later than this after the newest deploy is not that deploy's.
 */
export const ROLLOVER_SPAN_MS = 300_000;

/**
 * Who caused a code-update reset at `at`: `deploy` when a deploy other than `version`'s own landed at or before it, within
 * {@link ROLLOVER_SPAN_MS}; otherwise `own`, the version's own failure, whatever deploy came after it. `unknown` when a
 * list as long as the API lists does not reach back past the span, which cannot say.
 */
export function resetCause(deployments: readonly Deployment[], at: number, version = ''): 'deploy' | 'own' | 'unknown' {
  const others = deployments.filter((deployment) => !(deployment.versions.length === 1 && deployment.versions[0] === version));

  if (others.some((deployment) => deployment.at <= at && at - deployment.at <= ROLLOVER_SPAN_MS)) return 'deploy';

  return deployments.length >= DEPLOYMENTS_LISTED && deployments.every((deployment) => deployment.at > at - ROLLOVER_SPAN_MS) ? 'unknown' : 'own';
}
