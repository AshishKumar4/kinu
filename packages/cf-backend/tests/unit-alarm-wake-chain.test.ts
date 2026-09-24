/**
 * The one Kinu wake row (`_kinuTimerTick`) carries every async lane; losing it silently stops the workspace.
 * The alarm itself is fired for real in tests/workerd/do-alarm.test.ts (redelivery-on-throw).
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openWorkspaceMainActor } from '@kinu.run/core';
import { makeSql } from '../../core/tests/helpers';
import {
  hostedSubordinateHarness, orchestratorHarness, chatSessionTurns, until, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { present } from '@kinu.run/test-utils';

/** Journal, job registry and search ledger are actor-private: seeds must carry the owner the agent resolves. */
function harnessActorId(db: Database): string {
  return openWorkspaceMainActor(makeSql(db)).actorId;
}

function held(db: Database, counting: string): number {
  return present(db.query<{ held: number }, []>(counting).get(), `the count from ${counting}`).held;
}

const KINU_TIMER_CALLBACK = '_kinuTimerTick';

/** The maintenance wake a truncated sweep arms at its end: the sweep's own record that it ran. */
function wakeArmed(db: Database): boolean {
  return held(db, "SELECT COUNT(*) AS held FROM cf_agents_schedules WHERE callback = '_kinuTerminalRetryTick'") > 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The platform clock moves only across I/O: pinned at `at`, it steps one second after each schedule write, so
 * two arms of one wake straddle a second boundary on every run instead of on a starved box.
 */
function scheduleWritesTakeASecond(agent: HarnessOrchestratorAgent, at: number) {
  let now = at;
  setSystemTime(new Date(now));
  const write = agent.schedule.bind(agent);

  Object.defineProperty(agent, 'schedule', {
    configurable: true,
    value: async (...args: Parameters<typeof write>) => {
      const row = await write(...args);
      now += 1000;
      setSystemTime(new Date(now));

      return row;
    },
  });

  return { seconds: () => Math.floor(now / 1000) };
}

/** Injects the schedule-write failure that would end the chain. */
function breakScheduleWrites(agent: HarnessOrchestratorAgent): void {
  Object.defineProperty(agent, 'schedule', {
    configurable: true,
    value: async (): Promise<never> => { throw new Error('storage write failed'); },
  });
}

describe('the workspace keeps exactly one wake row', () => {
  test('the stale sweep spares the Kinu wake and still drops a dead continuation', async () => {
    // KINU-N027: the sweep runs before the SDK reads due rows, so it must not delete an overdue Kinu wake.
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();
    const overdueSec = Math.floor((Date.now() - 2 * DAY_MS) / 1000);

    const insert = db.prepare(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, ?, ?)`,
    );

    insert.run('kinu-wake', KINU_TIMER_CALLBACK, 'scheduled', overdueSec);
    insert.run('dead-continuation', '_chatRecovery', 'delayed', overdueSec);

    // The actor's activation, not `agent.onStart()`: the vendor chat base shadows that name.
    await agent.activateActor();

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual(['kinu-wake']);
  });

  test('a row whose callback names no method on the class is dropped at any age and type', async () => {
    // The alarm loop logs an unknown callback and keeps the row forever; no horizon reaches a recurring row.
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();

    const insert = db.prepare(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, ?, ?)`,
    );

    const soonSec = Math.floor((Date.now() + 60_000) / 1000);
    insert.run('dead-future', 'snapshotWorkspaceIfDue', 'scheduled', soonSec);
    insert.run('dead-cron', 'snapshotWorkspaceIfDue', 'cron', soonSec);
    insert.run('dead-interval', 'snapshotWorkspaceIfDue', 'interval', soonSec);
    // A live callback of the same age survives: the sweep reads the class, not the clock.
    insert.run('live-future', '_kinuTerminalRetryTick', 'scheduled', soonSec);

    await agent.activateActor();

    const rows = await agent.listSchedules();
    expect(rows.filter((row) => row.callback === 'snapshotWorkspaceIfDue')).toEqual([]);
    expect(rows.some((row) => row.id === 'live-future')).toBe(true);
  });

  test('due duplicates of the tick retire when one of them runs', async () => {
    // Overdue duplicates of the tick retire before the pass; the row the scheduler hands the callback stays.
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();
    const overdueSec = Math.floor((Date.now() - 60_000) / 1000);

    const insert = db.prepare(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, ?, ?)`,
    );

    for (const id of ['due-1', 'due-2', 'due-3', 'due-4']) insert.run(id, '_kinuTerminalRetryTick', 'scheduled', overdueSec);

    await agent.activateActor();
    await agent._kinuTerminalRetryTick(undefined, { id: 'due-2', callback: '_kinuTerminalRetryTick', payload: undefined, type: 'scheduled', time: overdueSec });

    const due = (await agent.listSchedules()).filter((row) => row.callback === '_kinuTerminalRetryTick' && row.time <= Math.floor(Date.now() / 1000));
    expect(due.map((row) => row.id)).toEqual(['due-2']);
  });

  test('a beyond-budget stale backlog drains across maintenance wakes, not the gate', async () => {
    // The sweep is budgeted (it runs in the init gate); a truncated pass arms the maintenance tick for the rest.
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();
    const overdueSec = Math.floor((Date.now() - 2 * DAY_MS) / 1000);

    const insert = db.prepare(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, ?, ?)`,
    );

    for (let i = 0; i < 4096 + 50; i++) insert.run(`stale-${i}`, '_chatRecovery', 'delayed', overdueSec);

    await agent.activateActor();
    await until(() => wakeArmed(db), 'the truncated sweep armed the maintenance wake');

    const staleRecoveries = `SELECT COUNT(*) AS held FROM cf_agents_schedules WHERE callback = '_chatRecovery'`;

    expect(held(db, staleRecoveries)).toBe(50);
    const armed = (await agent.listSchedules()).filter((row) => row.callback === '_kinuTerminalRetryTick');
    expect(armed.length).toBe(1);

    await agent.terminalRetryPass();
    expect(held(db, staleRecoveries)).toBe(0);
  });

  test('a beyond-budget FIBER backlog also arms the wake, and the wake drains it', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();
    db.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL)`);

    const insert = db.prepare(
      `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)`,
    );

    const expired = Date.now() - 25 * 60 * 60 * 1000;

    for (let i = 0; i < 4096 + 40; i++) insert.run(`fiber-${i}`, 'bg:stale', expired);

    await agent.activateActor();
    await until(() => wakeArmed(db), 'the truncated fiber sweep armed the maintenance wake');

    const seededFibers = `SELECT COUNT(*) AS held FROM cf_agents_runs WHERE id LIKE 'fiber-%'`;

    expect(held(db, seededFibers)).toBe(40);
    expect((await agent.listSchedules()).some((row) => row.callback === '_kinuTerminalRetryTick')).toBe(true);

    await agent.terminalRetryPass();
    expect(held(db, seededFibers)).toBe(0);
  });

  test('a hired child shares the workspace wake, and its backlog drains through it', async () => {
    // Hiring a child must not create a second wake: the root activation drains the shared database.
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'wake-child',
      displayName: 'Wake Child',
      nameOrigin: 'user',
      mission: 'share one wake',
    });

    const rootId = harnessActorId(workspace.db);
    expect(child.actor.handle.actorId).not.toBe(rootId);
    await workspace.agent.listSchedules();
    workspace.db.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL)`);

    const insert = workspace.db.prepare(
      `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)`,
    );

    const expired = Date.now() - 25 * 60 * 60 * 1000;

    for (let i = 0; i < 4096 + 12; i++) insert.run(`sub-fiber-${i}`, 'bg:stale', expired);

    await workspace.agent.activateActor();
    await until(() => wakeArmed(workspace.db), 'the truncated fiber sweep armed the shared wake');

    // Seeded rows only: the activation's own terminal-lane fiber writes a fresh carrier row here.
    const seededChildFibers = `SELECT COUNT(*) AS held FROM cf_agents_runs WHERE id LIKE 'sub-fiber-%'`;

    expect(held(workspace.db, seededChildFibers)).toBe(12);
    const wakes = (await workspace.agent.listSchedules()).filter((row) => row.callback === '_kinuTerminalRetryTick');
    expect(wakes).toHaveLength(1);

    await workspace.agent.terminalRetryPass();
    expect(held(workspace.db, seededChildFibers)).toBe(0);
  });

  test('a hired child deferred job is restored by the workspace wake', async () => {
    // The activation classifies (workspace-wide `owedWorkExists`) and arms an immediate wake; the tick dispatches to the child's instant.
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'deferred-child',
      displayName: 'Deferred Child',
      nameOrigin: 'user',
      mission: 'wait for one wake',
    });

    await workspace.agent.activateActor();
    await joinHarnessFibers();
    expect(await workspace.agent.listSchedules()).toEqual([]);

    const now = Date.now();
    const resumeAt = now + 60_000;
    workspace.db.prepare(
      `INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, resume_after, created_at)
       VALUES (?, 'job-waiting', 'agents', 'build', 'running', '{}', ?, ?)`,
    ).run(child.actor.handle.actorId, resumeAt, now);

    await workspace.agent.activateActor();
    await until(() => wakeArmed(workspace.db), 'the activation armed a wake for the child\'s owed job');

    const wakes = async (): Promise<Array<{ id: string; time: number }>> =>
      (await workspace.agent.listSchedules())
        .filter((row) => row.callback === '_kinuTerminalRetryTick')
        .map((row) => ({ id: row.id, time: row.time }));

    const owedAt = Math.ceil(resumeAt / 1000);
    const armed = await wakes();
    expect(armed).toHaveLength(1);
    const wake = armed[0];

    if (!wake) throw new Error('the activation armed no wake for the child\'s owed job');
    // Immediate and not the instant: counting rows alone cannot tell armed from stranded.
    expect(wake.time).not.toBe(owedAt);

    // A one-shot `scheduled` row is consumed when its alarm fires; the callback runs after.
    await workspace.agent.cancelSchedule(wake.id);
    const nowSec = Math.floor(Date.now() / 1000);
    await workspace.agent.terminalRetryPass();

    // Exactly one row at the job's own instant; the job's wake and the retry's wake collapse.
    const restored = await wakes();
    expect(restored.map((row) => row.time)).toEqual([owedAt]);
    expect(restored[0]?.time).toBeGreaterThan(nowSec);
  });

  test('a deferred job costs one wake at its instant, not a climbing chain', async () => {
    // A finished pass re-arms at the soonest timed owed instant, not the pessimistic next-lap row.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();

    const now = Date.now();
    const resumeAt = now + 60_000;
    db.prepare(
      `INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, resume_after, created_at)
       VALUES (?, 'job-deferred', 'agents', 'build', 'running', '{}', ?, ?)`,
    ).run(harnessActorId(db), resumeAt, now);

    await agent.terminalRetryPass();

    const armed = (await agent.listSchedules())
      .filter((row) => row.callback === '_kinuTerminalRetryTick')
      .map((row) => row.time);

    expect(armed).toEqual([Math.ceil(resumeAt / 1000)]);
  });

  test('a failed re-arm leaves the previous wake row in place', async () => {
    // KINU-N003 (first half): the replacement row is written before cancelling, so a failure leaves an extra wake, not zero.
    const { agent } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const before = await agent.listSchedules();
    expect(before.map((row) => row.callback)).toEqual([KINU_TIMER_CALLBACK]);

    breakScheduleWrites(agent);
    await expect(agent.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'soon' }))
      .rejects.toThrow('storage write failed');

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual(
      before.map((row) => row.id),
    );
  });

  test('a live branch head spawned after activation survives every tick', async () => {
    // The recovery cutoff is the isolate's construction instant, and the pass runs once per activation.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();

    const actorId = harnessActorId(db);

    const insertBranch = (id: string, spawnedAt: number): void => {
      db.prepare(
        `INSERT INTO head_journal (actor_id, id, root_id, depth, task, status, spawned_at)
         VALUES (?, ?, ?, 0, 'take a branch', 'running', ?)`,
      ).run(actorId, id, `branch-${id}`, spawnedAt);
    };

    const status = (id: string): string => present(db
      .query<{ status: string }, [string, string]>(`SELECT status FROM head_journal WHERE actor_id = ? AND id = ?`)
      .get(actorId, id), `the head_journal row of ${id}`).status;

    insertBranch('stale-head', Date.now() - 60_000);
    insertBranch('live-head', Date.now() + 5);

    await agent.terminalRetryPass();
    expect(status('stale-head')).toBe('errored');
    expect(status('live-head')).toBe('running');

    // The cutoff, not the tick count, guards live work: a row predating construction is stale wherever it appears.
    insertBranch('late-stale-head', Date.now() - 60_000);
    await agent.terminalRetryPass();
    expect(status('late-stale-head')).toBe('errored');
  });

  test('a live swarm ledger row created after activation survives the tick', async () => {
    // `closeUnclaimed` must not fail swarm rows created after construction.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();

    const actorId = harnessActorId(db);

    const insertRun = (root: string, createdAt: number): void => {
      db.prepare(
        `INSERT INTO mcts_search_runs
           (actor_id, root_id, root_msg_id, task, engine, status, config_json, budget, created_at, updated_at)
         VALUES (?, ?, ?, 'search the space', 'swarm', 'running', '{}', 4, ?, ?)`,
      ).run(actorId, root, `msg-${root}`, createdAt, createdAt);
    };

    const status = (root: string): string => present(db
      .query<{ status: string }, [string, string]>(`SELECT status FROM mcts_search_runs WHERE actor_id = ? AND root_id = ?`)
      .get(actorId, root), `the mcts_search_runs row of ${root}`).status;

    insertRun('stale-swarm', Date.now() - 60_000);
    insertRun('live-swarm', Date.now() + 5);

    await agent.terminalRetryPass();
    expect(status('stale-swarm')).toBe('failed');
    expect(status('live-swarm')).toBe('running');
  });

  test('a live run-event start after activation is not terminalized by the tick', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();

    const actorId = harnessActorId(db);

    // The ledger reads open runs through the event schema; an unreadable row is a fault.
    const start = (run: string, ts: number): void => {
      const stamped = new Date(ts).toISOString();
      db.prepare(
        `INSERT INTO run_events (actor_id, run_id, event_index, type, ts, payload)
         VALUES (?, ?, 1, 'run_start', ?, ?)`,
      ).run(actorId, run, stamped, JSON.stringify({ type: 'run_start', agentId: 'a', eventIndex: 1, runId: run, timestamp: stamped }));
    };

    const ended = (run: string): boolean => present(db
      .query<{ held: number }, [string, string]>('SELECT COUNT(*) AS held FROM run_events WHERE actor_id = ? AND run_id = ? AND type = \'run_end\'')
      .get(actorId, run), `the run_end count of ${run}`).held > 0;

    start('stale-run', Date.now() - 60_000);
    start('live-run', Date.now() + 5);

    await agent.terminalRetryPass();
    expect(ended('stale-run')).toBe(true);
    expect(ended('live-run')).toBe(false);
  });

  test('an unfinished pass re-arms in the FUTURE, at a pace that grows per lap', async () => {
    // A full-budget pass re-arms later each unfinished lap, so a backlog can never become a one-second loop.
    // The delay is baked into the schedule row, so nothing can shorten an armed wake.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();

    const insert = db.prepare(
      `INSERT INTO head_journal (actor_id, id, root_id, depth, task, status, spawned_at)
       VALUES (?, ?, ?, 0, 'take a branch', 'running', ?)`,
    );

    const actorId = harnessActorId(db);
    const stale = Date.now() - 60_000;

    for (let i = 0; i < 769; i++) insert.run(actorId, `floor-head-${i}`, `branch-floor-${i}`, stale);

    // The SDK deletes its one-shot row once the callback returns; without that a soonest-wins arm never ramps.
    const fireArmedTick = async (): Promise<number> => {
      const before = (await agent.listSchedules())
        .filter((row) => row.callback === '_kinuTerminalRetryTick');

      for (const row of before) await agent.cancelSchedule(row.id);
      const firedAtSec = Math.floor(Date.now() / 1000);
      await agent.terminalRetryPass();

      const armed = (await agent.listSchedules())
        .filter((row) => row.callback === '_kinuTerminalRetryTick');

      return armed.length === 0 ? 0 : (armed[0]?.time ?? 0) - firedAtSec;
    };

    const first = await fireArmedTick();
    expect(first).toBeGreaterThan(1);

    const second = await fireArmedTick();
    expect(second).toBeGreaterThan(first);

    expect(await fireArmedTick()).toBeGreaterThan(second);
    expect(await fireArmedTick()).toBe(0);
  });

  test('a tick killed after its arm and before its drain still leaves the wake', async () => {
    // Arm-first: the next-lap row is durable before any pass runs, so a failing roster row cannot end the chain.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();

    // Real input: `birth_request` is JSON-parsed on read mid-tick, after the arm and before the drain.
    db.prepare(
      `INSERT INTO actor_subordinates
        (actor_id, name, created_by, status, current_task, created_at, dismissed_at,
         lifetime, task_event_id, actor_reference, birth_request, delete_requested)
       VALUES (?, 'poisoned-birth', 'orchestrator', 'idle', NULL, ?, NULL, 'durable', NULL, NULL, '{malformed', 0)`,
    ).run(harnessActorId(db), Date.now());

    await expect(agent.terminalRetryPass()).rejects.toThrow('malformed');

    const armed = (await agent.listSchedules())
      .filter((row) => row.callback === '_kinuTerminalRetryTick' && row.time > Math.floor(Date.now() / 1000));

    expect(armed).toHaveLength(1);
  });

  test('a tick with nothing owed releases the row it armed', async () => {
    // A pass with nothing unfinished and nothing owed deletes exactly the row it armed.
    const { agent } = orchestratorHarness();
    await agent.activateActor();
    expect(await agent.listSchedules()).toEqual([]);

    await agent.terminalRetryPass();

    expect(await agent.listSchedules()).toEqual([]);
  });

  test('a tick that cannot re-arm fails, so the runtime redelivers it', async () => {
    // KINU-N003 (second half): a re-arm failure must reject the tick; the other phases stay tolerated.
    const { agent } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();

    if (!armed) throw new Error('the trigger did not arm a wake row');
    await agent.cancelSchedule(armed.id);
    breakScheduleWrites(agent);

    let failure: Error | null = null;

    try {
      await agent._kinuTimerTick();
    } catch (thrown) {
      if (thrown instanceof Error) failure = thrown;
    }

    // The rejection is the contract: it makes the platform redeliver the alarm.
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('re-arming the wake that keeps the timer chain alive');
    expect(String(failure?.cause)).toContain('storage write failed');
  });

  test('an activation restores a wake row that went missing', async () => {
    // Redelivery is bounded, so activation reconstructs the derived wake row.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();

    if (!armed) throw new Error('the trigger did not arm a wake row');
    await agent.cancelSchedule(armed.id);
    expect(await agent.listSchedules()).toEqual([]);
    // Through activation, not the reconcile method: an onStart that stopped reconciling must fail this.
    await agent.activateActor();
    await until(() => held(db, `SELECT COUNT(*) AS held FROM cf_agents_schedules WHERE callback = '${KINU_TIMER_CALLBACK}'`) > 0,
      'the activation restored the timer wake');

    expect((await agent.listSchedules()).map((row) => row.callback))
      .toEqual([KINU_TIMER_CALLBACK]);
  });

  test('the reconcile cannot invent a wake nothing is waiting for', async () => {
    const { agent } = orchestratorHarness();

    await agent.activateActor();
    await joinHarnessFibers();

    expect(await agent.listSchedules()).toEqual([]);
  });

  test('an armed wake is left alone, however overdue', async () => {
    // The reconcile asks whether a wake row exists, never whether it is soon enough (`armTimer`'s question).
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();

    if (!armed) throw new Error('the trigger did not arm a wake row');
    db.prepare(`UPDATE cf_agents_schedules SET time = ? WHERE id = ?`)
      .run(Math.floor((Date.now() - 2 * DAY_MS) / 1000), armed.id);

    await agent.activateActor();
    await joinHarnessFibers();

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual([armed.id]);
  });

  test('a due row is not counted as armed, so the chain re-arms over it', async () => {
    // A due row belongs to the running tick; an arm for later work writes its own future row.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();

    if (!armed) throw new Error('the trigger did not arm a wake row');
    const dueSec = Math.floor(Date.now() / 1000) - 5;
    db.prepare(`UPDATE cf_agents_schedules SET time = ? WHERE id = ?`).run(dueSec, armed.id);

    const laterAtMs = Date.now() + 2 * DAY_MS;
    await agent.createTimerTrigger({ atMs: laterAtMs, label: 'later' });

    const rows = (await agent.listSchedules()).filter((row) => row.callback === KINU_TIMER_CALLBACK);
    expect(rows.map((row) => row.time).sort((a, b) => a - b))
      .toEqual([dueSec, Math.ceil(laterAtMs / 1000)]);
  });

  test('a root turn arms the wake when it opens', async () => {
    // An opened turn owes nothing yet but must leave exactly one wake (riding the terminal-retry row).
    const { agent } = orchestratorHarness();
    await agent.activateActor();
    expect(await agent.listSchedules()).toEqual([]);

    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn that opens' }] });

    const armed = (await agent.listSchedules())
      .filter((row) => row.callback === '_kinuTerminalRetryTick');

    expect(armed).toHaveLength(1);

    // Settle so the pump finishes inside this test.
    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a tick that fires inside a parked turn keeps a wake row', async () => {
    // An open turn is untimed owed work: a finished pass must keep its wake row.
    const { agent } = orchestratorHarness();
    await agent.activateActor();
    expect(await agent.listSchedules()).toEqual([]);

    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn the tick fires inside' }] });

    const wakes = async (): Promise<number[]> => (await agent.listSchedules())
      .filter((row) => row.callback === '_kinuTerminalRetryTick')
      .map((row) => row.time);

    expect(await wakes()).toHaveLength(1);

    // The SDK consumes the one-shot row when it fires, then the callback runs.
    for (const row of await agent.listSchedules()) await agent.cancelSchedule(row.id);
    const firedAtSec = Math.floor(Date.now() / 1000);
    await agent.terminalRetryPass();

    const kept = await wakes();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBeGreaterThan(firedAtSec);

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a turn-open wake does not fire inside an ordinary turn', async () => {
    // The turn-open arm is set at the recovery ceiling, after any ordinary turn.
    const { agent } = orchestratorHarness();
    await agent.activateActor();

    const turns = chatSessionTurns(agent);
    const armedAtSec = Math.floor(Date.now() / 1000);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn that opens' }] });

    const armed = (await agent.listSchedules())
      .filter((row) => row.callback === '_kinuTerminalRetryTick')
      .map((row) => row.time);

    expect(armed).toHaveLength(1);
    expect((armed[0] ?? 0) - armedAtSec).toBeGreaterThanOrEqual(60);

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('an email the binding refused is retried by the one future timer wake', async () => {
    // The mail outbox arms the Kinu timer like every other wake, awaited: a lost arm drops the receipt silently.
    const refusals: string[] = [];

    const { agent } = orchestratorHarness(
      { warmConnections: [], failWarm: null, titles: [], profile: { email: 'owner@example.com' } },
      {
        email: {
          send: async () => {
            refusals.push('send');

            throw new Error('the mail route refused the message');
          },
        },
      },
    );

    const clock = scheduleWritesTakeASecond(agent, Date.UTC(2026, 8, 24, 12));

    try {
      const admission = await agent.acceptEmailDelivery({
        from: 'owner@example.com', to: 'workspace@kinu.run', subject: 'status?', body_text: 'how is the deploy?',
        message_id: '<m-1@example.com>', in_reply_to: null, references: null, attachments: [], now: Date.now(),
      });

      expect(admission).toMatchObject({ admitted: true, duplicate: false });
      expect(refusals).toEqual(['send']);

      // The inbound email's drain wake falls due as the retry is armed. Arming collapses future rows only
      // (a due row is the next alarm's, which re-derives the wake), so the retry rides the one future row.
      const wakes = (await agent.listSchedules()).filter((row) => row.callback === KINU_TIMER_CALLBACK);
      expect(wakes.filter((row) => row.time > clock.seconds())).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  test('two concurrent arms converge on ONE wake row, the earliest', async () => {
    // `onStart` detaches `reconcileTimerRow()`, so concurrent arms interleave across awaits and both write.
    // The pair must collapse to one survivor, the sooner wake.
    const { agent } = orchestratorHarness();
    const soonerMs = Date.now() + 2 * DAY_MS;

    await Promise.all([
      agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' }),
      agent.createTimerTrigger({ atMs: soonerMs, label: 'sooner' }),
    ]);

    const wakes = (await agent.listSchedules())
      .filter((row) => row.callback === KINU_TIMER_CALLBACK);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.time).toBe(Math.ceil(soonerMs / 1000));
  });
});
