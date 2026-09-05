/**
 * One scenario, two transports, one durable state.
 *
 * Two backends now drive core's {@link TerminalTransitions}: a Durable Object,
 * whose close rides a fiber and whose wake is an alarm, and a CLI, whose close
 * is awaited inside the process that owns it and whose wake is its next start.
 * The state machine is meant to be the SAME machine under both. Nothing proved
 * that, and two adapters over one lifecycle drift silently — the drift shows up
 * as a reply nobody sent or a model lane paid for twice, on one backend only.
 *
 * So this suite is a differential one. Each scenario is a single script, run
 * twice over two fresh in-memory databases against two deliberately DIFFERENT
 * transports:
 *
 *   • `alarm` — the detached shape. `scheduleRetry` records the armed instant
 *     and a driver fires it on a fresh process; `hold` defers the close onto a
 *     queue the driver drains, so nothing of the close has happened when
 *     `settle` returns.
 *   • `startup` — the process-lifetime shape. `scheduleRetry` records the
 *     instant and does nothing else; `hold` starts the close immediately and the
 *     process awaits it before it exits, so the close is already under way
 *     inside `settle`.
 *
 * Neither is a real backend, and neither imports one: cf-backend and
 * cli-backend are unreachable from here on purpose. What they stand for is the
 * only two things a backend supplies — the effect implementations and the wake
 * transport. If the rows come out identical under both, the machine is
 * transport-independent, which is the property under test.
 *
 * THE ORACLE IS STORAGE, normalized. `terminal_effects` and
 * `tool_effect_claims` are read back and their clock columns collapsed to
 * ownership facts (`due`, `settled`) before the diff, because state OWNERSHIP is
 * what conformance means: which rows exist, in which disposition, with how many
 * attempts against them, and whether the outer transition is closed. The two
 * planes are deliberately given UNEQUAL clock bases so that raw instants cannot
 * coincide — a suite whose normalization was decorative would pass anyway, and
 * a machine that reads its own recorded instants back has to be offset-blind.
 *
 * Two journals ride along in the same snapshot, because the ledger's own rows
 * cannot witness a repeated side effect: `conf_effect_runs` is append-only and
 * counts EXECUTIONS, `conf_effect_output` is keyed on the effect's identity and
 * counts EFFECTS. An interruption after a side effect must make the first read 2
 * and leave the second at 1. That is the guarantee that makes replaying an owed
 * row safe.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';

import {
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID, type TerminalTransition,
} from '../src/orchestrator/terminal-transition';
import {
  initTerminalEffectTable, terminalEffect, terminalEffectKey, TerminalEffectInterrupt,
  TERMINAL_EFFECT_RETRY_BASE_MS,
  type OwedEffect, type TerminalEffect, type TerminalEffectFault, type TerminalEffectName,
  type TerminalEffectPhase, type TerminalEffectTable,
} from '../src/orchestrator/terminal-effects';
import {
  claimToolEffect, initToolEffectClaimTable, type ToolEffectKey,
} from '../src/tools/effect-claim';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import type { JsonObject } from '../src/utils/json';
import { makeSql, makeExecRaw } from './helpers';

/** The response every scenario settles. One turn, one assistant message: the
 *  transition's identity is the pair, and the sequence id is derived from it. */
const TRANSITION: TerminalTransition = { turnId: 'turn-conformance', messageId: 'msg-answer' };

/** Carried in every effect's recorded input, and written out by the effect's
 *  keyed boundary. An output row holding it proves the input survived storage. */
const ANSWER = 'the answer this turn settled on';

/**
 * A tool of the SAME turn, claimed before the response settles.
 *
 * The witness for the release policy: `end` may drop a turn's tool claims only
 * once no response of that turn can still be settling, so this row surviving is
 * as much a conformance fact as the terminal row itself.
 */
const TOOL_CLAIM: ToolEffectKey = {
  turnId: TRANSITION.turnId, callId: 'write_file#1', digest: 'conformance-tool-digest',
};

/** The declared sequence, in declared order. Real names, because the ledger's
 *  schema IS the union and a row naming anything else is a different test. */
const SEQUENCE = [
  'takes', 'event_reply', 'turn_record', 'auto_title',
] as const satisfies readonly TerminalEffectName[];

/** The one detached effect: a model lane must not hold the turn queue. Exactly
 *  one, and it is LAST, so a cut on an inline effect leaves an exact suffix
 *  rather than a claim about scheduling. */
const DETACHED: TerminalEffectName = 'auto_title';

/** The effect the scripts make report itself owed. A reply channel that is
 *  still open is what `owed` means in production. */
const HELD: TerminalEffectName = 'event_reply';

/** Implemented by both adapters and absent from {@link SEQUENCE}: what a second
 *  `declare()` on a resumed response would try to add. Implemented on purpose —
 *  a frozen roster has to hold against an effect the adapter COULD run. */
const LATE: TerminalEffectName = 'branches';

/** Declared by one scenario and implemented by neither adapter: a row this
 *  build cannot attempt. */
const UNIMPLEMENTED: TerminalEffectName = 'parent_report';

const IMPLEMENTED: readonly TerminalEffectName[] = [...SEQUENCE, LATE];

const EffectInputSchema = v.object({ answer: v.string() });

/** How long a script waits before recovering: past the first backoff, because an
 *  attempt arms its schedule BEFORE the side effect and a replay inside that
 *  window is deliberately deferred. */
const PAST_BACKOFF_MS = TERMINAL_EFFECT_RETRY_BASE_MS + 1;

type AdapterKind = 'alarm' | 'startup';

/** Unequal on purpose: identical bases would make the normalization below look
 *  load-bearing when it was not. */
const CLOCK_BASE = {
  alarm: 1_700_000_000_000,
  startup: 1_700_000_987_654,
} satisfies Record<AdapterKind, number>;

function roster(names: readonly TerminalEffectName[]): OwedEffect[] {
  return names.map((name) => ({
    name,
    scope: TRANSITION.messageId,
    input: { answer: ANSWER },
    lane: name === DETACHED ? 'detached' : 'inline',
  }));
}

/** One ledger row with its clock columns collapsed. `due` and `settled` are
 *  ownership facts; the instants behind them are the plane's own clock and say
 *  nothing about which adapter is correct. */
interface EffectView {
  readonly sequence: string;
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly seq: number;
  readonly status: string;
  readonly input: string;
  readonly outcome: string | null;
  readonly attempts: number;
  readonly due: boolean;
  readonly settled: boolean;
}

/** One claim row. The digest is left out: it is the key's binding rather than
 *  lifecycle state, and a wrong one shows up here anyway as a second row under
 *  the same call id. */
interface ClaimView {
  readonly turn: string;
  readonly call: string;
  readonly result: string | null;
}

interface Snapshot {
  readonly effects: readonly EffectView[];
  readonly claims: readonly ClaimView[];
  /** Executions per effect key. 2 means a body ran twice. */
  readonly runs: Record<string, number>;
  /** The keyed boundary each effect writes through. 1 row per key, always. */
  readonly outputs: Record<string, string>;
  /** The order effects actually ran in — the lane's only observable effect. */
  readonly runOrder: readonly string[];
  readonly wake: 'none' | 'due' | 'future';
  readonly inFlight: number;
  readonly interrupts: readonly string[];
}

interface EffectLedgerRow {
  sequence_id: string;
  effect_key: string;
  effect_name: string;
  scope: string;
  seq: number;
  status: string;
  input_json: string;
  outcome: string | null;
  attempts: number;
  next_attempt_at: number;
  settled_at: number | null;
}

/**
 * One workspace, one transport, and the processes that come and go over them.
 *
 * The database outlives every process here, which is the whole point: a
 * `restart` is the isolate dying or the CLI exiting, and what the next process
 * can see is exactly what was written down.
 */
class Plane {
  private readonly db = new Database(':memory:');
  private readonly sql = makeSql(this.db);
  private readonly execRaw = makeExecRaw(this.db);

  private clock: number;
  private cut: { readonly phase: TerminalEffectPhase; readonly name: TerminalEffectName } | null = null;
  /**
   * The instant this transport was last asked to wake at, consumed by a
   * recovery.
   *
   * The two transports differ in how a wake is DELIVERED — an alarm fires it, a
   * start supersedes it — not in what the machine asked for, so the asked-for
   * instant is the comparable half and the one under test. It survives a
   * restart: an alarm row and a next start both do.
   */
  private wakeAt: number | null = null;
  /** `alarm`: closes the driver has not drained yet. */
  private readonly deferred: Array<() => Promise<void>> = [];
  /** `startup`: the close the live process is carrying. */
  private closing: Promise<void> | null = null;
  private live: TerminalTransitions | null = null;
  private readonly interrupts: string[] = [];

  constructor(private readonly kind: AdapterKind) {
    this.clock = CLOCK_BASE[kind];
    initTerminalEffectTable(this.execRaw);
    initToolEffectClaimTable(this.execRaw);
    this.execRaw('CREATE TABLE IF NOT EXISTS conf_effect_runs (effect_key TEXT NOT NULL)');
    this.execRaw(`CREATE TABLE IF NOT EXISTS conf_effect_output (
      output_key TEXT PRIMARY KEY,
      payload    TEXT NOT NULL
    )`);
    this.execRaw('CREATE TABLE IF NOT EXISTS conf_held (effect_key TEXT PRIMARY KEY)');
    claimToolEffect(this.sql, TOOL_CLAIM);
  }

  close(): void {
    this.db.close();
  }

  /** The live process, booted on demand. */
  process(): TerminalTransitions {
    this.live ??= new TerminalTransitions({
      sql: this.sql,
      effects: this.effects(),
      now: () => this.clock,
      fault: () => this.fault(),
      scheduleRetry: async (atMs: number) => {
        this.wakeAt = atMs;
        await Promise.resolve();
      },
      // A REAL transaction, because both planes stand for processes that can die
      // between two statements. The identity default is honest only inside a
      // Durable Object, where a synchronous run cannot be interrupted — and a
      // suite that took the default would be proving atomicity it never had.
      transaction: <T>(body: () => T): T => this.db.transaction(body)(),
    });
    return this.live;
  }

  /** The process is gone. Nothing it held in RAM comes back — the in-flight set
   *  included, which is why a recovery can enter a sequence the dead process
   *  had entered. */
  restart(): void {
    this.live = null;
  }

  /** Effect keys in the order they actually ran. The lane's whole observable
   *  consequence is ORDER, so a count cannot witness it. */
  runOrder(): readonly string[] {
    return this.sql<{ effect_key: string }>`
      SELECT effect_key FROM conf_effect_runs ORDER BY rowid`.map((row) => row.effect_key);
  }


  advance(ms: number): void {
    this.clock += ms;
  }

  /** Make one effect report itself owed on its first execution. */
  hold(name: TerminalEffectName): void {
    void this.sql`INSERT OR IGNORE INTO conf_held (effect_key)
      VALUES (${terminalEffectKey(name, TRANSITION.messageId)})`;
  }

  /** Arm, or disarm, the interruption. Never persisted: a process death does
   *  not survive itself. */
  interruptAt(phase: TerminalEffectPhase | null, name?: TerminalEffectName): void {
    this.cut = phase === null || name === undefined ? null : { phase, name };
  }

  /** One settled response, driven through this transport. Returns as soon as the
   *  adapter's `hold` has taken the close, exactly as `onChatResponse` does. */
  async settle(declare: () => readonly OwedEffect[]): Promise<void> {
    await this.capture(async () => {
      await this.process().settle({
        transition: TRANSITION,
        declare,
        hold: (_claimed, close) => { this.carry(close); },
      });
    });
  }

  /** Let the transport finish the close it is carrying: the driver drains its
   *  queue, or the process awaits what it started. */
  async join(): Promise<void> {
    for (;;) {
      const close = this.deferred.shift();
      if (close === undefined) break;
      await this.capture(close);
    }
    const closing = this.closing;
    this.closing = null;
    if (closing !== null) await closing;
  }

  /**
   * Bring a process back for whatever is still owed, the way this transport
   * does.
   *
   * The alarm shape depends on a wake having been armed and being due; the
   * startup shape has the next start and needs neither. Same core entry point
   * under both — a machine that converges only when something re-arms it for
   * free would show up here as a divergence.
   */
  async recover(): Promise<void> {
    // Consumed under both transports — a start supersedes the arm it found
    // exactly as firing spends it — so what remains afterwards is what this
    // recovery itself asked for.
    if (this.kind === 'alarm' && (this.wakeAt === null || this.wakeAt > this.clock)) return;
    this.wakeAt = null;
    this.restart();
    await this.capture(async () => { await this.process().replayOwedAndRearm(); });
  }

  snapshot(): Snapshot {
    const rows = this.sql<EffectLedgerRow>`
      SELECT sequence_id, effect_key, effect_name, scope, seq, status, input_json, outcome,
             attempts, next_attempt_at, settled_at
      FROM terminal_effects ORDER BY sequence_id, seq, effect_key`;
    const runs: Record<string, number> = {};
    for (const row of this.sql<{ effect_key: string; runs: number }>`
      SELECT effect_key, COUNT(*) AS runs FROM conf_effect_runs
      GROUP BY effect_key ORDER BY effect_key`) {
      runs[row.effect_key] = row.runs;
    }
    const outputs: Record<string, string> = {};
    for (const row of this.sql<{ output_key: string; payload: string }>`
      SELECT output_key, payload FROM conf_effect_output ORDER BY output_key`) {
      outputs[row.output_key] = row.payload;
    }
    return {
      effects: rows.map((row) => ({
        sequence: row.sequence_id,
        key: row.effect_key,
        name: row.effect_name,
        scope: row.scope,
        seq: row.seq,
        status: row.status,
        input: row.input_json,
        outcome: row.outcome,
        attempts: row.attempts,
        due: row.next_attempt_at <= this.clock,
        settled: row.settled_at !== null,
      })),
      claims: this.sql<{ turn_id: string; normalized_call_id: string; result_json: string | null }>`
        SELECT turn_id, normalized_call_id, result_json FROM tool_effect_claims
        ORDER BY turn_id, normalized_call_id`
        .map((row) => ({ turn: row.turn_id, call: row.normalized_call_id, result: row.result_json })),
      runs,
      runOrder: this.runOrder(),
      outputs,
      // Derived from what is still OWED, not from the last arm. A wake armed
      // before a replay and left pending after it fires once, finds nothing and
      // stops — the harmless failure the ledger deliberately prefers to a suffix
      // with no carrier. Reading the arm itself would call that a difference.
      wake: this.owedWake(),
      inFlight: this.live?.inFlightCount ?? 0,
      interrupts: [...this.interrupts],
    };
  }

  /** When the ledger would next need this process back, as a state rather than
   *  an instant: the two planes run on deliberately unequal clocks. */
  private owedWake(): 'none' | 'due' | 'future' {
    const at = this.live?.nextRetryAt() ?? null;
    if (at === null) return 'none';
    return at <= this.clock ? 'due' : 'future';
  }

  /** `alarm` defers the close; `startup` starts it and holds the promise. */
  private carry(close: () => Promise<void>): void {
    if (this.kind === 'alarm') {
      this.deferred.push(close);
      return;
    }
    this.closing = this.capture(close);
  }

  /**
   * An interruption is caught HERE, one frame outside everything the transition
   * runs — where the platform's own handler sits when an activation dies. Any
   * other throw is a defect and travels.
   */
  private async capture(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof TerminalEffectInterrupt)) throw err;
      this.interrupts.push(err.message);
    }
  }

  private fault(): TerminalEffectFault | null {
    const cut = this.cut;
    if (cut === null) return null;
    return (phase, name, scope) => {
      if (phase !== cut.phase || name !== cut.name) return;
      throw new TerminalEffectInterrupt(phase, name, scope);
    };
  }

  /**
   * Both adapters run the same bodies, and every body writes twice: an
   * append-only execution row, then its output under the effect's own versioned
   * key. The output write is idempotent by construction, which is what makes
   * replaying an owed row safe rather than a second side effect.
   */
  private effects(): TerminalEffectTable {
    const declare = (name: TerminalEffectName): TerminalEffect => terminalEffect({
      input: EffectInputSchema,
      run: (input, scope) => {
        const key = terminalEffectKey(name, scope);
        void this.sql`INSERT INTO conf_effect_runs (effect_key) VALUES (${key})`;
        const runs = this.sql<{ runs: number }>`
          SELECT COUNT(*) AS runs FROM conf_effect_runs WHERE effect_key = ${key}`[0]?.runs ?? 0;
        if (runs === 1 && this.sql`SELECT effect_key FROM conf_held WHERE effect_key = ${key}`.length > 0) {
          return { status: 'owed', detail: 'the reply channel this answer owes is still open' };
        }
        void this.sql`INSERT OR IGNORE INTO conf_effect_output (output_key, payload)
          VALUES (${key}, ${input.answer})`;
        return { status: 'completed' };
      },
    });
    const table: { [K in TerminalEffectName]?: TerminalEffect } = {};
    for (const name of IMPLEMENTED) table[name] = declare(name);
    return table;
  }
}

/**
 * Run one scenario through both transports over two fresh databases, prove the
 * durable state came out identical, and hand it back for the scenario's own
 * claims.
 *
 * The diff is the conformance claim; the returned snapshot is where a scenario
 * says what that shared state must actually BE, so that a machine broken the
 * same way under both adapters still fails.
 */
async function conform(script: (plane: Plane) => Promise<void>): Promise<Snapshot> {
  const alarm = new Plane('alarm');
  const startup = new Plane('startup');
  try {
    await script(alarm);
    await script(startup);
    const detached = alarm.snapshot();
    expect(startup.snapshot()).toEqual(detached);
    return detached;
  } finally {
    alarm.close();
    startup.close();
  }
}

/** Effect keys, as the scenarios name them. */
const K = (name: TerminalEffectName): string => terminalEffectKey(name, TRANSITION.messageId);

/** Which rows survive, and in what disposition. */
function dispositions(snap: Snapshot): Record<string, string> {
  return Object.fromEntries(snap.effects.map((row) => [row.key, row.status]));
}

/** The claim table as a scenario reads it: which claims exist, and which are
 *  closed. */
function claimState(snap: Snapshot): Record<string, string | null> {
  return Object.fromEntries(snap.claims.map((row) => [row.call, row.result]));
}

const TERMINAL_CLAIM_CALL = `${TERMINAL_TRANSITION_CALL_ID}:${TRANSITION.messageId}`;
// The stored result is the JSON encoding of the string 'settled'.
const SETTLED = JSON.stringify('settled');

/** Every declared effect ran exactly once, and wrote exactly one output. */
const RAN_ONCE: Record<string, number> = Object.fromEntries(SEQUENCE.map((name) => [K(name), 1]));
const EVERY_OUTPUT: Record<string, string> = Object.fromEntries(
  SEQUENCE.map((name) => [K(name), ANSWER]),
);

let restoreDiagnostics: (() => void) | null = null;

beforeAll(() => {
  // The blocked-row scenario and the duplicate callback both report themselves.
  // Recorded rather than printed: the claims here are about rows.
  restoreDiagnostics = setDiagnosticsSink(createRecordingLogger());
});

afterAll(() => {
  restoreDiagnostics?.();
});

describe('terminal transition conformance across two adapters', () => {
  test('a clean sequence settles, prunes its rows and releases the turn tool claims', async () => {
    const snap = await conform(async (plane) => {
      await plane.settle(() => roster(SEQUENCE));
      await plane.join();
    });

    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
    expect(snap.inFlight).toBe(0);
    expect(snap.interrupts).toEqual([]);
  });

  test('an interruption before a side effect leaves the suffix owed, and a recovery runs it', async () => {
    const snap = await conform(async (plane) => {
      plane.interruptAt('before', 'turn_record');
      await plane.settle(() => roster(SEQUENCE));
      await plane.join();

      const cut = plane.snapshot();
      expect(dispositions(cut)).toEqual({
        [K('takes')]: 'completed',
        [K('event_reply')]: 'completed',
        [K('turn_record')]: 'pending',
        [K('auto_title')]: 'pending',
      });
      // Nothing happened at the cut point, and the effects after it never
      // started: the claim is what names them.
      expect(cut.runs).toEqual({ [K('takes')]: 1, [K('event_reply')]: 1 });
      expect(claimState(cut)[TERMINAL_CLAIM_CALL]).toBeNull();

      plane.interruptAt(null);
      plane.advance(PAST_BACKOFF_MS);
      await plane.recover();
    });

    expect(snap.interrupts).toEqual([
      'terminal effect turn_record:msg-answer interrupted before its side effect',
    ]);
    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
    expect(snap.wake).toBe('none');
  });

  test('an interruption after a side effect replays the body without repeating the effect', async () => {
    const snap = await conform(async (plane) => {
      plane.interruptAt('after', 'turn_record');
      await plane.settle(() => roster(SEQUENCE));
      await plane.join();

      const cut = plane.snapshot();
      // The side effect happened and nothing recorded that it did.
      expect(cut.outputs[K('turn_record')]).toBe(ANSWER);
      expect(dispositions(cut)[K('turn_record')]).toBe('pending');

      plane.interruptAt(null);
      plane.advance(PAST_BACKOFF_MS);
      await plane.recover();
    });

    expect(snap.interrupts).toEqual([
      'terminal effect turn_record:msg-answer interrupted after its side effect',
    ]);
    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    // The body ran twice; the boundary it writes through moved once.
    expect(snap.runs).toEqual({ ...RAN_ONCE, [K('turn_record')]: 2 });
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
  });

  test('an owed effect holds the transition open until a later pass closes it', async () => {
    const snap = await conform(async (plane) => {
      plane.hold(HELD);
      await plane.settle(() => roster(SEQUENCE));
      await plane.join();

      const held = plane.snapshot();
      // Owed, not failed: the row keeps its input and gates the close while
      // every other effect of the sequence has completed.
      expect(dispositions(held)).toEqual({
        [K('takes')]: 'completed',
        [K('event_reply')]: 'pending',
        [K('turn_record')]: 'completed',
        [K('auto_title')]: 'completed',
      });
      expect(held.effects.find((row) => row.key === K(HELD))?.outcome)
        .toBe('owed: the reply channel this answer owes is still open');
      expect(claimState(held)).toEqual({
        [TERMINAL_CLAIM_CALL]: null,
        [TOOL_CLAIM.callId]: null,
      });
      expect(held.wake).toBe('future');

      plane.advance(PAST_BACKOFF_MS);
      await plane.recover();
    });

    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    expect(snap.runs).toEqual({ ...RAN_ONCE, [K(HELD)]: 2 });
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
    expect(snap.interrupts).toEqual([]);
  });

  test('a duplicate callback arriving mid-flight runs nothing twice', async () => {
    const snap = await conform(async (plane) => {
      const first = plane.settle(() => roster(SEQUENCE));
      const duplicate = plane.settle(() => roster(SEQUENCE));
      await Promise.all([first, duplicate]);
      await plane.join();
    });

    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
    expect(snap.inFlight).toBe(0);
  });

  test('a resumed response runs the recorded roster and never re-declares', async () => {
    const snap = await conform(async (plane) => {
      plane.interruptAt('before', 'turn_record');
      await plane.settle(() => roster(SEQUENCE));
      await plane.join();

      plane.interruptAt(null);
      plane.advance(PAST_BACKOFF_MS);
      // The process that claimed the sequence is gone; the next one settles the
      // same response with a roster that has grown under it.
      plane.restart();
      // Counted for the record, not asserted at zero: the gather runs BEFORE any
      // durable write so a throw inside it cannot leave an open claim with no
      // rows, which means a resumed response gathers and then discards. What must
      // not happen is a ROW appearing for the effect it re-declared.
      let declared = 0;
      await plane.settle(() => {
        declared += 1;
        return roster([...SEQUENCE, LATE]);
      });
      await plane.join();
      expect(declared).toBeGreaterThan(0);
    });

    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    // The late effect has no row, no execution and no output: the roster was
    // frozen at what the first attempt claimed.
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.outputs).toEqual(EVERY_OUTPUT);
    expect(snap.runs[K(LATE)]).toBeUndefined();
  });

  test('an effect this build cannot run stays blocked, owed, and holds the transition open', async () => {
    const snap = await conform(async (plane) => {
      await plane.settle(() => roster([...SEQUENCE, UNIMPLEMENTED]));
      await plane.join();
      plane.advance(PAST_BACKOFF_MS);
      await plane.recover();
    });

    // Nothing was pruned, because nothing closed: a blocked row is work a
    // deploy still owes.
    expect(dispositions(snap)).toEqual({
      [K('takes')]: 'completed',
      [K('event_reply')]: 'completed',
      [K('turn_record')]: 'completed',
      [K('auto_title')]: 'completed',
      [K(UNIMPLEMENTED)]: 'blocked',
    });
    const blocked = snap.effects.find((row) => row.key === K(UNIMPLEMENTED));
    expect(blocked?.outcome)
      .toBe(`effect "${UNIMPLEMENTED}" is not implemented by this actor`);
    // Attempted again by the recovery, and still blocked: convergence to
    // success would delete the only evidence the work never happened.
    expect(blocked?.attempts).toBe(2);
    expect(claimState(snap)).toEqual({
      [TERMINAL_CLAIM_CALL]: null,
      [TOOL_CLAIM.callId]: null,
    });
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.wake).toBe('future');
  });

  /**
   * A DETACHED row does not hold the inline work behind it, on replay either.
   *
   * The forward path runs every inline effect and only then starts the detached
   * ones, but the roster interleaves them: a reply is declared before the
   * recording. Recovery walks stored rows, so unless the LANE is stored too it
   * walks them serially — and a reply whose channel hangs then blocks a recording
   * the live path had already committed. This pins the lane onto the row.
   */
  test('replay runs the inline work before the detached row declared ahead of it', async () => {
    const snapshot = await conform(async (plane) => {
      // Detached FIRST in declared order, inline SECOND. A replay that walked the
      // stored roster serially would run them in that order; the forward path
      // never would, and a detached reply that hangs would then hold the
      // recording behind it indefinitely.
      const roster = (): readonly OwedEffect[] => [
        { name: 'auto_title', scope: TRANSITION.messageId, lane: 'detached', input: { answer: 'a' } },
        { name: 'turn_record', scope: TRANSITION.messageId, lane: 'inline', input: { answer: 'r' } },
      ];
      // Cut on the INLINE row, which the forward path reaches first: nothing runs,
      // so the replay is handed BOTH rows and its scheduling is what decides the
      // order below.
      plane.interruptAt('before', 'turn_record');
      await plane.settle(roster);
      await plane.join();
      plane.interruptAt(null);
      plane.restart();
      plane.advance(PAST_BACKOFF_MS);
      await plane.recover();
    });
    expect(snapshot.runOrder).toEqual([K('turn_record'), K('auto_title')]);
    expect(snapshot.runs[K('turn_record')]).toBe(1);
    expect(snapshot.runs[K('auto_title')]).toBe(1);
  });

  /**
   * A roster is all or nothing.
   *
   * Every row is inserted under one commit, because a PREFIX is what recovery
   * cannot tell from a complete roster: it replays what it finds and then closes
   * the outer claim over everything absent. A transaction that throws part-way
   * must leave the storage exactly as it was.
   */
  test('a roster that fails part-way through inserts nothing', async () => {
    const plane = new Plane('alarm');
    try {
      // A roster whose second input cannot be serialized: the insert throws
      // inside the commit, after the first row has been written.
      const circular: JsonObject = {};
      circular.self = circular;
      const roster = (): readonly OwedEffect[] => [
        { name: 'takes', scope: TRANSITION.messageId, lane: 'inline', input: { answer: 'a' } },
        {
          name: 'turn_record', scope: TRANSITION.messageId, lane: 'inline',
          input: circular,
        },
      ];
      await expect(plane.settle(roster)).rejects.toThrow();
      const after = plane.snapshot();
      // NEITHER row. The first insert is rolled back with the failed one.
      expect(after.effects).toEqual([]);
      // AND NO OUTER CLAIM. This is the half that makes the rollback matter: a
      // claim with no roster behind it is what a recovery reads as a finished
      // turn — it replays an empty suffix, settles, and every effect the
      // response owed is gone. The claim belongs in the same commit as the rows
      // it gates.
      expect(after.claims.some((row) => row.call.startsWith(TERMINAL_TRANSITION_CALL_ID))).toBe(false);
    } finally {
      plane.close();
    }
  });

});
