/**
 * Timer ingress — registering the schedules that wake an agent, and firing the
 * ones that are due.
 *
 * A backend owns exactly two things here: the clock that calls
 * {@link fireDueTriggers} (a Durable Object alarm, a local `setTimeout`) and
 * what it does with the count that comes back. The registration rules, the
 * event a firing publishes, the cron re-arm and the one-shot revoke are the
 * agent's behaviour, not the host's.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log.js';
import type { TriggerRegistry } from '../hub/triggers.js';
import type { TriggerRow, TrustLevel } from '../hub/types.js';
import { nextCronFire } from '../hub/cron.js';
import { JsonObjectSchema, type JsonObject } from '../../utils/json.js';

export interface TimerTriggerOpts {
  cron?: string;
  atMs?: number;
  label?: string;
  payload?: JsonObject;
  trust?: 'authenticated' | 'owner';
  /** The mission budget every turn this schedule wakes spends against. */
  missionLabel?: string;
}

export interface TimerTrigger {
  id: string;
  kind: 'timer_cron' | 'timer_oneshot';
  nextFireAt: number | null;
}

/** The trigger spec a timer registration writes and a firing reads back. */
const TimerSpecSchema = v.object({
  cron: v.optional(v.string()),
  label: v.optional(v.string()),
  payload: v.optional(JsonObjectSchema),
  mission_label: v.optional(v.string()),
});
type TimerSpec = v.InferOutput<typeof TimerSpecSchema>;

/**
 * Register a timer trigger — `timer_cron` (recurring, from a cron expr) or
 * `timer_oneshot` (a single future fire at `atMs`). Shared by the agent's
 * `agent.schedule` tool and the auto-GEPA scheduler, so trigger creation has
 * one home (not inlined SQL). `trust` defaults to 'authenticated' so
 * agent-created schedules are distinguishable from operator ones.
 */
export function createTimerTrigger(
  registry: TriggerRegistry,
  opts: TimerTriggerOpts,
  now: number,
): TimerTrigger {
  const kind: 'timer_cron' | 'timer_oneshot' = opts.cron ? 'timer_cron' : 'timer_oneshot';
  const nextFireAt = opts.cron ? nextCronFire(opts.cron, now) : (opts.atMs ?? null);
  if (opts.cron && nextFireAt === null) throw new Error(`Unsupported cron expression: ${opts.cron}`);
  if (!opts.cron && nextFireAt === null) throw new Error('Timer trigger requires cron or atMs');
  const triggerSpec: JsonObject = {};
  if (opts.cron !== undefined) Object.assign(triggerSpec, { cron: opts.cron });
  if (opts.label !== undefined) Object.assign(triggerSpec, { label: opts.label });
  if (opts.payload !== undefined) Object.assign(triggerSpec, { payload: opts.payload });
  if (opts.missionLabel !== undefined) Object.assign(triggerSpec, { mission_label: opts.missionLabel });
  const id = registry.register({
    kind,
    spec: triggerSpec satisfies TimerSpec,
    creator_trust: opts.trust ?? 'authenticated',
    next_fire_at: nextFireAt ?? undefined,
  }, now);
  return { id, kind, nextFireAt };
}

/** One trigger as the operator surfaces render it — every column except the
 *  spec's secrets, which live in a store of their own. */
export interface TriggerView {
  id: string;
  kind: string;
  spec: JsonObject;
  creator_trust: TrustLevel;
  state: TriggerRow['state'];
  created_at: number;
  paused_at: number | null;
  revoked_at: number | null;
  rate_limit_per_min: number;
  next_fire_at: number | null;
  last_fire_at: number | null;
  fire_count: number;
}

export function listTriggers(registry: TriggerRegistry) {
  return {
    triggers: registry.list().map((t) => ({
      id: t.id,
      kind: t.kind,
      spec: t.spec,
      creator_trust: t.creator_trust,
      state: t.state,
      created_at: t.created_at,
      paused_at: t.paused_at,
      revoked_at: t.revoked_at,
      rate_limit_per_min: t.rate_limit_per_min,
      next_fire_at: t.next_fire_at,
      last_fire_at: t.last_fire_at,
      fire_count: t.fire_count,
    })),
  };
}

/** Cancel a trigger (revoke). Idempotent. */
export function cancelTrigger(
  registry: TriggerRegistry, trigger_id: string, now: number,
) {
  return { ok: true, changed: registry.revoke(trigger_id, now) };
}

export interface TimerFireDeps {
  registry: TriggerRegistry;
  log: EventLog;
}

/**
 * Publish a Timer event for every due schedule, re-arm cron, revoke one-shot.
 * Returns how many fired, which is what tells the caller whether to drain.
 *
 * Crash-safe: hub dedupe on `(trigger_id, scheduled_fire_at)` makes a re-fire
 * after eviction a no-op publish.
 */
export function fireDueTriggers(deps: TimerFireDeps, now: number) {
  let fired = 0;
  for (const trigger of deps.registry.due(now)) {
    // Only timers produce timer events. No other kind carries a next_fire_at
    // today, and one that did must not be published as an alarm.
    if (trigger.kind !== 'timer_cron' && trigger.kind !== 'timer_oneshot') continue;
    fired += 1;
    const spec = v.parse(TimerSpecSchema, trigger.spec);

    deps.log.publish({
      descriptor: {
        ingress: 'timer_alarm',
        variant: 'timer',
        payload: {
          trigger_id: trigger.id,
          scheduled_fire_at: trigger.next_fire_at ?? now,
          label: spec.label,
          user_payload: spec.payload,
          mission_label: spec.mission_label,
        },
        trigger_creator_trust: trigger.creator_trust,
      },
      now,
    });

    if (trigger.kind === 'timer_cron') {
      deps.registry.markFired(trigger.id, now, spec.cron ? nextCronFire(spec.cron, now) : null);
    } else {
      deps.registry.markFired(trigger.id, now, null);
      deps.registry.revoke(trigger.id, now);
    }
  }
  return { fired };
}
