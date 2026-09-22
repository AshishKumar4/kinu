/**
 * One Kinu user's Drive: their Mossaic tenant, as Kinu's file plane.
 *
 * The tenant id IS the Kinu user id, and this is the only place the SDK is
 * constructed, so there is exactly one answer to "whose tenant is this": the
 * caller's argument, which the workspace runtime fills from the owner claim
 * and the Drive routes fill from the signed-in identity. Absent bindings are
 * a null plane, which the mount states as an absence and the routes answer
 * with 503.
 */
import { createVFS, type MossaicEnv } from '@mossaic/sdk';
import { mossaicVfs, type MossaicVfs } from '@kinu.run/core';

/** One Mossaic object as the SDK's binding client reaches it: an id minted
 *  from a name, and the stub that id resolves. `DurableObjectNamespace` is
 *  wider than this in both directions the SDK never uses, so the deployment's
 *  binding satisfies it and a caller that has no Durable Objects at all can
 *  still say what this code would have reached. */
export type MossaicObject = MossaicEnv['MOSSAIC_USER'];

export interface DriveBindings extends Pick<Env, 'JWT_SECRET'> {
  MOSSAIC_USER?: MossaicObject;
  MOSSAIC_SHARD?: MossaicObject;
}

/** Whether this deployment binds the Drive's two objects AND holds the secret
 *  they sign listings with: a tenant whose first listing would answer 500 is
 *  not a Drive, and is stated as an absence here rather than met on a route. */
export function driveBound(env: DriveBindings): boolean {
  return env.MOSSAIC_USER !== undefined && env.MOSSAIC_SHARD !== undefined
    && (env.JWT_SECRET ?? '').length > 0;
}

export function tenantDrive(env: DriveBindings, tenant: string): MossaicVfs | null {
  if (!driveBound(env) || env.MOSSAIC_USER === undefined || env.MOSSAIC_SHARD === undefined) return null;

  return mossaicVfs(createVFS({ MOSSAIC_USER: env.MOSSAIC_USER, MOSSAIC_SHARD: env.MOSSAIC_SHARD }, { tenant }));
}
