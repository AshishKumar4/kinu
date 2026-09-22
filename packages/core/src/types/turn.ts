import * as v from 'valibot';

// 'plan' is read-only and structural; 'build' is the absence of constraint, shown as "Auto".
export type WorkMode = 'plan' | 'build';

/** Why the turn runs; orthogonal to WorkMode. Timer fires arrive as `event_drain` events. */
export type TurnProvenance = 'chat' | 'background_resume';

export const WorkModeSchema: v.GenericSchema<WorkMode> = v.picklist(['plan', 'build']);

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}
