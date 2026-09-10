import * as v from 'valibot';

// ── The axes of a turn ──────────────────────────────────────────────────────
// These are independent facts, and forcing them through one variable is what
// made two of them unreachable. A background-job wake IS a resume AND it IS
// build work; a Plan turn woken by a timer is BOTH. So:
//
//   WorkMode      — what the turn may do. 'plan' is read-only and structural;
//                   'build' is the absence of constraint, shown as "Auto".
//   TurnProvenance— why the turn is running. Adds an overlay, never a bar.
//   Role          — the resolved profile's one prompt section (prompt.ts).

export type WorkMode = 'plan' | 'build';

/**
 * Why this turn is running. Orthogonal to WorkMode.
 *
 * Two values, because two are all that exist. `cron` and `release` were here
 * and neither had a producer: a timer fire is published as an EVENT
 * (`ingress: 'timer_alarm'`, events/ingress/triggers.ts) and reaches the agent
 * through the reactor drain as `kinuEvent: 'event_drain'`, never under a
 * timer- or cron-named event; and nothing anywhere stamps a release mode. The
 * guidance written for both of them had therefore never reached a model.
 */
export type TurnProvenance = 'chat' | 'background_resume';

const WorkModeSchema = v.picklist(['plan', 'build']);

export function isWorkMode<Value>(value: Value): value is Value & WorkMode {
  return v.is(WorkModeSchema, value);
}
