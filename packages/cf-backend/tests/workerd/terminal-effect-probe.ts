/**
 * Core's real `TerminalTransitions` over Durable Object SQLite with a real alarm, across `abortAllDurableObjects()`.
 * Defends: a replay after isolate death doubling an effect (`probe_effect_output` must stay at 1 per key).
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import {
  argumentDigest, claimToolEffect, initToolEffectClaimTable, initWorkspaceSchema, openWorkspaceMainActor,
  parseJsonValue, settleToolEffect, WorkspaceActorDirectory,
  type ActorHandle, type RawSqlExec, type SqlExecutor, type SqlValue, type ToolEffectKey,
} from '@kinu.run/core';

import {
  initTerminalEffectTable, terminalEffect, TerminalEffectInterrupt, terminalEffectKey,
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID,
  type OwedEffect, type TerminalEffect, type TerminalEffectFault, type TerminalEffectName,
  type TerminalEffectPhase, type TerminalEffectTable,
} from '@kinu.run/core';

/** Real `TERMINAL_EFFECT_NAMES`, all inline so a cut leaves an exact suffix (detached effects would make it a scheduling assertion). */
export const PROBE_SEQUENCE = [
  'takes', 'event_reply', 'turn_record', 'auto_title', 'auto_gepa',
] as const satisfies readonly TerminalEffectName[];

/** Reports itself owed on its first execution, as an open reply channel does in production. */
export const HELD_EFFECT: TerminalEffectName = 'event_reply';

/** A wake armed in the past re-enters immediately; this floor stops it spinning on a row a millisecond short of due. */
const WAKE_FLOOR_MS = 250;

const ProbeInputSchema = v.object({ answer: v.string() });

export interface ProbeCut {
  readonly name: TerminalEffectName;
  readonly phase: TerminalEffectPhase;
}

export interface ProbeSettleOpts {
  readonly cut?: ProbeCut;
  readonly holdReply?: boolean;
}

/** Deliberately not the whole row: an assertion over the column list would break on every schema addition. */
export interface ProbeEffectRow {
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly answer: string;
}

export interface ProbeExecution {
  readonly key: string;
  readonly runs: number;
}

export interface ProbeOutput {
  readonly key: string;
  readonly payload: string;
}

export interface ProbeClaim {
  readonly turnId: string;
  readonly messageId: string;
  readonly settled: boolean;
}

export interface ProbeToolCall {
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, string>;
}

/** Flat because the Durable Object stub's serializer cannot map the recursive `JsonValue`. */
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
  private readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  private readonly execRaw: RawSqlExec = (ddl: string) => {
    this.ctx.storage.sql.exec(ddl);
  };

  private initialized = false;

  /** Lazy per activation like `UserDO.ensureInit`: `alarm()` can arrive on an activation nothing else has touched. */
  private ensureInit(): void {
    if (this.initialized) return;
    initWorkspaceSchema({
      execRaw: this.execRaw,
      sql: this.sql,
      exec: this.ctx.storage.sql,
      transactionSync: (write) => this.ctx.storage.transactionSync(write),
    });
    initTerminalEffectTable(this.execRaw);
    initToolEffectClaimTable(this.execRaw);
    // Claims and transitions are keyed per actor, so the probe needs its own.
    const identity = this.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`;

    if (identity.length === 0) {
      void this.sql`INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${'probe-workspace'}, ${'probe'}, ${Date.now()})`;
    }

    new WorkspaceActorDirectory(this.sql, { workspaceId: 'probe-workspace', ownerUserId: '' })
      .createMain({ name: 'probe' });
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

  private probeActor(): ActorHandle {
    this.ensureInit();

    return openWorkspaceMainActor(this.sql);
  }

  private fault: TerminalEffectFault | null = null;

  /** Mutable field, not a constructor argument: the lifecycle is one object per activation and its in-flight guard is under test. */
  private clockSkewMs = 0;

  private _transitions: TerminalTransitions | null = null;

  private get transitions(): TerminalTransitions {
    this._transitions ??= new TerminalTransitions({
      sql: this.sql,
      actor: this.probeActor(),
      effects: this.effectTable(),
      now: () => Date.now() + this.clockSkewMs,
      fault: () => this.fault,
      transaction: (body) => this.ctx.storage.transactionSync(body),
      // Arms before replaying: a one-shot alarm must not be consumed with the suffix uncarried.
      // Soonest wins: core arms again after the pass at a later instant, which would push the wake past a due row.
      scheduleRetry: async (atMs) => {
        const at = Math.max(atMs, Date.now() + WAKE_FLOOR_MS);
        const armed = await this.ctx.storage.getAlarm();

        if (armed !== null && armed <= at) return;
        await this.ctx.storage.setAlarm(at);
      },
    });

    return this._transitions;
  }

  /** The output key is the effect's versioned identity, so the write is idempotent and a replay is safe. */
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
   * The interrupt is caught here, one frame outside every effect and the closing path, where the platform's handler sits when an activation dies.
   */
  async settle(
    turnId: string, messageId: string, answer: string, opts?: ProbeSettleOpts,
  ): Promise<string | null> {
    this.ensureInit();

    if (opts?.holdReply === true) {
      void this.sql`INSERT OR IGNORE INTO probe_held_scope (scope) VALUES (${messageId})`;
    }

    const cut = opts?.cut;
    this.fault = cut === undefined
      ? null
      : (phase, name, scope) => {
        if (phase !== cut.phase || name !== cut.name) return;
        throw new TerminalEffectInterrupt(phase, name, scope);
      };

    // Awaited, unlike the Durable Object's fiber: this RPC keeps the object alive for the close.
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

  /** The in-activation guard is only reachable mid flight, so both calls start before either is awaited. */
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

  /** `jump` advances the injected clock: an owed row is not attempted before its retry instant. */
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

  /** Logged first, so a test can attribute completion to the alarm and not its own polling. */
  override async alarm(): Promise<void> {
    this.ensureInit();
    void this.sql`INSERT INTO probe_alarm_runs (at) VALUES (${Date.now()})`;
    this.clockSkewMs = 0;
    await this.transitions.resumeAll();
    await this.releaseWakeIfConverged();
  }

  incompleteSequences(): string[] {
    this.ensureInit();

    return this.transitions.incomplete().map((t) => this.transitions.sequenceId(t));
  }

  /** Core arms before a replay, so a pass that finishes everything leaves an alarm a test cannot tell from one with work. */
  private async releaseWakeIfConverged(): Promise<void> {
    if (this.transitions.nextRetryAt() !== null) return;
    await this.ctx.storage.deleteAlarm();
  }

  // The tool-effect claim on its own: no ledger behind it, and refusing is the whole of its recovery.

  private toolKey(call: ProbeToolCall): ToolEffectKey {
    return {
      turnId: call.turnId,
      callId: call.callId,
      digest: argumentDigest({ tool: call.tool, args: call.args }),
    };
  }
  claimTool(call: ProbeToolCall): ProbeToolClaim {
    this.ensureInit();
    const claim = claimToolEffect(this.sql, this.probeActor(), this.toolKey(call));

    return {
      kind: claim.kind,
      result: claim.kind === 'settled' ? JSON.stringify(claim.result) : null,
    };
  }
  settleTool(call: ProbeToolCall, result: string): void {
    this.ensureInit();
    settleToolEffect(this.sql, this.probeActor(), this.toolKey(call), result);
  }

  // Reads only: no recovery runs on a request, so polling cannot cause what the alarm case measures.

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
