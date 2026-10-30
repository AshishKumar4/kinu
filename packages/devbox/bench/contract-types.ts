import * as v from 'valibot';

export const CONTAINER_CONTRACTS = ['tools', 'exec', 'processes', 'kill', 'trust'] as const;

export type ContainerContract = typeof CONTAINER_CONTRACTS[number];

export const DISK_CONTRACTS = ['blocks', 'levels', 'compact', 'baseline', 'streaming', 'parallel-mounts', 'low-disk', 'lost-inventory', 'quiesce-tick', 'set-aside'] as const;

export type DiskContract = typeof DISK_CONTRACTS[number];

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** One phase of A2's acceptance (recovery-acceptance.ts) and the workspace it makes: here, with no Workers type, for the
 *  tier that asks for it. */
export const RecoveryAcceptanceSchema = v.object({
  phase: v.picklist(['fill', 'saves', 'seal', 'recover']),
  smallFiles: v.optional(Count, 12_000),
  bigFiles: v.optional(Count, 512),
  /** At least the 1 MiB a delta starts sending a file as its changed blocks at (disk-delta.ts `BIG`). */
  bigBytes: v.optional(v.pipe(Count, v.minValue(1_048_576)), 2_097_152),
  bigPerSave: v.optional(Count, 4),
  from: v.optional(Count, 1),
  count: v.optional(Count, 16),
});

export type RecoveryAcceptance = v.InferOutput<typeof RecoveryAcceptanceSchema>;
