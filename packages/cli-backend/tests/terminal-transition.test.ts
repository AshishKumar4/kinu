// Process-death recovery for the terminal transition: cut at a named effect and phase (TerminalEffectInterrupt),
// reopen a second session over the same database, and check every effect ran exactly once.
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import type { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import type { SqlExecutor, SqlValue } from '@kinu.run/core';
import {
  TerminalEffectInterrupt, ADVISOR_LANE_FIBER,
  COMPLETION_GATE_EVENT, TERMINAL_EFFECT_RETRY_CEILING_MS,
  TERMINAL_TRANSITION_CALL_ID,
  listQueuedShadowTrials,
  type Shell, type TerminalEffectFault,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import type { TestLanguageModelV2 } from './test-language-model';
import type { CLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import {
  armShadowTrials, captureTakes, openTerminalWorkspace, scriptedModel,
} from './terminal-workspace';

/** `terminalEffectFault` is protected with no production setter, so the test subclasses, as the DO's harness does. */
class ProbeSession extends LocalAgentSession {
  /** Cut once at this effect and phase; disarmed as it fires so the ledger's replay is not cut too. */
  cutAt(name: TerminalEffectName, phase: TerminalEffectPhase): void {
    const fault: TerminalEffectFault = (at, effect, scope) => {
      if (effect !== name || at !== phase) return;
      this.terminalEffectFault = null;
      throw new TerminalEffectInterrupt(at, effect, scope);
    };

    this.terminalEffectFault = fault;
  }

  /** Skew the ledger clock past the backoff instead of sleeping five real seconds; `generation` grows per restart
   *  because each restart armed its next attempt from its own skewed clock. */
  skipBackoff(generation = 1): void {
    this.terminalClockSkewMs = TERMINAL_EFFECT_RETRY_CEILING_MS * generation;
  }

  /** Skew the clock back so the five-second wake is due as armed: this makes the timer fire, the skew above makes rows due. */
  armWakeImmediately(): void {
    this.terminalClockSkewMs = -TERMINAL_EFFECT_RETRY_CEILING_MS;
  }
}

/** One in-memory database shared by sessions: the restart the fault hooks reach. */
function workspace(): { db: Database; rt: CLIRuntime } {
  return openTerminalWorkspace(':memory:');
}

// Each observable is the effect's own storage footprint, not a ledger row.
const completedTurns = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM completed_turns`[0]?.n ?? 0;

const queuedTrials = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM scaffold_trial_queue
    WHERE actor_id = ${rt.actor.actorId}`[0]?.n ?? 0;

const claimedTakes = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM alternate_takes WHERE turn_id IS NOT NULL`[0]?.n ?? 0;

const stillOwed = (rt: CLIRuntime) =>
  rt.storage.sql<{ effect_name: string; status: string }>`
    SELECT effect_name, status FROM terminal_effects WHERE status != 'completed'`;

interface RestartOptions {
  rt: CLIRuntime;
  db: Database;
  model: TestLanguageModelV2;
  events: SessionEvent[];
  oneShot?: boolean;
  generation?: number;
}

async function restart({ rt, db, model, events, generation = 1, ...sessionOpts }: RestartOptions): Promise<ProbeSession> {
  const next = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e), ...sessionOpts });
  next.skipBackoff(generation);
  await next.recoverBackgroundJobs();
  // The replay may enqueue a turn and start a detached lane; this is the join a one-shot process makes before exit.
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

    // Killed after the takes claim wrote its rows and before anything recorded that it had.
    session.cutAt('takes', 'after');
    await session.send('refactor the parser');

    expect(claimedTakes(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(0);
    expect(queuedTrials(rt)).toBe(0);
    expect(state.titleCalls).toBe(0);
    expect(stillOwed(rt).length).toBeGreaterThan(0);

    // A later turn's captures: the replay claims the take ids its row recorded, not whatever is unclaimed now.
    captureTakes(rt, 'root-b', Date.now() + 2_000);

    const next = await restart({ rt, db, model, events });

    expect(claimedTakes(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
  });

  // Both effects are keyed at their own boundary: "after" converges only because the key makes the replay a no-op.
  const keyedInserts = [
    { effect: 'turn_record', observe: completedTurns },
    { effect: 'shadow_trial', observe: queuedTrials },
  ] as const;

  for (const { effect, observe } of keyedInserts) {
    test(`${effect} interrupted BEFORE and AFTER its side effect both converge on one execution`, async () => {
      for (const phase of ['before', 'after'] as const) {
        const { db, rt } = workspace();
        await armShadowTrials(rt);
        const { model, state } = scriptedModel('answered');
        const events: SessionEvent[] = [];
        const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

        session.cutAt(effect, phase);
        await session.send('write the migration');

        expect(observe(rt)).toBe(phase === 'after' ? 1 : 0);
        expect(state.titleCalls).toBe(0);

        const next = await restart({ rt, db, model, events });

        expect(observe(rt)).toBe(1);
        expect(state.titleCalls).toBe(1);
        expect(stillOwed(rt)).toEqual([]);
        await next.end();
      }
    });
  }

  test('the completion gate asks once across a restart that interrupted it', async () => {
    const { db, rt } = workspace();
    // The in-SQLite shell answers probes unevenly, and a gate with nothing to show declines, passing without gating.
    const probed: string[] = [];

    const shell: Shell = {
      exec: async (command) => {
        probed.push(command);

        return { stdout: `output of ${command}`, stderr: '', exitCode: 0 };
      },
    };

    const gated: CLIRuntime = { ...rt, shell };

    // The gate triggers on tool calls plus a completed stream, so the turn must call something.
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

    const next = await restart({ rt: gated, db, model, events, oneShot: true });

    expect(asked()).toBe(1);
    expect(probed.length).toBeGreaterThan(0);
    // Still owed: a queued turn is RAM only, so the row stays owed until the confirming turn's own row exists.
    expect(stillOwed(gated).map((row) => row.effect_name)).toEqual(['completion_gate']);
    await next.end();

    const third = await restart({ rt: gated, db, model, events, oneShot: true, generation: 2 });

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

    const next = await restart({ rt, db, model, events });

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

    // Core's in-flight guard is process-local; only the driver lease stops a second opener running the same rows.
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
 * Across a real process boundary: a child is SIGKILLed at instants production code reaches, over a workspace on disk,
 * which a same-process restart cannot observe.
 */
test('a managed context edit reaches the local request and retained trial together', async () => {
  const { db, rt } = workspace();
  const requests: string[] = [];

  const { model } = scriptedModel('answer', { onStream: async (prompt) => { requests.push(JSON.stringify(prompt)); } });
  const session = new LocalAgentSession({ rt, db, model, onEvent: () => {} });

  try {
    await session.send('use the OLD premise');
    await session.settleBackgroundWork();
    // Armed after the first turn: a drain still running that turn's trial re-reads the queue between laps and
    // would take the follow-up's trial with it, however fast the workspace files answer.
    await armShadowTrials(rt);
    const document = v.parse(v.string(), await rt.storage.vfs.readFile('/context/working.jsonl', { encoding: 'utf8' }));
    await rt.storage.vfs.writeFile('/context/working.jsonl', document.replace('OLD premise', 'NEW premise'));
    await expect(rt.storage.vfs.writeFile('/context/working.jsonl', document)).rejects.toThrow(/revision|stale|changed/i);
    await session.send('follow-up input');
    await session.settleBackgroundWork();
    const trial = listQueuedShadowTrials(rt.storage.sql, rt.actor, 1).find((row) => row.task === 'follow-up input');
    const claim = rt.stores.claims.latestTurn();

    if (trial === undefined || claim === null) throw new Error('the turn did not retain its claim and trial');
    const admitted = await rt.stores.claims.admittedContext(claim.turnId);
    const consumed = await rt.stores.claims.consumedContext(claim.turnId, 0);

    if (admitted === null || consumed === null) throw new Error('the turn recorded no admitted or consumed context');
    expect(requests.at(-1)).toContain('NEW premise');
    expect(requests.at(-1)).not.toContain('OLD premise');
    // The admission is the selection before the edit landed; the trial retains the step-0 context.
    expect(admitted.messages?.[0]).toEqual({ role: 'user', content: 'use the OLD premise' });
    expect(trial.context[0]).toEqual({ role: 'user', content: 'use the NEW premise' });
    expect(trial.context.filter((message) => message.content === 'follow-up input')).toHaveLength(1);
    expect(consumed.messages).toEqual(trial.context);
  } finally {
    await session.end();
    db.close();
  }
});

describe('a killed CLI process is recovered by the next start', () => {
  /** Run the child to its kill point, and answer the marker it printed. */
  async function killAt(
    dbPath: string, mode: 'before-settle' | 'inside-claim' | 'inside-title',
  ): Promise<string> {
    const child = Bun.spawn(
      ['bun', new URL('./terminal-death-probe.ts', import.meta.url).pathname, dbPath, mode],
      { cwd: new URL('../../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' },
    );

    const out = await new Response(child.stdout).text();
    await child.exited;

    return out.trim().split('\n').at(-1) ?? '';
  }

  test('answer and terminal roster survive a crash before settlement', async () => {
    const dbPath = scratchPath('terminal-death-before-settle', 'agent.db');
    expect(await killAt(dbPath, 'before-settle')).toBe('KILLED before-settle');

    const { db, rt } = openTerminalWorkspace(dbPath);
    expect(assistantRows(rt)).toBe(1);
    expect(completedTurns(rt)).toBe(0);
    expect(terminalClaims(rt)).toBe(1);
    expect(rosterRows(rt)).toBeGreaterThan(0);

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart({ rt, db, model, events });

    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(claimedTakes(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    // A replay that re-persisted would leave two assistant rows.
    expect(assistantRows(rt)).toBe(1);
    await next.end();
    db.close();
  });

  test('a death inside the roster commit rolls back the answer and its terminal claim', async () => {
    const dbPath = scratchPath('terminal-death-inside-claim', 'agent.db');
    expect(await killAt(dbPath, 'inside-claim')).toBe('KILLED inside-claim');

    const { db, rt } = openTerminalWorkspace(dbPath);
    // The send's own reservation survives: the admission ledger committed before the turn began.
    expect(assistantRows(rt)).toBe(0);
    expect(terminalClaims(rt)).toBe(0);
    expect(rosterRows(rt)).toBe(0);

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart({ rt, db, model, events });

    // The acknowledged send re-enters the pump and its turn commits whole, then the replay settles each effect once.
    expect(events.some((e) => e.type === 'turn-start')).toBe(true);
    expect(completedTurns(rt)).toBe(1);
    expect(queuedTrials(rt)).toBe(1);
    expect(claimedTakes(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    expect(assistantRows(rt)).toBe(1);
    await next.end();
    db.close();
  });

  test('a death INSIDE the title body leaves a named workspace and pays for no second call', async () => {
    const dbPath = scratchPath('terminal-death-inside-title', 'agent.db');
    expect(await killAt(dbPath, 'inside-title')).toBe('KILLED inside-title');

    const { db, rt } = openTerminalWorkspace(dbPath);
    // Cut between the body's two durable acts, an instant no before/after fault hook can produce.
    expect(displayName(rt)).toBe('refactor the parser');
    expect(stillOwed(rt).map((row) => row.effect_name)).toContain('auto_title');

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart({ rt, db, model, events });

    // The replay pays for nothing: the title is no longer a placeholder, so the lane is a no-op.
    // This is why a failed persist must reach the ledger instead of being logged.
    expect(state.titleCalls).toBe(0);
    expect(displayName(rt)).toBe('refactor the parser');
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });
});

/** Who may re-drive an interrupted lane, which gate state its verdict was earned under, and whose auto-evolution
 *  setting applies are read off the record, never off the recovering session. */
describe('a recovery reads the record, not the session that finds it', () => {
  const NOTE = 'the staging cluster was never named';

  /** The advisor switched on via the durable `actor_config` row; the reviewer's prompts are collected. */
  function withAdvisor(rt: CLIRuntime): string[] {
    const asked: string[] = [];
    rt.actor.config.setAdvisorEnabled(true);
    rt.advisorLlm = {
      stream: async function* () { yield ''; },
      complete: async (prompt: string) => {
        asked.push(prompt);

        return JSON.stringify({ note: NOTE, severity: 'concern', class: 'wrong-work' });
      },
    };

    return asked;
  }

  /** An interrupted advisor lane checkpoint in `createSqlFiber`'s shape; `fibers` is keyed `(actor_id, id)`, so an
   *  ownerless row could never be claimed. */
  function stashAdvisorLane(rt: CLIRuntime, opts: { turnId: string; gateOpen: boolean }): void {
    const snapshot = {
      turn: {
        userMessage: 'rotate the keys', assistantResponse: 'rotated the staging keys',
        toolCalls: [], steps: 1, durationMs: 5, feedback: null, hadError: false,
        turnId: opts.turnId,
      },
      reachable: [], minSeverity: 'concern', recent: [], gateOpen: opts.gateOpen,
    };

    void rt.storage.sql`INSERT INTO fibers (actor_id, id, name, snapshot, created_at)
      VALUES (${rt.actor.actorId}, ${`fiber-${opts.turnId}`}, ${ADVISOR_LANE_FIBER},
              ${JSON.stringify(snapshot)}, 1)`;
  }

  const advisorFibers = (rt: CLIRuntime) =>
    rt.storage.sql<{ n: number }>`
      SELECT count(*) AS n FROM fibers WHERE name = ${ADVISOR_LANE_FIBER}`[0]?.n ?? 0;

  const notes = (rt: CLIRuntime) =>
    rt.storage.sql<{ message: string }>`
      SELECT message FROM evolution_events WHERE type = 'advisor_note'`.map((row) => row.message);

  const programmaticTurns = (events: SessionEvent[]) =>
    events.filter((e) => e.type === 'turn-start' && e.kind === 'programmatic').length;

  test('an orphaned advisor review waits for the process that holds the driver lease', async () => {
    const { db, rt } = workspace();
    const asked = withAdvisor(rt);
    stashAdvisorLane(rt, { turnId: 'turn-orphan', gateOpen: true });
    const { model } = scriptedModel('unused');
    const events: SessionEvent[] = [];

    // Not the driver: each process finding this orphan would pay for its own review and append its own advice.
    const rival = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    rival.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));
    await rival.recoverBackgroundJobs();
    await rival.settleBackgroundWork();

    expect(asked).toEqual([]);
    expect(notes(rt)).toEqual([]);
    // Kept: the row is the only thing that can bring the review back.
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
      const asked = withAdvisor(rt);
      stashAdvisorLane(rt, { turnId: `turn-gate-${String(gateOpen)}`, gateOpen });
      const { model } = scriptedModel('acknowledged');
      const events: SessionEvent[] = [];

      const driver = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
      await driver.recoverBackgroundJobs();
      await driver.settleBackgroundWork();

      // Recorded either way (the dedupe window reads it); a fresh process reads the gate as closed unless the checkpoint carries it.
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

    // `--no-auto-evolve` on the recovering process does not un-owe a window row earned with evolution on.
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

    // The inverse: a turn that owed no evolution state must not acquire one from the recovering host.
    const next = await restart({ rt, db, model, events });

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
    // The confirming turn holds inside its model call, where a five-second retry timer finds it before its message row exists.
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

    // Fixture bookkeeping: the rolled-back retirement leaves the send owed, and re-queuing it would spend the gate row early.
    void gated.storage.sql`DELETE FROM pending_steers WHERE actor_id = ${rt.actor.actorId}`;

    const next = new ProbeSession({
      rt: gated, db, model, oneShot: true, onEvent: (e) => events.push(e),
    });

    next.skipBackoff();
    const replay = next.recoverBackgroundJobs();
    await inGateTurn.promise;
    await replay;
    // A retry finding the confirming turn queued or running reports the row held: no second turn, no doubled backoff.
    const attemptsBefore = gateAttempts(gated);
    next.skipBackoff(2);
    await next.recoverTerminalTransitions();
    expect(gateAttempts(gated)).toBe(attemptsBefore);
    const held = stillOwed(gated);
    expect(held.map((row) => row.effect_name)).toEqual(['completion_gate']);
    expect(held.every((row) => row.status === 'pending')).toBe(true);
    expect(asked()).toBe(1);
    release.resolve();
    await next.settleBackgroundWork();

    expect(asked()).toBe(1);
    expect(probed.length).toBeGreaterThan(0);
    // Still owed: the row waits for the message, which landed only after the retry looked.
    expect(stillOwed(gated).map((row) => row.effect_name)).toEqual(['completion_gate']);
    await next.end();

    // Not wedged: the next start reads the message now on disk and completes the row.
    const third = await restart({ rt: gated, db, model, events, oneShot: true, generation: 3 });
    expect(asked()).toBe(1);
    expect(stillOwed(gated)).toEqual([]);
    await third.end();
    db.close();
  });
});

describe('an owed follow-up turn waits for its own row', () => {
  test('an overflow retry stays owed until its turn is on disk, and the next pass closes it', async () => {
    const { db, rt } = workspace();
    let overflowed = false;

    const { model } = scriptedModel('recovered', {
      onStream: async () => {
        if (overflowed) return;
        overflowed = true;
        throw new Error('context_length_exceeded: prompt is too long');
      },
    });

    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    const retries = () => events.filter((e) => e.type === 'turn-start' && e.event === 'overflow_retry').length;
    const owed = () => stillOwed(rt).map((row) => row.effect_name);

    await session.send('build the thing');
    await session.settleBackgroundWork();

    expect(retries()).toBe(1);
    expect(owed()).toContain('overflow_retry');

    session.skipBackoff();
    await session.recoverTerminalTransitions();

    expect(owed()).not.toContain('overflow_retry');
    expect(retries()).toBe(1);
    await session.end();
    db.close();
  });
});

const assistantRows = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM conversation_entries WHERE actor_id = ${rt.actor.actorId} AND role = 'assistant'`[0]?.n ?? 0;

const displayName = (rt: CLIRuntime) =>
  rt.storage.sql<{ value: string }>`SELECT value FROM actor_config WHERE key = 'display_name'`[0]?.value ?? null;

/** The transition's outer effect claims, apart from tool claims; `open` counts ones with no disposition. */
const terminalClaims = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims
    WHERE normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}`[0]?.n ?? 0;

const openTerminalClaims = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims
    WHERE normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}
      AND result_json IS NULL`[0]?.n ?? 0;

const rosterRows = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM terminal_effects`[0]?.n ?? 0;

/** Attempts taken by the completion-gate row: proof a sweep reached the body rather than finding it not due. */
const gateAttempts = (rt: CLIRuntime) =>
  rt.storage.sql<{ attempts: number }>`
    SELECT attempts FROM terminal_effects WHERE effect_name = 'completion_gate'`[0]?.attempts ?? 0;

describe('a terminal close that fails leaves a way back', () => {
  test('a close whose settle throws re-arms its own wake', async () => {
    const { db, rt } = workspace();
    // The claim settle fails once: the last durable act of the close, after which no owed row can derive the wake.
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

    // The title lane spans a macrotask, so the pre-armed wake fires mid-sequence, finds it held, and is spent.
    const { model } = scriptedModel('answered', { onGenerate: () => Bun.sleep(5) });
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    session.armWakeImmediately();

    await session.send('write the migration');
    await session.settleBackgroundWork();

    // Nothing is owed; only the wake the catch armed can close the sequence.
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    const closed = await waitForClose(() => openTerminalClaims(rt) === 0);

    expect(closed).toBe(true);
    // Two attempts: the close's own, which threw, and the re-armed wake's.
    expect(settleAttempts).toBe(2);
    await session.end();
    db.close();
  });
});

/** Polls for the close: production arms an unref'd five-second wake with nothing to await, and the stood-back
 *  ledger clock makes it due at once. */
async function waitForClose(condition: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return true;
    await Bun.sleep(10);
  }

  return condition();
}
