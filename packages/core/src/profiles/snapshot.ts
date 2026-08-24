// The durable snapshot of one resolved turn profile.
//
// A durable swarm must run under the profile it was STARTED under, however long
// it lives: catalog edits are for later turns, never an in-flight tree. So
// before a swarm detaches into a durable job — and therefore before any
// re-drive of that job can reach today's catalog — the run records ONE frozen
// copy of what the resolver produced, beside the provenance saying why each
// slot carries the value it does.
//
// This module is the codec for that record: the valibot gate over the frozen
// {@link ResolvedTurnProfile} shape plus its three source tags. It lives beside
// the resolver so the two cannot drift; the ledger stores it inside the run's
// own config blob, and a re-drive reads it back instead of resolving again.

import * as v from 'valibot';

import { NAMED_SWARM_PRESETS } from '../strategy/swarm-presets';
import { REASONING_EFFORTS } from '../strategy/effort';
import type { WorkMode } from '../prompting/surface';
import {
  TIER_IDS, ProfileAuthoritySchema, formatProfileValidationIssues,
  type RoleId, type TierId,
} from './catalog';
import { type TierSource, type ResolvedTurnProfile } from './resolve';

/** Why each resolved slot carries the value it does.
 *
 * `role`: the caller named a role (`explicit`) or the swarm rides the caller's
 * own active role (`caller`). `tier` and `preset` reuse the resolver's
 * vocabulary: explicit wins, then the role's default, then the built-in
 * fallback. */
export interface ProfileProvenance {
  readonly roleSource: 'explicit' | 'caller';
  readonly tierSource: TierSource;
  readonly presetSource: 'explicit' | 'role_default';
}

const ProvenanceSchema = v.strictObject({
  roleSource: v.picklist(['explicit', 'caller']),
  tierSource: v.picklist(['explicit', 'role', 'default']),
  presetSource: v.picklist(['explicit', 'role_default']),
});

/** Valibot mirror of {@link ResolvedTurnProfile} — declared explicitly rather
 *  than derived, because the whole point is a gate that keeps checking the
 *  frozen shape even if resolution later grows a field without this reader
 *  knowing. */
const TierSlotSchema = v.strictObject({
  model: v.string(),
  reasoningEffort: v.picklist(REASONING_EFFORTS),
});

const ResolvedTurnProfileSchema = v.strictObject({
  role: v.strictObject({
    id: v.string(),
    label: v.string(),
    description: v.string(),
    instructions: v.string(),
  }),
  tier: v.strictObject({
    id: v.picklist(TIER_IDS),
    source: v.picklist(['explicit', 'role', 'default']),
    model: v.string(),
    reasoningEffort: v.picklist(REASONING_EFFORTS),
  }),
  /** Every tier slot as resolved for this turn — the table the fixed-tier
   *  producers route through (model-route.ts). Written out per slot so a
   *  snapshot missing one fails here rather than at a producer. */
  tiers: v.strictObject({
    tiny: TierSlotSchema,
    fast: TierSlotSchema,
    default: TierSlotSchema,
    slow: TierSlotSchema,
    deep: TierSlotSchema,
  }),
  workMode: v.picklist(['plan', 'build']),
  skills: v.array(v.string()),
  allowedTools: v.array(v.string()),
  defaultPreset: v.picklist(NAMED_SWARM_PRESETS),
  authority: ProfileAuthoritySchema,
  catalogVersion: v.number(),
  providerRevision: v.string(),
  digest: v.string(),
});

/** One durable swarm's immutable profile record. */
export interface SwarmProfileSnapshot {
  readonly profile: ResolvedTurnProfile;
  readonly sources: ProfileProvenance;
}

const SwarmProfileSnapshotSchema: v.GenericSchema<SwarmProfileSnapshot> = v.strictObject({
  profile: ResolvedTurnProfileSchema,
  sources: ProvenanceSchema,
});

/** Gate a stored snapshot, naming the offending paths when it fails. A blob
 *  this code wrote that no longer parses means the shape moved without its
 *  reader — refuse loudly rather than resume under a half-read profile. */
export function validateSwarmProfileSnapshot<Input>(input: Input): SwarmProfileSnapshot {
  const parsed = v.safeParse(SwarmProfileSnapshotSchema, input);
  if (!parsed.success) {
    throw new Error(
      `invalid durable swarm profile snapshot: ${formatProfileValidationIssues(parsed.issues)}`,
    );
  }
  return parsed.output;
}

/** Type-level re-exports kept local so callers need one module. */
export type { ResolvedTurnProfile, RoleId, TierId, TierSource, WorkMode };
