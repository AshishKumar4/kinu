/** Timer ingress. The host supplies only the clock that calls {@link fireDueTriggers}. */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { TriggerRegistry } from '../hub/triggers';
import type { TriggerRow, TrustLevel } from '../hub/types';
import { nextCronFire } from '../hub/cron';
import type { WebhookSecretStore } from './secrets';
import { JsonObjectSchema, type JsonObject } from '../../utils/json';

export interface TimerTriggerOpts {
  cron?: string;
  atMs?: number;
  label?: string;
  payload?: JsonObject;
  trust?: 'authenticated' | 'owner';
  missionLabel?: string;
}

export interface TimerTrigger {
  id: string;
  kind: 'timer_cron' | 'timer_oneshot';
  nextFireAt: number | null;
}

const TimerSpecSchema = v.object({
  cron: v.optional(v.string()),
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
  const nextFireAt = opts.cron ? nextCronFire(opts.cron, now) : (opts.atMs ?? null);

  if (opts.cron && nextFireAt === null) throw new Error(`Unsupported cron expression: ${opts.cron}`);

  if (!opts.cron && nextFireAt === null) throw new Error('Timer trigger requires cron or atMs');
  const triggerSpec: JsonObject = {};

  if (opts.cron !== undefined) Object.assign(triggerSpec, { cron: opts.cron });

  if (opts.label !== undefined) Object.assign(triggerSpec, { label: opts.label });

  if (opts.payload !== undefined) Object.assign(triggerSpec, { payload: opts.payload });

  if (opts.missionLabel !== undefined) Object.assign(triggerSpec, { mission_label: opts.missionLabel });

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

export interface TimerFireDeps {
  registry: TriggerRegistry;
  log: EventLog;
}

/** Re-fire after eviction is a no-op publish via dedupe on `(trigger_id, scheduled_fire_at)`. */
export async function fireDueTriggers(deps: TimerFireDeps, now: number) {
  let fired = 0;

  for (const trigger of deps.registry.due(now)) {
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
      await deps.registry.markFired(trigger.id, now, spec.cron ? nextCronFire(spec.cron, now) : null);
    } else {
      await deps.registry.markFired(trigger.id, now, null);
      deps.registry.revoke(trigger.id, now);
    }
  }

  return { fired };
}
