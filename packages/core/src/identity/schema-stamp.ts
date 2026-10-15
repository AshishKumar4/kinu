/**
 * Every database Kinu makes is of one class (an account, a workspace, an agent, a CLI-local workspace), and is
 * stamped (`PRAGMA user_version`) with its class's stamp: the digest of the genesis of the tables that class's init
 * makes (`scripts/schema-classes.json`, `SCHEMA_STAMPS`). A database is asked its stamp, never caught failing:
 *
 * - the class's stamp: it holds the tables its init makes, as this build declares them, and is opened;
 * - none (0) and none of the class's tables: nothing made it yet, so it is made and stamped;
 * - anything else: a release changed its class's tables since it was made, and nothing of it is read or written but
 *   by the tables step that brings it to this build (`scripts/reset.ts tables`); a Durable Object made before stamps
 *   were per class (0, with its tables) is such a database, which the step repairs and stamps.
 *
 * A change to one class's tables moves only its stamp, so it puts no other class's databases into repair. A local
 * database and an export are refused under another stamp: Kinu never migrates them.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { SCHEMA_STAMPS } from './schema-genesis';
import type { SqlExec } from '../types/primitives';

export type SchemaClass = keyof typeof SCHEMA_STAMPS;

/** The table each class's init makes first: a database without it was never made by that class. */
const FIRST_TABLE = {
  account: 'user_profile',
  workspace: 'workspace_capability',
  agent: 'workspace_actors',
  local: 'workspace_identity',
} as const satisfies Record<SchemaClass, string>;

/** What a database says of itself, read with one PRAGMA (and, for an unstamped one, whether its class made it). */
export type StampReading = 'current' | 'unmade' | 'behind';

const VersionSchema = v.object({ user_version: v.number() });

/** The stamp `sql`'s database carries, 0 for none. */
export function stampOf(sql: SqlExec): number {
  return v.parse(VersionSchema, sql.exec('PRAGMA user_version').toArray()[0]).user_version;
}

/** Whether `sql` holds `schema`'s tables as this build declares them, holds none yet, or is behind this build. */
export function readStamp(sql: SqlExec, schema: SchemaClass): StampReading {
  const stamp = stampOf(sql);

  if (stamp === SCHEMA_STAMPS[schema]) return 'current';

  if (stamp !== 0) return 'behind';

  return sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, FIRST_TABLE[schema]).toArray().length === 0 ? 'unmade' : 'behind';
}

/** Marks `sql`'s database as holding `schema`'s tables as this build declares them. */
export function writeStamp(sql: SqlExec, schema: SchemaClass): void {
  sql.exec(`PRAGMA user_version = ${String(SCHEMA_STAMPS[schema])}`);
}

/** The refusal a Durable Object behind this build answers every call with until the tables step reaches it. */
export class StoragePredatesReleaseError extends KinuError {
  override readonly name = 'StoragePredatesReleaseError';

  constructor(readonly schema: SchemaClass, readonly stamp: number) {
    super('unavailable', `This ${schema}'s storage was made before this release changed its tables (it is stamped ${stamp.toString(16)}, `
      + `this build ${SCHEMA_STAMPS[schema].toString(16)}): the deploy's tables step (scripts/reset.ts tables) has not reached it yet. `
      + 'Try again in a few minutes.');
  }
}

/** Refuses `what`, a local database or an export stamped `stamp` (0 for none), unless this Kinu made it. */
export function requireSchemaStamp(what: string, schema: SchemaClass, stamp: number): void {
  return settleSync(stamp === SCHEMA_STAMPS[schema] ? Effect.void : Effect.fail(new KinuError('unsupported',
    `${what} was made by an older version of Kinu, which this version cannot open. To start fresh, run: `
    + 'kinu create <new-name>')));
}
