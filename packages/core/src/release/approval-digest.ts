/**
 * Digest binding for release deploy approvals (agent-core SPEC §7.3).
 *
 * A deploy approval is a human's yes to deploying THIS patch via THIS command
 * to THIS environment. Between `request_approval` and the engine's `deploy`,
 * the agent could (prompt-injected) mutate the stored patch or pass an ad-hoc
 * deploy `command` the owner never reviewed — `hasApproved(type)` alone would
 * still pass. So the approval commits to a digest of the reviewable deploy
 * identity at request time, and `deploy` recomputes it over what is about to
 * run, rejecting any drift (fail-closed).
 *
 * The command bound is the binding's DECLARED deploy target (reviewable on the
 * Releases surface), never an argument supplied at deploy time — that is
 * exactly the value an injection would try to swap.
 */

import { argumentDigest } from '../safety/argument-digest';
import type { ReleaseApproval, ReleaseDeployment } from './types';

/** A binding's deployTarget doubles as the deploy command when it reads like
 *  one (has whitespace, e.g. "bunx wrangler deploy"); a bare label like
 *  "production" is an environment tag, not a command. This is the DECLARED,
 *  reviewable command an approval binds — never an argument passed at deploy. */
export function deployTargetAsCommand(deployTarget: string | null): string | null {
  if (!deployTarget) return null;
  return /\s/.test(deployTarget.trim()) ? deployTarget.trim() : null;
}

/** The approval type a deploy to `environment` requires. */
export function approvalTypeForEnvironment(
  environment: ReleaseDeployment['environment'],
): ReleaseApproval['approvalType'] {
  if (environment === 'production') return 'deploy_production';
  if (environment === 'staging') return 'deploy_staging';
  return 'apply';
}

export interface DeployApprovalBinding {
  approvalType: ReleaseApproval['approvalType'];
  /** The change's stored unified diff at binding time (the reviewed artifact). */
  patch: string | null;
  /** The resolved deploy command, or null when the change promotes a preview. */
  command: string | null;
}

/** SHA-256 over the deploy identity the approval authorizes. `v` guards the
 *  shape against silent format drift invalidating live approvals. */
export function deployApprovalDigest(binding: DeployApprovalBinding): string {
  return argumentDigest({
    v: 1,
    approvalType: binding.approvalType,
    patch: binding.patch ?? null,
    command: binding.command ?? null,
  });
}
