import * as v from 'valibot';

// 'plan' is read-only and structural; 'build' is the absence of constraint, shown as "Auto".
export type WorkMode = 'plan' | 'build';

/** Why the turn runs, orthogonal to WorkMode: a message, or a background job's wake naming the job. Timer fires
 *  arrive as `event_drain` events. */
export type TurnReason =
  | { readonly provenance: 'chat' }
  | { readonly provenance: 'background_resume'; readonly job: string | null }
  /** Any other `kinuEvent`, as a run's `causedBy` names it. */
  | { readonly provenance: 'signal'; readonly event: string };

export const TurnReasonSchema: v.GenericSchema<TurnReason> = v.variant('provenance', [
  v.object({ provenance: v.literal('chat') }),
  v.object({ provenance: v.literal('background_resume'), job: v.nullable(v.string()) }),
  v.object({ provenance: v.literal('signal'), event: v.string() }),
]);

export const WorkModeSchema: v.GenericSchema<WorkMode> = v.picklist(['plan', 'build']);

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}

/** Whom a turn answers: the owner's turn runs in the owner's lane; the hirer's in the hirer's, and may `report`. Set by
 *  the path that admitted it (`orchestrator/turn-authorship.ts`). */
export type TurnAuthorship = 'owner' | 'hirer';
