import * as v from 'valibot';
import { USER_AI_PROXY_PATH } from '@kinu.run/core';
import { DeploymentAnswer, EVAL_DEPLOYMENT_ORIGIN, evalTargetVerdict, evalWorkspaceName, infraBoundary } from '@kinu.run/test-utils';
import {
  openPublicSession, resolveWebIdentity, type KinuPublicSession, type PublicWebIdentity,
} from './session';

type Env = Record<string, string | undefined>;

/** Where trials run and as whom: the eval-service identity on the deployment, never a person's session. */
export type EvalTarget = { readonly origin: string; readonly identity: PublicWebIdentity };

/**
 * A named workspace setting applied when a trial's workspace opens. `product` changes nothing; an
 * arm that compares a setting against the product is declared here, and its cohorts never mix
 * with another arm's.
 */
export type EvalArm = { readonly id: string; apply(session: KinuPublicSession): Promise<void> };

export const ARMS = [
  { id: 'product', apply: () => Promise.resolve() },
] as const satisfies readonly EvalArm[];

/** The deployment and the browser-plane identity, refused before any trial when either is missing. */
export function resolveEvalTarget(env: Env): EvalTarget {
  const named = env.KINU_EVAL_ORIGIN?.trim() ?? '';
  const verdict = evalTargetVerdict(named === '' ? EVAL_DEPLOYMENT_ORIGIN : named);

  if (verdict.kind === 'refused') throw new Error(verdict.reason);
  const web = resolveWebIdentity(verdict.origin, env);

  if (web.kind === 'absent') throw new Error(web.remedy);

  return { origin: verdict.origin, identity: web.identity };
}

const HealthSchema = v.object({ build: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)) }) });

/** The build the deployment serves now: the product a trial measures. */
export function deployedBuild(target: EvalTarget): Promise<string> {
  return infraBoundary(`GET ${target.origin}/api/health`, async () => {
    const response = await fetch(`${target.origin}/api/health`);

    if (!response.ok) throw new DeploymentAnswer(`/api/health answered ${String(response.status)}`, response.status);

    return v.parse(HealthSchema, await response.json()).build.sha;
  });
}

/**
 * A fresh eval-prefixed workspace on `model`, its mission written before the first prompt so no
 * genesis turn runs. The caller tears it down.
 */
export function openWorkspace(target: EvalTarget, request: { subject: string; mission: string; model: string }): Promise<KinuPublicSession> {
  return openPublicSession({
    origin: target.origin,
    identity: target.identity,
    workspace: evalWorkspaceName(request.subject),
    purpose: request.mission,
    genesis: false,
    llm: { name: 'eval', baseURL: `${target.origin}${USER_AI_PROXY_PATH}`, headers: {}, model: request.model },
  });
}
