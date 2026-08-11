/**
 * Unit tests: TriggerRegistry — the durable subscription lifecycle.
 *
 * The registry owns two things that are easy to break silently: the state
 * machine (active → paused → active, anything → revoked, each transition
 * idempotent and reporting whether it actually changed anything), and the alarm
 * contract (when the DO is asked to wake). Both are exercised here through the
 * public API over real in-memory SQLite, so the CHECK constraints in the DDL
 * are live.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  DEFAULT_FORK_POLICY, TriggerRegistry, initEventsHubTables,
  type AlarmScheduler, type RegisterSpec, type TriggerKind,
} from '../src/events/hub/index.ts';
import type { SqlExec } from '../src/index.js';

/** Records every wake request so the alarm contract is assertable, and models
 *  the real scheduler's "converge on the soonest pending time" semantics. */
class RecordingAlarm implements AlarmScheduler {
  readonly requested: number[] = [];
  private at: number | null = null;

  scheduleAt(ts: number): void {
    this.requested.push(ts);
    if (this.at === null || ts < this.at) this.at = ts;
  }

  currentAlarm(): number | null { return this.at; }
}

const NOW = 1_700_000_000_000;

function setup() {
  const db = new Database(':memory:');
  const sql: SqlExec = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
  initEventsHubTables(sql);
  const alarm = new RecordingAlarm();
  return { registry: new TriggerRegistry(sql, alarm), alarm };
}

function spec(patch: Partial<RegisterSpec> = {}): RegisterSpec {
  return { kind: 'timer_cron', spec: { cron: '0 * * * *' }, creator_trust: 'owner', ...patch };
}

describe('TriggerRegistry.register', () => {
  test('persists the trigger and returns a retrievable id', () => {
    const { registry } = setup();
    const id = registry.register(spec({ spec: { cron: '*/5 * * * *' } }), NOW);

    const row = registry.get(id)!;
    expect(row.id).toBe(id);
    expect(row.kind).toBe('timer_cron');
    expect(row.state).toBe('active');
    expect(row.created_at).toBe(NOW);
    expect(row.fire_count).toBe(0);
    expect(row.paused_at).toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  test('round-trips the spec through JSON rather than stringifying it into the row', () => {
    const { registry } = setup();
    const id = registry.register(spec({ spec: { cron: '0 9 * * *', tz: 'UTC', nested: { a: [1, 2] } } }), NOW);
    expect(registry.get(id)!.spec).toEqual({ cron: '0 9 * * *', tz: 'UTC', nested: { a: [1, 2] } });
  });

  test('rate limit defaults to 60/min and an explicit one is honoured', () => {
    const { registry } = setup();
    expect(registry.get(registry.register(spec(), NOW))!.rate_limit_per_min).toBe(60);
    expect(registry.get(registry.register(spec({ rate_limit_per_min: 5 }), NOW))!.rate_limit_per_min).toBe(5);
  });

  test('an explicit rate limit of 0 is preserved, not defaulted away', () => {
    // `?? 60` must not degrade into `|| 60` — 0 means "block", not "unset".
    const { registry } = setup();
    expect(registry.get(registry.register(spec({ rate_limit_per_min: 0 }), NOW))!.rate_limit_per_min).toBe(0);
  });

  test('fork_policy is null unless overridden — the per-kind default is applied at fork time', () => {
    const { registry } = setup();
    expect(registry.get(registry.register(spec(), NOW))!.fork_policy).toBeNull();
    expect(registry.get(registry.register(spec({ fork_policy: 'share' }), NOW))!.fork_policy).toBe('share');
  });

  test('schedules an alarm only when the trigger has a fire time', () => {
    const { registry, alarm } = setup();
    registry.register(spec({ kind: 'peer_inbox' }), NOW);
    expect(alarm.requested).toEqual([]);

    registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    expect(alarm.requested).toEqual([NOW + 60_000]);
  });

  test('ids are unique across registrations', () => {
    const { registry } = setup();
    const ids = new Set(Array.from({ length: 25 }, () => registry.register(spec(), NOW)));
    expect(ids.size).toBe(25);
  });
});

describe('TriggerRegistry.get / list', () => {
  test('get returns null for an unknown id', () => {
    const { registry } = setup();
    expect(registry.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
  });

  test('list filters by kind and by state independently and together', () => {
    const { registry } = setup();
    const cron = registry.register(spec({ kind: 'timer_cron' }), NOW);
    const inbox = registry.register(spec({ kind: 'peer_inbox' }), NOW);
    registry.pause(inbox, NOW + 1);

    expect(registry.list().map(t => t.id).sort()).toEqual([cron, inbox].sort());
    expect(registry.list({ kind: 'peer_inbox' }).map(t => t.id)).toEqual([inbox]);
    expect(registry.list({ state: 'active' }).map(t => t.id)).toEqual([cron]);
    expect(registry.list({ kind: 'peer_inbox', state: 'active' })).toEqual([]);
    expect(registry.list({ kind: 'peer_inbox', state: 'paused' }).map(t => t.id)).toEqual([inbox]);
  });

  test('list returns newest first', () => {
    const { registry } = setup();
    const first = registry.register(spec(), NOW);
    const second = registry.register(spec(), NOW + 1000);
    const third = registry.register(spec(), NOW + 2000);
    expect(registry.list().map(t => t.id)).toEqual([third, second, first]);
  });
});

describe('TriggerRegistry pause / resume', () => {
  test('pause moves an active trigger to paused and stamps the time', () => {
    const { registry } = setup();
    const id = registry.register(spec(), NOW);

    expect(registry.pause(id, NOW + 5)).toBe(true);
    const row = registry.get(id)!;
    expect(row.state).toBe('paused');
    expect(row.paused_at).toBe(NOW + 5);
  });

  test('pause reports false when it changed nothing', () => {
    const { registry } = setup();
    const id = registry.register(spec(), NOW);
    registry.pause(id, NOW);

    expect(registry.pause(id, NOW + 1)).toBe(false);      // already paused
    expect(registry.pause('nope', NOW)).toBe(false);       // unknown id
    expect(registry.get(id)!.paused_at).toBe(NOW);         // not re-stamped
  });

  test('a revoked trigger cannot be paused', () => {
    const { registry } = setup();
    const id = registry.register(spec(), NOW);
    registry.revoke(id, NOW);
    expect(registry.pause(id, NOW + 1)).toBe(false);
  });

  test('resume clears paused_at and re-arms a future fire time', () => {
    const { registry, alarm } = setup();
    const id = registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    registry.pause(id, NOW + 1);
    alarm.requested.length = 0;

    expect(registry.resume(id, NOW + 2)).toBe(true);
    const row = registry.get(id)!;
    expect(row.state).toBe('active');
    expect(row.paused_at).toBeNull();
    expect(alarm.requested).toEqual([NOW + 60_000]);
  });

  test('resume does NOT backfill a fire time that elapsed while paused', () => {
    // The missed window is gone by design; re-arming on a past time would fire
    // the trigger immediately on unarchive.
    const { registry, alarm } = setup();
    const id = registry.register(spec({ next_fire_at: NOW + 10 }), NOW);
    registry.pause(id, NOW + 20);
    alarm.requested.length = 0;

    expect(registry.resume(id, NOW + 999)).toBe(true);
    expect(alarm.requested).toEqual([]);
  });

  test('resume reports false for an active, revoked, or unknown trigger', () => {
    const { registry } = setup();
    const active = registry.register(spec(), NOW);
    const revoked = registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(registry.resume(active, NOW)).toBe(false);
    expect(registry.resume(revoked, NOW)).toBe(false);
    expect(registry.resume('nope', NOW)).toBe(false);
  });
});

describe('TriggerRegistry pauseAll / resumeAll', () => {
  test('pauseAll pauses only active triggers and returns how many it moved', () => {
    const { registry } = setup();
    const a = registry.register(spec(), NOW);
    const b = registry.register(spec(), NOW);
    const revoked = registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(registry.pauseAll(NOW + 1)).toBe(2);
    expect(registry.get(a)!.state).toBe('paused');
    expect(registry.get(b)!.state).toBe('paused');
    expect(registry.get(revoked)!.state).toBe('revoked');
    expect(registry.pauseAll(NOW + 2)).toBe(0);
  });

  test('resumeAll re-arms the SOONEST pending fire time, once', () => {
    const { registry, alarm } = setup();
    registry.register(spec({ next_fire_at: NOW + 90_000 }), NOW);
    registry.register(spec({ next_fire_at: NOW + 30_000 }), NOW);
    registry.register(spec({ next_fire_at: NOW - 5 }), NOW);   // already elapsed
    registry.register(spec({ kind: 'peer_inbox' }), NOW);       // no fire time
    registry.pauseAll(NOW + 1);
    alarm.requested.length = 0;

    expect(registry.resumeAll(NOW + 2)).toBe(4);
    expect(alarm.requested).toEqual([NOW + 30_000]);
  });

  test('resumeAll with nothing pending asks for no alarm', () => {
    const { registry, alarm } = setup();
    registry.register(spec({ kind: 'peer_inbox' }), NOW);
    registry.pauseAll(NOW);
    alarm.requested.length = 0;

    expect(registry.resumeAll(NOW + 1)).toBe(1);
    expect(alarm.requested).toEqual([]);
  });

  test('resumeAll does not revive revoked triggers', () => {
    const { registry } = setup();
    const revoked = registry.register(spec(), NOW);
    registry.revoke(revoked, NOW);

    expect(registry.resumeAll(NOW + 1)).toBe(0);
    expect(registry.get(revoked)!.state).toBe('revoked');
  });
});

describe('TriggerRegistry revoke / revokeAll', () => {
  test('revoke stamps the time and clears the fire schedule', () => {
    const { registry } = setup();
    const id = registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);

    expect(registry.revoke(id, NOW + 5)).toBe(true);
    const row = registry.get(id)!;
    expect(row.state).toBe('revoked');
    expect(row.revoked_at).toBe(NOW + 5);
    expect(row.next_fire_at).toBeNull();
  });

  test('revoke works from paused, and is idempotent afterwards', () => {
    const { registry } = setup();
    const id = registry.register(spec(), NOW);
    registry.pause(id, NOW);

    expect(registry.revoke(id, NOW + 1)).toBe(true);
    expect(registry.revoke(id, NOW + 2)).toBe(false);
    expect(registry.get(id)!.revoked_at).toBe(NOW + 1);
  });

  test('revoke reports false for an unknown id', () => {
    const { registry } = setup();
    expect(registry.revoke('nope', NOW)).toBe(false);
  });

  test('revokeAll counts everything not already revoked, and is idempotent', () => {
    const { registry } = setup();
    registry.register(spec({ next_fire_at: NOW + 60_000 }), NOW);
    const paused = registry.register(spec(), NOW);
    registry.pause(paused, NOW);
    const already = registry.register(spec(), NOW);
    registry.revoke(already, NOW);

    expect(registry.revokeAll(NOW + 1)).toBe(2);
    expect(registry.list().every(t => t.state === 'revoked')).toBe(true);
    expect(registry.list().every(t => t.next_fire_at === null)).toBe(true);
    expect(registry.revokeAll(NOW + 2)).toBe(0);
  });
});

describe('TriggerRegistry alarm wakeup path', () => {
  test('due returns triggers at or before now, and nothing scheduled later', () => {
    const { registry } = setup();
    const past = registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    const exactly = registry.register(spec({ next_fire_at: NOW }), NOW);
    registry.register(spec({ next_fire_at: NOW + 1 }), NOW);

    expect(registry.due(NOW).map(t => t.id).sort()).toEqual([past, exactly].sort());
  });

  test('due ignores triggers with no fire time', () => {
    const { registry } = setup();
    registry.register(spec({ kind: 'peer_inbox' }), NOW);
    expect(registry.due(NOW + 10_000)).toEqual([]);
  });

  test('due ignores paused and revoked triggers even when their time has come', () => {
    const { registry } = setup();
    const paused = registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    const revoked = registry.register(spec({ next_fire_at: NOW - 1 }), NOW);
    registry.pause(paused, NOW);
    registry.revoke(revoked, NOW);

    expect(registry.due(NOW)).toEqual([]);
  });

  test('markFired advances the counter and re-arms a recurring trigger', () => {
    const { registry, alarm } = setup();
    const id = registry.register(spec({ next_fire_at: NOW }), NOW);
    alarm.requested.length = 0;

    registry.markFired(id, NOW, NOW + 3_600_000);

    const row = registry.get(id)!;
    expect(row.fire_count).toBe(1);
    expect(row.last_fire_at).toBe(NOW);
    expect(row.next_fire_at).toBe(NOW + 3_600_000);
    expect(alarm.requested).toEqual([NOW + 3_600_000]);
    expect(registry.due(NOW)).toEqual([]);
  });

  test('markFired with no next time retires a one-shot without re-arming', () => {
    const { registry, alarm } = setup();
    const id = registry.register(spec({ kind: 'timer_oneshot', next_fire_at: NOW }), NOW);
    alarm.requested.length = 0;

    registry.markFired(id, NOW, null);

    expect(registry.get(id)!.next_fire_at).toBeNull();
    expect(registry.get(id)!.fire_count).toBe(1);
    expect(alarm.requested).toEqual([]);
  });

  test('fire_count accumulates across firings', () => {
    const { registry } = setup();
    const id = registry.register(spec({ next_fire_at: NOW }), NOW);
    registry.markFired(id, NOW, NOW + 60_000);
    registry.markFired(id, NOW + 60_000, NOW + 120_000);
    registry.markFired(id, NOW + 120_000, null);

    expect(registry.get(id)!.fire_count).toBe(3);
    expect(registry.get(id)!.last_fire_at).toBe(NOW + 120_000);
  });
});

describe('TriggerRegistry.forkPlan', () => {
  test('routes each kind by its documented default policy', () => {
    const { registry } = setup();
    const ids = new Map<TriggerKind, string>();
    for (const kind of Object.keys(DEFAULT_FORK_POLICY) as TriggerKind[]) {
      ids.set(kind, registry.register(spec({ kind }), NOW));
    }

    const { copy, share } = registry.forkPlan();
    const expected = (policy: string) => (Object.keys(DEFAULT_FORK_POLICY) as TriggerKind[])
      .filter(k => DEFAULT_FORK_POLICY[k] === policy)
      .map(k => ids.get(k)!)
      .sort();

    expect(copy.map(t => t.id).sort()).toEqual(expected('copy'));
    expect(share.map(t => t.id).sort()).toEqual(expected('share'));
    // Severed kinds appear in neither bucket.
    const planned = new Set([...copy, ...share].map(t => t.id));
    for (const kind of expected('sever')) expect(planned.has(kind)).toBe(false);
  });

  test('a per-trigger fork_policy overrides the kind default in both directions', () => {
    const { registry } = setup();
    // timer_cron defaults to copy; mcp_route defaults to sever.
    const severedCron = registry.register(spec({ kind: 'timer_cron', fork_policy: 'sever' }), NOW);
    const copiedRoute = registry.register(spec({ kind: 'mcp_route', fork_policy: 'copy' }), NOW);
    const sharedRoute = registry.register(spec({ kind: 'mcp_route', fork_policy: 'share' }), NOW);

    const { copy, share } = registry.forkPlan();
    expect(copy.map(t => t.id)).toEqual([copiedRoute]);
    expect(share.map(t => t.id)).toEqual([sharedRoute]);
    expect([...copy, ...share].map(t => t.id)).not.toContain(severedCron);
  });

  test('only active triggers are inherited — paused and revoked ones are not', () => {
    const { registry } = setup();
    const paused = registry.register(spec({ kind: 'timer_cron' }), NOW);
    const revoked = registry.register(spec({ kind: 'peer_inbox' }), NOW);
    const live = registry.register(spec({ kind: 'timer_cron' }), NOW);
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
