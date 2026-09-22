/**
 * Per-turn ledger of bulk payloads crossing into the root's token stream, written as one `context_budget` run event.
 * A ledger, not a governor: the per-result cap is `DEFAULT_TOOL_RESULT_MAX_CHARS` (tools/clamp.ts).
 */

import type { JsonValue } from './utils/json';

/** Every directory a Kinu spill lands in; producers build their paths from here. */
export const SPILL_DIRS = {
  /** tools/clamp.ts */
  toolOutput: '.kinu/tool-output',
  /** attachment-sanitizer */
  attachments: 'attachments',
  /** events/hub/content-spill.ts */
  eventContent: '.kinu/event-content',
  /** @kinu.run/compaction stores.ts */
  compaction: '.kinu/compaction',
} as const;

const SPILL_DIR_VALUES: readonly string[] = Object.values(SPILL_DIRS);

/** Durable counter keys in `context_budget`, not tool names: `web_fetch` survives the tool merge into `web`. */
export type BulkProducer =
  | 'shell'
  | 'file_read'
  | 'web_fetch'
  | 'eval'
  | 'external_tool'
  | 'attachment'
  | 'pasted_text';

/** Absent counters are zero. */
export interface ContextBudgetSnapshot {
  /** Post-clamp tool-result chars. */
  admittedChars: number;
  /** Chars withheld by clamping or spilling (bytes for binary payloads). */
  omittedChars: number;
  trips: Partial<Record<BulkProducer, number>>;
  /** Trips whose spill write landed. */
  referenced: number;
  /** Tool calls that cited a spill address. */
  followUps: number;
}

export interface SpillTrip {
  producer: BulkProducer;
  /** Chars (bytes for binary payloads). */
  omitted: number;
  referenced: boolean;
}

export class TurnContextBudget {
  private admitted = 0;
  private omitted = 0;
  private readonly tripsByProducer = new Map<BulkProducer, number>();
  private referenced = 0;
  private followUps = 0;

  reset(): void {
    this.admitted = 0;
    this.omitted = 0;
    this.tripsByProducer.clear();
    this.referenced = 0;
    this.followUps = 0;
  }

  admit(chars: number): void {
    this.admitted += chars;
  }

  recordSpill(trip: SpillTrip): void {
    this.omitted += trip.omitted;
    this.tripsByProducer.set(trip.producer, (this.tripsByProducer.get(trip.producer) ?? 0) + 1);

    if (trip.referenced) this.referenced++;
  }

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

  /** False skips the durable row for turns that never touched bulk. */
  get active(): boolean {
    return this.admitted > 0 || this.omitted > 0 || this.followUps > 0;
  }
}

/**
 * True when a tool call's arguments name a spill address.
 * Deliberately unguarded: unserializable args mean a non-tool input, which must not be reported as zero.
 */
export function citesSpillAddress(args: JsonValue | undefined): boolean {
  const text = JSON.stringify(args);

  if (!text) return false;

  return SPILL_DIR_VALUES.some((dir) => text.includes(`${dir}/`));
}
