// Defends: an agent the panel cannot see, a hired or background agent given a tab or a composer, a swarm worker
// left out or shown working after its run ended, and a chat that needs the person or failed reading idle.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { initHeadsTables } from '../src/heads/schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initActorClaimTables } from '../src/orchestrator/actor-claims';
import { SubordinateRosterStore } from '../src/subordinates/roster';
import { actorReferenceOf, type ActorHandle } from '../src/identity/actor-handle';
import type { SubordinateRosterEntry } from '../src/delegation/agents-tool';
import { readWorkspaceAgents, type PanelAgent } from '../src/read-models/workspace-agents';
import { OWNER_STOPPED } from '../src/heads/types';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { readAgentFigures } from '../src/read-models/agent-figures';
import { EventLog, initEventsHubTables, type EmailPayload } from '../src/events/hub/index';
import { admitSubordinateTask } from '../src/subordinates/support';
import { initDeferredApprovalsTable } from '../src/safety/deferred-approval';
import { initPlanReviewTable } from '../src/plans/review';

const EMAIL: EmailPayload = {
  from: 'owner@example.com', to: 'kinu@agents.example.com', subject: 'Status?', body_text: 'Is staging green?',
  message_id: '<msg-1@example.com>', in_reply_to: null, references: null, attachments: [],
};

function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const exec = makeSqlExec(db);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw);
  initSwarmNodeRecords(execRaw);
  initActorClaimTables(execRaw);
  initEventsHubTables(exec);
  initRunEventTables(execRaw);
  const actors = createTestActors(sql, execRaw);
  new SubordinateRosterStore(exec, actors.main).ensureSchema();

  const hire = (parent: ActorHandle, name: string, entry: Partial<SubordinateRosterEntry>): ActorHandle => {
    const { origin = 'agent', lifetime = 'durable', ...rest } = entry;
    const child = actors.directory.create({ parent, name, origin, lifetime, creationId: name });

    new SubordinateRosterStore(exec, parent).create({
      name, actorReference: actorReferenceOf(child), birth: null, deleteRequested: false,
      status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, taskEventId: null, ...rest,
    });

    return child;
  };

  const read = (queued = false): Promise<PanelAgent[]> => readWorkspaceAgents({
    sql, exec, root: actors.main, actors: actors.directory.list({ retired: true }),
    figures: (actorIds) => readAgentFigures(sql, actorIds), queued,
  });

  const openTurn = (actor: ActorHandle): void => {
    db.query(`INSERT INTO actor_turn_claims (actor_id, turn_id, run_id, epoch, work_mode, program_kind, program_version, outcome, claimed_at)
      VALUES (?, ?, 'run', 0, 'build', 'builtin', 1, NULL, 1)`).run(actor.actorId, `turn-${actor.name}`);
  };

  /** One turn through the real recorder: each step's usage and price, `minutes` of wall clock from its start to its end. */
  const turn = (actor: ActorHandle, runId: string, minutes: number, steps: readonly { input: number; output: number; cacheRead: number; usd: number }[]): void => {
    const recorder = new RunEventRecorder(sql, actor);
    const start = Date.parse('2026-09-30T10:00:00.000Z');

    setSystemTime(start);
    recorder.emit(runId, { type: 'turn_start', turnIndex: 0 });

    for (const [stepIndex, { usd, ...usage }] of steps.entries()) recorder.emit(runId, { type: 'step_finish', stepIndex, usage, usd });

    setSystemTime(start + minutes * 60_000);
    recorder.emit(runId, { type: 'turn_end', turnIndex: 0 });
    setSystemTime();
  };

  return { db, exec, main: actors.main, hire, read, openTurn, turn };
}

const byLabel = <T extends { label: string }>(rows: T[]): T[] => rows.sort((a, b) => a.label.localeCompare(b.label));

/** The parent named by its label, so a row reads the same whatever ids the directory minted. */
const rows = (listed: readonly PanelAgent[]) => listed.map(({ label, category, activity, parent, tab, input, open }) => ({
  label, category, activity, parent: listed.find((agent) => agent.key === parent)?.label ?? null, tab, input, open,
}));

describe('the Agents panel lists every agent in the workspace', () => {
  test('the owner\'s own, one an agent hired, and a background helper, each placed as the design says', async () => {
    const { db, main, hire, read, openTurn } = workspace();
    const alice = hire(main, 'alice', { origin: 'user' });
    openTurn(hire(alice, 'scout-1', {}));
    hire(main, 'refiner-1', { origin: 'evolution', lifetime: 'task' });
    openTurn(hire(main, 'lookup-1', { lifetime: 'task' }));
    hire(main, 'reviewer', {});
    db.query('UPDATE workspace_actors SET created_at = 0 WHERE name = ?').run('scout-1');

    expect(byLabel(rows(await read()))).toEqual(byLabel([
      { label: 'Main', category: 'main', activity: 'idle', parent: null, tab: true, input: true, open: { kind: 'chat', path: null } },
      { label: 'alice', category: 'user', activity: 'idle', parent: 'Main', tab: true, input: true, open: { kind: 'chat', path: 'alice' } },
      { label: 'scout-1', category: 'hired', activity: 'working', parent: 'alice', tab: false, input: true, open: { kind: 'chat', path: 'alice/scout-1' } },
      { label: 'refiner-1', category: 'background', activity: 'idle', parent: 'Main', tab: false, input: false, open: { kind: 'chat', path: 'refiner-1' } },
      { label: 'lookup-1', category: 'hired', activity: 'working', parent: 'Main', tab: false, input: true, open: { kind: 'chat', path: 'lookup-1' } },
      // A durable hire talks to its parent, not the person: it never takes a tab.
      { label: 'reviewer', category: 'hired', activity: 'idle', parent: 'Main', tab: false, input: true, open: { kind: 'chat', path: 'reviewer' } },
    ]));
  });

  test('a swarm\'s workers are listed under the agent that started it: working while the run runs, read-only', async () => {
    const { db, main, read } = workspace();
    db.query('INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)').run(main.actorId, 'run-1', 'compare two parsers', 10);

    const head = db.query(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (?, ?, NULL, 'run-1', 0, ?, 'r', ?, ?, 'synthesize')`);

    head.run(main.actorId, 'h-a', 'Try the PEG parser', 'running', 11);
    head.run(main.actorId, 'h-b', 'Try the Pratt parser', 'completed', 12);

    const workers = rows(await read()).filter((agent) => agent.category === 'swarm');

    expect(workers).toEqual([
      { label: 'Try the PEG parser', category: 'swarm', activity: 'working', parent: 'Main', tab: false, input: false, open: { kind: 'node', runId: 'run-1', nodeId: 'h-a', owner: null } },
      { label: 'Try the Pratt parser', category: 'swarm', activity: 'done', parent: 'Main', tab: false, input: false, open: { kind: 'node', runId: 'run-1', nodeId: 'h-b', owner: null } },
    ]);
  });

  test('only a worker its owner stopped reads stopped; one cut off with its search or that errored reads failed', async () => {
    const { db, main, read } = workspace();
    db.query('INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)').run(main.actorId, 'run-1', 'compare two parsers', 10);

    const head = db.query(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, error_message, spawned_at, merge_strategy)
      VALUES (?, ?, NULL, 'run-1', 0, ?, 'r', ?, ?, ?, 'synthesize')`);

    head.run(main.actorId, 'h-a', 'Try the PEG parser', 'aborted', OWNER_STOPPED, 11);
    head.run(main.actorId, 'h-b', 'Try the Pratt parser', 'aborted', 'the search was aborted', 12);
    head.run(main.actorId, 'h-c', 'Try a hand-written parser', 'errored', 'the model refused', 13);

    expect((await read()).filter((agent) => agent.category === 'swarm').map((agent) => [agent.label, agent.activity])).toEqual([
      ['Try the PEG parser', 'stopped'],
      ['Try the Pratt parser', 'failed'],
      ['Try a hand-written parser', 'failed'],
    ]);
  });

  test('an agent is working while it holds an open turn, whatever its roster row last said', async () => {
    const { db, main, hire, read, openTurn } = workspace();
    const chatting = hire(main, 'chatting', { origin: 'user', status: 'idle' });
    openTurn(chatting);

    expect((await read()).find((agent) => agent.label === 'chatting')?.activity).toBe('working');

    db.query("UPDATE actor_turn_claims SET outcome = 'indeterminate' WHERE turn_id = 'turn-chatting'").run();
    expect((await read()).find((agent) => agent.label === 'chatting')?.activity).toBe('idle');
  });

  // Staging f75f06932, 2026-10-01: the eval's settle called five trials quiet on two idle reads a second apart, while
  // each owed a turn it had not claimed (a helper's admitted task, its report to the lead, a job's wake). From the
  // moment a turn is owed, the agent it is owed to reads working.
  test('an agent owed a turn it has not claimed reads working', async () => {
    const { exec, main, hire, read } = workspace();
    const helper = hire(main, 'counter-1', { lifetime: 'task' });
    const activity = async (queued = false) => Object.fromEntries((await read(queued)).map((agent) => [agent.label, agent.activity]));

    expect(await activity()).toEqual({ Main: 'idle', 'counter-1': 'idle' });

    // The lead's chat queued a turn (a job's wake) it has not claimed.
    expect((await activity(true)).Main).toBe('working');

    // The helper was handed a task its drain has not run.
    admitSubordinateTask(new EventLog(exec, helper), { fromWorkspace: helper.workspaceId, kind: 'task', body: 'Count the files.', mode: 'build', now: Date.now() });
    expect((await activity())['counter-1']).toBe('working');

    // An email reached the lead, and the drain that takes it has not run.
    new EventLog(exec, main).publish({ descriptor: { ingress: 'email_inbound', variant: 'email', sender_class: 'owner', payload: EMAIL }, now: Date.now() });
    expect((await activity()).Main).toBe('working');
  });

  test('a chat that asks the person reads waiting, even mid-turn, and one whose last turn failed reads failed until the next starts', async () => {
    const { db, main, hire, read, openTurn } = workspace();
    const alice = hire(main, 'alice', { origin: 'user' });
    const scout = hire(main, 'scout', {});
    const activity = async () => Object.fromEntries((await read()).map((agent) => [agent.label, agent.activity]));

    const claim = db.query(`INSERT INTO actor_turn_claims (actor_id, turn_id, run_id, epoch, work_mode, program_kind, program_version, outcome, claimed_at)
      VALUES (?, ?, 'run', 0, 'build', 'builtin', 1, ?, ?)`);

    initDeferredApprovalsTable(makeExecRaw(db));
    initPlanReviewTable(makeExecRaw(db));
    openTurn(alice);
    db.query(`INSERT INTO deferred_approvals (actor_id, id, command, reason, status, requested_at) VALUES (?, 'd1', 'rm -rf build', 'deletes files', 'queued', 1)`).run(alice.actorId);
    db.query(`INSERT INTO plan_reviews (actor_id, id, session_id, revision, content, status, created_at, updated_at) VALUES (?, 'p1', 's', 1, '# Plan', 'pending', 1, 1)`).run(main.actorId);
    claim.run(scout.actorId, 't1', 'error', 5);

    expect(await activity()).toEqual({ Main: 'waiting', alice: 'waiting', scout: 'failed' });

    db.query(`UPDATE deferred_approvals SET status = 'approved'`).run();
    db.query(`UPDATE plan_reviews SET status = 'approved'`).run();
    claim.run(scout.actorId, 't2', null, 6);

    expect(await activity()).toEqual({ Main: 'idle', alice: 'working', scout: 'working' });

    db.query(`UPDATE actor_turn_claims SET outcome = 'completed' WHERE turn_id = 't2'`).run();
    expect((await activity()).scout).toBe('idle');
  });

  test('a worker still running in an old swarm stays listed past the newest twenty runs', async () => {
    const { db, main, read } = workspace();
    const run = db.query('INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)');

    const head = db.query(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (?, ?, NULL, ?, 0, ?, 'r', ?, ?, 'synthesize')`);

    run.run(main.actorId, 'old', 'a long job', 1);
    head.run(main.actorId, 'old-h', 'old', 'Still grinding', 'running', 1);

    for (let i = 0; i < 25; i += 1) {
      run.run(main.actorId, `run-${String(i)}`, 'r', 100 + i);
      head.run(main.actorId, `h-${String(i)}`, `run-${String(i)}`, `Finished ${String(i)}`, 'completed', 100 + i);
    }

    const workers = (await read()).filter((agent) => agent.category === 'swarm');

    expect(workers.find((agent) => agent.label === 'Still grinding')?.activity).toBe('working');
    expect(workers.filter((agent) => agent.label.startsWith('Finished'))).toHaveLength(20);
  });

  test('each agent shows what its own turns cost: tokens, dollars, time and the prompt-cache EMA', async () => {
    const { main, hire, read, turn } = workspace();
    const alice = hire(main, 'alice', { origin: 'user' });

    turn(alice, 'run-a', 3, [
      { input: 1000, output: 200, cacheRead: 0, usd: 0.01 },
      { input: 2000, output: 100, cacheRead: 1800, usd: 0.02 },
    ]);
    turn(main, 'run-m', 1, [{ input: 500, output: 50, cacheRead: 400, usd: 0.005 }]);

    const listed = await read();
    const figures = (label: string) => listed.find((agent) => agent.label === label)?.figures;

    // The EMA seeds on the first rate (0) and moves α = 0.2 toward the second (0.9).
    expect(figures('alice')).toEqual({ tokens: 3300, usd: 0.03, activeMs: 180_000, cacheEma: 0.2 * 0.9 });
    expect(figures('Main')).toEqual({ tokens: 550, usd: 0.005, activeMs: 60_000, cacheEma: 0.8 });
  });

  test('an agent that has not run shows no figures, not zeros', async () => {
    const { main, hire, read } = workspace();
    hire(main, 'idle-one', { origin: 'user' });

    expect((await read()).find((agent) => agent.label === 'idle-one')?.figures).toEqual({ activeMs: 0, cacheEma: null });
  });
});
