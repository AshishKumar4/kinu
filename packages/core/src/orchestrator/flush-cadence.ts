/** When a streamed step's buffered output is written to the stream buffer. */
import type { TextStreamPart, ToolSet } from 'ai';

const FLUSH_EVERY = 10;

export type PartialFlushSignal = 'content' | 'settled' | 'none';

/** First content flushes, then every {@link FLUSH_EVERY}, and a settled tool result at once; a step boundary resets. */
export interface PartialFlushCadence {
  flushes(signal: PartialFlushSignal): boolean;
  reset(): void;
}

export function partialFlushCadence(): PartialFlushCadence {
  let sinceFlush = 0;
  let flushedContent = false;

  return {
    flushes: (signal) => {
      if (signal === 'none') return false;
      sinceFlush += 1;

      if (signal !== 'settled' && flushedContent && sinceFlush < FLUSH_EVERY) return false;
      sinceFlush = 0;
      flushedContent = true;

      return true;
    },
    reset: () => {
      sinceFlush = 0;
      flushedContent = false;
    },
  };
}

const SETTLED: ReadonlySet<string> = new Set(['tool-result', 'tool-error', 'tool-output-denied']);

const CONTENT: ReadonlySet<string> = new Set(['text-delta', 'reasoning-delta', 'tool-call']);

export function flushSignal(part: TextStreamPart<ToolSet>): PartialFlushSignal {
  if (SETTLED.has(part.type)) return 'settled';

  return CONTENT.has(part.type) ? 'content' : 'none';
}
