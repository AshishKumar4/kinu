/**
 * The turn's context budget — one per-turn ledger of every bulk payload that
 * crosses into the root's token stream.
 *
 * Kinu's spill producers each honour the reference-plus-digest invariant on
 * their own (clamped tool results, spilled attachments, event content), but
 * each one only knows about ITSELF. This is where a turn's bulk is added up:
 * every producer records what the root ingested and what it withheld, and the
 * turn's settle spine writes one durable `context_budget` run event, so "how
 * often does the real workload cross the bulk thresholds at all" is a query
 * rather than a guess.
 *
 * It is a LEDGER, not a governor: the per-result cap is
 * `DEFAULT_TOOL_RESULT_MAX_CHARS` (tools/clamp.ts) and nothing here moves it.
 *
 * Owned per turn by the TurnAccumulator (reset with the rest of the turn's
 * accounting), and by construction per ROOT — a node or a subordinate builds
 * its own tools and therefore budgets its own turns, which is correct: a node
 * is its own root.
 */

/** Every directory a Kinu spill lands in — the single source of truth for
 *  the addresses a "go read the rest" recipe resolves to. Producers build
 *  their paths from here, and {@link citesSpillAddress} recognises a tool call
 *  that went back for one. */
export const SPILL_DIRS = {
  /** Clamped tool results (tools/clamp.ts). */
  toolOutput: '.kinu/tool-output',
  /** Message-borne bulk: attachments and pasted text (attachment-sanitizer). */
  attachments: 'attachments',
  /** Oversize event payloads (events/hub/content-spill.ts). */
  eventContent: '.kinu/event-content',
  /** Compaction transcripts (@kinu.run/compaction stores.ts). */
  compaction: '.kinu/compaction',
} as const;

const SPILL_DIR_VALUES: readonly string[] = Object.values(SPILL_DIRS);

/** Bulk producers, as the counters name them. These are durable counter keys
 *  in `context_budget`, not tool names: `web_fetch` stayed itself when the
 *  `web_search`/`web_fetch` tools merged into `web`, so stored rows keep
 *  aggregating with new ones. */
export type BulkProducer =
  | 'shell'
  | 'file_read'
  | 'web_fetch'
  | 'eval'
  | 'external_tool'
  | 'attachment'
  | 'pasted_text';

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
  /** Tool calls this turn that cited a spill address — the recipe being used. */
  followUps: number;
}

export interface SpillTrip {
  producer: BulkProducer;
  /** Chars (bytes, for binary payloads) the root will never see inline. */
  omitted: number;
  /** True when the full payload landed somewhere the agent can read back. */
  referenced: boolean;
}

export class TurnContextBudget {
  private admitted = 0;
  private omitted = 0;
  private readonly tripsByProducer = new Map<BulkProducer, number>();
  private referenced = 0;
  private followUps = 0;

  /** Clear for a new turn. */
  reset(): void {
    this.admitted = 0;
    this.omitted = 0;
    this.tripsByProducer.clear();
    this.referenced = 0;
    this.followUps = 0;
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
 * being followed", including the task-lifetime hire that names a path in its
 * mission and the fork-cites-spill shape: both reach the payload through its
 * path.
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
