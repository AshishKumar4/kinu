/** A user's Mossaic tenant; the tenant id is the Kinu user id, and this is the only place the SDK is constructed. */
import { createVFS, type MossaicEnv } from '@mossaic/sdk';
import { mossaicVfs, type MossaicVfs } from '@kinu.run/core';

export type MossaicObject = MossaicEnv['MOSSAIC_USER'];

export interface DriveBindings extends Pick<Env, 'JWT_SECRET'> {
  MOSSAIC_USER?: MossaicObject;
  MOSSAIC_SHARD?: MossaicObject;
}

/** Both objects and the listing-signing secret are required; without the secret every listing answers 500. */
export function driveBound(env: DriveBindings): boolean {
  return env.MOSSAIC_USER !== undefined && env.MOSSAIC_SHARD !== undefined
    && (env.JWT_SECRET ?? '').length > 0;
}

export function tenantDrive(env: DriveBindings, tenant: string): MossaicVfs | null {
  if (!driveBound(env) || env.MOSSAIC_USER === undefined || env.MOSSAIC_SHARD === undefined) return null;

  return mossaicVfs(createVFS({ MOSSAIC_USER: env.MOSSAIC_USER, MOSSAIC_SHARD: env.MOSSAIC_SHARD }, { tenant }));
}
