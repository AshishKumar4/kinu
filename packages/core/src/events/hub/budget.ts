/**
 * ReactorBudget — distinct from per-turn step budgets.
 *
 * Five axes (any may exhaust). Exhaustion does NOT throw — it forces the
 * Hub to issue a `(head_op: keep, event_op: defer)` decision in place of
 * spawning a reactor head. The event remains visible and the next phase-idle
 * transition retries.
 *
 *   per_turn_invocations         (hard cap, default 3)
 *   per_trace_invocations        (hard cap across replans, default 5)
 *   per_hour_agent_invocations   (soft cap → defer-all, default 60)
 *   per_hour_user_tokens         (hard cap, from per-user plan)
 *   per_source_invocations       (per (ingress, source_id), default 10/turn)
 *
 * The budget reads from `reactor_budget_log` rows in `agent_log`'s sibling
 * table. Counter queries are cheap with the indexes from `schema.ts`.
 */

import {
  DEFAULT_REACTOR_BUDGET, type ReactorBudgetConfig,
  type TurnId, type TraceId,
} from './types.js';
import { ulid } from './ulid.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface BudgetCheckOutcome {
  ok: boolean;
  /** Which axis exhausted, if any. */
  exhausted_axis: keyof ReactorBudgetConfig | null;
  /** The limit that was hit. */
  limit: number | null;
  /** Current usage on the failing axis. */
  current: number | null;
}

export interface BudgetRecordOutcome {
  invocation_id: string;
}

export interface BudgetUserTokenProvider {
  /** Tokens used by this user in the last hour, summed across all their
   *  agents. The hub asks UserDO via this callback at consult time. */
  getUserHourlyTokens(): Promise<number>;
}

export class ReactorBudget {
  constructor(
    private readonly sql: SqlExec,
    private readonly config: ReactorBudgetConfig = DEFAULT_REACTOR_BUDGET,
    private readonly userTokens?: BudgetUserTokenProvider,
  ) {}

  /** Check whether a reactor invocation is allowed right now. Does not
   *  mutate state — call `record()` after the invocation actually runs. */
  async check(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    source_key: string;        // e.g. `webhook:gh-pr-events` or `peer:agentX`
    now: number;
  }): Promise<BudgetCheckOutcome> {
    const { turn_id, trace_id, source_key, now } = opts;

    const perTurn = this.countRows(
      `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE turn_id = ?`,
      turn_id,
    );
    if (perTurn >= this.config.per_turn_invocations) {
      return exhausted('per_turn_invocations', this.config.per_turn_invocations, perTurn);
    }

    const perTrace = this.countRows(
      `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE trace_id = ?`,
      trace_id,
    );
    if (perTrace >= this.config.per_trace_invocations) {
      return exhausted('per_trace_invocations', this.config.per_trace_invocations, perTrace);
    }

    const perSourceInTurn = this.countRows(
      `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE turn_id = ? AND source_key = ?`,
      turn_id, source_key,
    );
    if (perSourceInTurn >= this.config.per_source_invocations) {
      return exhausted('per_source_invocations', this.config.per_source_invocations, perSourceInTurn);
    }

    const hourStart = now - ONE_HOUR_MS;
    const perHourAgent = this.countRows(
      `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE invoked_at >= ?`,
      hourStart,
    );
    if (perHourAgent >= this.config.per_hour_agent_invocations) {
      return exhausted('per_hour_agent_invocations', this.config.per_hour_agent_invocations, perHourAgent);
    }

    if (this.userTokens) {
      const userHourlyTokens = await this.userTokens.getUserHourlyTokens();
      if (userHourlyTokens >= this.config.per_hour_user_tokens) {
        return exhausted('per_hour_user_tokens', this.config.per_hour_user_tokens, userHourlyTokens);
      }
    }

    return { ok: true, exhausted_axis: null, limit: null, current: null };
  }

  /** Record a reactor invocation. Called regardless of decision outcome
   *  so that retries don't bypass the budget. */
  record(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    source_key: string;
    outcome: 'decided' | 'fallback_defer' | 'budget_exhausted';
    now: number;
  }): BudgetRecordOutcome {
    const id = ulid();
    this.sql.exec(
      `INSERT INTO reactor_budget_log (id, turn_id, trace_id, source_key, invoked_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id, opts.turn_id, opts.trace_id, opts.source_key, opts.now, opts.outcome,
    );
    return { invocation_id: id };
  }

  /** Per-turn snapshot of remaining budget (the parent field is
   *  `budget_remaining`, so the keys are the remaining counts per scope). */
  snapshot(turn_id: TurnId, trace_id: TraceId, now: number): { per_turn: number; per_trace: number; per_hour: number } {
    return {
      per_turn: Math.max(0,
        this.config.per_turn_invocations - this.countRows(
          `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE turn_id = ?`, turn_id,
        )),
      per_trace: Math.max(0,
        this.config.per_trace_invocations - this.countRows(
          `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE trace_id = ?`, trace_id,
        )),
      per_hour: Math.max(0,
        this.config.per_hour_agent_invocations - this.countRows(
          `SELECT COUNT(*) AS n FROM reactor_budget_log WHERE invoked_at >= ?`,
          now - ONE_HOUR_MS,
        )),
    };
  }

  private countRows(query: string, ...bindings: unknown[]): number {
    const rows = this.sql.exec(query, ...bindings).toArray() as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }
}

function exhausted(
  axis: keyof ReactorBudgetConfig,
  limit: number,
  current: number,
): BudgetCheckOutcome {
  return { ok: false, exhausted_axis: axis, limit, current };
}

