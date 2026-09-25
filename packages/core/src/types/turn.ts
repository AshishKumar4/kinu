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

export const WorkModeSchema: v.GenericSchema<WorkMode> = v.picklist(['plan', 'build']);

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}
