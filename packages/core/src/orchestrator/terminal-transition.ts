/**
 * The once-only lifecycle of one settled response: claim, run what it owes ({@link TerminalEffectLedger}),
 * close when nothing is owed, hand an interrupted one to the next activation. Backend-neutral; a backend
 * supplies only effect implementations and the wake.
 */
import { claimToolEffect, settleToolEffect, type ToolEffectKey } from '../tools/effect-claim';
import { argumentDigest } from '../safety/argument-digest';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import {
  TERMINAL_EFFECT_RETRY_BASE_MS,
  TerminalEffectLedger,
  type TerminalEffectFault,
  type TerminalEffectTable,
  type OwedEffect,
  type TerminalSequenceRun,
} from './terminal-effects';

/** Suffixed with the response's message id: a continuation keeps the turn's user-message id. */
export const TERMINAL_TRANSITION_CALL_ID = 'terminal:response';

const TERMINAL_TRANSITION_SETTLED = '"settled"';

/** Bounded: a wake that refuses twice refuses for a reason a third call cannot change. */
const TERMINAL_RECOVERY_ARM_ATTEMPTS = 2;

export interface TerminalTransition {
  readonly turnId: string;
  readonly messageId: string;
}

/** `resumed`: begun and never recorded; the ledger decides per effect. `unclaimed`: no durable identity, runs unledgered. */
export type TerminalDisposition = 'first' | 'resumed' | 'done' | 'unclaimed';

export interface TerminalTransitionDeps {
  readonly sql: SqlExecutor;
  /** An id alone is not authority over a sibling's suffix. */
  readonly actor: ActorHandle;
  /** A row naming an absent effect is blocked, not skipped. */
  readonly effects: TerminalEffectTable;
  readonly now: () => number;
  /** Read per call, so a test can arm a cut after construction. */
  readonly fault?: () => TerminalEffectFault | null;
  /** Claim and roster go through this. A process that can die between statements must supply a real transaction. */
  readonly transaction?: <T>(body: () => T) => T;
  /** Gates the turn-wide tool-claim release: an auto-continuation may run tools before it has a terminal claim. */
  readonly turnIsLive?: (turnId: string) => boolean;
  /** A past instant means due now. */
  readonly scheduleRetry: (atMs: number) => Promise<void>;
}

/** Owns the ordering: claim before the first effect, disposition before release, close only on an empty owed set, prune after close. */
export class TerminalTransitions {
  /** Callers never reach past this for the claim, the close or the sweep. */
  readonly ledger: TerminalEffectLedger;

  /** Guards against a duplicate callback re-entering pending effects within one process. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TerminalTransitionDeps) {
    const ledgerDeps = {
      sql: deps.sql,
      actor: deps.actor,
      effects: deps.effects,
      now: deps.now,
      scheduleRetry: deps.scheduleRetry,
    };

    const withFault = deps.fault === undefined ? ledgerDeps : { ...ledgerDeps, fault: deps.fault };

    const withTransaction = deps.transaction === undefined
      ? withFault
      : { ...withFault, transaction: deps.transaction };

    this.ledger = new TerminalEffectLedger(withTransaction);
  }

  sequenceId(transition: TerminalTransition): string {
    return `${transition.turnId}/${transition.messageId}`;
  }

  /** The digest binds the row to the turn. */
  private key(transition: TerminalTransition): ToolEffectKey {
    return {
      turnId: transition.turnId,
      callId: `${TERMINAL_TRANSITION_CALL_ID}:${transition.messageId}`,
      digest: argumentDigest({
        tool: TERMINAL_TRANSITION_CALL_ID,
        args: { turn: transition.turnId, message: transition.messageId },
      }),
    };
  }

  begin(transition: TerminalTransition | null): TerminalDisposition {
    if (transition === null) return 'unclaimed';
    const claim = claimToolEffect(this.deps.sql, this.deps.actor, this.key(transition));

    switch (claim.kind) {
      case 'claimed': return 'first';
      case 'indeterminate': return 'resumed';
      case 'settled': return 'done';
    }
  }

  /** Record the frozen roster and its claim together, before any effect runs.
     * A local adapter includes this synchronous write in its answer transaction. */
  record(transition: TerminalTransition | null, owed: readonly OwedEffect[]): TerminalDisposition {
    const commit = this.deps.transaction ?? (<T>(body: () => T): T => body());

    return commit(() => {
      const disposition = this.begin(transition);

      if (transition !== null && disposition === 'first') this.ledger.claim(this.sequenceId(transition), owed);

      return disposition;
    });
  }

  /** Released by {@link leave}, never in a `finally`: an interruption must leave the durable rows as the record. */
  enter(transition: TerminalTransition): boolean {
    const id = this.sequenceId(transition);

    if (this.inFlight.has(id)) return false;
    this.inFlight.add(id);

    return true;
  }

  leave(transition: TerminalTransition): void {
    this.inFlight.delete(this.sequenceId(transition));
  }

  /** Zero means every sequence a sweep entered reached a disposition. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Every ordering here is a correctness constraint. A resumed response does not re-declare: its roster is
   * frozen at what the first attempt claimed. `hold` keeps the runtime alive for the close (per backend).
   */
  async settle(input: {
    readonly transition: TerminalTransition | null;
    /** Called once, before any durable write; used only on a first attempt. */
    readonly declare: () => readonly OwedEffect[];
    /** The backend decides what stays alive for the thunk. Never called for an unledgered response. */
    readonly hold: (transition: TerminalTransition, close: () => Promise<void>) => void;
  }): Promise<void> {
    const { transition, declare, hold } = input;
    // Built first: a throw here must not leave an open claim with no rows, which recovery reads as finished.
    const owed = declare();

    // No durable identity: run unledgered rather than invent a shared identity.
    if (transition === null) {
      await this.runUnledgered(owed);

      return;
    }

    if (!this.enter(transition)) {
      diagnostics.event('turn.terminal_transition_in_flight', {
        turn: transition.turnId, message: transition.messageId,
      });

      return;
    }

    const disposition = this.record(transition, owed);

    if (disposition === 'done') {
      this.leave(transition);
      diagnostics.event('turn.terminal_transition_replayed', {
        turn: transition.turnId, message: transition.messageId,
      });

      return;
    }

    let run: TerminalSequenceRun;

    try {
      run = await this.ledger.drive(this.sequenceId(transition));
    } catch (err) {
      // Released, then re-armed: a held sequence is skipped by later sweeps, and owed rows need a wake.
      this.leave(transition);
      await this.armRecovery(transition, { cause: err });
      throw err;
    }

    hold(transition, async () => {
      await run.reported;
      this.end(transition);
    });
  }

  /** Nothing is recoverable here; detached bodies still start in order and this caller owns them until settled. */
  private async runUnledgered(owed: readonly OwedEffect[]): Promise<void> {
    const detached: Promise<void>[] = [];

    for (const effect of owed) {
      const body = this.deps.effects[effect.name];

      if (body === undefined) continue;

      const running = (async (): Promise<void> => {
        try {
          await body.run(effect.input, effect.scope);
        } catch (cause) {
          diagnostics.failure('turn.terminal_effect_failed', toKinuError({
            doing: `running the ${effect.name} effect a settled turn owed`,
            cause,
            otherwise: 'unavailable',
          }), { sequence: '(unledgered)', effect: effect.name });
        }
      })();

      if (effect.lane === 'inline') await running;
      else detached.push(running);
    }

    await Promise.all(detached);
  }

  nextRetryAt(): number | null {
    return this.ledger.nextRetryAt(this.inFlight);
  }

  /** Records completion only once every effect is terminal; must never move into a `finally`. */
  end(transition: TerminalTransition | null): void {
    if (transition === null) return;
    this.leave(transition);
    const sequenceId = this.sequenceId(transition);
    const owed = this.ledger.owed(sequenceId);

    if (owed.length > 0) {
      diagnostics.event('turn.terminal_effects_owed', {
        sequence: sequenceId, owed: owed.map((row) => row.key).join(','),
      });

      return;
    }

    // Disposition first, release second.
    settleToolEffect(this.deps.sql, this.deps.actor, this.key(transition), TERMINAL_TRANSITION_SETTLED);

    // Tool claims are released only when no response of this turn can still be settling; open terminal rows
    // are the witness.
    const openResponses = this.deps.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM tool_effect_claims
      WHERE actor_id = ${this.deps.actor.actorId} AND turn_id = ${transition.turnId}
        AND normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}
        AND result_json IS NULL`[0]?.n ?? 0;

    // A live turn may be mid-continuation with no terminal claim yet, so zero open claims is not enough.
    if (openResponses === 0 && !(this.deps.turnIsLive?.(transition.turnId) ?? false)) {
      void this.deps.sql`DELETE FROM tool_effect_claims
        WHERE actor_id = ${this.deps.actor.actorId} AND turn_id = ${transition.turnId}
          AND normalized_call_id NOT LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}`;
    }

    this.ledger.prune(sequenceId);
  }

  /** Claimed and never settled; the message id comes back off the call-id suffix. */
  incomplete(): TerminalTransition[] {
    const prefix = `${TERMINAL_TRANSITION_CALL_ID}:`;

    return this.deps.sql<{ turn_id: string; normalized_call_id: string }>`
      SELECT DISTINCT turn_id, normalized_call_id FROM tool_effect_claims
      WHERE actor_id = ${this.deps.actor.actorId}
        AND normalized_call_id LIKE ${`${prefix}%`} AND result_json IS NULL
    `.map((row) => ({
      turnId: row.turn_id,
      messageId: row.normalized_call_id.slice(prefix.length),
    }));
  }

  /** One indexed LIMIT-1 read that must not materialize the roster. */
  hasIncomplete(): boolean {
    const prefix = `${TERMINAL_TRANSITION_CALL_ID}:`;

    return this.deps.sql<{ present: number }>`
      SELECT 1 AS present FROM tool_effect_claims
      WHERE actor_id = ${this.deps.actor.actorId}
        AND normalized_call_id LIKE ${`${prefix}%`} AND result_json IS NULL LIMIT 1
    `.length > 0;
  }

  /** Every input comes off its row; {@link end} closes only if nothing is still owed. */
  async resume(transition: TerminalTransition): Promise<void> {
    await this.ledger.replayOwed(this.sequenceId(transition));
    this.end(transition);
  }

  /** Reads the roster from storage. Never throws: one unrecoverable response must not stop the next. */
  async resumeAll(): Promise<void> {
    for (const transition of this.incomplete()) {
      // Acquired, not merely checked: startup reconcile and retry wakes interleave, and must not replay one row concurrently.
      if (!this.enter(transition)) continue;

      try {
        await this.resume(transition);
      } catch (err) {
        this.leave(transition);
        diagnostics.failure('turn.terminal_resume_failed', toKinuError({
          doing: 'finishing what an interrupted terminal transition still owed',
          cause: err,
          otherwise: 'unavailable',
        }), { turnId: transition.turnId, messageId: transition.messageId });
        // Re-armed: a close that threw may leave no owed row for the wake to derive from.
        await this.armRecovery(transition, { cause: err });
      }
    }
  }

  /** Arms the wake without replaying, for a caller that must not await (a fiber-recovery hook runs inside the init gate). {@link resumeAll}'s claim join makes the re-entry safe. */
  async armOwedRecovery(): Promise<void> {
    const owed = this.incomplete();

    if (owed.length === 0) return;
    // The ledger's own instant when it has one; the base delay otherwise.
    const at = this.nextRetryAt() ?? this.deps.now() + TERMINAL_EFFECT_RETRY_BASE_MS;
    const armed = await this.armWake(at);

    if (armed.armed) {
      diagnostics.event('turn.terminal_recovery_armed', { owed: owed.length, at });

      return;
    }

    diagnostics.failure('turn.terminal_recovery_unarmed', toKinuError({
      doing: 'arming the durable wake for the terminal sequences an interruption left owed',
      cause: armed.refusal,
      otherwise: 'io',
    }), { owed: owed.length });
  }

  /** Released and re-armed: the rejection may be the ledger's final wake failing. */
  async closeFailed(transition: TerminalTransition, failure: { readonly cause: unknown }): Promise<void> {
    this.leave(transition);
    diagnostics.failure('turn.terminal_transition_close_failed', toKinuError({
      doing: "recording that a settled turn's effects had all reported", cause: failure.cause, otherwise: 'io',
    }), { turnId: transition.turnId, messageId: transition.messageId });
    await this.armRecovery(transition, failure);
  }

  /** Bounded retries of the backend's sanctioned wake; when all refuse, rows stay owed and visible with a named failure. Never reach around the wake. */
  async armRecovery(
    transition: TerminalTransition,
    failure: { readonly cause: unknown },
  ): Promise<void> {
    const armed = await this.armWake(this.deps.now() + TERMINAL_EFFECT_RETRY_BASE_MS);

    if (armed.armed) return;
    diagnostics.failure('turn.terminal_recovery_unarmed', toKinuError({
      doing: 'arming a durable wake for a terminal sequence whose ledger could not start',
      cause: armed.refusal,
      otherwise: 'io',
    }), {
      turn: transition.turnId,
      message: transition.messageId,
      ledgerCause: renderThrownChain(failure),
    });
  }

  /** Shared attempt; callers report the refusal differently. */
  private async armWake(atMs: number): Promise<{ armed: true } | { armed: false; refusal: unknown }> {
    let refusal: unknown;

    for (let attempt = 0; attempt < TERMINAL_RECOVERY_ARM_ATTEMPTS; attempt++) {
      try {
        await this.deps.scheduleRetry(atMs);

        return { armed: true };
      } catch (err) {
        refusal = err;
      }
    }

    return { armed: false, refusal };
  }

  /** Idempotent: re-arms from what is left. */
  async replayOwedAndRearm(): Promise<void> {
    await this.resumeAll();
    const next = this.nextRetryAt();

    if (next !== null) await this.deps.scheduleRetry(next);
  }
}
