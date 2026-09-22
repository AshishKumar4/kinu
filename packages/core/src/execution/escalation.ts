/**
 * Escalation: a turn running on a runtime other than its own `workspace` shell,
 * recorded per decision (runtime, reason, outcome) and emitted into `run_events` at turn end.
 */

/** `refused` means the runtime was unreachable, distinct from a failed command. */
export const ESCALATION_OUTCOMES = ['ok', 'failed', 'refused'] as const;

export type EscalationOutcome = (typeof ESCALATION_OUTCOMES)[number];

export interface EscalationDecision {
  /** Never `workspace`: that is the default, not an escalation. */
  readonly runtime: string;
  /** Null when the model gave no reason; never fabricated, so unreasoned escalation stays measurable. */
  readonly reason: string | null;
  readonly outcome: EscalationOutcome;
  readonly count: number;
}

/** The turn's escalations, in first-observed order. */
export interface EscalationSnapshot {
  readonly escalations: readonly EscalationDecision[];
}

const ESCALATION_REASON_MAX_CHARS = 240;

/** Per-turn escalation ledger; same ownership rule as `TurnFileLedger`. */
export class TurnEscalationLedger {
  /** Map insertion order gives the snapshot its first-observed order. */
  private readonly decisions = new Map<string, {
    runtime: string; reason: string | null; outcome: EscalationOutcome; count: number;
  }>();

  reset(): void {
    this.decisions.clear();
  }

  get active(): boolean {
    return this.decisions.size > 0;
  }

  observe(input: { runtime: string; reason: string | undefined; outcome: EscalationOutcome }): void {
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

  snapshot(): EscalationSnapshot {
    return { escalations: [...this.decisions.values()].map((d) => ({ ...d })) };
  }
}
