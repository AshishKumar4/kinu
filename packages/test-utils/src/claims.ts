// A turn claimed and bound in one call, as a test that reads claims, not the execution that opens them, needs.
import type { ActorClaimStore, ActorTurnClaim } from '@kinu.run/core';

/** Reserves the turn's claim, minting its epoch, then binds it, as an execution's open and its admission do. */
export async function admitTestClaim(claims: ActorClaimStore, input: Omit<Parameters<ActorClaimStore['admit']>[0], 'epoch'>): Promise<ActorTurnClaim> {
  const { epoch } = claims.reserve(input);

  return await claims.admit({ ...input, epoch });
}
