/** A user's Mossaic tenant; the tenant id is the Kinu user id, and this is the only place the SDK is constructed. */
import { createVFS, type MossaicEnv } from '@mossaic/sdk';
import { mossaicVfs, objectNamed, type MossaicVfs } from '@kinu.run/core';
import { confirmedDeletion } from '@kinu.run/core/obs';
import type { MossaicShardDO, MossaicUserDO } from './mossaic-objects';

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
function tenantObjectNames(tenant: string) {
  return { user: `vfs:default:${tenant}`, shard: (index: number) => `vfs:default:${tenant}:s${String(index)}` };
}

/** A namespace of the Drive's objects, as far as `destroyDriveTenant` calls into it: an object by its name. */
interface DriveNamespace<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id): Stub;
}

/** An object's methods as a stub answers them: each one's answer awaited. */
type Answered<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** The Drive's two objects, as Kinu deploys them: the calls its deletion makes of each. */
interface DriveObjects<Id> {
  readonly MOSSAIC_USER?: DriveNamespace<Id, Answered<Pick<MossaicUserDO, 'tenantShards' | 'destroyUser' | 'storedTables' | 'storedBytes'>>>;
  readonly MOSSAIC_SHARD?: DriveNamespace<Id, Answered<Pick<MossaicShardDO, 'destroyShard' | 'storedTables'>>>;
}

/** The bytes the account's Drive holds, as its tenant accounts them; 0 on a deployment with no Drive. */
export async function driveStoredBytes<Id>(env: DriveObjects<Id>, tenant: string): Promise<number> {
  return env.MOSSAIC_USER === undefined ? 0 : await objectNamed(env.MOSSAIC_USER, tenantObjectNames(tenant).user).storedBytes();
}

/** The account's Drive deleted whole, as the account is: every shard its bytes may be on, then its user object. */
export async function destroyDriveTenant<Id>(env: DriveObjects<Id>, tenant: string): Promise<{ readonly shards: number }> {
  const { MOSSAIC_USER: users, MOSSAIC_SHARD: shards } = env;

  if (users === undefined || shards === undefined) return { shards: 0 };
  const names = tenantObjectNames(tenant);
  const spans = await objectNamed(users, names.user).tenantShards();

  for (let index = 0; index < spans; index += 1) {
    await confirmedDeletion(() => {
      const shard = objectNamed(shards, names.shard(index));

      return { destroy: async () => shard.destroyShard(), remains: async () => shard.storedTables() };
    }, `the Drive's shard ${String(index)}`);
  }

  await confirmedDeletion(() => {
    const user = objectNamed(users, names.user);

    return { destroy: async () => user.destroyUser(), remains: async () => user.storedTables() };
  }, "the Drive's user object");

  return { shards: spans };
}
