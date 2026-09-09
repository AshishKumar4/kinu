/**
 * Owner-authorized inspection of a subordinate's own rows, in the ONE workspace
 * database.
 *
 * WHAT THIS USED TO BE. Every actor owned a database, so inspecting a
 * grandchild meant an RPC per hop, and each hop had to prove its own lineage
 * from rows only it could see: a stored parent path of SDK class names
 * (`OrchestratorAgent`, then `SubordinateAgent` per level), a stored physical
 * key, and a per-facet identity row. That chain was the only authority
 * available — but it authenticated a facet's own account of who its parents
 * were, and a class name is not an identity.
 *
 * WHAT IT IS NOW. There is one database and one membership authority over it:
 * `workspace_actors`, read through {@link WorkspaceActorDirectory}. So the walk
 * is a directory walk from the CALLER's own actor, each hop issued by that
 * directory, and the read is taken as the actor the walk arrived at. No RPC per
 * hop, no per-facet identity row, no class-name comparison — and no way to
 * reach an actor that is not a descendant of the caller, because
 * `resolveChild` only answers for children of the handle it is given.
 *
 * The owner check stays and stays FIRST: the transport authenticated an owner
 * and addressed a workspace by name, and this verifies both against the
 * workspace's own identity row before any actor is resolved. A request that
 * names an owner this database does not belong to reads nothing.
 */

import { missingSubordinateHistory, readSubordinateInspection, SubordinateInspectionRequestSchema, type SubordinateInspectionRequest, type SubordinateInspectionResult } from './inspection';
import * as v from 'valibot';
import { tableExists } from '../identity/schema';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import type { WorkspaceActorDirectory } from '../state/workspace-actors';

export interface SubordinateInspectionAuthority {
  /** The owner the transport authenticated. */
  readonly owner: string;
  /** The workspace the transport addressed, by name. */
  readonly workspace: string;
}

export interface SubordinateInspectionAccess {
  /** The ONE workspace database every actor's rows live in. */
  readonly sql: SqlExecutor;
  readonly raw: SqlExec;
  /**
   * The actor the request is made AS. The walk starts here, so a subordinate
   * asking about `['a','b']` reaches its own descendants and nobody else's.
   */
  readonly actor: ActorHandle;
  /** Membership authority: which actors exist, and whose children they are. */
  readonly directory: WorkspaceActorDirectory;
}

const OwnerRowSchema = v.object({ name: v.string(), owner_user_id: v.nullable(v.string()) });

/** Read one actor's own rows, as that actor, under its ancestor's authority. */
export function inspectSubordinateStorage(
  access: SubordinateInspectionAccess,
  request: SubordinateInspectionRequest,
  authority: SubordinateInspectionAuthority,
): SubordinateInspectionResult {
  const input = v.parse(SubordinateInspectionRequestSchema, request);
  const missing = (): SubordinateInspectionResult => missingSubordinateHistory(input.path);
  if (!tableExists(access.sql, 'workspace_identity')) return missing();
  const rows = access.sql<{ name: string; owner_user_id: string | null }>`
    SELECT name, owner_user_id FROM workspace_identity`;
  if (rows.length !== 1) return missing();
  const identity = v.parse(OwnerRowSchema, rows[0]);
  if (identity.name !== authority.workspace || identity.owner_user_id !== authority.owner) return missing();
  let target = access.actor;
  for (const name of input.path) {
    const child = access.directory.resolveChild(target, name);
    if (!child) return missing();
    target = child;
  }
  return readSubordinateInspection(access.sql, target, access.raw, input);
}
