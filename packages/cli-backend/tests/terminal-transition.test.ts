import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Process-death recovery for the terminal transition: cut at a named effect and phase (TerminalEffectInterrupt),
// reopen a second session over the same database, and check every effect ran exactly once.
import { describe, test, expect } from 'bun:test';
import { APICallError } from 'ai';
import * as v from 'valibot';
import type { Database } from 'bun:sqlite';
import { spawnTest, AwaitedList, handClock, scratchPath, scriptedAdvisorPort, type ScriptedAdvisorPort } from '@kinu.run/test-utils'
import type { SqlExecutor, SqlValue } from '@kinu.run/core';
import {
  TerminalEffectInterrupt,
  COMPLETION_GATE_EVENT, TERMINAL_EFFECT_RETRY_CEILING_MS,
  TERMINAL_TRANSITION_CALL_ID,
  missionOf,
  type Shell, type TemporaryAgentPort, type TerminalEffectFault,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import { TestLanguageModelV2 } from './test-language-model';
import { soulIn, type CLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import {
  installProgram, openTerminalWorkspace, scriptedModel,
} from './terminal-workspace';
import { fakeModel, toolSequenceModel, type PromptMessage } from './helpers/local-session';

/** The advisor a workspace's sessions hire through; a session with no host has no port of its own. */
const advisors = new WeakMap<CLIRuntime, TemporaryAgentPort>();

/** `terminalEffectFault` is protected with no production setter, so the test subclasses, as the DO's harness does. */
class ProbeSession extends LocalAgentSession {
  private readonly probeRt: CLIRuntime;

  constructor(opts: ConstructorParameters<typeof LocalAgentSession>[0]) {
    super(opts);
    this.probeRt = opts.rt;
  }

  protected override advisorPort(): TemporaryAgentPort | null {
    return advisors.get(this.probeRt) ?? null;
  }

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
}

/** One database shared by sessions: the restart the fault hooks reach. A workspace's own space is beside its file. */
function workspace(): { db: Database; rt: CLIRuntime } {
  return openTerminalWorkspace(scratchPath('terminal-transition', 'agent.db'));
}

// Each observable is the effect's own storage footprint, not a ledger row.
const completedTurns = (rt: CLIRuntime) =>
  rt.storage.sql<{ n: number }>`SELECT count(*) AS n FROM completed_turns`[0]?.n ?? 0;

const stillOwed = (rt: CLIRuntime) =>
  rt.storage.sql<{ effect_name: string; status: string }>`
    SELECT effect_name, status FROM terminal_effects WHERE status != 'completed'`;

interface RestartOptions {
  rt: CLIRuntime;
  db: Database;
  model: TestLanguageModelV2;
  events: { push(event: SessionEvent): void };
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

describe('a workspace born with its mission as a stand-in title', () => {
  test('its first turn names it through the session, once, as the cloud genesis turn does', async () => {
    const { db, rt } = workspace();
    const mission = 'Audit the OAuth callback flow';
    // The mission is the soul's own section, as `kinu create` seeds it.
    await writeText(rt.ownFiles, '/home/main/SOUL.md', `# Kinu\n\n## Mission\n\n${mission}\n`);
    rt.actor.config.setDisplayNameOrigin(mission, 'auto');
    expect(missionOf(soulIn(rt.space))).toBe(mission);
    const { model, state } = scriptedModel('found two issues');
    const session = new ProbeSession({ rt, db, model, onEvent: () => {} });

    await session.send('start', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    expect(state.titleCalls).toBe(1);
    expect(rt.actor.config.getDisplayName()).toBe('Parser Work');

    await session.send('and the refresh path?', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    expect(state.titleCalls).toBe(1);
    await session.end();
  });
});

describe('an interrupted terminal sequence is finished by the next start', () => {
  test('the recording and the title each run exactly once', async () => {
    const { db, rt } = workspace();
    const { model, state } = scriptedModel('the parser is fixed');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    // Killed before the recording, with the answer already durable.
    session.cutAt('turn_record', 'before');
    await session.send('refactor the parser', { id: crypto.randomUUID() });

    expect(completedTurns(rt)).toBe(0);
    expect(state.titleCalls).toBe(0);
    expect(stillOwed(rt).length).toBeGreaterThan(0);

    const next = await restart({ rt, db, model, events });

    expect(completedTurns(rt)).toBe(1);
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
  });

  // The inline insert commits with its disposition; a cut on either side leaves neither.
  const keyedInserts = [{ effect: 'turn_record', observe: completedTurns }] as const;

  for (const { effect, observe } of keyedInserts) {
    test(`${effect} interrupted BEFORE and AFTER its side effect both converge on one execution`, async () => {
      for (const phase of ['before', 'after'] as const) {
        const { db, rt } = workspace();
        const { model, state } = scriptedModel('answered');
        const events: SessionEvent[] = [];
        const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

        session.cutAt(effect, phase);
        await session.send('write the migration', { id: crypto.randomUUID() });

        expect(observe(rt)).toBe(0);
        expect(rt.storage.sql`SELECT status, attempts FROM terminal_effects WHERE effect_name = ${effect}`)
          .toEqual([{ status: 'pending', attempts: 0 }]);
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
    await session.send('rename the columns', { id: crypto.randomUUID() });

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
    const { model, state } = scriptedModel('done');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    await session.send('tidy the imports', { id: crypto.randomUUID() });
    await session.end();

    const settled = { turns: completedTurns(rt), titles: state.titleCalls };

    expect(settled.turns).toBe(1);
    expect(stillOwed(rt)).toEqual([]);

    const next = await restart({ rt, db, model, events });

    expect(completedTurns(rt)).toBe(settled.turns);
    expect(state.titleCalls).toBe(settled.titles);
    await next.end();
  });

  test('a process that does not hold the driver lease replays nothing', async () => {
    const { db, rt } = workspace();
    const { model, state } = scriptedModel('answered');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration', { id: crypto.randomUUID() });
    expect(completedTurns(rt)).toBe(0);

    // Core's in-flight guard is process-local; only the driver lease stops a second opener running the same rows.
    const rival = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    rival.skipBackoff();
    rival.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));
    await rival.recoverBackgroundJobs();
    await rival.settleBackgroundWork();

    expect(completedTurns(rt)).toBe(0);
    expect(state.titleCalls).toBe(0);
    expect(stillOwed(rt).length).toBeGreaterThan(0);
    await rival.end();
  });
});

/**
 * Across a real process boundary: a child is SIGKILLed at instants production code reaches, over a workspace on disk,
 * which a same-process restart cannot observe.
 */
test('a managed context edit reaches the local request', async () => {
  const { db, rt } = workspace();
  const requests: string[] = [];

  const { model } = scriptedModel('answer', { onStream: async (prompt) => { requests.push(JSON.stringify(prompt)); } });
  const session = new LocalAgentSession({ rt, db, model, onEvent: () => {} });

  try {
    await session.send('use the OLD premise', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    const document = v.parse(v.string(), await readText(rt.toolFiles, 'vfs://context/working.jsonl'));
    await writeText(rt.toolFiles, 'vfs://context/working.jsonl', document.replace('OLD premise', 'NEW premise'));
    await expect(writeText(rt.toolFiles, 'vfs://context/working.jsonl', document)).rejects.toThrow(/revision|stale|changed/i);
    await session.send('follow-up input', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    const claim = rt.stores.claims.latestTurn();

    if (claim === null) throw new Error('the turn did not retain its claim');
    const admitted = await rt.stores.claims.admittedContext(claim.turnId);
    const consumed = await rt.stores.claims.consumedContext(claim.turnId, 0);

    if (admitted === null || consumed === null) throw new Error('the turn recorded no admitted or consumed context');
    expect(requests.at(-1)).toContain('NEW premise');
    expect(requests.at(-1)).not.toContain('OLD premise');
    // The admission is the selection before the edit landed; the step consumed the edited context.
    expect(admitted.messages[0]).toEqual({ role: 'user', content: 'use the OLD premise' });
    expect(consumed.messages[0]).toEqual({ role: 'user', content: 'use the NEW premise' });
    expect(consumed.messages.filter((message) => message.content === 'follow-up input')).toHaveLength(1);
  } finally {
    await session.end();
    db.close();
  }
});

describe('a killed CLI process is recovered by the next start', () => {
  /** Run the child to its kill point, and answer the marker it printed. */
  async function killAt(
    dbPath: string, mode: 'before-settle' | 'inside-claim' | 'inside-title' | 'after-record' | 'inside-close' | 'mid-cancel' | 'mid-program',
  ): Promise<string> {
    const child = spawnTest(['bun', new URL('./terminal-death-probe.ts', import.meta.url).pathname, dbPath, mode],
    { cwd: new URL('../../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' },);

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
    expect(state.titleCalls).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    expect(assistantRows(rt)).toBe(1);
    await next.end();
    db.close();
  });

  test('a death after synchronous recording leaves neither its output nor an attempted row', async () => {
    const dbPath = scratchPath('terminal-death-after-record', 'agent.db');
    expect(await killAt(dbPath, 'after-record')).toBe('KILLED after-record');
    const { db, rt } = openTerminalWorkspace(dbPath);
    expect(completedTurns(rt)).toBe(0);
    expect(rt.storage.sql`SELECT status, attempts FROM terminal_effects WHERE effect_name = 'turn_record'`)
      .toEqual([{ status: 'pending', attempts: 0 }]);
    const { model } = scriptedModel('recovered');
    const next = await restart({ rt, db, model, events: [] });
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
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
    expect(rt.storage.sql`SELECT attempts FROM terminal_effects WHERE effect_name = 'auto_title'`)
      .toEqual([{ attempts: 1 }]);

    const { model, state } = scriptedModel('recovered');
    const events: SessionEvent[] = [];
    const next = await restart({ rt, db, model, events });

    // The stand-in is not a name: the replay asks again until one lands, as the cloud's genesis row does.
    expect(state.titleCalls).toBe(1);
    expect(displayName(rt)).toBe('Parser Work');
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });

  test('a death inside the close, once every effect ran, leaves the whole close to the next start', async () => {
    const dbPath = scratchPath('terminal-death-inside-close', 'agent.db');
    expect(await killAt(dbPath, 'inside-close')).toBe('KILLED inside-close');

    const { db, rt } = openTerminalWorkspace(dbPath);
    // Cut after the outer claim's disposition was written: the close is one write, so the kill took all of it back.
    expect(completedTurns(rt)).toBe(1);
    expect(displayName(rt)).toBe('Parser Work');
    expect(stillOwed(rt)).toEqual([]);
    expect(openTerminalClaims(rt)).toBe(1);

    const { model, state } = scriptedModel('recovered');
    const next = await restart({ rt, db, model, events: [] });

    // The next start closes it: nothing runs twice, and nothing of the sequence is left behind.
    expect(state.titleCalls).toBe(0);
    expect(completedTurns(rt)).toBe(1);
    expect(assistantRows(rt)).toBe(1);
    expect(openTerminalClaims(rt)).toBe(0);
    expect(rt.storage.sql`SELECT effect_name FROM terminal_effects`).toEqual([]);
    await next.end();
    db.close();
  });
  test('a death after the owner\'s stop landed is not resumed: the next start ends the turn as the stop did', async () => {
    const dbPath = scratchPath('terminal-death-mid-cancel', 'agent.db');
    expect(await killAt(dbPath, 'mid-cancel')).toBe('KILLED mid-cancel');

    const { db, rt } = openTerminalWorkspace(dbPath);
    const turnId = rt.storage.sql<{ id: string }>`SELECT id FROM pending_steers`[0]?.id;
    let asked = 0;
    const { model } = scriptedModel('the stopped turn ran again', { onStream: async () => { asked += 1; } });
    const next = await restart({ rt, db, model, events: [] });

    // The model is never asked again, the run closes as the stop closes it, and the owner's words stay theirs.
    expect(asked).toBe(0);
    expect(claimOf(rt, turnId)).toEqual({ outcome: 'aborted', epoch: 1 });
    expect(runEnds(rt)).toEqual(['aborted']);
    expect(rt.storage.sql`SELECT id FROM pending_steers`).toEqual([]);
    expect(rt.storage.sql`SELECT role FROM conversation_entries WHERE id = ${turnId ?? ''}`).toEqual([{ role: 'user' }]);
    expect(assistantRows(rt)).toBe(0);
    await next.end();
    db.close();
  });

  test('a turn whose program changed while its process was dead is not run again under the new one', async () => {
    const dbPath = scratchPath('terminal-death-mid-program', 'agent.db');
    expect(await killAt(dbPath, 'mid-program')).toBe('KILLED mid-program');

    const { db, rt } = openTerminalWorkspace(dbPath);
    const turnId = rt.storage.sql<{ id: string }>`SELECT id FROM pending_steers`[0]?.id;
    // Version 1's bytes are not the bytes the turn was admitted under.
    await installProgram(rt, 1, 'async function run() { await host.emit({ type: "text_delta", text: "a changed program" }); }');
    let asked = 0;
    const { model } = scriptedModel('the turn ran again', { onStream: async () => { asked += 1; } });
    const events: SessionEvent[] = [];
    const next = await restart({ rt, db, model, events });

    expect(asked).toBe(0);
    expect(JSON.stringify(events)).not.toContain('a changed program');
    expect(claimOf(rt, turnId)).toEqual({ outcome: 'indeterminate', epoch: 1 });
    expect(runEnds(rt)).toEqual(['aborted']);
    expect(rt.storage.sql`SELECT id FROM pending_steers`).toEqual([]);
    await next.end();
    db.close();
  });


});

/** Who may re-drive an interrupted lane, which gate state its verdict was earned under, and whose auto-evolution
 *  setting applies are read off the record, never off the recovering session. */
describe('a recovery reads the record, not the session that finds it', () => {
  const NOTE = 'the staging cluster was never named';

  /** The advisor switched on via the durable `actor_config` row, hired through a port the test answers. */
  function withAdvisor(rt: CLIRuntime): ScriptedAdvisorPort {
    rt.actor.config.setAdvisorEnabled(true);
    const advisor = scriptedAdvisorPort();
    advisors.set(rt, advisor);

    return advisor;
  }

  /** A turn cut at its owed hire: the row, snapshot included, is all a later process has. */
  async function cutAtHire(opts: { rt: CLIRuntime; db: Database; phase: TerminalEffectPhase }): Promise<void> {
    const { model } = scriptedModel('rotated the staging keys');
    const cut = new ProbeSession({ rt: opts.rt, db: opts.db, model, onEvent: () => {} });
    cut.cutAt('advisor_review', opts.phase);
    await cut.send('rotate the keys', { id: crypto.randomUUID() });
    await cut.settleBackgroundWork();
    await cut.end();
  }

  const owedReviews = (rt: CLIRuntime) => stillOwed(rt).filter((row) => row.effect_name === 'advisor_review').length;

  const notes = (rt: CLIRuntime) =>
    rt.storage.sql<{ message: string }>`
      SELECT message FROM evolution_events WHERE type = 'advisor_note'`.map((row) => row.message);

  const programmaticTurns = (events: SessionEvent[]) =>
    events.filter((e) => e.type === 'turn-start' && e.kind === 'programmatic').length;

  test('an owed advisor hire waits for the process that holds the driver lease', async () => {
    const { db, rt } = workspace();
    const advisor = withAdvisor(rt);
    await cutAtHire({ rt, db, phase: 'before' });
    expect(advisor.tasks).toEqual([]);
    const { model } = scriptedModel('acknowledged');
    const events: SessionEvent[] = [];

    // Not the driver: each process finding this row would hire its own advisor.
    const rival = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    rival.setDriverGate(() => ({ reason: 'unavailable', error: 'another process is driving' }));
    await rival.recoverBackgroundJobs();
    await rival.settleBackgroundWork();

    expect(advisor.tasks).toEqual([]);
    // Kept: the row is the only thing that can bring the hire back.
    expect(owedReviews(rt)).toBe(1);
    await rival.end();

    const driver = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    driver.skipBackoff();
    await driver.recoverBackgroundJobs();
    await driver.settleBackgroundWork();

    expect(advisor.tasks).toHaveLength(1);
    expect(owedReviews(rt)).toBe(0);
    expect(notes(rt)).toEqual([]);

    // The answer arrives after the turn: the note lands once and opens one turn.
    advisor.answer(JSON.stringify({ note: NOTE, severity: 'concern', class: 'wrong-work' }));
    await driver.deliverAdvisorAnswers();
    await driver.settleBackgroundWork();
    await driver.deliverAdvisorAnswers();
    expect(notes(rt)).toEqual([NOTE]);
    expect(programmaticTurns(events)).toBe(1);
    await driver.end();
    db.close();
  });

  test('an advisor answer a death left undelivered is delivered once, at the next start', async () => {
    const { db, rt } = workspace();
    const advisor = withAdvisor(rt);
    const { model } = scriptedModel('rotated the staging keys');
    const first = new ProbeSession({ rt, db, model, onEvent: () => {} });
    await first.send('rotate the keys', { id: crypto.randomUUID() });
    await first.settleBackgroundWork();
    // The answer is stored; the process dies before anything delivers it.
    advisor.answer(JSON.stringify({ note: NOTE, severity: 'concern', class: 'wrong-work' }));
    await first.end();
    expect(notes(rt)).toEqual([]);

    const events: SessionEvent[] = [];
    const next = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });
    await next.recoverBackgroundJobs();
    await next.settleBackgroundWork();
    await next.recoverBackgroundJobs();
    await next.settleBackgroundWork();

    expect(notes(rt)).toEqual([NOTE]);
    expect(programmaticTurns(events)).toBe(1);
    await next.end();
    db.close();
  });

  test('a hire cut after it started is not hired again by the replay', async () => {
    const { db, rt } = workspace();
    const advisor = withAdvisor(rt);
    await cutAtHire({ rt, db, phase: 'after' });
    expect(advisor.tasks).toHaveLength(1);
    expect(owedReviews(rt)).toBe(1);

    const driver = new ProbeSession({ rt, db, model: scriptedModel('unused').model, onEvent: () => {} });
    driver.skipBackoff();
    await driver.recoverBackgroundJobs();
    await driver.settleBackgroundWork();

    expect(advisor.tasks).toHaveLength(1);
    expect(owedReviews(rt)).toBe(0);
    await driver.end();
    db.close();
  });

  test('with the advisor off, a turn owes no review and hires none', async () => {
    const { db, rt } = workspace();
    const advisor = scriptedAdvisorPort();
    advisors.set(rt, advisor);
    const { model } = scriptedModel('done');
    const session = new ProbeSession({ rt, db, model, onEvent: () => {} });
    await session.send('rotate the keys', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    expect(advisor.tasks).toEqual([]);
    expect(owedReviews(rt)).toBe(0);
    await session.end();
    db.close();
  });

  test('a turn produced with learning ON is recorded by a recovery after it was turned off', async () => {
    const { db, rt } = workspace();
    const { model } = scriptedModel('answered');
    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration', { id: crypto.randomUUID() });
    expect(completedTurns(rt)).toBe(0);

    // Turning learning off before the recovery does not un-owe a row earned with it on.
    rt.actor.config.setLearning(false);
    const next = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    next.skipBackoff();
    await next.recoverBackgroundJobs();
    await next.settleBackgroundWork();

    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    await next.end();
    db.close();
  });

  test('a turn produced with learning OFF is recorded by no later session, even once it is back on', async () => {
    const { db, rt } = workspace();
    const { model } = scriptedModel('answered');
    const events: SessionEvent[] = [];

    rt.actor.config.setLearning(false);
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    session.cutAt('turn_record', 'before');
    await session.send('write the migration', { id: crypto.randomUUID() });
    rt.actor.config.setLearning(true);

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
    const release = Promise.withResolvers<void>();

    const { model } = scriptedModel('I renamed them', {
      toolCall: { name: 'fact', input: { action: 'recall', key: 'probe' } },
      onStream: async (prompt) => {
        if (!JSON.stringify(prompt).includes('output of ')) return;
        await release.promise;
      },
    });

    const events = new AwaitedList<SessionEvent>();

    const session = new ProbeSession({
      rt: gated, db, model, oneShot: true, onEvent: (e) => events.push(e),
    });

    session.cutAt('completion_gate', 'before');
    await session.send('rename the columns', { id: crypto.randomUUID() });

    const asked = () => events.items.filter(
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
    await events.until((frames) => frames.filter((e) => e.type === 'run-event' && e.event.type === 'model_operation' && e.event.phase === 'start' && e.event.source === 'agent').length === 2);
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

    await session.send('build the thing', { id: crypto.randomUUID() });
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

const claimOf = (rt: CLIRuntime, turnId: string | undefined) =>
  rt.storage.sql<{ outcome: string | null; epoch: number }>`SELECT outcome, epoch FROM actor_turn_claims WHERE turn_id = ${turnId ?? ''}`[0] ?? null;

/** Each run's close, by its reason, in the order they were written. */
const runEnds = (rt: CLIRuntime) => rt.storage.sql<{ payload: string }>`SELECT payload FROM run_events WHERE type = 'run_end' ORDER BY rowid`
  .map((row) => v.parse(v.object({ reason: v.string() }), JSON.parse(row.payload)).reason);

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
  test('a close whose settle throws is recoverable through the public API', async () => {
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

    const { model } = scriptedModel('answered');

    const events: SessionEvent[] = [];
    const session = new ProbeSession({ rt, db, model, onEvent: (e) => events.push(e) });

    await session.send('write the migration', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();

    // The turn completed; recovery finishes the unsettled close.
    expect(completedTurns(rt)).toBe(1);
    expect(stillOwed(rt)).toEqual([]);
    session.skipBackoff();
    await session.recoverTerminalTransitions();
    expect(openTerminalClaims(rt)).toBe(0);
    // Two attempts: the close's own, which threw, and the recovery call's.
    expect(settleAttempts).toBe(2);
    await session.end();
    db.close();
  });
});

describe('a one-shot exit waits on the turn\'s own close', () => {
  test('with no background job running, the wait announces none', async () => {
    const { db, rt } = workspace();
    const clock = handClock();
    const titled = Promise.withResolvers<void>();
    const { model } = scriptedModel('answered', { onGenerate: async () => { await titled.promise; } });
    const events = new AwaitedList<SessionEvent>();
    const session = new ProbeSession({ rt, db, model, clock, onEvent: (e) => events.push(e) });

    await session.send('write the migration', { id: crypto.randomUUID() });
    await events.until((frames) => frames.some((e) => e.type === 'run-event' && e.event.type === 'model_operation' && e.event.source === 'fast' && e.event.phase === 'start'));
    const settling = session.settleBackgroundWork();
    await Promise.resolve();
    expect(Bun.peek.status(settling)).toBe('pending');
    titled.resolve();
    await settling;

    expect(events.items.filter((e) => e.type === 'background')).toEqual([]);
    await session.end();
    db.close();
  });
});

describe('a turn\'s lessons are one owed terminal effect', () => {
  const LESSON = 'Name `path` in every file read.';

  /** Calls `file` with no path, which its schema refuses; asked for a lesson, answers one, or refuses while
   *  `refusing`. */
  function struggler(state: { lessonAsks: number; refusing: boolean }) {
    const turn = toolSequenceModel([{ name: 'file', input: { action: 'read' } }]);
    const lesson = fakeModel(JSON.stringify({ update: null, text: LESSON }));

    const answering = (prompt: readonly PromptMessage[]) => {
      if (!JSON.stringify(prompt).includes('spared this turn the struggle')) return turn;
      state.lessonAsks += 1;

      if (state.refusing) throw new Error('the fast tier is down');

      return lesson;
    };

    return new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doGenerate: async (options) => answering(options.prompt).doGenerate(options),
      doStream: async (options) => answering(options.prompt).doStream(options),
    });
  }

  const lessons = (rt: CLIRuntime) => rt.storage.sql<{ tool: string; text: string }>`SELECT tool, text FROM tool_lessons`;

  test('a programmatic turn asks for its lesson once, with its review and a restart run too', async () => {
    const { db, rt } = workspace();
    const state = { lessonAsks: 0, refusing: false };
    const model = struggler(state);
    const session = new ProbeSession({ rt, db, model, onEvent: () => {} });

    await session.enqueueTurn({ text: 'read the README', metadata: { kinuEvent: 'background_job' } });
    await session.settleBackgroundWork();
    await session.end();
    const next = await restart({ rt, db, model, events: [] });

    expect({ asked: state.lessonAsks, lessons: lessons(rt) }).toEqual({ asked: 1, lessons: [{ tool: 'file', text: LESSON }] });
    await next.end();
  });

  test('a refused lesson stays owed, and the next start writes it', async () => {
    const { db, rt } = workspace();
    const state = { lessonAsks: 0, refusing: true };
    const model = struggler(state);
    const session = new ProbeSession({ rt, db, model, onEvent: () => {} });

    await session.send('read the README', { id: crypto.randomUUID() });
    await session.end();

    // The naming call fails on this scripted model too and stays owed, as on the cloud; only the lessons are this test's.
    const owedLessons = () => stillOwed(rt).filter((row) => row.effect_name === 'turn_lessons');
    expect(lessons(rt)).toEqual([]);
    expect(owedLessons()).toEqual([{ effect_name: 'turn_lessons', status: 'pending' }]);

    state.refusing = false;
    const next = await restart({ rt, db, model, events: [] });

    expect(lessons(rt)).toEqual([{ tool: 'file', text: LESSON }]);
    expect(owedLessons()).toEqual([]);
    await next.end();
  });
});

// AGENTS.md, 2026-09-30 (T1-T3): a refusal only the owner can fix parks with no wake until their model settings change
// or new work settles. Opening a session is neither.
describe('a title refused for funds parks until the owner acts or new work settles', () => {
  const MISSION = 'Audit the OAuth callback flow';

  /** A workspace born with its mission, whose naming call the provider refuses until the account is funded. */
  async function refusedTitle() {
    const { db, rt } = workspace();
    const titling = { funded: false };

    await writeText(rt.ownFiles, '/home/main/SOUL.md', `# Kinu\n\n## Mission\n\n${MISSION}\n`);
    rt.actor.config.setDisplayNameOrigin(MISSION, 'auto');

    const { model, state } = scriptedModel('found two issues', {
      onGenerate: () => {
        if (!titling.funded) throw new APICallError({ message: 'payment required', url: 'https://x.example/v1', requestBodyValues: {}, statusCode: 402, isRetryable: false });
      },
    });

    const session = new ProbeSession({ rt, db, model, onEvent: () => {} });
    const title = () => stillOwed(rt).filter((row) => row.effect_name === 'auto_title').map((row) => row.status);

    await session.send('start', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    expect(title()).toEqual(['parked']);

    return { db, rt, model, state, titling, session, title };
  }

  test("it survives a retry pass and a restart, and the owner's settings change releases it", async () => {
    const { db, rt, model, state, titling, session, title } = await refusedTitle();
    const asked = state.titleCalls;

    session.skipBackoff();
    await session.recoverTerminalTransitions();
    await session.end();
    const reopened = await restart({ rt, db, model, events: [] });

    expect({ asked: state.titleCalls, title: title() }).toEqual({ asked, title: ['parked'] });

    titling.funded = true;
    reopened.setProviderAccount('openai', 'work');
    await reopened.settleBackgroundWork();
    // The wake the release armed.
    await reopened.recoverTerminalTransitions();
    await reopened.settleBackgroundWork();
    expect({ title: title(), name: rt.actor.config.getDisplayName() }).toEqual({ title: [], name: 'Parser Work' });
    await reopened.end();
  });

  test('the next settled turn releases it', async () => {
    const { rt, titling, session, title } = await refusedTitle();

    titling.funded = true;
    await session.send('and the refresh path?', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    // The wake the release armed.
    await session.recoverTerminalTransitions();
    await session.settleBackgroundWork();
    expect({ title: title(), name: rt.actor.config.getDisplayName() }).toEqual({ title: [], name: 'Parser Work' });
    await session.end();
  });
});
