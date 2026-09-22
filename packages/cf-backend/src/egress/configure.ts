/**
 * Egress configuration contents only. Applying it belongs to `KinuSandbox.configureEgress`, the one writer that binds
 * the handlers in the safe order; timing belongs to `sandbox-exec-lane.ts`, before any op that can start the container.
 * Until it lands the container has no network (`enableInternet = false`, no handler): fails closed.
 * Not `onStart`: `gate:do-init` forbids awaiting there, and this needs a UserDO round trip.
 */

import {
  grantedEgressBindings,
  type ApprovalGrant,
  type EgressSecretBinding,
} from '@kinu.run/core';
import type { KinuEgressParams } from './outbound';

export interface EgressConfigurationInput {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  readonly vault: readonly EgressSecretBinding[];
  readonly grants: readonly ApprovalGrant[];
}

export function kinuEgressParams(input: EgressConfigurationInput): KinuEgressParams {
  return {
    workspaceName: input.workspaceName,
    ownerUserId: input.ownerUserId,
    // Ungranted bindings never reach the handler, so the container never learns their placeholders: consent gates visibility.
    bindings: grantedEgressBindings(input.vault, input.grants),
  };
}
