/**
 * A local workspace database carries its class's stamp (identity/schema-stamp.ts): the digest of the genesis of the
 * tables a local workspace makes. A database made under another would open and then fail on its first missing column,
 * so it is refused by name. Kinu never migrates a local schema (AGENTS.md "No migrations").
 */

import type { Database } from 'bun:sqlite';
import { exists } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import { getCurrentScaffoldVersion, pragmaStamps, requireSchemaStamp, type ActorHandle, type SqlExecutor, type VersionedScaffoldSource } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import { makeSqlExec } from './runtime';

/** The stamp a database carries, 0 for none. */
export function schemaGenesisOf(db: Database): number {
  return pragmaStamps(makeSqlExec(db)).read();
}

/** Refuses a database another Kinu's schema made. */
export function requireSchemaGenesis(db: Database, name: string): void {
  requireSchemaStamp(`Workspace "${name}"`, 'local', schemaGenesisOf(db));
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
