/**
 * The turn's context budget — one per-turn ledger of every bulk payload that
 * crosses into the root's token stream, and the cap that tightens as the turn
 * gets heavy.
 *
 * Proteus's spill producers each honour the reference-plus-digest invariant
 * on their own (clamped tool results, spilled attachments, event content),
 * but each one only knows about ITSELF: eight 39k-char tool results sail
 * through a 40k per-result cap and land ~78k tokens of bulk in one turn's
 * durable history. RLMEnv's answer is mechanical rather than advisory — the
 * root sees at most a fixed slice of REPL output per iteration — and this is
 * that rule at the seam Proteus already owns: once a turn has admitted
 * {@link DEFAULT_TURN_ADMIT_BUDGET_CHARS} of tool-result text, the per-result
 * cap for the REMAINDER of the turn drops to {@link TIGHTENED_RESULT_MAX_CHARS}.
 * Full text is still spilled, the marker recipe is unchanged, so nothing is
 * lost — the root just stops paying for it inline.
 *
 * The same object is the M1 trip counter: every producer records its spills
 * here and the turn's settle spine writes one durable `context_budget` run
 * event, so "how often does the real workload cross the bulk thresholds at
 * all" is a query rather than a guess.
 *
 * Deterministic by construction: the cap for result N is a pure function of
 * the sizes of results 1..N-1, so a replayed turn clamps identically. Owned
 * per turn by the TurnAccumulator (reset with the rest of the turn's
 * accounting), and by construction per ROOT — a node or a subordinate builds
 * its own tools and therefore budgets its own turns, which is correct: a node
 * is its own root.
 */

/** Every directory a Proteus spill lands in — the single source of truth for
 *  the addresses a "go read the rest" recipe resolves to. Producers build
 *  their paths from here, and {@link citesSpillAddress} recognises a tool call
 *  that went back for one. */
export const SPILL_DIRS = {
  /** Clamped tool results (tools/clamp.ts). */
  toolOutput: '.proteus/tool-output',
  /** Message-borne bulk: attachments and pasted text (attachment-sanitizer). */
  attachments: 'attachments',
  /** Oversize event payloads (events/hub/content-spill.ts). */
  eventContent: '.proteus/event-content',
  /** Compaction transcripts (@kinu/compaction stores.ts). */
  compaction: '.proteus/compaction',
} as const;

const SPILL_DIR_VALUES: readonly string[] = Object.values(SPILL_DIRS);

/** Bulk producers, as the counters name them. These are durable counter keys
 *  in `context_budget`, not tool names: `web_fetch` stayed itself when the
 *  `web_search`/`web_fetch` tools merged into `web`, so stored rows keep
 *  aggregating with new ones. */
export type BulkProducer =
  | 'run'
  | 'file_read'
  | 'web_fetch'
  | 'execute_tools'
  | 'external_tool'
  | 'attachment'
  | 'pasted_text';

/**
 * Cumulative tool-result chars a turn may admit at the full per-result cap.
 * Three full-size results — enough for the navigation reads that open a turn
 * at full fidelity, after which the turn is heavy and delegation is the right
 * move. A pre-registration, not a derivation: docs/CONTEXT-BUDGET.md records
 * the thresholds that keep or revert it.
 */
export const DEFAULT_TURN_ADMIT_BUDGET_CHARS = 120_000;

/** The per-result cap once the turn's admit budget is spent — RLMEnv's 8k
 *  visible-output floor. */
export const TIGHTENED_RESULT_MAX_CHARS = 8_000;

/** What one turn did to its context budget. Absent counters are zero. */
export interface ContextBudgetSnapshot {
  /** Tool-result chars admitted into this turn's context (post-clamp). */
  admittedChars: number;
  /** Chars withheld from the root by clamping or spilling (bytes, for the
   *  binary payloads where chars mean nothing). */
  omittedChars: number;
  /** Spill trips per producer — omitted producers never tripped. */
  trips: Partial<Record<BulkProducer, number>>;
  /** Trips that carried a resolvable reference (the spill write landed). */
  referenced: number;
  /** Trips clamped at the tightened floor because the admit budget was spent. */
  tightened: number;
  /** Tool calls this turn that cited a spill address — the recipe being used. */
  followUps: number;
}

export interface SpillTrip {
  producer: BulkProducer;
  /** Chars (bytes, for binary payloads) the root will never see inline. */
  omitted: number;
  /** True when the full payload landed somewhere the agent can read back. */
  referenced: boolean;
  /** True when the per-result cap was the tightened floor, not the configured one. */
  tightened?: boolean;
}

export class TurnContextBudget {
  private admitted = 0;
  private omitted = 0;
  private readonly tripsByProducer = new Map<BulkProducer, number>();
  private referenced = 0;
  private tightened = 0;
  private followUps = 0;

  constructor(
    /** Cumulative admitted chars before the per-result cap tightens. */
    private readonly admitBudget: number = DEFAULT_TURN_ADMIT_BUDGET_CHARS,
    /** The tightened per-result cap. */
    private readonly floor: number = TIGHTENED_RESULT_MAX_CHARS,
  ) {}

  /** Clear for a new turn. */
  reset(): void {
    this.admitted = 0;
    this.omitted = 0;
    this.tripsByProducer.clear();
    this.referenced = 0;
    this.tightened = 0;
    this.followUps = 0;
  }

  /**
   * The per-result cap for the NEXT tool result: the configured cap until this
   * turn has admitted its budget, the floor after. Never above the configured
   * cap — a caller that asked for a tighter budget keeps it.
   */
  capFor(configuredMax: number): number {
    return this.admitted >= this.admitBudget ? Math.min(this.floor, configuredMax) : configuredMax;
  }

  /** Count chars entering the root's context from a tool result. */
  admit(chars: number): void {
    this.admitted += chars;
  }

  /** Record one producer's spill/clamp trip. */
  recordSpill(trip: SpillTrip): void {
    this.omitted += trip.omitted;
    this.tripsByProducer.set(trip.producer, (this.tripsByProducer.get(trip.producer) ?? 0) + 1);
    if (trip.referenced) this.referenced++;
    if (trip.tightened) this.tightened++;
  }

  /** The agent went back to a spill address — the recipe worked. */
  noteFollowUp(): void {
    this.followUps++;
  }

  snapshot(): ContextBudgetSnapshot {
    const trips: Partial<Record<BulkProducer, number>> = {};
    for (const [producer, count] of this.tripsByProducer) trips[producer] = count;
    return {
      admittedChars: this.admitted,
      omittedChars: this.omitted,
      trips,
      referenced: this.referenced,
      tightened: this.tightened,
      followUps: this.followUps,
    };
  }

  /** True when the turn touched the budget at all — the settle spine skips the
   *  durable row for turns that never produced or consumed bulk. */
  get active(): boolean {
    return this.admitted > 0 || this.omitted > 0 || this.followUps > 0;
  }
}

/**
 * True when a tool call's arguments name a spill address — a read of a
 * clamped output, a spilled attachment, an event body, or a compaction
 * archive. The counter for "the drop-content-keep-the-path recipe is actually
 * being followed", including the `llm.query`-over-slices and fork-cites-spill
 * shapes: both reach the payload through its path.
 *
 * A tool call's arguments are what the model sent as JSON, so serializing them
 * cannot fail. It is not guarded: arguments that will not serialize mean the
 * accumulator is holding something other than a tool input, and reporting that
 * as "cites no spill" would retire the defect as a metric of zero.
 */
export function citesSpillAddress<Args>(args: Args): boolean {
  const text = JSON.stringify(args);
  if (!text) return false;
  return SPILL_DIR_VALUES.some((dir) => text.includes(`${dir}/`));
}
