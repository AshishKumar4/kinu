/**
 * Egress configuration contents only. Applying it belongs to `KinuDevbox.configureEgress`, the one writer that binds
 * the handlers in the safe order; timing belongs to `sandbox-exec-lane.ts`, before any op that can start the container.
 * Until it lands the container has no network (`enableInternet = false`, no handler): fails closed.
 * Not `onStart`: `gate:do-init` forbids awaiting there, and this needs a UserDO round trip.
 */

import {
  grantedEgressBindings,
  ownerCaller,
  type ApprovalGrant,
  type EgressSecretBinding,
  type OwnerCapabilityEnv,
  type UserCaller,
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

interface EgressVaultClient {
  listEgressSecrets(caller: UserCaller): Promise<readonly EgressSecretBinding[]>;
}

/** The owner's egress secrets, as bindings carrying no secret material; an unreadable vault rejects. */
export async function ownerEgressVault(
  env: OwnerCapabilityEnv & Pick<Env, 'UserDO'>, ownerUserId: string,
): Promise<readonly EgressSecretBinding[]> {
  // Used, never copied (see `userDOStubFor`).
  const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(ownerUserId));

  return await vault.listEgressSecrets(await ownerCaller(env));
}
