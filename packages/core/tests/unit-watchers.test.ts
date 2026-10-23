/** Watchers over real in-memory SQLite: a check decides whether a firing wakes the agent, one check per trigger at a time. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActorsOver, present } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { TriggerRegistry, buildDrainBatch, initEventsHubTables, type AlarmScheduler } from '../src/events/hub/index';
import {
  EventLog, WatchClaims, checkAnswerOf, checkWatcher, createTimerTrigger, fireDueTriggers,
  type WatchOutcome, type JsonValue, type RunCheck,
} from '../src/index';
import { makeSqlExec } from './helpers';

const NOW = 1_700_000_000_000;

/** The watcher's own part of its trigger, read as any reader of the row reads it. */
const watchOf = (row: { readonly spec: JsonValue }) => v.parse(v.looseObject({ watch: v.optional(v.unknown()) }), row.spec).watch;

class Alarm implements AlarmScheduler {
  async scheduleAt(): Promise<void> {}
}

function watchers(run: RunCheck) {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);

  initEventsHubTables(sql);
  const actor = createTestActorsOver(db).main;
  const registry = new TriggerRegistry(sql, actor, new Alarm());
  const log = new EventLog(sql, actor);
  const claims = new WatchClaims();

  return {
    registry, log, claims,
    fire: (now: number) => fireDueTriggers({ registry, log, watch: { run, claims } }, now),
    check: (id: string, at: number, input?: JsonValue) => checkWatcher({ registry, log, run, claims }, id, { at, timer: false, ...(input !== undefined && { input }) }, () => NOW),
    fired: () => log.pending({ variant: 'timer' }).map((event) => v.parse(v.looseObject({ watch_brief: v.optional(v.string()) }), event.payload)),
    state: (id: string) => watchOf(present(registry.get(id), 'the watcher')),
  };
}

const answered = (answer: JsonValue): WatchOutcome => ({ kind: 'answered', answer: present(checkAnswerOf(answer), 'a well-formed answer') });

/** A check that waits on `gate` before it answers, as a slow provider read does. */
function gated() {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });

  return { gate, open: () => { open(); } };
}

async function watcher(registry: TriggerRegistry) {
  const created = await createTimerTrigger(registry, { cron: '*/5 * * * *', label: 'mail', payload: { prompt: 'Tell me what needs me.' }, check: { code: 'return { fire: false };' } }, NOW);

  return { id: created.id, at: present(created.nextFireAt, 'its first firing') };
}

describe('a watcher', () => {
  test('a quiet check wakes nothing and keeps its cursor; one that found something fires with its brief', async () => {
    const seen: (JsonValue | undefined)[] = [];
    let found = false;

    const t = watchers(async (_check, state) => {
      seen.push(state);

      return answered(found ? { fire: true, brief: 'Mail from Ada: the invoice is due.', state: { cursor: 11 } } : { fire: false, state: { cursor: 10 } });
    });

    const { id, at } = await watcher(t.registry);

    await t.fire(at);
    expect(t.fired()).toEqual([]);
    expect(t.state(id)).toEqual({ state: { cursor: 10 } });

    found = true;
    await t.fire(present(t.registry.get(id)?.next_fire_at, 'its next firing'));
    expect(seen).toEqual([undefined, { cursor: 10 }]);
    expect(t.fired().map((payload) => payload.watch_brief)).toEqual(['Mail from Ada: the invoice is due.']);
    expect(t.state(id)).toEqual({ state: { cursor: 11 } });
  });

  test('overlapping deliveries with one real change make one fire, the cursor never moving back', async () => {
    const slow = gated();
    const inputs: (JsonValue | undefined)[] = [];
    let runs = 0;

    const t = watchers(async (_check, state, input) => {
      inputs.push(input);
      runs += 1;

      if (runs === 1) await slow.gate;

      // One change exists: whichever check reads cursor 10 finds it; a check after it finds nothing new.
      return answered(state === undefined ? { fire: true, brief: 'One new message.', state: { cursor: 11 } } : { fire: false, state: { cursor: 11 } });
    });

    const { id, at } = await watcher(t.registry);
    const first = t.check(id, at, { historyId: 1 });
    const second = t.check(id, at + 1, { historyId: 2 });
    const third = t.check(id, at + 2, { historyId: 3 });

    await second;
    await third;
    slow.open();
    await first;
    expect(runs).toBe(2);
    expect(inputs).toEqual([{ historyId: 1 }, { historyId: 3 }]);
    expect(t.fired().map((payload) => payload.watch_brief)).toEqual(['One new message.']);
    expect(t.state(id)).toEqual({ state: { cursor: 11 } });
  });

  test('a cursor that moves back commits nothing and fires nothing', async () => {
    let cursor = 20;
    const t = watchers(async () => answered({ fire: true, brief: 'stale', state: { cursor } }));
    const { id, at } = await watcher(t.registry);

    await t.check(id, at);
    expect(t.fired()).toHaveLength(1);
    cursor = 19;
    await t.check(id, at + 1);
    expect(t.fired()).toHaveLength(1);
    expect(t.state(id)).toEqual({ state: { cursor: 20 } });
  });

  test('a watcher cancelled while its check runs fires nothing', async () => {
    const slow = gated();

    const t = watchers(async () => {
      await slow.gate;

      return answered({ fire: true, brief: 'too late', state: { cursor: 1 } });
    });

    const { id, at } = await watcher(t.registry);
    const checking = t.check(id, at);

    t.registry.revoke(id, NOW);
    slow.open();
    await checking;
    expect(t.fired()).toEqual([]);
  });

  test('a refused connection parks it with no next firing, and keeps its cursor', async () => {
    let refuse = false;

    const t = watchers(async () => (refuse
      ? { kind: 'parked', reason: 'connection', detail: 'the Google connection was revoked' }
      : answered({ fire: false, state: { cursor: 5 } })));

    const { id, at } = await watcher(t.registry);

    await t.check(id, at);
    refuse = true;
    await t.check(id, at + 1);
    const row = present(t.registry.get(id), 'the watcher');

    expect(row.state).toBe('paused');
    expect(watchOf(row)).toEqual({ state: { cursor: 5 }, parked: { reason: 'connection', at: NOW, detail: 'the Google connection was revoked' } });
    expect(t.registry.due(Number.MAX_SAFE_INTEGER).map((due) => due.id)).not.toContain(id);
  });

  test('a provider\'s retry time moves the next firing; a transient failure leaves everything as it was', async () => {
    let outcome: WatchOutcome = { kind: 'transient', detail: 'a 503' };
    const t = watchers(async () => outcome);
    const { id, at } = await watcher(t.registry);
    const before = present(t.registry.get(id), 'the watcher');

    await t.check(id, at);
    expect(t.registry.get(id)).toEqual(before);
    outcome = { kind: 'deferred', until: at + 3_600_000, detail: 'Retry-After: 3600' };
    await t.check(id, at);
    expect(t.registry.get(id)?.next_fire_at).toBe(at + 3_600_000);
  });

  test('a firing stays due until its check commits, and a one-shot watcher ends with its answer', async () => {
    const slow = gated();

    const t = watchers(async () => {
      await slow.gate;

      return answered({ fire: false });
    });

    const once = await createTimerTrigger(t.registry, { atMs: NOW + 1_000, check: { code: 'return { fire: false };' } }, NOW);
    const firing = t.fire(NOW + 1_000);

    expect(t.registry.due(NOW + 1_000).map((row) => row.id)).toEqual([once.id]);
    slow.open();
    await firing;
    expect(t.registry.get(once.id)?.state).toBe('revoked');
  });

  test('a fire from a watcher plans, as mail does', async () => {
    const t = watchers(async () => answered({ fire: true, brief: 'A PR needs review.' }));
    const { id, at } = await watcher(t.registry);

    await t.check(id, at);
    expect(buildDrainBatch(t.log.pending({ variant: 'timer' }))?.mode).toBe('plan');
  });

  test('an answer off its shape is not an answer', () => {
    expect(checkAnswerOf({ fire: true })).toBeNull();
    expect(checkAnswerOf({ fire: 'yes', brief: 'x' })).toBeNull();
    expect(checkAnswerOf({ fire: false, state: { historyId: '123' } })).toEqual({ fire: false, state: { historyId: '123' } });
  });
});
