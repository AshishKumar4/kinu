/**
 * Egress configuration contents only. Applying it belongs to `KinuDevbox.configureEgress`, the one writer that binds
 * the handlers in the safe order; timing belongs to `sandbox-exec-lane.ts`, before any op that can start the container.
 * Until it lands the container has no network (`enableInternet = false`, no handler): fails closed. A workspace's own
 * egress is minted with the same contents as it opens (`OrchestratorAgent.workspaceEgress`). Neither reads the vault:
 * the egress asks it only for a request that names a placeholder.
 */

import { egressGrants, type ApprovalGrant } from '@kinu.run/core';
import type { KinuEgressParams } from './outbound';

export interface EgressConfigurationInput {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  readonly grants: readonly ApprovalGrant[];
}

export function kinuEgressParams(input: EgressConfigurationInput): KinuEgressParams {
  return {
    workspaceName: input.workspaceName,
    ownerUserId: input.ownerUserId,
    // Only the grants that spend a vault secret: the rest of the workspace's consent is no business of its egress.
    grants: egressGrants(input.grants),
  };
}
