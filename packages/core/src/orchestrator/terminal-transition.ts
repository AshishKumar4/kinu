/**
 * The once-only lifecycle of ONE settled response: claim it, run what it owes,
 * close it when nothing is owed any more, and hand an interrupted one to the
 * next activation.
 *
 * A turn's answer causes a sequence of side effects, and the effects themselves
 * are the {@link TerminalEffectLedger}'s subject. What lives here is the
 * boundary AROUND them: the durable claim that says this response's sequence was
 * started, the in-activation guard that stops a duplicate callback re-entering
 * it, and the close that may only happen once the ledger holds nothing owed.
 *
 * Backend-neutral on purpose. The Durable Object and the CLI answer the same
 * question — "what did this response still owe when the process went away?" —
 * and they used to answer it differently: the DO claimed and swept, the CLI
 * released its claims as soon as the transcript was persisted and had no
 * recovery at all. One state machine over one table is what makes an interrupted
 * laptop turn and an evicted isolate the same problem with the same answer.
 *
 * What a backend still supplies is only the two things it genuinely owns: the
 * effect IMPLEMENTATIONS, and the WAKE that brings a process back for an owed
 * row (a DO alarm, or the CLI's startup driver).
 */
import { claimToolEffect, settleToolEffect, type ToolEffectKey } from '../tools/effect-claim';
import { argumentDigest } from '../safety/argument-digest';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import {
  TERMINAL_EFFECT_RETRY_BASE_MS,
  TerminalEffectLedger,
  type PendingRow,
  type TerminalEffectFault,
  type TerminalEffectTable,
  type OwedEffect,
  type TerminalSequenceRun,
} from './terminal-effects';

/**
 * The effect-claim call id every terminal transition is filed under.
 *
 * A constant, suffixed with the response's own message id: a turn fires this
 * hook once per response and a continuation keeps the turn's user-message id, so
 * a key on the turn alone let the first continuation close the claim and the
 * final response — carrying the actual answer — read `done` and skip everything
 * it owed.
 */
export const TERMINAL_TRANSITION_CALL_ID = 'terminal:response';

/** The recorded disposition. A terminal transition has no value to hand back, so
 *  what is written is the fact that it finished. */
const TERMINAL_TRANSITION_SETTLED = '"settled"';

/** How many times the recovery wake is attempted when the ledger could not arm
 *  its own. More than one because a storage write fails transiently; bounded
 *  because a wake that refuses twice refuses for a reason a third call cannot
 *  change. */
const TERMINAL_RECOVERY_ARM_ATTEMPTS = 2;

/** One response's terminal sequence, named by the durable turn it belongs to and
 *  the assistant message that carries its answer. */
export interface TerminalTransition {
  readonly turnId: string;
  readonly messageId: string;
}

/**
 * What a terminal transition's claim says about this attempt.
 *
 *   • `first`     — nobody has run it. Run everything.
 *   • `resumed`   — a previous attempt began it and never recorded a result. Run
 *     it again: the per-effect ledger decides what that means for each effect,
 *     skipping the ones already completed and deferring the ones whose schedule
 *     has not come round.
 *   • `done`      — it already completed. Nothing to do.
 *   • `unclaimed` — the response has no durable identity to claim against. The
 *     sequence still runs; saying so is more honest than inventing an identity
 *     every such response would share.
 */
export type TerminalDisposition = 'first' | 'resumed' | 'done' | 'unclaimed';

export interface TerminalTransitionDeps {
  readonly sql: SqlExecutor;
  /** What this actor can actually run. A row naming an effect absent here is
   *  blocked by the ledger rather than silently skipped. */
  readonly effects: TerminalEffectTable;
  readonly now: () => number;
  /** Read per call, so a test can arm a cut after construction. */
  readonly fault?: () => TerminalEffectFault | null;
  /**
   * Commit a group of writes as ONE durable unit.
   *
   * The claim and its whole roster go through this. Inside a Durable Object a
   * synchronous run is already atomic, so the identity function is honest there;
   * a process that can die between two statements — a CLI — must supply a real
   * transaction, or a kill mid-insert leaves a PREFIX of the roster that recovery
   * reads as the whole of it and closes over.
   */
  readonly transaction?: <T>(body: () => T) => T;
  /**
   * Whether this durable turn may still produce another response.
   *
   * Gates the turn-wide tool-claim release. An auto-continuation can already be
   * executing tools under the same turn before it has any terminal claim of its
   * own, so counting open terminal claims says "nobody is using this turn" while
   * somebody is — and deleting the live claim leaves the next interruption free
   * to replay an external tool with no guard.
   */
  readonly turnIsLive?: (turnId: string) => boolean;
  /**
   * Bring a process back at this instant, because rows are still owed.
   *
   * The one genuinely per-backend part of recovery: a Durable Object writes a
   * schedule row, and a CLI has its next start. An instant in the past means a
   * row is due now.
   */
  readonly scheduleRetry: (atMs: number) => Promise<void>;
}

/**
 * The transition lifecycle, over one storage.
 *
 * One object rather than a set of helpers because the ORDERING is what it owns,
 * and every one of those orderings was a defect before it existed: claim before
 * the first effect, disposition before release, close only on an empty owed set,
 * prune only after the close.
 */
export class TerminalTransitions {
  /** The per-effect ledger this lifecycle wraps. Exposed because a caller
   *  declares effects and reads back what is owed; it never reaches past this
   *  for the claim, the close or the sweep. */
  readonly ledger: TerminalEffectLedger;

  /**
   * Sequences this PROCESS has already entered.
   *
   * A duplicate callback arriving while the first is still running its effects
   * would otherwise re-enter every pending one beside it. The durable rows close
   * that window across a restart; this closes it inside one.
   */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TerminalTransitionDeps) {
    const ledgerDeps = {
      sql: deps.sql,
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

  /** The sequence id every effect row of one transition is filed under. */
  sequenceId(transition: TerminalTransition): string {
    return `${transition.turnId}/${transition.messageId}`;
  }

  /** The versioned effect-claim identity of one transition. The digest binds the
   *  row to the turn, so a differently shaped future claim on the same id cannot
   *  silently match this one. */
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

  /** Claim this transition before any of its effects run. */
  begin(transition: TerminalTransition | null): TerminalDisposition {
    if (transition === null) return 'unclaimed';
    const claim = claimToolEffect(this.deps.sql, this.key(transition));
    switch (claim.kind) {
      case 'claimed': return 'first';
      case 'indeterminate': return 'resumed';
      case 'settled': return 'done';
    }
  }

  /** Enter one sequence, or report that this process is already inside it.
   *  Released by {@link leave}, never in a `finally` around the effects: an
   *  interruption must leave the durable rows, not a cleared flag, as the
   *  record. */
  enter(transition: TerminalTransition): boolean {
    const id = this.sequenceId(transition);
    if (this.inFlight.has(id)) return false;
    this.inFlight.add(id);
    return true;
  }

  leave(transition: TerminalTransition): void {
    this.inFlight.delete(this.sequenceId(transition));
  }

  /** How many sequences this process currently owns. The join condition a
   *  recovery sweep is finished against: it acquires each sequence it resumes
   *  and releases through the normal close, so zero means every one it entered
   *  reached a disposition. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Drive ONE settled response, end to end.
   *
   * The whole state machine, in one place, because every ordering in it was a
   * defect before it was written down: the roster built before anything durable
   * exists, the in-process guard before the durable claim, the claim and the
   * whole roster committed as one unit, and the close only once the detached tail
   * has reported.
   *
   * A RESUMED response does not re-declare. Its roster is frozen at what the
   * first attempt claimed: a second declaration reads live state that has moved
   * — a scaffold candidate that did not exist then, a config flag since flipped —
   * and would append rows to a sequence already under way, scoring this turn
   * against a world it never ran in. The recorded rows are what it owed.
   *
   * `hold` is the ONE genuinely per-backend piece: a Durable Object runs the
   * close on a durable fiber that keeps the isolate alive, and a CLI awaits it
   * before the process exits. Core decides WHEN to close; the backend decides
   * what keeps the runtime alive until it does.
   */
  async settle(input: {
    readonly transition: TerminalTransition | null;
    /** The roster this response owes. Called exactly once, BEFORE any durable
     *  write, and its result is used only on a first attempt — a resumed response
     *  replays what it already claimed. */
    readonly declare: () => readonly OwedEffect[];
    /** Carry the close. Handed the transition being closed and a thunk that
     *  joins the detached tail and settles it; the backend decides what stays
     *  alive for the thunk. Never called for an unledgered response — there is
     *  nothing to close. */
    readonly hold: (transition: TerminalTransition, close: () => Promise<void>) => void;
  }): Promise<void> {
    const { transition, declare, hold } = input;
    // BUILT FIRST, before anything durable exists. A throw while gathering — a
    // projection that cannot serialize, a read that fails — must not leave an
    // open claim with no rows behind it, because recovery reads an empty roster
    // as a finished one and closes over everything the response owed.
    const owed = declare();
    // No durable identity means no key to claim against — a response that never
    // opened on a persisted message. The sequence still has to run, so it runs
    // unledgered, and saying that is more honest than inventing an identity every
    // such response would share.
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
    // ONE COMMIT for the claim AND the roster it gates. Separately, a process
    // that died between them left an indeterminate claim with no rows — and a
    // recovery reads an empty roster as a finished turn, settles the claim, and
    // every effect the response owed is gone with nothing on disk saying so.
    // The `resumed` branch below deliberately does not re-declare, which is what
    // makes that loss silent rather than merely unlucky.
    const commit = this.deps.transaction ?? (<T>(body: () => T): T => body());
    let claimed: PendingRow[] = [];
    const disposition = commit(() => {
      const decided = this.begin(transition);
      if (decided === 'first') claimed = this.ledger.claim(this.sequenceId(transition), owed);
      return decided;
    });
    if (disposition === 'done') {
      this.leave(transition);
      diagnostics.event('turn.terminal_transition_replayed', {
        turn: transition.turnId, message: transition.messageId,
      });
      return;
    }
    if (disposition === 'resumed') {
      hold(transition, async () => { await this.resume(transition); });
      return;
    }
    let run: TerminalSequenceRun;
    try {
      run = await this.ledger.drive(this.sequenceId(transition), claimed);
    } catch (err) {
      // RELEASED, then RE-ARMED. `run` can reject while arming the first wake:
      // a live process holding the sequence is one every later sweep skips, and
      // rows owed with no wake behind them are rows nothing comes back for.
      this.leave(transition);
      await this.armRecovery(transition, { cause: err });
      throw err;
    }
    hold(transition, async () => {
      await run.reported;
      this.end(transition);
    });
  }

  /**
   * Run a roster with no ledger behind it.
   *
   * The path a response with no durable identity takes. Nothing here is
   * recoverable — there is no row to recover from — so the bodies run through the
   * same declared effects and their outcomes are dropped. Detached bodies still
   * start in order and concurrently; this caller owns them until all settle.
   */
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

  /** When to come back, given the sequences this process is still running. */
  nextRetryAt(): number | null {
    return this.ledger.nextRetryAt(this.inFlight);
  }

  /**
   * Record that the sequence finished — but ONLY once every effect it owes has
   * reached a terminal disposition.
   *
   * The gate is the guarantee. While one effect is still pending the outer row
   * keeps its null result, so the next activation is handed the suffix instead
   * of being told the turn was done. Called only on the path where every effect
   * returned: a throw must leave the row with no result, which is what makes the
   * interruption legible, so this must never move into a `finally`.
   */
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
    // Disposition first, release second. Between the two the turn's answer is
    // already durable and its effects have already happened, so the only reader
    // that can arrive in between is a recovery — and it reads a settled row.
    settleToolEffect(this.deps.sql, this.key(transition), TERMINAL_TRANSITION_SETTLED);
    // The tool claims are released only once NO response of this durable turn
    // can still be settling. Transitions are per response and the close is
    // detached, so an auto-continuation's next response can already have claimed
    // a tool while the previous one's effects are still reporting — and a
    // turn-wide delete here removed that live claim, leaving the next
    // interruption free to replay an external tool with no guard. The terminal
    // rows themselves are the witness: while one is open, somebody may still be
    // using the turn.
    const openResponses = this.deps.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM tool_effect_claims
      WHERE turn_id = ${transition.turnId}
        AND normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}
        AND result_json IS NULL`[0]?.n ?? 0;
    // A live turn may still be MID-CONTINUATION: the next response can already
    // be executing tools under this turn id and will not have its own terminal
    // claim until it produces an answer, so an open-claim count of zero does not
    // mean nobody is using the turn.
    if (openResponses === 0 && !(this.deps.turnIsLive?.(transition.turnId) ?? false)) {
      void this.deps.sql`DELETE FROM tool_effect_claims
        WHERE turn_id = ${transition.turnId}
          AND normalized_call_id NOT LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`}`;
    }
    this.ledger.prune(sequenceId);
  }

  /**
   * The sequences that were claimed and never settled.
   *
   * A row with no result is a response that landed and then stopped part-way
   * through what it caused. The identity comes back off the row itself — the
   * message id is the call-id suffix — which is what lets a recovery address the
   * same sequence the interrupted attempt was running.
   */
  incomplete(): TerminalTransition[] {
    const prefix = `${TERMINAL_TRANSITION_CALL_ID}:`;
    return this.deps.sql<{ turn_id: string; normalized_call_id: string }>`
      SELECT DISTINCT turn_id, normalized_call_id FROM tool_effect_claims
      WHERE normalized_call_id LIKE ${`${prefix}%`} AND result_json IS NULL
    `.map((row) => ({
      turnId: row.turn_id,
      messageId: row.normalized_call_id.slice(prefix.length),
    }));
  }

  /** Whether ANY sequence is owed — one indexed LIMIT-1 read, for the
   *  activation-time arm decision that must not materialize the roster. */
  hasIncomplete(): boolean {
    const prefix = `${TERMINAL_TRANSITION_CALL_ID}:`;
    return this.deps.sql<{ present: number }>`
      SELECT 1 AS present FROM tool_effect_claims
      WHERE normalized_call_id LIKE ${`${prefix}%`} AND result_json IS NULL LIMIT 1
    `.length > 0;
  }

  /**
   * Finish what one interrupted sequence still owes, from storage.
   *
   * Every input comes off its row, so this needs no hydrated turn and no
   * actor-specific knowledge: it replays what is due, leaves what is not, and
   * then closes the outer row — which {@link end} does only if nothing is still
   * owed, so a genuinely unfinished sequence stays offered.
   */
  async resume(transition: TerminalTransition): Promise<void> {
    await this.ledger.replayOwed(this.sequenceId(transition));
    this.end(transition);
  }

  /**
   * The whole recovery sweep: every open claim, resumed.
   *
   * The entry point for a cold start and for the retry alarm. It reads the
   * roster from storage rather than from a sequence a caller happens to name,
   * because the sequences that need it are precisely the ones whose process is
   * gone.
   *
   * Never throws: one unrecoverable response must not stop the next one.
   */
  async resumeAll(): Promise<void> {
    for (const transition of this.incomplete()) {
      // ACQUIRED, not merely checked. Two entry points reach this — the startup
      // reconcile and the retry wake — and so does every wake {@link
      // armOwedRecovery} arms for an interrupted activation; they interleave at
      // every await inside the replay. Checking without joining let them all
      // pass, snapshot the same pending row and invoke the same external effect
      // concurrently.
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
        // RE-ARMED. A close that threw leaves an incomplete claim with, possibly,
        // no owed row behind it — and the wake below is derived from owed rows,
        // so it would arm nothing and an idle process would never retry the
        // close.
        await this.armRecovery(transition, { cause: err });
      }
    }
  }

  /**
   * The wake for what an interrupted activation still owes, and NO replay here.
   *
   * What a caller that must not await a replay asks for. The other entries — a
   * cold start's reconcile, the retry alarm — run with no queue behind them and
   * may spend what a replay costs: an SMTP round trip, a judge's model call, a
   * wait on another agent's live head. A Durable Object's fiber-recovery hook
   * may not, because the platform awaits that hook inside the object's init
   * gate, where every request on the object waits with it.
   *
   * So nothing is written and nothing is replayed: the owed rows already ARE the
   * record of what is due, and this leaves the sanctioned way back to them. The
   * claim join in {@link resumeAll} is what makes that re-entry safe — the wake
   * acquires each sequence before resuming it, so an armed wake and a concurrent
   * sweep cannot both replay one row.
   */
  async armOwedRecovery(): Promise<void> {
    const owed = this.incomplete();
    if (owed.length === 0) return;
    // The ledger's own instant when it has one, so a sequence mid-backoff is not
    // woken early only to defer itself again; the base delay otherwise, which is
    // what a claim with nothing owed behind it needs in order to be closed.
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

  /**
   * Leave a durable way BACK to a sequence whose ledger arm failed.
   *
   * `TerminalEffectLedger.run` rejects when the wake it arms fails. The rows are
   * written and owed at that point, but nothing is due to come back for them:
   * the response is already persisted and this hook is not re-fired.
   *
   * So the wake is attempted again, bounded — a storage write fails transiently,
   * and a call that refuses twice refuses for a reason a third cannot change.
   * When every attempt refuses the rows stay owed and VISIBLE with a named
   * failure, and the next start from any cause sweeps them. That is the honest
   * state rather than a claim of recovery that was never armed.
   *
   * Bounded retries of the SANCTIONED wake and nothing cleverer: a backend's
   * wake is the only carrier it has, and reaching around it — a Durable Object
   * writing the platform alarm slot directly, say — destroys the scheduler that
   * owns it.
   */
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

  /** One BOUNDED attempt at the backend's own wake, saying which outcome it
   *  was. Two callers arm the same wake for different reasons and report the
   *  refusal differently, so the attempt is shared and the reporting is not. */
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

  /**
   * The sweep, plus the wake for whatever it could not finish.
   *
   * What a durable retry fires into. Idempotent: it reads the owed roster from
   * storage and re-arms from what is left, so a duplicate wake costs one read.
   */
  async replayOwedAndRearm(): Promise<void> {
    await this.resumeAll();
    const next = this.nextRetryAt();
    if (next !== null) await this.deps.scheduleRetry(next);
  }
}
