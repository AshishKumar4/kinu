// Codec for the frozen profile a durable swarm records before detaching, so a re-drive
// runs under the profile it started with instead of today's catalog.

import * as v from 'valibot';

import { NAMED_SWARM_PRESETS } from '../strategy/swarm-presets';
import { REASONING_EFFORTS } from '../strategy/effort';
import type { WorkMode } from '../types/turn';
import { TierIdSchema,
  ProfileAuthoritySchema, formatProfileValidationIssues,
  type RoleId, type TierId,
} from './catalog';
import { type TierSource, type ResolvedTurnProfile } from './resolve';

/** Why each resolved slot carries the value it does. */
export interface ProfileProvenance {
  readonly roleSource: 'explicit' | 'caller';
  readonly tierSource: TierSource;
  readonly presetSource: 'explicit' | 'role_default';
}

const ProvenanceSchema = v.strictObject({
  roleSource: v.picklist(['explicit', 'caller']),
  tierSource: v.picklist(['explicit', 'role', 'default', 'workspace', 'actor']),
  presetSource: v.picklist(['explicit', 'role_default']),
});

/** Declared, not derived from {@link ResolvedTurnProfile}, so it keeps checking the frozen shape. */
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
    id: TierIdSchema,
    source: v.picklist(['explicit', 'role', 'default', 'workspace', 'actor']),
    model: v.string(),
    reasoningEffort: v.picklist(REASONING_EFFORTS),
  }),
  /** Per slot, so a snapshot missing one fails here rather than at a producer (model-route.ts). */
  tiers: v.strictObject({
    fast: TierSlotSchema,
    default: TierSlotSchema,
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

/** Refuse a stored snapshot that no longer parses rather than resume under a half-read profile. */
export function validateSwarmProfileSnapshot(input: { value: unknown }): SwarmProfileSnapshot {
  const parsed = v.safeParse(SwarmProfileSnapshotSchema, input.value);

  if (!parsed.success) {
    throw new Error(
      `invalid durable swarm profile snapshot: ${formatProfileValidationIssues(parsed.issues)}`,
    );
  }

  return parsed.output;
}

export type { ResolvedTurnProfile, RoleId, TierId, TierSource, WorkMode };
