// Codec for the frozen profile a durable swarm records before detaching, so a re-drive
// runs under the profile it started with instead of today's catalog.

import * as v from 'valibot';
import { DECISION_MODELS } from '../providers/decision-model';

import { NAMED_SWARM_PRESETS } from '../types/swarm';
import { REASONING_EFFORTS } from '../providers/effort';
import type { WorkMode } from '../types/turn';
import { TierIdSchema,
  ProfileAuthoritySchema, parseProfileValue,
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

const LevelSchema = v.nullable(v.picklist(REASONING_EFFORTS));

const FallbacksSchema = v.array(v.strictObject({ model: v.string(), reasoningEffort: LevelSchema }));

/** Declared, not derived from {@link ResolvedTurnProfile}, so it keeps checking the frozen shape. */
const TierSlotSchema = v.strictObject({
  model: v.string(),
  reasoningEffort: LevelSchema,
  fallbacks: FallbacksSchema,
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
    reasoningEffort: LevelSchema,
    fallbacks: FallbacksSchema,
    replaced: v.nullable(v.string()),
  }),
  /** Per slot, so a snapshot missing one fails here rather than at a producer (model-route.ts). */
  tiers: v.strictObject({
    fast: TierSlotSchema,
    default: TierSlotSchema,
    deep: TierSlotSchema,
  }),
  retries: v.number(),
  decisionModel: v.picklist(DECISION_MODELS),
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

const SwarmProfileSnapshotSchema: v.GenericSchema<unknown, SwarmProfileSnapshot> = v.strictObject({
  profile: ResolvedTurnProfileSchema,
  sources: ProvenanceSchema,
});

/** A stored snapshot that no longer parses is refused, never resumed half-read. */
export function validateSwarmProfileSnapshot(input: { value: unknown }): SwarmProfileSnapshot {
  return parseProfileValue(SwarmProfileSnapshotSchema, 'durable swarm profile snapshot', input);
}

export type { ResolvedTurnProfile, RoleId, TierId, TierSource, WorkMode };
