/** A local database's or an export's schema genesis, refused under another: Kinu never migrates a workspace. */

import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { SCHEMA_GENESIS } from './schema-genesis';

/** SQLite's `user_version` is a signed 32-bit integer: seven hex digits of the digest fit it. */
export const SCHEMA_GENESIS_STAMP = Number.parseInt(SCHEMA_GENESIS.slice(0, 7), 16);

/** Refuses `what`, stamped `stamp` (seven hex digits, or null when unstamped), unless this Kinu made it. */
export function requireSchemaGenesis(what: string, stamp: string | null): void {
  return settleSync(stamp === SCHEMA_GENESIS.slice(0, 7) ? Effect.void : Effect.fail(new KinuError('unsupported',
    `${what} was made by an older Kinu (schema ${stamp ?? 'unstamped'}, this Kinu reads `
    + `${SCHEMA_GENESIS.slice(0, 7)}), and Kinu does not migrate a workspace. Start a new one with `
    + '`kinu create <name>`; the old one stays where it is.')));
}
