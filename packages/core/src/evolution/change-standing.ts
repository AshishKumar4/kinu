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
import type { RefinementRequest, RefinementRoute } from './refinement';

/** The stores a dream's changes live in, each the owner of whether its change is in effect. */
export interface ChangeOwners {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  /** The trust authority a dream's skill lives by; absent: no skill is in effect. */
  readonly approvals?: Pick<InstructionApprovalStore, 'get'>;
}

/** Where a dream's change stands, as its owner holds it now, never as its route recorded it when it was made. */
export type ChangeStanding = 'refused' | 'waiting' | 'in_effect' | 'reverted' | 'replaced';

export interface Standing {
  readonly standing: ChangeStanding;
  readonly since: number;
}

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
