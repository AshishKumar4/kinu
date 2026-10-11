/**
 * Egress configuration contents only. Applying it belongs to `KinuDevbox.configureEgress`, the one writer that binds
 * the handlers in the safe order; timing belongs to `sandbox-exec-lane.ts`, before any op that can start the container.
 * Until it lands the container has no network (`enableInternet = false`, no handler): fails closed.
 * Not `onStart`: `gate:do-init` forbids awaiting there, and this needs a UserDO round trip.
 */

import {
  grantedEgressBindings,
  OwnerCapabilityUnavailableError,
  ownerCaller,
  type ApprovalGrant,
  type EgressSecretBinding,
  type ObjectNamespace,
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

/**
 * The owner's egress secrets, as bindings carrying no secret material; an unreadable vault rejects. A deployment that
 * holds no root secret has no vault to open, so it answers none: its egress still judges destinations and refuses every
 * placeholder.
 */
export async function ownerEgressVault<Id>(
  env: OwnerCapabilityEnv & { readonly UserDO: ObjectNamespace<Id, EgressVaultClient> }, ownerUserId: string,
): Promise<readonly EgressSecretBinding[]> {
  let caller: UserCaller;

  try {
    caller = await ownerCaller(env);
  } catch (cause) {
    if (cause instanceof OwnerCapabilityUnavailableError) return [];
    throw cause;
  }

  // Used, never copied (see `userDOStubFor`).
  const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(ownerUserId));

  return await vault.listEgressSecrets(caller);
}
