/**
 * The Kinu timer job carries every async lane and the terminal-retry job every owed one; losing either silently
 * stops the workspace. Jobs are driven by the SDK's own Lifecycle; the platform alarm is tests/workerd/do-alarm.test.ts.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openWorkspaceMainActor, recoveryBackoffMs } from '@kinu.run/core';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { makeSql } from '../../core/tests/helpers';
import {
  armedWakes, catalogTurn, fireSoonestWake, gatewayWorkspace, hostedSubordinateHarness, orchestratorHarness, chatSessionTurns, reactivateOrchestratorHarness,
  runDelegatedTask, tapDiagnostics, until,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { present } from '@kinu.run/test-utils';
import { answeringGateway } from './helpers/platform-gateway';
import { KINU_TIMER_JOB, TERMINAL_RETRY_JOB, type WakeJob } from '../src/wake-jobs';

/** Journal, job registry and search ledger are actor-private: seeds must carry the owner the agent resolves. */
function harnessActorId(db: Database): string {
  return openWorkspaceMainActor(makeSql(db)).actorId;
}

function held(db: Database, counting: string): number {
  return present(db.query<{ held: number }, []>(counting).get(), `the count from ${counting}`).held;
}

/** The instants `id` is armed for; the queue keys a job by its id. */
function armedAt(db: Database, id: WakeJob): number[] {
  return armedWakes(db).filter((wake) => wake.id === id).map((wake) => wake.time);
}

/** Where an arm for `atMs` lands: wakes land on a whole second, as the SDK's schedules did. */
function landing(atMs: number): number {
  return Math.ceil(atMs / 1000) * 1000;
}

/** The maintenance wake a truncated sweep arms at its end: the sweep's own record that it ran. */
function wakeArmed(db: Database): boolean {
  return armedAt(db, TERMINAL_RETRY_JOB).length > 0;
}

/** Every wake write the queue makes from here is refused, as a failing storage write would be. */
function breakWakeWrites(db: Database): void {
  db.exec(`CREATE TRIGGER wake_writes_refused BEFORE INSERT ON cf_agents_jobs
    BEGIN SELECT RAISE(ABORT, 'storage write failed'); END`);
}

afterEach(() => { setSystemTime(); });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A branch head spawned now: work in flight in this activation, which recovery leaves running. The
 * next activation sweeps it only once its start is later than `spawned_at`, so a test that needs the
 * sweep moves the clock between activations rather than hoping they land in different milliseconds.
 */
function liveHead(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO head_journal (actor_id, id, root_id, depth, task, status, spawned_at)
     VALUES (?, ?, ?, 0, 'take a branch', 'running', ?)`,
  ).run(harnessActorId(db), id, `branch-${id}`, Date.now());
}

/** An assignment row's dispatch state and, once settled, the reason it was dismissed. */
function orphanRow(db: Database, id: string): { step_idx: number | null; dismissed: string | null } {
  return present(db
    .query<{ step_idx: number | null; dismissed: string | null }, [string]>(
      `SELECT step_idx, json_extract(payload, '$.__dismissed.reason') AS dismissed FROM agent_log WHERE id = ?`)
    .get(id), `the agent_log row ${id}`);
}

describe('a refiner answer stored with no waiter', () => {
  test('arms the Kinu wake at once, and the tick routes it so the workspace owes nothing after', async () => {
    // After an eviction the answer used to wait for the owner's next message.
    const workspace = orchestratorHarness();
    const now = Date.now();
    const { requests } = await workspace.agent.listRefinements(1);
    expect(requests).toEqual([]);

    const actorId = harnessActorId(workspace.db);
    workspace.db.prepare(`INSERT INTO refinement_requests
      (actor_id, id, trigger, scope, stage, claim, turn_ids, debt_key, proposal, routes, detail, created_at, updated_at)
      VALUES (?, 'refine-1', 'explicit', 'workspace', 'requested', NULL, '[]', NULL, NULL, '[]', 'opened', ?, ?)`).run(actorId, now, now);
    workspace.db.prepare(`INSERT INTO evolution_helpers
      (actor_id, name, lane_request_id, answer_status, answer, created_at)
      VALUES (?, 'ask-refiner-x1', 'refine-1', 'completed', ?, ?)`)
      .run(actorId, 'Nothing to change.\n\n{"scope":"workspace","summary":"nothing","edits":[]}', now);

    await workspace.agent.activateActor();
    await until(() => armedAt(workspace.db, KINU_TIMER_JOB).length > 0, 'the stored answer armed the Kinu wake');

    await workspace.agent._kinuTimerTick();
    await joinHarnessFibers();

    expect((await workspace.agent.listRefinements(1)).requests[0]?.stage).not.toBe('requested');
  });

  test('an answer relayed after activation pulls the Kinu wake to now, and the tick routes it', async () => {
    const workspace = gatewayWorkspace(answeringGateway('Nothing to change.\n\n{"scope":"workspace","summary":"nothing","edits":[]}'));
    await workspace.agent.activateActor();
    const actorId = harnessActorId(workspace.db);
    const now = Date.now();
    workspace.db.prepare(`INSERT INTO refinement_requests
      (actor_id, id, trigger, scope, stage, claim, turn_ids, debt_key, proposal, routes, detail, created_at, updated_at)
      VALUES (?, 'refine-1', 'explicit', 'workspace', 'requested', NULL, '[]', NULL, NULL, '[]', 'opened', ?, ?)`).run(actorId, now, now);

    const refiner = await hostedSubordinateHarness(workspace, {
      name: 'ask-refiner-x1', displayName: 'Refiner', nameOrigin: 'auto', mission: 'propose refinements', origin: 'evolution',
    });

    workspace.db.prepare(`INSERT INTO actor_subordinates (actor_id, name, status, current_task, created_at, dismissed_at,
      lifetime, task_event_id, actor_reference, birth_request, delete_requested)
      VALUES (?, 'ask-refiner-x1', 'working', 'review', ?, NULL, 'task', 'evt-1', ?, NULL, 0)`)
      .run(actorId, now, JSON.stringify(refiner.actor.reference));
    workspace.db.prepare(`INSERT INTO evolution_helpers (actor_id, name, lane_request_id, created_at)
      VALUES (?, 'ask-refiner-x1', 'refine-1', ?)`).run(actorId, now);
    expect(armedAt(workspace.db, KINU_TIMER_JOB)).toEqual([]);

    await runDelegatedTask(workspace, refiner.actor.handle.actorId, 'Review the recent turns.');
    expect(held(workspace.db, `SELECT COUNT(*) AS held FROM evolution_helpers WHERE answer_status = 'completed'`)).toBe(1);
    await until(() => armedAt(workspace.db, KINU_TIMER_JOB).length > 0, 'the relayed answer armed the Kinu wake');

    await workspace.agent._kinuTimerTick();
    await joinHarnessFibers();
    expect((await workspace.agent.listRefinements(1)).requests[0]?.stage).not.toBe('requested');
  });
});

describe('the workspace keeps exactly one wake per job', () => {
  test('a beyond-budget FIBER backlog also arms the wake, and the wake drains it', async () => {
    const { agent, db, started } = orchestratorHarness();
    await started;
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
    expect(wakeArmed(db)).toBe(true);

    await agent.terminalRetryPass();
    expect(held(db, seededFibers)).toBe(0);
  });

  test('an activation whose fiber sweep finished does not sweep again on its ticks', async () => {
    // 2026-09-28: the sweep ran on every tick, so a retry tick inside a turn read the fiber table again.
    const { agent, db, started } = orchestratorHarness();
    await started;
    await agent.activateActor();
    const expired = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES ('after-sweep', 'bg:stale', NULL, ?)`).run(expired);

    await agent.terminalRetryPass();

    // The next activation's sweep takes it.
    expect(held(db, "SELECT COUNT(*) AS held FROM cf_agents_runs WHERE id = 'after-sweep'")).toBe(1);
  });

  test('a quiet turn keeps the wake a truncated sweep still needs', async () => {
    // Unfinished maintenance is found only by running a pass, so a turn settling over it must not take its wake.
    const workspace = gatewayWorkspace(answeringGateway('done'));
    const { agent, db } = workspace;
    await workspace.started;
    db.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT, created_at INTEGER NOT NULL)`);

    const insert = db.prepare(`INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)`);
    const expired = Date.now() - 25 * 60 * 60 * 1000;

    for (let i = 0; i < 4096 + 40; i++) insert.run(`fiber-${i}`, 'bg:stale', expired);

    await agent.activateActor();
    await until(() => wakeArmed(db), 'the truncated fiber sweep armed the maintenance wake');

    await catalogTurn(agent, 'a turn over an unfinished sweep');
    await joinHarnessFibers();

    expect(wakeArmed(db)).toBe(true);
    await agent.terminalRetryPass();
    expect(held(db, `SELECT COUNT(*) AS held FROM cf_agents_runs WHERE id LIKE 'fiber-%'`)).toBe(0);
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
    expect(armedAt(workspace.db, TERMINAL_RETRY_JOB)).toHaveLength(1);

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
    expect(armedWakes(workspace.db)).toEqual([]);

    const now = Date.now();
    const resumeAt = now + 60_000;
    workspace.db.prepare(
      `INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, input_json, resume_after, created_at)
       VALUES (?, 'job-waiting', 'agents', 'build', 'running', '{}', ?, ?)`,
    ).run(child.actor.handle.actorId, resumeAt, now);

    await workspace.agent.activateActor();
    await until(() => wakeArmed(workspace.db), 'the activation armed a wake for the child\'s owed job');

    const armed = armedAt(workspace.db, TERMINAL_RETRY_JOB);
    expect(armed).toHaveLength(1);
    // Immediate and not the instant: counting rows alone cannot tell armed from stranded.
    expect(armed[0]).not.toBe(landing(resumeAt));

    await fireSoonestWake(workspace.agent, workspace.db);

    // Exactly one wake at the job's own instant; the job's wake and the retry's wake collapse.
    expect(armedAt(workspace.db, TERMINAL_RETRY_JOB)).toEqual([landing(resumeAt)]);
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

    expect(armedAt(db, TERMINAL_RETRY_JOB)).toEqual([landing(resumeAt)]);
  });

  test('a failed re-arm leaves the previous wake in place', async () => {
    // KINU-N003 (first half): a refused write replaces nothing, so a failure leaves the old wake, not zero.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const before = armedWakes(db);
    expect(before.map((wake) => wake.id)).toEqual([KINU_TIMER_JOB]);

    breakWakeWrites(db);
    await expect(agent.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'soon' }))
      .rejects.toThrow('storage write failed');

    expect(armedWakes(db)).toEqual(before);
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
           (actor_id, root_id, task, status, config_json, created_at, updated_at)
         VALUES (?, ?, 'search the space', 'running', '{}', ?, ?)`,
      ).run(actorId, root, createdAt, createdAt);
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
    // The delay is baked into the job's time, so nothing can shorten an armed wake.
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

    // The queue deletes a job its pass did not re-arm; without that a soonest-wins arm never ramps.
    const fireArmedTick = async (): Promise<number> => {
      // The first lap has no wake yet: the backlog was seeded after activation armed nothing.
      if (wakeArmed(db)) await fireSoonestWake(agent, db);
      else await agent.terminalRetryPass();

      const firedAt = Date.now();
      const [armed] = armedAt(db, TERMINAL_RETRY_JOB);

      return armed === undefined ? 0 : armed - firedAt;
    };

    setSystemTime(new Date(Date.now()));
    const first = await fireArmedTick();
    expect(first).toBeGreaterThan(1000);

    const second = await fireArmedTick();
    expect(second).toBeGreaterThan(first);

    expect(await fireArmedTick()).toBeGreaterThan(second);
    expect(await fireArmedTick()).toBe(0);
  });

  // eval-trajectory-evals-pu-eedw1v and warm-forge-4d6acc02, 2026-09-26: their only true arm was admittedDelegations, a
  // task row for an actor the drain never visits, which woke each object every lap for days.
  test('a task for an actor that is gone settles with a reason and stops owing a wake', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();

    db.prepare(
      `INSERT INTO agent_log (actor_id, id, kind, variant, trace_id, payload, received_at)
       VALUES ('gone-actor', 'orphan-task', 'event', 'subordinate_task', 'trace-orphan', '{"body":"brief"}', ?)`,
    ).run(Date.now());

    await agent.terminalRetryPass();
    await joinHarnessFibers();

    expect(orphanRow(db, 'orphan-task')).toMatchObject({ step_idx: -2, dismissed: 'its actor is retired or gone' });
    expect(wakeArmed(db)).toBe(false);
  });

  test('a task left for a retired hire settles, and a live hire\'s task still runs', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await joinHarnessFibers();
    await agent.setSoul('# Purpose\n\nDo each task asked.');
    const { subordinate: retired } = await agent.createSubordinateAgent();
    const { subordinate: live } = await agent.createSubordinateAgent();

    if (retired.actorId === null || live.actorId === null) throw new Error('the added agents have no actors');
    await agent.dismissSubordinate(retired.name, true);

    const insert = db.prepare(
      `INSERT INTO agent_log (actor_id, id, kind, variant, trace_id, payload, payload_visibility, received_at)
       VALUES (?, ?, 'event', 'subordinate_task', 'trace-left', '{"body":"brief","kinu_mode":"build"}', 'full', ?)`,
    );

    insert.run(retired.actorId, 'left-task', Date.now());
    insert.run(live.actorId, 'live-task', Date.now());

    await agent.terminalRetryPass();
    await joinHarnessFibers();

    expect(orphanRow(db, 'left-task')).toMatchObject({ step_idx: -2, dismissed: 'its actor is retired or gone' });
    expect(orphanRow(db, 'live-task').step_idx).not.toBe(-2);
  });

  // eval-trajectory-evals-pu-eedw1v, 2026-09-22 to 26: one arm stayed true, each ~30 s the idle object was evicted
  // and the in-memory ramp restarted at 2 s, so it woke ~8 times a minute for days instead of at the 60 s ceiling.
  test('evictions between unfinished laps neither shorten the pace nor lift its ceiling', async () => {
    const { db } = orchestratorHarness();
    const lapDelays: number[] = [];
    // Each lap fires at its job's own instant on a frozen clock, as the platform delivers it, so a delay is
    // the product's pace and never a wall read taken mid-tick.
    let at = Date.now();

    try {
      for (let lap = 0; lap < 8; lap++) {
        setSystemTime(new Date(at));
        // Every lap is a fresh activation over the same storage, as the platform's idle eviction makes it.
        const { agent } = await reactivateOrchestratorHarness(db);
        // Work still running in this activation keeps the lap unfinished.
        liveHead(db, `lap-${String(lap)}`);

        // The first lap starts the chain; each later lap fires the wake the lap before armed.
        if (wakeArmed(db)) await fireSoonestWake(agent, db);
        else await agent.terminalRetryPass();

        const [next] = armedAt(db, TERMINAL_RETRY_JOB);

        if (next === undefined) throw new Error(`lap ${String(lap)} left no wake`);
        lapDelays.push(next - at);
        at = next;
      }
    } finally {
      setSystemTime();
    }

    for (let lap = 1; lap < lapDelays.length; lap++) expect(lapDelays[lap]).toBeGreaterThanOrEqual(lapDelays[lap - 1] ?? 0);
    const ceiling = recoveryBackoffMs(Infinity);
    expect(lapDelays.at(-1)).toBe(ceiling);
    expect(Math.max(...lapDelays)).toBe(ceiling);
  });

  test('an unfinished streak names its arms once, however many laps, and a new streak names them again', async () => {
    const { db, agent: first } = orchestratorHarness();
    const recorder = createRecordingLogger();
    let running = true;
    let laps = 0;
    const start = Date.now();
    let activations = 0;

    const lap = async (): Promise<void> => {
      // A minute per activation: the lap before's head is older than this activation, so its recovery sweeps it.
      setSystemTime(new Date(start + ++activations * 60_000));
      const { agent } = await reactivateOrchestratorHarness(db);

      if (running) liveHead(db, `streak-${String(laps++)}`);
      // Each activation installs its own sink, so the recorder is tapped per activation.
      const untap = tapDiagnostics(recorder);

      try {
        if (wakeArmed(db)) await fireSoonestWake(agent, db);
        else await agent.terminalRetryPass();
      } finally {
        untap();
      }
    };

    try {
      for (let i = 0; i < 5; i++) await lap();

      // The streak ends: a lap with nothing owed, since a new activation errors the heads a dead one left.
      running = false;
      await lap();
      running = true;

      for (let i = 0; i < 3; i++) await lap();
    } finally {
      setSystemTime();
    }

    const named = recorder.emitted.filter((line) => line.event === 'wake.unfinished_arms');

    expect(named).toHaveLength(2);

    for (const line of named) {
      // `workspace` and `source` are what its fleet row keeps; the arm flags stay in the log.
      expect(line.fields).toMatchObject({
        unfinishedHeads: true, admittedDelegations: false, sweeps: false, chatLoop: false,
        workspace: first.name, source: 'unfinishedHeads',
      });
    }
  });

  test('a tick killed after its arm and before its drain still leaves the wake', async () => {
    // Arm-first: the next-lap row is durable before any pass runs, so a failing roster row cannot end the chain.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();

    // Real input: `birth_request` is JSON-parsed on read mid-tick, after the arm and before the drain.
    db.prepare(
      `INSERT INTO actor_subordinates
        (actor_id, name, status, current_task, created_at, dismissed_at,
         lifetime, task_event_id, actor_reference, birth_request, delete_requested)
       VALUES (?, 'poisoned-birth', 'idle', NULL, ?, NULL, 'durable', NULL, NULL, '{malformed', 0)`,
    ).run(harnessActorId(db), Date.now());

    await expect(agent.terminalRetryPass()).rejects.toThrow('malformed');

    // The pass's own next-lap arm stands: its streak is on the one wake.
    expect(armedWakes(db).filter((wake) => wake.id === TERMINAL_RETRY_JOB).map((wake) => wake.payload))
      .toEqual([{ laps: 1, arms: null }]);
  });

  test('a tick with nothing owed releases the wake it armed', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    expect(armedWakes(db)).toEqual([]);

    await agent.terminalRetryPass();

    expect(armedWakes(db)).toEqual([]);
  });

  test('a turn that settles with nothing owed leaves no wake armed', async () => {
    // Rest: the turn-open arm and the terminal sequence's pre-attempt arm both go once nothing is owed, so no wake
    // follows the turn only to find nothing (S4, kinu-logs/onstart/DESIGN.md).
    const workspace = gatewayWorkspace(answeringGateway('done'));
    await workspace.agent.activateActor();

    await catalogTurn(workspace.agent, 'a turn with nothing after it');
    await joinHarnessFibers();

    expect(armedWakes(workspace.db)).toEqual([]);
  });

  test('a tick that cannot re-arm fails, and its wake comes back later instead of ending the chain', async () => {
    // KINU-N003 (second half): a re-arm failure must fail the tick; the other phases stay tolerated.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    db.prepare('UPDATE cf_agents_jobs SET time = ? WHERE id = ?').run(Date.now() - 1000, KINU_TIMER_JOB);
    breakWakeWrites(db);
    const recorder = createRecordingLogger();
    const untap = tapDiagnostics(recorder);

    try {
      await agent.alarm();
    } finally {
      untap();
    }

    const failed = recorder.emitted.filter((line) => line.event === 'schedule.wake_failed');
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain('re-arming the wake that keeps the timer chain alive');
    // Retried after every in-process attempt failed: the chain survives at the capped backoff.
    expect(armedAt(db, KINU_TIMER_JOB)[0]).toBeGreaterThanOrEqual(Date.now() + recoveryBackoffMs(Infinity) - 1000);
  });

  test('an activation restores a wake that went missing', async () => {
    // Redelivery is bounded, so activation reconstructs the derived wake.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    db.prepare('DELETE FROM cf_agents_jobs WHERE id = ?').run(KINU_TIMER_JOB);
    expect(armedWakes(db)).toEqual([]);
    // Through activation, not the arm itself: an onStart that stopped re-deriving must fail this.
    await agent.activateActor();
    await until(() => armedAt(db, KINU_TIMER_JOB).length > 0, 'the activation restored the timer wake');

    expect(armedWakes(db).map((wake) => wake.id)).toEqual([KINU_TIMER_JOB]);
  });

  test('an activation cannot invent a wake nothing is waiting for', async () => {
    const { agent, db } = orchestratorHarness();

    await agent.activateActor();
    await joinHarnessFibers();

    expect(armedWakes(db)).toEqual([]);
  });

  test('an armed wake is left alone, however overdue', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const overdue = Date.now() - 2 * DAY_MS;
    db.prepare('UPDATE cf_agents_jobs SET time = ? WHERE id = ?').run(overdue, KINU_TIMER_JOB);

    await agent.activateActor();
    await joinHarnessFibers();

    expect(armedAt(db, KINU_TIMER_JOB)).toEqual([overdue]);
  });

  test('a due wake no tick is running counts as armed: it fires now, and its pass re-arms the later work', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const due = Date.now() - 5000;
    db.prepare('UPDATE cf_agents_jobs SET time = ? WHERE id = ?').run(due, KINU_TIMER_JOB);

    await agent.createTimerTrigger({ atMs: Date.now() + 2 * DAY_MS, label: 'later' });

    expect(armedAt(db, KINU_TIMER_JOB)).toEqual([due]);
  });

  test('restarts that each died inside their wake leave one wake, run once, not one per restart', async () => {
    // warm-forge-4d6acc02, 2026-09-25: each 15-minute alarm wall kill left its row and its armed next lap due, and the
    // next activation armed a fresh row over them, until one alarm read 57 due ticks. A job is keyed by its id.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    const turns = chatSessionTurns(agent);

    await turns.prepare({ messages: [{ role: 'user', content: 'a turn the restarts interrupt' }] });

    for (let restart = 0; restart < 5; restart++) {
      // Killed mid-dispatch: the wake due and still marked running, as the SDK's driver leaves it.
      db.prepare('UPDATE cf_agents_jobs SET time = ?, running = 1 WHERE id = ?').run(Date.now() - 60_000, TERMINAL_RETRY_JOB);
      await agent.activateActor();
      await joinHarnessFibers();
    }

    expect(held(db, "SELECT COUNT(*) AS held FROM cf_agents_jobs WHERE capability = 'kinu-wakes'")).toBe(1);
    let passes = 0;
    const pass = agent.terminalRetryPass.bind(agent);

    Object.defineProperty(agent, 'terminalRetryPass', {
      configurable: true,
      value: async (...args: Parameters<typeof pass>) => {
        passes += 1;
        await pass(...args);
      },
    });
    await agent.alarm();

    expect(passes).toBe(1);
  });

  test('a root turn arms the wake when it opens', async () => {
    // An opened turn owes nothing yet but must leave exactly one wake (riding the terminal-retry job).
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    expect(armedWakes(db)).toEqual([]);

    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn that opens' }] });

    expect(armedAt(db, TERMINAL_RETRY_JOB)).toHaveLength(1);

    // Settle so the pump finishes inside this test.
    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a tick that fires inside a parked turn keeps a wake', async () => {
    // An open turn is untimed owed work: a finished pass must keep its wake.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    expect(armedWakes(db)).toEqual([]);

    const turns = chatSessionTurns(agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn the tick fires inside' }] });

    expect(armedAt(db, TERMINAL_RETRY_JOB)).toHaveLength(1);
    await fireSoonestWake(agent, db);

    const kept = armedAt(db, TERMINAL_RETRY_JOB);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBeGreaterThan(Date.now());

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('a turn-open wake does not fire inside an ordinary turn', async () => {
    // The turn-open arm is set at the recovery ceiling, after any ordinary turn.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();

    const turns = chatSessionTurns(agent);
    const openedAt = Date.now();
    setSystemTime(new Date(openedAt));
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'a turn that opens' }] });

    expect(armedAt(db, TERMINAL_RETRY_JOB)).toEqual([landing(openedAt + recoveryBackoffMs(Infinity))]);

    await turns.settle({ messageId: request.identity.messageId, text: 'done' });
  });

  test('an email the binding refused is retried by the one future timer wake', async () => {
    // The mail outbox arms the Kinu timer like every other wake, awaited: a lost arm drops the receipt silently.
    const refusals: string[] = [];

    const { agent, db } = orchestratorHarness(
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

    const admission = await agent.acceptEmailDelivery({
      from: 'owner@example.com', to: 'workspace@kinu.run', subject: 'status?', body_text: 'how is the deploy?',
      message_id: '<m-1@example.com>', in_reply_to: null, references: null, attachments: [], now: Date.now(),
    });

    expect(admission).toMatchObject({ admitted: true, duplicate: false });
    expect(refusals).toEqual(['send']);

    // The inbound email's drain wake lands on the next second as the retry is armed; it fires then and its pass
    // re-derives the retry from the outbox, so the retry rides that one wake.
    const wakes = armedAt(db, KINU_TIMER_JOB);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toBeLessThanOrEqual(landing(Date.now()) + 1000);
  });

  test('two concurrent arms converge on ONE wake, the earliest', async () => {
    // `onStart` detaches its arm, so concurrent arms interleave; the pair must leave the sooner wake.
    const { agent, db } = orchestratorHarness();
    const soonerMs = Date.now() + 2 * DAY_MS;

    await Promise.all([
      agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' }),
      agent.createTimerTrigger({ atMs: soonerMs, label: 'sooner' }),
    ]);

    expect(armedAt(db, KINU_TIMER_JOB)).toEqual([landing(soonerMs)]);
  });
});
