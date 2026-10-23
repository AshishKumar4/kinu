/**
 * Mossaic's two Drive objects as Kinu deploys them (`server.ts`), with what Mossaic has no call for: an account's
 * tenant deleted whole, as the account is (`destroyDriveTenant`).
 */
import * as v from 'valibot';
import { MossaicShardDO as MossaicShard, MossaicUserDO as MossaicUser } from '@mossaic/sdk';

const TopSchema = v.object({ top: v.nullable(v.number()) });

const UsedSchema = v.object({ used: v.nullable(v.number()) });

const CountSchema = v.object({ held: v.number() });

/**
 * The object's storage deleted and its activation ended, so a tenant of the same name later starts from nothing: its
 * schema flag is in memory, and an activation left running after `deleteAll` answers "no such table" (measured in
 * workerd, 2026-10-22). The end can cut this call's answer on its way back (production, 2026-10-22: 32 of 32 cut, where
 * local workerd delivered 60 of 60), so the caller learns the outcome from `storedTables`, not from this answer.
 */
async function deleted(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  setTimeout(() => { ctx.abort('the drive tenant was deleted'); }, 0);
}

/** How many of its own tables the object holds, read without opening its schema: none once it was deleted. */
function storedTables(ctx: DurableObjectState): number {
  return v.parse(CountSchema, ctx.storage.sql.exec(
    // The runtime's own tables, `_cf_*` and `sqlite_*`, are not the object's (and `_` is a wildcard to LIKE).
    "SELECT COUNT(*) AS held FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'",
  ).one()).held;
}

export class MossaicUserDO extends MossaicUser {
  /** How many shards this tenant's bytes may be on: its pool, or past it where any record names a higher shard. */
  tenantShards(): number {
    const sql = this.ctx.storage.sql;
    const top = (column: string, table: string): number => v.parse(TopSchema, sql.exec(`SELECT MAX(${column}) AS top FROM "${table}"`).one()).top ?? -1;

    // Every table that names a shard, by its own definition (workerd refuses `pragma_table_info`), and the pool's size: a
    // tenant whose tables were never made spans none.
    const tables = sql.exec<{ name: string; ddl: string }>(`SELECT name, sql AS ddl FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`).toArray();
    const named = tables.filter(({ ddl }) => /\bshard_index\b/u.test(ddl)).map(({ name }) => top('shard_index', name) + 1);
    const pool = tables.some(({ name }) => name === 'quota') ? top('pool_size', 'quota') : 0;

    return Math.max(0, pool, ...named);
  }

  /** The bytes this tenant's files hold, as Mossaic itself accounts them (`quota.storage_used`); 0 before any write. */
  storedBytes(): number {
    const sql = this.ctx.storage.sql;
    const made = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quota'`).toArray().length > 0;

    return made ? v.parse(UsedSchema, sql.exec('SELECT SUM(storage_used) AS used FROM quota').one()).used ?? 0 : 0;
  }

  /** Every file, version and record this tenant has, deleted; its shards are first (`destroyDriveTenant`). */
  async destroyUser(): Promise<void> {
    await deleted(this.ctx);
  }

  /** The tables this tenant's object holds: none once `destroyUser` ran. */
  storedTables(): number {
    return storedTables(this.ctx);
  }
}

export class MossaicShardDO extends MossaicShard {
  /** Every chunk and record this shard holds for its tenant, deleted. */
  async destroyShard(): Promise<void> {
    await deleted(this.ctx);
  }

  /** The tables this shard holds: none once `destroyShard` ran. */
  storedTables(): number {
    return storedTables(this.ctx);
  }
}
