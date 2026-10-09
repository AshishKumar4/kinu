// Sleep-time compute on every backend (m1544): the `sleep_time` effect, its idle and closed-session wakes (m1435).

import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { effectAlreadyDone, recordEffectDone } from '../identity/effect-tombstones';
import type { FactsStore } from '../memory/facts';
import {
  accountProposals, applySleepTimeUpdate, runSleepTimeCompute, SleepTimeUpdateSchema, SLEEP_TIME_CADENCE, sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeUpdate, type SleepTimeWindow,
} from '../memory/sleep-time-compute';
import { AccountProposalSchema, type AccountMemory } from '../memory/account';
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
  // Account proposals a commit owes the user object, kept until it takes each: `delivery` is the proposal's identity
  // there, so a delivery repeated after a crash or a refusal files nothing new.
  execRaw(`CREATE TABLE IF NOT EXISTS account_proposal_outbox (
      delivery      TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL
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
  /**
   * The account's memory, where one is wired: the pass reads its facts and proposes to it, never writes it. Cloudflare
   * only: the CLI has no account's user object, so it leaves this unset (`scripts/capability-parity.lock.json`).
   */
  readonly account?: () => AccountMemory | undefined;
}

function idleReason(window: SleepTimeWindow | null): string {
  if (window === null) return 'the lane is off';

  return window.inputPending ? 'input pending' : 'no unprocessed turn';
}

export class SleepTimeLane {
  constructor(private readonly deps: SleepTimeLaneDeps) {}

  /**
   * Whether the outbox may hold a proposal: unknown until this activation reads it once, then true only while a commit
   * here filed one or a delivery left one. Every turn's pass asked first, and two reads a turn cost the workerd turn
   * budget two statements (2026-10-09, batch 64).
   */
  private mayOwe = true;

  /** Proposals this activation filed, so a delivery that read the outbox before a filing does not clear it. */
  private filed = 0;

  effect(): TerminalEffect {
    return terminalEffect({ input: v.object({}), run: () => this.runTerminal() });
  }

  runTerminal(): Promise<TerminalEffectOutcome> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.deps.config.getSleepTimeComputeEnabled()) return { status: 'completed', detail: 'the lane is off' } as const;
      // What an earlier pass owes the account goes first, whether or not this one is due.
      const account = this.deps.account?.();

      if (account !== undefined) yield* this.deliver(account);
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
      const closedAt = this.instant(CLOSED_AT);
      // Every timer tick reads this lane; only a tick at or past the lane's own wake was armed by it.
      const woke = now >= (sleepTimeWakeAt({ settledAt, closedAt }) ?? Number.POSITIVE_INFINITY);
      const window = this.deps.config.getSleepTimeComputeEnabled() ? yield* this.window() : null;

      if (window === null || window.completedTurns < 2 || window.turns.length === 0 || window.inputPending) {
        this.deps.config.delete(SETTLED_AT);

        if (woke) this.nothingDue(idleReason(window));

        return false;
      }

      const due = sleepTimeDue({
        completedTurns: window.completedTurns,
        lastRunTurn: window.lastRunTurn,
        idleMs: now - settledAt,
        ...(closedAt !== null && { lastConnectionClosedMs: now - closedAt }),
      });

      if (!due) {
        if (woke) this.nothingDue('the cadence is not due');

        return false;
      }

      yield* this.compute(window);

      return true;
    });
  }

  /** The lane's own wake found nothing to compress: a wake no model call or fact write accounts for. */
  private nothingDue(reason: string): void {
    diagnostics.event('memory.sleep_time_wake_idle', { workspace: this.deps.workspace, reason });
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
      const account = this.deps.account?.();

      // A user object that does not answer costs this run its account section, never the workspace's facts.
      const accountFacts = stored !== undefined || account === undefined
        ? undefined
        : yield* attempt({ doing: "reading the account's facts the pass proposes against", otherwise: 'unavailable' }, async () => await account.facts()).pipe(
          Effect.catch((failure) => Effect.sync(() => {
            diagnostics.failure('memory.account_read_failed', failure, { workspace: this.deps.workspace });

            return undefined;
          })),
        );

      const update = stored ?? (yield* attempt({ doing: 'compressing the recent turns into agent facts', otherwise: 'unavailable' }, () => runSleepTimeCompute(this.deps.llm(), {
        turns: window.turns,
        currentFacts: this.deps.facts.all()
          .sort((a, b) => b.lastObservedAt - a.lastObservedAt)
          .map((fact) => ({ key: fact.key, value: fact.value, confidence: fact.confidence })),
        ...(accountFacts !== undefined && { accountFacts: accountFacts.map((fact) => ({ key: fact.key, value: fact.value })) }),
      })));

      if (stored === undefined) {
        void this.deps.sql`INSERT INTO sleep_time_updates (effect_key, update_json)
          VALUES (${key}, ${JSON.stringify(update)})
          ON CONFLICT(effect_key) DO NOTHING`;
      }

      const proposals = account === undefined ? [] : accountProposals(update, window.turns);

      // One commit, so a replay never repeats a prefix: the workspace's facts, and the account proposals it owes.
      const summary = this.deps.transactionSync(() => {
        const applied = applySleepTimeUpdate(this.deps.facts, update);

        for (const [index, proposal] of proposals.entries()) {
          void this.deps.sql`INSERT INTO account_proposal_outbox (delivery, proposal_json)
            VALUES (${`${key}#${String(index)}`}, ${JSON.stringify(proposal)}) ON CONFLICT(delivery) DO NOTHING`;
          this.filed += 1;
          this.mayOwe = true;
        }

        this.finish(key);

        return applied;
      });

      diagnostics.event('memory.facts_compressed', {
        workspace: this.deps.workspace, upserted: summary.upserted, decayed: summary.decayed, skipped: summary.skipped,
      });

      if (account !== undefined) yield* this.deliver(account);
    }).pipe(Effect.tapError((failure) => Effect.sync(() => {
      if (isDefinitiveTerminalFailure(failure.code)) this.deps.transactionSync(() => { this.finish(key); });
      diagnostics.failure('memory.fact_compression_failed', failure);
    })));
  }

  /**
   * Hands the user object every proposal the outbox holds, each removed once it is taken. One it refuses or never
   * answers stays, and every later pass delivers it again; the delivery id makes that file nothing new.
   */
  private deliver(account: AccountMemory): Effect.Effect<void> {
    if (!this.mayOwe) return Effect.void;
    const filed = this.filed;
    const owed = this.deps.sql<{ delivery: string; proposal_json: string }>`SELECT delivery, proposal_json FROM account_proposal_outbox ORDER BY delivery`;
    let left = 0;

    return Effect.forEach(owed, (row) => attempt(
      { doing: 'proposing an account fact for the owner to approve', otherwise: 'unavailable' },
      async () => await account.propose(v.parse(AccountProposalSchema, JSON.parse(row.proposal_json)), row.delivery),
    ).pipe(Effect.match({
      onSuccess: () => { void this.deps.sql`DELETE FROM account_proposal_outbox WHERE delivery = ${row.delivery}`; },
      onFailure: (failure) => {
        left += 1;
        diagnostics.failure('memory.account_proposal_failed', failure, { workspace: this.deps.workspace, delivery: row.delivery });
      },
    })), { discard: true }).pipe(Effect.tap(() => Effect.sync(() => {
      this.mayOwe = left > 0 || this.filed !== filed;

      if (owed.length > 0) diagnostics.event('memory.account_proposed', { workspace: this.deps.workspace, owed: owed.length });
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
