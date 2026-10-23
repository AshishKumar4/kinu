/**
 * Where a dream's change stands, read from the store that owns it (docs/EVOLUTION.md, "The watch"): a text version's
 * row, the fact's provenance, a skill's trust row. Settlement, the watch and the rater's list read it here; no status is
 * written beside it.
 */

import type { ActorHandle } from '../identity/actor-handle';
import type { SqlExecutor } from '../types/primitives';
import type { FactsStore } from '../memory/facts';
import type { InstructionApprovalStore } from '../safety/instruction-trust';
import { artifactVersion, type ArtifactStatus } from './artifacts';
import type { RefinementDeps, RefinementRequest, RefinementRoute } from './refinement';
import { replacedBy } from '../scaffold/versions';
import type { ScaffoldStatus } from '../types/scaffold';
import type { ChangelogRevertAction } from './changelog';

/** The stores a dream's changes live in, each the owner of whether its change is in effect. */
export interface ChangeOwners {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  /** The trust authority a dream's skill lives by; absent: no skill is in effect. */
  readonly approvals?: Pick<InstructionApprovalStore, 'get'>;
}

/** The stores a dream lane's changes live in. */
export function changeOwners(deps: Pick<RefinementDeps, 'control' | 'approvals'>): ChangeOwners {
  return { sql: deps.control.sql, actor: deps.control.rt.actor, ...(deps.approvals !== undefined && { approvals: deps.approvals }) };
}

/** Where a dream's change stands, as its owner holds it now, never as its route recorded it when it was made. */
export type ChangeStanding = 'refused' | 'waiting' | 'in_effect' | 'reverted' | 'replaced';

export interface Standing {
  readonly standing: ChangeStanding;
  readonly since: number;
}

/** A standing as the owner reads it in the changelog and the watch. */
export const STANDING_TEXT = {
  refused: 'refused',
  waiting: 'waiting for a cold turn',
  in_effect: 'in effect',
  reverted: 'reverted',
  replaced: 'replaced by a later version',
} as const satisfies Record<ChangeStanding, string>;

const TEXT_STANDING = {
  current: 'in_effect',
  staged: 'waiting',
  rolled_back: 'reverted',
  historical: 'replaced',
} as const satisfies Record<ArtifactStatus, ChangeStanding>;

/**
 * A text version by its row; a fact by whether the dream still wrote it last; a skill by its trust row: none yet is
 * waiting for a cold turn, one revoked or moved to other bytes is reverted, and one for the reviewed bytes is in
 * effect. Null for a change with no owner (a subagent spec) or a text version no longer stored.
 */
export function changeStanding(
  owners: ChangeOwners, facts: FactsStore, { request, route }: { readonly request: RefinementRequest; readonly route: RefinementRoute },
): Standing | null {
  if (route.disposition === 'refused') return { standing: 'refused', since: request.updatedAt };

  switch (route.kind) {
    case 'prompt_section':
    case 'tool_description': {
      const at = route.target.lastIndexOf('@');
      const row = at <= 0 ? null : artifactVersion(owners.sql, owners.actor, route.target.slice(0, at), Number(route.target.slice(at + 1)));

      return row === null ? null : { standing: TEXT_STANDING[row.status], since: row.decidedAt ?? row.writtenAt };
    }

    case 'fact': {
      const fact = facts.recall(route.target);

      // A later write by anyone else makes the fact theirs.
      return fact?.source === `refinement:${request.id}`
        ? { standing: 'in_effect', since: fact.lastObservedAt }
        : { standing: route.disposition === 'rejected' ? 'reverted' : 'replaced', since: request.updatedAt };
    }

    case 'skill': {
      const trust = owners.approvals?.get(route.target) ?? null;

      if (trust === null) return { standing: route.disposition === 'rejected' ? 'reverted' : 'waiting', since: request.updatedAt };

      return { standing: trust.decision === 'approved' && trust.digest === route.digest ? 'in_effect' : 'reverted', since: request.updatedAt };
    }

    case 'subagent_spec': return null;
  }
}

/** Whether a dream still holds its route: one the owner rejected, or a gate refused, is no longer the dream's to undo,
 *  even where the owner has since put the same bytes in effect themselves. */
export function routeHeld(route: Pick<RefinementRoute, 'disposition'>): boolean {
  return route.disposition === 'staged' || route.disposition === 'applied';
}

/**
 * How the owner reverts a dream's change that is in effect or waiting to be, through the change's own owner; null for
 * one that is neither, or that the dream no longer holds, so a fact another writer has since written is never offered
 * to be forgotten.
 */
export function revertOf(
  standing: ChangeStanding, { request, route, index }: { readonly request: RefinementRequest; readonly route: RefinementRoute; readonly index: number },
): ChangelogRevertAction | null {
  if ((standing !== 'in_effect' && standing !== 'waiting') || !routeHeld(route)) return null;

  switch (route.kind) {
    case 'fact': return { type: 'fact_forget', target: route.target };
    case 'prompt_section':
    case 'tool_description': return { type: 'artifact_revert', target: route.target };
    case 'skill': return request.stage === 'rolled_back' ? null : { type: 'skill_revert', target: `${request.id}#${String(index)}` };
    case 'subagent_spec': return null;
  }
}

const SCAFFOLD_STANDING = {
  current: 'in_effect',
  pending: 'waiting',
  rolled_back: 'reverted',
  historical: 'replaced',
} as const satisfies Record<ScaffoldStatus, ChangeStanding>;

/** A scaffold version by its row, in effect since the promotion that made it current; null for one never recorded. */
export function scaffoldStanding({ sql, actor }: ChangeOwners, version: number): Standing | null {
  actor.assertCurrent();

  const row = sql<{ status: ScaffoldStatus; written_at: number }>`SELECT status, written_at FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND version = ${version}`[0];

  return row === undefined ? null : { standing: SCAFFOLD_STANDING[row.status], since: replacedBy(sql, actor, version)?.at ?? row.written_at };
}
