/**
 * The terminal transition lifecycle, carried across an isolate the object never
 * chose to end.
 *
 * WHAT THIS EXERCISES. Core's own `TerminalTransitions` — the class production
 * drives, not a copy of its choreography — over REAL Durable Object SQLite, with
 * a real alarm as its wake, driven across `abortAllDurableObjects()`: an isolate
 * death, not a simulated one. That means the in-activation guard, the durable
 * claim, the roster freeze, `resumeAll`, the close gate and the recovery arming
 * are all the shipped implementations. This file used to reimplement each of
 * them, so the real-isolate suite stayed green for defects in the lifecycle and
 * proved only the ledger underneath it.
 *
 * The schema comes from `initTerminalEffectTable` and `initToolEffectClaimTable`,
 * so a probe cannot pass against a table production has drifted away from.
 *
 * The claim is ALSO exercised on its own, keyed on an ordinary tool call rather
 * than on a terminal transition (`claimTool`/`settleTool`). The transition path
 * reads only settled-or-not, so it never reaches `indeterminate` — the answer
 * that REFUSES — and that answer is reachable only when an activation dies
 * between a claim and its settle.
 *
 * WHAT IT DOES NOT. `onChatResponse` and everything above it. Reaching a real
 * terminal sequence through the ACTOR means an `ActorAgent` turn, which needs the
 * hosted workspace plane this pool loads none of (NIMBUS_SESSION's wasm subgraph,
 * LOADER's worker_loaders) and a model to answer with. So what this object
 * supplies is exactly what the actor supplies — the effect BODIES and the WAKE —
 * and nothing between them; `tests/unit-durable-terminal.test.ts` is where the
 * actor half runs.
 *
 * WHY IT CANNOT LIVE UNDER `bun test`. Every claim below is about what SURVIVES.
 * Outside workerd there is no isolate reset, so "the surviving rows name the
 * unfinished suffix" is a statement about a table a test wrote by hand, and
 * there is no alarm, so "convergence comes from a durable wake" cannot be
 * observed at all — the bun tier reaches recovery by calling it.
 *
 * THE DUPLICATE ORACLE IS TWO TABLES, not a spy, because the two questions are
 * different and an eviction separates them:
 *   • `probe_effect_runs` is append-only and counts EXECUTIONS. Two rows for one
 *     effect key means a later activation ran the body again.
 *   • `probe_effect_output` is keyed on the effect's own identity and counts
 *     EFFECTS. Two rows would mean the side effect doubled.
 * An interruption between a side effect and its record makes the first count 2
 * and must leave the second at 1. That is precisely the guarantee that replaces
 * refusing to replay: the boundary is idempotent, so replaying is safe.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import {
  argumentDigest, claimToolEffect, initToolEffectClaimTable, parseJsonValue, settleToolEffect,
  type RawSqlExec, type SqlExecutor, type ToolEffectKey,
} from '@kinu.run/core';

import {
  initTerminalEffectTable, terminalEffect, TerminalEffectInterrupt, terminalEffectKey,
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID,
  type OwedEffect, type TerminalEffect, type TerminalEffectFault, type TerminalEffectName,
  type TerminalEffectPhase, type TerminalEffectTable,
} from '@kinu.run/core';

/**
 * One actor's declared sequence, in declared order and all INLINE.
 *
 * Real names from `TERMINAL_EFFECT_NAMES`, because the ledger's schema is the
 * union and a row naming anything else is a different test. Inline throughout so
 * a cut leaves an exact suffix: detached effects start in one tick, and a
 * suffix assertion over them would be an assertion about scheduling.
 */
export const PROBE_SEQUENCE = [
  'takes', 'event_reply', 'turn_record', 'auto_title', 'auto_gepa',
] as const satisfies readonly TerminalEffectName[];

/** The effect that reports itself still owed on its first execution, so a
 *  sequence can be left legitimately unfinished without any fault: a reply
 *  channel that is still open is what `owed` means in production. */
export const HELD_EFFECT: TerminalEffectName = 'event_reply';

/**
 * A wake armed in the past is an immediate re-entry, and a re-entry that finds
 * the row a millisecond short of due arms the same instant again — a spin, not a
 * retry. The floor is the probe's, not the ledger's: the ledger decides WHEN,
 * this decides that the platform is asked no sooner than it can usefully answer.
 */
const WAKE_FLOOR_MS = 250;

/** Every effect here records the same thing, and the recording is the point: a
 *  replay reads this back off its row and writes its output from it, so an
 *  output that carries the answer proves the input survived the isolate. */
const ProbeInputSchema = v.object({ answer: v.string() });

/** The instant a test cuts the sequence at. Both phases matter: `before` is
 *  "nothing happened", `after` is "it happened and nothing recorded it". */
export interface ProbeCut {
  readonly name: TerminalEffectName;
  readonly phase: TerminalEffectPhase;
}

export interface ProbeSettleOpts {
  readonly cutAt?: ProbeCut;
  /** Make {@link HELD_EFFECT} report itself owed on its first execution. */
  readonly holdReply?: boolean;
}

/** One ledger row, with its recorded input decoded — which is the read a fresh
 *  activation has to be able to make. Deliberately not the whole row: the
 *  columns are the ledger's business and an assertion over the column list would
 *  break on every schema addition. */
export interface ProbeEffectRow {
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly answer: string;
}

/** How many times one effect's BODY has run. */
export interface ProbeExecution {
  readonly key: string;
  readonly runs: number;
}

/** One row of the keyed boundary an effect writes through. */
export interface ProbeOutput {
  readonly key: string;
  readonly payload: string;
}

/** One outer terminal transition, as the claims table holds it. `settled` is
 *  what the gate controls. */
export interface ProbeClaim {
  readonly turnId: string;
  readonly messageId: string;
  readonly settled: boolean;
}

/** One ordinary tool call, as a test names it. The digest is built here from
 *  `tool` and `args` rather than passed in, so two calls differing only in their
 *  arguments are two identities without a test having to spell that out. */
export interface ProbeToolCall {
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, string>;
}

/** What a claim read establishes, with the settled result as the JSON text it
 *  was recorded as. Flat because `JsonValue` is recursive and the Durable Object
 *  stub's serializer cannot map a recursive type; the text still comes back out
 *  of the claim's own parse, so a parse that dropped something would show. */
export interface ProbeToolClaim {
  readonly kind: 'claimed' | 'indeterminate' | 'settled';
  readonly result: string | null;
}

interface EffectLedgerSqlRow {
  effect_key: string;
  effect_name: string;
  status: string;
  input_json: string;
}

export class TerminalEffectProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the same assertion `bindAgentSql` (runtime.ts:113) makes, at the
  // same boundary and for the same reason — `SqlExecutor` and the platform's
  // `sql.exec` are one tagged-template protocol, and `SqlExecutor` additionally
  // admits ArrayBuffer, which Durable Object SQLite binds at runtime and does
  // not type. The Agents SDK is not hosted in this worker, so the bridge is here.
  private readonly sql = ((
    query: TemplateStringsArray, ...values: SqlStorageValue[]
  ) => this.ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

  private readonly execRaw: RawSqlExec = (ddl: string) => {
    this.ctx.storage.sql.exec(ddl);
  };

  private initialized = false;

  /** Lazy per activation, the shape `UserDO.ensureInit` uses: DDL is synchronous
   *  over Durable Object SQLite, so it needs no init gate, and every entry point
   *  below — including `alarm()`, which arrives on an activation nothing else
   *  has touched — passes through here first. */
  private ensureInit(): void {
    if (this.initialized) return;
    initTerminalEffectTable(this.execRaw);
    initToolEffectClaimTable(this.execRaw);
    this.execRaw(`CREATE TABLE IF NOT EXISTS probe_effect_runs (
      effect_key TEXT NOT NULL,
      ran_at     INTEGER NOT NULL
    )`);
    this.execRaw(`CREATE TABLE IF NOT EXISTS probe_effect_output (
      output_key TEXT PRIMARY KEY,
      payload    TEXT NOT NULL
    )`);
    this.execRaw(`CREATE TABLE IF NOT EXISTS probe_held_scope (scope TEXT PRIMARY KEY)`);
    this.execRaw(`CREATE TABLE IF NOT EXISTS probe_alarm_runs (at INTEGER NOT NULL)`);
    this.initialized = true;
  }

  /** Armed by one call, never persisted: a cut point is an isolate death, and an
   *  isolate death does not survive itself. */
  private fault: TerminalEffectFault | null = null;

  /**
   * How far ahead of the wall clock this activation's lifecycle reads. Zero
   * except where a test has to reach a retry instant.
   *
   * An owed row is not attempted before `next_attempt_at`, and a probe that slept
   * would bind its runtime to the backoff schedule. Mutable on the field rather
   * than a constructor argument because the lifecycle is ONE object per
   * activation — its in-flight guard is part of what is under test, so a second
   * instance would hand every duplicate a fresh empty set.
   */
  private clockSkewMs = 0;

  private _transitions: TerminalTransitions | null = null;

  /**
   * The production lifecycle, with the two things a Durable Object owns wired to
   * this object: the effect bodies below, and the alarm.
   *
   * One instance per activation, exactly as `ActorAgent` holds one.
   */
  private get transitions(): TerminalTransitions {
    this._transitions ??= new TerminalTransitions({
      sql: this.sql,
      effects: this.effectTable(),
      now: () => Date.now() + this.clockSkewMs,
      fault: () => this.fault,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      // Written on the spot and AWAITED, as production's schedule row is: core
      // arms BEFORE it replays, because a one-shot alarm must not be consumed
      // with the suffix still uncarried, and a wake held in RAM until the call
      // returns is one an eviction can take with it.
      //
      // SOONEST WINS, which is why the armed slot is read first. Core arms once
      // before a pass and again after it, and the second instant is the later
      // one — overwriting would push the wake past the row that is already due.
      scheduleRetry: async (atMs) => {
        const at = Math.max(atMs, Date.now() + WAKE_FLOOR_MS);
        const armed = await this.ctx.storage.getAlarm();
        if (armed !== null && armed <= at) return;
        await this.ctx.storage.setAlarm(at);
      },
    });
    return this._transitions;
  }

  /**
   * This actor's effects. Every one of them writes twice: an append-only
   * execution row, then its keyed output.
   *
   * The output key is the effect's own versioned identity, so the write is
   * idempotent by construction — which is what makes the effect replayable
   * rather than indeterminate, and is the only reason a replay of an effect
   * that already ran is safe.
   */
  private effectTable(): TerminalEffectTable {
    const declare = (name: TerminalEffectName): TerminalEffect => terminalEffect({
      input: ProbeInputSchema,
      run: (input, scope) => {
        const key = terminalEffectKey(name, scope);
        void this.sql`INSERT INTO probe_effect_runs (effect_key, ran_at) VALUES (${key}, ${Date.now()})`;
        const runs = this.sql<{ runs: number }>`
          SELECT COUNT(*) AS runs FROM probe_effect_runs WHERE effect_key = ${key}`[0]?.runs ?? 0;
        if (name === HELD_EFFECT && runs === 1
          && this.sql`SELECT scope FROM probe_held_scope WHERE scope = ${scope}`.length > 0) {
          return { status: 'owed', detail: 'the reply channel this answer owes is still open' };
        }
        void this.sql`INSERT OR IGNORE INTO probe_effect_output (output_key, payload)
          VALUES (${key}, ${input.answer})`;
        return { status: 'completed' };
      },
    });
    const table: { [K in TerminalEffectName]?: TerminalEffect } = {};
    for (const name of PROBE_SEQUENCE) table[name] = declare(name);
    return table;
  }

  private owedEffects(messageId: string, answer: string): OwedEffect[] {
    return PROBE_SEQUENCE.map((name) => ({
      name, scope: messageId, input: { answer }, lane: 'inline' as const,
    }));
  }

  /**
   * One settled turn's terminal sequence, through core's `settle`.
   *
   * Everything the actor supplies is supplied here and nothing else: the roster
   * thunk, the effect bodies, and a `hold` that keeps this RPC alive for the
   * close. The claim, the in-flight guard, the roster freeze, the inline pass and
   * the close gate are core's.
   *
   * Answers the cut's message, or null when the sequence ran to the end. The
   * interrupt is caught HERE and nowhere inside — one frame further out than
   * every effect and than the closing path, which is where the platform's own
   * handler sits when a real activation dies. A rejection across the Durable
   * Object RPC boundary would additionally be an uncaught exception in the
   * object, and workerd reports it as one; the claim under test is that nothing
   * after the throw ran, not how the runtime logs it.
   */
  async settle(
    turnId: string, messageId: string, answer: string, opts?: ProbeSettleOpts,
  ): Promise<string | null> {
    this.ensureInit();
    if (opts?.holdReply === true) {
      void this.sql`INSERT OR IGNORE INTO probe_held_scope (scope) VALUES (${messageId})`;
    }
    const cut = opts?.cutAt;
    this.fault = cut === undefined
      ? null
      : (phase, name, scope) => {
        if (phase !== cut.phase || name !== cut.name) return;
        throw new TerminalEffectInterrupt(phase, name, scope);
      };
    // AWAITED, unlike the Durable Object's fiber: this RPC is what keeps the
    // object alive for the close, so a test observes the same state a fiber would
    // have reached rather than racing it.
    let closing: Promise<void> = Promise.resolve();
    try {
      await this.transitions.settle({
        transition: { turnId, messageId },
        declare: () => this.owedEffects(messageId, answer),
        hold: (_claimed, close) => { closing = close(); },
      });
      await closing;
    } catch (err) {
      if (!(err instanceof TerminalEffectInterrupt)) throw err;
      return err.message;
    }
    await this.releaseWakeIfConverged();
    return null;
  }

  /**
   * Two settles of ONE response, concurrently, and how many of them entered.
   *
   * The in-activation guard: a duplicate callback arriving while the first is
   * still running its effects would otherwise re-enter every pending effect
   * beside it. The durable claim closes that window across a restart; this closes
   * it inside one, and it is only reachable while a sequence is genuinely mid
   * flight — which is why the two calls are started before either is awaited.
   */
  async settleTwice(turnId: string, messageId: string, answer: string): Promise<number> {
    this.ensureInit();
    const both = [
      this.settle(turnId, messageId, answer),
      this.settle(turnId, messageId, answer),
    ];
    await Promise.all(both);
    return this.sql<{ runs: number }>`
      SELECT COUNT(*) AS runs FROM probe_effect_runs
      WHERE effect_key = ${terminalEffectKey(PROBE_SEQUENCE[0], messageId)}`[0]?.runs ?? 0;
  }

  /**
   * The recovery sweep, from storage alone — core's `resumeAll`, which is what
   * a cold start, a recovery fiber and a retry wake all reach.
   *
   * `jump` advances this activation's injected clock to the earliest armed
   * attempt. An owed row is not attempted before its retry instant, so without it
   * a recovery that arrives early attempts nothing — which is itself worth
   * asserting, and is why this is a parameter rather than always on.
   */
  async resume(jump: boolean): Promise<void> {
    this.ensureInit();
    this.clockSkewMs = 0;
    if (jump) {
      const due = this.transitions.nextRetryAt();
      this.clockSkewMs = due === null ? 0 : Math.max(0, due - Date.now());
    }
    await this.transitions.resumeAll();
    await this.releaseWakeIfConverged();
  }

  /**
   * The durable wake, arriving with nothing connected.
   *
   * The whole of convergence in the shipped design: no attempt is abandoned, so
   * the only thing that can finish an owed row after an eviction is the alarm
   * the interrupted activation committed. Logged first, so a test can attribute
   * the completion to this and not to its own polling.
   */
  override async alarm(): Promise<void> {
    this.ensureInit();
    void this.sql`INSERT INTO probe_alarm_runs (at) VALUES (${Date.now()})`;
    this.clockSkewMs = 0;
    await this.transitions.resumeAll();
    await this.releaseWakeIfConverged();
  }

  /** The sequences core itself reports as claimed and never settled — the read a
   *  recovery makes before it has hydrated anything. */
  incompleteSequences(): string[] {
    this.ensureInit();
    return this.transitions.incomplete().map((t) => this.transitions.sequenceId(t));
  }

  /**
   * Release the wake slot once nothing is owed.
   *
   * Core arms before a replay rather than after it, so a pass that then finishes
   * everything leaves behind an alarm it asked for while work was still open. A
   * wake armed over a converged ledger is a delivery that finds nothing to do,
   * and a test cannot tell it from one that had work — so convergence is read
   * back off storage and the slot released.
   */
  private async releaseWakeIfConverged(): Promise<void> {
    if (this.transitions.nextRetryAt() !== null) return;
    await this.ctx.storage.deleteAlarm();
  }

  // ── The tool-effect claim, on its own ─────────────────────────────────
  //
  // The same table and the same two functions as the transition gate above,
  // keyed on a tool call. Nothing here is scheduled or replayed: a tool call's
  // claim has no ledger behind it, and refusing is the whole of its recovery.

  private toolKey(call: ProbeToolCall): ToolEffectKey {
    return {
      turnId: call.turnId,
      callId: call.callId,
      digest: argumentDigest({ tool: call.tool, args: call.args }),
    };
  }

  claimTool(call: ProbeToolCall): ProbeToolClaim {
    this.ensureInit();
    const claim = claimToolEffect(this.sql, this.toolKey(call));
    return {
      kind: claim.kind,
      result: claim.kind === 'settled' ? JSON.stringify(claim.result) : null,
    };
  }

  settleTool(call: ProbeToolCall, result: string): void {
    this.ensureInit();
    settleToolEffect(this.sql, this.toolKey(call), result);
  }

  // ── Observation ───────────────────────────────────────────────────────
  //
  // Reads only. This object runs no recovery on a request — that is what makes
  // the alarm-driven case attributable: polling it cannot cause what it measures.

  effectRows(turnId: string, messageId: string): ProbeEffectRow[] {
    this.ensureInit();
    return this.sql<EffectLedgerSqlRow>`
      SELECT effect_key, effect_name, status, input_json
      FROM terminal_effects WHERE sequence_id = ${`${turnId}/${messageId}`}
      ORDER BY seq, effect_key`
      .map((row) => ({
        key: row.effect_key,
        name: row.effect_name,
        status: row.status,
        answer: v.parse(ProbeInputSchema, parseJsonValue(row.input_json)).answer,
      }));
  }

  /** Sequences the ledger itself reports as still owing something — the question
   *  a fresh activation asks before it has hydrated anything. */
  owedSequences(): readonly string[] {
    this.ensureInit();
    return this.transitions.ledger.pendingSequences();
  }

  executions(): ProbeExecution[] {
    this.ensureInit();
    return this.sql<{ effect_key: string; runs: number }>`
      SELECT effect_key, COUNT(*) AS runs FROM probe_effect_runs
      GROUP BY effect_key ORDER BY MIN(rowid)`
      .map((row) => ({ key: row.effect_key, runs: row.runs }));
  }

  outputs(): ProbeOutput[] {
    this.ensureInit();
    return this.sql<{ output_key: string; payload: string }>`
      SELECT output_key, payload FROM probe_effect_output ORDER BY rowid`
      .map((row) => ({ key: row.output_key, payload: row.payload }));
  }

  claims(): ProbeClaim[] {
    this.ensureInit();
    const prefix = `${TERMINAL_TRANSITION_CALL_ID}:`;
    return this.sql<{ turn_id: string; normalized_call_id: string; result_json: string | null }>`
      SELECT turn_id, normalized_call_id, result_json FROM tool_effect_claims
      WHERE normalized_call_id LIKE ${`${prefix}%`}
      ORDER BY turn_id, normalized_call_id`
      .map((row) => ({
        turnId: row.turn_id,
        messageId: row.normalized_call_id.slice(prefix.length),
        settled: row.result_json !== null,
      }));
  }

  async armedWake(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  alarmRuns(): number {
    this.ensureInit();
    return this.sql<{ runs: number }>`SELECT COUNT(*) AS runs FROM probe_alarm_runs`[0]?.runs ?? 0;
  }
}
