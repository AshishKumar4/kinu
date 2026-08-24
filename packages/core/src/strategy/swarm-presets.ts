/** Closed swarm preset vocabulary. Kept independent of the search engine so
 * profile schemas and prompt surfaces do not import engine policy. */
export const SWARM_PRESETS = [
  'ideate',
  'research',
  'audit',
  'redteam',
  'optimise',
  'prove',
  'custom',
] as const;

export type SwarmPreset = (typeof SWARM_PRESETS)[number];

export const NAMED_SWARM_PRESETS = SWARM_PRESETS.filter(
  (preset): preset is Exclude<SwarmPreset, 'custom'> => preset !== 'custom',
);

export type NamedSwarmPreset = (typeof NAMED_SWARM_PRESETS)[number];
