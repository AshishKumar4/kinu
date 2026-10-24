/** The restore's phases, shared by the box and the bench that reads its stamps. */

/** `containerStart` is the first command that answered. */
export type RestorePhase = 'containerStart' | 'attached' | 'bootId' | 'tools';

/** Milliseconds after the restoration opened; an unreached phase is absent, never zero,
 *  so a start the platform reset still names its last phase. */
export type RestorePhaseStamps = { readonly [P in RestorePhase]?: number };
