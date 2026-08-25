/**
 * Escalation — a turn reaching past its own shell into a provisioned
 * environment, recorded as a decision with a reason.
 *
 * The `run` tool defaults to `workspace`, the agent's own shell over its own
 * file plane. Naming any other runtime is a different KIND of act: it moves the
 * work onto a substrate that has to be provisioned, that costs a cold start,
 * and that is capped — `max_instances` on the container binding is a hard
 * ceiling shared by every concurrent turn. So it is a decision, and a decision
 * with no recorded reason cannot be evaluated later.
 *
 * What this exists to make answerable, from the durable log alone: did
 * escalating help? That needs three things per decision and nothing more — the
 * runtime chosen, why the model says it chose it, and how it turned out. The
 * outcome is enumerated rather than a pair of booleans because `refused` (the
 * runtime was not reachable at all) is not a failed command, and conflating
 * them would read as "the container is unreliable" when the truth is "the
 * container was never there".
 *
 * Repeats are COUNTED, not re-listed. A turn that runs thirty commands in one
 * container made one decision thirty times over; thirty near-identical rows
 * would be noise, and counting by reason is the same idiom `file_edit` already
 * uses for its failure reasons.
 *
 * Not a new store. The snapshot is emitted into `run_events` by the settle
 * spine at turn end, exactly as the context, file, craft and recovery ledgers
 * are.
 */

/** How an escalation turned out.
 *
 *  Enumerated so a reader can assert every branch is exercised rather than
 *  assuming it — the same reason `WORKSPACE_RESTORE_OUTCOMES` is a list. */
export const ESCALATION_OUTCOMES = ['ok', 'failed', 'refused'] as const;
export type EscalationOutcome = (typeof ESCALATION_OUTCOMES)[number];

/** One escalation decision, with however many times the turn repeated it. */
export interface EscalationDecision {
  /** The runtime escalated TO. Never `workspace` — that is the default, not an
   *  escalation. */
  readonly runtime: string;
  /** Why the model says it escalated, or null when it said nothing.
   *
   *  Null is a real and useful value, not a gap to paper over: it measures how
   *  often escalation happens unreasoned, which is exactly the thing a prompt
   *  change would be trying to move. Fabricating a reason from the runtime name
   *  would destroy that measurement. */
  readonly reason: string | null;
  readonly outcome: EscalationOutcome;
  /** How many times this turn made this same decision with this same result. */
  readonly count: number;
}

/** The turn's escalations, in first-observed order. */
export interface EscalationSnapshot {
  readonly escalations: readonly EscalationDecision[];
}

/** Model-supplied text going into a durable payload is unbounded on both
 *  cardinality and length; only the length is worth bounding here, because the
 *  distinct-decision count is already capped by the turn's own step limit. */
const ESCALATION_REASON_MAX_CHARS = 240;

/**
 * The turn's escalation ledger. Same ownership rule as `TurnFileLedger` and
 * `TurnContextBudget`: the backend passes its accumulator's, and a caller that
 * omits it gets a fresh one, so the policy is per-root by construction.
 */
export class TurnEscalationLedger {
  /** Keyed on runtime + outcome + reason, so a repeated decision increments its
   *  count rather than appending a near-identical row. Insertion-ordered by Map
   *  contract, which is what makes the snapshot first-observed order. */
  private readonly decisions = new Map<string, {
    runtime: string; reason: string | null; outcome: EscalationOutcome; count: number;
  }>();

  /** Clear for a new turn. */
  reset(): void {
    this.decisions.clear();
  }

  /** True when this turn escalated at all — the settle spine writes no row for
   *  a turn that never left its own shell. */
  get active(): boolean {
    return this.decisions.size > 0;
  }

  /**
   * Record one escalation. `reason` is the model's own words; absent or blank
   * becomes null rather than an invented string.
   */
  observe(input: { runtime: string; reason: string | undefined; outcome: EscalationOutcome }): void {
    // Whitespace-only counts as none: a reason that is a space is not a reason.
    const stated = input.reason?.trim();
    const reason = stated ? stated.slice(0, ESCALATION_REASON_MAX_CHARS) : null;
    const key = `${input.runtime}\u0000${input.outcome}\u0000${reason ?? ''}`;
    const existing = this.decisions.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.decisions.set(key, { runtime: input.runtime, reason, outcome: input.outcome, count: 1 });
  }

  /** What the turn decided, for the durable row. */
  snapshot(): EscalationSnapshot {
    return { escalations: [...this.decisions.values()].map((d) => ({ ...d })) };
  }
}
