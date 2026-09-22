/**
 * Owner-authorized inspection of a subordinate's own rows in the workspace database.
 * The owner check runs first; the walk goes through {@link WorkspaceActorDirectory} from
 * the caller, so only the caller's descendants are reachable.
 */

import { missingSubordinateHistory, readSubordinateInspection, SubordinateInspectionRequestSchema, type SubordinateInspectionRequest, type SubordinateInspectionResult } from './inspection';
import * as v from 'valibot';
import { tableExists } from '../identity/schema';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { WorkspaceActorDirectory } from '../identity/workspace-actors';
import type { SessionTranscriptReader } from '../session/transcript';

export interface SubordinateInspectionAuthority {
  /** The owner the transport authenticated. */
  readonly owner: string;
  /** The workspace the transport addressed, by name. */
  readonly workspace: string;
}

export interface SubordinateInspectionAccess {
  /** The workspace database every actor's rows live in. */
  readonly sql: SqlExecutor;
  readonly raw: SqlExec;
  /** The actor the request is made as; the walk starts here. */
  readonly actor: ActorHandle;
  /** Membership authority: which actors exist, and whose children they are. */
  readonly directory: WorkspaceActorDirectory;
  readonly transcriptFor: (actor: ActorHandle) => SessionTranscriptReader;
}

const OwnerRowSchema = v.object({ name: v.string(), owner_user_id: v.nullable(v.string()) });

/** Read one actor's own rows, as that actor, under its ancestor's authority. */
export async function inspectSubordinateStorage(
  access: SubordinateInspectionAccess,
  request: SubordinateInspectionRequest,
  authority: SubordinateInspectionAuthority,
): Promise<SubordinateInspectionResult> {
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

  return readSubordinateInspection({ sql: access.sql, raw: access.raw, actor: target, transcriptFor: access.transcriptFor }, input);
}
