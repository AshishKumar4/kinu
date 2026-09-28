/**
 * A local workspace database carries the schema genesis that made it. A reset deployment clears Durable Objects
 * only; a local database made under another genesis would open and then fail on its first missing column, so it is
 * refused by name. Kinu never migrates a schema (AGENTS.md "No migrations").
 */

import type { Database } from 'bun:sqlite';
import { requireSchemaGenesis as requireGenesis, SCHEMA_GENESIS_STAMP } from '@kinu.run/core';

/** Marks a database this Kinu made outside `createWorkspace`, which stamps its own. */
export function stampSchemaGenesis(db: Database): void {
  db.exec(`PRAGMA user_version = ${String(SCHEMA_GENESIS_STAMP)}`);
}

/** The seven hex digits a database is stamped with, or null for one no Kinu stamped. */
export function schemaGenesisOf(db: Database): string | null {
  const stamp = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;

  return stamp === 0 ? null : stamp.toString(16).padStart(7, '0');
}

/** Refuses a database another Kinu's schema made. */
export function requireSchemaGenesis(db: Database, name: string): void {
  requireGenesis(`Workspace "${name}"`, schemaGenesisOf(db));
}
