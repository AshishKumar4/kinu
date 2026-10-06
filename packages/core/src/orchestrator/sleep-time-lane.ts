// Sleep-time compute on every backend (m1544): the `sleep_time` effect, its idle and closed-session wakes (m1435).

import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { effectAlreadyDone, recordEffectDone } from '../identity/effect-tombstones';
import type { FactsStore } from '../memory/facts';
import {
  applySleepTimeUpdate, runSleepTimeCompute, SleepTimeUpdateSchema, SLEEP_TIME_CADENCE, sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeUpdate, type SleepTimeWindow,
} from '../memory/sleep-time-compute';
import { attempt, diagnostics, settle, type KinuError } from '../obs/index';
import type { SessionTranscript } from '../session/transcript';
import type { LLM, RawSqlExec, SqlExecutor } from '../types/primitives';
import { isDefinitiveTerminalFailure, terminalEffect, type TerminalEffect, type TerminalEffectOutcome } from './terminal-effects';

const PROCESSED = 'sleep_time';

const SETTLED_AT = 'sleep_time_settled_at';

const CLOSED_AT = 'sleep_time_closed_at';

/** One answer past the cadence, plus steers: decides as the whole transcript would. */
const READ_ROWS = (SLEEP_TIME_CADENCE.everyTurns + 1) * 8;

export function initSleepTimeUpdatesTable(execRaw: RawSqlExec): void {
  // The paid answer, so a replay applies it instead of buying another.
  execRaw(`CREATE TABLE IF NOT EXISTS sleep_time_updates (
      effect_key  TEXT PRIMARY KEY,
      update_json TEXT NOT NULL
    )`);
}

export interface SleepTimeLaneDeps {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly config: AgentConfigStore;
  readonly facts: FactsStore;
  readonly transcript: () => Pick<SessionTranscript, 'newestFirst'>;
  readonly llm: () => LLM;
  readonly transactionSync: <T>(write: () => T) => T;
  /** Wakes the actor at `nextWakeAt`. */
  readonly armWake: () => void;
  readonly workspace: string;
}

export class SleepTimeLane {
  constructor(private readonly deps: SleepTimeLaneDeps) {}

  effect(): TerminalEffect {
    return terminalEffect({ input: v.object({}), run: () => this.runTerminal() });
  }

  runTerminal(): Promise<TerminalEffectOutcome> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.deps.config.getSleepTimeComputeEnabled()) return { status: 'completed', detail: 'the lane is off' } as const;
      const window = yield* this.window();

      if (!sleepTimeDue(window)) {
        this.arm(window);
        diagnostics.event('memory.facts_deferred', {
          workspace: this.deps.workspace, completedTurns: window.completedTurns, unprocessed: window.turns.length,
        });

        return { status: 'completed', detail: 'the cadence is not due' } as const;
      }

      yield* this.compute(window);

      return { status: 'completed' } as const;
    }));
  }

  nextWakeAt(): number | null {
    return sleepTimeWakeAt({ settledAt: this.instant(SETTLED_AT), closedAt: this.instant(CLOSED_AT) });
  }

  runIfDue(now: number): Promise<boolean> {
    return settle(this.due(now));
  }

  /** A failure is logged and releases the wake. */
  wake(now: number): Promise<void> {
    return settle(Effect.catch(Effect.asVoid(this.due(now)), (failure) => Effect.sync(() => {
      this.releaseWake();
      diagnostics.failure('memory.sleep_time_wake_failed', failure);
    })));
  }

  releaseWake(): void {
    this.deps.config.delete(SETTLED_AT);
  }

  lastClientLeft(): void {
    this.deps.config.set(CLOSED_AT, String(Date.now()));
    this.deps.armWake();
  }

  clientArrived(): void {
    this.deps.config.delete(CLOSED_AT);
  }

  /** Bounded by the newest consumed answer, so two triggers never share turns. */
  private window(): Effect.Effect<SleepTimeWindow, KinuError> {
    return Effect.map(
      attempt({ doing: 'reading the turns sleep-time compute would compress', otherwise: 'io' }, () => this.deps.transcript().newestFirst(READ_ROWS)),
      (rows) => sleepTimeWindow(rows, (answerId) => effectAlreadyDone(this.deps.sql, this.deps.actor, PROCESSED, answerId)),
    );
  }

  private due(now: number): Effect.Effect<boolean, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const settledAt = this.instant(SETTLED_AT);

      if (settledAt === null) return false;
      const window = this.deps.config.getSleepTimeComputeEnabled() ? yield* this.window() : null;

      if (window === null || window.completedTurns < 2 || window.turns.length === 0 || window.inputPending) {
        this.deps.config.delete(SETTLED_AT);

        return false;
      }

      const closedAt = this.instant(CLOSED_AT);

      const due = sleepTimeDue({
        completedTurns: window.completedTurns,
        lastRunTurn: window.lastRunTurn,
        idleMs: now - settledAt,
        ...(closedAt !== null && { lastConnectionClosedMs: now - closedAt }),
      });

      if (!due) return false;
      yield* this.compute(window);

      return true;
    });
  }

  private arm(window: SleepTimeWindow): void {
    if (window.completedTurns < 2 || window.turns.length === 0) {
      this.deps.config.delete(SETTLED_AT);

      return;
    }

    this.deps.config.set(SETTLED_AT, String(Date.now()));
    this.deps.armWake();
  }

  private instant(key: string): number | null {
    const raw = this.deps.config.get(key);
    const at = raw === null ? Number.NaN : Number(raw);

    return Number.isFinite(at) ? at : null;
  }

  private compute(window: SleepTimeWindow): Effect.Effect<void, KinuError> {
    const key = window.newestId;

    if (key === null) return Effect.void;

    return Effect.gen({ self: this }, function* () {
      const stored = this.recordedUpdate(key);

      const update = stored ?? (yield* attempt({ doing: 'compressing the recent turns into agent facts', otherwise: 'unavailable' }, () => runSleepTimeCompute(this.deps.llm(), {
        turns: window.turns,
        currentFacts: this.deps.facts.all()
          .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
          .map((fact) => ({ key: fact.key, value: fact.value, confidence: fact.confidence })),
      })));

      if (stored === undefined) {
        void this.deps.sql`INSERT INTO sleep_time_updates (effect_key, update_json)
          VALUES (${key}, ${JSON.stringify(update)})
          ON CONFLICT(effect_key) DO NOTHING`;
      }

      // One commit, so a replay never repeats a prefix.
      const summary = this.deps.transactionSync(() => {
        const applied = applySleepTimeUpdate(this.deps.facts, update);
        this.finish(key);

        return applied;
      });

      diagnostics.event('memory.facts_compressed', {
        workspace: this.deps.workspace, upserted: summary.upserted, decayed: summary.decayed, skipped: summary.skipped,
      });
    }).pipe(Effect.tapError((failure) => Effect.sync(() => {
      if (isDefinitiveTerminalFailure(failure.code)) this.deps.transactionSync(() => { this.finish(key); });
      diagnostics.failure('memory.fact_compression_failed', failure);
    })));
  }

  private finish(key: string): void {
    recordEffectDone(this.deps.sql, this.deps.actor, { scope: PROCESSED, key });
    void this.deps.sql`DELETE FROM sleep_time_updates WHERE effect_key = ${key}`;
    this.deps.config.delete(SETTLED_AT, CLOSED_AT);
  }

  private recordedUpdate(key: string): SleepTimeUpdate | undefined {
    const row = this.deps.sql<{ update_json: string }>`SELECT update_json FROM sleep_time_updates WHERE effect_key = ${key}`[0];

    return row === undefined ? undefined : v.parse(SleepTimeUpdateSchema, JSON.parse(row.update_json));
  }
}
