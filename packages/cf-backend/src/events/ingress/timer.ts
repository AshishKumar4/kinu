/**
 * Timer ingress — DO alarm() fires → publish Timer events for every due
 * trigger.
 *
 * The OrchestratorAgent's `alarm()` handler calls `handleAlarm(...)`. The
 * function:
 *
 *   1. Reads `triggers.due(now)` to find scheduled triggers due to fire
 *   2. For each: publishes a Timer event via EventLog
 *   3. For cron triggers: schedules the next firing
 *   4. For one-shot triggers: revokes after firing
 *   5. Reschedules the DO alarm for the next-soonest pending trigger
 *
 * Crash-safety: if the DO crashes between `due()` and `markFired()`, the
 * same trigger re-fires (dedupe via `(trigger_id, scheduled_fire_at)`
 * makes this idempotent — the second publish is a no-op).
 */

import {
  type EventLog, type TriggerRegistry, type TriggerRow,
  type TimerPayload,
} from '@proteus/core';

export interface TimerIngressDeps {
  log: EventLog;
  triggers: TriggerRegistry;
}

export interface TimerIngressOutcome {
  fired: number;
  next_alarm_at: number | null;
}

export async function handleAlarm(
  deps: TimerIngressDeps,
  now: number,
  parseCron: (cron: string, after: number) => number | null,
): Promise<TimerIngressOutcome> {
  const due = deps.triggers.due(now);
  let fired = 0;

  for (const trigger of due) {
    const scheduled_fire_at = (trigger as TriggerRow & { next_fire_at?: number }).next_fire_at ?? now;
    const spec = trigger.spec as { label?: string; payload?: unknown; cron?: string };

    const payload: TimerPayload = {
      trigger_id: trigger.id,
      scheduled_fire_at,
      label: spec.label,
      user_payload: spec.payload,
    };

    deps.log.publish({
      descriptor: {
        ingress: 'timer_alarm',
        variant: 'timer',
        payload,
        trigger_creator_trust: trigger.creator_trust,
      },
      now,
    });

    // Reschedule cron or revoke one-shot.
    if (trigger.kind === 'timer_cron') {
      const next = spec.cron ? parseCron(spec.cron, now) : null;
      deps.triggers.markFired(trigger.id, now, next);
    } else {
      // timer_oneshot
      deps.triggers.markFired(trigger.id, now, null);
      deps.triggers.revoke(trigger.id, now);
    }

    fired++;
  }

  // Find the next-soonest pending alarm for re-scheduling.
  const nextRow = deps.triggers.list({ state: 'active' })
    .map(t => (t as TriggerRow & { next_fire_at?: number }).next_fire_at ?? null)
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b)[0] ?? null;

  return { fired, next_alarm_at: nextRow };
}
