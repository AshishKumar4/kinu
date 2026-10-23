/** Timer ingress. The host supplies only the clock that calls {@link fireDueTriggers}. */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { TriggerRegistry } from '../hub/triggers';
import type { TriggerRow, TrustLevel } from '../hub/types';
import { knownTimeZone, nextCronFire } from '../hub/cron';
import type { WebhookSecretStore } from './secrets';
import { JsonObjectSchema, type JsonObject } from '../../utils/json';
import { Effect } from 'effect';
import { KinuError, settleSync } from '../../obs/index';
import { checkWatcher, watchCheckOf, WatchCheckSchema, type WatchCheck, type WatchDeps } from './watch';

export interface TimerTriggerOpts {
  cron?: string;
  /** The IANA zone whose wall clock `cron` names; absent, UTC. */
  timeZone?: string;
  atMs?: number;
  label?: string;
  payload?: JsonObject;
  trust?: 'authenticated' | 'owner';
  missionLabel?: string;
  /** Makes it a watcher: the check runs at each firing, and only what it found wakes the agent (watch.ts). */
  check?: WatchCheck;
}

export interface TimerTrigger {
  id: string;
  kind: 'timer_cron' | 'timer_oneshot';
  nextFireAt: number | null;
}

const TimerSpecSchema = v.object({
  cron: v.optional(v.string()),
  time_zone: v.optional(v.string()),
  label: v.optional(v.string()),
  payload: v.optional(JsonObjectSchema),
  mission_label: v.optional(v.string()),
});

type TimerSpec = v.InferOutput<typeof TimerSpecSchema>;

/** `trust` defaults to 'authenticated' so agent-created schedules differ from operator ones. */
export async function createTimerTrigger(
  registry: TriggerRegistry,
  opts: TimerTriggerOpts,
  now: number,
): Promise<TimerTrigger> {
  const kind: 'timer_cron' | 'timer_oneshot' = opts.cron ? 'timer_cron' : 'timer_oneshot';
  const nextFireAt = opts.cron ? nextCronFire(opts.cron, now, opts.timeZone) : (opts.atMs ?? null);

  if (opts.timeZone !== undefined && !knownTimeZone(opts.timeZone)) return settleSync(Effect.fail(new KinuError('bad_input', `Unknown time zone: ${opts.timeZone}`)));

  if (opts.cron && nextFireAt === null) return settleSync(Effect.fail(new KinuError('bad_input', `Unsupported cron expression: ${opts.cron}`)));

  if (!opts.cron && nextFireAt === null) return settleSync(Effect.fail(new KinuError('bad_input', 'Timer trigger requires cron or atMs')));
  const triggerSpec: JsonObject = {};

  if (opts.cron !== undefined) Object.assign(triggerSpec, { cron: opts.cron });

  if (opts.timeZone !== undefined) Object.assign(triggerSpec, { time_zone: opts.timeZone });

  if (opts.label !== undefined) Object.assign(triggerSpec, { label: opts.label });

  if (opts.payload !== undefined) Object.assign(triggerSpec, { payload: opts.payload });

  if (opts.missionLabel !== undefined) Object.assign(triggerSpec, { mission_label: opts.missionLabel });

  if (opts.check !== undefined) Object.assign(triggerSpec, { check: v.parse(WatchCheckSchema, opts.check) });

  const id = await registry.register({
    kind,
    spec: triggerSpec satisfies TimerSpec,
    creator_trust: opts.trust ?? 'authenticated',
    next_fire_at: nextFireAt ?? undefined,
  }, now);

  return { id, kind, nextFireAt };
}

/** Secrets live in a separate store and never appear here. */
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

export interface CancelTriggerResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly error?: string;
}

export interface CancelTriggerRequest {
  readonly registry: TriggerRegistry;
  readonly trigger_id: string;
  readonly now: number;
  readonly caller: TrustLevel;
  readonly secrets?: Pick<WebhookSecretStore, 'deleteByTrigger'>;
}

/**
 * Owner-created triggers are revocable only by the owner: webhook trigger ids are model-visible.
 * Not a `TRUST_ORDER` comparison, which ranks `self` above `owner`. Secrets are deleted in the same
 * host call; the trigger row is kept as audit.
 */
export function cancelTrigger(request: CancelTriggerRequest): CancelTriggerResult {
  const { registry, trigger_id, now, caller, secrets } = request;
  const trigger = registry.get(trigger_id);

  if (trigger && trigger.creator_trust === 'owner' && caller !== 'owner') {
    return {
      ok: false,
      changed: false,
      error: 'this trigger was created by the owner; only the owner can revoke it',
    };
  }

  const changed = registry.revoke(trigger_id, now);

  if (changed) secrets?.deleteByTrigger(trigger_id);

  return { ok: true, changed };
}

/** A daily schedule's cron, `M H * * *`: the one shape whose time of day the owner may move. */
const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u;

/** `HH:MM`, 24-hour. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** The time of day a daily schedule fires, `HH:MM`; null for any other cron. */
export function dailyTimeOf(cron: string): string | null {
  const [, minutes, hours] = DAILY_CRON.exec(cron.trim()) ?? [];

  return minutes === undefined || hours === undefined ? null : `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

export interface RetimeTriggerRequest {
  readonly registry: TriggerRegistry;
  readonly trigger_id: string;
  /** `HH:MM`, in the schedule's own time zone. */
  readonly at: string;
  readonly now: number;
}

/**
 * A daily schedule moved to `at`, in the time zone it already keeps; its next firing is the next `at` from now. Only a
 * live daily schedule moves: any other trigger, or a time that is not `HH:MM`, is refused. The owner's call alone (the
 * host gives it no model surface).
 */
export async function retimeDailyTrigger(request: RetimeTriggerRequest): Promise<{ readonly at: string; readonly nextFireAt: number }> {
  const { registry, trigger_id, at, now } = request;
  const trigger = registry.get(trigger_id);
  const clock = CLOCK.exec(at);

  if (clock === null) return settleSync(Effect.fail(new KinuError('bad_input', `A time of day is HH:MM, not ${at}`)));
  const spec = trigger === null || trigger.kind !== 'timer_cron' || trigger.state === 'revoked' ? null : v.parse(TimerSpecSchema, trigger.spec);

  if (trigger === null || spec === null || spec.cron === undefined || dailyTimeOf(spec.cron) === null) {
    return settleSync(Effect.fail(new KinuError('missing', 'No daily schedule with that id')));
  }

  const cron = `${String(Number(clock[2]))} ${String(Number(clock[1]))} * * *`;
  const nextFireAt = nextCronFire(cron, now, spec.time_zone);

  if (nextFireAt === null) return settleSync(Effect.fail(new KinuError('bad_input', `Unsupported cron expression: ${cron}`)));
  await registry.retime(trigger.id, { ...trigger.spec, cron }, nextFireAt);

  return { at, nextFireAt };
}

export interface TimerFireDeps {
  registry: TriggerRegistry;
  log: EventLog;
  /** Where a watcher's check runs; absent, a watcher fires as a schedule does. */
  watch?: Pick<WatchDeps, 'run' | 'claims'>;
}

/**
 * Re-fire after eviction is a no-op publish via dedupe on `(trigger_id, scheduled_fire_at)`. A watcher's firing is moved
 * on before its check runs, and its check publishes only what it found: a reset during the check loses that firing,
 * never the change, which its cursor still leads to.
 */
export async function fireDueTriggers(deps: TimerFireDeps, now: number) {
  let fired = 0;
  const checks: Promise<void>[] = [];

  for (const trigger of deps.registry.due(now)) {
    if (trigger.kind !== 'timer_cron' && trigger.kind !== 'timer_oneshot') continue;
    fired += 1;
    const spec = v.parse(TimerSpecSchema, trigger.spec);
    const scheduledAt = trigger.next_fire_at ?? now;

    if (deps.watch !== undefined && watchCheckOf(trigger) !== null) {
      await deps.registry.markFired(trigger.id, now, spec.cron === undefined ? null : nextCronFire(spec.cron, now, spec.time_zone));
      checks.push(checkWatcher({ registry: deps.registry, log: deps.log, ...deps.watch }, trigger.id, { at: scheduledAt }, Date.now));
      continue;
    }

    deps.log.publish({
      descriptor: {
        ingress: 'timer_alarm',
        variant: 'timer',
        payload: {
          trigger_id: trigger.id,
          scheduled_fire_at: scheduledAt,
          label: spec.label,
          user_payload: spec.payload,
          mission_label: spec.mission_label,
        },
        trigger_creator_trust: trigger.creator_trust,
      },
      now,
    });

    if (trigger.kind === 'timer_cron') {
      await deps.registry.markFired(trigger.id, now, spec.cron ? nextCronFire(spec.cron, now, spec.time_zone) : null);
    } else {
      await deps.registry.markFired(trigger.id, now, null);
      deps.registry.revoke(trigger.id, now);
    }
  }

  await Promise.all(checks);

  return { fired };
}
