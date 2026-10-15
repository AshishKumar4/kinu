/** A local database's or an export's schema genesis, refused under another: Kinu never migrates a workspace. */

import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { SCHEMA_GENESIS } from './schema-genesis';
import type { RawSqlExec } from '../types/primitives';

/** SQLite's `user_version` is a signed 32-bit integer: seven hex digits of the digest fit it. */
const SCHEMA_GENESIS_STAMP = Number.parseInt(SCHEMA_GENESIS.slice(0, 7), 16);

/** Marks a local database as made under this genesis: the one writer of the stamp `requireSchemaGenesis` reads. */
export function stampSchemaGenesis(execRaw: RawSqlExec): void {
  execRaw(`PRAGMA user_version = ${String(SCHEMA_GENESIS_STAMP)}`);
}

/** Refuses `what`, stamped `stamp` (seven hex digits, or null when unstamped), unless this Kinu made it. */
export function requireSchemaGenesis(what: string, stamp: string | null): void {
  return settleSync(stamp === SCHEMA_GENESIS.slice(0, 7) ? Effect.void : Effect.fail(new KinuError('unsupported',
    `${what} was made by an older version of Kinu, which this version cannot open. To start fresh, run: `
    + 'kinu create <new-name>')));
}
