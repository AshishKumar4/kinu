import * as v from 'valibot';
import { missingSubordinateHistory, readSubordinateInspection, SubordinateInspectionRequestSchema, type SubordinateInspectionRequest, type SubordinateInspectionResult } from './inspection';
import { SubordinateIdentityStore } from './support';
import { subordinateInspectionRoster } from './historical-roster';
import { tableExists } from '../identity/schema';
import type { JsonValue } from '../utils/json';
import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { SubordinateRosterEntry } from '../tools/agents-tool';
import { sameActorReference } from '../state/actor-handle';

export interface SubordinateInspectionAuthority {
  readonly owner: string;
  readonly workspace: string;
  readonly traversed: readonly string[];
  readonly storagePath: readonly string[];
}
export interface SubordinateInspectionPort {
  inspectSubordinateStorage(request: SubordinateInspectionRequest, authority: SubordinateInspectionAuthority): Promise<SubordinateInspectionResult>;
}
export interface SubordinateInspectionAccess {
  readonly sql: SqlExecutor;
  readonly raw: SqlExec;
  storedParentPath(): Promise<JsonValue | undefined>;
  storedPhysicalKey(): Promise<JsonValue | undefined>;
  existing(row: SubordinateRosterEntry): Promise<{ port: SubordinateInspectionPort; storageKey: string } | null>;
}
const ParentPathSchema = v.array(v.strictObject({ className: v.string(), name: v.string() }));

/** Only the root's owner transport constructs authority. Each hop verifies stored lineage. */
export async function inspectSubordinateStorage(
  access: SubordinateInspectionAccess,
  request: SubordinateInspectionRequest,
  authority: SubordinateInspectionAuthority,
): Promise<SubordinateInspectionResult> {
  const input = v.parse(SubordinateInspectionRequestSchema, request);
  const missing = () => missingSubordinateHistory(input.path);
  const { sql, raw } = access;
  const depth = authority.traversed.length;
  if (authority.storagePath.length !== depth) return missing();
  if (depth > 0) {
    if (await access.storedPhysicalKey() !== authority.storagePath.at(-1)) return missing();
    if (!tableExists(sql, 'subordinate_identity')) return missing();
    const identity = new SubordinateIdentityStore(raw).read();
    if (!identity || identity.ownerUserId !== authority.owner || identity.parentWorkspace !== authority.workspace
      || identity.name !== authority.traversed.at(-1) || identity.depth !== depth) return missing();
    const stored = v.safeParse(ParentPathSchema, await access.storedParentPath());
    if (!stored.success || stored.output.length !== depth) return missing();
    const root = stored.output[0];
    if (root?.className !== 'OrchestratorAgent' || root.name !== authority.workspace) return missing();
    for (let index = 1; index < depth; index++) {
      const parent = stored.output[index];
      if (parent?.className !== 'SubordinateAgent' || parent.name !== authority.storagePath[index - 1]) return missing();
    }
  }
  if (depth === input.path.length) return readSubordinateInspection(sql, raw, input);
  const name = input.path[depth];
  if (!name) return missing();
  const roster = subordinateInspectionRoster(sql, raw);
  if (!roster) return missing();
  const row = roster.get(name);
  if (!row) return missing();
  const child = await access.existing(row);
  // A wipe may remove the roster while the native lookup crosses an await.
  const current = roster.get(name);
  if (!child || !current || current.createdAt !== row.createdAt || current.lifetime !== row.lifetime) return missing();
  if ((row.actorReference === null) !== (current.actorReference === null)
    || (row.actorReference !== null && current.actorReference !== null && !sameActorReference(row.actorReference, current.actorReference))) return missing();
  return child.port.inspectSubordinateStorage(input, {
    owner: authority.owner, workspace: authority.workspace, traversed: [...authority.traversed, name],
    storagePath: [...authority.storagePath, child.storageKey],
  });
}
