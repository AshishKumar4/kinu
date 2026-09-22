/**
 * Differential conformance: each scenario runs over an `alarm` and a `startup` transport and the
 * normalized storage must match.
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
import type { ActorHandle } from '../src/identity/actor-handle';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';

const TRANSITION: TerminalTransition = { turnId: 'turn-conformance', messageId: 'msg-answer' };

const ANSWER = 'the answer this turn settled on';

/** Same-turn tool claim; `end` must keep it while the turn can still settle. */
const TOOL_CLAIM: ToolEffectKey = {
  turnId: TRANSITION.turnId, callId: 'write_file#1', digest: 'conformance-tool-digest',
};

const SEQUENCE = [
  'takes', 'event_reply', 'turn_record', 'auto_title',
] as const satisfies readonly TerminalEffectName[];

/** Last, so a cut on an inline effect leaves an exact suffix. */
const DETACHED: TerminalEffectName = 'auto_title';

const HELD: TerminalEffectName = 'event_reply';

/** A resumed response's second `declare()` must not add this. */
const LATE: TerminalEffectName = 'branches';

const UNIMPLEMENTED: TerminalEffectName = 'parent_report';

const IMPLEMENTED: readonly TerminalEffectName[] = [...SEQUENCE, LATE];

const EffectInputSchema = v.object({ answer: v.string() });

/** An attempt arms its schedule before the side effect, so an earlier replay is deferred. */
const PAST_BACKOFF_MS = TERMINAL_EFFECT_RETRY_BASE_MS + 1;

type AdapterKind = 'alarm' | 'startup';

/** Unequal so the normalization is load-bearing. */
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

/** Digest omitted: a wrong one shows up as a second row. */
interface ClaimView {
  readonly turn: string;
  readonly call: string;
  readonly result: string | null;
}

interface Snapshot {
  readonly effects: readonly EffectView[];
  readonly claims: readonly ClaimView[];
  /** 2 means a body ran twice. */
  readonly runs: Record<string, number>;
  readonly outputs: Record<string, string>;
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

/** The database outlives every process. */
class Plane {
  private readonly db = new Database(':memory:');
  private readonly sql = makeSql(this.db);
  private readonly execRaw = makeExecRaw(this.db);
  private readonly actor = createTestActors(this.sql, this.execRaw).main;

  private clock: number;
  private cut: { readonly phase: TerminalEffectPhase; readonly name: TerminalEffectName } | null = null;
  /** Survives restart. */
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
    claimToolEffect(this.sql, this.actor, TOOL_CLAIM);
  }

  close(): void {
    this.db.close();
  }

  process(): TerminalTransitions {
    this.live ??= new TerminalTransitions({
      sql: this.sql,
      actor: this.actor,
      effects: this.effects(),
      now: () => this.clock,
      fault: () => this.fault(),
      scheduleRetry: async (atMs: number) => {
        this.wakeAt = atMs;
        await Promise.resolve();
      },
      // A real transaction: both planes stand for processes that can die between statements.
      transaction: <T>(body: () => T): T => this.db.transaction(body)(),
    });

    return this.live;
  }

  restart(): void {
    this.live = null;
  }

  runOrder(): readonly string[] {
    return this.sql<{ effect_key: string }>`
      SELECT effect_key FROM conf_effect_runs ORDER BY rowid`.map((row) => row.effect_key);
  }


  advance(ms: number): void {
    this.clock += ms;
  }

  hold(name: TerminalEffectName): void {
    void this.sql`INSERT OR IGNORE INTO conf_held (effect_key)
      VALUES (${terminalEffectKey(name, TRANSITION.messageId)})`;
  }

  interruptAt(phase: TerminalEffectPhase | null, name?: TerminalEffectName): void {
    this.cut = phase === null || name === undefined ? null : { phase, name };
  }

  async settle(declare: () => readonly OwedEffect[]): Promise<void> {
    await this.capture(async () => {
      await this.process().settle({
        transition: TRANSITION,
        declare,
        hold: (_claimed, close) => { this.carry(close); },
      });
    });
  }

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

  async settleOnLostCarrier(declare: () => readonly OwedEffect[]): Promise<void> {
    const reported: Promise<void>[] = [];

    await this.process().settle({
      transition: TRANSITION,
      declare,
      hold: (claimed) => {
        this.wakeAt = null;
        reported.push(this.process().closeFailed(claimed, { cause: new Error('the carrier died before the close ran') }));
      },
    });
    await Promise.all(reported);
  }

  /** False when nothing was armed. */
  async wakeLive(): Promise<boolean> {
    if (this.wakeAt === null) return false;
    this.clock = Math.max(this.clock, this.wakeAt);
    this.wakeAt = null;
    await this.capture(async () => { await this.process().replayOwedAndRearm(); });

    return true;
  }

  async recover(): Promise<void> {
    // Consumed under both transports.
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
      // Derived from what is still owed, not the last arm.
      wake: this.owedWake(),
      inFlight: this.live?.inFlightCount ?? 0,
      interrupts: [...this.interrupts],
    };
  }

  private owedWake(): 'none' | 'due' | 'future' {
    const at = this.live?.nextRetryAt() ?? null;

    if (at === null) return 'none';

    return at <= this.clock ? 'due' : 'future';
  }

  private carry(close: () => Promise<void>): void {
    if (this.kind === 'alarm') {
      this.deferred.push(close);

      return;
    }

    this.closing = this.capture(close);
  }

  /** Catches only interruptions; any other throw is a defect and travels. */
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

  /** Output is keyed and idempotent, so replaying an owed row is safe. */
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

/** Diffs durable state across transports and returns it. */
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

test('a recorded terminal roster recovers through the same lifecycle on both transports', async () => {
  const snap = await conform(async (plane) => {
    plane.process().record(TRANSITION, roster(SEQUENCE));
    expect(plane.runOrder()).toEqual([]);
    plane.restart();
    await plane.process().resumeAll();
    await plane.process().resumeAll();
  });

  expect(snap.effects).toEqual([]);
  expect(snap.runs).toEqual(RAN_ONCE);
  expect(snap.outputs).toEqual(EVERY_OUTPUT);
});

test('recorded terminal rosters with colliding identities belong only to their actor', async () => {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actors = createTestActors(sql, execRaw);
  const child = actors.sibling('child');
  const effects: string[] = [];
  initTerminalEffectTable(execRaw);
  initToolEffectClaimTable(execRaw);

  const open = (actor: ActorHandle) => new TerminalTransitions({
    sql, actor, now: () => 0, scheduleRetry: async () => {},
    transaction: (body) => db.transaction(body)(),
    effects: {
      turn_record: terminalEffect({
        input: EffectInputSchema,
        run: ({ answer }) => {
          effects.push(`${actor.actorId}:${answer}`);

          return { status: 'completed' };
        },
      }),
    },
  });

  const root = open(actors.main);
  const subordinate = open(child);
  root.record(TRANSITION, [{ name: 'turn_record', scope: 'same', lane: 'inline', input: { answer: 'root' } }]);
  subordinate.record(TRANSITION, [{ name: 'turn_record', scope: 'same', lane: 'inline', input: { answer: 'child' } }]);
  await open(actors.main).resumeAll();
  expect(effects).toEqual([`${actors.main.actorId}:root`]);
  expect(subordinate.incomplete()).toEqual([TRANSITION]);
  await open(child).resumeAll();
  await open(actors.main).resumeAll();
  await open(child).resumeAll();
  expect(effects).toEqual([`${actors.main.actorId}:root`, `${child.actorId}:child`]);
  expect(root.incomplete()).toEqual([]);
  expect(subordinate.incomplete()).toEqual([]);
  db.close();
});

test('an unsupported recorded roster remains inspectable and owed after reopening', async () => {
  await conform(async (plane) => {
    plane.process().record(TRANSITION, roster([UNIMPLEMENTED]));
    plane.restart();
    await plane.process().resumeAll();
    const sequence = plane.process().sequenceId(TRANSITION);
    const owed = plane.process().ledger.owed(sequence);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ status: 'blocked', rawName: UNIMPLEMENTED, input: JSON.stringify({ answer: ANSWER }) });
    plane.restart();
    await plane.process().resumeAll();
    expect(plane.process().ledger.owed(sequence)).toEqual(owed);
    expect(plane.process().incomplete()).toEqual([TRANSITION]);
  });
});

test('an unreadable recorded effect input is retained instead of dropping its obligation', async () => {
  await conform(async (plane) => {
    plane.process().record(TRANSITION, [{ name: 'takes', scope: 'answer', lane: 'inline', input: { answer: 42 } }]);
    plane.restart();
    await plane.process().resumeAll();
    plane.advance(PAST_BACKOFF_MS);
    plane.restart();
    await plane.process().resumeAll();

    const owed = plane.process().ledger.owed(plane.process().sequenceId(TRANSITION));
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ rawName: 'takes', input: '{"answer":42}', attempts: 2 });
    expect(plane.process().incomplete()).toEqual([TRANSITION]);
    expect(plane.runOrder()).toEqual([]);
  });
});

const K = (name: TerminalEffectName): string => terminalEffectKey(name, TRANSITION.messageId);

function dispositions(snap: Snapshot): Record<string, string> {
  return Object.fromEntries(snap.effects.map((row) => [row.key, row.status]));
}

function claimState(snap: Snapshot): Record<string, string | null> {
  return Object.fromEntries(snap.claims.map((row) => [row.call, row.result]));
}

const TERMINAL_CLAIM_CALL = `${TERMINAL_TRANSITION_CALL_ID}:${TRANSITION.messageId}`;

// The stored result is the JSON encoding of the string 'settled'.
const SETTLED = JSON.stringify('settled');

const RAN_ONCE: Record<string, number> = Object.fromEntries(SEQUENCE.map((name) => [K(name), 1]));

const EVERY_OUTPUT: Record<string, string> = Object.fromEntries(
  SEQUENCE.map((name) => [K(name), ANSWER]),
);

let restoreDiagnostics: (() => void) | null = null;

beforeAll(() => {
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

  test('a close whose carrier dies is released and re-armed, so the live process closes it', async () => {
    const snap = await conform(async (plane) => {
      await plane.settleOnLostCarrier(() => roster(SEQUENCE.filter((name) => name !== DETACHED)));
      const lost = plane.snapshot();
      // Later sweeps would skip a sequence the dead process held.
      expect(claimState(lost)[TERMINAL_CLAIM_CALL]).toBeNull();
      expect(lost.inFlight).toBe(0);
      // No row is owed, so only the re-arm brings it back.
      expect(await plane.wakeLive()).toBe(true);
    });

    expect(snap.effects).toEqual([]);
    expect(claimState(snap)).toEqual({ [TERMINAL_CLAIM_CALL]: SETTLED });
    expect(snap.inFlight).toBe(0);
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
      // Owed, not failed: the row gates the close.
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
      plane.restart();
      // Not asserted at zero; no row may appear for the re-declared effect.
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

    // Nothing pruned: a blocked row is work a deploy still owes.
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
    // Still blocked: converging to success would erase the evidence.
    expect(blocked?.attempts).toBe(2);
    expect(claimState(snap)).toEqual({
      [TERMINAL_CLAIM_CALL]: null,
      [TOOL_CLAIM.callId]: null,
    });
    expect(snap.runs).toEqual(RAN_ONCE);
    expect(snap.wake).toBe('future');
  });

  /** A detached row must not hold inline work behind it on replay. */
  test('replay runs the inline work before the detached row declared ahead of it', async () => {
    const snapshot = await conform(async (plane) => {
      // Detached first: a serial replay would let a hanging reply block the recording.
      const declared = (): readonly OwedEffect[] => [
        { name: 'auto_title', scope: TRANSITION.messageId, lane: 'detached', input: { answer: 'a' } },
        { name: 'turn_record', scope: TRANSITION.messageId, lane: 'inline', input: { answer: 'r' } },
      ];

      plane.interruptAt('before', 'turn_record');
      await plane.settle(declared);
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

  /** A roster is all or nothing: recovery cannot tell a prefix from a complete one. */
  test('a roster that fails part-way through inserts nothing', async () => {
    const plane = new Plane('alarm');

    try {
      // The insert throws after the first row is written.
      const circular: JsonObject = {};
      circular.self = circular;

      const declared = (): readonly OwedEffect[] => [
        { name: 'takes', scope: TRANSITION.messageId, lane: 'inline', input: { answer: 'a' } },
        {
          name: 'turn_record', scope: TRANSITION.messageId, lane: 'inline',
          input: circular,
        },
      ];

      await expect(plane.settle(declared)).rejects.toThrow();
      const after = plane.snapshot();
      expect(after.effects).toEqual([]);
      // No outer claim either: without its roster it reads as a finished turn.
      expect(after.claims.some((row) => row.call.startsWith(TERMINAL_TRANSITION_CALL_ID))).toBe(false);
    } finally {
      plane.close();
    }
  });

});
