// Process-death recovery for the CLI's terminal transition.
//
// A local turn's answer is only half of what the turn causes. The other half —
// the alternate-takes claim, the completion gate, the evolution recording, the
// shadow trial, the auto title — used to be straight-line code that released
// its turn claims as soon as the transcript hit disk, with no recovery at all.
// A laptop killed anywhere inside that sequence lost every remaining step, and
// nothing on disk said which ones had happened.
//
// So the subject here is not "does the sequence run" — the ordinary session
// tests cover that. It is: kill the process at an exact point inside the
// sequence, open a SECOND session over the same database, and check that every
// effect has happened exactly once when the dust settles. The interruption is
// deterministic (core's TerminalEffectInterrupt, armed at a named effect and
// phase) because a claim about exactly-once is a claim about WHERE the process
// died, and the only way to test that is to choose the instant.
import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import type { SqlExecutor, SqlValue } from '@kinu.run/core';
import {
  TerminalEffectInterrupt,
  COMPLETION_GATE_EVENT, TERMINAL_EFFECT_RETRY_CEILING_MS,
  TERMINAL_TRANSITION_CALL_ID,
  type Shell, type TerminalEffectFault,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import type { TestLanguageModelV2 } from './test-language-model';
import type { CLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import {
  armShadowTrials, captureTakes, openTerminalWorkspace, scriptedModel,
} from './terminal-workspace';

/** The session, with the deterministic cut point reachable. `terminalEffectFault`
 *  is protected on purpose — production has no setter for it — so a test that
 *  wants to choose the instant subclasses, exactly as the DO's harness does. */
class ProbeSession extends LocalAgentSession {
  /** Cut the sequence once, at this effect and phase. Disarmed as it fires: the
   *  same session object is never re-driven, but the ledger's own replay path is,
   *  and a fault that stayed armed would cut the recovery too. */
  cutAt(name: TerminalEffectName, phase: TerminalEffectPhase): void {
    const fault: TerminalEffectFault = (at, effect, scope) => {
      if (effect !== name || at !== phase) return;
      this.terminalEffectFault = null;
      throw new TerminalEffectInterrupt(at, effect, scope);
    };
    this.terminalEffectFault = fault;
  }

  /** Stand this session's ledger clock past the backoff a failed attempt armed,
   *  so the sweep sees the owed rows as due instead of the test sleeping out a
   *  real five seconds per interruption.
   *
   *  `generation` grows with each restart, because the attempt a previous restart
   *  made armed its next one from that restart's own skewed clock: a second sweep
   *  reading the same instant finds every row it just touched not yet due. */
  skipBackoff(generation = 1): void {
    this.terminalClockSkewMs = TERMINAL_EFFECT_RETRY_CEILING_MS * generation;
  }

  /** Stand the ledger clock BACK instead, so the five-second wake a failed
   *  attempt or a failed close arms is due the moment it is armed. The skew
   *  above makes owed ROWS read as due; this makes the TIMER fire. */
  armWakeImmediately(): void {
    this.terminalClockSkewMs = -TERMINAL_EFFECT_RETRY_CEILING_MS;
  }
}

/** The workspace on ONE in-memory database, opened by however many sessions the
 *  test needs. This is the restart the fault hooks can reach; the process-death
 *  suite below opens a file instead. */
function workspace(): { db: Database; rt: CLIRuntime } {
  return openTerminalWorkspace(':memory:');
}

// The durable observables. Each is the effect's own footprint on storage rather
// than a ledger row, so a test that passes says the WORK happened once — not
// that the bookkeeping about it did.
const completedTurns = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM completed_turns`[0]?.n ?? 0;
const queuedTrials = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM scaffold_trial_queue`[0]?.n ?? 0;
const claimedTakes = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM alternate_takes WHERE turn_id IS NOT NULL`[0]?.n ?? 0;
/** Every row the transition is still waiting on. Empty means it closed. */
const stillOwed = (rt: CLIRuntime) =>
  rt.storage.sql<{ effect_name: string; status: string }>`
    SELECT effect_name, status FROM terminal_effects WHERE status != 'completed'`;

/** The restart: a fresh session over the same database, driven through the one
 *  startup path every real CLI entry point takes. */
async function restart(
  rt: CLIRuntime, db: Database, model: TestLanguageModelV2, events: SessionEvent[],
  opts: { oneShot?: boolean; generation?: number } = {},
): Promise<ProbeSession> {
  const { generation = 1, ...sessionOpts } = opts;
  const next = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e), ...sessionOpts });
  next.skipBackoff(generation);
  await next.recoverBackgroundJobs();
  // The replay may enqueue a turn (the completion gate does) and may start a
  // detached lane; this is the join a real one-shot process makes before exit.
  await next.settleBackgroundWork();
  return next;
}


describe('an interrupted terminal sequence is finished by the next start', () => {
  test('the takes claim, the recording, the trial and the title each run exactly once', async () => {
    const { db, rt } = workspace();
    await armShadowTrials(rt);
    captureTakes(rt, 'root-a', Date.now() + 1_000);
    const { model, state } = scriptedModel('the parser is fixed');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    // Killed AFTER the takes claim wrote its rows and BEFORE anything recorded
    // that it had — the interruption the old code could not tell apart from a
    // turn that claimed nothing.
    session.cutAt('takes', 'after');
    await session.send('refactor the parser');

    expect(claimedTakes(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(0);
    expect(queuedTrials(rt)).toBe(0);
    expect(state.titleCalls).toBe(0);
    expect(stillOwed(rt).length).toBeGreaterThan(0);

    // A LATER turn's captures, taken while this workspace was down. The replay
    // must not sweep them: its row recorded the take ids the interrupted turn
    // actually competed against, so "whatever is unclaimed now" is not the
    // question it asks.
    captureTakes(rt, 'root-b', Date.now() + 2_000);

    const next = await restart(rt, db, model, events);

    expect(claimedTakes(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
  });

  // The two effects whose side effect is a durable INSERT, each with the count
  // that shows it happened. Both are keyed at their own boundary, which is the
  // property under test: "after" only converges because the key makes the
  // replay a no-op rather than a second row.
  const keyedInserts = [
    { effect: 'turn_record', observe: completedTurns },
    { effect: 'shadow_trial', observe: queuedTrials },
  ] as const;

  for (const { effect, observe } of keyedInserts) {
    test(`${effect} interrupted BEFORE and AFTER its side effect both converge on one execution`, async () => {
      // Two different instants of death, one observable. The pair is the point:
      // "before" must still run it, "after" must not run it again, and both must
      // end at the same number.
      for (const phase of ['before', 'after'] as const) {
        const { db, rt } = workspace();
        await armShadowTrials(rt);
        const { model, state } = scriptedModel('answered');
        const events: SessionEvent[] = [];
        const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

        session.cutAt(effect, phase);
        await session.send('write the migration');

        expect(observe(rt)).toBe(phase === 'after' ? 1 : 0);
        // The sequence stopped where it was cut, so the lane behind it is untouched.
        expect(state.titleCalls).toBe(0);

        const next = await restart(rt, db, model, events);

        expect(observe(rt)).toBe(1);
        expect(state.titleCalls).toBe(1);
        expect(stillOwed(rt)).toEqual([]);
        await next.end();
      }
    });
  }

  test('the completion gate asks once across a restart that interrupted it', async () => {
    const { db, rt } = workspace();
    // A shell whose probes always answer. The in-SQLite workspace shell answers
    // unevenly, and a gate with nothing to show declines by design — which would
    // let this test pass without ever gating.
    const probed: string[] = [];
    const shell: Shell = {
      exec: async (command) => {
        probed.push(command);
        return { stdout: `output of ${command}`, stderr: '', exitCode: 0 };
      },
    };
    const gated: CLIRuntime = { ...rt, shell };
    // The gate's trigger is tool calls plus a completed stream, never anything
    // the model said — so the turn has to actually call something.
    const { model } = scriptedModel(
      'I renamed them',
      { toolCall: { name: 'fact', input: { action: 'recall', key: 'probe' } } },
    );
    const events: SessionEvent[] = [];
    const session = new ProbeSession({
      rt: gated, db, model, oneShot: true, onEvent: (e) => events.push(e),
    });

    session.cutAt('completion_gate', 'before');
    await session.send('rename the columns');

    const asked = () => events.filter(
      (e) => e.type === 'turn-start' && e.event === COMPLETION_GATE_EVENT,
    ).length;
    expect(asked()).toBe(0);
    expect(probed).toEqual([]);

    const next = await restart(gated, db, model, events, { oneShot: true });

    expect(asked()).toBe(1);
    expect(probed.length).toBeGreaterThan(0);
    // STILL OWED, and that is the fix. Pushing a queue item is a RAM act, so the
    // effect reports owed until the confirming turn's own durable row exists —
    // before, it reported `completed` over a queue a process death erased, and
    // the pruned row meant nothing ever asked again.
    expect(stillOwed(gated).map((row) => row.effect_name)).toEqual(['completion_gate']);
    await next.end();

    // The confirming turn IS on disk now, so the next start completes the row
    // from that fact and does not ask a second time.
    const third = await restart(gated, db, model, events, { oneShot: true, generation: 2 });

    expect(asked()).toBe(1);
    expect(stillOwed(gated)).toEqual([]);
    await third.end();
  });

  test('a second start with nothing owed does nothing', async () => {
    const { db, rt } = workspace();
    await armShadowTrials(rt);
    const { model, state } = scriptedModel('done');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    await session.send('tidy the imports');
    await session.end();

    const settled = {
      turns: completedTurns(rt), trials: queuedTrials(rt), titles: state.titleCalls,
    };
    expect(settled.turns).toBe(1);
    expect(settled.trials).toBe(1);
    expect(stillOwed(rt)).toEqual([]);

    const next = await restart(rt, db, model, events);

    expect(completedTurns(rt)).toBe(settled.turns);
    expect(queuedTrials(rt)).toBe(settled.trials);
    expect(state.titleCalls).toBe(settled.titles);
    await next.end();
  });

  test('a process that does not hold the driver lease replays nothing', async () => {
    const { db, rt } = workspace();
    await armShadowTrials(rt);
    const { model, state } = scriptedModel('answered');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration');
    expect(completedTurns(rt)).toBe(0);

    // A second opener that is NOT the driver. Core's in-flight guard is
    // process-local, so nothing else would stop this one reading the same
    // pending rows and running the recording, the drain and the title call
    // beside the process that owns the conversation.
    const rival = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    rival.skipBackoff();
    rival.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));
    await rival.recoverBackgroundJobs();
    await rival.settleBackgroundWork();

    expect(completedTurns(rt)).toBe(0);
    expect(queuedTrials(rt)).toBe(0);
    expect(state.titleCalls).toBe(0);
    expect(stillOwed(rt).length).toBeGreaterThan(0);
    await rival.end();
  });
});

/**
 * The same subject across a REAL process boundary.
 *
 * Everything above restarts by constructing a second session over the same live
 * `Database` and `CLIRuntime`, and cuts only at the ledger's before/after-body
 * hooks. Neither can see a death between two synchronous durable writes, nor
 * state that wrongly survives on the runtime object. These two kill a child
 * process with SIGKILL at instants production code reaches, over a workspace on
 * disk, and then open that file here.
 */
describe('a killed CLI process is recovered by the next start', () => {
  /** Run the child to its kill point, and answer the marker it printed. */
  async function killAt(
    dbPath: string, mode: 'before-claim' | 'inside-claim' | 'inside-title',
  ): Promise<string> {
    const child = Bun.spawn(
      ['bun', new URL('./terminal-death-probe.ts', import.meta.url).pathname, dbPath, mode],
      { cwd: new URL('../../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    return out.trim().split('\n').at(-1) ?? '';
  }

  test('an answer whose transition was never claimed is replayed from its recorded roster', async () => {
    const dbPath = scratchPath('terminal-death-before-claim', 'agent.db');
    expect(await killAt(dbPath, 'before-claim')).toBe('KILLED before-claim');

    // The file, opened by a new process. The answer is on disk and NOTHING has
    // claimed the transition, so the intent row beside the answer is the only
    // carrier there is.
    const { db, rt } = openTerminalWorkspace(dbPath);
    expect(assistantRows(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(0);
    expect(recordedIntents(rt)).toBe(1);

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart(rt, db, model, events);

    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(claimedTakes(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    // Consumed: the claim carries the sequence from here, and an intent nothing
    // deletes is a turn every later start re-enters.
    expect(recordedIntents(rt)).toBe(0);
    expect(stillOwed(rt)).toEqual([]);
    // ONE answer. A replay that re-persisted would leave two assistant rows and
    // read back as the agent having answered twice.
    expect(assistantRows(rt)).toBe(1);
    await next.end();
    db.close();
  });

  test('a death INSIDE the roster commit leaves nothing claimed, and the intent replays it', async () => {
    const dbPath = scratchPath('terminal-death-inside-claim', 'agent.db');
    expect(await killAt(dbPath, 'inside-claim')).toBe('KILLED inside-claim');

    const { db, rt } = openTerminalWorkspace(dbPath);
    // The cut landed between the outer claim and the first roster row. Both are
    // in ONE commit, so neither survives: a claim that had committed alone would
    // be read below as a sequence already under way, and the `resumed` branch
    // does not re-declare — it would replay an EMPTY roster, settle the claim
    // and drop every effect this response owed with nothing on disk saying so.
    expect(assistantRows(rt)).toBe(1);
    expect(recordedIntents(rt)).toBe(1);
    expect(terminalClaims(rt)).toBe(0);
    expect(rosterRows(rt)).toBe(0);

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart(rt, db, model, events);

    // Claimed fresh from the recorded roster, and every effect runs once.
    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(claimedTakes(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(recordedIntents(rt)).toBe(0);
    expect(stillOwed(rt)).toEqual([]);
    expect(assistantRows(rt)).toBe(1);
    await next.end();
    db.close();
  });

  test('a death INSIDE the title body leaves a named workspace and pays for no second call', async () => {
    const dbPath = scratchPath('terminal-death-inside-title', 'agent.db');
    expect(await killAt(dbPath, 'inside-title')).toBe('KILLED inside-title');

    const { db, rt } = openTerminalWorkspace(dbPath);
    // The cut landed BETWEEN the body's two durable acts: the deterministic title
    // is persisted, the generated one is not, and the row that owed the lane is
    // still owed. No fault hook can produce this instant — the ledger cuts only
    // before or after a whole body.
    expect(displayName(rt)).toBe('refactor the parser');
    expect(stillOwed(rt).map((row) => row.effect_name)).toContain('auto_title');

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart(rt, db, model, events);

    // The row settles, and the replay pays for NOTHING: persisting a title
    // stamps `name_origin`, so the plan no longer matches and the lane is a
    // no-op. That stamp is the whole reason this effect is replayable — and the
    // reason a failed persist has to reach the ledger instead of being logged.
    expect(state.titleCalls).toBe(0);
    expect(displayName(rt)).toBe('refactor the parser');
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });
});

/**
 * Three recovery decisions that are not about one effect body: WHO may re-drive
 * an interrupted lane, WHAT gate state its verdict was earned under, and WHOSE
 * auto-evolution setting a recorded turn is recorded with. Each used to be read
 * off the session that found the work instead of off the record, so the answer
 * depended on which process happened to open the workspace next.
 */
describe('a recovery reads the record, not the session that finds it', () => {
  const NOTE = 'the staging cluster was never named';

  /** The advisor switched on the way an owner switches it on — the durable
   *  `agent_config` row — with a reviewer whose prompts this array collects. */
  function withAdvisor(rt: CLIRuntime, db: Database): string[] {
    const asked: string[] = [];
    db.query(`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('advisor_enabled', 'true')`).run();
    rt.advisorLlm = {
      stream: async function* () { yield ''; },
      complete: async (prompt: string) => {
        asked.push(prompt);
        return JSON.stringify({ note: NOTE, severity: 'concern', class: 'wrong-work' });
      },
    };
    return asked;
  }

  /** The checkpoint a previous process left behind: one advisor lane, stashed and
   *  then interrupted before it recorded anything. */
  function stashAdvisorLane(db: Database, opts: { turnId: string; gateOpen: boolean }): void {
    const snapshot = {
      turn: {
        userMessage: 'rotate the keys', assistantResponse: 'rotated the staging keys',
        toolCalls: [], steps: 1, durationMs: 5, feedback: null, hadError: false,
        turnId: opts.turnId,
      },
      reachable: [], minSeverity: 'concern', recent: [], gateOpen: opts.gateOpen,
    };
    db.query(`INSERT INTO fibers (id, name, snapshot, created_at) VALUES (?, 'advisor.review', ?, 1)`)
      .run(`fiber-${opts.turnId}`, JSON.stringify(snapshot));
  }

  const advisorFibers = (rt: CLIRuntime) =>
    rt.storage.sql<{ n: number }>`
      SELECT count(*) AS n FROM fibers WHERE name = 'advisor.review'`[0]?.n ?? 0;
  const notes = (rt: CLIRuntime) =>
    rt.storage.sql<{ message: string }>`
      SELECT message FROM evolution_events WHERE type = 'advisor_note'`.map((row) => row.message);
  const programmaticTurns = (events: SessionEvent[]) =>
    events.filter((e) => e.type === 'turn-start' && e.kind === 'programmatic').length;

  test('an orphaned advisor review waits for the process that holds the driver lease', async () => {
    const { db, rt } = workspace();
    const asked = withAdvisor(rt, db);
    stashAdvisorLane(db, { turnId: 'turn-orphan', gateOpen: true });
    const { model } = scriptedModel('unused');
    const events: SessionEvent[] = [];

    // A second opener that is NOT the driver. The review is a model call and the
    // note is durable, so two processes that both find this orphan each pay for
    // one and each append their own advice.
    const rival = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    rival.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));
    await rival.recoverBackgroundJobs();
    await rival.settleBackgroundWork();

    expect(asked).toEqual([]);
    expect(notes(rt)).toEqual([]);
    // KEPT. This row is the only thing that can bring the review back, so the
    // process that may not run it may not clear it either.
    expect(advisorFibers(rt)).toBe(1);
    await rival.end();

    const driver = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    await driver.recoverBackgroundJobs();
    await driver.settleBackgroundWork();

    expect(asked).toHaveLength(1);
    expect(notes(rt)).toEqual([NOTE]);
    expect(advisorFibers(rt)).toBe(0);
    await driver.end();
    db.close();
  });

  test('a checkpointed review keeps the completion-gate verdict it was judged under', async () => {
    for (const gateOpen of [true, false]) {
      const { db, rt } = workspace();
      const asked = withAdvisor(rt, db);
      stashAdvisorLane(db, { turnId: `turn-gate-${String(gateOpen)}`, gateOpen });
      const { model } = scriptedModel('acknowledged');
      const events: SessionEvent[] = [];

      const driver = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
      await driver.recoverBackgroundJobs();
      await driver.settleBackgroundWork();

      // Recorded either way — the row is what the next turn's dedupe window
      // reads. The gate decides whether it is also SAID, and a fresh process
      // reads the gate as closed unless the checkpoint carries it: the note the
      // verdict held back for an open gate was delivered instead.
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(notes(rt)).toEqual([NOTE]);
      expect(programmaticTurns(events)).toBe(gateOpen ? 0 : 1);
      await driver.end();
      db.close();
    }
  });

  test('a turn produced with auto-evolution ON is recorded by a recovery that has it off', async () => {
    const { db, rt } = workspace();
    const { model } = scriptedModel('answered');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration');
    expect(completedTurns(rt)).toBe(0);

    // `--no-auto-evolve` on the RECOVERING process. It says what this run spends
    // its own compute on; it does not un-owe the window row a turn produced with
    // evolution on already earned.
    const next = new ProbeSession({
      rt, db, model, noAutoEvolve: true, onEvent: (e) => events.push(e),
    });
    next.skipBackoff();
    await next.recoverBackgroundJobs();
    await next.settleBackgroundWork();

    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });

  test('a turn produced with auto-evolution OFF is recorded by no later session', async () => {
    const { db, rt } = workspace();
    const { model } = scriptedModel('answered');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({
      rt, db, model, noAutoEvolve: true, onEvent: (e) => events.push(e),
    });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration');

    // The inverse, and the reason the decision travels rather than the flag: this
    // recovery HAS auto-evolution, and a turn that owed no evolution state must
    // not acquire one from whichever host happens to finish it.
    const next = await restart(rt, db, model, events);

    expect(completedTurns(rt)).toBe(0);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });

  test('a retry that falls due while the confirming turn is running queues no second one', async () => {
    const { db, rt } = workspace();
    const probed: string[] = [];
    const shell: Shell = {
      exec: async (command) => {
        probed.push(command);
        return { stdout: `output of ${command}`, stderr: '', exitCode: 0 };
      },
    };
    const gated: CLIRuntime = { ...rt, shell };
    // The confirming turn HOLDS inside its model call, which is where a retry
    // timer finds it: five seconds after the attempt that queued it, with the
    // turn's own message row not yet written.
    const inGateTurn = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { model } = scriptedModel('I renamed them', {
      toolCall: { name: 'fact', input: { action: 'recall', key: 'probe' } },
      onStream: async (prompt) => {
        if (!JSON.stringify(prompt).includes('output of ')) return;
        inGateTurn.resolve();
        await release.promise;
      },
    });
    const events: SessionEvent[] = [];
    const session = new ProbeSession({
      rt: gated, db, model, oneShot: true, onEvent: (e) => events.push(e),
    });

    session.cutAt('completion_gate', 'before');
    await session.send('rename the columns');

    const asked = () => events.filter(
      (e) => e.type === 'turn-start' && e.event === COMPLETION_GATE_EVENT,
    ).length;
    expect(asked()).toBe(0);

    // The replay queues the confirming turn and does NOT await it: the pump runs
    // it beside the rest of the sweep, exactly as it does in production, and the
    // sequence is released while that turn is still going.
    const next = new ProbeSession({
      rt: gated, db, model, oneShot: true, onEvent: (e) => events.push(e),
    });
    next.skipBackoff();
    const replay = next.recoverBackgroundJobs();
    await inGateTurn.promise;
    await replay;
    expect(asked()).toBe(1);

    // THE RETRY, and it has to be genuinely DUE: the attempt that queued the
    // turn armed its own next one off this session's skewed clock, so the sweep
    // is stood one generation further on — the same thing five real seconds do
    // to a process that stayed open.
    const attemptsBefore = gateAttempts(gated);
    next.skipBackoff(2);
    await next.recoverTerminalTransitions();
    // The body RAN: it took another attempt and reported owed. Without this the
    // sweep could have found the row not yet due and the assertion below would
    // hold for a retry that never happened.
    expect(gateAttempts(gated)).toBe(attemptsBefore + 1);
    // The gate row is still owed, the confirming message is not on disk, and its
    // queue item was shifted out before the turn started — so the running turn is
    // the only evidence that this confirmation is already being asked.
    release.resolve();
    await next.settleBackgroundWork();

    expect(asked()).toBe(1);
    expect(probed.length).toBeGreaterThan(0);
    // Still owed, and that is right: the row waits for the message rather than
    // for the queue, and the confirming turn's row landed only after the retry
    // had already looked.
    expect(stillOwed(gated).map((row) => row.effect_name)).toEqual(['completion_gate']);
    await next.end();

    // And it is not wedged: the next start reads the message that is now on disk
    // and completes the row without asking again.
    const third = await restart(gated, db, model, events, { oneShot: true, generation: 3 });
    expect(asked()).toBe(1);
    expect(stillOwed(gated)).toEqual([]);
    await third.end();
    db.close();
  });
});

const assistantRows = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM messages WHERE role = 'assistant'`[0]?.n ?? 0;
const recordedIntents = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM terminal_intents`[0]?.n ?? 0;
const displayName = (rt: CLIRuntime) =>
  rt.storage.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'display_name'`[0]?.value ?? null;
/** The transition's own effect claims — the outer ones, keyed apart from any
 *  tool claim the turn itself made. `open` counts the ones with no disposition:
 *  a sequence that has not been closed. */
const terminalClaims = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims
    WHERE normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}`[0]?.n ?? 0;
const openTerminalClaims = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims
    WHERE normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}
      AND result_json IS NULL`[0]?.n ?? 0;
const rosterRows = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM terminal_effects`[0]?.n ?? 0;
/** How many attempts the completion-gate row has taken. The witness that a
 *  sweep actually reached the body rather than finding the row not yet due. */
const gateAttempts = (rt: CLIRuntime) =>
  rt.storage.sql<{ attempts: number }>`
    SELECT attempts FROM terminal_effects WHERE effect_name = 'completion_gate'`[0]?.attempts ?? 0;

describe('a terminal close that fails leaves a way back', () => {
  test('a close whose settle throws re-arms its own wake', async () => {
    const { db, rt } = workspace();
    // The claim settle, made to fail ONCE: it is the last durable act of the
    // close, it runs after every effect has already reported, and by then no
    // owed row is left for the ledger's own wake to be derived from.
    const real: SqlExecutor = rt.storage.sql;
    let settleAttempts = 0;
    let failuresLeft = 1;
    const cutting: SqlExecutor = <T = unknown>(
      query: TemplateStringsArray, ...values: SqlValue[]
    ): T[] => {
      if (query.join('').includes('UPDATE tool_effect_claims SET result_json')) {
        settleAttempts += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('the claim settle failed');
        }
      }
      return real<T>(query, ...values);
    };
    const storage: { sql: SqlExecutor } = rt.storage;
    storage.sql = cutting;

    // The title lane spans a macrotask, which is what makes this the interval the
    // review named: the wake the ledger armed before the replay fires while the
    // sequence is still in flight, finds it held, and is spent. Nothing is armed
    // when the close then throws.
    const { model } = scriptedModel('answered', { onGenerate: () => Bun.sleep(5) });
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    session.armWakeImmediately();

    await session.send('write the migration');
    await session.settleBackgroundWork();

    // Every effect ran, so nothing is owed and the sequence is simply not closed.
    // The wake the catch armed is the only thing left that can close it, and the
    // test asks for nothing: no restart, no second recovery call.
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    const closed = await waitForClose(() => openTerminalClaims(rt) === 0);

    expect(closed).toBe(true);
    // Two attempts: the close's own, which threw, and the one the re-armed wake
    // made. One attempt would mean nothing came back for it.
    expect(settleAttempts).toBe(2);
    await session.end();
    db.close();
  });
});

/** Poll for the close, briefly. A REAL timer is the subject here — production
 *  arms an unref'd five-second wake and hands nothing back — so there is no
 *  promise or event to await and no fake clock that would drive the production
 *  path. The session's ledger clock is stood back instead, which makes that wake
 *  due at once, so this settles in the first poll or not at all. */
async function waitForClose(condition: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}
