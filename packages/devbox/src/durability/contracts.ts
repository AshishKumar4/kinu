/** Durability shapes shared byte for byte across programs; instruments must import these,
 *  never copy them. */

import * as v from 'valibot';

const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));


/** `containerStart` is the first command that answered; a box with no chain skips `storeMount`/`baseAttach`. */
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
