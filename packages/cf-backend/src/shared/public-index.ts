/**
 * How the Shared page's "Public" list learns a share exists: the owner's
 * `/api/shared/live` write indexes it on the control plane, and a revoke
 * forgets it. Both are AWAITED inside the owner's own request (a share that
 * returns before it is listed is a share the owner cannot find on the page)
 * and neither is fatal: the share row in the workspace object is the truth,
 * the index is a copy every reader verifies against that object.
 *
 * Worker code, never Durable Object code: it mints the internal caller and
 * addresses the singleton, both of which belong to the Worker's plane.
 */
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { PublicShareKey, PublicShareRow } from '@kinu.run/core/control-plane';
import { internalCaller } from '../control-plane/admin-caller';
import { controlPlaneStub, hasControlPlane } from '../control-plane/stub';

async function reported(doing: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (cause) {
    diagnostics.failure('shared.public_index_failed', toKinuError({ doing, cause, otherwise: 'unavailable' }));
  }
}

export async function indexPublicShare(env: Env, row: PublicShareRow): Promise<void> {
  if (!hasControlPlane(env)) return;
  await reported('indexing a public share', async () => {
    await controlPlaneStub(env).publicShares_put(await internalCaller(env), row);
  });
}

export async function forgetPublicShare(env: Env, key: PublicShareKey): Promise<void> {
  if (!hasControlPlane(env)) return;
  await reported('forgetting a public share', async () => {
    await controlPlaneStub(env).publicShares_forget(await internalCaller(env), key);
  });
}

/** The index as it stands; empty where this deployment has no control plane. */
export async function listPublicShares(env: Env): Promise<PublicShareRow[]> {
  if (!hasControlPlane(env)) return [];

  return controlPlaneStub(env).publicShares_list(await internalCaller(env));
}
