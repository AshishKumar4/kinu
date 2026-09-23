/**
 * Owner's `/api/shared/live` write indexes a share on the control plane; revoke forgets it.
 * Both are awaited in the owner's request, never fatal: the workspace share row is the truth.
 * Worker code only: it mints the internal caller and addresses the singleton.
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
