/**
 * WHAT a settled response owes, in order — the declaration half of the terminal
 * lifecycle.
 *
 * The {@link TerminalEffectLedger} owns each effect's disposition and
 * {@link TerminalTransitions} owns the once-only boundary around them. What
 * lives here is the third thing, and the one that used to be copied: the ROSTER.
 * Which effects a settled response owes, in which order, on which lane, keyed on
 * what, and gated by which facts about the turn.
 *
 * Every one of those is a rule, and every one of them was written out separately
 * in each backend before this existed — so the workspace root, the subordinate
 * facet and the CLI each had their own answer to questions like "does an aborted
 * turn close an event lease?" and "does a Plan turn feed the improvement lanes?".
 * They are the same questions. A backend that answered one of them differently
 * was a bug nobody could see by reading either copy.
 *
 * Every field is a VALUE the caller reads, never a decision it makes. That split
 * is the whole design: only the caller can read its own accumulator, its pending
 * branches or its scaffold candidate, and only this module decides what those
 * readings mean. An effect a backend does not have is simply an absent part —
 * a subordinate owes no alternate takes, so it passes none, and no row exists.
 */
import type { JsonValue } from '../utils/json';
import type { WorkMode } from '../prompting/surface';
import type { RunEndReason } from './turn-lifecycle';
import type { TurnContinuity } from './agent-orchestrator';
import type { OwedEffect } from './terminal-effects';
import type { SubordinateReportStatus } from '../events/hub/types';

/**
 * What every settled response knows about itself.
 *
 * `completed` is the DRIVER's verdict, and `durablyAnswered` below narrows it
 * further: a stream can report completion while the assistant row was never
 * written, and a later activation reads that turn back as never having happened.
 * Everything keyed to that row is gated on the narrower fact.
 */
export interface TerminalTurnFacts {
  /** The assistant message this response settled on. Empty when its row was
   *  never written — an identity no effect may key on. */
  readonly messageId: string;
  readonly status: RunEndReason;
  readonly workMode: WorkMode;
  readonly continuity: TurnContinuity;
  /** The driver's own verdict, not the stream's. */
  readonly completed: boolean;
  readonly userText: string;
  readonly assistantText: string;
  /** The completed turn, ALREADY SCOPED to the missions it ran under. Scoped by
   *  the caller because the governor scope is live state a replay does not have. */
  readonly scopedTurn: JsonValue;
  /** WHEN the turn ended. A replay stamped with the recovery clock would order an
   *  old turn after a newer one. */
  readonly recordedAt: number;
  /**
   * Whether THIS session recorded evolution state at all.
   *
   * Recorded for the same reason the continuity and the mode are: the recording
   * body used to read the ambient gate, so a turn produced under
   * `--no-auto-evolve` and recovered by an ordinary session was written into the
   * window it never earned, and the inverse silently dropped one it did.
   */
  readonly evolutionEnabled: boolean;
}

/** The optional halves, each supplied only by a backend that has one. */
export interface TerminalTurnParts {
  /** Alternate takes captured mid-turn. `credited` null means the captures
   *  cannot be attributed and must be purged rather than claimed. */
  readonly takes?: {
    readonly credited: string | null;
    readonly startedAt: number;
    readonly takeIds: readonly string[];
  };
  /** Crafted tools this turn actually called, for async thumbs to re-score. */
  readonly craftedToolsUsed?: readonly string[];
  /** Every delivery this turn answered, whichever way it reached the turn, with
   *  the request id the reply is dispatched under. Together, because the id is
   *  meaningless to a backend that answers no deliveries. */
  readonly eventReplies?: {
    readonly answered: ReadonlySet<string>;
    readonly requestId: string;
  };
  /** Steer-as-Branch redirects launched during this turn. */
  readonly branches?: readonly { readonly id: string; readonly task: string }[];
  /** The extension turn-end, for a backend that owes it as a RECORDED effect,
   *  carrying the RAW assistant message the response ended on. Raw rather than
   *  converted, because converting is an await and the claim has to exist before
   *  any await that follows a persisted answer — so the conversion happens in the
   *  effect body, on the first attempt and on a replay alike. A backend whose
   *  turn stream already fired the turn-end inside the turn owes nothing here,
   *  and a row would either double-fire or block the close forever. */
  readonly turnEndExtensions?: { readonly message: JsonValue };
  /** The completion gate's subject, for a backend that runs one. Its armed state
   *  is RAM-only, so the row is the only record that the confirming turn it
   *  enqueues was already enqueued. */
  readonly completionGate?: { readonly text: string };
  /** A context-overflow retry this turn earned. Delivery is a claimed effect
   *  because enqueueing it is asynchronous and must survive a process cut. */
  readonly overflowRetry?: boolean;
  /**
   * The ONE continuation a turn cut at the provider's output limit earned
   * (core `owesOutputLimitContinuation`), for a backend whose loop cannot
   * continue inside the turn.
   *
   * Claimed for the same reason the retry beside it is: the answer is already
   * durable and truncated, so a continuation lost to an eviction leaves exactly
   * the state it exists to prevent — a turn published as finished whose work
   * stopped mid-sentence. `runChat` passes nothing here; it continues inside the
   * turn and has no follow-up to owe.
   */
  readonly outputContinuation?: boolean;
  /** The advisor's recovery snapshot, as the improvement lanes replay it. */
  readonly advisor?: JsonValue;
  /** The sampling plan, when this turn is sampled against a candidate. */
  readonly shadowTrial?: {
    readonly pendingVersion: number;
    /** ALREADY BOUNDED by the caller: a recorded input is a SQLite row, and one
     *  built from a million-token turn fails its insert partway through a
     *  claimed sequence. */
    readonly trialContext: JsonValue;
  };
  /** The turn's tool calls, for the memory-compression lane. */
  readonly sleepTime?: { readonly toolCalls: JsonValue };
  /** What this actor should name itself from, when it is unnamed. */
  readonly autoTitle?: { readonly subject: string };
  /** Whether this actor runs the cadence optimisation lanes at all. */
  readonly autoGepa?: boolean;
  /**
   * The report this facet owes its parent, when it owes one.
   *
   * The PRESENCE is the decision and it belongs to the caller, because only the
   * caller knows its own lifetime: a `task` child owes its caller a terminal
   * answer on every ending — answered, errored, interrupted alike — while a
   * durable child relays only a completed turn worth relaying. Gating this on
   * completion here would have silenced exactly the endings an `agents.ask` is
   * blocked on.
   */
  readonly parentReport?: {
    readonly text: string;
    /** What KIND of ending this reports. A task child's terminal answer and a
     *  durable child's progress note are different words for the parent. */
    readonly status: SubordinateReportStatus;
    /** The report's durable identity, which the parent's ingress dedupes on. */
    readonly sequenceId: string;
  };
}

/**
 * The roster, in the order it must run.
 *
 * Order is load-bearing twice over. The settle spine runs turn-end, then the
 * recording, then the drain, because the extension's effects are part of the
 * turn the review then reads. And the inline effects precede the detached ones
 * so a queue waiting on an inline effect cannot be overtaken.
 */
export function declareTerminalRoster(
  facts: TerminalTurnFacts, parts: TerminalTurnParts = {},
): OwedEffect[] {
  const { messageId, assistantText, completed } = facts;
  // ONE gate, meaning "this turn has a durable answer". A completed stream whose
  // assistant row is absent is a turn a later activation reads back as never
  // having happened, so closing a delivery's lease on the stream alone would mark
  // an unanswered event answered.
  const durablyAnswered = completed && messageId !== '';
  const owed: OwedEffect[] = [];

  if (parts.takes) {
    owed.push({
      name: 'takes', scope: messageId, lane: 'inline',
      input: {
        credited: parts.takes.credited,
        startedAt: parts.takes.startedAt,
        // Read by the caller HERE, at declaration. A retry that re-selected
        // "whatever is unclaimed now" would claim — or purge — a later turn's
        // captures.
        takeIds: [...parts.takes.takeIds],
      },
    });
  }

  const craftNames = durablyAnswered ? parts.craftedToolsUsed ?? [] : [];
  if (craftNames.length > 0) {
    owed.push({
      name: 'craft_usage', scope: messageId, lane: 'inline',
      input: { messageId, toolNames: [...craftNames] },
    });
  }

  // One effect per delivery, because each closes its own recovery lease: a batch
  // whose replies are still pending must stay owed on its own.
  if (durablyAnswered && parts.eventReplies) {
    for (const answered of parts.eventReplies.answered) {
      owed.push({
        name: 'event_reply', scope: answered, lane: 'detached',
        input: {
          drainTurnId: answered, answer: assistantText,
          requestId: parts.eventReplies.requestId,
        },
      });
    }
  }

  // ONE ROW PER BRANCH, keyed on the branch id — which IS the settlement key, so
  // nothing downstream has to invent one. An aborted turn passes no answer, which
  // aborts a branch instead of settling it against a partial one.
  for (const branch of parts.branches ?? []) {
    owed.push({
      name: 'branches', scope: branch.id, lane: 'detached',
      input: {
        id: branch.id,
        task: branch.task,
        turnId: completed ? parts.takes?.credited ?? null : null,
        liveText: completed ? assistantText : '',
      },
    });
  }

  // Before the spine, because the gate reads the answer as it stands and the
  // spine's extension emit may add to it.
  if (parts.completionGate) {
    owed.push({
      name: 'completion_gate', scope: messageId, lane: 'inline',
      input: { text: parts.completionGate.text },
    });
  }

  // The settle spine, as FOUR separately claimed boundaries. Each records the
  // whole input it needs, because each is genuinely replayed.
  if (parts.turnEndExtensions) {
    owed.push({
      name: 'turn_end_extensions', scope: messageId, lane: 'inline',
      input: { messageId, text: assistantText, message: parts.turnEndExtensions.message },
    });
  }
  if (parts.overflowRetry) {
    owed.push({
      name: 'overflow_retry', scope: messageId, lane: 'inline', input: {},
    });
  }
  // Beside the retry, and never with it: one answers a turn that failed, the
  // other a turn that finished with more to say, and `completed` decides which.
  if (parts.outputContinuation) {
    owed.push({
      name: 'output_continuation', scope: messageId, lane: 'inline', input: {},
    });
  }
  owed.push({
    name: 'turn_record', scope: messageId, lane: 'inline',
    input: {
      messageId,
      status: facts.status,
      turn: facts.scopedTurn,
      // RECORDED, not re-read. A fresh actor defaults to `conversation` and to
      // build, so a replay would park an independent task awaiting a follow-up
      // that cannot come, and would record a PLAN turn into evolution.
      continuity: facts.continuity,
      workMode: facts.workMode,
      recordedAt: facts.recordedAt,
      autoEvolve: facts.evolutionEnabled,
    },
  });
  owed.push({ name: 'event_drain', scope: messageId, lane: 'inline', input: {} });
  owed.push({
    name: 'improvement_lanes', scope: messageId, lane: 'inline',
    input: {
      status: facts.status,
      turn: facts.scopedTurn,
      workMode: facts.workMode,
      advisor: parts.advisor ?? null,
    },
  });

  if (parts.parentReport) {
    owed.push({
      name: 'parent_report', scope: messageId, lane: 'detached',
      input: {
        text: parts.parentReport.text,
        status: parts.parentReport.status,
        sequenceId: parts.parentReport.sequenceId,
        // The mode TRAVELS. A cold replay must not re-derive it from turn
        // metadata that has moved on and turn a Plan report into a Build one.
        mode: facts.workMode,
      },
    });
  }

  // Everything below is completed-Build only, and the gate is here rather than at
  // each caller because it is one rule: a turn the improvement lanes are closed
  // for earned none of the work these lanes do, and a candidate scored against an
  // aborted or Plan turn is evidence about nothing.
  if (!completed || facts.workMode === 'plan') return owed;

  if (parts.shadowTrial) {
    owed.push({
      name: 'shadow_trial', scope: messageId, lane: 'inline',
      input: {
        turn: facts.scopedTurn,
        trialContext: parts.shadowTrial.trialContext,
        pendingVersion: parts.shadowTrial.pendingVersion,
      },
    });
  }
  // The between-turn lanes. Each is durably gated at its own boundary — a config
  // flag, a `name_origin` stamp, a turn-count cadence — which is what makes each
  // replayable from its recorded input.
  if (parts.sleepTime) {
    owed.push({
      name: 'sleep_time', scope: messageId, lane: 'detached',
      input: {
        task: facts.userText,
        output: assistantText,
        toolCalls: parts.sleepTime.toolCalls,
      },
    });
  }
  if (parts.autoTitle) {
    owed.push({
      name: 'auto_title', scope: messageId, lane: 'detached',
      input: { subject: parts.autoTitle.subject },
    });
  }
  if (parts.autoGepa) {
    owed.push({ name: 'auto_gepa', scope: messageId, lane: 'detached', input: {} });
  }
  return owed;
}
