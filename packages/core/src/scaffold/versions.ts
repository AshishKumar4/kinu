/** The scaffold version an actor runs, and the source of any version: the one reader every status and trial uses. */
import { exists, readText } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

/** Highest status='current' version. Never `pending - 1` or MAX: numbering is non-contiguous after rollbacks, and MAX counts a pending proposal. */
export function getCurrentScaffoldVersion(sql: SqlExecutor, actor: Pick<ActorHandle, 'actorId' | 'assertCurrent'>): number | null {
  actor.assertCurrent();

  const rows = sql<{ version: number }>`
    SELECT version FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND status = 'current'
    ORDER BY version DESC LIMIT 1`;

  return rows[0]?.version ?? null;
}

export async function readVersionedScaffoldSource(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = `${rt.identity.scaffold.path}.v${version}`;
  const scaffoldVfs = rt.agentStateVfs ?? rt.storage.vfs;

  if (!await exists(scaffoldVfs, versioned)) return null;

  return v.parse(v.string(), await readText(scaffoldVfs, versioned));
}

/** Prefers the canonical `agent.js.v{N}` file; the live file holds the current version, not a pending one. */
export async function readScaffoldVersion(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = await readVersionedScaffoldSource(rt, version);

  if (versioned !== null) return versioned;

  // No version file (v0): the live file holds only the status='current' version, so a missing pending file is not it.
  if (version !== getCurrentScaffoldVersion(rt.storage.sql, rt.actor)) return null;

  return await rt.identity.scaffold.read();
}
