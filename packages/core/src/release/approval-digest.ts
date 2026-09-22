// Deploy approvals bind a digest of (patch, declared deploy command); deploy recomputes it and
// rejects drift, so an injected patch edit or ad-hoc command cannot ride an old approval.

import { argumentDigest } from '../safety/argument-digest';
import type { ReleaseApproval, ReleaseDeployment } from './types';

/** The deployTarget as a command when it contains whitespace; a bare label is an environment tag. */
export function deployTargetAsCommand(deployTarget: string | null): string | null {
  if (!deployTarget) return null;

  return /\s/.test(deployTarget.trim()) ? deployTarget.trim() : null;
}

/** A blank argument supplies no command; the binding's deploy target answers for it. */
export function suppliedCommand(command: string | undefined): string | null {
  const trimmed = command === undefined ? '' : command.trim();

  return trimmed === '' ? null : trimmed;
}

export function approvalTypeForEnvironment(
  environment: ReleaseDeployment['environment'],
): ReleaseApproval['approvalType'] {
  if (environment === 'production') return 'deploy_production';

  if (environment === 'staging') return 'deploy_staging';

  return 'apply';
}

export interface DeployApprovalBinding {
  approvalType: ReleaseApproval['approvalType'];
  patch: string | null;
  /** Null when the change promotes a preview. */
  command: string | null;
}

/** `v` guards against format drift silently invalidating live approvals. */
export function deployApprovalDigest(binding: DeployApprovalBinding): string {
  return argumentDigest({
    v: 1,
    approvalType: binding.approvalType,
    patch: binding.patch ?? null,
    command: binding.command ?? null,
  });
}
