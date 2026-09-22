/** TriggerRegistry over real in-memory SQLite, so the DDL CHECK constraints are live. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActorsOver, present } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  DEFAULT_FORK_POLICY, TriggerRegistry, initEventsHubTables,
  type AlarmScheduler, type RegisterSpec, type TriggerKind,
} from '../src/events/hub/index';
import {
  EventLog, JsonObjectSchema, cancelTrigger, createTimerTrigger, fireDueTriggers, listTriggers,
  type KinuEvent, type TimerPayload,
} from '../src/index';
import { makeSqlExec } from './helpers';

/** Records wake requests and converges on the soonest pending time, as the real scheduler does. */
class RecordingAlarm implements AlarmScheduler {
  readonly requested: number[] = [];
  private at: number | null = null;

  async scheduleAt(ts: number): Promise<void> {
    this.requested.push(ts);

    if (this.at === null || ts < this.at) this.at = ts;
  }
}

const NOW = 1_700_000_000_000;

const TRIGGER_KINDS: TriggerKind[] = [
  'webhook_durable', 'webhook_ephemeral', 'timer_oneshot', 'timer_cron',
  'process_watch', 'file_watch', 'peer_inbox', 'mcp_route', 'email_route',
];

function timerPayload(event: KinuEvent): TimerPayload {
  if (event.variant !== 'timer') throw new Error('expected timer event');

  return v.parse(v.object({
    trigger_id: v.string(),
    scheduled_fire_at: v.number(),
    label: v.optional(v.string()),
    user_payload: v.optional(JsonObjectSchema),
    mission_label: v.optional(v.string()),
  }), event.payload);
}

function setup() {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);
  initEventsHubTables(sql);
  const alarm = new RecordingAlarm();
  // `pauseAll` means everything this actor registered, so the registry needs a real owner.
  const actor = createTestActorsOver(db).main;

  return { registry: new TriggerRegistry(sql, actor, alarm), alarm, actor };
}

function spec(patch: Partial<RegisterSpec> = {}): RegisterSpec {
  return { kind: 'timer_cron', spec: { cron: '0 * * * *' }, creator_trust: 'owner', ...patch };
}

describe('TriggerRegistry.register', () => {
  test('persists the trigger and returns a retrievable id', async () => {
    const { registry } = setup();
    const id = await registry.register(spec({ spec: { cron: '*/5 * * * *' } }), NOW);

    const row = present(registry.get(id), 'registered trigger');
    expect(row.id).toBe(id);
    expect(row.kind).toBe('timer_cron');
    expect(row.state).toBe('active');
    expect(row.created_at).toBe(NOW);
    expect(row.fire_count).toBe(0);
    expect(row.paused_at).toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  test('round-trips the spec through JSON rather than stringifying it into the row', async () => {
    const { registry } = setup();
    const id = await registry.register(spec({ spec: { cron: '0 9 * * *', tz: 'UTC', nested: { a: [1, 2] } } }), NOW);
    expect(present(registry.get(id), 'registered trigger').spec).toEqual({ cron: '0 9 * * *', tz: 'UTC', nested: { a: [1, 2] } });
  });

  test('rate limit defaults to 60/min and an explicit one is honoured', async () => {
    const { registry } = setup();
    expect(present(registry.get(await registry.register(spec(), NOW)), 'registered trigger').rate_limit_per_min).toBe(60);
    expect(present(registry.get(await registry.register(spec({ rate_limit_per_min: 5 }), NOW)), 'registered trigger').rate_limit_per_min).toBe(5);
  });

  test('an explicit rate limit of 0 is preserved, not defaulted away', async () => {
    // `?? 60` must not degrade into `|| 60`: 0 means "block", not "unset".
    const { registry } = setup();
    expect(present(registry.get(await registry.register(spec({ rate_limit_per_min: 0 }), NOW)), 'registered trigger').rate_limit_per_min).toBe(0);
  });

  test('fork_policy is null unless overridden — the per-kind default is applied at fork time', async () => {
    const { registry } = setup();
    expect(present(registry.get(await registry.register(spec(), NOW)), 'registered trigger').fork_policy).toBeNull();
    expect(present(registry.get(await registry.register(spec({ fork_policy: 'share' }), NOW)), 'registered trigger').fork_policy).toBe('share');
  });

  test('schedules an alarm only when the trigger has a fire time', async () => {
    const { registry, alarm } = setup();
    await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    expect(alarm.requested).toEqual([]);

    await registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    expect(alarm.requested).toEqual([NOW + 60_000]);
  });

  test('ids are unique across registrations', async () => {
    const { registry } = setup();
    const ids = new Set(await Promise.all(Array.from({ length: 25 }, () => registry.register(spec(), NOW))));
    expect(ids.size).toBe(25);
  });
});

describe('TriggerRegistry.get / list', () => {
  test('get returns null for an unknown id', () => {
    const { registry } = setup();
    expect(registry.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  test('list filters by kind and by state independently and together', async () => {
    const { registry } = setup();
    const cron = await registry.register(spec({ kind: 'timer_cron' }), NOW);
    const inbox = await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    registry.pause(inbox, NOW + 1);

    expect(registry.list().map(t => t.id).sort()).toEqual([cron, inbox].sort());
    expect(registry.list({ kind: 'peer_inbox' }).map(t => t.id)).toEqual([inbox]);
    expect(registry.list({ state: 'active' }).map(t => t.id)).toEqual([cron]);
    expect(registry.list({ kind: 'peer_inbox', state: 'active' })).toEqual([]);
    expect(registry.list({ kind: 'peer_inbox', state: 'paused' }).map(t => t.id)).toEqual([inbox]);
  });

  test('list returns newest first', async () => {
    const { registry } = setup();
    const first = await registry.register(spec(), NOW);
    const second = await registry.register(spec(), NOW + 1000);
    const third = await registry.register(spec(), NOW + 2000);
    expect(registry.list().map(t => t.id)).toEqual([third, second, first]);
  });
});

describe('TriggerRegistry pause / resume', () => {
  test('pause moves an active trigger to paused and stamps the time', async () => {
    const { registry } = setup();
    const id = await registry.register(spec(), NOW);

    expect(registry.pause(id, NOW + 5)).toBe(true);
    const row = present(registry.get(id), 'registered trigger');
    expect(row.state).toBe('paused');
    expect(row.paused_at).toBe(NOW + 5);
  });

  test('pause reports false when it changed nothing', async () => {
    const { registry } = setup();
    const id = await registry.register(spec(), NOW);
    registry.pause(id, NOW);

    expect(registry.pause(id, NOW + 1)).toBe(false);
    expect(registry.pause('nope', NOW)).toBe(false);
    expect(present(registry.get(id), 'registered trigger').paused_at).toBe(NOW);
  });

  test('a revoked trigger cannot be paused', async () => {
    const { registry } = setup();
    const id = await registry.register(spec(), NOW);
    registry.revoke(id, NOW);
    expect(registry.pause(id, NOW + 1)).toBe(false);
  });

  test('resume clears paused_at and re-arms a future fire time', async () => {
    const { registry, alarm } = setup();
    const id = await registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    registry.pause(id, NOW + 1);
    alarm.requested.length = 0;

    expect(await registry.resume(id, NOW + 2)).toBe(true);
    const row = present(registry.get(id), 'registered trigger');
    expect(row.state).toBe('active');
    expect(row.paused_at).toBeNull();
    expect(alarm.requested).toEqual([NOW + 60_000]);
  });

  test('resume does NOT backfill a fire time that elapsed while paused', async () => {
    // Re-arming on a past time would fire the trigger immediately on unarchive.
    const { registry, alarm } = setup();
    const id = await registry.register(spec({ next_fire_at: NOW + 10 }), NOW);
    registry.pause(id, NOW + 20);
    alarm.requested.length = 0;

    expect(await registry.resume(id, NOW + 999)).toBe(true);
    expect(alarm.requested).toEqual([]);
  });

  test('resume reports false for an active, revoked, or unknown trigger', async () => {
    const { registry } = setup();
    const active = await registry.register(spec(), NOW);
    const revoked = await registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(await registry.resume(active, NOW)).toBe(false);
    expect(await registry.resume(revoked, NOW)).toBe(false);
    expect(await registry.resume('nope', NOW)).toBe(false);
  });
});

describe('TriggerRegistry pauseAll / resumeAll', () => {
  test('pauseAll pauses only active triggers and returns how many it moved', async () => {
    const { registry } = setup();
    const a = await registry.register(spec(), NOW);
    const b = await registry.register(spec(), NOW);
    const revoked = await registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(registry.pauseAll(NOW + 1)).toBe(2);
    expect(present(registry.get(a), 'registered trigger').state).toBe('paused');
    expect(present(registry.get(b), 'registered trigger').state).toBe('paused');
    expect(present(registry.get(revoked), 'registered trigger').state).toBe('revoked');
    expect(registry.pauseAll(NOW + 2)).toBe(0);
  });

  test('resumeAll re-arms the SOONEST pending fire time, once', async () => {
    const { registry, alarm } = setup();
    await registry.register(spec({ next_fire_at: NOW + 90_000 }), NOW);
    await registry.register(spec({ next_fire_at: NOW + 30_000 }), NOW);
    await registry.register(spec({ next_fire_at: NOW - 5 }), NOW);
    await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    registry.pauseAll(NOW + 1);
    alarm.requested.length = 0;

    expect(await registry.resumeAll(NOW + 2)).toBe(4);
    expect(alarm.requested).toEqual([NOW + 30_000]);
  });

  test('resumeAll with nothing pending asks for no alarm', async () => {
    const { registry, alarm } = setup();
    await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    registry.pauseAll(NOW);
    alarm.requested.length = 0;

    expect(await registry.resumeAll(NOW + 1)).toBe(1);
    expect(alarm.requested).toEqual([]);
  });

  test('resumeAll does not revive revoked triggers', async () => {
    const { registry } = setup();
    const revoked = await registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(await registry.resumeAll(NOW + 1)).toBe(0);
    expect(present(registry.get(revoked), 'registered trigger').state).toBe('revoked');
  });
});

describe('TriggerRegistry revoke / revokeAll', () => {
  test('revoke stamps the time and clears the fire schedule', async () => {
    const { registry } = setup();
    const id = await registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);

    expect(registry.revoke(id, NOW + 5)).toBe(true);
    const row = present(registry.get(id), 'registered trigger');
    expect(row.state).toBe('revoked');
    expect(row.revoked_at).toBe(NOW + 5);
    expect(row.next_fire_at).toBeNull();
  });

  test('revoke works from paused, and is idempotent afterwards', async () => {
    const { registry } = setup();
    const id = await registry.register(spec(), NOW);
    registry.pause(id, NOW);

    expect(registry.revoke(id, NOW + 1)).toBe(true);
    expect(registry.revoke(id, NOW + 2)).toBe(false);
    expect(present(registry.get(id), 'registered trigger').revoked_at).toBe(NOW + 1);
  });

  test('revoke reports false for an unknown id', () => {
    const { registry } = setup();
    expect(registry.revoke('nope', NOW)).toBe(false);
  });

  test('revokeAll counts everything not already revoked, and is idempotent', async () => {
    const { registry } = setup();
    await registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    const paused = await registry.register(spec(), NOW);
    registry.pause(paused, NOW);
    const already = await registry.register(spec(), NOW);
    registry.revoke(already, NOW);

    expect(registry.revokeAll(NOW + 1)).toBe(2);
    expect(registry.list().every(t => t.state === 'revoked')).toBe(true);
    expect(registry.list().every(t => t.next_fire_at === null)).toBe(true);
    expect(registry.revokeAll(NOW + 2)).toBe(0);
  });
});

describe('TriggerRegistry alarm wakeup path', () => {
  test('due returns triggers at or before now, and nothing scheduled later', async () => {
    const { registry } = setup();
    const past = await registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    const exactly = await registry.register(spec({ next_fire_at: NOW }), NOW);
    await registry.register(spec({ next_fire_at: NOW + 1 }), NOW);

    expect(registry.due(NOW).map(t => t.id).sort()).toEqual([past, exactly].sort());
  });

  test('due ignores triggers with no fire time', async () => {
    const { registry } = setup();
    await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    expect(registry.due(NOW + 10_000)).toEqual([]);
  });

  test('due ignores paused and revoked triggers even when their time has come', async () => {
    const { registry } = setup();
    const paused = await registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    const revoked = await registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    registry.pause(paused, NOW);
    registry.revoke(revoked, NOW);

    expect(registry.due(NOW)).toEqual([]);
  });

  test('markFired advances the counter and re-arms a recurring trigger', async () => {
    const { registry, alarm } = setup();
    const id = await registry.register(spec({ next_fire_at: NOW }), NOW);
    alarm.requested.length = 0;

    await registry.markFired(id, NOW, NOW + 3_600_000);

    const row = present(registry.get(id), 'registered trigger');
    expect(row.fire_count).toBe(1);
    expect(row.last_fire_at).toBe(NOW);
    expect(row.next_fire_at).toBe(NOW + 3_600_000);
    expect(alarm.requested).toEqual([NOW + 3_600_000]);
    expect(registry.due(NOW)).toEqual([]);
  });

  test('markFired with no next time retires a one-shot without re-arming', async () => {
    const { registry, alarm } = setup();
    const id = await registry.register(spec({ kind: 'timer_oneshot', next_fire_at: NOW }), NOW);
    alarm.requested.length = 0;

    await registry.markFired(id, NOW, null);

    expect(present(registry.get(id), 'registered trigger').next_fire_at).toBeNull();
    expect(present(registry.get(id), 'registered trigger').fire_count).toBe(1);
    expect(alarm.requested).toEqual([]);
  });

  test('fire_count accumulates across firings', async () => {
    const { registry } = setup();
    const id = await registry.register(spec({ next_fire_at: NOW }), NOW);
    await registry.markFired(id, NOW, NOW + 60_000);
    await registry.markFired(id, NOW + 60_000, NOW + 120_000);
    await registry.markFired(id, NOW + 120_000, null);

    expect(present(registry.get(id), 'registered trigger').fire_count).toBe(3);
    expect(present(registry.get(id), 'registered trigger').last_fire_at).toBe(NOW + 120_000);
  });
});

describe('TriggerRegistry.forkPlan', () => {
  test('routes each kind by its documented default policy', async () => {
    const { registry } = setup();
    const ids = new Map<TriggerKind, string>();
    expect(Object.keys(DEFAULT_FORK_POLICY)).toEqual(TRIGGER_KINDS);

    for (const kind of TRIGGER_KINDS) {
      ids.set(kind, await registry.register(spec({ kind }), NOW));
    }

    const { copy, share } = registry.forkPlan();

    const expected = (policy: string) => TRIGGER_KINDS
      .filter(k => DEFAULT_FORK_POLICY[k] === policy)
      .map((kind) => {
        const id = ids.get(kind);

        if (!id) throw new Error(`expected registered trigger id for ${kind}`);

        return id;
      })
      .sort();

    expect(copy.map(t => t.id).sort()).toEqual(expected('copy'));
    expect(share.map(t => t.id).sort()).toEqual(expected('share'));
    const planned = new Set([...copy, ...share].map(t => t.id));

    for (const kind of expected('sever')) expect(planned.has(kind)).toBe(false);
  });

  test('a per-trigger fork_policy overrides the kind default in both directions', async () => {
    const { registry } = setup();
    const severedCron = await registry.register(spec({ kind: 'timer_cron', fork_policy: 'sever' }), NOW);
    const copiedRoute = await registry.register(spec({ kind: 'mcp_route', fork_policy: 'copy' }), NOW);
    const sharedRoute = await registry.register(spec({ kind: 'mcp_route', fork_policy: 'share' }), NOW);

    const { copy, share } = registry.forkPlan();
    expect(copy.map(t => t.id)).toEqual([copiedRoute]);
    expect(share.map(t => t.id)).toEqual([sharedRoute]);
    expect([...copy, ...share].map(t => t.id)).not.toContain(severedCron);
  });

  test('only active triggers are inherited — paused and revoked ones are not', async () => {
    const { registry } = setup();
    const paused = await registry.register(spec({ kind: 'timer_cron' }), NOW);
    const revoked = await registry.register(spec({ kind: 'peer_inbox' }), NOW);
    const live = await registry.register(spec({ kind: 'timer_cron' }), NOW);
    registry.pause(paused, NOW);
    registry.revoke(revoked, NOW);

    const { copy, share } = registry.forkPlan();
    expect(copy.map(t => t.id)).toEqual([live]);
    expect(share).toEqual([]);
  });

  test('an empty registry plans nothing', () => {
    const { registry } = setup();
    expect(registry.forkPlan()).toEqual({ copy: [], share: [] });
  });
});

/** Timer ingress: the loop every backend's clock drives; a host owns only when it is called. */
describe('timer ingress', () => {
  function timers() {
    const db = new Database(':memory:');
    const sql = makeSqlExec(db);
    initEventsHubTables(sql);
    const alarm = new RecordingAlarm();
    // One actor for both, or the timer fires into an inbox nothing drains.
    const actor = createTestActorsOver(db).main;
    const registry = new TriggerRegistry(sql, actor, alarm);
    const log = new EventLog(sql, actor);

    return {
      registry, alarm, log,
      fire: (now: number) => fireDueTriggers({ registry, log }, now),
      fired: () => log.pending({ variant: 'timer' }).map(timerPayload),
    };
  }

  test('a cron schedule fires, re-arms itself, and stays active', async () => {
    const t = timers();
    const timer = await createTimerTrigger(t.registry, { cron: '*/5 * * * *', label: 'sweep' }, NOW);
    expect(timer.kind).toBe('timer_cron');
    const firesAt = present(timer.nextFireAt, 'the cron trigger\'s first fire time');
    expect(firesAt).toBeGreaterThan(NOW);

    expect(await t.fire(firesAt)).toEqual({ fired: 1 });
    expect(t.fired()).toEqual([{
      trigger_id: timer.id, scheduled_fire_at: firesAt, label: 'sweep',
      user_payload: undefined, mission_label: undefined,
    }]);
    const row = present(t.registry.get(timer.id), 'registered trigger');
    expect(row.state).toBe('active');
    expect(row.fire_count).toBe(1);
    const rearmedAt = present(row.next_fire_at, 'the re-armed fire time');
    expect(rearmedAt).toBeGreaterThan(firesAt);
    expect(t.alarm.requested).toContain(rearmedAt);
  });

  test('a one-shot fires once and revokes itself', async () => {
    const t = timers();

    const timer = await createTimerTrigger(t.registry, {
      atMs: NOW + 1000, payload: { task: 'ship' }, missionLabel: 'release', trust: 'owner',
    }, NOW);

    expect(timer).toMatchObject({ kind: 'timer_oneshot', nextFireAt: NOW + 1000 });

    expect(await t.fire(NOW + 1000)).toEqual({ fired: 1 });
    expect(t.fired()[0]).toMatchObject({ user_payload: { task: 'ship' }, mission_label: 'release' });
    expect(t.registry.get(timer.id)).toMatchObject({ state: 'revoked', next_fire_at: null });

    expect(await t.fire(NOW + 2000)).toEqual({ fired: 0 });
    expect(t.fired()).toHaveLength(1);
  });

  test('a re-fire after the host was evicted dedupes on (trigger, scheduled fire)', async () => {
    const t = timers();
    const timer = await createTimerTrigger(t.registry, { cron: '*/5 * * * *' }, NOW);
    const firesAt = present(timer.nextFireAt, 'the cron trigger\'s first fire time');
    await t.fire(firesAt);
    await t.registry.markFired(timer.id, firesAt, timer.nextFireAt);
    expect(await t.fire(firesAt)).toEqual({ fired: 1 });
    expect(t.fired()).toHaveLength(1);
  });

  test('a due trigger that is not a timer is left alone, not published as an alarm', async () => {
    const t = timers();

    const watch = await t.registry.register(
      { kind: 'file_watch', spec: {}, creator_trust: 'owner', next_fire_at: NOW }, NOW,
    );

    expect(await t.fire(NOW)).toEqual({ fired: 0 });
    expect(t.fired()).toEqual([]);
    expect(present(t.registry.get(watch), 'registered trigger').state).toBe('active');
  });

  test('an unusable schedule is refused at registration, before a row exists', async () => {
    const t = timers();
    await expect(createTimerTrigger(t.registry, { cron: 'not a cron' }, NOW))
      .rejects.toThrow('Unsupported cron expression: not a cron');
    await expect(createTimerTrigger(t.registry, {}, NOW))
      .rejects.toThrow('Timer trigger requires cron or atMs');
    expect(t.registry.list()).toEqual([]);
  });

  test('the operator surface lists every column but never fires a cancelled one', async () => {
    const t = timers();
    const timer = await createTimerTrigger(t.registry, { cron: '*/5 * * * *', label: 'sweep' }, NOW);

    expect(listTriggers(t.registry).triggers).toEqual([{
      id: timer.id, kind: 'timer_cron', spec: { cron: '*/5 * * * *', label: 'sweep' },
      creator_trust: 'authenticated', state: 'active', created_at: NOW,
      paused_at: null, revoked_at: null, rate_limit_per_min: 60,
      next_fire_at: timer.nextFireAt, last_fire_at: null, fire_count: 0,
    }]);

    expect(cancelTrigger({ registry: t.registry, trigger_id: timer.id, now: NOW, caller: 'owner' })).toEqual({ ok: true, changed: true });
    expect(cancelTrigger({ registry: t.registry, trigger_id: timer.id, now: NOW, caller: 'owner' })).toEqual({ ok: true, changed: false });
    expect(await t.fire(present(timer.nextFireAt, 'the cancelled trigger\'s fire time'))).toEqual({ fired: 0 });
  });
});
