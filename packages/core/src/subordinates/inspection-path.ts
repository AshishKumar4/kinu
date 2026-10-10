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
import { isSubordinateOrigin, type WorkspaceActorDirectory } from '../identity/workspace-actors';
import { readSessionTranscript, type SessionTranscriptReader } from '../session/transcript';
import { actorReadHandle } from '../read-models/workspace-work';
import { CHAT_SESSION_ID } from '../session/transcript-schema';

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
  /** A subordinate's chat and run views, read where its own rows are. */
  readonly ownRows: (actor: ActorHandle, request: AgentOwnInspection) => Promise<SubordinateInspectionResult>;
}

export type AgentOwnInspection = Extract<SubordinateInspectionRequest, { readonly view: 'history' | 'runs' | 'events' | 'step' }>;

function ownView(request: SubordinateInspectionRequest): request is AgentOwnInspection {
  return request.view === 'history' || request.view === 'runs' || request.view === 'events' || request.view === 'step';
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

  return inspectDescendant(access, input);
}

/** The walk from `access.actor` down `path`, then to the named actor if any; the caller has already authorized it. */
export async function inspectDescendant(
  access: SubordinateInspectionAccess,
  request: SubordinateInspectionRequest,
): Promise<SubordinateInspectionResult> {
  const input = v.parse(SubordinateInspectionRequestSchema, request);
  const missing = (): SubordinateInspectionResult => missingSubordinateHistory(input.path);
  let target = access.actor;

  for (const name of input.path) {
    const child = access.directory.resolveChild(target, name);

    if (!child) return missing();
    target = child;
  }

  if ('actor' in input && input.actor !== undefined) {
    const kept = retainedDescendant(access, target, input.actor);

    if (kept === null) return missing();

    if (ownView(input)) return await access.ownRows(kept.actor, input);

    return readSubordinateInspection({ sql: access.sql, raw: access.raw, actor: kept.actor, transcriptFor: () => kept.transcript }, input);
  }

  if (ownView(input) && target.parentActorId !== null) return await access.ownRows(target, input);

  return readSubordinateInspection({ sql: access.sql, raw: access.raw, actor: target, transcriptFor: access.transcriptFor }, input);
}

/** A subordinate at any depth below `ancestor`, live or released. */
function retainedDescendant(access: SubordinateInspectionAccess, ancestor: ActorHandle, actorId: string): { actor: ActorHandle; transcript: SessionTranscriptReader } | null {
  const record = access.directory.retained(actorId);

  for (let step = record; step?.actorId !== ancestor.actorId; step = access.directory.retained(step.parentActorId ?? '')) {
    if (step === null || !isSubordinateOrigin(step.origin)) return null;
  }

  if (record === null) return null;

  if (record.retiringAt === null && record.deletedAt === null) {
    const actor = access.directory.open(actorId);

    return { actor, transcript: access.transcriptFor(actor) };
  }

  const actor = actorReadHandle(access.sql, record);

  return { actor, transcript: readSessionTranscript(access.sql, actor, CHAT_SESSION_ID, null) };
}
