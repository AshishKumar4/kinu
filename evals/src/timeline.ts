// When each part of a trial ran, on the clock of the machine running it: the harness's own phases
// (opening the workspace, each prompt, each poll until the workspace settles, the checks, the
// teardown) and the chunks of every turn's stream as they arrived. Kept beside the ledger, it is what
// `evals/scripts/timing.ts` splits a trial's wall time with: the model's time to first token and
// generation, provider waits, tools, the product's own work between steps, and the harness's waits.
import type { JsonValue } from '@kinu.run/core';

export type TimelineEntry = {
  /** When it began, or when the first chunk of a folded run arrived: milliseconds since the epoch. */
  readonly at: number;
  readonly mark: string;
  /** When a span ended, or when the last chunk of a folded run arrived. */
  until?: number;
  /** How many chunks of one type arrived in a row. */
  count?: number;
  readonly detail?: JsonValue;
};

export class TrialTimeline {
  readonly entries: TimelineEntry[] = [];

  mark(mark: string, detail?: JsonValue): void {
    this.entries.push(detail === undefined ? { at: Date.now(), mark } : { at: Date.now(), mark, detail });
  }

  async span<T>(mark: string, op: () => Promise<T>): Promise<T> {
    const entry: TimelineEntry = { at: Date.now(), mark };

    this.entries.push(entry);

    try {
      return await op();
    } finally {
      entry.until = Date.now();
    }
  }

  /** One chunk of a turn's stream, by its type. A run of one type is one entry: a turn streams thousands of deltas. */
  chunk(type: string): void {
    const at = Date.now();
    const mark = `chunk:${type}`;
    const last = this.entries.at(-1);

    if (last?.mark === mark) {
      last.until = at;
      last.count = (last.count ?? 1) + 1;

      return;
    }

    this.entries.push({ at, mark, until: at, count: 1 });
  }
}
