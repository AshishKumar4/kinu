/** Durability shapes shared byte for byte across programs; instruments must import these,
 *  never copy them. */

/** `containerStart` is the first command that answered; a box with no chain skips `storeMount`/`baseAttach`. */
export type RestorePhase = 'containerStart' | StoragePhase | 'attached' | 'bootId';

export type StoragePhase = 'storeMount' | 'baseAttach';

/** Milliseconds after the restoration opened; an unreached phase is absent, never zero,
 *  so a start the platform reset still names its last phase. */
export type RestorePhaseStamps = { readonly [P in RestorePhase]?: number };
