// A cancelled fork must stop being reported as running, end to end over the real stores,
// signal seam and per-step ledger: an operator cancel writes only the job registry, so the
// head journal must be reconciled or the roster keeps claiming the heads run.
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';
import { HeadJournal, initHeadsTables } from '../src/heads/index';
import {
  reconcileInterruptedForks, FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
} from '../src/heads/reconcile';
import { RunEventRecorder, initRunEventTables } from '../src/events/recorder';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { Inbox } from '../src/orchestrator/inbox';
import {
  agentDynamicContext, renderDynamicContextBlock, DynamicContextLedger,
} from '../src/prompting/volatile-context';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { ModelMessage } from 'ai';
import { present, testActorHandle } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

const HEADS = 4;

const ROOT = 'root-research';

const RATIONALE = 'four angles on the research question';

const RUN = 'run-dispatched-the-fork';

/**
 * `abandonRunning` retires only heads spawned before the reconciling activation, so the
 * fixture's heads must predate it.
 */
const SPAWNED_A_MINUTE_EARLIER_MS = 60_000;

/** A detached fork journalled by a process that has since exited, then operator-cancelled. */
function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw);
  initBackgroundJobsTable(execRaw);
  const actor = createTestActorsOver(db).main;
  const journal = new HeadJournal(sql, actor);
  const jobs = new BackgroundJobStore(sql, actor);

  const now = Date.now() - SPAWNED_A_MINUTE_EARLIER_MS;
  jobs.create({
    id: 'bgjob-fork', kind: 'agents', workMode: 'build', now,
    label: 'search: survey the prior art',
  });
  journal.recordSplit(ROOT, RATIONALE, now);

  for (let i = 1; i <= HEADS; i++) {
    journal.insertSpawn({
      id: `h${i}`, parentId: null, rootId: ROOT, depth: 1,
      task: `angle ${i}`, rationale: 'why', mode: 'build',
      inheritedContext: [], mergeStrategy: 'synthesize',
      budget: { maxDepth: 2, spawnedAt: now },
      loop: defaultLoopOrigin('head'),
    });
  }

  // The operator cancel writes the job registry only.
  jobs.cancel('bgjob-fork', 0, now + 1_000);

  return { db, journal, jobs };
}

function nextStepBlock(w: ReturnType<typeof workspace>): string | null {
  return renderDynamicContextBlock(agentDynamicContext({
    factsBlock: undefined, memoryTail: undefined, recoveryFindings: [], executors: [],
    runningJobs: w.jobs.listRunning(),
    openTasks: { items: [], total: 0 },
    liveHeadRuns: w.journal.listLive(),
    missingCapabilities: [],
  }));
}

/** No turn running, so `deliver` routes through enqueueTurn. */
function idleAgent() {
  const enqueued: ProgrammaticTurn[] = [];

  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (turn) => {
      enqueued.push(turn);

      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  return { enqueued, inbox: new Inbox(host) };
}

describe('an operator-cancelled fork is not reported as running', () => {
  test('the two stores disagreed, and the disagreement is what the model read', () => {
    const w = workspace();

    expect(w.jobs.get('bgjob-fork')?.status).toBe('cancelled');
    expect(w.jobs.get('bgjob-fork')?.error).toBe('cancelled by operator');
    expect(w.jobs.listRunning()).toEqual({ items: [], total: 0 });

    expect(w.journal.listLive()).toEqual({
      items: [{ rootId: ROOT, rationale: RATIONALE, running: HEADS, total: HEADS }],
      total: 1,
    });
    expect(nextStepBlock(w)).toContain(`${HEADS} of ${HEADS} nodes running`);
  });

  test('reconciliation settles the journal, so the next step no longer claims it is running', async () => {
    const w = workspace();
    const agent = idleAgent();

    const settled = await reconcileInterruptedForks({ journal: w.journal, inbox: agent.inbox });

    expect(settled).toEqual([
      { rootId: ROOT, rationale: RATIONALE, abandoned: HEADS, total: HEADS },
    ]);
    expect(w.journal.listLive()).toEqual({ items: [], total: 0 });
    expect(nextStepBlock(w)).toBeNull();
    // The Exploration surface infers run status from heads; it must no longer read 'running'.
    expect(w.journal.readRun(ROOT)?.status).not.toBe('running');

    for (const head of w.journal.readTree(ROOT)) {
      expect(head.status).toBe('aborted');
      expect(head.error_message).toContain('no executor');
      expect(head.completed_at).not.toBeNull();
    }
  });

  test('the agent is TOLD, on the one signal seam, naming the run and its head count', async () => {
    const w = workspace();
    const agent = idleAgent();

    await reconcileInterruptedForks({ journal: w.journal, inbox: agent.inbox });

    // A fork vanishing from the roster retracts nothing the agent already read; it gets a turn.
    expect(agent.enqueued).toHaveLength(1);
    const turn = agent.enqueued[0];
    expect(turn.metadata?.kinuEvent).toBe(FORK_INTERRUPTED_SIGNAL);
    expect(turn.text).toContain(ROOT);
    expect(turn.text).toContain(RATIONALE);
    expect(turn.text).toContain(`${HEADS} of ${HEADS} heads`);
    expect(turn.text).toContain('nothing is executing them');
    expect(turn.text).toContain('no longer true');
  });

  /**
   * `head_split` without a closing row leaves the Timeline showing the fork in flight forever,
   * so reconciliation closes the split in `run_events`.
   */
  test('the fork run that died is closed in the run-event ledger, not left mid-split', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const sql = makeSql(w.db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));

    recorder.emit(RUN, {
      type: 'head_split', rootId: ROOT, headIds: ['h1', 'h2', 'h3', 'h4'], rationale: RATIONALE,
    });
    recorder.emit(RUN, { type: 'run_end', reason: 'done' });

    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
    });

    const events = recorder.read(RUN);
    expect(events.map((e) => e.type)).toEqual(['head_split', 'run_end', 'head_abandoned']);
    expect(events.at(-1)).toMatchObject({
      type: 'head_abandoned', rootId: ROOT, headCount: HEADS, abandoned: HEADS,
      rationale: RATIONALE, reason: FORK_INTERRUPTED_REASON,
    });
  });

  test('a fork whose split was never recorded reconciles without inventing a run', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const sql = makeSql(w.db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));

    // No `head_split` row: guessing a run would put the fork's death on an unrelated timeline.
    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
    });

    expect(recorder.read(RUN)).toEqual([]);
    // The ledger is additional, never a precondition for retiring a stale head.
    expect(w.journal.listLive()).toEqual({ items: [], total: 0 });
  });

  /**
   * A killed turn leaves its run open: `closeTurnRun` runs in the turn's own frame, so nothing
   * writes a terminal row when that frame is destroyed.
   */
  test('a run a dead activation left open is closed, and a live one is not touched', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const sql = makeSql(w.db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));

    recorder.emit(RUN, { type: 'run_start', agentId: 'a' });
    recorder.emit(RUN, {
      type: 'head_split', rootId: ROOT, headIds: ['h1', 'h2', 'h3', 'h4'], rationale: RATIONALE,
    });
    // Control: attributes the assertion below to being open, not to being old.
    recorder.emit('run-that-finished', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-that-finished', { type: 'run_end', reason: 'complete' });

    // The cutoff is `<`: a same-millisecond tie counts as live.
    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
      now: Date.now() + 1,
    });

    const cut = recorder.read(RUN);
    const closed = cut.filter((event) => event.type === 'run_end');
    expect(closed).toMatchObject([{ type: 'run_end', reason: 'interrupted' }]);
    // The ledger cannot tell eviction from exit from crash, so the reason must not guess.
    expect(closed[0]?.reason).not.toContain('evict');

    expect(recorder.read('run-that-finished').map((event) => event.type))
      .toEqual(['run_start', 'run_end']);
  });

  test('a run the turn loop re-opened is the loop\'s to close, however old its start', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const sql = makeSql(w.db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));

    // Both runs predate the activation; only the loop's own word says which it continues.
    recorder.emit('run-continued', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-abandoned', { type: 'run_start', agentId: 'a' });

    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
      liveRuns: () => ['run-continued'],
      now: Date.now() + 1,
    });

    expect(recorder.read('run-continued').map((event) => event.type)).toEqual(['run_start']);
    expect(recorder.read('run-abandoned').map((event) => event.type)).toEqual(['run_start', 'run_end']);
  });

  test('a second activation closes nothing again', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const sql = makeSql(w.db);
    const recorder = new RunEventRecorder(sql, testActorHandle(sql));
    recorder.emit(RUN, { type: 'run_start', agentId: 'a' });

    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
      now: Date.now() + 1,
    });
    await reconcileInterruptedForks({
      journal: w.journal, inbox: idleAgent().inbox, runEvents: recorder,
      now: Date.now() + 1,
    });

    // A second terminal row would double-count every duration query.
    expect(recorder.read(RUN).filter((event) => event.type === 'run_end')).toHaveLength(1);
  });

  test('a clean start reconciles nothing and wakes nobody', async () => {
    const w = workspace();
    const agent = idleAgent();
    await reconcileInterruptedForks({ journal: w.journal, inbox: agent.inbox });

    const second = idleAgent();
    expect(await reconcileInterruptedForks({ journal: w.journal, inbox: second.inbox })).toEqual([]);
    expect(second.enqueued).toHaveLength(0);
  });

  test('the ledger supersedes the stale block at the tip rather than editing it', async () => {
    const w = workspace();
    const ledger = new DynamicContextLedger();
    const history: ModelMessage[] = [{ role: 'user', content: 'research this' }];

    const before = ledger.weave(history, agentDynamicContext({
      factsBlock: undefined, memoryTail: undefined, recoveryFindings: [], executors: [],
      runningJobs: { items: [], total: 0 }, openTasks: { items: [], total: 0 }, liveHeadRuns: w.journal.listLive(), missingCapabilities: [],
    }));

    expect(v.parse(v.string(), before.at(-1)?.content)).toContain(`${HEADS} of ${HEADS} nodes running`);

    await reconcileInterruptedForks({ journal: w.journal, inbox: idleAgent().inbox });

    // One superseding block at the tail; frozen bytes before it untouched (prefix-cache contract).
    const after = ledger.weave([...history, { role: 'assistant', content: 'working' }], agentDynamicContext({
      factsBlock: 'workspace = kinu', memoryTail: undefined, recoveryFindings: [], executors: [],
      runningJobs: { items: [], total: 0 }, openTasks: { items: [], total: 0 }, liveHeadRuns: w.journal.listLive(), missingCapabilities: [],
    }));

    expect(ledger.size).toBe(2);
    expect(after[1]).toEqual(present(before.at(-1), 'the last block before the reconcile'));
    expect(v.parse(v.string(), after.at(-1)?.content)).not.toContain('heads running');
  });

  /** Reconciliation and resume cannot be ordered; these two tests are the spawn-time bound's two directions. */
  test('a head the resume spawned in THIS activation survives the sweep beside it', async () => {
    const w = workspace();
    const activationStart = Date.now();
    w.journal.recordSplit('root-resumed', 'the re-entered search', activationStart + 5);
    w.journal.insertSpawn({
      id: 'resumed-node', parentId: null, rootId: 'root-resumed', depth: 1,
      task: 'the continuation', rationale: 'why', mode: 'build',
      inheritedContext: [], mergeStrategy: 'synthesize',
      budget: { maxDepth: 2, spawnedAt: activationStart + 5 },
      loop: defaultLoopOrigin('head'),
    });

    const agent = idleAgent();

    const settled = await reconcileInterruptedForks({
      journal: w.journal, inbox: agent.inbox, now: activationStart,
    });

    // Denominator: the sweep did retire the dead attempt's heads.
    expect(settled.map((run) => run.rootId)).toEqual([ROOT]);
    expect(settled[0]?.abandoned).toBe(HEADS);
    expect(w.journal.readHead('resumed-node')?.status).toBe('running');
    expect(w.journal.readHead('resumed-node')?.error_message).toBeNull();
    expect(w.journal.listLive().items.map((run) => run.rootId)).toEqual(['root-resumed']);
    expect(String(agent.enqueued[0]?.text)).not.toContain('root-resumed');
  });

  /**
   * `markInterrupted` transitions `running` rows only, so the resume gate must also be offered
   * rows an earlier activation already marked, or it retires a run being re-driven.
   */
  test('a run an EARLIER activation marked is still offered to the resume gate', async () => {
    const w = workspace();
    const firstActivation = Date.now();
    w.journal.markInterrupted({ spawnedBefore: firstActivation }, firstActivation);
    expect(w.journal.readHeadView('h1')?.status).toBe('interrupted');

    const agent = idleAgent();
    const offered: string[][] = [];

    const settled = await reconcileInterruptedForks({
      journal: w.journal,
      inbox: agent.inbox,
      resume: async (roots) => {
        offered.push([...roots]);

        return roots.filter((root) => root === ROOT);
      },
      now: firstActivation + 1_000,
    });

    expect(offered).toEqual([[ROOT]]);
    expect(settled).toEqual([]);
    expect(agent.enqueued).toHaveLength(0);
    expect(w.journal.readHeadView('h1')?.status).toBe('interrupted');
    expect(w.journal.readHead('h1')?.error_message).toBeNull();
  });

  test('and the same run is retired once the gate stops claiming it', async () => {
    // Denominator: offering a root is not sparing it.
    const w = workspace();
    const firstActivation = Date.now();
    w.journal.markInterrupted({ spawnedBefore: firstActivation }, firstActivation);

    const agent = idleAgent();

    const settled = await reconcileInterruptedForks({
      journal: w.journal, inbox: agent.inbox,
      resume: async () => [],
      now: firstActivation + 1_000,
    });

    expect(settled.map((run) => run.rootId)).toEqual([ROOT]);
    expect(w.journal.readHead('h1')?.status).toBe('aborted');
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent)).toEqual([FORK_INTERRUPTED_SIGNAL]);
  });
});

describe('the operator cancel of ONE job reaches the agent', () => {
  // The runner's wake is pinned in unit-background-job-runner; this pins why it must exist:
  // a quiet roster retracts nothing.
  test('a cancelled job leaves the roster with nothing to correct the record', () => {
    const w = workspace();
    expect(w.jobs.listRunning()).toEqual({ items: [], total: 0 });

    const block = renderDynamicContextBlock(agentDynamicContext({
      factsBlock: undefined, memoryTail: undefined, recoveryFindings: [], executors: [],
      runningJobs: w.jobs.listRunning(), openTasks: { items: [], total: 0 }, liveHeadRuns: { items: [], total: 0 }, missingCapabilities: [],
    }));

    expect(block).toBeNull();
  });
});
