/**
 * Every database Kinu makes is of one class (an account, a workspace, an agent, a CLI-local workspace), and is
 * stamped (a local one in `PRAGMA user_version`, a Durable Object in its own KV) with its class's stamp: the digest of the genesis of the tables that class's init
 * makes (`scripts/schema-classes.json`, `SCHEMA_STAMPS`). A database is asked its stamp, never caught failing:
 *
 * - the class's stamp: it holds the tables its init makes, as this build declares them, and is opened;
 * - none (0) and none of the class's tables: nothing made it yet, so it is made and stamped;
 * - anything else: a release changed its class's tables since it was made, and its object repairs it before anything
 *   else reads it (state/schema-repair.ts); a Durable Object made before stamps were per class (0, with its tables) is
 *   such a database. One whose repair refuses is read by nothing until a release can bring it up.
 *
 * A change to one class's tables moves only its stamp, so it puts no other class's databases into repair. A local
 * database and an export are refused under another stamp: Kinu never migrates them.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { SCHEMA_STAMPS } from './schema-genesis';
import type { RawSqlExec, SqlExec } from '../types/primitives';

export type SchemaClass = keyof typeof SCHEMA_STAMPS;

/** Marks a local database as made by this build: the one writer of the stamp a local database is opened under. */
export function stampSchemaGenesis(execRaw: RawSqlExec): void {
  execRaw(`PRAGMA user_version = ${String(SCHEMA_STAMPS.local)}`);
}

/** The table each class's init makes first: a database without it was never made by that class. */
const FIRST_TABLE = {
  account: 'user_profile',
  workspace: 'workspace_capability',
  agent: 'workspace_actors',
  local: 'workspace_identity',
  room: 'room',
  gallery: 'gallery_listings',
} as const satisfies Record<SchemaClass, string>;

/** What a database says of itself, read once (and, for an unstamped one, whether its class made it). */
export type StampReading = 'current' | 'unmade' | 'behind';

/** Where a database keeps its stamp: SQLite's `user_version` for a local one; a Durable Object's own synchronous KV,
 *  since its SQL may run no such PRAGMA (SQLITE_AUTH). */
export interface StampStore {
  read(): number;
  write(stamp: number): void;
}

const VersionSchema = v.object({ user_version: v.number() });

/** A local database's stamp, in its `user_version`. */
export function pragmaStamps(sql: SqlExec): StampStore {
  return {
    read: () => v.parse(VersionSchema, sql.exec('PRAGMA user_version').toArray()[0]).user_version,
    write: (stamp) => { sql.exec(`PRAGMA user_version = ${String(stamp)}`); },
  };
}

/** The key a Durable Object keeps its stamp under, in the KV beside its SQL. */
const STAMP_KEY = 'kinu.schema_stamp';

/** The part of a Durable Object's synchronous KV a stamp reads and writes. */
export interface StampKv {
  get(key: string): number | undefined;
  put(key: string, value: number): void;
}

/** A Durable Object's stamp, in its own synchronous KV. */
export function durableStamps(kv: StampKv): StampStore {
  return {
    read: () => v.parse(v.optional(v.number(), 0), kv.get(STAMP_KEY)),
    write: (stamp) => { kv.put(STAMP_KEY, stamp); },
  };
}

/** Whether `sql` holds `schema`'s tables as this build declares them, holds none yet, or is behind this build. */
export function readStamp(stamps: StampStore, sql: SqlExec, schema: SchemaClass): StampReading {
  const stamp = stamps.read();

  if (stamp === SCHEMA_STAMPS[schema]) return 'current';

  if (stamp !== 0) return 'behind';

  return sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, FIRST_TABLE[schema]).toArray().length === 0 ? 'unmade' : 'behind';
}

/** Marks a database as holding `schema`'s tables as this build declares them. */
export function writeStamp(stamps: StampStore, schema: SchemaClass): void {
  stamps.write(SCHEMA_STAMPS[schema]);
}

/** The refusal a Durable Object answers every call with when its repair could not bring it to this build. */
export class StoragePredatesReleaseError extends KinuError {
  override readonly name = 'StoragePredatesReleaseError';

  constructor(readonly schema: SchemaClass, readonly reason: string) {
    super('unavailable', `This ${schema}'s storage could not be brought to this release's tables, so it is kept as it is `
      + `and nothing reads it until a release can: ${reason}`);
  }
}

/** Refuses `what`, a local database or an export stamped `stamp` (0 for none), unless this Kinu made it. */
export function requireSchemaStamp(what: string, schema: SchemaClass, stamp: number): void {
  return settleSync(stamp === SCHEMA_STAMPS[schema] ? Effect.void : Effect.fail(new KinuError('unsupported',
    `${what} was made by an older version of Kinu, which this version cannot open. To start fresh, run: `
    + 'kinu create <new-name>')));
}
