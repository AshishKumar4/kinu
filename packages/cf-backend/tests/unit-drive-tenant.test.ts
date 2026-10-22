// An account's Drive deleted whole. Production, 2026-10-22: every trial account's deletion answered 500, because each
// Drive object's deletion ends its activation, and that end cut the deletion's answer on its way back (32 of 32); the
// storage was gone all the same. The deletion is now confirmed by a read of the storage, not by the answer.
import { describe, expect, test } from 'bun:test';
import { renderThrownChain } from '@kinu.run/core/obs';
import { destroyDriveTenant } from '../src/drive/tenant';

/** A Drive object as production measured it: its deletion empties its storage, then its answer is cut, unless `keeps`. */
interface Stored {
  tables: number;
  readonly shardIndex: number;
}

function drive(spans: number, keeps: ReadonlySet<string> = new Set()) {
  const stored = new Map<string, Stored>();

  const of = (name: string): Stored => {
    const found = stored.get(name) ?? { tables: 3, shardIndex: 0 };

    stored.set(name, found);

    return found;
  };

  const deletion = async (name: string): Promise<void> => {
    if (!keeps.has(name)) of(name).tables = 0;

    throw new Error('the drive tenant was deleted');
  };

  const namespace = <Stub>(stub: (name: string) => Stub) => ({ idFromName: (name: string) => name, get: (name: string) => stub(name) });

  const env = {
    MOSSAIC_USER: namespace((name) => ({
      tenantShards: async () => spans, destroyUser: async () => deletion(name), storedTables: async () => of(name).tables,
    })),
    MOSSAIC_SHARD: namespace((name) => ({ destroyShard: async () => deletion(name), storedTables: async () => of(name).tables })),
  };

  return { env, tables: () => Object.fromEntries([...stored].map(([name, object]) => [name, object.tables])) };
}

describe("an account's Drive deleted", () => {
  test('whole, its storage read back empty, though every deletion answer was cut by the end of its activation', async () => {
    const { env, tables } = drive(2);

    await expect(destroyDriveTenant(env, 'u1')).resolves.toEqual({ shards: 2 });
    expect(tables()).toEqual({ 'vfs:default:u1': 0, 'vfs:default:u1:s0': 0, 'vfs:default:u1:s1': 0 });
  });

  test('not, where an object still holds its tables: the failure is its deletion\'s, naming the object', async () => {
    const { env } = drive(2, new Set(['vfs:default:u1:s1']));

    const [outcome] = await Promise.allSettled([destroyDriveTenant(env, 'u1')]);
    const failed = outcome.status === 'rejected' ? renderThrownChain({ cause: outcome.reason }) : 'it answered';

    expect(failed).toMatch(/the Drive's shard 1[\s\S]*the drive tenant was deleted/u);
  });
});
