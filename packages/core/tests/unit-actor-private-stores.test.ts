/**
 * The five actor-private store families, over ONE real workspace database.
 *
 * Every case here runs against a single `initWorkspaceSchema` SQLite holding
 * TWO issued actors — a main and a real subordinate of it, both from the
 * production `WorkspaceActorDirectory`. That is the shape the scoping exists
 * for and the only shape that can falsify it: with a database per actor these
 * assertions all pass vacuously, because the rows were never in the same table.
 *
 * The keys collide ON PURPOSE. A fact key is model-authored prose, a task id is
 * `t{seq}` from a per-actor sequence, a job id is chosen by its caller, and a
 * head id is DERIVED from a branch point and slot rather than minted — so two
 * actors doing the same work really do present the same identifiers, and "the
 * ids happen to differ" is not available as a reason these rows stay apart.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors, type TestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor } from '../src/types/primitives';
import { createFactsStore } from '../src/memory/facts';
import { TaskListStore, readPlanTasks } from '../src/tasks/store';
import { runTaskPlan, type TaskPlan } from '../src/tasks/plan-scope';
import { HeadJournal } from '../src/heads/journal';
import { BackgroundJobStore } from '../src/jobs/store';
import { MctsSearchStore } from '../src/mcts/search-store';
import { StaleCursorError } from '../src/read-models/page';
import type { HeadInput } from '../src/heads/types';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

interface World {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly actors: TestActors;
  readonly a: ActorHandle;
  readonly b: ActorHandle;
  close(): void;
}

/** One production-schema database, two issued actors, one SQL handle. */
function world(): World {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db) });
  const actors = createTestActors(sql, execRaw);
  return {
    db, sql, actors,
    a: actors.main,
    b: actors.sibling('sibling'),
    close: () => db.close(),
  };
}

/** A task list bound to one actor, over the world's real transaction seam —
 *  `transactionSync` stays required because a task and its plan link are one
 *  fact. */
function tasks(w: World, actor: ActorHandle): TaskListStore {
  return new TaskListStore(w.sql, actor, (write) => w.db.transaction(write)());
}

function headInput(id: string, rootId: string, task: string, spawnedAt: number): HeadInput {
  return {
    id, parentId: null, rootId, depth: 1, task, rationale: task,
    mode: 'build', inheritedContext: [], mergeStrategy: 'synthesize',
    budget: { spawnedAt, maxDepth: 2 },
    loop: defaultLoopOrigin('head'),
  };
}

describe('two actors, one database: agent_facts', () => {
  test('the same fact key holds a different value for each actor', () => {
    const w = world();
    const a = createFactsStore(w.sql, w.a);
    const b = createFactsStore(w.sql, w.b);

    expect(a.upsert('deploy target', 'a.workers.dev')).toBe('created');
    // 'created', not 'changed': B has never written this key, however loudly A did.
    expect(b.upsert('deploy target', 'b.workers.dev')).toBe('created');

    expect(a.recall('deploy_target')?.value).toBe('a.workers.dev');
    expect(b.recall('deploy_target')?.value).toBe('b.workers.dev');
    w.close();
  });

  test('list, top-K and forget each stop at the owner', () => {
    const w = world();
    const a = createFactsStore(w.sql, w.a);
    const b = createFactsStore(w.sql, w.b);
    a.upsert('shared', 'from-a');
    a.upsert('a-only', 1);
    b.upsert('shared', 'from-b');

    expect(a.all().map((f) => f.key)).toEqual(['a-only', 'shared']);
    expect(b.all().map((f) => f.key)).toEqual(['shared']);
    expect(a.recentTopK(10)).toHaveLength(2);
    expect(b.recentTopK(10)).toHaveLength(1);

    // A forgets the colliding key. B's row is a different row and survives.
    a.forget('shared');
    expect(a.recall('shared')).toBeNull();
    expect(b.recall('shared')?.value).toBe('from-b');
    w.close();
  });
});

describe('two actors, one database: agent_tasks', () => {
  test('both actors mint t1, and neither can close the other\'s', () => {
    const w = world();
    const a = tasks(w, w.a);
    const b = tasks(w, w.b);
    const now = 1_000;

    expect(a.add(['ship it'], null, now).added.map((t) => t.id)).toEqual(['t1']);
    // The sequence is the owner's, so B starts at t1 too rather than continuing A's.
    expect(b.add(['audit it'], null, now).added.map((t) => t.id)).toEqual(['t1']);

    expect(a.get('t1')?.title).toBe('ship it');
    expect(b.get('t1')?.title).toBe('audit it');

    expect(a.setStatus('t1', 'done', now + 1)?.status).toBe('done');
    expect(b.get('t1')?.status).toBe('open');
    w.close();
  });

  test('list, count and the open roster carry only the owner\'s items', () => {
    const w = world();
    const a = tasks(w, w.a);
    const b = tasks(w, w.b);
    a.add(['one', 'two'], null, 1_000);
    b.add(['other'], null, 1_000);

    expect(a.count()).toBe(2);
    expect(b.count()).toBe(1);
    expect(a.list().map((t) => t.title)).toEqual(['one', 'two']);
    expect(b.list().map((t) => t.title)).toEqual(['other']);
    expect(a.listOpen().total).toBe(2);
    expect(b.listOpen().total).toBe(1);
    w.close();
  });

  test('a subtask nests under its own parent and cannot adopt a foreign one', () => {
    const w = world();
    const a = tasks(w, w.a);
    const b = tasks(w, w.b);
    a.add(['parent'], null, 1_000);
    b.add(['b parent'], null, 1_000);

    const nested = a.add(['child'], 't1', 1_001);
    expect(nested.added.map((t) => t.parentId)).toEqual(['t1']);
    expect(a.list()[0]?.subtasks.map((t) => t.title)).toEqual(['child']);
    expect(a.countOpenSubtasks('t1')).toBe(1);
    // B has a `t1` of its own with no children — A's subtask is not counted here.
    expect(b.countOpenSubtasks('t1')).toBe(0);

    // B names `t2`, which exists — but only in A's list. Refused, with the same
    // sentence an id nobody wrote would get, because to B it is the same fact.
    const foreign = b.add(['stolen'], 't2', 1_002);
    expect(foreign.added).toEqual([]);
    expect(foreign.rejected.map((r) => r.reason)).toEqual(['no task t2']);
    w.close();
  });

  test('one plan revision, two actors: each reads back only its own tasks', () => {
    const w = world();
    const plan: TaskPlan = { id: 'plan-1', revision: 1, sessionId: 'default' };
    const a = tasks(w, w.a);
    const b = tasks(w, w.b);
    runTaskPlan({ sql: [w.sql], plan }, () => a.add(['a step'], null, 1_000));
    runTaskPlan({ sql: [w.sql], plan }, () => b.add(['b step'], null, 1_000));

    expect(readPlanTasks(w.sql, w.a, plan).map((t) => t.title)).toEqual(['a step']);
    expect(readPlanTasks(w.sql, w.b, plan).map((t) => t.title)).toEqual(['b step']);
    w.close();
  });
});

describe('two actors, one database: background_jobs', () => {
  test('one job id, two owners — and an id alone is not authority to settle', () => {
    const w = world();
    const a = new BackgroundJobStore(w.sql, w.a);
    const b = new BackgroundJobStore(w.sql, w.b);
    const now = 5_000;
    a.create({ id: 'job-1', kind: 'agents', workMode: 'build', label: 'a work', now });
    b.create({ id: 'job-1', kind: 'agents', workMode: 'build', label: 'b work', now });

    expect(a.get('job-1')?.label).toBe('a work');
    expect(b.get('job-1')?.label).toBe('b work');

    a.settle('job-1', 0, '"done"', now + 1);
    expect(a.get('job-1')?.status).toBe('completed');
    // B holds the same id and a valid epoch. The write still misses: the row it
    // would have settled is not B's.
    expect(b.get('job-1')?.status).toBe('running');
    w.close();
  });

  test('the roster is the actor\'s, the concurrency cap is the machine\'s', () => {
    const w = world();
    const a = new BackgroundJobStore(w.sql, w.a);
    const b = new BackgroundJobStore(w.sql, w.b);
    a.create({ id: 'a1', kind: 'agents', workMode: 'build', now: 1 });
    a.create({ id: 'a2', kind: 'agents', workMode: 'build', now: 2 });
    b.create({ id: 'b1', kind: 'agents', workMode: 'build', now: 3 });

    // Two rosters, three process trees: this is the split, not a leak.
    expect(a.listRunning().items.map((j) => j.id)).toEqual(['a2', 'a1']);
    expect(a.listRunning().total).toBe(2);
    expect(b.listRunning().total).toBe(1);
    expect(a.countRunningInWorkspace()).toBe(3);
    expect(b.countRunningInWorkspace()).toBe(3);
    expect(a.hasLiveJobsInWorkspace()).toBe(true);

    // The sweep is the actor's, because everything it can act through is.
    expect(a.runningIds()).toEqual(['a1', 'a2']);
    expect(b.runningIds()).toEqual(['b1']);
    w.close();
  });

  test('the wake instant is workspace-wide, so no actor sleeps through a sibling', () => {
    const w = world();
    const a = new BackgroundJobStore(w.sql, w.a);
    const b = new BackgroundJobStore(w.sql, w.b);
    a.create({ id: 'a1', kind: 'agents', workMode: 'build', now: 1 });
    b.create({ id: 'b1', kind: 'agents', workMode: 'build', now: 1 });
    a.deferResume('a1', 9_000);
    b.deferResume('b1', 4_000);

    expect(a.nextResumeAtInWorkspace()).toBe(4_000);
    expect(a.resumeOwedIdsInWorkspace(0).sort()).toEqual(['a1', 'b1']);
    w.close();
  });

  test('clearing settled history leaves the sibling\'s history alone', () => {
    const w = world();
    const a = new BackgroundJobStore(w.sql, w.a);
    const b = new BackgroundJobStore(w.sql, w.b);
    a.create({ id: 'job-1', kind: 'agents', workMode: 'build', now: 1 });
    b.create({ id: 'job-1', kind: 'agents', workMode: 'build', now: 1 });
    a.settle('job-1', 0, '"a"', 2);
    b.settle('job-1', 0, '"b"', 2);

    a.clearSettled();
    expect(a.get('job-1')).toBeNull();
    expect(b.get('job-1')?.result).toBe('"b"');
    w.close();
  });

  test('a retry claims its own settled source, not the sibling\'s', () => {
    const w = world();
    const a = new BackgroundJobStore(w.sql, w.a);
    const b = new BackgroundJobStore(w.sql, w.b);
    a.create({ id: 'src', kind: 'agents', workMode: 'build', now: 1 });
    b.create({ id: 'src', kind: 'agents', workMode: 'build', now: 1 });
    b.settle('src', 0, '"b done"', 2);

    // A's `src` is still running, so A has nothing to retry — even though a row
    // with that id is settled one actor over.
    expect(a.createRetry({ sourceId: 'src', id: 'retry-1', kind: 'agents', workMode: 'build', input: '{}', now: 3 })).toBe(false);
    expect(b.createRetry({ sourceId: 'src', id: 'retry-1', kind: 'agents', workMode: 'build', input: '{}', now: 3 })).toBe(true);
    // Both actors may hold the same retry edge; the unique index is per owner.
    a.settle('src', 0, '"a done"', 4);
    expect(a.createRetry({ sourceId: 'src', id: 'retry-1', kind: 'agents', workMode: 'build', input: '{}', now: 5 })).toBe(true);
    w.close();
  });
});

describe('two actors, one database: the head journal', () => {
  test('one derived head id under one root id, two independent runs', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.recordSplit('root-1', 'compare two approaches', 100);
    b.recordSplit('root-1', 'compare two approaches', 100);
    a.insertSpawn(headInput('root-1-h0', 'root-1', 'A branch', 100));
    b.insertSpawn(headInput('root-1-h0', 'root-1', 'B branch', 100));

    expect(a.readHead('root-1-h0')?.task).toBe('A branch');
    expect(b.readHead('root-1-h0')?.task).toBe('B branch');
    expect(a.readTree('root-1')).toHaveLength(1);
    expect(b.readTree('root-1')).toHaveLength(1);
    w.close();
  });

  test('the live roster and the run list carry only the owner\'s heads', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.recordSplit('root-a', 'a split', 100);
    a.insertSpawn(headInput('a-h0', 'root-a', 'A0', 100));
    a.insertSpawn(headInput('a-h1', 'root-a', 'A1', 101));
    b.recordSplit('root-b', 'b split', 100);
    b.insertSpawn(headInput('b-h0', 'root-b', 'B0', 100));

    const live = a.listLive();
    expect(live.total).toBe(1);
    expect(live.items.map((r) => r.rootId)).toEqual(['root-a']);
    expect(live.items[0]?.running).toBe(2);
    expect(b.listLive().items.map((r) => r.rootId)).toEqual(['root-b']);

    expect(a.listRuns(10).map((r) => r.rootId)).toEqual(['root-a']);
    expect(b.listRuns(10).map((r) => r.rootId)).toEqual(['root-b']);
    expect(a.readRun('root-b')).toBeNull();
    w.close();
  });

  test('the task-keyed reclaim never hands one actor the other\'s root', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    // The SAME rationale text — the whole key `findResumableRun` has.
    a.recordSplit('root-a', 'design the algorithm', 100);
    b.recordSplit('root-b', 'design the algorithm', 100);

    expect(a.findResumableRun('design the algorithm')).toBe('root-a');
    expect(b.findResumableRun('design the algorithm')).toBe('root-b');
    w.close();
  });

  test('a sweep settles the owner\'s unfinished heads and no others', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.recordSplit('root-1', 'shared rationale', 100);
    b.recordSplit('root-1', 'shared rationale', 100);
    a.insertSpawn(headInput('root-1-h0', 'root-1', 'A branch', 100));
    b.insertSpawn(headInput('root-1-h0', 'root-1', 'B branch', 100));

    expect(a.markInterrupted({ spawnedBefore: 200 }, 300).map((r) => r.rootId)).toEqual(['root-1']);
    // `HeadJournalRow.status` is typed to the report statuses plus 'running';
    // 'interrupted' is a stored value that union does not name, so compare as text.
    expect(String(a.readHead('root-1-h0')?.status)).toBe('interrupted');
    expect(b.readHead('root-1-h0')?.status).toBe('running');
    expect(b.hasUnfinishedHeads()).toBe(true);

    a.abandonRunning('nothing left to run it', { spawnedBefore: 200 }, 400);
    expect(a.readHead('root-1-h0')?.status).toBe('aborted');
    expect(b.readHead('root-1-h0')?.status).toBe('running');
    w.close();
  });

  test('a trace cursor minted by one actor is stale for the other', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.insertSpawn(headInput('h0', 'root-1', 'A branch', 100));
    b.insertSpawn(headInput('h0', 'root-1', 'B branch', 100));
    for (let seq = 0; seq < 3; seq++) a.appendStep('h0', seq, { text: `a${String(seq)}`, toolCalls: [] });
    b.appendStep('h0', 0, { text: 'b0', toolCalls: [] });

    expect(a.readSteps('h0').map((s) => s.text)).toEqual(['a0', 'a1', 'a2']);
    expect(b.readSteps('h0').map((s) => s.text)).toEqual(['b0']);
    expect(a.countSteps('h0').steps).toBe(3);
    expect(b.countSteps('h0').steps).toBe(1);

    const page = a.readStepsPage('h0', { limit: 2 });
    expect(page.items.map((s) => s.text)).toEqual(['a1', 'a2']);
    expect(page.status).toBe('more');
    const cursor = page.status === 'more' ? page.next.after : null;
    expect(cursor).toBe('h0-s1');
    // The anchor names `h0-s1`, a row id B's trace also has a seq space for but
    // no row of. The walk restarts rather than resuming in someone else's trace.
    expect(() => b.readStepsPage('h0', { cursor: { after: cursor! } })).toThrow(StaleCursorError);
    w.close();
  });

  test('a re-open clears the owner\'s trace and leaves the sibling\'s', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.insertSpawn(headInput('h0', 'root-1', 'A branch', 100));
    b.insertSpawn(headInput('h0', 'root-1', 'B branch', 100));
    a.appendStep('h0', 0, { text: 'a0', toolCalls: [] });
    b.appendStep('h0', 0, { text: 'b0', toolCalls: [] });

    a.insertSpawn(headInput('h0', 'root-1', 'A branch', 500));
    expect(a.readSteps('h0')).toEqual([]);
    expect(b.readSteps('h0').map((s) => s.text)).toEqual(['b0']);
    w.close();
  });

  test('evidence and the cached merge settle under their own owner', () => {
    const w = world();
    const a = new HeadJournal(w.sql, w.a);
    const b = new HeadJournal(w.sql, w.b);
    a.insertSpawn(headInput('h0', 'root-1', 'A branch', 100));
    b.insertSpawn(headInput('h0', 'root-1', 'B branch', 100));
    a.insertEvidence('h0', { id: 'e1', kind: 'fact', body: 'from a' });
    b.insertEvidence('h0', { id: 'e1', kind: 'fact', body: 'from b' });
    expect(a.readEvidence('h0').map((e) => e.body)).toEqual(['from a']);
    expect(b.readEvidence('h0').map((e) => e.body)).toEqual(['from b']);

    a.cacheMerge('root-1', {
      mergedNarrative: 'a merged', selectedDecisions: [], unresolvedQuestions: [],
      recommendations: [], blindSpots: [], evidenceAggregate: [], headIds: [], headScores: [],
      fileChanges: [], grounded: false,
      costSummary: { headCount: 1, headsWithFindings: 0, totalTokens: undefined, totalWallClockMs: 0, maxDepth: 1 },
    }, 'synthesize');

    expect(a.readCachedMerge('root-1')?.mergedNarrative).toBe('a merged');
    expect(b.readCachedMerge('root-1')).toBeNull();
    // A settled run is no longer reclaimable — for its owner alone.
    expect(a.findResumableRun('A branch')).toBeNull();
    w.close();
  });
});

describe('two actors, one database: the search ledger', () => {
  test('one task, two searches — neither re-enters the other', () => {
    const w = world();
    const a = new MctsSearchStore(w.sql, w.a);
    const b = new MctsSearchStore(w.sql, w.b);
    const config = { budget: 4, branches: 2 };
    a.begin({ rootId: 'search-a', task: 'pick a backfill approach', engine: 'mcts', rootMsgId: 'm1', config, budget: 4, now: 1_000 });
    b.begin({ rootId: 'search-b', task: 'pick a backfill approach', engine: 'mcts', rootMsgId: 'm2', config, budget: 4, now: 1_001 });

    expect(a.findResumable('pick a backfill approach')?.rootId).toBe('search-a');
    expect(b.findResumable('pick a backfill approach')?.rootId).toBe('search-b');
    expect(a.get('search-b')).toBeNull();
    expect(a.list(10).map((r) => r.rootId)).toEqual(['search-a']);
    w.close();
  });

  test('the same task, two swarms — the newest-wins rule stays inside one owner', () => {
    const w = world();
    const a = new MctsSearchStore(w.sql, w.a);
    const b = new MctsSearchStore(w.sql, w.b);
    const config = { budget: 3, branches: 3 };
    a.begin({ rootId: 'swarm-a1', task: 'explore', engine: 'swarm', rootMsgId: null, config, budget: 3, now: 1_000 });
    a.begin({ rootId: 'swarm-a2', task: 'explore', engine: 'swarm', rootMsgId: null, config, budget: 3, now: 2_000 });
    b.begin({ rootId: 'swarm-b1', task: 'explore', engine: 'swarm', rootMsgId: null, config, budget: 3, now: 3_000 });

    expect(a.findRunningSwarms('explore').map((r) => r.rootId)).toEqual(['swarm-a2', 'swarm-a1']);
    expect(b.findRunningSwarms('explore').map((r) => r.rootId)).toEqual(['swarm-b1']);
    expect(a.hasRunningSwarms()).toBe(true);
    expect(a.runningSwarmRoots(9_000).length).toBe(2);
    w.close();
  });

  test('a settle written against a foreign root changes nothing', () => {
    const w = world();
    const a = new MctsSearchStore(w.sql, w.a);
    const b = new MctsSearchStore(w.sql, w.b);
    const config = { budget: 2, branches: 2 };
    b.begin({ rootId: 'search-b', task: 'x', engine: 'mcts', rootMsgId: 'm', config, budget: 2, now: 1_000 });

    expect(a.reclaim('search-b')).toBeNull();
    a.converge('search-b', 0, 2_000);
    a.fail('search-b', 0, 2_000);
    a.supersede('search-b', 2_000);
    expect(b.get('search-b')?.status).toBe('running');
    expect(b.get('search-b')?.epoch).toBe(0);
    w.close();
  });

  test('closeUnclaimed retires the owner\'s abandoned swarms only', () => {
    const w = world();
    const a = new MctsSearchStore(w.sql, w.a);
    const b = new MctsSearchStore(w.sql, w.b);
    const config = { budget: 2, branches: 2 };
    a.begin({ rootId: 'swarm-a', task: 'x', engine: 'swarm', rootMsgId: null, config, budget: 2, now: 1_000 });
    b.begin({ rootId: 'swarm-b', task: 'x', engine: 'swarm', rootMsgId: null, config, budget: 2, now: 1_000 });

    expect(a.closeUnclaimed(new Set(), 5_000)).toEqual(['swarm-a']);
    expect(b.get('swarm-b')?.status).toBe('running');
    w.close();
  });
});

describe('a fresh child actor', () => {
  test('starts with empty stores under a parent that has rows, and links to it', () => {
    const w = world();
    createFactsStore(w.sql, w.a).upsert('deploy target', 'a.workers.dev');
    tasks(w, w.a).add(['ship it'], null, 1_000);
    new BackgroundJobStore(w.sql, w.a).create({ id: 'job-1', kind: 'agents', workMode: 'build', now: 1 });
    const journalA = new HeadJournal(w.sql, w.a);
    journalA.recordSplit('root-a', 'a split', 100);
    journalA.insertSpawn(headInput('a-h0', 'root-a', 'A0', 100));
    new MctsSearchStore(w.sql, w.a).begin({
      rootId: 'search-a', task: 't', engine: 'mcts', rootMsgId: 'm',
      config: { budget: 1, branches: 1 }, budget: 1, now: 1_000,
    });

    const child = w.actors.sibling('fresh');
    expect(child.parentActorId).toBe(w.a.actorId);
    expect(child.actorId).not.toBe(w.a.actorId);

    expect(createFactsStore(w.sql, child).all()).toEqual([]);
    expect(tasks(w, child).count()).toBe(0);
    // Its first task is t1, not t2: it did not inherit its parent's sequence.
    expect(tasks(w, child).add(['own work'], null, 2_000).added.map((t) => t.id)).toEqual(['t1']);
    expect(new BackgroundJobStore(w.sql, child).list()).toEqual([]);
    expect(new HeadJournal(w.sql, child).listRuns(10)).toEqual([]);
    expect(new HeadJournal(w.sql, child).hasUnfinishedHeads()).toBe(false);
    expect(new MctsSearchStore(w.sql, child).list(10)).toEqual([]);

    // The parent's rows are still there — the child saw nothing, it removed nothing.
    expect(createFactsStore(w.sql, w.a).all()).toHaveLength(1);
    expect(new HeadJournal(w.sql, w.a).hasUnfinishedHeads()).toBe(true);
    w.close();
  });

  test('a retired actor\'s stores stop answering, on every family', () => {
    const w = world();
    const facts = createFactsStore(w.sql, w.b);
    const taskList = tasks(w, w.b);
    const jobs = new BackgroundJobStore(w.sql, w.b);
    const journal = new HeadJournal(w.sql, w.b);
    const ledger = new MctsSearchStore(w.sql, w.b);
    facts.upsert('k', 'v');

    // The directory's own retirement column — the same one every handle's
    // validate closure reads. The stores captured `actorId` at construction, so
    // this is exactly the drift `assertCurrent` exists to catch.
    void w.sql`UPDATE workspace_actors SET retiring_at = ${Date.now()} WHERE actor_id = ${w.b.actorId}`;

    expect(() => facts.recall('k')).toThrow(/no longer present/);
    expect(() => taskList.count()).toThrow(/no longer present/);
    expect(() => jobs.list()).toThrow(/no longer present/);
    expect(() => journal.listRuns(5)).toThrow(/no longer present/);
    expect(() => ledger.list(5)).toThrow(/no longer present/);

    // The sibling is untouched: this is one actor's identity, not the database's.
    expect(createFactsStore(w.sql, w.a).all()).toEqual([]);
    w.close();
  });
});
