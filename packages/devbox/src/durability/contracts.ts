/** Durability shapes shared byte for byte across programs; instruments must import these,
 *  never copy them. */

import * as v from 'valibot';

const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** Work one restore did, in the dimensions a readiness claim is checked against.
 *  `serialRemoteOps` counts the remote operations that were unavoidably serial. */
export const RestoreWorkSchema = v.strictObject({
  serialRemoteOps: CountSchema,
  totalRemoteOps: CountSchema,
  metadataBytes: CountSchema,
  payloadBytes: CountSchema,
  cpuSteps: CountSchema,
  mounts: CountSchema,
  replayUnits: CountSchema,
});

export type RestoreWork = v.InferOutput<typeof RestoreWorkSchema>;

export const PublishWorkSchema = v.strictObject({
  objectsPut: CountSchema,
  bytesPut: CountSchema,
  casAttempts: CountSchema,
});

/** `containerStart` is the first command that answered: the RPC server comes up after admission.
 *  `storeMount`/`baseAttach` are stamped by the storage strategy; a box with no chain skips them. */
export type RestorePhase = 'containerStart' | StoragePhase | 'attached' | 'bootId';

export type StoragePhase = 'storeMount' | 'baseAttach';

/** Milliseconds after the restoration opened; an unreached phase is absent, never zero,
 *  so a start the platform reset still names its last phase. */
export type RestorePhaseStamps = { readonly [P in RestorePhase]?: number };

export const RestorePhaseStampsSchema: v.GenericSchema<RestorePhaseStamps> = v.object({
  containerStart: v.optional(CountSchema),
  storeMount: v.optional(CountSchema),
  baseAttach: v.optional(CountSchema),
  attached: v.optional(CountSchema),
  bootId: v.optional(CountSchema),
});
