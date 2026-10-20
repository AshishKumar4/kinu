/**
 * Mossaic's two Drive objects as Kinu deploys them (`server.ts`), with what Mossaic has no call for: an account's
 * tenant deleted whole, as the account is (`destroyDriveTenant`).
 */
import * as v from 'valibot';
import { MossaicShardDO as MossaicShard, MossaicUserDO as MossaicUser } from '@mossaic/sdk';

const TopSchema = v.object({ top: v.nullable(v.number()) });

/** The object's storage deleted and its activation ended, so a tenant of the same name later starts from nothing. */
async function deleted(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  setTimeout(() => { ctx.abort('the drive tenant was deleted'); }, 0);
}

export class MossaicUserDO extends MossaicUser {
  /** How many shards this tenant's bytes may be on: its pool, or past it where any record names a higher shard. */
  tenantShards(): number {
    const sql = this.ctx.storage.sql;
    const top = (column: string, table: string): number => v.parse(TopSchema, sql.exec(`SELECT MAX(${column}) AS top FROM "${table}"`).one()).top ?? -1;

    // Every table that names a shard, and the pool's size: a tenant whose tables were never made spans none.
    const named = sql.exec<{ name: string; column: string }>(`SELECT m.name AS name, p.name AS column FROM sqlite_master m, pragma_table_info(m.name) p
      WHERE m.type = 'table' AND (p.name = 'shard_index' OR (m.name = 'quota' AND p.name = 'pool_size'))`).toArray();

    return Math.max(0, ...named.map(({ name, column }) => (column === 'pool_size' ? top(column, name) : top(column, name) + 1)));
  }

  /** Every file, version and record this tenant has, deleted; its shards are first (`destroyDriveTenant`). */
  async destroyUser(): Promise<void> {
    await deleted(this.ctx);
  }
}

export class MossaicShardDO extends MossaicShard {
  /** Every chunk and record this shard holds for its tenant, deleted. */
  async destroyShard(): Promise<void> {
    await deleted(this.ctx);
  }
}
