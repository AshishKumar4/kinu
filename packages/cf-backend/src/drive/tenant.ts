/** A user's Mossaic tenant; the tenant id is the Kinu user id, and this is the only place the SDK is constructed. */
import { createVFS, type MossaicEnv } from '@mossaic/sdk';
import { mossaicVfs, objectNamed, type MossaicVfs } from '@kinu.run/core';

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

/**
 * Mossaic's names for a tenant's objects (its `vfsUserDOName` and `vfsShardDOName`, which the SDK does not export): the
 * default namespace, as `createVFS` opens it above.
 */
export function tenantObjectNames(tenant: string) {
  return { user: `vfs:default:${tenant}`, shard: (index: number) => `vfs:default:${tenant}:s${String(index)}` };
}

/** The account's Drive deleted whole, as the account is: every shard its bytes may be on, then its user object. */
export async function destroyDriveTenant(env: Pick<Env, 'MOSSAIC_USER' | 'MOSSAIC_SHARD'>, tenant: string): Promise<{ readonly shards: number }> {
  const { MOSSAIC_USER: users, MOSSAIC_SHARD: shards } = env;

  if (users === undefined || shards === undefined) return { shards: 0 };
  const names = tenantObjectNames(tenant);
  const user = objectNamed(users, names.user);
  const spans = await user.tenantShards();

  for (let index = 0; index < spans; index += 1) await objectNamed(shards, names.shard(index)).destroyShard();
  await user.destroyUser();

  return { shards: spans };
}
