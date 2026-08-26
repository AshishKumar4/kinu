// A cancelled fork must stop being reported as running — end to end, over the
// real stores, the real signal seam, and the real per-step ledger.
//
// The defect this locks: `head_journal.status` had exactly ONE writer that
// cleared 'running' (HeadJournal.recordReport, the happy path). An operator
// cancel settled the fork's background job and a process exit killed its
// executor, but nothing ever wrote the head rows — so `listLive()`'s
// running-head predicate stayed true forever, and every model step carried
//
//   ## Delegates working for you
//   - <root> (search) — 4 of 4 nodes running: <rationale>
//
// while `background_jobs` said `cancelled by operator`. The agent was not
// reasoning from a stale transcript; the runtime was asserting the falsehood.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadJournal, initHeadsTables } from '../src/heads/index';
import {
  reconcileInterruptedForks, FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
} from '../src/heads/reconcile';
import { RunEventRecorder, initRunEventTables } from '../src/events/recorder';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { SignalDelivery } from '../src/orchestrator/signals';
import {
  agentDynamicContext, renderDynamicContextBlock, DynamicContextLedger,
} from '../src/prompting/volatile-context';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { ModelMessage } from 'ai';
import { makeSql, makeExecRaw } from './helpers';

const HEADS = 4;
const ROOT = 'root-research';
const RATIONALE = 'four angles on the research question';
/** The run the fork was dispatched from — the one carrying its `head_split`. */
const RUN = 'run-dispatched-the-fork';

/**
 * How long before the reconciling activation the dead one spawned these heads.
 *
 * Load-bearing rather than cosmetic. `abandonRunning` retires heads spawned BEFORE the
 * activation doing the sweep — that bound is what stops a resume's own heads from being
 * retired by a reconciliation running beside it — so a fixture that spawns its heads at
 * `Date.now()` is asserting the impossible: an activation cannot spawn a head after the
 * activation that reconciles it has started. The whole point of the scenario is that
 * these heads outlived the process that owned them.
 */
const SPAWNED_A_MINUTE_EARLIER_MS = 60_000;

/** The workspace as it stood when the operator cancelled: a detached 4-head
 *  fork, journalled by the real controller's writes, by a process that has since
 *  exited. */
function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw, makeSql(db));
  initBackgroundJobsTable(execRaw, makeSql(db));
  const journal = new HeadJournal(sql);
  const jobs = new BackgroundJobStore(sql);

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
      budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: now },
    });
  }
  // The operator cancel, as `kinu stop` / the repair path writes it: the job
  // registry only. Nothing reaches the heads, because the process that owned
  // them is gone.
  jobs.cancel('bgjob-fork', 0, now + 1_000);
  return { db, journal, jobs };
}

/** The dynamic-context block the NEXT model step would carry, assembled from
 *  the same sources both backends read (actor-agent.ts / local-session.ts). */
function nextStepBlock(w: ReturnType<typeof workspace>): string | null {
  return renderDynamicContextBlock(agentDynamicContext({
    factsBlock: undefined, memoryTail: undefined, recoveryFindings: [], executors: [],
    runningJobs: w.jobs.listRunning(),
    openTasks: { items: [], total: 0 },
    liveHeadRuns: w.journal.listLive(),
    missingCapabilities: [],
  }));
}

/** An idle agent: `deliver` therefore routes through enqueueTurn, which is what
 *  "the agent learns at its next step" means when no turn is running. */
function idleAgent() {
  const enqueued: ProgrammaticTurn[] = [];
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (turn) => { enqueued.push(turn); return { status: 'queued' }; },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  return { enqueued, signals: new SignalDelivery(host) };
}

describe('an operator-cancelled fork is not reported as running', () => {
  test('the two stores disagreed, and the disagreement is what the model read', () => {
    const w = workspace();

    // The registry is right.
    expect(w.jobs.get('bgjob-fork')?.status).toBe('cancelled');
    expect(w.jobs.get('bgjob-fork')?.error).toBe('cancelled by operator');
    expect(w.jobs.listRunning()).toEqual({ items: [], total: 0 });

    // The journal is wrong, and the roster it feeds says so out loud.
    expect(w.journal.listLive()).toEqual({
      items: [{ rootId: ROOT, rationale: RATIONALE, running: HEADS, total: HEADS }],
      total: 1,
    });
    expect(nextStepBlock(w)).toContain(`${HEADS} of ${HEADS} nodes running`);
  });

  test('reconciliation settles the journal, so the next step no longer claims it is running', async () => {
    const w = workspace();
    const agent = idleAgent();

    const settled = await reconcileInterruptedForks({ journal: w.journal, signals: agent.signals });

    expect(settled).toEqual([
      { rootId: ROOT, rationale: RATIONALE, abandoned: HEADS, total: HEADS },
    ]);
    expect(w.journal.listLive()).toEqual({ items: [], total: 0 });
    // Nothing left to say: the roster is the only plane this workspace had.
    expect(nextStepBlock(w)).toBeNull();
    // And the run stops reading as in-flight on the Exploration surface, which
    // infers run status from its heads. ('partial' — heads finished, no merge
    // synthesis — is that surface's own wording; the invariant here is only
    // that it is no longer 'running'.)
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

    await reconcileInterruptedForks({ journal: w.journal, signals: agent.signals });

    // A fork vanishing from the roster retracts nothing: the agent had already
    // read that it was in flight. It gets a turn, not a silence.
    expect(agent.enqueued).toHaveLength(1);
    const turn = agent.enqueued[0]!;
    expect(turn.metadata?.kinuEvent).toBe(FORK_INTERRUPTED_SIGNAL);
    expect(turn.text).toContain(ROOT);
    expect(turn.text).toContain(RATIONALE);
    expect(turn.text).toContain(`${HEADS} of ${HEADS} heads`);
    expect(turn.text).toContain('nothing is executing them');
    expect(turn.text).toContain('no longer true');
  });

  /**
   * The agent is told, and so is the ledger.
   *
   * `head_split` goes into `run_events` at fork dispatch and `head_merge` when
   * the split settles. That pair is what the Timeline renders (read-models/
   * timeline.ts) and, per heads/controller.ts, "the only durable trace a fork
   * ran at all". An interrupted fork reached the first and never the second, so
   * its run kept a "Heads split" span nothing ever closed — in that ledger it is
   * indistinguishable from a fork still in flight, forever.
   *
   * Which is this module's own argument, applied to the second ledger: a state
   * ledger that goes quiet does not retract anything. The roster got its
   * retraction; `run_events` did not.
   */
  test('the fork run that died is closed in the run-event ledger, not left mid-split', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const recorder = new RunEventRecorder(makeSql(w.db));

    // The dispatching turn, as the ledger records a split.
    recorder.emit(RUN, {
      type: 'head_split', rootId: ROOT, headIds: ['h1', 'h2', 'h3', 'h4'], rationale: RATIONALE,
    });
    // …and that run ended with the process. The fork outlived it, which is the
    // whole situation: nothing was ever going to append to this run again.
    recorder.emit(RUN, { type: 'run_end', reason: 'done' });

    await reconcileInterruptedForks({
      journal: w.journal, signals: idleAgent().signals, runEvents: recorder,
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
    const recorder = new RunEventRecorder(makeSql(w.db));

    // No `head_split` row: a benchmark trial, or a fork dispatched before the
    // ledger existed. There is no run to close, and guessing one would put a
    // fork's death on an unrelated turn's timeline.
    await reconcileInterruptedForks({
      journal: w.journal, signals: idleAgent().signals, runEvents: recorder,
    });

    expect(recorder.read(RUN)).toEqual([]);
    // The journal is still settled — the ledger is an additional record, never
    // a precondition for retiring a stale head.
    expect(w.journal.listLive()).toEqual({ items: [], total: 0 });
  });

  /**
   * A KILLED TURN LEAVES ITS RUN OPEN, and that is the durable face of the
   * owner's "why will it not give up its turn".
   *
   * A run is closed by `closeTurnRun`, which runs in the turn's own frame. Nothing
   * writes a terminal row when the platform destroys that frame, so the ledger
   * cannot tell a turn that is running from one that was killed. Measured on the
   * owner's workspace: six `run_start` rows against three `run_end`, and the
   * missing ones include the turn that dispatched the search.
   *
   * Same start-of-life argument as the journal: this activation is executing none
   * of these, so each was left by an earlier one.
   */
  test('a run a dead activation left open is closed, and a live one is not touched', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const recorder = new RunEventRecorder(makeSql(w.db));

    // The turn that dispatched the fork, cut before it could close itself.
    recorder.emit(RUN, { type: 'run_start', agentId: 'a' });
    recorder.emit(RUN, {
      type: 'head_split', rootId: ROOT, headIds: ['h1', 'h2', 'h3', 'h4'], rationale: RATIONALE,
    });
    // A turn that DID close itself, on the same ledger — the control that makes
    // the assertion below attributable to being open rather than to being old.
    recorder.emit('run-that-finished', { type: 'run_start', agentId: 'a' });
    recorder.emit('run-that-finished', { type: 'run_end', reason: 'complete' });

    await reconcileInterruptedForks({
      journal: w.journal, signals: idleAgent().signals, runEvents: recorder,
    });

    const cut = recorder.read(RUN);
    const closed = cut.filter((event) => event.type === 'run_end');
    expect(closed).toMatchObject([{ type: 'run_end', reason: 'interrupted' }]);
    // The reason is not a mechanism. This ledger cannot distinguish an eviction
    // from a process exit from a crash, and writing a guess into durable history
    // is what the fork journal's own reason was rewritten to stop doing. Read off
    // the emitted row, so a production rename fails here instead of agreeing with
    // itself.
    expect(closed[0]?.reason).not.toContain('evict');

    // The closed run keeps its own terminal row, and gains no second one.
    expect(recorder.read('run-that-finished').map((event) => event.type))
      .toEqual(['run_start', 'run_end']);
  });

  test('a second activation closes nothing again', async () => {
    const w = workspace();
    initRunEventTables(makeExecRaw(w.db));
    const recorder = new RunEventRecorder(makeSql(w.db));
    recorder.emit(RUN, { type: 'run_start', agentId: 'a' });

    await reconcileInterruptedForks({
      journal: w.journal, signals: idleAgent().signals, runEvents: recorder,
    });
    await reconcileInterruptedForks({
      journal: w.journal, signals: idleAgent().signals, runEvents: recorder,
    });

    // Idempotent, because a closed run is no longer open. A second terminal row
    // would make every duration query double-count the wake.
    expect(recorder.read(RUN).filter((event) => event.type === 'run_end')).toHaveLength(1);
  });

  test('a clean start reconciles nothing and wakes nobody', async () => {
    const w = workspace();
    const agent = idleAgent();
    await reconcileInterruptedForks({ journal: w.journal, signals: agent.signals });

    const second = idleAgent();
    expect(await reconcileInterruptedForks({ journal: w.journal, signals: second.signals })).toEqual([]);
    expect(second.enqueued).toHaveLength(0);
  });

  test('the ledger supersedes the stale block at the tip rather than editing it', async () => {
    const w = workspace();
    const ledger = new DynamicContextLedger();
    const history: ModelMessage[] = [{ role: 'user', content: 'research this' }];

    // The step that read the lie.
    const before = ledger.weave(history, agentDynamicContext({
      factsBlock: undefined, memoryTail: undefined, recoveryFindings: [], executors: [],
      runningJobs: { items: [], total: 0 }, openTasks: { items: [], total: 0 }, liveHeadRuns: w.journal.listLive(), missingCapabilities: [],
    }));
    expect(String(before.at(-1)?.content)).toContain(`${HEADS} of ${HEADS} nodes running`);

    await reconcileInterruptedForks({ journal: w.journal, signals: idleAgent().signals });

    // The next step: one more block at the tail (a superseding one), and the
    // frozen bytes before it untouched — the prefix-cache contract.
    const after = ledger.weave([...history, { role: 'assistant', content: 'working' }], agentDynamicContext({
      factsBlock: 'workspace = kinu', memoryTail: undefined, recoveryFindings: [], executors: [],
      runningJobs: { items: [], total: 0 }, openTasks: { items: [], total: 0 }, liveHeadRuns: w.journal.listLive(), missingCapabilities: [],
    }));
    expect(ledger.size).toBe(2);
    expect(after[1]).toEqual(before.at(-1)!);
    expect(String(after.at(-1)?.content)).not.toContain('heads running');
  });

  /**
   * THE ORDERING RULE, from both sides.
   *
   * Reconciliation and a RESUME both run at start of life, and neither backend can
   * order them: the CLI awaits this before recovery, while a Durable Object's `onStart`
   * and `onFiberRecovered` are both dispatched by the Agents SDK. So the safety is a
   * bound on the write — heads spawned before the reconciling activation — and these two
   * tests are its two directions. Without the bound the second one fails: a resume that
   * re-expanded its tree and then had this sweep run beside it would have its live nodes
   * marked `aborted`, and the agent would be TOLD, over the one signal seam, that work
   * still running had been retired.
   */
  test('a head the resume spawned in THIS activation survives the sweep beside it', async () => {
    const w = workspace();
    const activationStart = Date.now();
    // The re-drive re-expands the interrupted tree: a new node, spawned now, under a
    // root of its own. Journalled through the same writer a swarm node uses.
    w.journal.recordSplit('root-resumed', 'the re-entered search', activationStart + 5);
    w.journal.insertSpawn({
      id: 'resumed-node', parentId: null, rootId: 'root-resumed', depth: 1,
      task: 'the continuation', rationale: 'why', mode: 'build',
      inheritedContext: [], mergeStrategy: 'synthesize',
      budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: activationStart + 5 },
    });

    const agent = idleAgent();
    const settled = await reconcileInterruptedForks({
      journal: w.journal, signals: agent.signals, now: activationStart,
    });

    // The DEAD attempt's heads are retired — the denominator, so this cannot pass by
    // the sweep having done nothing at all.
    expect(settled.map((run) => run.rootId)).toEqual([ROOT]);
    expect(settled[0]?.abandoned).toBe(HEADS);
    // And the live node is untouched: still `running`, still on the roster, and never
    // named in the wake the agent was sent.
    expect(w.journal.readHead('resumed-node')?.status).toBe('running');
    expect(w.journal.readHead('resumed-node')?.error_message).toBeNull();
    expect(w.journal.listLive().items.map((run) => run.rootId)).toEqual(['root-resumed']);
    expect(String(agent.enqueued[0]?.text)).not.toContain('root-resumed');
  });
});

describe('the operator cancel of ONE job reaches the agent', () => {
  // The other half: a cancel issued while the agent keeps working. The runner's
  // lifecycle test (unit-background-job-runner) pins the wake itself; this pins
  // the reason it must exist — the roster the agent reads goes quiet, and a
  // quiet roster does not retract a promise the runtime already made.
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
