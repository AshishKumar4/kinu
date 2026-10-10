/**
 * A local workspace database carries the schema genesis that made it. A reset deployment clears Durable Objects
 * only; a local database made under another genesis would open and then fail on its first missing column, so it is
 * refused by name. Kinu never migrates a schema (AGENTS.md "No migrations").
 */

import type { Database } from 'bun:sqlite';
import { exists } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import { getCurrentScaffoldVersion, type ActorHandle, type SqlExecutor, type VersionedScaffoldSource } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
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

interface LocalActorScaffold {
  readonly actor: ActorHandle;
  readonly sql: SqlExecutor;
  readonly source: VersionedScaffoldSource;
}

/** Only the actor-owned layout is read. A retained pointer without its own bytes requires a reset, never a copy. */
export function localActorScaffoldSource({ actor, sql, source }: LocalActorScaffold): Promise<VersionedScaffoldSource> {
  return settle(Effect.gen(function* () {
    const version = getCurrentScaffoldVersion(sql, actor);

    if (actor.parentActorId !== null && version !== null && !(yield* Effect.promise(() => exists(source.vfs, `${source.path}.v${version}`)))) {
      return yield* new KinuError('unsupported', `Actor ${actor.name} lacks its actor-owned scaffold bytes. This CLI layout ships with a reset, and Kinu does not migrate local workspaces. Start a new workspace with kinu create <name>; the old database and files stay untouched.`);
    }

    return source;
  }));
}
